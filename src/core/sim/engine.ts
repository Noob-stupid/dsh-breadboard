/**
 * SimEngine —— 仿真生命周期（设计文档 §5.1 闭环 / §8 流程 B、C）
 * @module dsh-hardware-sandbox/core/sim/engine
 *
 * 把已经就位的四块接成一条闭环：
 *   `AssemblyState`（SSOT）+ `VirtualClock` + `DeviceRegistry` + `BridgeServer` + **项目进程**
 *
 * ★ **零依赖宿主 API**（§10.3）：进程能力通过注入的 {@link SimSpawner} 获得，
 *   不 import `ctx.subprocess`。⇒ 引擎可脱离 DSH 单测（用假 spawner 即可）。
 *
 * ── 两个容易做错的地方，都在这里定死 ──
 *
 * ① **`duration` 是虚拟秒，不是墙钟秒。**
 *    加速模式下 5 秒虚拟时间可能只花 100ms 真实时间（实测：含 `sleep(1)×5` 的脚本约 100ms）。
 *    所以预算**由 BridgeServer 执行**（它是唯一推进时钟的地方），墙钟只做**兜底超时**
 *    防进程挂死 —— 两者是不同性质的东西，不能混。
 *
 * ② **`sim_tick` 必须节流合并**（铁律②）。
 *    `advance(1.0)` 在 step=1ms 下产生 1000 次 tick；逐 tick 推前端会打死链路。
 *    引擎把每次推进交给 {@link SimTickThrottle} 合并，前端拿到的是**区间累计量**。
 */
import path from 'node:path'

import type { VirtualClock } from '../vclock/virtual-clock.ts'
import type { AssemblyState } from '../state/assembly-state.ts'
import { HardwareEventBus, SimTickThrottle } from '../events.ts'
import { BridgeServer } from '../bridge/server.ts'
import type { SimMode } from '../../contracts/assembly.ts'
import type { DeviceFault } from '../../contracts/device.ts'
import { IPC_ENV, IPC_VERSION } from '../../contracts/ipc.ts'

/* ─────────────────────────── 注入点 ─────────────────────────── */

/** 一个正在运行的项目进程。结构上等价于宿主 `SubprocessHandle` 的子集。 */
export interface SimProcessHandle {
  /**
   * 进程 id。**可选** —— 宿主的 `SubprocessHandle` **刻意不暴露它**
   * （服务契约原文："Target identity remains provider-private"）。
   *
   * ★ 不要为了让字段"填满"而编一个假 pid（`-1` / `0` / 自增计数）：
   *   日志里那行会**看着像诊断信息、实际是垃圾**，排查时把人带偏。
   *   这正是本项目失败族里的典型形态。拿不到就不打印。
   */
  readonly pid?: number
  /** 进程结束时解析。**只在 spawn 级失败时 reject**。 */
  readonly done: Promise<{ exitCode: number | null }>
  /** 终止（宿主实现应为**进程树级**终止）。 */
  terminate(): void
}

export interface SimSpawnRequest {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly onStdout: (text: string) => void
  readonly onStderr: (text: string) => void
}

/**
 * 进程能力注入点。宿主半用 `ctx.subprocess.spawn` 实现它。
 *
 * ★ 允许返回 Promise：宿主侧拉起进程前需要 `await subprocess.resolveExecutable()`
 *   （**执行世界的可执行文件解析**——宿主明确要求不要自己拼 PATH）。
 *   引擎本来就在 async 上下文里调用它，多一个 await 不改变任何时序约束：
 *   并发守卫 {@link SimEngine.run} 已在**第一个 await 之前**同步置位。
 */
export type SimSpawner = (request: SimSpawnRequest) => SimProcessHandle | Promise<SimProcessHandle>

/* ─────────────────────────── 选项与结果 ─────────────────────────── */

export interface SimEngineOptions {
  readonly clock: VirtualClock
  readonly state: AssemblyState
  readonly bus: HardwareEventBus
  readonly spawn: SimSpawner
  /** Python 解释器绝对路径。 */
  readonly pythonPath: string
  /** `project-shim/` 目录绝对路径（注入 shim 用）。 */
  readonly shimRoot: string
  /** 墙钟兜底超时（毫秒），防进程挂死。默认 60s。 */
  readonly maxWallMs?: number
  /** 日志缓冲上限（行）。默认 2000。 */
  readonly maxLogLines?: number
  /** 墙钟来源，可注入以便测试。 */
  readonly wallNow?: () => number
}

export interface SimRunOptions {
  /** 项目根目录。 */
  readonly projectPath: string
  /** 入口脚本（相对 projectPath）。默认 `main.py`。 */
  readonly entry?: string
  /** **虚拟**时间长度（秒）。 */
  readonly duration: number
  readonly mode: SimMode
}

