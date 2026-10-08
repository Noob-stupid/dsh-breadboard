#!/usr/bin/env python3
"""§7.4 test_clock.py —— **项目侧**脚本（由宿主作为子进程拉起）

这就是设计文档里那段验收代码，只是把它写成真能跑的脚本：

    readings = []
    for i in range(5):
        readings.append(i2c.read(TEST_ADDR, 0x00, 2))
        time.sleep(1)
    assert readings == [1, 2, 3, 4, 5]

★ 注意它长得**完全像一段真实的树莓派项目代码**：用真正的 ``smbus`` API、
  真正的 ``time.sleep``。之所以能跑在虚拟硬件上，是因为 shim 目录在
  PYTHONPATH 前面把两者都接走了 —— 这正是「语义等价 + 适配层」的形态（§3）。

输出一行 JSON 给宿主侧的测试断言。
"""

from __future__ import annotations

import json
import sys
import time

import smbus

TEST_ADDR = 0x48


def main() -> int:
    bus = smbus.SMBus(1)

    readings = []
    for _ in range(5):
        data = bus.read_i2c_block_data(TEST_ADDR, 0x00, 2)
        readings.append(data[0] * 256 + data[1])
        # ★ 这一行本该真的睡 1 秒。被 shim 接走后，它推进的是**虚拟时钟**。
        time.sleep(1)

    print(json.dumps({"readings": readings}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
