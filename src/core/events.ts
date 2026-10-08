/**
 * 事件桥 —— 设计文档 §6.2
 * @module dsh-hardware-sandbox/core/events
 *
 * ★ 承载**铁律②**：虚拟时钟 tick 绝不逐 tick 推前端。
 *   `advance(1.0)` 在 step=1ms 下产生 1000 次 tick；若每次 tick 都推一条消息过浏览器 RPC，
 *   一次 `sleep(1)` 就是 1000 条 × N 设备 —— 链路会被打死。
 *   所以 `sim_tick` 必须**在宿主侧节流合并**：前端收到的 `advancedMicros` 是**区间累计量**，
 *   而不是逐 tick 一条。{@link SimTickThrottle} 就是这条规则的可执行形态。
 */
import type { DeviceSnapshot } from '../contracts/device.ts'
import type { HardwareEvent, SimTickEvent } from '../contracts/assembly.ts'

export type HardwareEventListener = (event: HardwareEvent) => void

/** 事件桥。单进程内的发布订阅，不做持久化。 */
export class HardwareEventBus {
  #listeners = new Set<HardwareEventListener>()

  /** 订阅。返回退订函数。 */
  on(listener: HardwareEventListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  get listenerCount(): number {
    return this.#listeners.size
  }

  /**
   * 广播一个事件。
   *
   * ★ 单个订阅者抛错**不影响**其它订阅者 —— 前端断线不能把宿主内核带崩。
   */
  emit(event: HardwareEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event)
      } catch {
        // 订阅者自己的问题，吞掉以免影响其它订阅者
      }
    }
  }
}

export interface SimTickThrottleOptions {
  /** 最小投递间隔（毫秒）。默认 100（约 10Hz，够人眼跟手，又不会淹链路）。 */
  readonly minIntervalMs?: number
  /** 墙钟来源，可注入以便测试。 */
  readonly wallNow?: () => number
}

/**
 * `sim_tick` 节流合并器。
 *
 * 用法（SimEngine 每次 `advance()` 之后调一次 `record`）：
 * ```ts
 * throttle.record(clock.nowMicros, clock.now, clock.listDevices().map(d => d.snapshot()))
 * ```
 * 宿主墙钟未到投递间隔时**只累计不投递**；到点才发一条，其 `advancedMicros`
 * 是这段时间内累计推进的虚拟时间。
 */
export class SimTickThrottle {
  readonly #bus: HardwareEventBus
  readonly #minIntervalMs: number
  readonly #wallNow: () => number

  /** 自上次投递以来累计推进的虚拟微秒。 */
  #pendingMicros = 0
  #lastEmitWallMs: number
  #lastNowMicros = 0
  #lastNow = 0
  #lastDevices: readonly DeviceSnapshot[] = []

  constructor(bus: HardwareEventBus, options: SimTickThrottleOptions = {}) {
    this.#bus = bus
    this.#minIntervalMs = options.minIntervalMs ?? 100
    this.#wallNow = options.wallNow ?? (() => Date.now())
    this.#lastEmitWallMs = this.#wallNow()
  }

  /** 累计一次推进。到达投递间隔才真正发事件。 */
  record(nowMicros: number, now: number, devices: readonly DeviceSnapshot[]): void {
    if (this.#lastNowMicros === 0) this.#lastNowMicros = nowMicros
    this.#pendingMicros += Math.max(0, nowMicros - this.#lastNowMicros)
    this.#lastNowMicros = nowMicros
    this.#lastNow = now
    this.#lastDevices = devices

    const elapsed = this.#wallNow() - this.#lastEmitWallMs
    if (elapsed >= this.#minIntervalMs) this.flush()
  }

  /** 立即投递一条（仿真结束时调用，保证末态一定送达）。 */
  flush(): void {
    const event: SimTickEvent = {
      type: 'hardware/sim_tick',
      source: 'sim',
      at: this.#lastNow,
      now: this.#lastNow,
      nowMicros: this.#lastNowMicros,
      advancedMicros: this.#pendingMicros,
      devices: this.#lastDevices,
    }
    this.#pendingMicros = 0
    this.#lastEmitWallMs = this.#wallNow()
    this.#bus.emit(event)
  }

  /** 当前待投递的累计量（微秒）。用于观测节流效果。 */
  get pendingMicros(): number {
    return this.#pendingMicros
  }
}
