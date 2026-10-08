/**
 * NetworkedDevice —— 联网设备运行时（第二类虚拟硬件）
 * @module dsh-hardware-sandbox/core/devices/networked
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么它**不是** `VirtualDevice`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `VirtualDevice.tick` 的契约原文是「**必须纯同步、无 IO、无真随机**」。
 * 联网设备天生做 IO 且不可确定（对面是真服务器）⇒ **结构上不可能**是它。
 * 详见 `contracts/network.ts` 的长注释（含"为什么驱动源必须是墙钟"）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 全部逻辑都在 `reportOnce()` 里，循环只是薄壳
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 这是**为可测性做的结构性选择**：若把逻辑埋在定时器回调里，测试就只能
 * 「等真实时间过去」—— 慢、不稳、且失败时看不出是哪一步错的。
 * 现在测试直接调 `reportOnce()`，**不碰定时器、不碰网络**（传输是注入的）。
 * `start()` 里的循环因此可以短到一眼看完。
 */
import type {
  JsonRecord,
  JsonScalar,
  NetworkBinding,
  NetworkCallContext,
  NetworkDeviceSnapshot,
  NetworkDeviceStatus,
  NetworkProtocolAdapter,
  NetworkTransport,
} from '../../contracts/network.ts'
import { toDeviceStatus } from '../../contracts/network.ts'
import type { DeviceFault, DeviceSnapshot } from '../../contracts/device.ts'

export interface NetworkedDeviceOptions {
  readonly id: string
  readonly label: string
  readonly binding: NetworkBinding
  readonly adapter: NetworkProtocolAdapter
  readonly transport: NetworkTransport
  /** 初始物理读数（键见 `adapter.readingKeys`）。 */
  readonly reading?: JsonRecord
  /** 每多少次上报拉一次配置（智座"改配置免重烧"靠它）。默认 10。 */
  readonly configPullEveryCycles?: number
  /** 墙钟来源，可注入以便测试。 */
  readonly now?: () => number
  /** 定时器注入 —— 测试不必真的等。 */
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
  /** 状态变化通知（由注册表用来把快照发布回 SSOT）。 */
  readonly onChange?: () => void
}

export class NetworkedDevice {
  readonly id: string
  readonly #label: string
  readonly #binding: NetworkBinding
  readonly #adapter: NetworkProtocolAdapter
  readonly #transport: NetworkTransport
  readonly #configPullEvery: number
  readonly #now: () => number
  readonly #setTimer: (callback: () => void, ms: number) => unknown
  readonly #clearTimer: (handle: unknown) => void
  readonly #onChange: (() => void) | undefined

  #status: NetworkDeviceStatus = 'idle'
  #config: JsonRecord | undefined
  #reading: JsonRecord
  #reports = 0
  #failures = 0
  #lastError: string | undefined
  #lastReportAt: string | undefined
  #cycles = 0
  #running = false
  #timer: unknown
  /** 故障：`disconnect` 时**停止上报**（模拟设备掉线，用于验证对面的离线判定）。 */
  #disconnected = false

  /**
   * 同步并发守卫 —— **必须在任何 `await` 之前置位**。
   *
   * ★ 这里的风险比 I2C 那边更实：一次 HTTP 可能比上报间隔还慢，
   *   于是定时器再次触发、两个 `reportOnce` 叠在一起，**上报次数翻倍**。
   *   而"上报比预期频繁"没有任何报错 —— 属于本项目的失败族。
   *   （同 `SimEngine.run` 的教训，见 `docs/04` 第 10 例。）
   */
  #busy = false

