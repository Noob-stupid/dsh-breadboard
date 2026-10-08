/**
 * VirtualClock —— 虚拟时钟调度器（设计文档 §7.3）
 * @module dsh-hardware-sandbox/core/vclock
 *
 * ★ 权威侧在宿主（JS/Node 内核）。Python 侧 `time.sleep` 经 shim 转发到本类的 `advance()`。
 *
 * 本实现相对设计文档 §7.3 伪码的三处强化（均来自定位文件 §3 的实测修正）：
 *
 * ① **整数微秒权威**：`0.001` 累加 1000 次在浮点下不等于 1.0。用整数微秒后累加精确，
 *    否则「逐次确定性读数」会在某个时刻多跳一格，P3/T1 会偶发红灯。
 *
 * ② **必须周期性让出宿主事件循环**（★ 新增判据 T6）：
 *    文档伪码是同步忙循环。`advance(1.0)` 在 step=1ms 下是 1000 次同步迭代，
 *    跑在宿主 Node 的事件循环上 —— 期间 DSH 自身（会话、UI 通信、其他插件）全部停摆。
 *    大步长下会明显卡顿甚至被误判为死机。本实现按**墙钟预算**让出：
 *    只有真正花掉 `yieldBudgetMs` 才 `await`，所以「算得快就不让出」（T5 不受损）、
 *    「算得久就让出」（T6 得到保证）。
 *
 * ③ **加速模式跳空**（代替文档所说的「事件优先队列」）：
 *    设备通过 `nextEventIn()` 声明「我下一个有意义的事件在 Δ 之后」。
 *    **只要有一台设备返回 null（需要每片），就绝不跳空** —— 积分型模型（如 BME280 漂移）
 *    的结果与片数相关，跳空会改变结果。这是安全性优先的取舍。
 */
import type { Micros, TickContext } from '../../contracts/time.ts'
import { MICROS_PER_SECOND, microsToSeconds, secondsToMicros } from '../../contracts/time.ts'
import type { VirtualDevice } from '../../contracts/device.ts'

/** 参数非法或超出护栏时抛出。 */
export class VirtualClockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VirtualClockError'
  }
}

export interface VirtualClockOptions {
  /** 最小时间片（秒）。默认 0.001（1ms，同文档 §7.3）。 */
  readonly step?: number
  /**
   * 宿主墙钟让出预算（毫秒）。默认 **1**。
   * 单次 `advance` 内累计消耗超过它就让出一次事件循环。
   * 设为 `0` 表示**从不让出** —— 仅供对照实验（T6 用它证明让出确实有效）。
   *
   * ★ 为什么默认是 1 而不是 4（实测：每片 20µs、`advance(10.0)`、10000 片）：
   *
   *   | 预算 | p50   | p95   | p99   | max   | 总耗时 |
   *   |-----:|------:|------:|------:|------:|-------:|
   *   |  0ms | 16.2  | 207.7 | 207.7 | 207.7 |  212ms |
   *   |  1ms |  1.04 |  1.19 |  2.20 |  16.0 |  220ms |
   *   |  2ms |  2.04 |  2.24 | 14.85 |  15.1 |  217ms |
   *   |  4ms |  4.06 |  9.18 | 15.07 |  15.1 |  217ms |
   *   |  8ms |  8.08 | 16.16 | 16.17 |  16.2 |  213ms |
   *
   *   两条结论：
   *   ① **p50 精确跟随预算** —— 让出机制按设计工作，预算就是典型阻塞时长。
   *   ② **max 有一个 ~16ms 的环境地板**，与预算无关（Node 定时器/GC 抖动），
   *      不是本时钟引入的系统性阻塞。⇒ 判据必须盯分位数，只盯 max 会把环境抖动
   *      误读成时钟缺陷。
   *
   *   4ms 预算的 p95 已达 9.18ms、p99 达 15ms，几乎吃掉一个 60fps 帧；
   *   1ms 预算的 p95 只有 1.19ms，代价仅 ~3% 总耗时（220ms vs 213ms）。
   *   对「realtime 模式要让人看得顺」的目标，1ms 明显更优。
   */
  readonly yieldBudgetMs?: number
  /** 单次 advance 的虚拟时长上限（秒）。默认 3600，防跑飞。 */
  readonly maxAdvanceSeconds?: number
  /** 让出事件循环的方式。默认 `setImmediate`；可注入以便测试。 */
  readonly yielder?: () => Promise<void>
  /** 墙钟来源。默认 `performance.now()`；可注入以便测试。 */
  readonly wallNow?: () => number
}

/** 单次推进的观测结果。 */
export interface AdvanceResult {
  readonly now: number
  readonly nowMicros: Micros
  /** 本次实际推进的虚拟时间（微秒）。 */
  readonly advancedMicros: Micros
  /** 实际执行的 tick 片数。 */
  readonly slices: number
  /** 本次让出事件循环的次数（T6 观测点）。 */
  readonly yielded: number
  /** 本次的宿主墙钟耗时（毫秒）。 */
  readonly wallMs: number
  /** 因跳空而**未**执行 tick 的虚拟时长（微秒）。 */
  readonly skippedMicros: Micros
}

