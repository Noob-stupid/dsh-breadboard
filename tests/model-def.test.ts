/**
 * 数据驱动型号定义的正反两面。
 *
 * ★ 这个文件里**失败用例比成功用例更重要**：写定义的人多半不是我们
 *   （那是"生态往里填硬件"的前提），所以每条错误都必须**说清是哪个字段**，
 *   而且**危险的定义必须被拒绝**（覆盖内置、端口重号、规则本身不合理）。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  applyRegistry,
  buildRegistry,
  loadModelDefs,
  parseModelDefinition,
} from '../src/core/models/definitions.ts'
import {
  HARDWARE_MODELS,
  SOURCES,
  findModel,
  isExternalModel,
  modelKeys,
  resolveModel,
  setExternalModels,
} from '../src/contracts/library.ts'

/** 一条最小可用的合法定义（测试自造，不代表任何真板子）。 */
function minimalDef(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'test-chip',
    label: '测试芯片',
    size: { x: 0.02, y: 0.005, z: 0.01 },
    powerDrawW: 0,
    powerSupplyW: 0,
    // ★ 端口必须**要么给显式 `position`、要么给 `portLayout`** ——
    //   两者都缺按契约就是"解析时报错"。这里给显式坐标（最简单的一种）。
    ports: [
      {
        portId: 'P1',
        name: 'GND',
        protocol: 'power',
        voltage: 3.3,
        direction: 'ground',
        position: { x: -0.002, y: 0.0025, z: 0 },
      },
      {
        portId: 'P2',
        name: 'GPIO1',
        protocol: 'gpio',
        voltage: 3.3,
        direction: 'io',
        position: { x: 0.002, y: 0.0025, z: 0 },
      },
    ],
    ...overrides,
  }
}

/* ───────────────────────── 成功路径 ───────────────────────── */

test('合法定义能解析，并且真的能算出端口坐标（解析 ≠ 只是字段检查）', () => {
  const parsed = parseModelDefinition(minimalDef())
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  const model = resolveModel(parsed.source)
  assert.equal(model.key, 'test-chip')
  assert.equal(model.ports.length, 2)
  // ★ 端口位置是"解析"产出的，必须真的算出来了（不能是 undefined）
  for (const port of model.ports) {
    assert.equal(typeof port.position.x, 'number')
    assert.equal(typeof port.position.y, 'number')
    assert.equal(typeof port.position.z, 'number')
  }
})

/* ───────────────────────── 失败族 ───────────────────────── */

test('缺 key / key 形状不合法 —— 报错必须说清是哪一项', () => {
  const noKey = parseModelDefinition({ ...minimalDef(), key: undefined })
  assert.equal(noKey.ok, false)
  if (!noKey.ok) assert.match(noKey.reason, /key/)

  const badShape = parseModelDefinition(minimalDef({ key: 'Bad_Key' }))
  assert.equal(badShape.ok, false)
  if (!badShape.ok) assert.match(badShape.reason, /key 不合法/)
})

test('size 缺失或非正数 —— 必须拒绝（退化包围盒不会自己报错）', () => {
  const missing = parseModelDefinition(minimalDef({ size: undefined }))
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.reason, /size/)

  const zero = parseModelDefinition(minimalDef({ size: { x: 0, y: 0.005, z: 0.01 } }))
  assert.equal(zero.ok, false)
  if (!zero.ok) assert.match(zero.reason, /size\.x 必须为正数/)

  const nan = parseModelDefinition(minimalDef({ size: { x: Number.NaN, y: 0.005, z: 0.01 } }))
  assert.equal(nan.ok, false)
})

