/**
 * 联网设备（第二类虚拟硬件）的测试
 *
 * ★ 全部**不联网、不等真实时间**：
 *   · 传输是注入的假实现
 *   · 定时器是注入的假实现
 *   · 逻辑全在 `reportOnce()` 里，直接调
 *
 * ★ 本文件专门盯住几处**不报错但会做错**的地方：
 *   ① 上报不带 `device_id` ⇒ 设备"一直在上报"却显示"离线"（纯静默）
 *   ② `ir_active_high` 搞反 ⇒ "人坐下反而释放"（纯静默）
 *   ③ 放进场景就自动发请求 ⇒ **默认产生外部副作用**
 *   ④ 两个注册表都写 `virtualDevices` ⇒ 互相覆盖，"设备时有时无"
 *   ⑤ 并发守卫写在 `await` 之后 ⇒ 上报次数翻倍
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  NetworkedDevice,
  type NetworkedDeviceOptions,
} from '../src/core/devices/networked.ts'
import { zhizuoSensorAdapter, ZHIZUO_PROTOCOL_ID } from '../src/core/devices/protocols/zhizuo.ts'
import { NetworkRegistry } from '../src/core/sim/network-registry.ts'
import { DeviceRegistry } from '../src/core/sim/device-registry.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { restingY } from '../src/contracts/library.ts'
import type {
  JsonRecord,
  NetworkRequest,
  NetworkResponse,
  NetworkTransport,
} from '../src/contracts/network.ts'

/* ─────────────────── 假传输 ─────────────────── */

interface RecordedCall {
  readonly method: string
  readonly url: string
  readonly body?: JsonRecord
}

interface FakeTransport {
  readonly transport: NetworkTransport
  readonly calls: RecordedCall[]
  /** 下一次响应（按调用顺序弹出；用尽后重复最后一个）。 */
  respond(...responses: NetworkResponse[]): void
}

function makeTransport(): FakeTransport {
  const calls: RecordedCall[] = []
  let queue: NetworkResponse[] = [{ status: 200, body: { code: 200, message: 'ok', data: {} } }]
  let index = 0

  const transport: NetworkTransport = (request: NetworkRequest) => {
    calls.push({
      method: request.method,
      url: request.url,
      ...(request.body !== undefined ? { body: request.body } : {}),
    })
    const response = queue[Math.min(index, queue.length - 1)] ?? { status: 200, body: {} }
    index += 1
    return Promise.resolve(response)
  }

  return {
    transport,
    calls,
    respond: (...responses) => {
      queue = responses
      index = 0
    },
  }
}

/** 造一个智座风格的成功响应。 */
function zhizuoOk(data: Record<string, unknown>): NetworkResponse {
  return { status: 200, body: { code: 200, message: 'success', data } }
}

const ZHIZUO_CONFIG: Record<string, unknown> = {
  device_id: 'AA:BB:CC:11:22:33',
  registered: true,
  ir_active_high: true,
  sensor_type: 'pir',
  distance_threshold_cm: 50,
  report_interval_ms: 1000,
  seat_id: 6,
  seat_label: 'A-4',
  floor_id: 3,
}

function makeDevice(
  fake: FakeTransport,
  overrides: Partial<NetworkedDeviceOptions> = {},
): NetworkedDevice {
  return new NetworkedDevice({
    id: 'esp1',
    label: 'ESP32 #1',
    binding: {
      protocol: ZHIZUO_PROTOCOL_ID,
      endpoint: 'http://127.0.0.1:5800',
      deviceId: 'AA:BB:CC:11:22:33',
    },
    adapter: zhizuoSensorAdapter,
    transport: fake.transport,
    ...overrides,
  })
}

/* ═══════════════ ① 智座适配器 ═══════════════ */

