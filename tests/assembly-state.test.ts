/**
 * AssemblyState（SSOT）测试 —— 设计文档 §6.1 / §6.2 / §8 流程 A。
 *
 * 重点覆盖三件容易做错的事：
 *   ① 连线校验的**判定顺序**（协议 → 占用 → 电平 → 供电），与文档 §6.2 一致
 *   ② 端口占用**只从 connections 推导**，不落在 Port 上（否则就是第二本账）
 *   ③ I2C 是**总线**：一条线上可挂多个从机，而同总线地址冲突必须被检出
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { restingY } from '../src/contracts/library.ts'
import type { WarningCode } from '../src/contracts/assembly.ts'

/** 放一台带电源的树莓派（否则任何设备都会 power_exceeded）。 */
function withPi(): { state: AssemblyState; pi: string } {
  const state = new AssemblyState()
  const result = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  assert.ok(result.ok, '放置树莓派应成功')
  return { state, pi: result.value.id }
}

function codes(state: AssemblyState): WarningCode[] {
  return state.warnings().map((warning) => warning.code)
}

/* ─────────────────────────── 放置 / 移除 ─────────────────────────── */

test('放置组件成功并递增 revision', () => {
  const { state, pi } = withPi()
  assert.equal(state.revision, 1)
  assert.equal(state.components.length, 1)
  assert.equal(state.findComponent(pi)?.hardwareModel, 'rpi-4b')
})

test('未知型号被拒绝', () => {
  const state = new AssemblyState()
  const result = state.place('nonexistent-board', { x: 0, y: 0, z: 0 })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'unknown_hardware_model')
  assert.equal(state.revision, 0, '失败不应改动状态')
})

test('无供电源时放置设备 → power_exceeded（面包板除外，它不耗电）', () => {
  const state = new AssemblyState()
  const sensor = state.place('bme280', { x: 0, y: restingY('bme280'), z: 0 })
  assert.equal(sensor.ok, false)
  assert.equal(sensor.ok === false && sensor.reason, 'power_exceeded')

  const board = state.place('breadboard', { x: 0, y: 0, z: 0 })
  assert.equal(board.ok, true, '零功耗的无源器件不应被供电预算拦住')
})

test('移除组件会连带移除挂在它身上的线缆', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const link = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.ok(link.ok)
  assert.equal(state.connections.length, 1)

  const removed = state.remove(pi)
  assert.ok(removed.ok)
  assert.deepEqual(removed.value.removedCables, [link.value.cableId])
  assert.equal(state.connections.length, 0)
})

/* ─────────────────────────── 连线校验（§6.2） ─────────────────────────── */

test('正常 I2C 连线成功，协议取自端口', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const link = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.ok(link.ok)
  assert.equal(link.value.protocol, 'i2c')
  assert.equal(link.value.cableId, 'w1')
})