/** 时钟累计统计。 */
export interface ClockStats {
  readonly advanceCalls: number
  readonly totalSlices: number
  readonly totalYielded: number
  readonly lastAdvanceWallMs: number
  readonly maxAdvanceWallMs: number
}

const DEFAULT_STEP_SECONDS = 0.001
/** 默认让出预算 1ms。取值依据见 {@link VirtualClock.yieldBudgetMs} 的实测表格。 */
const DEFAULT_YIELD_BUDGET_MS = 1
const DEFAULT_MAX_ADVANCE_SECONDS = 3600

/** 默认让出方式：`setImmediate` 是最便宜的一次宏任务让出。 */
function defaultYielder(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve))
}

function defaultWallNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance
  return typeof perf?.now === 'function' ? perf.now() : Date.now()
}

export class VirtualClock {
  /** 虚拟时刻，整数微秒 —— 权威值。 */
  #nowMicros: Micros = 0
  #advanceId = 0
  #devices: VirtualDevice[] = []
  #byId = new Map<string, VirtualDevice>()
  /** 串行化并发 advance，避免两个推进交错破坏设备状态。 */
  #tail: Promise<void> = Promise.resolve()

  #advanceCalls = 0
  #totalSlices = 0
  #totalYielded = 0
  #lastAdvanceWallMs = 0
  #maxAdvanceWallMs = 0

  readonly stepMicros: Micros
  readonly yieldBudgetMs: number
  readonly maxMicrosPerAdvance: Micros
  readonly #yielder: () => Promise<void>
  readonly #wallNow: () => number

  constructor(options: VirtualClockOptions = {}) {
    const step = options.step ?? DEFAULT_STEP_SECONDS
    if (!Number.isFinite(step) || step <= 0) {
      throw new VirtualClockError(`step 必须是正的有限秒数，收到 ${String(step)}`)
    }
    const stepMicros = secondsToMicros(step)
    if (stepMicros < 1) {
      throw new VirtualClockError(`step 太小：${step}s 折算不足 1 微秒`)
    }

    const budget = options.yieldBudgetMs ?? DEFAULT_YIELD_BUDGET_MS
    if (!Number.isFinite(budget) || budget < 0) {
      throw new VirtualClockError(`yieldBudgetMs 必须是非负数，收到 ${String(budget)}`)
    }

    const maxSeconds = options.maxAdvanceSeconds ?? DEFAULT_MAX_ADVANCE_SECONDS
    if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
      throw new VirtualClockError(`maxAdvanceSeconds 必须是正的有限秒数，收到 ${String(maxSeconds)}`)
    }

