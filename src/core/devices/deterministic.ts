/**
 * DeterministicTestDevice —— 验收专用确定性设备（设计文档 §0.4 P3）
 * @module dsh-hardware-sandbox/core/devices/deterministic
 *
 * 设计文档给的原型是「每次 tick 就 +1」。**那个原型与 §7.3 的时钟设计自相矛盾**，
 * 必须修正，否则 P3 的断言 `readings == [1,2,3,4,5]` 永远不可能成立：
 *
 *   若 `tick` 每次 +1，而 `advance(1.0)` 在 step=1ms 下要 tick **1000 次**，
 *   则第一次读数就是 1000，五次读数会是 [1000, 2000, 3000, 4000, 5000]。
 *
 * 本实现的修正（两条，都是把「说不清」变成「说得清」）：
 *
 * ① **按采样周期结转而非按 tick 计数**：设备累加的是虚拟时间，每满 `period` 秒
 *    产生一次采样。`advance(1.0)` 恰好推进 1.0 秒 → 恰好 +1 次采样。
 *    定义文档的 `readings == [1,2,3,4,5]` 因此**逐字成立**。
 *
 * ② **初值为 1 而非 0**：文档的测试循环是「先读、后睡」——
 *    第 1 次读发生在任何 sleep 之前。真实传感器上电即产出首个有效读数，
 *    所以 t=0 时已有第 1 个采样，初值为 1 是**物理正确**的，不是凑数。
 *
 * 副产品：这个修正让 P3 变成一条**更强的**判据 —— 它同时验证了
 * 「1000 个 1ms 时间片必须精确累加为 1.0 秒」（整数微秒时钟的核心性质）。
 */
import type {
  DeviceFault,
  DeviceSnapshot,
  I2CReadRequest,
  I2CReadResult,
  I2CWriteRequest,
  VirtualDevice,
} from '../../contracts/device.ts'
import type { Micros, TickContext } from '../../contracts/time.ts'
import { MICROS_PER_SECOND, secondsToMicros } from '../../contracts/time.ts'

export interface DeterministicDeviceOptions {
  readonly id?: string
  /** 采样周期（秒）。默认 1.0 —— 与文档测试的 `sleep(1)` 对齐。 */
  readonly period?: number
  /** I2C 从机地址。默认 0x48。 */
  readonly address?: number
  /** t=0 时已有几个采样。默认 1（上电即有首读）。 */
  readonly initialSamples?: number
}

/** 大端编码为定长字节串。 */
function encodeBigEndian(value: number, length: number): Uint8Array {
  const out = new Uint8Array(length)
  let rest = Math.max(0, Math.trunc(value))
  for (let i = length - 1; i >= 0; i -= 1) {
    out[i] = rest & 0xff
    rest = Math.floor(rest / 256)
  }
  return out
}

export class DeterministicTestDevice implements VirtualDevice {
  readonly id: string
  readonly kind = 'test' as const
  readonly address: number

  readonly #periodMicros: Micros
  readonly #initialSamples: number

  /** 当前采样序号（1 基）。t=0 时为 `initialSamples`。 */
  #samples: number
  /** 被时钟 tick 过的次数。★ 这是「时间片无丢失」的探针（T3）。 */
  #tickCount = 0
  #status: DeviceSnapshot['status'] = 'ok'

  constructor(options: DeterministicDeviceOptions = {}) {
    const period = options.period ?? 1
    if (!Number.isFinite(period) || period <= 0) {
      throw new Error(`DeterministicTestDevice 的 period 必须是正的有限秒数，收到 ${String(period)}`)
    }
    this.#periodMicros = secondsToMicros(period)
    if (this.#periodMicros < 1) {
      throw new Error(`DeterministicTestDevice 的 period 太小：${period}s 折算不足 1 微秒`)
    }

    const initialSamples = options.initialSamples ?? 1
    if (!Number.isInteger(initialSamples) || initialSamples < 0) {
      throw new Error(`initialSamples 必须是非负整数，收到 ${String(initialSamples)}`)
    }

    const address = options.address ?? 0x48
    if (!Number.isInteger(address) || address < 0 || address > 0x7f) {
      throw new Error(`I2C 地址必须是 7 位整数（0–127），收到 ${String(address)}`)
    }

    this.id = options.id ?? 'deterministic'
    this.address = address
    this.#initialSamples = initialSamples
    this.#samples = initialSamples
  }

  /** 当前采样序号（1 基）。 */
  get samples(): number {
    return this.#samples
  }

  /** 被 tick 的次数。 */
  get tickCount(): number {
    return this.#tickCount
  }

  get status(): DeviceSnapshot['status'] {
    return this.#status
  }

  /**
   * 由 `ctx.nowMicros` **绝对推导**采样序号，而不是累加 `ctx.delta`。
   *
   * 这样做的收益：即使时钟因为加速跳空而漏掉若干 tick（本设备不会，
   * 但契约允许），采样序号也不会累计漂移 —— 它只是虚拟时刻的纯函数。
   */
  tick(ctx: TickContext): void {
    this.#tickCount += 1
    const due = this.#initialSamples + Math.floor(ctx.nowMicros / this.#periodMicros)
    if (due !== this.#samples) this.#samples = due
  }

  /**
   * ★ 永远返回 `null`：本设备**需要每一个时间片**。
   *
   * 这是刻意的 —— 它的职责就是当「时间片无丢失」的探针（T3）。
   * 若它声明可跳空，`tickCount` 就会小于片数，探针失效。
   * 积分型行为模型（如 BME280 的随机漂移）同理必须返回 null。
   */
  nextEventIn(): number | null {
    return null
  }

  /**
   * I2C 读。地址不匹配返回 `null`（交给总线上下一个设备，**不是错误**）。
   * 读数按**大端**编码进 `length` 字节 —— shim 侧按同一约定解码。
   */
  onI2CRead(request: I2CReadRequest): I2CReadResult {
    if (request.address !== this.address) return null
    if (this.#status === 'disconnected') return null
    return encodeBigEndian(this.#samples, request.length)
  }

  onI2CWrite(_request: I2CWriteRequest): void {
    // 确定性设备无寄存器，写操作被忽略（保持与真实设备的接口形状一致）
  }

  injectFault(fault: DeviceFault): void {
    switch (fault.type) {
      case 'disconnect':
        this.#status = 'disconnected'
        break
      case 'busy':
        this.#status = 'busy'
        break
      case 'nack':
        this.#status = 'faulted'
        break
      case 'clear':
        this.#status = 'ok'
        break
      case 'set_reading':
        // 确定性设备不认读数注入 —— 它的值由虚拟时间唯一决定，注入会破坏确定性
        throw new Error('DeterministicTestDevice 拒绝 set_reading：其读数必须是虚拟时间的纯函数')
      default: {
        const exhaustive: never = fault.type
        throw new Error(`未知故障类型：${String(exhaustive)}`)
      }
    }
  }

  snapshot(): DeviceSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      label: `确定性设备 @0x${this.address.toString(16).padStart(2, '0')}`,
      status: this.#status,
      readings: {
        samples: this.#samples,
        tickCount: this.#tickCount,
        periodMicros: this.#periodMicros,
      },
    }
  }
}

export { MICROS_PER_SECOND }
