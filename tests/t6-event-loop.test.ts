/**
 * T6（本插件新增判据）：advance() 不得饿死宿主事件循环。
 *
 * ★ 为什么新增：设计文档 §7.3 的 `advance()` 是**同步忙循环**。
 *   `advance(1.0)` 在 step=1ms 下是 1000 次同步迭代，`advance(10.0)` 是 10000 次。
 *   这个循环跑在**宿主 Node 的事件循环**上 —— 期间 DSH 自身（会话、UI 通信、其他插件）
 *   全部停摆。文档 §7.4 只讨论了「精度不够」，没有识别这条。
 *
 * ★ 判据为什么盯分位数而不是 max（实测结论，见 virtual-clock.ts 的表格）：
 *   关闭让出时阻塞随总耗时线性增长（1022ms 的推进就阻塞 1022ms）。
 *   打开让出后 **p50 精确跟随预算**，但 **max 有一个 ~16ms 的环境地板**
 *   （Node 定时器/GC 抖动），任何预算都压不下去。
 *   只盯 max 会把环境抖动误读成时钟缺陷，且让判据变成偶发红灯 —— 这正是
 *   设计文档 §0.4 批评过的「用概率性行为验证确定性判据」。
 *   所以：p50/p95 是判据，max 只做宽松上界。
 *
 * ★ 本测试是**可伪证**的：同一套测量在 yieldBudgetMs=0 时必须测出 > 50ms 的阻塞。
 *   否则说明测量方法本身无效，「让出有效」就成了不可证的空话。
 *
 * 用「自校准忙等」消耗墙钟时间，因此总耗时与机器速度无关：
 * 10000 片 × 20µs = 200ms，无论 CPU 快慢。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import type { DeviceSnapshot, VirtualDevice } from '../src/contracts/device.ts'
import type { TickContext } from '../src/contracts/time.ts'

/** T6 上界（毫秒）：宽松，只用于兜住病态情况。 */
const MAX_BLOCK_MS = 50
/** T6 主判据（毫秒）：p95 阻塞必须在一帧（16.7ms）之内且留足余量。 */
const P95_BLOCK_MS = 5

/** 自校准忙等：把墙钟烧到指定时刻。 */
function burnUntil(deadlineMs: number): void {
  while (performance.now() < deadlineMs) {
    /* spin */
  }
}

/** 每片消耗约 `microsPerTick` 微秒的设备 —— 模拟「有点贵」的行为模型。 */
function busyDevice(microsPerTick: number): VirtualDevice {
  return {
    id: 'busy',
    kind: 'test',
    tick(_ctx: TickContext): void {
      if (microsPerTick > 0) burnUntil(performance.now() + microsPerTick / 1000)
    },
    nextEventIn(): number | null {
      return null
    },
    snapshot(): DeviceSnapshot {
      return { id: 'busy', kind: 'test', label: 'busy', status: 'ok', readings: {} }
    },
  }
}

/** 事件循环心跳探针：收集相邻两次心跳的间隔。 */
function startGapProbe(intervalMs = 1): { stop(): Promise<number[]> } {
  const gaps: number[] = []
  let last = performance.now()
  let stopped = false
  let handle: ReturnType<typeof setTimeout> | undefined

  const beat = (): void => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
    if (!stopped) handle = setTimeout(beat, intervalMs)
  }

  handle = setTimeout(beat, intervalMs)

  return {
    async stop(): Promise<number[]> {
      // 先让「被阻塞期间排队的心跳」落地并记录，再停链
      await new Promise<void>((resolve) => setTimeout(resolve, 30))
      stopped = true
      if (handle !== undefined) clearTimeout(handle)
      return gaps
    },
  }
}

/** 按 `p`（0–100）取分位数。 */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[index] ?? 0
}

interface BlockStats {
  readonly n: number
  readonly p50: number
  readonly p95: number
  readonly max: number
}