test('适配器：register 从 {code,message,data} 信封里取出 config', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: true, is_new: false, config: ZHIZUO_CONFIG }))

  const outcome = await zhizuoSensorAdapter.register({
    transport: fake.transport,
    endpoint: 'http://x',
    deviceId: 'AA:BB:CC:11:22:33',
    options: {},
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.data?.['seat_id'], 6)
  assert.equal(outcome.data?.['ir_active_high'], true)
  assert.equal(fake.calls[0]?.url, 'http://x/api/sensor/device/register')
  assert.deepEqual(fake.calls[0]?.body, { device_id: 'AA:BB:CC:11:22:33' })
})

test('★ 适配器：HTTP 4xx 与信封 code 都要判 —— 只看一层会把错误当成功', async () => {
  const fake = makeTransport()
  // HTTP 200 但信封说 code=400（代理/网关/重构都可能造成这种不一致）
  fake.respond({ status: 200, body: { code: 400, message: '缺少 device_id', data: null } })

  const outcome = await zhizuoSensorAdapter.register({
    transport: fake.transport,
    endpoint: 'http://x',
    deviceId: '',
    options: {},
  })
  assert.equal(outcome.ok, false, '信封 code=400 必须判失败')
  assert.match(outcome.message ?? '', /缺少 device_id/)
})

test('适配器：HTTP 4xx 时把 body 里的说明带出来', async () => {
  const fake = makeTransport()
  fake.respond({ status: 400, body: { code: 400, message: '该座位红外传感器已停用', data: null } })

  const outcome = await zhizuoSensorAdapter.report(
    { transport: fake.transport, endpoint: 'http://x', deviceId: 'AA', options: { seat_id: 6 } },
    { ir_front: 1, ir_back: 1 },
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.message ?? '', /红外传感器已停用/)
})

test('★ 适配器：pullConfig 的 registered:false 变成可执行的 needsRegister 信号', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: false, device_id: 'AA', config: null }))

  const outcome = await zhizuoSensorAdapter.pullConfig({
    transport: fake.transport,
    endpoint: 'http://x',
    deviceId: 'AA',
    options: {},
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.needsRegister, true, '必须是可执行信号，而不是让人去正则匹配文案')
})

test('★★ 适配器：上报**必须**带 device_id（否则在线心跳不刷新，纯静默失败）', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ seat_id: 6, status: 'occupied', consecutive_empty: 0 }))

  await zhizuoSensorAdapter.report(
    {
      transport: fake.transport,
      endpoint: 'http://x',
      deviceId: 'AA:BB:CC:11:22:33',
      options: { seat_id: 6 },
    },
    { ir_front: 1, ir_back: 1 },
  )

  const body = fake.calls[0]?.body
  assert.equal(
    body?.['device_id'],
    'AA:BB:CC:11:22:33',
    'app.py:2174 靠 data["device_id"] 刷新 last_seen；不带它，面板会显示"离线"',
  )
  assert.equal(body?.['seat_id'], 6)
})

test('适配器：没有绑定座位时明确拒绝（真机此时也不知道自己在哪）', async () => {
  const fake = makeTransport()
  const outcome = await zhizuoSensorAdapter.report(
    { transport: fake.transport, endpoint: 'http://x', deviceId: 'AA', options: {} },
    { ir_front: 1, ir_back: 1 },
  )
  assert.equal(outcome.ok, false)
  assert.match(outcome.message ?? '', /绑定座位/)
  assert.equal(fake.calls.length, 0, '不该发出请求')
})

test('适配器：intervalMs 取配置、有下限保护', () => {
  assert.equal(zhizuoSensorAdapter.intervalMs({ report_interval_ms: 1000 }), 1000)
  assert.equal(zhizuoSensorAdapter.intervalMs(undefined), 5000, '配置缺失给默认值')
  assert.equal(zhizuoSensorAdapter.intervalMs({ report_interval_ms: 0 }), 5000, '非法值走默认')
  assert.equal(zhizuoSensorAdapter.intervalMs({ report_interval_ms: 1 }), 50, '下限防打爆对面')
})

