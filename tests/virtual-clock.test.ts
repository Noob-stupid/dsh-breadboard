/**
 * VirtualClock 单元测试。
 *
 * ★ 跑法：`node --test tests/`（Node 24 原生类型擦除，无需编译、无需 npm install）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualClock, VirtualClockError } from '../src/core/vclock/virtual-clock.ts'
import type { DeviceSnapshot, VirtualDevice } from '../src/contracts/device.ts'
import type { TickContext } from '../src/contracts/time.ts'

/** 测试替身：把 tick 记录进共享数组。 */
function recorder(id: string, log: string[]): VirtualDevice {
  return {
    id,
    kind: 'test',
    tick(_ctx: TickContext): void {
      log.push(id)
    },
    nextEventIn(): number | null {
      return null
    },
    snapshot(): DeviceSnapshot {
      return { id, kind: 'test', label: id, status: 'ok', readings: {} }
    },
  }
}

test('整数微秒精确累加：0.001 × 1000 恰好等于 1 秒（浮点累加做不到）', async () => {
  const clock = new VirtualClock({ step: 0.001 })

  // 先证伪「浮点会漂」：这正是必须用整数微秒的理由
  let floatSum = 0
  for (let i = 0; i < 1000; i += 1) floatSum += 0.001
  assert.notEqual(floatSum, 1, '前置假设失效：浮点累加居然精确等于 1')

  for (let i = 0; i < 1000; i += 1) await clock.advance(0.001)

  assert.equal(clock.nowMicros, 1_000_000, '整数微秒必须精确等于 1 秒')
  assert.equal(clock.now, 1)
})

test('步进数量：advance(1.0) 在 step=1ms 下恰好 1000 片', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  const log: string[] = []
  clock.register(recorder('a', log))

  const result = await clock.advance(1)
  assert.equal(result.slices, 1000)
  assert.equal(log.length, 1000)
  assert.equal(result.advancedMicros, 1_000_000)
})

test('非整片时长：advance(0.0005) 走 1 片且 delta 为 500 微秒', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  const deltas: number[] = []
  clock.register({
    id: 'probe',
    kind: 'test',
    tick(ctx: TickContext): void {
      deltas.push(ctx.deltaMicros)
    },
    snapshot(): DeviceSnapshot {
      return { id: 'probe', kind: 'test', label: 'probe', status: 'ok', readings: {} }
    },
  })

  const result = await clock.advance(0.0005)
  assert.equal(result.slices, 1)
  assert.deepEqual(deltas, [500])
  assert.equal(clock.nowMicros, 500)
})

test('advance(0) 不产生任何片', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  const log: string[] = []
  clock.register(recorder('a', log))

  const result = await clock.advance(0)
  assert.equal(result.slices, 0)
  assert.equal(log.length, 0)
  assert.equal(clock.nowMicros, 0)
})

test('设备按注册顺序确定性执行', async () => {
  const clock = new VirtualClock({ step: 1 })
  const log: string[] = []
  clock.register(recorder('first', log))
  clock.register(recorder('second', log))
  clock.register(recorder('third', log))

  await clock.advance(1)
  assert.deepEqual(log, ['first', 'second', 'third'])
})

test('设备 id 重复时拒绝注册', () => {
  const clock = new VirtualClock()
  const log: string[] = []
  clock.register(recorder('dup', log))
  assert.throws(() => clock.register(recorder('dup', log)), VirtualClockError)
})

test('注销后不再被 tick；注销函数幂等', async () => {
  const clock = new VirtualClock({ step: 1 })
  const log: string[] = []
  const dispose = clock.register(recorder('a', log))

  await clock.advance(1)
  assert.equal(log.length, 1)

  dispose()
  dispose() // 幂等
  await clock.advance(1)
  assert.equal(log.length, 1, '注销后不应再收到 tick')
  assert.equal(clock.deviceCount, 0)
})