async function measureBlock(yieldBudgetMs: number, busyMicros: number): Promise<BlockStats> {
  const clock = new VirtualClock({ step: 0.001, yieldBudgetMs })
  clock.register(busyDevice(busyMicros))

  const probe = startGapProbe()
  await clock.advance(10) // 10000 片 × busyMicros
  const gaps = (await probe.stop()).slice().sort((a, b) => a - b)

  return {
    n: gaps.length,
    p50: percentile(gaps, 50),
    p95: percentile(gaps, 95),
    max: percentile(gaps, 100),
  }
}

test('T6：默认配置下 advance(10.0) 不饿死宿主事件循环', async (t) => {
  const stats = await measureBlock(1, 20)
  t.diagnostic(
    `让出开启（预算 1ms）：n=${stats.n} p50=${stats.p50.toFixed(2)}ms ` +
      `p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`,
  )
  assert.ok(
    stats.p95 < P95_BLOCK_MS,
    `T6 失败：p95 阻塞 ${stats.p95.toFixed(2)}ms（上限 ${P95_BLOCK_MS}ms）——` +
      `advance() 未按要求让出事件循环，DSH 宿主自身会被饿死`,
  )
  assert.ok(
    stats.max < MAX_BLOCK_MS,
    `T6 失败：最大阻塞 ${stats.max.toFixed(2)}ms（上限 ${MAX_BLOCK_MS}ms）`,
  )
})

test('T6 可伪证性：关掉让出后，同一测量必须测出 > 50ms 的阻塞', async (t) => {
  const stats = await measureBlock(0, 20)
  t.diagnostic(
    `让出关闭：n=${stats.n} p50=${stats.p50.toFixed(2)}ms ` +
      `p95=${stats.p95.toFixed(2)}ms max=${stats.max.toFixed(2)}ms`,
  )
  assert.ok(
    stats.p95 > MAX_BLOCK_MS,
    `对照实验失败：即使从不让出也只测到 p95=${stats.p95.toFixed(2)}ms。` +
      `说明探针灵敏度不足，上一条 T6 断言不具证明力——必须调高每片耗时或片数`,
  )
})

test('T6 机制验证：p50 精确跟随让出预算（预算才是在控制阻塞）', async (t) => {
  const tight = await measureBlock(1, 20)
  const loose = await measureBlock(8, 20)
  t.diagnostic(
    `预算 1ms → p50 ${tight.p50.toFixed(2)}ms；预算 8ms → p50 ${loose.p50.toFixed(2)}ms`,
  )

  assert.ok(
    tight.p50 < 2.5,
    `预算 1ms 时 p50 应为 ~1ms，实际 ${tight.p50.toFixed(2)}ms`,
  )
  assert.ok(
    loose.p50 > 5,
    `预算 8ms 时 p50 应明显更大，实际 ${loose.p50.toFixed(2)}ms`,
  )
  assert.ok(
    loose.p50 > tight.p50 * 3,
    '预算应当成比例地控制典型阻塞时长',
  )
})

test('T6 收益量化：让出把阻塞从「整段」压到「一个预算」', async (t) => {
  const blocked = await measureBlock(0, 20)
  const yielded = await measureBlock(1, 20)
  t.diagnostic(
    `阻塞 p95 ${blocked.p95.toFixed(1)}ms → ${yielded.p95.toFixed(1)}ms` +
      `（降幅 ${(blocked.p95 / yielded.p95).toFixed(0)}×）`,
  )
  assert.ok(yielded.p95 < blocked.p95 / 10, '让出应至少把分位阻塞压低一个数量级')
})

test('T5：accelerated 模式下 1 秒虚拟时间耗时 < 50ms（未被让出机制拖慢）', async (t) => {
  const clock = new VirtualClock({ step: 0.001 })
  clock.register(busyDevice(0)) // 空设备，只测时钟自身开销

  const started = performance.now()
  const result = await clock.advance(1)
  const wallMs = performance.now() - started

  t.diagnostic(`1 秒虚拟时间（1000 片）耗时 ${wallMs.toFixed(2)}ms，让出 ${result.yielded} 次`)
  assert.equal(result.slices, 1000)
  assert.ok(wallMs < 50, `T5 失败：1 秒虚拟时间耗时 ${wallMs.toFixed(1)}ms（上限 50ms）`)
})