    this.stepMicros = stepMicros
    this.yieldBudgetMs = budget
    this.maxMicrosPerAdvance = secondsToMicros(maxSeconds)
    this.#yielder = options.yielder ?? defaultYielder
    this.#wallNow = options.wallNow ?? defaultWallNow
  }

  /** 当前虚拟时刻（整数微秒）—— 权威值。 */
  get nowMicros(): Micros {
    return this.#nowMicros
  }

  /** 当前虚拟时刻（秒）—— 展示用视图。 */
  get now(): number {
    return microsToSeconds(this.#nowMicros)
  }

  get deviceCount(): number {
    return this.#devices.length
  }

  get stats(): ClockStats {
    return {
      advanceCalls: this.#advanceCalls,
      totalSlices: this.#totalSlices,
      totalYielded: this.#totalYielded,
      lastAdvanceWallMs: this.#lastAdvanceWallMs,
      maxAdvanceWallMs: this.#maxAdvanceWallMs,
    }
  }

  /**
   * 注册设备。返回注销函数。
   * ★ 执行顺序 = 注册顺序（§7.3「同一时间片内按设备注册顺序确定性执行」）。
   */
  register(device: VirtualDevice): () => void {
    if (this.#byId.has(device.id)) {
      throw new VirtualClockError(`设备 id 重复：${device.id}`)
    }
    this.#byId.set(device.id, device)
    this.#devices.push(device)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      this.unregister(device.id)
    }
  }

  /** 注销设备。 */
  unregister(id: string): boolean {
    const device = this.#byId.get(id)
    if (!device) return false
    this.#byId.delete(id)
    const index = this.#devices.indexOf(device)
    if (index >= 0) this.#devices.splice(index, 1)
    return true
  }

  get(id: string): VirtualDevice | undefined {
    return this.#byId.get(id)
  }

  /** 按注册顺序返回设备（只读）。 */
  listDevices(): readonly VirtualDevice[] {
    return this.#devices
  }

  /** 全部设备快照，按注册顺序。 */
  snapshotDevices(): ReturnType<VirtualDevice['snapshot']>[] {
    return this.#devices.map((device) => device.snapshot())
  }

  /** 归零虚拟时刻（不注销设备）。 */
  reset(): void {
    this.#nowMicros = 0
    this.#advanceId = 0
  }

  /**
   * 推进虚拟时间 `dt` 秒。
   *
   * 并发调用会被**串行化**（内部 Promise 链），不会交错推进设备状态。
   *
   * @param dt - 推进的虚拟时长（秒），必须 >= 0
   */
  advance(dt: number): Promise<AdvanceResult> {
    const run = this.#tail.then(() => this.#doAdvance(dt))
    // 保持链条存活：某次 advance 抛错不能卡死后续调用
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #doAdvance(dt: number): Promise<AdvanceResult> {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new VirtualClockError(`advance 的 dt 必须是非负有限秒数，收到 ${String(dt)}`)
    }

    const startMicros = this.#nowMicros
    const targetMicros = startMicros + secondsToMicros(dt)

    if (targetMicros - startMicros > this.maxMicrosPerAdvance) {
      throw new VirtualClockError(
        `单次 advance 超过护栏：${dt}s > ${microsToSeconds(this.maxMicrosPerAdvance)}s`,
      )
    }

    this.#advanceId += 1
    const advanceId = this.#advanceId
    const wallStart = this.#wallNow()
    let windowStart = wallStart
    let slices = 0
    let yielded = 0
    let skippedMicros = 0

    // 无设备：语义上无需任何 tick，直接跳到目标（省掉无意义的 1000 次空转）
    if (this.#devices.length === 0) {
      skippedMicros = targetMicros - this.#nowMicros
      this.#nowMicros = targetMicros
    } else {
      while (this.#nowMicros < targetMicros) {
        // ── 跳空（仅当所有设备都声明了下一个事件点）──
        const skip = this.#computeSkipMicros(targetMicros)
        if (skip > 0) {
          this.#nowMicros += skip
          skippedMicros += skip
          if (this.#nowMicros >= targetMicros) break
        }

        // ── 走一个时间片 ──
        const remaining = targetMicros - this.#nowMicros
        const deltaMicros = remaining < this.stepMicros ? remaining : this.stepMicros
        this.#nowMicros += deltaMicros

        const ctx: TickContext = {
          delta: microsToSeconds(deltaMicros),
          now: microsToSeconds(this.#nowMicros),
          deltaMicros,
          nowMicros: this.#nowMicros,
          slice: slices,
          advanceId,
        }

        for (const device of this.#devices) device.tick(ctx)
        slices += 1

        // ── 让出事件循环（T6）──
        if (this.yieldBudgetMs > 0 && this.#wallNow() - windowStart >= this.yieldBudgetMs) {
          await this.#yielder()
          yielded += 1
          windowStart = this.#wallNow()
        }
      }
    }

    const wallMs = this.#wallNow() - wallStart
    this.#advanceCalls += 1
    this.#totalSlices += slices
    this.#totalYielded += yielded
    this.#lastAdvanceWallMs = wallMs
    if (wallMs > this.#maxAdvanceWallMs) this.#maxAdvanceWallMs = wallMs

    return {
      now: this.now,
      nowMicros: this.#nowMicros,
      advancedMicros: this.#nowMicros - startMicros,
      slices,
      yielded,
      wallMs,
      skippedMicros,
    }
  }

  /**
   * 计算可以安全跳过的微秒数。
   *
   * 返回 0 表示**不可跳空**（有设备需要每一个时间片）。
   * 返回正值表示所有设备都同意跳到那个事件点。
   */
  #computeSkipMicros(targetMicros: Micros): Micros {
    let nearest: Micros | null = null

    for (const device of this.#devices) {
      const hint = device.nextEventIn?.()
      // undefined / null → 需要每片；安全优先，绝不跳空
      if (hint === undefined || hint === null) return 0
      if (!Number.isFinite(hint) || hint <= 0) return 0
      const hintMicros = secondsToMicros(hint)
      if (hintMicros <= 0) return 0
      nearest = nearest === null || hintMicros < nearest ? hintMicros : nearest
    }

    if (nearest === null) return 0
    const remaining = targetMicros - this.#nowMicros

    // ★ 必须给最后一个时间片留出位置。
    //   否则当 skip 恰好等于 remaining 时，循环会直接 break，设备**永远拿不到终点那一刻的 tick**，
    //   其内部状态相对 nowMicros 变陈旧 —— 仿真结束时的末次采样就会错。
    //   留一片之后，最后一次 step 必然精确落在 targetMicros 上并产生 tick。
    const cap = remaining > this.stepMicros ? remaining - this.stepMicros : 0
    return nearest < cap ? nearest : cap
  }
}

/** 便于外部换算，避免各处重复 import。 */
export { MICROS_PER_SECOND, microsToSeconds, secondsToMicros }
