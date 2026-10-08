"""注入入口（设计文档 §7.2 / §12.1）

Python 在解释器启动时会自动 import ``sitecustomize``（只要它在 ``sys.path`` 上）。
宿主把 ``project-shim`` 放进项目进程的 ``PYTHONPATH``，本文件就会在**项目代码运行之前**
完成拦截安装 —— 这是 §1.1「注入时机确定」的落点。

★ 拦截的核心洞察（§7.2）：**把"时间"也当成一个可拦截的接口**。
  ``time.sleep`` 被换成一次 ``clock_advance`` IPC 调用，宿主据此按时间片推进
  虚拟时钟并 tick 所有设备。没有这一步，``while True: read(); sleep(1)`` 会永远
  读到同一个值。

★ 惰性铁律：**没有注入 ``DSH_HW_BRIDGE_*`` 时本模块什么都不做**。
  同一个 ``project-shim`` 目录可能被误挂到 PYTHONPATH 上，那时它必须完全无害。
"""

from __future__ import annotations

import sys

try:
    import bridge_client
except ImportError:  # pragma: no cover - 路径没配好时保持沉默，不干扰项目启动
    bridge_client = None  # type: ignore[assignment]


def _install_sleep_interception() -> bool:
    """把 ``time.sleep`` 换成虚拟时钟推进。返回是否安装成功。"""
    import time as _time

    #: 保留真实 sleep —— IPC 层/调试偶尔需要真的睡一下
    _real_sleep = _time.sleep

    def _virtual_sleep(seconds: float) -> None:
        if seconds is None:
            raise TypeError("sleep() 需要一个参数")
        # 与真实 time.sleep 一致地拒绝负数
        if seconds < 0:
            raise ValueError("sleep length must be non-negative")
        if seconds == 0:
            return
        bridge_client.get_client().clock_advance(float(seconds))

    _time.sleep = _virtual_sleep  # type: ignore[assignment]
    _time._dsh_real_sleep = _real_sleep  # type: ignore[attr-defined]
    return True


if bridge_client is not None and bridge_client.bridge_configured():
    try:
        _install_sleep_interception()
    except Exception as exc:  # pragma: no cover - 拦截失败不应阻断项目启动
        print(f"[dsh-hw-shim] time.sleep 拦截安装失败：{exc}", file=sys.stderr)