test('协议不匹配被拒绝，且不改动状态', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const before = state.connections.length

  const link = state.connect({ componentId: pi, portId: 'P19' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.equal(link.ok, false)
  assert.equal(link.ok === false && link.reason, 'protocol_mismatch')
  assert.equal(state.connections.length, before, '校验失败不得产生连接')
})

test('电平不匹配被拒绝（3.3V 与 5V 差 1.7V）', () => {
  const { state, pi } = withPi()
  const led = state.place('led-5v', { x: 0.05, y: restingY('led-5v'), z: 0 })
  assert.ok(led.ok)

  const link = state.connect({ componentId: pi, portId: 'P1' }, { componentId: led.value.id, portId: 'VCC' })
  assert.equal(link.ok, false)
  assert.equal(link.ok === false && link.reason, 'voltage_mismatch')
})

test('点对点端口（供电）被占用后拒绝第二条线', () => {
  const { state, pi } = withPi()
  const a = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.08, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  const first = state.connect({ componentId: pi, portId: 'P1' }, { componentId: a.value.id, portId: 'VCC' })
  assert.ok(first.ok)

  const second = state.connect({ componentId: pi, portId: 'P1' }, { componentId: b.value.id, portId: 'VCC' })
  assert.equal(second.ok, false)
  assert.equal(second.ok === false && second.reason, 'port_occupied')
})

test('★ I2C 是总线：同一端口可挂多个从机', () => {
  const { state, pi } = withPi()
  const a = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.08, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  const first = state.connect({ componentId: pi, portId: 'P3' }, { componentId: a.value.id, portId: 'SDA' })
  const second = state.connect({ componentId: pi, portId: 'P3' }, { componentId: b.value.id, portId: 'SDA' })
  assert.ok(first.ok, '第一个从机应能连上')
  assert.ok(second.ok, 'I2C 是总线，第二个从机也必须能连上（否则地址冲突永远测不出来）')
  assert.equal(state.connections.length, 2)
})

test('不允许把组件连到自己身上', () => {
  const { state, pi } = withPi()
  const result = state.connect({ componentId: pi, portId: 'P3' }, { componentId: pi, portId: 'P27' })
  assert.equal(result.ok, false)
  assert.equal(result.ok === false && result.reason, 'protocol_mismatch')
})

/* ─────────────────────── 占用关系只有 connections 一个出处 ─────────────────────── */

test('★ 端口占用在快照里由 connections 推导，模型库本体的端口不被污染', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const before = state.snapshot()
  const piBefore = before.components.find((component) => component.id === pi)
  assert.equal(piBefore?.ports.find((port) => port.portId === 'P3')?.occupiedBy, undefined)

  const link = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.ok(link.ok)

  const after = state.snapshot()
  const piAfter = after.components.find((component) => component.id === pi)
  assert.equal(piAfter?.ports.find((port) => port.portId === 'P3')?.occupiedBy, link.value.cableId)

  // 拔线后占用必须消失 —— 若占用被写死在 Port 上，这里就会残留
  state.disconnect(link.value.cableId)
  const afterRemoval = state.snapshot()
  const piRemoved = afterRemoval.components.find((component) => component.id === pi)
  assert.equal(piRemoved?.ports.find((port) => port.portId === 'P3')?.occupiedBy, undefined)
})

test('拔出线缆递增 revision；拔不存在的线报错', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const link = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.ok(link.ok)

  const revisionBefore = state.revision
  assert.ok(state.disconnect(link.value.cableId).ok)
  assert.ok(state.revision > revisionBefore)
  assert.equal(state.disconnect('w999').ok, false)
})

/* ─────────────────────────── 警告（§8 流程 A） ─────────────────────────── */