test('★★ 适配器：ir_active_high 两种极性都要翻译对（搞反 = 坐下反而释放）', () => {
  const blocked = { ir_front: true, ir_back: true }
  const clear = { ir_front: false, ir_back: false }

  assert.deepEqual(zhizuoSensorAdapter.translate({ ir_active_high: true }, blocked), {
    ir_front: 1,
    ir_back: 1,
  })
  assert.deepEqual(zhizuoSensorAdapter.translate({ ir_active_high: true }, clear), {
    ir_front: 0,
    ir_back: 0,
  })
  assert.deepEqual(zhizuoSensorAdapter.translate({ ir_active_high: false }, blocked), {
    ir_front: 0,
    ir_back: 0,
  })
  assert.deepEqual(zhizuoSensorAdapter.translate({ ir_active_high: false }, clear), {
    ir_front: 1,
    ir_back: 1,
  })
})

test('适配器：极性只翻布尔，不翻物理量（如超声波距离）', () => {
  const translated = zhizuoSensorAdapter.translate({ ir_active_high: false }, {
    ir_front: true,
    distance_cm: 42,
  })
  assert.equal(translated['ir_front'], 0, '布尔 = 物理遮挡，要翻')
  assert.equal(translated['distance_cm'], 42, '数字是物理量，翻它就错了')
})

/* ═══════════════ ② NetworkedDevice ═══════════════ */

test('设备：start 先注册再进入 online', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: true, is_new: true, config: ZHIZUO_CONFIG }))

  const device = makeDevice(fake)
  await device.start()
  device.stop()

  assert.equal(fake.calls[0]?.url, 'http://127.0.0.1:5800/api/sensor/device/register')
  assert.equal(device.snapshot().config?.['seat_id'], 6)
})

test('★ 设备：注册失败**不抛**，但要如实进入 error 且留下原因', async () => {
  const fake = makeTransport()
  fake.respond({ status: 500, body: { code: 500, message: '服务器炸了', data: null } })

  const device = makeDevice(fake)
  await device.start()

  // ★ 必须在 stop() **之前**读 —— stop() 会把 status 置成 'stopped'，
  //   之后再断言 'error' 就会失败（这是测试自己踩的坑，不是代码的问题）。
  const snap = device.snapshot()
  assert.equal(snap.status, 'error', '状态必须可见，不能静默吞掉')
  assert.match(snap.lastError ?? '', /服务器炸了/)
  assert.equal(snap.failures, 1)

  device.stop()
  assert.equal(device.snapshot().status, 'stopped', 'stop 之后才该是 stopped')
})

test('★ 设备：上报用的是**翻译后**的读数（不是原始布尔）', async () => {
  const fake = makeTransport()
  fake.respond(
    zhizuoOk({ registered: true, is_new: false, config: ZHIZUO_CONFIG }),
    zhizuoOk({ seat_id: 6, status: 'occupied', consecutive_empty: 0 }),
  )

  const device = makeDevice(fake)
  await device.start()
  device.setReading({ ir_front: true, ir_back: true })
  const ok = await device.reportOnce()
  device.stop()

  assert.equal(ok, true)
  const reportBody = fake.calls[1]?.body
  assert.equal(reportBody?.['ir_front'], 1, 'ir_active_high=true ⇒ 遮挡发 1')
  assert.equal(reportBody?.['ir_back'], 1)
})

test('★★ 设备：并发守卫必须在第一个 await 之前置位（否则上报次数翻倍）', async () => {
  const fake = makeTransport()
  fake.respond(
    zhizuoOk({ registered: true, is_new: false, config: ZHIZUO_CONFIG }),
    zhizuoOk({ seat_id: 6, status: 'occupied', consecutive_empty: 0 }),
  )

  const device = makeDevice(fake)
  await device.start()
  const before = fake.calls.length

  // 同时发起三次 —— 只有一次该真正发出去
  const results = await Promise.all([device.reportOnce(), device.reportOnce(), device.reportOnce()])
  device.stop()

  const issued = fake.calls.length - before
  assert.equal(issued, 1, `只该发出 1 次请求，实际 ${String(issued)} 次`)
  assert.deepEqual(results, [true, false, false], '被守卫挡下的返回 false，不是抛错')
})