test('端口字段缺失 —— 报错带**端口下标**（写定义的人要能自己修）', () => {
  const noName = parseModelDefinition(
    minimalDef({
      ports: [
        { portId: 'P1', name: 'GND', protocol: 'power', voltage: 3.3, direction: 'ground' },
        { portId: 'P2', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      ],
    }),
  )
  assert.equal(noName.ok, false)
  if (!noName.ok) assert.match(noName.reason, /ports\[1\]\.name/)

  const noVoltage = parseModelDefinition(
    minimalDef({ ports: [{ portId: 'P1', name: 'GND', protocol: 'power', direction: 'ground' }] }),
  )
  assert.equal(noVoltage.ok, false)
  if (!noVoltage.ok) assert.match(noVoltage.reason, /ports\[0\]\.voltage/)
})

test('★ portId 重复必须拒绝 —— 两个端口共用一个身份是**静默灾难**', () => {
  const dup = parseModelDefinition(
    minimalDef({
      ports: [
        { portId: 'P1', name: 'GND', protocol: 'power', voltage: 3.3, direction: 'ground' },
        { portId: 'P1', name: 'VCC', protocol: 'power', voltage: 3.3, direction: 'power' },
      ],
    }),
  )
  assert.equal(dup.ok, false)
  if (!dup.ok) assert.match(dup.reason, /portId 重复/)
})

test('★ 布局规则本身不合理（一排比板子还长）—— 在**加载时**就被拦下', () => {
  const tooWide = parseModelDefinition(
    minimalDef({
      // 10 个端口 × 2.54mm 间距 = 22.86mm，而板子只有 20mm ⇒ 规则不成立
      size: { x: 0.02, y: 0.005, z: 0.01 },
      ports: Array.from({ length: 10 }, (_, i) => ({
        portId: `P${String(i + 1)}`,
        name: `PIN${String(i + 1)}`,
        protocol: 'gpio',
        voltage: 3.3,
        direction: 'io',
      })),
      portLayout: { edge: '+z', pitch: 0.00254, count: 10, inset: 0.001 },
    }),
  )
  assert.equal(tooWide.ok, false)
  if (!tooWide.ok) assert.match(tooWide.reason, /无法解析成可用型号/)
})

/* ───────────────────── 注册表：内置不可被覆盖 ───────────────────── */

test('★★ 外部定义不得覆盖内置型号 —— 否则别人能悄悄改掉所有用户的引脚表', () => {
  const builtinKey = Object.keys(HARDWARE_MODELS)[0]
  assert.ok(builtinKey !== undefined)
  const { models, result } = buildRegistry([
    { source: 'evil.json', raw: minimalDef({ key: builtinKey, label: '被篡改的' }) },
  ])
  assert.deepEqual(result.registered, [])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]?.reason ?? '', /内置型号/)
  // 篡改的定义**没有**进入注册表
  assert.equal(models[builtinKey], undefined)
})

test('外部两条同名 —— 保留先出现的，后到的记原因', () => {
  const { result } = buildRegistry([
    { source: 'a.json', raw: minimalDef({ key: 'dup-chip' }) },
    { source: 'b.json', raw: minimalDef({ key: 'dup-chip', label: '后来的' }) },
  ])
  assert.deepEqual(result.registered, ['dup-chip'])
  assert.equal(result.rejected.length, 1)
  assert.match(result.rejected[0]?.reason ?? '', /重复/)
})

test('失败与拒绝都**被报出来**（不允许静默丢弃）', () => {
  const { result } = buildRegistry([
    { source: 'broken.json', raw: { key: 'x' } },
    { source: 'ok.json', raw: minimalDef({ key: 'ok-chip' }) },
  ])
  assert.deepEqual(result.registered, ['ok-chip'])
  assert.equal(result.failures.length, 1)
  assert.equal(result.failures[0]?.source, 'broken.json')
})

/* ───────────────────── 装上之后：查找路径 ───────────────────── */

test('装上外部表后 findModel/modelKeys 能找到它，且内置仍然优先', () => {
  const builtinKey = Object.keys(HARDWARE_MODELS)[0]
  assert.ok(builtinKey !== undefined)

  const { models } = buildRegistry([{ source: 'ext.json', raw: minimalDef({ key: 'ext-chip' }) }])
  applyRegistry(models)
  try {
    // 外部型号可见
    assert.equal(findModel('ext-chip')?.key, 'ext-chip')
    assert.equal(isExternalModel('ext-chip'), true)
    assert.ok(modelKeys().includes('ext-chip'))
    // 内置型号不受影响，且不被算作"外部"
    assert.equal(findModel(builtinKey)?.key, builtinKey)
    assert.equal(isExternalModel(builtinKey), false)
    // 未知型号仍然 undefined（调用方据此发 unknown_hardware_model）
    assert.equal(findModel('definitely-not-a-model'), undefined)
  } finally {
    applyRegistry({}) // ★ 清理：别让这个测试污染后面的用例
  }
  assert.equal(findModel('ext-chip'), undefined)
})

/* ───────────────────── ★ 往返：这个格式真的能表达现有型号吗 ───────────────────── */

