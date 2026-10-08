"""DSH 硬件沙盒 · IPC 客户端（设计文档 §1.1 / §12.1）

★ 本模块**只做序列化转发，不含任何硬件语义**（§1.0 铁律）。
  所有行为模型、虚拟时钟、状态都在宿主 JS 侧。这里出现任何"温度是多少"之类
  的逻辑，都是架构错误。

通道：TCP 回环 + 一次性 token + NDJSON（换行分隔 JSON）。
  对齐 DSH 自带 Python SDK 的风格，抓包可读 —— 排查 P4「拦截完整性」时这点很关键。

★ 异常语义（§3.2「异常一致」）：硬件访问失败一律抛 `BridgeError`，
  它是 `OSError` 的子类且 errno = 121（EREMOTEIO）——与真实 Linux 上
  smbus 访问失败时项目会看到的异常一致，所以项目的 `except OSError` 分支
  在虚拟与真实环境下走同一条路径。
"""

from __future__ import annotations

import itertools
import json
import os
import socket
import threading
from typing import Any, Iterable

__all__ = ["BridgeClient", "BridgeError", "get_client"]

# 与宿主 src/contracts/ipc.ts 的 IPC_ENV 逐字对应
ENV_HOST = "DSH_HW_BRIDGE_HOST"
ENV_PORT = "DSH_HW_BRIDGE_PORT"
ENV_TOKEN = "DSH_HW_BRIDGE_TOKEN"
ENV_VERSION = "DSH_HW_BRIDGE_VERSION"

#: 宿主侧协议版本（与 contracts/ipc.ts 的 IPC_VERSION 对应）
PROTOCOL_VERSION = 1

#: 真实 Linux smbus 访问失败时的 errno（Remote I/O error）
EREMOTEIO = 121


class BridgeError(OSError):
    """硬件访问失败。

    继承 ``OSError`` 并携带 errno 121，使得项目的异常处理分支与真实硬件一致。
    """

    def __init__(self, code: str, message: str) -> None:
        self.code = code
        self.message = message
        super().__init__(EREMOTEIO, message)

    def __str__(self) -> str:  # pragma: no cover - 仅在打印时用到
        return f"[{self.code}] {self.message}"


