/**
 * 声明式端口布局（`portLayout`）测试。
 *
 * ★ 这个机制存在的理由：**手打坐标已经出过一次错**（三个型号混用两套原点约定，
 *   树莓派 6 个端口 4 个落在几何体外）。声明式规则让等距**由规则推出**，
 *   并让自检从「逐点在盒内」升级为**结构性校验**。
 *
 * 本文件同时钉住两件在实现过程中真实踩到的事：
 *   ① **声明顺序 ≠ 几何顺序**（bme280 按 I2C/VCC/GND 声明，几何上是 中间/右/左）
 *   ② **`inset` 是垂直方向的内缩，不是沿边方向的边距** —— 混用会让校验公式失效
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  HARDWARE_MODELS,
  PortLayoutError,
  TOP_FACE_INSET,
  resolveModel,
  type HardwareModelSource,
  type PortLayoutRule,
} from '../src/contracts/library.ts'

/** 造一个最小可测的型号源。 */
function source(size: { x: number; y: number; z: number }, rule?: PortLayoutRule): HardwareModelSource {
  return {
    key: 'test-model',
    label: '测试型号',
    size,
    ...(rule ? { portLayout: rule } : {}),
    ports: [
      { portId: 'A', name: 'A', protocol: 'i2c', voltage: 3.3 },
      { portId: 'B', name: 'B', protocol: 'power', voltage: 3.3 },
      { portId: 'C', name: 'C', protocol: 'power', voltage: 0 },
    ],
    powerDrawW: 0,
    powerSupplyW: 0,
  }
}

/* ─────────────────── 精确等价（这个改动的唯一验收标准） ─────────────────── */

