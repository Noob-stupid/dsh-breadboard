/**
 * 真机观察器的状态机 —— **`error` 与 `stale` 必须分开**。
 *
 * ★ 这是 P1 里最要紧的一组断言。混起来的后果很具体：
 *   我们查不到服务端（地址写错 / 没登录 / 服务没起）会显示成"**设备离线**"，
 *   于是人去拔插硬件、重启板子，而真正的问题在我们这边。
 *   ⇒ 这属于本项目失败族里"**结论看起来合理、实际完全错误**"那一类。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import { MIN_OBSERVE_INTERVAL_MS, type ObserveConfig } from '../src/contracts/observe.ts'
import { RealDeviceObserver, computeStatus, type ObserverIo } from '../src/core/sim/observer.ts'
import { ZHIZUO_OBSERVE_MAPPING, zhizuoObserveConfig } from '../src/core/sim/zhizuo-observe.ts'

/** 可控的假 io：轮询次数、时间、定时器全由测试驱动。 */
function makeIo(responses: (() => Promise<unknown>)[]) {
  let index = 0
  let clock = 1_700_000_000_000
  const timers: (() => void)[] = []
  const io: ObserverIo = {
    fetchJson: async () => {
      const next = responses[Math.min(index, responses.length - 1)]
      index += 1
      if (next === undefined) throw new Error('no response scripted')
      return await next()
    },
    setTimer: (fn) => {
      timers.push(fn)
      return () => {
        const at = timers.indexOf(fn)
        if (at >= 0) timers.splice(at, 1)
      }
    },
    now: () => clock,
  }
  return {
    io,
    tick: () => {
      clock += 5000
      for (const fn of [...timers]) fn()
    },
    get polls() {
      return index
    },
  }
}

const config = (over: Partial<ObserveConfig> = {}): ObserveConfig => ({
  componentId: 'c1',
  deviceId: 'AA:BB:CC:11:22:33',
  url: 'http://127.0.0.1:5800/api/admin/sensor/devices',
  intervalMs: 5000,
  staleAfterSec: 180,
  mapping: ZHIZUO_OBSERVE_MAPPING,
  ...over,
})

/* ───────────────── 纯函数：状态判定 ───────────────── */

test('★ 查不到 ⇒ error（**不是** stale/offline）', () => {
  const status = computeStatus({
    pollFailed: true,
    ageSec: 5, // 就算上次的数据很新
    staleAfterSec: 180,
    everSucceeded: true,
  })
  assert.equal(status, 'error')
})

test('★ 查到了但数据很旧 ⇒ stale（这才是"真机离线"）', () => {
  const status = computeStatus({ pollFailed: false, ageSec: 600, staleAfterSec: 180, everSucceeded: true })
  assert.equal(status, 'stale')
})

test('查到了且数据新 ⇒ ok', () => {
  assert.equal(computeStatus({ pollFailed: false, ageSec: 3, staleAfterSec: 180, everSucceeded: true }), 'ok')
})

test('还没成功过也没失败 ⇒ idle', () => {
  assert.equal(computeStatus({ pollFailed: false, ageSec: undefined, staleAfterSec: 180, everSucceeded: false }), 'idle')
})

/* ───────────────── 观察器：轮询与状态迁移 ───────────────── */

test('start 会立刻查一次（不让用户等一个间隔才看到状态）', async () => {
  const harness = makeIo([async () => ({ devices: [{ device_id: 'AA:BB:CC:11:22:33', last_seen_age_sec: 3 }] })])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    const entry = observer.list()[0]
    assert.equal(entry?.polls, 1)
    assert.equal(entry?.device.status, 'ok')
  } finally {
    observer.dispose()
  }
})

test('★★ 轮询失败后：状态是 error，且**保留上次成功的时间与读数**（便于判断多久没看到）', async () => {
  let fail = false
  const harness = makeIo([
    async () => ({ devices: [{ device_id: 'AA:BB:CC:11:22:33', last_seen_age_sec: 3, ir_front: true }] }),
    async () => {
      if (fail) throw new Error('ECONNREFUSED')
      return { devices: [{ device_id: 'AA:BB:CC:11:22:33', last_seen_age_sec: 4 }] }
    },
  ])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    const first = observer.list()[0]?.device
    assert.equal(first?.status, 'ok')
    assert.equal(first?.readings.ir_front, true)

    fail = true
    harness.tick()
    await new Promise((resolve) => setImmediate(resolve))
    const after = observer.list()[0]?.device
    assert.equal(after?.status, 'error', '查不到必须是 error')
    assert.match(after?.detail ?? '', /观察失败/)
    // ★ 上次成功的时间**必须留着**：否则用户没法知道"多久没看到真机了"
    assert.equal(after?.lastSuccessAt, first?.lastSuccessAt)
  } finally {
    observer.dispose()
  }
})

