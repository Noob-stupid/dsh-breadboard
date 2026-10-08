/**
 * 时钟验收测试 —— 对应设计文档 §0.4 P3 与 §7.4 T1–T3。
 *
 * ★ 关于设计文档的两处自相矛盾（本文件按「修正后」的语义验收，修正理由见 deterministic.ts 文件头）：
 *
 *   矛盾一：§0.4 的 `DeterministicTestDevice.tick` 每次 +1，而 §7.3 的 `advance(1.0)`
 *           在 step=1ms 下要 tick 1000 次 → 首读会是 1000 而非 1，`[1,2,3,4,5]` 永不成立。
 *           修正：按**采样周期**结转（累加虚拟时间，满 period 秒 +1 采样）。
 *
 *   矛盾二：§7.4 的 T2 写 `clock.now ≈ 4.0`，但 §7.4 的测试循环是 5 次 `read()+sleep(1)`
 *           → 循环结束时虚拟时刻是 5.0。4.0 是**第 5 次读数发生的时刻**，不是结束时刻。
 *           本文件按「第 5 次读数的时刻 == 4.0」验收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { DeterministicTestDevice } from '../src/core/devices/deterministic.ts'
import { secondsToMicros } from '../src/contracts/time.ts'
import type { DeviceSnapshot, VirtualDevice } from '../src/contracts/device.ts'
import type { TickContext } from '../src/contracts/time.ts'

const TEST_ADDR = 0x48

/** shim 侧的解码约定：大端 → 无符号整数。与 deterministic.ts 的编码成对。 */
function decodeBigEndian(bytes: Uint8Array): number {
  let value = 0
  for (const byte of bytes) value = value * 256 + byte
  return value
}

/** 周期计数器：统计「每 period 秒一次的周期性事件」发生了多少次。 */
interface PeriodCounter {
  readonly device: VirtualDevice
  crossings: number
  ticks: number
}

function makePeriodCounter(id: string, periodSeconds: number): PeriodCounter {
  const periodMicros = secondsToMicros(periodSeconds)
  const counter: PeriodCounter = {
    crossings: 0,
    ticks: 0,
    device: {
      id,
      kind: 'test',
      tick(ctx: TickContext): void {
        counter.ticks += 1
        const index = Math.floor(ctx.nowMicros / periodMicros)
        if (index > counter.crossings) counter.crossings = index
      },
      nextEventIn(): number | null {
        return null
      },
      snapshot(): DeviceSnapshot {
        return {
          id,
          kind: 'test',
          label: id,
          status: 'ok',
          readings: { crossings: counter.crossings, ticks: counter.ticks },
        }
      },
    },
  }
  return counter
}

/** 复刻 §7.4 的 test_clock.py 循环：先读、后 sleep(1)，共 5 轮。 */
async function runDocLoop(): Promise<{
  readings: number[]
  readTimes: number[]
  clock: VirtualClock
  device: DeterministicTestDevice
}> {
  const clock = new VirtualClock({ step: 0.001 })
  const device = new DeterministicTestDevice({ id: 'test-device', period: 1, address: TEST_ADDR })
  clock.register(device)

  const readings: number[] = []
  const readTimes: number[] = []

  for (let i = 0; i < 5; i += 1) {
    const bytes = device.onI2CRead({ address: TEST_ADDR, register: 0x00, length: 2 })
    assert.ok(bytes, '确定性设备必须应答')
    readings.push(decodeBigEndian(bytes))
    readTimes.push(clock.now)
    // —— 这一行等价于 Python 侧 shim 的 time.sleep(1) 经 IPC 转发的 clock_advance(1) ——
    await clock.advance(1)
  }

  return { readings, readTimes, clock, device }
}

test('P3 / T1：五次读数确定性递增，逐字等于 [1,2,3,4,5]', async () => {
  const { readings } = await runDocLoop()
  assert.deepEqual(readings, [1, 2, 3, 4, 5], `FAIL: 虚拟时钟未按序推进 ${JSON.stringify(readings)}`)
})