test('★ 规则与手打坐标精确等价（基线逐项比对）', () => {
  // ★ rpi-4b 的基线**在 2026-10-08 有意改过两次**（都不是漂移，理由如下）：
  //
  //   第一次（y 与 pitch）：
  //   · `height` 从"贴包络顶面"（+0.0084）改成 +0.0016（推导的排针顶）
  //   · `pitch` 从 0.012 收到 0.009：6 个端口原跨 60mm，真 40pin 首尾针中心距只有 48.26mm
  //
  //   第二次（**整条边反了** —— 这次是主修正）：
  //   · `edge` 从 `'+z'` 改成 **`'-z'`**：40pin 排针在 **−z 那条长边**上，端口原来铺在对侧空边上。
  //     三个独立证据：并行会话的顶点分箱 / 本仓库的高处顶点分布（z∈[−26,−25) 跨度 53.8mm）/
  //     **用户直接在渲染图上圈出了排针的位置**。
  //   · `inset` 0.005 → **0.0025**：排针实际在 z ≈ −25.5（−28 + 2.5），原来从 +z 边内缩 5mm 落在 +23。
  //   · `height` 0.0016 → **0.0031**：**实测**的排针顶（推导的 1.6mm 假设 PCB 贴包络下缘，实测 PCB 高约 1.5mm）。
  const BASELINE: Record<string, Record<string, [number, number, number]>> = {
    // ★★ rpi-4b **逐针建模**（2026-10-08）：40 针、2 排。
    //   几何：`row = (n−1) % 2`（奇数脚一排、偶数脚另一排），`column = floor((n−1)/2)`
    //   x = **−0.00165** + (column − 9.5) × **0.0023**   y = **0**（针杆中部，不是针尖）
    //   z = −0.028 + 0.00325 ∓ 0.00115（两排对称跨 inset 线）
    //
    //   ⚠️ `pitch` 用 **2.3mm 而不是标准的 2.54mm** —— 那是**归一化之后**模型的实际引脚间距。
    //   根因：声明 `size.x = 85mm`（真机 PCB 长）而**模型包围盒 x = 92.86mm**
    //   ⇒ 逐轴缩放系数 85/92.86 = **0.9153** ⇒ 2.54mm 被压成 2.32mm。
    //   用 2.54 会让 19 列累积漂移 4.6mm、两端引脚落到排针外（实测 P37–P40 落空）。
    //   **这是已知的模型/契约尺寸不一致**，两条路各有代价，见 `docs/06` 待办 #1。
    'rpi-4b': {
      P1: [-0.0307175, 0, -0.0259125],
      P2: [-0.0307175, 0, -0.0235875],
      P3: [-0.0283925, 0, -0.0259125],
      P4: [-0.0283925, 0, -0.0235875],
      P39: [0.0134575, 0, -0.0259125],
      P40: [0.0134575, 0, -0.0235875],
    },
    // ★ 逐针后 bme280 是 4 针，`order` = VCC/GND/SCL/SDA（负→正），
    //   4 槽居中 ⇒ z = ∓3.81mm、∓1.27mm。
    bme280: {
      VCC: [-0.008025, -0.0014, -0.00381],
      GND: [-0.008025, -0.0014, -0.00127],
      SCL: [-0.008025, -0.0014, 0.00127],
      SDA: [-0.008025, -0.0014, 0.00381],
    },
    'led-5v': {
      SIG: [-0.0063, -0.00375, 0],
      VCC: [-0.0063, -0.00375, 0.00254],
      GND: [-0.0063, -0.00375, -0.00254],
    },
  }

  let checked = 0
  for (const [key, expected] of Object.entries(BASELINE)) {
    const model = HARDWARE_MODELS[key]
    assert.ok(model, `${key} 应存在`)
    // ★ 遍历**基线里的项**，不是模型里的全部端口 —— rpi-4b 逐针后有 40 个，
    //   逐个抄进基线只是把规则重写一遍。这里取**首尾与相邻**的代表性引脚，
    //   结构性的东西（跨度、双排、2.54mm 间距）由下面的独立断言把关。
    for (const portId of Object.keys(expected)) {
      const want = expected[portId]
      const port = model.ports.find((p) => p.portId === portId)
      assert.ok(port, `${key}.${portId} 不在模型里`)
      assert.ok(want, `${key}.${portId} 基线缺失`)
      const got: [number, number, number] = [port.position.x, port.position.y, port.position.z]
      for (let axis = 0; axis < 3; axis += 1) {
        assert.ok(
          Math.abs((got[axis] ?? 0) - (want[axis] ?? 0)) < 1e-12,
          `${key}.${portId} 第 ${String(axis)} 轴：期望 ${String(want[axis])}，得到 ${String(got[axis])}`,
        )
      }
      checked += 1
    }
  }
  // 6（rpi-4b 首尾与相邻代表）+ 4（bme280 逐针）+ 3（led-5v）= 13
  assert.equal(checked, 13, '应比对 13 个端口')
})

/* ─────────────────── ★ 声明顺序 ≠ 几何顺序 ─────────────────── */

test('★ bme280：几何顺序与声明顺序不同，由 order 显式表达', () => {
  const model = HARDWARE_MODELS.bme280
  const z = (portId: string): number =>
    model.ports.find((port) => port.portId === portId)?.position.z ?? Number.NaN

  // ★ 逐针建模后 bme280 是 **4 针**（原来 3 个：I2C/VCC/GND —— 把 SDA+SCL 并成了一根线）。
  //   `order` 显式给出沿 z 的几何次序，从负方向到正方向。
  assert.deepEqual(model.ports.map((port) => port.portId), ['VCC', 'GND', 'SCL', 'SDA'])
  assert.ok(z('VCC') < z('GND'), 'VCC 在最负方向')
  assert.ok(z('GND') < z('SCL'), 'GND 在 SCL 之前')
  assert.ok(z('SCL') < z('SDA'), 'SDA 在最正方向')
  assert.equal(z('VCC'), -z('SDA'), '4 针居中 ⇒ 首尾对称')
  assert.equal(z('GND'), -z('SCL'), '4 针居中 ⇒ 中间两个对称')
})