test('★★ 往返等价：把每个内置型号的作者时定义当成外部数据解析，结果必须一致', () => {
  // 这是本文件里**最重要的一条**：如果这个数据格式表达不了现有型号
  // （比如表达不了 rpi-4b 的双排 40 针），那"只加数据就能加板子"就是假的，
  // 只是把硬编码换了个地方。
  for (const [key, source] of Object.entries(SOURCES)) {
    // JSON 往返：证明它**能被序列化成数据**（不能用函数/undefined 之类 TS 专属表达）
    const asJson = JSON.parse(JSON.stringify(source)) as unknown
    const parsed = parseModelDefinition(asJson)
    assert.equal(parsed.ok, true, `${key} 的作者时定义无法作为 JSON 数据被解析：${parsed.ok ? '' : parsed.reason}`)
    if (!parsed.ok) continue

    const fromData = resolveModel(parsed.source)
    const builtin = HARDWARE_MODELS[key]
    assert.ok(builtin !== undefined)
    assert.equal(fromData.ports.length, builtin.ports.length, `${key} 端口数不一致`)

    // 逐端口比对身份/丝印/协议/电压/方向/位置
    for (let i = 0; i < builtin.ports.length; i += 1) {
      const a = fromData.ports[i]
      const b = builtin.ports[i]
      assert.ok(a !== undefined && b !== undefined)
      assert.equal(a.portId, b.portId, `${key} 第 ${String(i)} 个端口 portId 不一致`)
      assert.equal(a.name, b.name, `${key}.${b.portId} 丝印不一致`)
      assert.equal(a.protocol, b.protocol, `${key}.${b.portId} 协议不一致`)
      assert.equal(a.voltage, b.voltage, `${key}.${b.portId} 电压不一致`)
      assert.equal(a.direction, b.direction, `${key}.${b.portId} 方向不一致`)
      // 坐标允许浮点误差，但必须**真的落在同一处**（差一点就说明归一化/布局语义变了）
      assert.ok(Math.abs(a.position.x - b.position.x) < 1e-9, `${key}.${b.portId} x 坐标漂移`)
      assert.ok(Math.abs(a.position.y - b.position.y) < 1e-9, `${key}.${b.portId} y 坐标漂移`)
      assert.ok(Math.abs(a.position.z - b.position.z) < 1e-9, `${key}.${b.portId} z 坐标漂移`)
    }
  }
})

test('SOURCES 的每个键与 HARDWARE_MODELS 对齐（防止两处各记一份而漂移）', () => {
  assert.deepEqual(Object.keys(SOURCES).sort(), Object.keys(HARDWARE_MODELS).sort())
})

test('setExternalModels 直接装上（core 层之外的用法）', () => {
  setExternalModels({})
  assert.equal(findModel('ext-chip'), undefined)
})

/* ───────────────────── 从目录加载（启动时走的那条路） ───────────────────── */

test('loadModelDefs：多个目录**汇总后一次注册**（后者不会丢掉前者）', async () => {
  const files: Record<string, string> = {
    '/a/one.json': JSON.stringify(minimalDef({ key: 'dir-a-chip' })),
    '/b/two.json': JSON.stringify(minimalDef({ key: 'dir-b-chip' })),
  }
  const logs: string[] = []
  const result = await loadModelDefs(
    ['/a', '/b'],
    {
      listJson: async (dir) =>
        Object.keys(files)
          .filter((f) => f.startsWith(dir))
          .map((f) => f),
      readText: async (file) => files[file] ?? '',
    },
    (message) => logs.push(message),
  )
  try {
    assert.deepEqual([...result.registered].sort(), ['dir-a-chip', 'dir-b-chip'])
    // ★ 这是"逐目录注册会丢东西"那个坑的回归断言：两个目录的定义**同时**可见
    assert.equal(findModel('dir-a-chip')?.key, 'dir-a-chip')
    assert.equal(findModel('dir-b-chip')?.key, 'dir-b-chip')
  } finally {
    applyRegistry({})
  }
})

test('loadModelDefs：目录不存在 ⇒ 静默跳过（那是正常状态）', async () => {
  const result = await loadModelDefs(['/no/such/dir'], {
    listJson: async () => {
      const error = new Error('ENOENT') as Error & { code: string }
      error.code = 'ENOENT'
      throw error
    },
    readText: async () => '',
  })
  assert.deepEqual(result.registered, [])
  assert.deepEqual(result.failures, [])
})

test('loadModelDefs：坏 JSON 必须**报出是哪个文件**（"我明明加了却没生效"的典型）', async () => {
  const files: Record<string, string> = {
    '/c/good.json': JSON.stringify(minimalDef({ key: 'good-chip' })),
    '/c/broken.json': '{ this is not json',
  }
  const result = await loadModelDefs(
    ['/c'],
    {
      listJson: async () => Object.keys(files),
      readText: async (file) => files[file] ?? '',
    },
  )
  applyRegistry({})
  assert.deepEqual(result.registered, ['good-chip'])
  assert.equal(result.failures.length, 1)
  assert.match(result.failures[0]?.source ?? '', /broken\.json/)
  assert.match(result.failures[0]?.reason ?? '', /JSON/)
})