test('并发 advance 被串行化，不交错推进设备状态', async () => {
  const clock = new VirtualClock({ step: 1 })
  const seen: number[] = []
  clock.register({
    id: 's',
    kind: 'test',
    tick(ctx: TickContext): void {
      seen.push(ctx.advanceId)
    },
    snapshot(): DeviceSnapshot {
      return { id: 's', kind: 'test', label: 's', status: 'ok', readings: {} }
    },
  })

  const first = clock.advance(1)
  const second = clock.advance(1)
  await Promise.all([first, second])

  assert.deepEqual(seen, [1, 2], '两次推进必须顺序完成，不能交错')
  assert.equal(clock.now, 2)
})

test('护栏：dt 超过 maxAdvanceSeconds 抛错', async () => {
  const clock = new VirtualClock({ maxAdvanceSeconds: 1 })
  await assert.rejects(() => clock.advance(2), VirtualClockError)
})

test('护栏：非法构造参数抛错', () => {
  assert.throws(() => new VirtualClock({ step: 0 }), VirtualClockError)
  assert.throws(() => new VirtualClock({ step: -1 }), VirtualClockError)
  assert.throws(() => new VirtualClock({ yieldBudgetMs: -1 }), VirtualClockError)
  assert.throws(() => new VirtualClock({ maxAdvanceSeconds: 0 }), VirtualClockError)
})

test('失败的一次 advance 不会卡死后续调用（Promise 链存活）', async () => {
  const clock = new VirtualClock({ maxAdvanceSeconds: 1 })
  await assert.rejects(() => clock.advance(5), VirtualClockError)
  // 链条若被 rejection 污染，这里会永远 pending
  const ok = await clock.advance(1)
  assert.equal(ok.advancedMicros, 1_000_000)
})

test('skip-ahead：全部设备都声明可跳空时，tick 次数被大幅削减', async () => {
  const clock = new VirtualClock({ step: 0.001 })

  // 一台「每秒才有事」的设备：期间无需 tick，但值必须由虚拟时刻正确推导
  let tickCount = 0
  clock.register({
    id: 'sparse',
    kind: 'test',
    tick(_ctx: TickContext): void {
      tickCount += 1
    },
    nextEventIn(): number | null {
      const microsIntoPeriod = clock.nowMicros % 1_000_000
      return (1_000_000 - microsIntoPeriod) / 1_000_000
    },
    snapshot(): DeviceSnapshot {
      return { id: 'sparse', kind: 'test', label: 'sparse', status: 'ok', readings: {} }
    },
  })

  const result = await clock.advance(10)

  assert.equal(result.skippedMicros > 0, true, '应当发生跳空')
  assert.equal(clock.nowMicros, 10_000_000, '跳空后虚拟时刻仍须精确抵达目标')
  assert.ok(tickCount < 50, `跳空后 tick 次数应远小于 10000，实际 ${tickCount}`)

  // ★ 关键：跳空不能吞掉终点那一刻的 tick
  assert.ok(tickCount >= 1, '终点必须至少被 tick 一次，否则设备状态会陈旧')
})

test('skip-ahead：只要有一台设备需要每片，就绝不跳空', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  let sparseTicks = 0

  clock.register({
    id: 'sparse',
    kind: 'test',
    tick(): void {
      sparseTicks += 1
    },
    nextEventIn(): number | null {
      return 1
    },
    snapshot(): DeviceSnapshot {
      return { id: 'sparse', kind: 'test', label: 'sparse', status: 'ok', readings: {} }
    },
  })
  // 这台返回 null（例如 BME280 积分型漂移，结果与片数相关）
  clock.register(recorder('integrator', []))

  const result = await clock.advance(1)
  assert.equal(result.skippedMicros, 0, '存在每片设备时不得跳空')
  assert.equal(result.slices, 1000)
  assert.equal(sparseTicks, 1000)
})

test('yieldBudgetMs=0 表示从不让出（T6 对照实验用）', async () => {
  const clock = new VirtualClock({ step: 0.001, yieldBudgetMs: 0 })
  clock.register(recorder('a', []))
  const result = await clock.advance(1)
  assert.equal(result.yielded, 0)
})

test('无设备时直接跳到目标，不做无意义空转', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  const result = await clock.advance(100)
  assert.equal(result.slices, 0)
  assert.equal(result.skippedMicros, 100_000_000)
  assert.equal(clock.nowMicros, 100_000_000)
})
