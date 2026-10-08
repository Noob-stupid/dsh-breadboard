/**
 * IPC 线上协议 —— 冻结契约（设计文档 §1.0 / §1.1 / §7.2）
 * @module dsh-hardware-sandbox/contracts/ipc
 *
 * ★ 架构前提（§1.0 决策 B）：**虚拟硬件权威侧在宿主 JS**。
 *   Python 侧 shim **只做序列化转发，不含任何硬件语义** —— 行为模型、虚拟时钟、状态
 *   全部在宿主。本文件定义的就是这条代理通道的线上格式。
 *
 * ── 三个已定的工程决策（都有实测理由，不是偏好）──
 *
 * ① **承载走 TCP 回环，不走 unix domain socket**
 *    Windows 没有原生 unix socket，而目标机就是 Windows。TCP 回环两端一致可用，
 *    还顺带白拿 §1.2「形态二」——项目进程可以独立启动、插件 attach，不必由插件 spawn。
 *
 * ② **分帧用 NDJSON（换行分隔 JSON），不用长度前缀**
 *    DSH 自己的 Python SDK（`python/sdk`）就是「宿主 ↔ 外部进程走 NDJSON-RPC」。
 *    对齐本仓库既定风格，且可读、可直接抓包肉眼调试 —— 对 P4「拦截完整性」排查很关键。
 *
 * ③ **必须带一次性 token**
 *    TCP 回环上任何本机进程都能连。没有 token 就是一个「谁都能读写的虚拟硬件后门」，
 *    而且它会推进虚拟时钟、篡改 SSOT。
 *
 * ★ 二进制用 `number[]`（每项 0–255）而不是 base64：
 *   I2C 单次读写本来就是几十字节量级，体积代价可忽略；
 *   换来的是日志里**肉眼可读**——调试「拦截是否完整」时这个价值远大于几个字节。
 */

/** 协议版本。双方不一致时握手直接失败，避免静默错配。 */
export const IPC_VERSION = 1 as const

/** 一个 TCP 帧的最大字节数（防止畸形输入打爆内存）。 */
export const IPC_MAX_FRAME_BYTES = 1024 * 1024

/* ───────────────────── 环境变量（宿主 → 项目进程） ───────────────────── */

/**
 * 注入给项目进程的环境变量名。
 *
 * ★ shim 靠这三个变量找到回连地址；宿主在 `subprocess.spawn` 的 `env` 里显式传入
 *   （`SubprocessSpawnSpec.env` 是「显式合并到已擦洗的父环境」，不是默认继承）。
 */
export const IPC_ENV = {
  /** 回连主机。目前恒为 '127.0.0.1'。 */
  host: 'DSH_HW_BRIDGE_HOST',
  /** 回连端口。由宿主监听 0 号端口后回填（OS 分配，避免固定端口冲突）。 */
  port: 'DSH_HW_BRIDGE_PORT',
  /** 一次性令牌。既做鉴权，也让「上一次仿真残留的进程」连不上新一次仿真。 */
  token: 'DSH_HW_BRIDGE_TOKEN',
  /** 协议版本，供 shim 自检。 */
  version: 'DSH_HW_BRIDGE_VERSION',
} as const

/* ───────────────────── 帧结构 ───────────────────── */

/** 请求 id：宿主按它把响应配回请求。同一连接内单调递增即可。 */
export type IpcRequestId = number

/** Python → 宿主 的方法名。 */
export type IpcMethod =
  | 'hello'
  | 'i2c_read'
  | 'i2c_write'
  | 'clock_advance'
  | 'gpio_write'
  | 'gpio_read'
  | 'log'

/** 一次请求。 */
export interface IpcRequest {
  readonly id: IpcRequestId
  readonly method: IpcMethod
  /** 方法入参。省略等价于 `{}`。 */
  readonly params?: unknown
}

/** 一次成功响应。**`result` 必须存在**（可为 null），与 `error` 互斥。 */
export interface IpcSuccess {
  readonly id: IpcRequestId
  readonly result: unknown
}

/** 错误码。 */
export type IpcErrorCode =
  | 'bad_frame'         // 不是合法 JSON / 缺 id 或 method
  | 'bad_params'        // 参数形状不对
  | 'unknown_method'    // 未实现的方法
  | 'no_device'         // 该地址上没有设备应答（I2C NACK）
  | 'disconnected'      // 设备被故障注入断开
  | 'internal'          // 宿主侧异常

/** 一次失败响应。 */
export interface IpcFailure {
  readonly id: IpcRequestId
  readonly error: { readonly code: IpcErrorCode; readonly message: string }
}

export type IpcResponse = IpcSuccess | IpcFailure

/* ───────────────────── 各方法入参 / 出参 ───────────────────── */
/*
 * ★ 命名规则：本文件的载荷类型**一律带 `Ipc` 前缀**。
 *   这不是风格偏好 —— `contracts/index.ts` 用 `export *` 做总出口，而 ESM 里
 *   两个 `export *` 来源导出**同名**成员会让该名字变成歧义（`tsc` 报 TS2308，
 *   运行时该名字静默不导出）。实测：本文件原先的 `I2CReadResult` 与 device.ts
 *   的 `I2CReadResult` 撞名，正是这种「编译报错、运行静默丢名字」的隐蔽故障。
 *   带前缀后两侧命名空间天然分开。
 */