class BridgeClient:
    """到宿主 BridgeServer 的同步 IPC 客户端。

    连接是**惰性建立**的：单纯 ``import smbus`` 不会去连，
    只有真正发生硬件访问时才连 —— 这样没跑仿真的项目也不受影响。
    """

    def __init__(self, host: str, port: int, token: str, version: int = PROTOCOL_VERSION) -> None:
        self._host = host
        self._port = port
        self._token = token
        self._version = version

        self._sock: socket.socket | None = None
        self._file = None
        self._ids = itertools.count(1)
        #: 串行化请求：IPC 是请求-响应式的，同一连接上并发会串包
        self._lock = threading.RLock()
        self._handshaken = False

    # ─────────────────────── 连接管理 ───────────────────────

    def _ensure_connected(self) -> None:
        if self._sock is not None and self._handshaken:
            return

        try:
            sock = socket.create_connection((self._host, self._port), timeout=10.0)
        except OSError as exc:
            raise BridgeError("no_bridge", f"连不上宿主 BridgeServer {self._host}:{self._port}：{exc}") from exc

        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self._sock = sock
        self._file = sock.makefile("rwb")

        hello = {
            "version": self._version,
            "token": self._token,
            "pid": os.getpid(),
            "python": _python_version(),
        }
        # 握手自己不能走 call()（会递归进 _ensure_connected）
        self._handshaken = True
        try:
            result = self._call_locked("hello", hello)
        except BaseException:
            self._handshaken = False
            self.close()
            raise
        self._devices = tuple(result.get("devices", ()))

    def close(self) -> None:
        """关闭连接。重复调用安全。"""
        with self._lock:
            if self._file is not None:
                try:
                    self._file.close()
                except OSError:
                    pass
                self._file = None
            if self._sock is not None:
                try:
                    self._sock.close()
                except OSError:
                    pass
                self._sock = None
            self._handshaken = False

    @property
    def devices(self) -> tuple[str, ...]:
        """宿主侧已挂载的虚拟设备 id（握手时取得，仅用于日志）。"""
        self._ensure_connected()
        return getattr(self, "_devices", ())

    # ─────────────────────── 帧收发 ───────────────────────

    def _call_locked(self, method: str, params: Any = None) -> Any:
        if self._file is None or self._sock is None:
            raise BridgeError("not_connected", "连接尚未建立")

        request_id = next(self._ids)
        frame = {"id": request_id, "method": method}
        if params is not None:
            frame["params"] = params

        try:
            self._file.write((json.dumps(frame) + "\n").encode("utf-8"))
            self._file.flush()
            line = self._file.readline()
        except OSError as exc:
            self.close()
            raise BridgeError("io_error", f"IPC 收发失败：{exc}") from exc

        if not line:
            self.close()
            raise BridgeError("io_error", "宿主关闭了连接（仿真是否已结束？）")

        try:
            response = json.loads(line.decode("utf-8"))
        except ValueError as exc:
            raise BridgeError("bad_frame", f"宿主回包不是合法 JSON：{line[:200]!r}") from exc

        if "error" in response:
            error = response["error"]
            raise BridgeError(str(error.get("code", "internal")), str(error.get("message", "")))
        return response.get("result")

    def call(self, method: str, params: Any = None) -> Any:
        """发一个请求并等响应（线程安全）。"""
        with self._lock:
            self._ensure_connected()
            return self._call_locked(method, params)

    # ─────────────────────── 硬件访问（纯转发） ───────────────────────

    def i2c_read(self, address: int, register: int, length: int) -> bytes:
        """读 ``length`` 字节。失败抛 :class:`BridgeError`（errno 121）。"""
        result = self.call("i2c_read", {"address": address, "register": register, "length": length})
        return bytes(result["data"])

    def i2c_write(self, address: int, register: int, data: Iterable[int]) -> None:
        """写一串字节。"""
        self.call("i2c_write", {"address": address, "register": register, "data": list(data)})

    def clock_advance(self, seconds: float) -> int:
        """推进虚拟时钟并返回推进后的虚拟时刻（**整数微秒**）。

        ★ 这是 ``time.sleep`` 的落点（§7.2）：把"时间"当成可拦截的接口。
          调用期间宿主会按时间片 tick 所有虚拟设备，所以设备状态真的在前进。
        """
        result = self.call("clock_advance", {"seconds": seconds})
        return int(result["nowMicros"])

    def gpio_write(self, pin: int, value: int) -> None:
        self.call("gpio_write", {"pin": pin, "value": 1 if value else 0})

    def gpio_read(self, pin: int) -> int:
        result = self.call("gpio_read", {"pin": pin})
        return int(result["value"])

    def log(self, stream: str, text: str) -> None:
        """把一行日志上报给宿主（保留与硬件访问的因果顺序）。"""
        try:
            self.call("log", {"stream": stream, "text": text})
        except BridgeError:
            # 日志失败绝不能影响项目运行
            pass


def _python_version() -> str:
    import platform

    return platform.python_version()


# ─────────────────────── 进程级单例 ───────────────────────

_client: BridgeClient | None = None
_client_lock = threading.Lock()


def bridge_configured() -> bool:
    """宿主是否注入了回连参数。

    ★ 没有注入时整个 shim 应当**完全惰性** —— 同一个 ``project-shim`` 目录
      可能被误挂到 PYTHONPATH 上，那时它不该改变任何行为。
    """
    return bool(os.environ.get(ENV_HOST) and os.environ.get(ENV_PORT) and os.environ.get(ENV_TOKEN))


def get_client() -> BridgeClient:
    """取得进程级单例客户端。未注入回连参数时抛错。"""
    global _client
    if _client is not None:
        return _client

    with _client_lock:
        if _client is not None:
            return _client

        host = os.environ.get(ENV_HOST)
        port = os.environ.get(ENV_PORT)
        token = os.environ.get(ENV_TOKEN)
        if not host or not port or not token:
            raise BridgeError(
                "no_bridge",
                "未找到 DSH_HW_BRIDGE_* 环境变量 —— 本进程不是由硬件沙盒插件托管的，"
                "虚拟硬件不可用",
            )

        version = int(os.environ.get(ENV_VERSION) or PROTOCOL_VERSION)
        _client = BridgeClient(host, int(port), token, version)
        return _client