export interface SimRunResult {
  readonly ok: boolean
  readonly exitCode: number | null
  /** 实际推进的虚拟秒数。 */
  readonly virtualElapsed: number
  readonly wallElapsedMs: number
  /** 项目进程的输出（含 shim 上报的日志）。 */
  readonly log: readonly string[]
  /** 结束原因：`exited` / `budget` / `timeout` / `error`。 */
  readonly reason: 'exited' | 'budget' | 'timeout' | 'error'
  /** 失败时的说明。 */
  readonly message?: string
}

/* ─────────────────────────── 引擎 ─────────────────────────── */

export class SimEngine {
  readonly #options: SimEngineOptions
  readonly #maxWallMs: number
  readonly #maxLogLines: number
  readonly #wallNow: () => number

  #log: string[] = []
  /** 同步并发守卫 —— 必须在任何 `await` 之前置位，否则守卫会被 await 时序穿透。 */
  #busy = false
  #running: { server: BridgeServer; handle: SimProcessHandle } | undefined

  constructor(options: SimEngineOptions) {
    this.#options = options
    this.#maxWallMs = options.maxWallMs ?? 60_000
    this.#maxLogLines = options.maxLogLines ?? 2000
    this.#wallNow = options.wallNow ?? (() => Date.now())
  }

  /** 是否正在跑。 */
  get running(): boolean {
    return this.#running !== undefined
  }

  /** 最近一次（或正在进行的）仿真的日志。 */
  get log(): readonly string[] {
    return this.#log
  }

  /**
   * 运行一次仿真。
   *
   * ★ **并发守卫必须在第一个 `await` 之前同步置位。**
   *   实测踩过：守卫原来写在 `server.listen()` / `spawn()` **之后**，
   *   而这两步之间隔着 await —— 第二次调用会在第一次置位之前就穿过去，
   *   守卫形同虚设。**「看起来对、因为 await 时序而不生效」属于本项目的失败族。**
   *
   * ★ 为什么必须拒绝而不是排队：两个项目进程共享同一份虚拟硬件会互相篡改状态，
   *   虚拟时钟还会被双重推进。排队更糟 —— 调用方会以为"提交了就开始了"。
   */
  async run(options: SimRunOptions): Promise<SimRunResult> {
    if (this.#busy) {
      return {
        ok: false,
        exitCode: null,
        virtualElapsed: 0,
        wallElapsedMs: 0,
        log: [],
        reason: 'error',
        message: '已有仿真在运行 —— 同一份虚拟硬件不能被两个项目进程共享',
      }
    }
    this.#busy = true
    try {
      return await this.#runInner(options)
    } finally {
      this.#busy = false
    }
  }

  async #runInner(options: SimRunOptions): Promise<SimRunResult> {
    const { clock, state, bus, spawn, pythonPath, shimRoot } = this.#options
    this.#log = []

    const wallStart = this.#wallNow()
    const virtualStart = clock.nowMicros

    // ── ① 起 BridgeServer，并把**虚拟时间预算**交给它执行 ──
    let budgetReached: () => void = () => undefined
    const budgetPromise = new Promise<void>((resolve) => {
      budgetReached = resolve
    })

    const throttle = new SimTickThrottle(bus)

    // realtime 限速：让虚拟时间不要跑在墙钟前面太多
    let lastWall = wallStart
    let lastVirtual = virtualStart

    const server = new BridgeServer({
      clock,
      onLog: (stream, text) => this.#push(`${stream === 'stderr' ? '! ' : ''}${text}`),
      virtualBudgetMicros: Math.round(options.duration * 1_000_000),
      onBudgetExhausted: () => {
        budgetReached()
      },
      onAdvance: async (result) => {
        // 铁律②：推进只写 SSOT + 节流后的 sim_tick，绝不逐 tick 推前端
        throttle.record(result.nowMicros, result.nowMicros / 1_000_000, clock.snapshotDevices())

        if (options.mode !== 'realtime') return
        // realtime：按虚拟/真实比率补等待（§7.4 T4）
        const nowWall = this.#wallNow()
        const virtualAhead = (result.nowMicros - lastVirtual) / 1000
        const wallSpent = nowWall - lastWall
        const wait = virtualAhead - wallSpent
        if (wait > 1) await new Promise<void>((resolve) => setTimeout(resolve, wait))
        lastWall = this.#wallNow()
        lastVirtual = result.nowMicros
      },
    })

    const address = await server.listen()

    bus.emit({
      type: 'hardware/sim_started',
      source: 'sim',
      at: clock.now / 1_000_000,
      projectPath: options.projectPath,
      mode: options.mode,
      duration: options.duration,
    })