export interface IpcHelloParams {
  readonly version: number
  /** 一次性令牌。 */
  readonly token: string
  /** 项目进程 pid，仅用于日志与排查。 */
  readonly pid: number
  /** Python 版本串，仅用于日志。 */
  readonly python: string
}
export interface IpcHelloResult {
  readonly ok: true
  /** 宿主侧插件版本，便于对照排查。 */
  readonly hostVersion: string
  /** 本次仿真已挂载的虚拟设备 id，让 shim 侧日志能报出「总线上有什么」。 */
  readonly devices: readonly string[]
}

/**
 * I2C 读（对应项目里的 `bus.read_byte_data(addr, reg)` / `read_i2c_block_data`）。
 *
 * ★ 这是 P4「拦截完整性」的核心入口：项目代码里**每一条**硬件读取路径最终都必须
 *   走到这里。任何绕过它的直通都是漏网。
 */
export interface IpcI2CReadParams {
  /** 7 位从机地址。 */
  readonly address: number
  /** 目标寄存器。 */
  readonly register: number
  /** 读取字节数。 */
  readonly length: number
}
export interface IpcI2CReadResult {
  /** 读到的字节，每项 0–255。 */
  readonly data: readonly number[]
}

/** I2C 写（对应 `write_byte_data` / `write_i2c_block_data`）。 */
export interface IpcI2CWriteParams {
  readonly address: number
  readonly register: number
  readonly data: readonly number[]
}
export interface IpcI2CWriteResult {
  /** 写入是否被设备接受。false = NACK。 */
  readonly ack: boolean
}

/**
 * 推进虚拟时钟（对应项目里的 `time.sleep()`，§7.2「把时间当成可拦截的接口」）。
 *
 * ★ 这是整个闭环的心跳：宿主收到后推进虚拟时钟并按时间片 tick 所有设备。
 *   项目进程在这一往返期间是**阻塞**的——这正是确定性仿真想要的效果。
 */
export interface IpcClockAdvanceParams {
  /** 推进的虚拟时长（秒）。 */
  readonly seconds: number
}
export interface IpcClockAdvanceResult {
  /**
   * 推进后的虚拟时刻（**整数微秒**）。
   * ★ 权威值是整数微秒而非浮点秒 —— 见 contracts/time.ts 的说明（浮点累加会漂）。
   */
  readonly nowMicros: number
  /** 本次实际推进的微秒数（可能因护栏被截断）。 */
  readonly advancedMicros: number
}

/** GPIO 写（对应 `RPi.GPIO.output`）。本期只实现协议，行为模型后置。 */
export interface IpcGpioWriteParams {
  readonly pin: number
  readonly value: 0 | 1
}
export interface IpcGpioWriteResult {
  readonly ok: true
}

/** GPIO 读（对应 `RPi.GPIO.input`）。 */
export interface IpcGpioReadParams {
  readonly pin: number
}
export interface IpcGpioReadResult {
  readonly value: 0 | 1
}

/**
 * 项目进程的日志输出（stdout/stderr 的一行）。
 *
 * ★ 由 shim 主动上报而不是宿主抓子进程 stdout：这样能保留「哪一行属于哪次硬件访问」
 *   的因果顺序，调试拦截完整性时比裸 stdout 有用得多。
 */
export interface IpcLogParams {
  readonly stream: 'stdout' | 'stderr'
  readonly text: string
}
export interface IpcLogResult {
  readonly ok: true
}

/* ───────────────────── 方法签名表（便于两侧对照与类型收窄） ───────────────────── */

export interface IpcMethodMap {
  readonly hello: { params: IpcHelloParams; result: IpcHelloResult }
  readonly i2c_read: { params: IpcI2CReadParams; result: IpcI2CReadResult }
  readonly i2c_write: { params: IpcI2CWriteParams; result: IpcI2CWriteResult }
  readonly clock_advance: { params: IpcClockAdvanceParams; result: IpcClockAdvanceResult }
  readonly gpio_write: { params: IpcGpioWriteParams; result: IpcGpioWriteResult }
  readonly gpio_read: { params: IpcGpioReadParams; result: IpcGpioReadResult }
  readonly log: { params: IpcLogParams; result: IpcLogResult }
}

/** 需要先完成 `hello` 握手才允许调用的方法（防止未鉴权推进虚拟时钟）。 */
export const IPC_METHODS_REQUIRING_HELLO: readonly IpcMethod[] = [
  'i2c_read',
  'i2c_write',
  'clock_advance',
  'gpio_write',
  'gpio_read',
]

/* ───────────────────── 编解码小工具（两侧共用同一实现，避免各写一份） ───────────────────── */

/** 编码一帧：JSON + 单个换行。**换行是唯一分隔符**，所以 JSON 内不能有裸换行（JSON.stringify 本来就不会产出）。 */
export function encodeFrame(message: IpcRequest | IpcResponse): string {
  return `${JSON.stringify(message)}\n`
}

/**
 * 从缓冲区里切出完整帧。
 *
 * @returns 解析出的消息与**剩余的未完成字节**；调用方把剩余部分留到下次。
 */
export function decodeFrames(buffer: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = []
  let rest = buffer
  let index = rest.indexOf('\n')
  while (index >= 0) {
    const line = rest.slice(0, index)
    rest = rest.slice(index + 1)
    if (line.trim().length > 0) messages.push(JSON.parse(line))
    index = rest.indexOf('\n')
  }
  return { messages, rest }
}
