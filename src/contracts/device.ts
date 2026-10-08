/**
 * 虚拟设备契约 —— 冻结契约（owner: session-24ca6e69）
 * @module dsh-hardware-sandbox/contracts/device
 *
 * ★ 权威侧在宿主（JS/Node）。Python 侧 shim 只做序列化代理，不含任何硬件语义（设计文档 §1.0）。
 *   因此本文件定义的是**唯一一份**行为模型接口，不存在第二实现。
 */
import type { TickContext } from './time.ts'

/** 协议族。本期只实现 i2c，其余为契约占位（§9.2 范围控制：协议只支持 I2C）。 */
export type Protocol = 'i2c' | 'spi' | 'uart' | 'gpio' | 'power'

/** 设备类别，用于行为模型查找与场景建模。 */
export type DeviceKind =
  | 'sensor'      // BME280 等
  | 'mcu'         // 树莓派 / ESP32
  | 'display'
  | 'actuator'
  | 'passive'     // 电阻 / 电容
  | 'test'        // 验收专用（确定性设备）

/** 设备运行状态，供场景着色与 DS 观察。 */
export type DeviceStatus = 'ok' | 'busy' | 'disconnected' | 'faulted'

/**
 * 设备自述快照。挂在 AssemblyState 上（单一 SSOT，§6.1），
 * 由前端场景**采样读取**，不做副本。
 */
export interface DeviceSnapshot {
  readonly id: string
  readonly kind: DeviceKind
  /** 展示名，如 'BME280 @0x76'。 */
  readonly label: string
  readonly status: DeviceStatus
  /**
   * 实时读数。值必须是 JSON 可序列化标量 —— 它要跨 realm 到浏览器渲染气泡。
   * 键名稳定（前端与 DS 都按名取值）。
   */
  readonly readings: Readonly<Record<string, number | string | boolean | null>>
  /**
   * 这台设备**属于哪一类**虚拟硬件。
   *
   * · `'bus'`（省略时的默认）—— 总线设备，由**虚拟时钟**驱动，可加速
   * · `'network'` —— **联网设备**，按**墙钟**走（见 `contracts/network.ts` 的长注释）
   *
   * ★ 必须可区分：两者的时刻语义**不同**。界面若把联网设备画在虚拟时间轴上，
   *   用户会以为它跟着仿真加速 —— 而它没有。
   */
  readonly transport?: 'bus' | 'network'
}

/** 一次 I2C 读请求（由 BridgeServer 从 Python shim 反序列化而来）。 */
export interface I2CReadRequest {
  /** 7 位从机地址。 */
  readonly address: number
  /** 目标寄存器。 */
  readonly register: number
  /** 读取字节数。 */
  readonly length: number
}

/**
 * I2C 读结果。
 * `null` 表示**本设备不认这个地址**，交总线上的下一个设备处理 —— 不是错误。
 */
export type I2CReadResult = Uint8Array | null

/** 一次 I2C 写请求。 */
export interface I2CWriteRequest {
  readonly address: number
  readonly register: number
  readonly data: Uint8Array
  /** 写入的后续字节（连续写 `write()` 的累积值，供需要整块数据的设备使用）。 */
  readonly payload: Uint8Array
}

/** 故障类型（对应工具 `hw_inject_fault`，§5.4）。 */
export type DeviceFaultType =
  | 'disconnect'        // 拔线：后续访问返回 NACK / 抛异常
  | 'nack'              // 单次 NACK
  | 'busy'              // 一直 busy
  | 'set_reading'       // 强制读数（如把温度拽到 -40°C）
  | 'clear'             // 清除全部故障

/** 一次故障注入。 */
export interface DeviceFault {
  readonly type: DeviceFaultType
  /** `set_reading` 时指定：读数字段名 → 目标值。 */
  readonly readings?: Readonly<Record<string, number>>
}

/**
 * 虚拟设备行为模型。
 *
 * ★ `tick` 是整个闭环的心跳（§5.2），由虚拟时钟按时间片驱动。
 * ★ `tick` 必须**纯同步、无 IO、无真随机**。需要随机漂移的模型必须自带固定种子（§0.4）。
 */
export interface VirtualDevice {
  readonly id: string
  readonly kind: DeviceKind

  /**
   * 按时间片推进内部状态。
   *
   * ★ 实现者必须能容忍「同一个 nowMicros 被 tick 多次」之外的任意切片序列，
   *   且**优先由 `ctx.nowMicros` 推导周期事件**而非累加 `ctx.delta` —— 前者对跳空安全。
   */
  tick(ctx: TickContext): void

  /** 当前状态快照。必须是无副作用纯函数。 */
  snapshot(): DeviceSnapshot

  /**
   * 加速模式的跳空声明（设计文档 §7.3「加速模式用事件优先队列跳过空闲区间」）。
   *
   *  - 返回 `null`  → 本设备需要**每一个时间片**（默认；积分型模型如 BME280 漂移必须如此）
   *  - 返回 `Δ`（秒，>0） → 本设备下一个有意义的事件在 Δ 之后，其间无需 tick
   *
   * ★ 只要**任何一台**设备返回 `null`，时钟就不得跳空。省略该方法等价于返回 `null`。
   */
  nextEventIn?(): number | null

  /** I2C 读。不认该地址时返回 `null`。 */
  onI2CRead?(request: I2CReadRequest): I2CReadResult

  /** I2C 写。 */
  onI2CWrite?(request: I2CWriteRequest): void

  /** 故障注入。 */
  injectFault?(fault: DeviceFault): void
}
