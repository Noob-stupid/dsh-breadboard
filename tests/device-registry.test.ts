/**
 * DeviceRegistry 测试 —— 验证「装配状态」与「虚拟设备」是**同一份真相**（§6.1）。
 *
 * 核心断言：**在装配里放一个 BME280，虚拟时钟上就真的多一台 BME280 设备**，
 * 而且读得到、能被 tick、能被故障注入。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { DeviceRegistry } from '../src/core/sim/device-registry.ts'
import { VirtualBME280 } from '../src/core/devices/bme280.ts'
import { restingY } from '../src/contracts/library.ts'

function setup(): { clock: VirtualClock; state: AssemblyState; registry: DeviceRegistry } {
  const clock = new VirtualClock({ step: 0.001 })
  const state = new AssemblyState()
  const registry = new DeviceRegistry({ clock, state })
  return { clock, state, registry }
}

test('放置树莓派不产生设备（它没有行为模型，不是遗漏）', () => {
  const { clock, state, registry } = setup()
  const pi = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  assert.ok(pi.ok)

  assert.equal(registry.deviceCount, 0, 'rpi-4b 在默认工厂表里没有条目')
  assert.equal(clock.deviceCount, 0)
})

test('★ 放置 BME280 ⇒ 虚拟时钟上真的多一台 BME280', () => {
  const { clock, state, registry } = setup()
  state.place('rpi-4b', { x: -0.06, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  assert.equal(registry.deviceCount, 1, '装配里有一块 BME280，设备表里就该有一台')
  assert.equal(clock.deviceCount, 1, '而且必须真的注册到虚拟时钟上（否则 tick 不到它）')

  const device = registry.deviceFor(sensor.value.id)
  assert.ok(device instanceof VirtualBME280, '设备 id 应与组件 id 一一对应')
  assert.equal(device.id, sensor.value.id)
  assert.equal(device.address, 0x76, '地址取自模型库的 i2cAddress')
})

test('★ 设备快照发布回 SSOT（前端与 DS 都从这里读，不另开一份）', () => {
  const { state } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })

  const snapshot = state.snapshot()
  assert.equal(snapshot.virtualDevices.length, 1, '§6.1：虚拟设备状态必须挂在 AssemblyState 上')
  const device = snapshot.virtualDevices[0]
  assert.ok(device)
  assert.equal(device.kind, 'sensor')
  assert.equal(typeof device.readings.temperature, 'number')
})

test('移除组件 ⇒ 设备跟着注销（不留幽灵设备）', () => {
  const { clock, state, registry } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  assert.equal(clock.deviceCount, 1)

  state.remove(sensor.value.id)
  assert.equal(registry.deviceCount, 0)
  assert.equal(clock.deviceCount, 0, '组件没了，时钟上不该还挂着设备')
  assert.equal(state.snapshot().virtualDevices.length, 0)
})

test('★ 设备的物理读数随时间片推进（接上了才算真闭环）', async () => {
  const { clock, state, registry } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const device = registry.deviceFor(sensor.value.id) as VirtualBME280
  const before = device.temperature

  await clock.advance(5)

  assert.notEqual(device.temperature, before, '设备必须真的被 tick 到（否则装配与时钟是两本账）')
})

test('设备能被 I2C 读到（与 BridgeServer 串起来的前提）', () => {
  const { state, registry } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const device = registry.deviceFor(sensor.value.id)
  assert.ok(device?.onI2CRead)
  const id = device.onI2CRead({ address: 0x76, register: 0xd0, length: 1 })
  assert.deepEqual(Array.from(id ?? []), [0x60], '挂上来的必须是真 BME280（芯片 ID 0x60）')
})

test('同型号放两块 ⇒ 两台设备（地址冲突由 SSOT 的警告负责，不是这里静默吞掉）', () => {
  const { clock, state } = setup()
  const pi = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  assert.ok(pi.ok)
  const a = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.06, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  assert.equal(clock.deviceCount, 2, '两台都该挂上——真实总线上也是两台都在')

  // ★ 只放置、不连线时**不该**报地址冲突：不在同一条总线上就没有冲突可言
  assert.equal(
    state.warnings().some((warning) => warning.code === 'i2c_address_conflict'),
    false,
    '未连接到同一总线的两台设备不构成地址冲突',
  )

  // 连到同一条 I2C 总线（I2C1 是 shared，允许多从机）后才构成冲突
  state.connect({ componentId: pi.value.id, portId: 'P3' }, { componentId: a.value.id, portId: 'SDA' })
  state.connect({ componentId: pi.value.id, portId: 'P3' }, { componentId: b.value.id, portId: 'SDA' })

  assert.ok(
    state.warnings().some((warning) => warning.code === 'i2c_address_conflict'),
    '地址冲突要由 SSOT 的警告暴露出来，而不是靠少挂一台设备来掩盖',
  )
})

test('★ 变更通知不形成死循环（发布设备快照不得反过来触发 sync）', () => {
  const { state } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })

  let notifications = 0
  state.onChange(() => {
    notifications += 1
  })

  // setVirtualDevices 会递增 revision 但**不得**通知结构性订阅者
  state.setVirtualDevices([])
  assert.equal(notifications, 0, '发布设备快照若触发通知，就会与注册表形成死循环')

  // 结构性变更仍然要通知
  state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.equal(notifications, 1, '结构性变更必须通知')
})

test('单个订阅者抛错不影响其它订阅者，也不让变更失败', () => {
  const { state } = setup()
  let secondCalled = false
  state.onChange(() => {
    throw new Error('订阅者自己炸了')
  })
  state.onChange(() => {
    secondCalled = true
  })

  const result = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  assert.equal(result.ok, true, '订阅者抛错不应让状态变更失败')
  assert.equal(secondCalled, true, '另一个订阅者仍应被调用')
})

test('dispose 后不再跟随装配变化', () => {
  const { clock, state, registry } = setup()
  registry.dispose()

  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })

  assert.equal(clock.deviceCount, 0, 'dispose 后不应再注册设备')
})

test('退订后重新注册同 id 设备不报错（id 复用安全）', () => {
  const { clock, state, registry } = setup()
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  // 摘除再放回：时钟对重复 id 是直接抛错的，所以摘除必须真的先发生
  state.remove(sensor.value.id)
  const again = state.place('bme280', { x: 0.04, y: restingY('bme280'), z: 0 }, sensor.value.id)
  assert.equal(again.ok, true)
  assert.equal(registry.deviceCount, 1)
  assert.equal(clock.deviceCount, 1)
})
