#!/usr/bin/env python3
"""虚拟 ESP32 —— 智座（`D:\\MAX_xiangmu`）的传感器设备模拟器

★ 这是什么、为什么需要它
────────────────────────────────────────────────────────────────────────
智座的真机是「每个座位一个 ESP32 + 双红外」，按周期把读数 HTTP 上报给主系统。
真机不在手上时，有两种办法驱动它：

  · **它自带的进程内模拟器**（`app.py` 的 `_build_sensor_simulator()`）
    —— 直接调回调，**完全绕过 HTTP / 设备注册 / 配置下发**。
  · **本脚本：进程外、走真网络**
    —— 用真实设备的那三个接口，因此**连协议本身一起测**。

两者不重复：自带模拟器测的是**状态机**，本脚本测的是**设备接入链路**
（注册 → 拉配置 → 周期上报 → 在线判定）。

★ 它按真机的规矩办事（这几条都是接口契约里的，不是我们编的）
────────────────────────────────────────────────────────────────────────
  1. 开机先 `POST /api/sensor/device/register`（新设备会被自动登记 `is_new`）
  2. 从返回的 `config` 里取 **`ir_active_high` / `report_interval_ms` /
     `sensor_type` / `distance_threshold_cm`** —— 面板改配置**免重烧**就是靠这个
  3. 之后按 `report_interval_ms` 周期 `POST /api/sensor/report`
  4. **`ir_active_high` 必须照做**：它决定"遮挡时读到 1 还是 0"。
     我们模拟的是**物理遮挡**，把它翻译成原始电平是**设备侧**的责任 ——
     搞反了症状是"人坐下反而释放"，而且不报错。
  5. 释放需要**连续 2 次空**（`seat.consecutive_empty >= 2`）——
     真机就是这样，所以场景必须真的多报几次空，不能只报一次。

用法
────────────────────────────────────────────────────────────────────────
    python virtual_esp32.py --server http://127.0.0.1:5800 \\
        --device-id AA:BB:CC:00:00:01 --seat-id 1 --scenario sit-then-leave
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_TIMEOUT = 8.0


class ZhizuoError(RuntimeError):
    """接口层错误。★ 明确抛，不静默 —— 静默会让"设备没上报"和"上报被拒"分不开。"""


class VirtualEsp32:
    """一台虚拟 ESP32：注册 → 拉配置 → 周期上报。

    ★ 只依赖标准库（`urllib`），不引入 `requests` —— 真机固件也不会带一堆依赖，
      保持"它就是个瘦客户端"这件事本身是重要的：**协议要能在最小实现上跑通**。
    """

    def __init__(self, base_url: str, device_id: str, timeout: float = DEFAULT_TIMEOUT) -> None:
        self.base_url = base_url.rstrip("/")
        self.device_id = device_id
        self.timeout = timeout
        self.config: dict | None = None

    # ── HTTP ──────────────────────────────────────────────────────────────

    def _post(self, path: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        return self._send(req)

    def _get(self, path: str, params: dict) -> dict:
        query = urllib.parse.urlencode(params)
        req = urllib.request.Request(f"{self.base_url}{path}?{query}", method="GET")
        return self._send(req)

    def _send(self, req: urllib.request.Request) -> dict:
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as response:
                raw = response.read().decode("utf-8")
        except urllib.error.HTTPError as error:
            # ★ 把 body 带出来：智座的错误说明在 body 里，只报状态码等于丢掉线索
            detail = error.read().decode("utf-8", "replace")
            raise ZhizuoError(f"HTTP {error.code} {req.full_url} -> {detail}") from error
        except urllib.error.URLError as error:
            raise ZhizuoError(f"连不上 {req.full_url}：{error.reason}") from error
        try:
            return json.loads(raw)
        except json.JSONDecodeError as error:
            raise ZhizuoError(f"响应不是 JSON：{raw[:200]!r}") from error

    # ── 设备侧三个动作 ────────────────────────────────────────────────────

    def register(self) -> dict:
        """开机注册 / 心跳。返回下发配置。"""
        result = self._post("/api/sensor/device/register", {"device_id": self.device_id})
        if not result.get("success", True):
            raise ZhizuoError(f"注册被拒：{result.get('message')}")
        self.config = (result.get("data") or {}).get("config")
        return result

    def pull_config(self) -> dict | None:
        """周期拉配置（面板改完即生效，免重烧）。"""
        result = self._get("/api/sensor/device_config", {"device_id": self.device_id})
        data = result.get("data") or {}
        if not data.get("registered", False):
            # ★ 未注册是**明确状态**，不是"配置为空" —— 真机此时应回到注册流程
            self.config = None
            return None
        self.config = data.get("config")
        return self.config

    def report(self, front_blocked: bool, back_blocked: bool) -> dict:
        """上报一次读数。**入参是物理遮挡**，原始电平由 `ir_active_high` 翻译。"""
        if self.config is None:
            raise ZhizuoError("还没有配置 —— 先 register()/pull_config()")

        seat_id = self.config.get("seat_id")
        if seat_id is None:
            raise ZhizuoError(
                "该设备还没有绑定座位 —— 请在智座面板上给它绑定一个座位，"
                "否则真机也不知道自己在哪"
            )

        payload = {
            "seat_id": seat_id,
            "ir_front": self._raw(front_blocked),
            "ir_back": self._raw(back_blocked),
        }
        result = self._post("/api/sensor/report", payload)
        if not result.get("success", True):
            raise ZhizuoError(f"上报被拒：{result.get('message')}  (payload={payload})")
        return result

    def _raw(self, blocked: bool) -> int:
        """物理遮挡 → 原始电平。

        ★ `ir_active_high=True` 表示**遮挡时读到 1**；为 False 则相反。
          搞反的症状是"坐下反而释放"，且**不报任何错** —— 所以这里必须照配置来。
        """
        active_high = bool((self.config or {}).get("ir_active_high", True))
        if active_high:
            return 1 if blocked else 0
        return 0 if blocked else 1

    # ── 场景 ──────────────────────────────────────────────────────────────

    def interval_seconds(self) -> float:
        ms = int((self.config or {}).get("report_interval_ms") or 5000)
        return max(0.05, ms / 1000.0)

    def run_scenario(self, states: list[tuple[bool, bool, int]], verbose: bool = True) -> list[dict]:
        """按 `[(front_blocked, back_blocked, 重复次数), …]` 依次上报。

        ★ **重复次数是场景的一部分，不是凑数**：释放需要连续 2 次空，
          只报一次空**不会**让座位释放。把它写进场景，才不会误以为系统坏了。
        """
        interval = self.interval_seconds()
        results: list[dict] = []
        for front, back, repeats in states:
            label = "有人（双束遮挡）" if (front and back) else "无人"
            if verbose:
                print(f"  → {label}  ir_front={self._raw(front)} ir_back={self._raw(back)}  ×{repeats}")
            for _ in range(repeats):
                results.append(self.report(front, back))
                time.sleep(interval)
        return results


# ── 预设场景 ──────────────────────────────────────────────────────────────

SCENARIOS: dict[str, list[tuple[bool, bool, int]]] = {
    # 坐下 → 离开（离开要报够 2 次空，状态机才释放）
    "sit-then-leave": [(True, True, 2), (False, False, 3)],
    # 只坐不走
    "sit": [(True, True, 3)],
    # 只走不坐
    "leave": [(False, False, 3)],
    # 单束遮挡 —— 不该判定为有人（交叉校验的意义）
    "one-beam-only": [(True, False, 3)],
    # 抖动：坐下、被单束干扰、再坐下
    "flicker": [(True, True, 1), (True, False, 1), (True, True, 2)],
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="智座虚拟 ESP32")
    parser.add_argument("--server", default="http://127.0.0.1:5800")
    parser.add_argument("--device-id", default="AA:BB:CC:00:00:01", help="WiFi MAC 形态的设备 id")
    parser.add_argument("--seat-id", type=int, default=None, help="仅用于打印提示")
    parser.add_argument("--scenario", default="sit-then-leave", choices=sorted(SCENARIOS))
    parser.add_argument("--repeat", type=int, default=1, help="整个场景重复几轮")
    args = parser.parse_args(argv)

    device = VirtualEsp32(args.server, args.device_id)

    print(f"[1/3] 注册 {args.device_id} → {args.server}")
    registered = device.register()
    data = registered.get("data") or {}
    print(f"      is_new={data.get('is_new')}  config={json.dumps(device.config, ensure_ascii=False)}")

    print("[2/3] 拉一次配置（模拟周期拉取）")
    config = device.pull_config()
    if config is None:
        print("      ✗ 设备未注册 —— 智座不认识这个 device_id")
        return 2
    if config.get("seat_id") is None:
        print(
            "      ✗ 该设备还没绑定座位。\n"
            "        真机此时也无法上报 —— 请先在智座面板「传感器设备」里给它绑定座位，\n"
            "        或换一个已绑定的 device_id 重跑。"
        )
        return 3
    print(
        f"      绑定座位 seat_id={config['seat_id']} label={config.get('seat_label')} "
        f"floor={config.get('floor_id')} | ir_active_high={config.get('ir_active_high')} "
        f"interval={config.get('report_interval_ms')}ms sensor_type={config.get('sensor_type')}"
    )

    print(f"[3/3] 跑场景 {args.scenario} ×{args.repeat}")
    for round_index in range(args.repeat):
        if args.repeat > 1:
            print(f"  ── 第 {round_index + 1} 轮 ──")
        device.run_scenario(SCENARIOS[args.scenario])

    print("完成。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