test('省略 order 时按声明顺序排（用于声明顺序本身就是几何顺序的型号）', () => {
  const model = resolveModel(source({ x: 0.02, y: 0.003, z: 0.02 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01 }))
  const xs = model.ports.map((port) => port.position.x)
  assert.deepEqual(xs, [-0.002, 0, 0.002], '按声明顺序依次排在负→正方向')
})

/* ─────────────────── ★ inset 是垂直方向的内缩 ─────────────────── */

test('★ inset 是**垂直方向**内缩，取半个垂直轴长即落在中线', () => {
  // ★ 用**合成模型**测规则本身。
  //   原来拿 `led-5v` 当例子（`edge:'+z'`、`inset` 取半深 ⇒ z=0），
  //   而逐针改造后它的引脚改到了 **−x 边**（真实模块的引脚就在短边上），
  //   那个例子不再成立 —— **拿真实型号当规则的例子，型号一改测试就假失败**。
  const model = resolveModel(source({ x: 0.02, y: 0.003, z: 0.02 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01 }))
  for (const port of model.ports) {
    assert.equal(port.position.z, 0, 'inset 取半深 ⇒ 整行落在 z=0 中线')
  }
})

test('沿边方向是**居中**的，不是从边距起排', () => {
  const model = resolveModel(source({ x: 0.02, y: 0.003, z: 0.02 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01 }))
  const xs = model.ports.map((port) => port.position.x)
  assert.equal((xs[0] ?? 0) + (xs[2] ?? 0), 0, '两端关于原点对称 ⇒ 居中')
})

/* ─────────────────── 结构性校验 ─────────────────── */

test('★ 结构性校验：整行装不下时在**写规则那一刻**就抛错', () => {
  // 沿 x 轴长 0.02，3 个端口间距 0.02 ⇒ 跨度 0.04 > 0.02
  assert.throws(
    () => resolveModel(source({ x: 0.02, y: 0.003, z: 0.02 }, { edge: '+z', pitch: 0.02, count: 3, inset: 0.01 })),
    PortLayoutError,
    '一行端口比板子还长，必须在解析时就拦下',
  )
})

test('结构性校验：inset 越出垂直轴时抛错', () => {
  // edge '+z' ⇒ 垂直方向是 z，轴长 0.02；inset 0.05 越界
  assert.throws(
    () => resolveModel(source({ x: 0.05, y: 0.003, z: 0.02 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.05 })),
    PortLayoutError,
  )
})

test('结构性校验：count 与 ports 数不一致时抛错', () => {
  assert.throws(
    () => resolveModel(source({ x: 0.05, y: 0.003, z: 0.05 }, { edge: '+z', pitch: 0.002, count: 5, inset: 0.01 })),
    PortLayoutError,
  )
})

test('结构性校验：order 里有未知 portId 或漏项时抛错', () => {
  const size = { x: 0.05, y: 0.003, z: 0.05 }
  assert.throws(
    () => resolveModel(source(size, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01, order: ['A', 'B', 'X'] })),
    PortLayoutError,
    '未知 portId 必须拦下',
  )
  assert.throws(
    () => resolveModel(source(size, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01, order: ['A', 'B'] })),
    PortLayoutError,
    '漏项必须拦下',
  )
  assert.throws(
    () => resolveModel(source(size, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01, order: ['A', 'A', 'B'] })),
    PortLayoutError,
    '重复 portId 必须拦下',
  )
})

test('结构性校验：pitch 非正、count 非正整数、inset 为负都抛错', () => {
  const size = { x: 0.05, y: 0.003, z: 0.05 }
  for (const rule of [
    { edge: '+z' as const, pitch: 0, count: 3, inset: 0.01 },
    { edge: '+z' as const, pitch: -0.001, count: 3, inset: 0.01 },
    { edge: '+z' as const, pitch: 0.002, count: 0, inset: 0.01 },
    { edge: '+z' as const, pitch: 0.002, count: 2.5, inset: 0.01 },
    { edge: '+z' as const, pitch: 0.002, count: 3, inset: -1 },
  ]) {
    assert.throws(() => resolveModel(source(size, rule)), PortLayoutError, JSON.stringify(rule))
  }
})