test('★ 设备：disconnect 故障后停止上报，且如实记为失败', async () => {
  const fake = makeTransport()
  fake.respond(
    zhizuoOk({ registered: true, is_new: false, config: ZHIZUO_CONFIG }),
    zhizuoOk({ seat_id: 6, status: 'free', consecutive_empty: 1 }),
  )

  const device = makeDevice(fake)
  await device.start()
  const afterStart = fake.calls.length

  device.injectFault({ type: 'disconnect' })
  const ok = await device.reportOnce()
  device.stop()

  assert.equal(ok, false)
  assert.equal(fake.calls.length, afterStart, '断开时**不该发出请求**')
  assert.match(device.snapshot().lastError ?? '', /断开/)
})

test('★ 设备：不认识的故障类型必须抛（不静默忽略）', async () => {
  const device = makeDevice(makeTransport())
  assert.throws(
    () => {
      device.injectFault({ type: 'nack' })
    },
    /不支持故障类型/,
    'nack/busy/set_reading 是总线设备的概念，联网设备必须明确拒绝',
  )
})

test('★ 设备：failures 不清零 —— 否则看不出"一直失败但偶尔成功"', async () => {
  const fake = makeTransport()
  fake.respond(
    zhizuoOk({ registered: true, is_new: false, config: ZHIZUO_CONFIG }),
    { status: 500, body: { code: 500, message: '炸', data: null } },
    zhizuoOk({ seat_id: 6, status: 'occupied', consecutive_empty: 0 }),
  )

  const device = makeDevice(fake)
  await device.start()
  await device.reportOnce() // 失败
  await device.reportOnce() // 成功

  // ★ 同样要在 stop() **之前**读 —— stop() 会把 status 置成 'stopped'
  const snap = device.snapshot()
  assert.equal(snap.reports, 1)
  assert.equal(snap.failures, 1, '成功不该把 failures 清掉')
  assert.equal(snap.status, 'online')
  assert.match(snap.lastError ?? '', /炸/, 'lastError 是"最近一次错误"，成功后保留以便回看')
  device.stop()
})

test('设备：未启动时上报被拒（不静默发请求）', async () => {
  const fake = makeTransport()
  const device = makeDevice(fake)
  const ok = await device.reportOnce()
  assert.equal(ok, false)
  assert.equal(fake.calls.length, 0)
})

test('★ 设备：快照标记 wallClockDriven，且投影带 transport=network', async () => {
  const device = makeDevice(makeTransport())
  assert.equal(device.snapshot().wallClockDriven, true)
  assert.equal(device.toDeviceSnapshot().transport, 'network')
})

/* ═══════════════ ③ NetworkRegistry ═══════════════ */

function placeNetworked(state: AssemblyState, id = 'esp1'): void {
  const placed = state.place('esp32-seat-sensor', { x: 0.1, y: restingY('esp32-seat-sensor'), z: 0.1 }, id, {
    network: {
      protocol: ZHIZUO_PROTOCOL_ID,
      endpoint: 'http://127.0.0.1:5800',
      deviceId: 'AA:BB:CC:11:22:33',
    },
  })
  assert.equal(placed.ok, true, '放置联网设备组件应当成功')
}

test('★★ 注册表：**放进场景不会自动发请求**（默认不产生外部副作用）', async () => {
  const fake = makeTransport()
  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })

  placeNetworked(state)

  assert.equal(registry.deviceCount, 1, '设备应当被创建')
  assert.equal(fake.calls.length, 0, '★ 仅仅放进来，一次请求都不该发出')
  assert.equal(registry.deviceFor('esp1')?.running, false)

  registry.dispose()
})

test('★ 注册表：显式 start 之后才开始发请求', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: true, is_new: true, config: ZHIZUO_CONFIG }))

  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })
  placeNetworked(state)

  await registry.start('esp1')
  registry.stop()
  registry.dispose()

  assert.ok(fake.calls.length >= 1, 'start 之后应当真的注册了')
  assert.match(fake.calls[0]?.url ?? '', /device\/register/)
})