test('I2C 连线后产生上拉电阻提示（文档 §8 流程 A 的那句话）', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  assert.equal(codes(state).includes('i2c_pullup_missing'), false, '未连线时不应提示上拉')

  state.connect({ componentId: pi, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' })
  assert.ok(codes(state).includes('i2c_pullup_missing'))
})

test('★ 同一条 I2C 总线上两个相同地址的设备 → 地址冲突', () => {
  const { state, pi } = withPi()
  const a = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.08, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  const one = state.connect({ componentId: pi, portId: 'P3' }, { componentId: a.value.id, portId: 'SDA' })
  const two = state.connect({ componentId: pi, portId: 'P3' }, { componentId: b.value.id, portId: 'SDA' })
  assert.ok(one.ok && two.ok)

  const conflict = state.warnings().find((warning) => warning.code === 'i2c_address_conflict')
  assert.ok(conflict, `应检出地址冲突，实际警告：${codes(state).join(',')}`)
  assert.equal(conflict.severity, 'error')
  assert.ok(conflict.message.includes('0x76'), '冲突信息应点明具体地址')
})

test('分挂在两条 I2C 总线上则不算冲突', () => {
  const { state, pi } = withPi()
  const a = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.08, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  state.connect({ componentId: pi, portId: 'P3' }, { componentId: a.value.id, portId: 'SDA' })
  state.connect({ componentId: pi, portId: 'P27' }, { componentId: b.value.id, portId: 'SDA' })

  assert.equal(codes(state).includes('i2c_address_conflict'), false)
})

test('悬空端口会产生 unconnected_port 提示', () => {
  const { state } = withPi()
  const unconnected = state.warnings().filter((warning) => warning.code === 'unconnected_port')
  // ★ 逐针后**按组件聚合**：40 个引脚全悬空 ⇒ **1 条**告警，不是 40 条。
    //   逐条报的后果是把 `hw_get_assembly` 的工具输出灌满噪音、埋掉真正有信息的那条。
    assert.equal(unconnected.length, 1, '40 个引脚悬空应聚合成 1 条，不是 40 条')
    assert.equal(unconnected[0]?.refs?.length, 40, '但 refs 里必须一个不少（信号不丢）')
})

/* ─────────────────────────── 供电 ─────────────────────────── */

test('供电汇总：需求来自组件、预算来自电源', () => {
  const { state } = withPi()
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const power = state.powerSummary()
  assert.equal(power.budgetW, 15)
  assert.ok(Math.abs(power.demandW - 3.004) < 1e-9)
  assert.equal(power.exceeded, false)
})

/* ─────────────────────────── 动作 / 一致性 ─────────────────────────── */

test('applyAction 覆盖全部动作且回带快照', () => {
  const { state, pi } = withPi()

  const placed = state.applyAction({ kind: 'place_component', hardwareModel: 'bme280', position: { x: 0.05, y: 0, z: 0 } })
  assert.ok(placed.ok)
  assert.ok(placed.snapshot, '成功时应回带快照，省一次往返')
  const sensorId = placed.snapshot.components.find((component) => component.hardwareModel === 'bme280')?.id
  assert.ok(sensorId)

  const moved = state.applyAction({ kind: 'move_component', componentId: sensorId, position: { x: 0.06, y: 0, z: 0 } })
  assert.ok(moved.ok)

  const linked = state.applyAction({
    kind: 'connect',
    from: { componentId: pi, portId: 'P3' },
    to: { componentId: sensorId, portId: 'SDA' },
  })
  assert.ok(linked.ok)

  const rejected = state.applyAction({
    kind: 'connect',
    from: { componentId: pi, portId: 'P19' },
    to: { componentId: sensorId, portId: 'GND' },
  })
  assert.equal(rejected.ok, false)
  assert.ok(rejected.reason, '失败应带原因码')
  assert.ok(rejected.snapshot, '失败也应回带快照，便于前端纠正显示')

  assert.ok(state.applyAction({ kind: 'remove_component', componentId: sensorId }).ok)
})

test('revision 单调递增；未变更时快照内容稳定', () => {
  const { state, pi } = withPi()
  const snapshotA = state.snapshot()
  const snapshotB = state.snapshot()
  assert.equal(snapshotA.revision, snapshotB.revision)
  assert.deepEqual(snapshotA, snapshotB, '无变更时两次快照必须完全一致（前端据此短路 diff）')

  state.move(pi, { x: 1, y: 0, z: 0 })
  const snapshotC = state.snapshot()
  assert.ok(snapshotC.revision > snapshotB.revision)
})

test('id 生成是确定性的（同序列 → 同 id，便于回放）', () => {
  const build = (): string[] => {
    const { state, pi } = withPi()
    const second = state.place('bme280', { x: 0.05, y: 0, z: 0 })
    assert.ok(second.ok)
    const third = state.place('led-5v', { x: 0.09, y: 0, z: 0 })
    assert.ok(third.ok)
    return [pi, second.value.id, third.value.id]
  }
  assert.deepEqual(build(), build())
})

test('reset 清空内容', () => {
  const { state } = withPi()
  state.reset()
  assert.equal(state.components.length, 0)
  assert.equal(state.connections.length, 0)
})

/* ─────────────────── 钉住（右键菜单） ─────────────────── */

test('★ 钉住后 move 必须**拒绝**（拦截在 SSOT，不在 UI）', () => {
  const { state, pi } = withPi()

  assert.equal(state.setPinned(pi, true).ok, true)

  const moved = state.move(pi, { x: 1, y: 0, z: 1 })
  assert.equal(moved.ok, false, '★ 钉住的组件必须拒绝移动')
  assert.equal((moved as { reason: WarningCode }).reason, 'component_pinned')

  // ★ 位置必须**真的没变** —— 只返回失败但已经改了，是最坏的一种
  const after = state.findComponent(pi)
  assert.deepEqual(after?.position, { x: 0, y: restingY('rpi-4b'), z: 0 }, '拒绝时不得留下半改状态')
})

test('★ 走 action 路由进来也一样被拒（这才叫锁；只拦鼠标不叫锁）', () => {
  const { state, pi } = withPi()
  state.applyAction({ kind: 'set_pinned', componentId: pi, pinned: true })

  const result = state.applyAction({ kind: 'move_component', componentId: pi, position: { x: 9, y: 9, z: 9 } })
  assert.equal(result.ok, false, 'DS / 另一个客户端从同一条路进来，也必须被拦')
  assert.equal(result.reason, 'component_pinned')
})

test('解开后可以正常移动', () => {
  const { state, pi } = withPi()
  state.setPinned(pi, true)
  assert.equal(state.setPinned(pi, false).ok, true)

  const moved = state.move(pi, { x: 0.5, y: 0.1, z: 0.5 })
  assert.equal(moved.ok, true)
  assert.deepEqual(state.findComponent(pi)?.position, { x: 0.5, y: 0.1, z: 0.5 })
})

test('钉住状态进快照（前端与 DS 都看得见）', () => {
  const { state, pi } = withPi()
  state.setPinned(pi, true)
  const component = state.snapshot().components.find((c) => c.id === pi)
  assert.equal(component?.pinned, true, '★ 必须在 SSOT 里可见，否则前端只能自己存一份（第二本账）')
})

test('★ 钉住是幂等的：重复设同一个值不递增 revision（避免无意义重调和）', () => {
  const { state, pi } = withPi()
  state.setPinned(pi, true)
  const revision = state.revision
  state.setPinned(pi, true)
  assert.equal(state.revision, revision, '已是目标值时不该动 revision')
  state.setPinned(pi, false)
  assert.equal(state.revision, revision + 1, '真的变了才动')
})

test('钉住**不拦删除**（钉住是"别乱动"，不是"别删"）', () => {
  const { state, pi } = withPi()
  state.setPinned(pi, true)
  assert.equal(state.remove(pi).ok, true, '删除是显式动作，本身已是一次确认')
})

test('对不存在的组件钉住 → unknown_hardware_model（不静默成功）', () => {
  const { state } = withPi()
  const result = state.setPinned('nope', true)
  assert.equal(result.ok, false)
  assert.equal((result as { reason: WarningCode }).reason, 'unknown_hardware_model')
})

/* ─────────────────── 重复连线与假地址冲突 ─────────────────── */

test('★ 同一对端口重复连接必须被拒（不静默叠线）', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const sid = sensor.value.id

  const first = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sid, portId: 'SDA' })
  assert.equal(first.ok, true)

  const again = state.connect({ componentId: pi, portId: 'P3' }, { componentId: sid, portId: 'SDA' })
  assert.equal(again.ok, false, '★ 完全重复的连接必须拒绝')
  assert.equal((again as { reason: WarningCode }).reason, 'already_connected')
  assert.equal(state.connections.length, 1, '不该叠出第二条线')
})