    // ── ② 拉起项目进程，注入 shim ──
    const separator = path.delimiter
    let handle: SimProcessHandle
    try {
      handle = await spawn({
        argv: [pythonPath, options.entry ?? 'main.py'],
        cwd: options.projectPath,
        env: {
          // ★ 顺序不能反：shim/ 在前（提供 smbus / RPi），project-shim/ 在后（提供 sitecustomize）
          PYTHONPATH: [path.join(shimRoot, 'shim'), shimRoot].join(separator),
          PYTHONIOENCODING: 'utf-8',
          PYTHONUNBUFFERED: '1',
          ...address.env,
          [IPC_ENV.version]: String(IPC_VERSION),
        },
        onStdout: (text) => this.#push(text),
        onStderr: (text) => this.#push(`! ${text}`),
      })
    } catch (error) {
      await server.close()
      this.#push(`! 启动项目进程失败：${String(error)}`)
      return {
        ok: false,
        exitCode: null,
        virtualElapsed: 0,
        wallElapsedMs: this.#wallNow() - wallStart,
        log: this.#log,
        reason: 'error',
        message: `启动项目进程失败：${String(error)}`,
      }
    }

    this.#running = { server, handle }
    // ★ pid 拿不到就**不打印**，不编一个假值（宿主刻意不暴露进程身份）。
    this.#push(
      `[sim] 项目进程已启动${handle.pid !== undefined ? ` pid=${String(handle.pid)}` : ''} ` +
        `预算=${String(options.duration)}s 虚拟时间`,
    )

    // ── ③ 等：进程退出 / 预算耗尽 / 墙钟兜底超时 ──
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        resolve('timeout')
      }, this.#maxWallMs)
    })

    let reason: SimRunResult['reason'] = 'exited'
    let exitCode: number | null = null

    try {
      const outcome = await Promise.race([
        handle.done.then((result) => ({ kind: 'exited' as const, result })),
        budgetPromise.then(() => ({ kind: 'budget' as const })),
        timeoutPromise.then(() => ({ kind: 'timeout' as const })),
      ])

      if (outcome.kind === 'exited') {
        exitCode = outcome.result.exitCode
        reason = 'exited'
      } else if (outcome.kind === 'budget') {
        reason = 'budget'
        this.#push(`[sim] 虚拟时间预算用尽（${String(options.duration)}s），终止项目进程`)
      } else {
        reason = 'timeout'
        this.#push(`[sim] 墙钟兜底超时（${String(this.#maxWallMs)}ms），终止项目进程`)
      }
    } catch (error) {
      reason = 'error'
      this.#push(`! 等待项目进程失败：${String(error)}`)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    // ── ④ 收尾：终止进程树 → 末次 sim_tick → 关服务端 ──
    handle.terminate()
    // 保证末态一定送达（节流器可能还压着最后一次累计量）
    throttle.flush()
    await server.close()
    this.#running = undefined

    const virtualElapsed = (clock.nowMicros - virtualStart) / 1_000_000
    const wallElapsedMs = this.#wallNow() - wallStart

    bus.emit({
      type: 'hardware/sim_ended',
      source: 'sim',
      at: clock.now / 1_000_000,
      projectPath: options.projectPath,
      exitCode,
      virtualElapsed,
      wallElapsedMs,
    })

    this.#push(
      `[sim] 结束 reason=${reason} 虚拟耗时=${virtualElapsed.toFixed(3)}s 真实耗时=${String(Math.round(wallElapsedMs))}ms`,
    )

    return {
      ok: reason !== 'error',
      exitCode,
      virtualElapsed,
      wallElapsedMs,
      log: this.#log,
      reason,
    }
  }

  /**
   * 运行期间注入故障（§8 流程 C）。
   *
   * `target` 形如 `bme280:0x76` 或直接给设备/组件 id。
   */
  injectFault(target: string, fault: DeviceFault): boolean {
    const { clock } = this.#options

    // target 允许写成 "model:address" 形式，取冒号前那段做 id 匹配
    const wanted = target.split(':')[0] ?? target

    for (const device of clock.listDevices()) {
      if (device.id !== wanted && !device.id.includes(wanted)) continue
      if (device.injectFault === undefined) continue
      device.injectFault(fault)
      this.#push(`[sim] 已向 ${device.id} 注入故障 ${fault.type}`)
      return true
    }

    // 按地址匹配（DeterministicTestDevice / BME280 都有 address 字段）
    for (const device of clock.listDevices()) {
      const address = (device as { address?: number }).address
      if (address === undefined) continue
      const hex = `0x${address.toString(16)}`
      if (!target.includes(hex)) continue
      if (device.injectFault === undefined) continue
      device.injectFault(fault)
      this.#push(`[sim] 已向 ${device.id}（${hex}）注入故障 ${fault.type}`)
      return true
    }

    this.#push(`! 未找到匹配 "${target}" 的设备，故障未注入`)
    return false
  }

  /** 关停（插件卸载时调用）。 */
  async dispose(): Promise<void> {
    const running = this.#running
    if (running === undefined) return
    running.handle.terminate()
    await running.server.close()
    this.#running = undefined
  }

  #push(line: string): void {
    this.#log.push(line)
    if (this.#log.length > this.#maxLogLines) {
      this.#log.splice(0, this.#log.length - this.#maxLogLines)
    }
  }
}
