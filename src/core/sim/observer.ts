/**
 * **真机观察器** —— 轮询只读接口，把真机状态映射到场景器件上。
 *
 * 设计要点见 `contracts/observe.ts`（尤其 **`error` ≠ `stale`** 那一条）。
 *
 * ★ 这里把 **io 与定时器都做成可注入**的：
 *   · 测试要能**确定性地**驱动"第 N 次轮询失败/成功"，而不是真等 2 秒；
 *   · 真机观察是**墙钟**行为，用真定时器测会又慢又飘。
 *   ⇒ 注入之后，"状态机"这件事才**测得动**，而状态机正是这层的全部难点。
 */

import type {
  ObserveConfig,
  ObserveStatus,
  ObservedDevice,
} from '../../contracts/observe.ts'
import { MIN_OBSERVE_INTERVAL_MS } from '../../contracts/observe.ts'

/** 观察器需要的外部能力（注入 ⇒ 可测）。 */
export interface ObserverIo {
  /** 取 JSON。失败**必须抛**（由调用方区分"查不到"与"设备离线"）。 */
  readonly fetchJson: (url: string, headers?: Readonly<Record<string, string>>) => Promise<unknown>
  /** 墙钟定时器：返回取消函数。 */
  readonly setTimer: (fn: () => void, ms: number) => () => void
  readonly now: () => number
}

/**
 * **状态判定的唯一出处**。
 *
 * ★ 抽成纯函数是刻意的：这是整个 P1 里**最容易写错、错了最难查**的一处 ——
 *   把"我们查不到"说成"设备离线"会让用户去拔插硬件，而真正的问题在地址/鉴权。
 */
export function computeStatus(input: {
  /** 本次轮询是否失败（失败 ⇒ `error`，**不看数据年龄**）。 */
  readonly pollFailed: boolean
  /** 数据本身的年龄（秒）。`undefined` = 服务端没给这个字段。 */
  readonly ageSec: number | undefined
  /** 超过它算离线（秒）。 */
  readonly staleAfterSec: number
  /** 是否曾经成功过（从没成功过且正在失败 ⇒ `error`；从没成功过且没失败过 ⇒ `idle`）。 */
  readonly everSucceeded: boolean
}): ObserveStatus {
  // ① 查不到 ⇒ error（**绝不能降级成 offline**：那是把我们的问题说成设备的问题）
  if (input.pollFailed) return 'error'
  if (!input.everSucceeded) return 'idle'
  // ② 查到了，但数据本身旧 ⇒ 真机确实离线
  if (input.ageSec !== undefined && input.ageSec > input.staleAfterSec) return 'stale'
  return 'ok'
}

/** 一次观察的当前状态（对外可读）。★ 字段**可变** —— 它是活的轮询状态，不是快照。 */
export interface ObserverEntry {
  readonly config: ObserveConfig
  device: ObservedDevice
  /** 轮询次数（成功/失败都算）—— 用于判断"到底有没有在轮询"。 */
  polls: number
  failures: number
}

/**
 * 真机观察器。
 *
 * ★ `start` 是**幂等**的：同一个器件重复 start 会先停掉旧的 ——
 *   否则会出现两个定时器同时写同一个器件（读数在两份数据间跳，看起来像"硬件不稳"）。
 */
export class RealDeviceObserver {
  readonly #io: ObserverIo
  readonly #log: (message: string) => void
  readonly #entries = new Map<string, ObserverEntry>()
  readonly #cancels = new Map<string, () => void>()

  constructor(io: ObserverIo, log: (message: string) => void = () => {}) {
    this.#io = io
    this.#log = log
  }

  /** 开始观察（幂等）。返回**被夹到下限之上**的实际间隔。 */
  start(config: ObserveConfig): number {
    const interval = Math.max(MIN_OBSERVE_INTERVAL_MS, Math.floor(config.intervalMs))
    this.stop(config.componentId)
    const entry: ObserverEntry = {
      config,
      device: {
        componentId: config.componentId,
        deviceId: config.deviceId,
        source: config.url,
        status: 'idle',
        readings: {},
      },
      polls: 0,
      failures: 0,
    }
    this.#entries.set(config.componentId, entry)
    // ★ 立刻先查一次：不查的话用户要等一个间隔才看到状态，
    //   而"刚点完没反应"会被当成"没生效"。
    const run = () => {
      void this.#poll(config.componentId)
    }
    run()
    this.#cancels.set(config.componentId, this.#io.setTimer(run, interval))
    this.#log(
      `真机观察开始：${config.componentId} ← ${config.url}（每 ${String(interval / 1000)} 秒，**墙钟**）`,
    )
    return interval
  }

  stop(componentId: string): boolean {
    const cancel = this.#cancels.get(componentId)
    if (cancel !== undefined) {
      cancel()
      this.#cancels.delete(componentId)
    }
    return this.#entries.delete(componentId)
  }

  list(): readonly ObserverEntry[] {
    return [...this.#entries.values()]
  }

  /** 轮询一次（`start` 会立刻调它；定时器也调它）。 */
  async #poll(componentId: string): Promise<void> {
    const entry = this.#entries.get(componentId)
    if (entry === undefined) return
    const { config } = entry
    entry.polls += 1
    let payload: unknown
    let pollFailed = false
    let failureReason = ''
    try {
      payload = await this.#io.fetchJson(config.url, config.headers)
    } catch (error) {
      pollFailed = true
      failureReason = String(error instanceof Error ? error.message : error)
    }

    if (pollFailed) {
      entry.failures += 1
      const previous = entry.device
      entry.device = {
        ...previous,
        // ★ 状态是 error（**不是 stale**）：我们查不到，跟设备在不在线无关
        status: computeStatus({
          pollFailed: true,
          ageSec: previous.dataAgeSec,
          staleAfterSec: config.staleAfterSec,
          everSucceeded: previous.lastSuccessAt !== undefined,
        }),
        detail: `观察失败：${failureReason}`,
      }
      return
    }

    const record = config.mapping.pick(payload, config.deviceId)
    if (record === undefined) {
      // ★ 服务端答得好好的，只是**没有这台设备** —— 既不是 error（通路是通的），
      //   也不是 ok（我们根本没看到设备）。**必须独立成 not_found**：
      //   ⚠️ 我实测踩过：归进 ok 会让界面显示「✅ 真机在线」而根本没看到它。
      const previous = entry.device
      entry.device = {
        ...previous,
        status: 'not_found',
        detail: '服务端里没有这台设备（它还没上过线，或 deviceId 不对）',
        readings: {},
        dataAgeSec: undefined,
        online: false,
      }
      return
    }

    const ageSec = config.mapping.ageSec(record)
    const readings = config.mapping.readings(record)
    entry.device = {
      componentId,
      deviceId: config.deviceId,
      source: config.url,
      status: computeStatus({
        pollFailed: false,
        ageSec,
        staleAfterSec: config.staleAfterSec,
        everSucceeded: true,
      }),
      lastSuccessAt: new Date(this.#io.now()).toISOString(),
      dataAgeSec: ageSec,
      online: ageSec === undefined ? true : ageSec <= config.staleAfterSec,
      readings,
    }
  }

  dispose(): void {
    for (const cancel of this.#cancels.values()) cancel()
    this.#cancels.clear()
    this.#entries.clear()
  }
}