test('★ 多个**不同**端口接到同一个端口是合法的（I2C 是总线）', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const sid = sensor.value.id

  assert.equal(state.connect({ componentId: pi, portId: 'P3' }, { componentId: sid, portId: 'SDA' }).ok, true)
  assert.equal(state.connect({ componentId: pi, portId: 'P27' }, { componentId: sid, portId: 'SDA' }).ok, true)
  assert.equal(state.connections.length, 2, '不同主机端口接同一从机端口应当允许')
})

test('★ 反向再连一次也算重复（A→B 与 B→A 是同一根线）', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const sid = sensor.value.id

  assert.equal(state.connect({ componentId: pi, portId: 'P3' }, { componentId: sid, portId: 'SDA' }).ok, true)
  const reversed = state.connect({ componentId: sid, portId: 'SDA' }, { componentId: pi, portId: 'P3' })
  assert.equal(reversed.ok, false, '★ 反着连是同一根线，必须拒绝')
  assert.equal((reversed as { reason: WarningCode }).reason, 'already_connected')
  assert.equal(state.connections.length, 1)
})

test('★★ 重复接线被拒 ⇒ **不可能**出现"一个器件被算成多个"的假地址冲突', () => {
  const { state, pi } = withPi()
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  const sid = sensor.value.id

  // 复现用户当时的操作：同一对端口反复连（含反方向）
  for (let i = 0; i < 3; i += 1) {
    state.applyAction({ kind: 'connect', from: { componentId: pi, portId: 'P27' }, to: { componentId: sid, portId: 'SDA' } })
    state.applyAction({ kind: 'connect', from: { componentId: sid, portId: 'SDA' }, to: { componentId: pi, portId: 'P27' } })
  }

  assert.equal(state.connections.length, 1, '六次尝试只该留下一条线')

  // ★ 这条断言是**真正的保证**：总线上只有一个器件 ⇒ 不得报地址冲突。
  //   （`#i2cWarnings` 里另有一层按**器件**去重的防御，那是给"本修复之前就已存在的状态"
  //     和未来新路径兜底的；经由公开 API 已经造不出重复，所以那一层在这里走不到。）
  const conflicts = state.warnings().filter((w) => w.code === 'i2c_address_conflict')
  assert.deepEqual(conflicts, [], '★ 一个器件不得被算成多个 —— 那是用户无从下手的假错误')
})