  constructor(options: NetworkedDeviceOptions) {
    this.id = options.id
    this.#label = options.label
    this.#binding = options.binding
    this.#adapter = options.adapter
    this.#transport = options.transport
    this.#configPullEvery = Math.max(1, options.configPullEveryCycles ?? 10)
    this.#now = options.now ?? (() => Date.now())
    this.#setTimer =
      options.setTimer ?? ((callback, ms) => setTimeout(callback, ms) as unknown)
    this.#clearTimer =
      options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
    this.#onChange = options.onChange

    // 初始读数：缺的键补 `false`（= 未遮挡）。
    // ★ 用 `adapter.readingKeys` 而不是硬编码 —— 协议知识不能漏进内核。
    const initial: Record<string, JsonScalar> = {}
    for (const key of this.#adapter.readingKeys) initial[key] = false
    this.#reading = { ...initial, ...(options.reading ?? {}) }
  }

  /* ─────────────────── 观察 ─────────────────── */

  get status(): NetworkDeviceStatus {
    return this.#status
  }

  get running(): boolean {
    return this.#running
  }

  snapshot(): NetworkDeviceSnapshot {
    return {
      id: this.id,
      label: this.#label,
      protocol: this.#binding.protocol,
      endpoint: this.#binding.endpoint,
      deviceId: this.#binding.deviceId,
      status: this.#status,
      ...(this.#config !== undefined ? { config: this.#config } : {}),
      reading: this.#reading,
      reports: this.#reports,
      failures: this.#failures,
      ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
      ...(this.#lastReportAt !== undefined ? { lastReportAt: this.#lastReportAt } : {}),
      wallClockDriven: true,
    }
  }

  /**
   * 投影成通用 {@link DeviceSnapshot} —— 让它与总线设备**进同一份 SSOT**。
   *
   * ★ `transport: 'network'` 是关键：两者时刻语义不同，前端必须能区分。
   */
  toDeviceSnapshot(): DeviceSnapshot {
    return {
      id: this.id,
      kind: 'mcu',
      label: this.#label,
      status: toDeviceStatus(this.#status),
      transport: 'network',
      readings: {
        protocol: this.#binding.protocol,
        deviceId: this.#binding.deviceId,
        endpoint: this.#binding.endpoint,
        status: this.#status,
        reports: this.#reports,
        failures: this.#failures,
        // 读数摊平进来，前端气泡直接可用
        ...this.#reading,
        ...(this.#config?.['seat_id'] !== undefined ? { seat_id: this.#config['seat_id'] } : {}),
        ...(this.#lastReportAt !== undefined ? { lastReportAt: this.#lastReportAt } : {}),
        ...(this.#lastError !== undefined ? { lastError: this.#lastError } : {}),
      },
    }
  }

  /* ─────────────────── 控制 ─────────────────── */

  /** 设置物理读数（如 `{ ir_front: true, ir_back: true }` = 有人）。 */
  setReading(reading: JsonRecord): void {
    this.#reading = { ...this.#reading, ...reading }
    this.#changed()
  }

  /**
   * 开机：注册 → 进入周期上报。
   *
   * ★ 注册失败**不抛**：设备会保持 `error` 状态并继续重试 ——
   *   真机也是这样（对面没起来不该让整个沙盒崩掉）。
   *   但状态是**可见的**（`status='error'` + `lastError`），不是静默吞掉。
   */
  async start(): Promise<void> {
    if (this.#running) return
    this.#running = true
    this.#status = 'registering'
    this.#changed()
    await this.register()
    this.#schedule()
  }

  stop(): void {
    this.#running = false
    if (this.#timer !== undefined) {
      this.#clearTimer(this.#timer)
      this.#timer = undefined
    }
    this.#status = 'stopped'
    this.#changed()
  }

  /** 注册（或重新注册）。 */
  async register(): Promise<boolean> {
    const outcome = await this.#adapter.register(this.#context())
    if (!outcome.ok) {
      this.#fail(outcome.message ?? '注册失败')
      return false
    }
    if (outcome.data !== undefined) this.#config = outcome.data
    this.#status = 'online'
    this.#lastError = undefined
    this.#changed()
    return true
  }

  /** 拉一次配置。 */
  async pullConfig(): Promise<boolean> {
    const outcome = await this.#adapter.pullConfig(this.#context())
    if (!outcome.ok) {
      // ★ `needsRegister` 是**可执行信号** —— 直接重新注册，不让调用方猜文案
      if (outcome.needsRegister === true) return await this.register()
      this.#fail(outcome.message ?? '拉配置失败')
      return false
    }
    if (outcome.data !== undefined) this.#config = outcome.data
    this.#changed()
    return true
  }

  /**
   * 上报一次。**这是全部逻辑所在**（循环只是薄壳，测试直接调它）。
   *
   * @returns 是否成功
   */
  async reportOnce(): Promise<boolean> {
    // ★ 守卫在第一个 await 之前同步置位
    if (this.#busy) return false
    this.#busy = true
    try {
      if (this.#disconnected) {
        // 故障：设备掉线。**不请求**，但要如实记为失败，否则"没上报"看起来像"没启用"。
        this.#fail('设备已断开（注入的 disconnect 故障）')
        return false
      }
      if (this.#status === 'idle' || this.#status === 'stopped') {
        this.#fail(`设备未启动（status=${this.#status}）`)
        return false
      }

      const translated = this.#adapter.translate?.(this.#config, this.#reading) ?? this.#reading
      const outcome = await this.#adapter.report(this.#context(), translated)
      this.#cycles += 1

      if (!outcome.ok) {
        this.#fail(outcome.message ?? '上报失败')
        if (outcome.needsRegister === true) await this.register()
        return false
      }

      this.#reports += 1
      this.#lastReportAt = new Date(this.#now()).toISOString()
      this.#status = 'online'
      // ★ 成功后**不清 lastError**：清掉就看不出"一直在失败但偶尔成功"。
      //   它只是"最近一次错误"，语义如此。
      this.#changed()

      // 周期性拉配置（"改配置免重烧"）
      if (this.#cycles % this.#configPullEvery === 0) await this.pullConfig()
      return true
    } finally {
      this.#busy = false
    }
  }

  /** 故障注入（对应工具 `hw_inject_fault`）。 */
  injectFault(fault: DeviceFault): void {
    switch (fault.type) {
      case 'disconnect':
        this.#disconnected = true
        break
      case 'clear':
        this.#disconnected = false
        break
      default:
        // ★ 不认识的故障**明确拒绝**，不静默忽略 ——
        //   否则调用方会以为故障注进去了（`docs/04` 纪律：未实现必须抛）
        throw new Error(
          `联网设备不支持故障类型 "${fault.type}"（支持：disconnect / clear）。` +
            'nack / busy / set_reading 是总线设备的概念。',
        )
    }
    this.#changed()
  }

  /* ─────────────────── 内部 ─────────────────── */

  #context(): NetworkCallContext {
    return {
      transport: this.#transport,
      endpoint: this.#binding.endpoint,
      deviceId: this.#binding.deviceId,
      options: this.#binding.options ?? {},
      // ★ 把**当前配置**一并交给适配器：设备"该上报哪个座位"是服务端说的，
      //   不看配置就会往旧座位上报（且不报错）。见 NetworkCallContext.config。
      ...(this.#config !== undefined ? { config: this.#config } : {}),
    }
  }

  #fail(message: string): void {
    this.#failures += 1
    this.#lastError = message
    this.#status = 'error'
    this.#changed()
  }

  #changed(): void {
    this.#onChange?.()
  }

  #schedule(): void {
    if (!this.#running) return
    const interval = this.#adapter.intervalMs(this.#config)
    this.#timer = this.#setTimer(() => {
      void (async () => {
        await this.reportOnce()
        this.#schedule()
      })()
    }, interval)
  }
}