test('T2：第 5 次读数发生在虚拟时刻 4.0（误差 < 1 个时间片）', async () => {
  const { readTimes } = await runDocLoop()
  const fifth = readTimes[4]
  assert.ok(fifth !== undefined)
  // 误差 < 1 个时间片 = 0.001 秒
  assert.ok(Math.abs(fifth - 4) < 0.001, `第 5 次读数应在 t=4.0，实际 t=${String(fifth)}`)
})

test('T2 补：循环结束时虚拟时刻精确等于 5.0（5 次 sleep(1)）', async () => {
  const { clock } = await runDocLoop()
  assert.equal(clock.nowMicros, 5_000_000)
})

test('T3：多设备场景下慢周期设备的周期事件无丢失（§7.3 的反例场景）', async () => {
  const clock = new VirtualClock({ step: 0.001 })

  // 场景来自 §7.3 反例：BME280 采样周期 1s + 另一个设备中断周期 10ms
  const slow = makePeriodCounter('bme280-like', 1)
  const fast = makePeriodCounter('fast-sensor', 0.01)
  clock.register(slow.device)
  clock.register(fast.device)

  // 若时钟「直接跳变 1 秒」而不是按片循环：
  //   slow 只会 tick 1 次、fast 的 100 次周期事件全部丢失。
  await clock.advance(1)

  assert.equal(fast.crossings, 100, '10ms 周期设备在 1 秒内应有 100 次周期事件，一次都不能丢')
  assert.equal(slow.crossings, 1, '1s 周期设备应有 1 次')
  assert.equal(fast.ticks, 1000, '10ms 设备必须被 tick 满 1000 片')
  assert.equal(slow.ticks, 1000, '1s 设备同样每片都被 tick（积分连续性）')
})

test('P3 可复现性：两次独立运行的读数与片数完全一致', async () => {
  const a = await runDocLoop()
  const b = await runDocLoop()

  assert.deepEqual(a.readings, b.readings)
  assert.deepEqual(a.readTimes, b.readTimes)
  assert.equal(a.device.tickCount, b.device.tickCount)
  assert.equal(a.clock.stats.totalSlices, b.clock.stats.totalSlices)
  assert.equal(a.device.tickCount, 5000, '5 次 advance(1.0) 在 step=1ms 下共 5000 片')
})

test('T3 补：时间片数 == 设备被 tick 次数（无漏片）', async () => {
  const { clock, device } = await runDocLoop()
  assert.equal(device.tickCount, clock.stats.totalSlices)
})

test('故障注入：disconnect 后设备不再应答（P4 / 流程 C 的前置能力）', async () => {
  const clock = new VirtualClock({ step: 0.001 })
  const device = new DeterministicTestDevice({ id: 'test-device', address: TEST_ADDR })
  clock.register(device)

  assert.ok(device.onI2CRead({ address: TEST_ADDR, register: 0x00, length: 2 }))

  device.injectFault({ type: 'disconnect' })
  assert.equal(device.onI2CRead({ address: TEST_ADDR, register: 0x00, length: 2 }), null)
  assert.equal(device.snapshot().status, 'disconnected')

  device.injectFault({ type: 'clear' })
  assert.ok(device.onI2CRead({ address: TEST_ADDR, register: 0x00, length: 2 }))
})

test('地址不匹配返回 null（交给总线下一个设备，不是错误）', async () => {
  const device = new DeterministicTestDevice({ address: TEST_ADDR })
  assert.equal(device.onI2CRead({ address: 0x76, register: 0x00, length: 2 }), null)
})

test('确定性设备拒绝 set_reading 注入（其读数必须是虚拟时间的纯函数）', () => {
  const device = new DeterministicTestDevice()
  assert.throws(() => device.injectFault({ type: 'set_reading', readings: { samples: 99 } }))
})