test('★ 真正的地址冲突仍要检出（去重不能把真问题一起修掉）', () => {
  const { state, pi } = withPi()
  const a = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  const b = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(a.ok && b.ok)

  // 两个 BME280 都挂在 I2C1 上 —— 默认地址都是 0x76，这才是真冲突
  state.connect({ componentId: pi, portId: 'P3' }, { componentId: a.value.id, portId: 'SDA' })
  state.connect({ componentId: pi, portId: 'P3' }, { componentId: b.value.id, portId: 'SDA' })

  const conflicts = state.warnings().filter((w) => w.code === 'i2c_address_conflict')
  assert.equal(conflicts.length, 1, '两个真器件同地址必须报出来')
  assert.equal(conflicts[0]?.severity, 'error')
})

/* ─────────────────── direction 的消费者（它不是装饰字段） ─────────────────── */

test('★ 两个供电输出相接被拒 —— `protocol` 抓不到，因为它两端都是 power', () => {
  const state = new AssemblyState()
  const a = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const b = state.place('rpi-4b', { x: 0.2, y: restingY('rpi-4b'), z: 0 })
  assert.ok(a.ok && b.ok)
  // P1 = 3V3（power）↔ P17 = 3V3（power）：**同电压**的两个供电输出接在一起。
  // ★ 必须同电压，否则先触发 `voltage_mismatch`（它排在 direction 之前）——
  //   那条更具体，但会**遮住**方向冲突，单测就测不到了。
  const link = state.connect({ componentId: a.value.id, portId: 'P1' }, { componentId: b.value.id, portId: 'P17' })
  assert.equal(link.ok, false)
  assert.equal(link.ok === false ? link.reason : '', 'direction_conflict')
})

test('★ power ↔ in 是**正常**的（供电 → 受电），不能被误拦', () => {
  const state = new AssemblyState()
  const pi = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.05, y: restingY('bme280'), z: 0 })
  assert.ok(pi.ok && sensor.ok)
  const link = state.connect({ componentId: pi.value.id, portId: 'P1' }, { componentId: sensor.value.id, portId: 'VCC' })
  assert.equal(link.ok, true, '树莓派 3V3 → 传感器 VCC 必须放行')
})

test('★ 两个输出驱动同一条线被拒（推挽对冲）', () => {
  const state = new AssemblyState()
  const pi = state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  const esp = state.place('esp32-seat-sensor', { x: 0.2, y: restingY('esp32-seat-sensor'), z: 0 })
  assert.ok(pi.ok && esp.ok)
  // P23 = SCLK（out）↔ E18 = VSPI_CLK（out）：两个输出
  const link = state.connect({ componentId: pi.value.id, portId: 'P23' }, { componentId: esp.value.id, portId: 'E18' })
  assert.equal(link.ok, false)
  assert.equal(link.ok === false ? link.reason : '', 'direction_conflict')
})