test('★ 服务端答得好好的但没有这台设备 ⇒ not_found（**既不是 error 也不是 ok**）', async () => {
  const harness = makeIo([async () => ({ devices: [{ device_id: 'OTHER:MAC', last_seen_age_sec: 1 }] })])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    const device = observer.list()[0]?.device
    // ★★ 实测踩过：这条曾经归进 `ok`，界面显示「✅ 真机在线」而**根本没看到设备**。
    assert.equal(device?.status, 'not_found')
    assert.match(device?.detail ?? '', /没有这台设备/)
    assert.equal(device?.online, false)
  } finally {
    observer.dispose()
  }
})

test('真机离线（数据旧）⇒ stale，且 online=false', async () => {
  const harness = makeIo([async () => ({ devices: [{ device_id: 'AA:BB:CC:11:22:33', last_seen_age_sec: 900 }] })])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    const device = observer.list()[0]?.device
    assert.equal(device?.status, 'stale')
    assert.equal(device?.online, false)
  } finally {
    observer.dispose()
  }
})

test('★ 轮询间隔被夹到下限之上（保护对方服务器）', () => {
  const harness = makeIo([async () => ({})])
  const observer = new RealDeviceObserver(harness.io)
  try {
    const actual = observer.start(config({ intervalMs: 10 }))
    assert.equal(actual, MIN_OBSERVE_INTERVAL_MS)
  } finally {
    observer.dispose()
  }
})

test('★ start 幂等：重复 start 不会留下两个定时器（否则读数在两份数据间跳）', async () => {
  const harness = makeIo([async () => ({ devices: [] })])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(observer.list().length, 1)
    // 一次 tick 只应触发一次轮询（两个定时器会触发两次）
    const before = observer.list()[0]?.polls ?? 0
    harness.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((observer.list()[0]?.polls ?? 0) - before, 1)
  } finally {
    observer.dispose()
  }
})

test('stop 之后不再轮询，且从列表里消失', async () => {
  const harness = makeIo([async () => ({ devices: [] })])
  const observer = new RealDeviceObserver(harness.io)
  try {
    observer.start(config())
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(observer.stop('c1'), true)
    const polls = harness.polls
    harness.tick()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(harness.polls, polls, 'stop 之后不该再轮询')
    assert.equal(observer.list().length, 0)
  } finally {
    observer.dispose()
  }
})

/* ───────────────── 智座映射 ───────────────── */

test('智座映射：从 admin 设备表里按 device_id 找到设备并读年龄', () => {
  const payload = { devices: [{ device_id: 'X', last_seen_age_sec: 12 }, { device_id: 'Y', last_seen_age_sec: 3 }] }
  const record = ZHIZUO_OBSERVE_MAPPING.pick(payload, 'Y')
  assert.ok(record !== undefined)
  assert.equal(ZHIZUO_OBSERVE_MAPPING.ageSec(record), 3)
})

test('智座映射：读数存在**座位**上，给什么读什么（读不到就是空，不编）', () => {
  assert.deepEqual(ZHIZUO_OBSERVE_MAPPING.readings({ ir_front: true, ir_back: false }), {
    ir_front: true,
    ir_back: false,
  })
  assert.deepEqual(ZHIZUO_OBSERVE_MAPPING.readings({ device_id: 'X' }), {})
  // 数字形状也收（有的接口给 0/1）
  assert.deepEqual(ZHIZUO_OBSERVE_MAPPING.readings({ ir_front: 1, ir_back: 0 }), {
    ir_front: true,
    ir_back: false,
  })
})

test('★ 智座配置用的是 admin 设备表，**不是** device_config（后者会刷 last_seen、伪造在线）', () => {
  const built = zhizuoObserveConfig({
    componentId: 'c1',
    deviceId: 'AA',
    endpoint: 'http://127.0.0.1:5800/',
    intervalMs: 5000,
  })
  assert.match(built.url, /\/api\/admin\/sensor\/devices$/)
  assert.ok(!built.url.includes('device_config'), '绝不能拿 device_config 做观察')
  // 结尾斜杠被规整掉（否则拼出 `//api`）
  assert.ok(!built.url.includes('5800//'))
})
