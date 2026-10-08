#!/usr/bin/env python3
"""流程 C 的异常路径验证：故障注入后，**项目代码必须观察到异常**。

设计文档 §8 流程 C：
    传感器断连时项目未捕获异常 → 报告「建议加 try/except」

要能给出这个报告，前提是**虚拟环境下的失败方式与真实硬件一致**（§3.2「异常一致」）。
真实 Linux 上 smbus 访问失败的异常是 ``OSError``（errno 121, Remote I/O error），
所以 shim 也抛同样的东西 —— 项目的 ``except OSError`` 分支在两边走同一条路径。

★ 本脚本演示了一个**加速仿真的关键性质**，值得所有宿主侧干预记住：

    **虚拟 ``time.sleep`` 是瞬时的**（它只推虚拟时钟，不花真实时间），
    所以「等一会儿再注入」这种墙钟思路在加速模式下必然失效 ——
    整个脚本可能几十毫秒就跑完了。

    正确做法是**由事件触发**：项目发一个就绪信号，宿主收到后立即注入，
    项目再用**真实** sleep 留出注入窗口（shim 刻意保留了 ``time._dsh_real_sleep``）。
"""

from __future__ import annotations

import json
import sys
import time

import bridge_client
import smbus

TEST_ADDR = 0x48


def main() -> int:
    bus = smbus.SMBus(1)

    first = bus.read_i2c_block_data(TEST_ADDR, 0x00, 2)
    print(json.dumps({"first": first}), flush=True)

    # ① 事件就绪信号：宿主 onLog 收到它才注入故障（不靠墙钟）
    bridge_client.get_client().log("stdout", "READY_FOR_FAULT")

    # ② 用**真实** sleep 留出注入窗口。虚拟 sleep 是瞬时的，给不了窗口。
    real_sleep = getattr(time, "_dsh_real_sleep", time.sleep)
    real_sleep(0.3)

    outcome: dict[str, object]
    try:
        bus.read_i2c_block_data(TEST_ADDR, 0x00, 2)
        outcome = {"raised": False, "note": "断连后仍然读成功，异常路径未生效"}
    except OSError as exc:
        outcome = {
            "raised": True,
            "errno": exc.errno,
            "is_oserror": True,
            "message": str(exc),
        }

    print(json.dumps(outcome))
    return 0


if __name__ == "__main__":
    sys.exit(main())
