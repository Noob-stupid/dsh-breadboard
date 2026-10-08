/**
 * 模型库自检 —— 坐标系错位的永久防线。
 *
 * ★ 为什么值得单独一条测试（前端 owner 建议、我采纳并升级为硬约束）：
 *   端口坐标是「组件局部坐标」，若原点约定不统一，端口就会落到几何体外，
 *   表现为**锚点飘在板外、线缆端点连空气** —— 而这类错误肉眼在代码里看不出来，
 *   一旦导入外部 STEP/glTF 模型只会更频繁。
 *   所以：对**每个**预置型号断言所有端口都在包围盒内。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HARDWARE_MODELS, findModel, instantiate, restingY } from '../src/contracts/library.ts'

/** 坐标比较容差（米）。1 微米。 */
const EPSILON = 1e-6

const models = Object.values(HARDWARE_MODELS)

test('模型库非空，且键与 model.key 一致', () => {
  assert.ok(models.length > 0)
  for (const model of models) {
    assert.equal(findModel(model.key)?.key, model.key, `${model.key} 的键与 key 字段不一致`)
  }
})

test('★ 每个型号的所有端口都落在几何包围盒内（原点 = 包围盒中心）', () => {
  for (const model of models) {
    const half = { x: model.size.x / 2, y: model.size.y / 2, z: model.size.z / 2 }

    for (const port of model.ports) {
      const { x, y, z } = port.position
      const where = `${model.key}.${port.portId} = (${String(x)}, ${String(y)}, ${String(z)})`
      const box = `包围盒 ±(${String(half.x)}, ${String(half.y)}, ${String(half.z)})`

      assert.ok(
        Math.abs(x) <= half.x + EPSILON,
        `${where} 越出包围盒 x 轴（${box}）—— 原点约定是「包围盒中心」，端口必须在体内`,
      )
      assert.ok(
        Math.abs(y) <= half.y + EPSILON,
        `${where} 越出包围盒 y 轴（${box}）—— 注意 y 是中心高度，平放地面要 position.y = size.y/2`,
      )
      assert.ok(
        Math.abs(z) <= half.z + EPSILON,
        `${where} 越出包围盒 z 轴（${box}）`,
      )
    }
  }
})

test('尺寸为正数（否则包围盒判定无意义）', () => {
  for (const model of models) {
    for (const axis of ['x', 'y', 'z'] as const) {
      assert.ok(model.size[axis] > 0, `${model.key}.size.${axis} 必须为正，实际 ${String(model.size[axis])}`)
    }
  }
})

test('同一型号内端口 id 不重复', () => {
  for (const model of models) {
    const ids = model.ports.map((port) => port.portId)
    assert.equal(new Set(ids).size, ids.length, `${model.key} 存在重复端口 id：${ids.join(',')}`)
  }
})

test('端口电平非负；功耗与供电非负', () => {
  for (const model of models) {
    for (const port of model.ports) {
      assert.ok(port.voltage >= 0, `${model.key}.${port.portId} 电平为负`)
    }
    assert.ok(model.powerDrawW >= 0, `${model.key}.powerDrawW 为负`)
    assert.ok(model.powerSupplyW >= 0, `${model.key}.powerSupplyW 为负`)
  }
})

test('I2C 从机地址：声明了就必须落在 7 位可用区间', () => {
  // 注意：有 I2C 端口 ≠ 是从机。树莓派是**总线主机**，本就不该有从机地址。
  // 「声明 i2cAddress」这一动作本身就表示「我是挂在总线上的从机」。
  for (const model of models) {
    if (model.i2cAddress === undefined) continue
    assert.ok(
      model.i2cAddress >= 0x08 && model.i2cAddress <= 0x77,
      `${model.key} 的 I2C 地址 ${String(model.i2cAddress)} 不在 7 位可用区间 0x08–0x77`,
    )
  }
})

test('至少有一个型号声明 I2C 从机地址（否则地址冲突检测是死代码）', () => {
  assert.ok(
    models.some((model) => model.i2cAddress !== undefined),
    '没有任何从机地址，i2c_address_conflict 永远不可能触发',
  )
})

test('每个 I2C 端口都明确表态是否为共享总线（漏了会让第二个设备连不上）', () => {
  for (const model of models) {
    for (const port of model.ports) {
      if (port.protocol !== 'i2c') continue
      assert.equal(
        port.shared,
        true,
        `${model.key}.${port.portId} 是 I2C 却未标 shared —— 一条总线上将只能挂一个设备`,
      )
    }
  }
})

test('至少有一个型号能供电（否则任何放置都会 power_exceeded）', () => {
  assert.ok(
    models.some((model) => model.powerSupplyW > 0),
    '模型库中没有任何供电源，供电预算恒为 0',
  )
})

test('instantiate 产出独立的端口副本（实例之间不共享可变对象）', () => {
  const a = instantiate('a', 'bme280', { x: 0, y: 0, z: 0 })
  const b = instantiate('b', 'bme280', { x: 0, y: 0, z: 0 })
  assert.ok(a && b)
  assert.notEqual(a.ports, b.ports)
  assert.notEqual(a.ports[0], b.ports[0])
  // 改一个实例的端口不应影响另一个，也不应影响模型库本体
  const first = a.ports[0]
  assert.ok(first)
  ;(first as { portId: string }).portId = 'MUTATED'
  assert.notEqual(b.ports[0]?.portId, 'MUTATED')
  assert.notEqual(findModel('bme280')?.ports[0]?.portId, 'MUTATED')
})

test('restingY 返回半厚（让组件平放地面）', () => {
  for (const model of models) {
    assert.equal(restingY(model.key), model.size.y / 2)
  }
  assert.equal(restingY('nonexistent-model'), 0, '未知型号应安全退化')
})