test('★ 注册表：移除组件会**先停再删**（不留还在发请求的孤儿）', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: true, is_new: true, config: ZHIZUO_CONFIG }))

  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })
  placeNetworked(state)
  await registry.start('esp1')

  state.remove('esp1')
  assert.equal(registry.deviceCount, 0)
  assert.equal(state.snapshot().virtualDevices.length, 0, 'SSOT 里也不该再有它')
  registry.dispose()
})

test('★ 注册表：未知协议**可见地**记下来，不静默忽略', () => {
  const fake = makeTransport()
  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })

  state.place('esp32-seat-sensor', { x: 0, y: restingY('esp32-seat-sensor'), z: 0 }, 'espX', {
    network: { protocol: 'nonexistent-protocol', endpoint: 'http://x', deviceId: 'AA' },
  })

  assert.equal(registry.deviceCount, 0)
  assert.match(registry.problems.get('espX') ?? '', /未知协议/)
  registry.dispose()
})

test('★ 注册表：快照发布进 SSOT，带 transport=network', () => {
  const fake = makeTransport()
  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })
  placeNetworked(state)

  const devices = state.snapshot().virtualDevices
  assert.equal(devices.length, 1)
  assert.equal(devices[0]?.id, 'esp1')
  assert.equal(devices[0]?.transport, 'network')
  registry.dispose()
})

test('★★ 两个注册表**互不覆盖**（早先共用一个 setter 会互相清空）', () => {
  const fake = makeTransport()
  const state = new AssemblyState()
  const clock = new VirtualClock({ step: 0.001 })

  // ★ 先放树莓派：它既是负载（3W）也是电源（15W）。
  //   供电预算把待放置的那台**同时计入需求与供给**，所以它自己能过；
  //   而 BME280（0.004W、无供给）**必须**在有了电源之后才放得下 ——
  //   否则会以 power_exceeded 失败（这正是"没有电源就放不下电源"死锁的镜像）。
  const pi = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  assert.equal(pi.ok, true)

  const busRegistry = new DeviceRegistry({ clock, state })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.equal(sensor.ok, true, '有了电源之后 BME280 才放得下')

  // 联网设备：ESP32（无端口 ⇒ 不占供电预算，见 library.ts 的说明）
  const netRegistry = new NetworkRegistry({ state, transport: fake.transport })
  placeNetworked(state)

  // ★ 顺序很关键：两边都写过之后，**两台设备都要还在**。
  //
  // ⚠️ 树莓派（c1）**不在**列表里是**正确的**：`DEFAULT_DEVICE_FACTORIES` 只登记了
  //    `bme280` —— 板卡是"载体"不是"设备"，它出现在装配里但不产生虚拟设备
  //    （`device-registry.ts` 文件头原文："这是设计而非遗漏"）。
  //    所以这里断言的是"总线那台 + 联网那台都在"，而不是"所有组件都在"。
  const devices = state.snapshot().virtualDevices
  const ids = devices.map((d) => d.id).sort()
  assert.deepEqual(ids, ['c2', 'esp1'], `总线一台 + 联网一台，实际 ${JSON.stringify(ids)}`)

  const busDevice = devices.find((d) => d.id === 'c2')
  const netDevice = devices.find((d) => d.id === 'esp1')
  assert.equal(busDevice?.transport, undefined, '总线设备省略 transport（默认 bus）')
  assert.equal(netDevice?.transport, 'network')

  netRegistry.dispose()
  busRegistry.dispose()
})

test('注册表：dispose 会停掉所有设备并清空 SSOT', async () => {
  const fake = makeTransport()
  fake.respond(zhizuoOk({ registered: true, is_new: true, config: ZHIZUO_CONFIG }))

  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })
  placeNetworked(state)
  await registry.start()

  registry.dispose()
  assert.equal(state.snapshot().virtualDevices.length, 0)
})