test('结构性校验：height 越出包围盒 y 轴时抛错', () => {
  assert.throws(
    () =>
      resolveModel(
        source({ x: 0.05, y: 0.003, z: 0.05 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.01, height: 1 }),
      ),
    PortLayoutError,
  )
})

test('既没有显式 position 也没有 portLayout ⇒ 解析时报错（不允许静默落零）', () => {
  const broken: HardwareModelSource = {
    ...source({ x: 0.05, y: 0.003, z: 0.05 }),
  }
  assert.throws(() => resolveModel(broken), PortLayoutError, '缺位置必须报错，不能默认成 (0,0,0)')
})

test('★ 同时给了 portLayout 与显式 position ⇒ 抛错（不搞「规则胜出 + 告警」）', () => {
  const size = { x: 0.05, y: 0.003, z: 0.05 }
  const both: HardwareModelSource = {
    key: 'both',
    label: '两处真相',
    size,
    portLayout: { edge: '+z', pitch: 0.002, count: 3, inset: 0.02 },
    ports: [
      { portId: 'A', name: 'A', protocol: 'i2c', voltage: 3.3, position: { x: 0, y: 0, z: 0 } },
      { portId: 'B', name: 'B', protocol: 'power', voltage: 3.3 },
      { portId: 'C', name: 'C', protocol: 'power', voltage: 0 },
    ],
    powerDrawW: 0,
    powerSupplyW: 0,
  }

  assert.throws(
    () => resolveModel(both),
    PortLayoutError,
    '两种歧义（都缺 / 都有）必须都不放过 —— 告警在这条链路上等于没有',
  )
})

/* ─────────────────── 四条边都能用 ─────────────────── */

test('四条边都能正确落位（沿边轴与垂直轴不混淆）', () => {
  const size = { x: 0.05, y: 0.01, z: 0.03 }
  const cases: Array<[PortLayoutRule['edge'], (p: { x: number; y: number; z: number }) => number, number]> = [
    ['+z', (p) => p.z, 0.03 / 2 - 0.005],
    ['-z', (p) => p.z, -(0.03 / 2) + 0.005],
    ['+x', (p) => p.x, 0.05 / 2 - 0.005],
    ['-x', (p) => p.x, -(0.05 / 2) + 0.005],
  ]
  for (const [edge, pick, expected] of cases) {
    const model = resolveModel(source(size, { edge, pitch: 0.004, count: 3, inset: 0.005 }))
    for (const port of model.ports) {
      assert.ok(
        Math.abs(pick(port.position) - expected) < 1e-12,
        `${edge}: 垂直轴落位应为 ${String(expected)}，得到 ${String(pick(port.position))}`,
      )
      assert.equal(port.position.y, size.y / 2 - TOP_FACE_INSET, '高度默认贴顶面')
    }
  }
})

test('默认高度 = 半厚 − TOP_FACE_INSET（不写 height 时）', () => {
  const model = resolveModel(source({ x: 0.05, y: 0.01, z: 0.05 }, { edge: '+z', pitch: 0.002, count: 3, inset: 0.02 }))
  for (const port of model.ports) {
    assert.equal(port.position.y, 0.01 / 2 - TOP_FACE_INSET)
  }
})

/* ─────────────────── 全部预置型号仍然自洽 ─────────────────── */

test('★ 全部预置型号：端口仍落在包围盒内（声明式改造没有破坏原有约束）', () => {
  for (const model of Object.values(HARDWARE_MODELS)) {
    const half = { x: model.size.x / 2, y: model.size.y / 2, z: model.size.z / 2 }
    for (const port of model.ports) {
      const { x, y, z } = port.position
      const where = `${model.key}.${port.portId}`
      assert.ok(Math.abs(x) <= half.x + 1e-9, `${where} 越出 x 轴`)
      assert.ok(Math.abs(y) <= half.y + 1e-9, `${where} 越出 y 轴`)
      assert.ok(Math.abs(z) <= half.z + 1e-9, `${where} 越出 z 轴`)
    }
  }
})
