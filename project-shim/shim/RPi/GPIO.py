"""``RPi.GPIO`` 的虚拟替身。

★ **本期范围外**（设计文档 §9.2：协议只支持 I2C）。所以这里采取的策略是：

  · ``setmode`` / ``setup`` / ``cleanup`` —— **配置类调用，做成 no-op**。
    它们配置的是真实硬件的引脚方向，虚拟环境里无对应物；让它们通过，
    失败点才会落在**真正的硬件访问**上，而不是在项目启动时就炸掉。

  · ``output`` / ``input`` —— **真正的硬件访问**，明确抛 ``NotImplementedError``。
    绝不静默返回假值：静默会让 P4「拦截完整性」排查时误判该路径已覆盖。

  这样 GPIO 项目的失败信息是"你用了本期不支持的 GPIO"，而不是一句含糊的 ImportError。
"""

from __future__ import annotations

BCM = 11
BOARD = 10
Bcm = BCM
Board = BOARD

IN = 1
OUT = 0

LOW = 0
HIGH = 1

PUD_OFF = 20
PUD_DOWN = 21
PUD_UP = 22

RISING = 31
FALLING = 32
BOTH = 33

_unsupported = (
    "RPi.GPIO 的引脚读写本期未实现（设计文档 §9.2：协议只支持 I2C）。"
    "如果这个项目确实依赖 GPIO，请告知我们把它排进 M2 的协议扩展。"
)


def setmode(mode: int) -> None:
    """no-op：配置引脚编号方式，虚拟环境无对应物。"""


def setup(pin: int | list[int], direction: int, pull_up_down: int = PUD_OFF, initial: int | None = None) -> None:
    """no-op：配置引脚方向，虚拟环境无对应物。"""


def cleanup(pin: int | list[int] | None = None) -> None:
    """no-op：释放引脚，虚拟环境无对应物。"""


def output(pin: int | list[int], value: int) -> None:
    raise NotImplementedError(_unsupported)


def input(pin: int) -> int:
    raise NotImplementedError(_unsupported)


def add_event_detect(*args: object, **kwargs: object) -> None:
    raise NotImplementedError(_unsupported)


def remove_event_detect(*args: object, **kwargs: object) -> None:
    raise NotImplementedError(_unsupported)


def wait_for_edge(*args: object, **kwargs: object) -> None:
    raise NotImplementedError(_unsupported)


def setwarnings(flag: bool) -> None:
    """no-op。"""


class PWM:
    def __init__(self, *args: object, **kwargs: object) -> None:
        raise NotImplementedError(_unsupported)
