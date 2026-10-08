"""``smbus`` 的虚拟替身 —— 仅代理，无硬件语义（设计文档 §1.0 / §12.1）

项目里 ``import smbus`` 会命中本模块（shim 目录在 PYTHONPATH 前面），
所有调用被转发给宿主 BridgeServer 上的虚拟设备。

★ 实现范围与**编码约定**（这些约定决定 §3.2「结果一致性」能否成立）：

===============  ============================================================
方法              约定
===============  ============================================================
read_byte_data   读 1 字节
read_word_data   **低字节在前**（SMBus Read Word 规范），即 value = b0 | b1<<8
read_i2c_block_data  原样返回 length 字节
write_byte_data  写 1 字节
write_word_data  **低字节在前**，与 read_word_data 对称
write_i2c_block_data 原样写
===============  ============================================================

★ 未实现的 SMBus 专属协议（``read_block_data`` / ``process_call`` 等）会**明确抛
  ``NotImplementedError``**，绝不静默返回假数据 —— 静默会让 P4「拦截完整性」
  排查时误判该路径已覆盖（与宿主侧 BridgeServer 同一原则）。
"""

from __future__ import annotations

from typing import Iterable, List

import bridge_client

__all__ = ["SMBus"]

#: 真实 smbus 用的 errno（Remote I/O error），异常类型见 bridge_client.BridgeError
EREMOTEIO = bridge_client.EREMOTEIO


class SMBus:
    """SMBus 设备访问。**只做转发**，不做任何缓存或解释。"""

    def __init__(self, bus: int | None = None) -> None:
        # bus 号在虚拟环境里无意义（总线的拓扑由宿主的 AssemblyState 决定），
        # 但保留参数以兼容 ``SMBus(1)`` 这种写法。
        self.bus = bus
        self._client = bridge_client.get_client()

    # ─────────────────────── 生命周期 ───────────────────────

    def open(self, bus: int) -> None:
        self.bus = bus

    def close(self) -> None:
        # 连接是进程级共享的，这里不关 —— 关掉会影响同一进程里其它 SMBus 实例
        pass

    def __enter__(self) -> "SMBus":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    # ─────────────────────── 读 ───────────────────────

    def read_byte(self, addr: int) -> int:
        return self._client.i2c_read(addr, 0x00, 1)[0]

    def read_byte_data(self, addr: int, cmd: int) -> int:
        return self._client.i2c_read(addr, cmd, 1)[0]

    def read_word_data(self, addr: int, cmd: int) -> int:
        # ★ SMBus Read Word 是低字节在前
        data = self._client.i2c_read(addr, cmd, 2)
        return data[0] | (data[1] << 8)

    def read_i2c_block_data(self, addr: int, cmd: int, length: int) -> List[int]:
        return list(self._client.i2c_read(addr, cmd, length))

    # ─────────────────────── 写 ───────────────────────

    def write_quick(self, addr: int) -> None:
        self._client.i2c_write(addr, 0x00, [])

    def write_byte(self, addr: int, value: int) -> None:
        self._client.i2c_write(addr, 0x00, [_byte(value)])

    def write_byte_data(self, addr: int, cmd: int, value: int) -> None:
        self._client.i2c_write(addr, cmd, [_byte(value)])

    def write_word_data(self, addr: int, cmd: int, value: int) -> None:
        # 与 read_word_data 对称：低字节在前
        self._client.i2c_write(addr, cmd, [value & 0xFF, (value >> 8) & 0xFF])

    def write_i2c_block_data(self, addr: int, cmd: int, values: Iterable[int]) -> None:
        self._client.i2c_write(addr, cmd, [_byte(v) for v in values])

    # ─────────────────────── 明确不支持 ───────────────────────

    def read_block_data(self, addr: int, cmd: int) -> List[int]:
        raise NotImplementedError(
            "read_block_data 走的是 SMBus Block Read 协议（带长度前缀 + PEC），"
            "本期 IPC 未建模该协议。请改用 read_i2c_block_data。"
        )

    def write_block_data(self, addr: int, cmd: int, values: Iterable[int]) -> None:
        raise NotImplementedError(
            "write_block_data 走的是 SMBus Block Write 协议（带长度前缀 + PEC），"
            "本期 IPC 未建模该协议。请改用 write_i2c_block_data。"
        )

    def process_call(self, addr: int, cmd: int, value: int) -> int:
        raise NotImplementedError("process_call 本期未建模")

    def block_process_call(self, addr: int, cmd: int, values: Iterable[int]) -> List[int]:
        raise NotImplementedError("block_process_call 本期未建模")


def _byte(value: int) -> int:
    """夹到 0–255，与真实 smbus 的字节语义一致。"""
    if not 0 <= value <= 0xFF:
        raise ValueError(f"字节值越界：{value}")
    return value
