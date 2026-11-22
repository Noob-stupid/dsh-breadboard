/**
 * 模型来源工具的护栏测试。
 *
 * ★ 为什么专测包围盒那一支：它是**唯一会产出一个数字、而那个数字会被当真**的地方。
 *   量错了不会报错，只会让 `aspectDrift` 变成"看着还行"的假数 —— 那正是这一族最坏的情形。
 *   所以这里钉的不是"能跑"，而是**知不知道自己在什么情况下不该给数**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { measureGlbBbox } from '../src/host/model-source-tools.ts'
import { createModelSourceTools } from '../src/host/model-source-tools.ts'

/** 造一个最小 GLB：一个 JSON chunk + 空 BIN chunk。 */
function makeGlb(doc: unknown): Uint8Array {
  const json = Buffer.from(JSON.stringify(doc), 'utf8')
  const pad = (4 - (json.length % 4)) % 4
  const jsonPadded = Buffer.concat([json, Buffer.alloc(pad, 0x20)])
  const total = 12 + 8 + jsonPadded.length
  const out = Buffer.alloc(total)
  out.write('glTF', 0, 'ascii')
  out.writeUInt32LE(2, 4)
  out.writeUInt32LE(total, 8)
  out.writeUInt32LE(jsonPadded.length, 12)
  out.writeUInt32LE(0x4e4f534a, 16)
  jsonPadded.copy(out, 20)
  return new Uint8Array(out)
}

/** 一个 POSITION accessor，包围盒给定。 */
function docWith(positionMin: number[], positionMax: number[], nodeExtra: Record<string, unknown> = {}) {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, ...nodeExtra }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: positionMin, max: positionMax }],
  }
}

test('纯平移的节点：能量，且平移不改变尺寸', () => {
  const glb = makeGlb(docWith([0, 0, 0], [0.085, 0.056, 0.016], { translation: [1, 2, 3] }))
  const result = measureGlbBbox(glb)
  assert.ok(result.dims, `应当能量出来，实际：${result.reason}`)
  const [x, y, z] = result.dims
  assert.ok(Math.abs(x - 0.085) < 1e-9, `x=${x}`)
  assert.ok(Math.abs(y - 0.056) < 1e-9, `y=${y}`)
  assert.ok(Math.abs(z - 0.016) < 1e-9, `z=${z}`)
})

test('★ 带旋转的节点：**拒绝给数**（旋转改变形状，accessor 的 min/max 不再等于包围盒）', () => {
  const s = Math.SQRT1_2
  const glb = makeGlb(docWith([0, 0, 0], [1, 1, 1], { rotation: [0, 0, s, s] }))
  const result = measureGlbBbox(glb)
  assert.equal(result.dims, undefined, '不该给出数字')
  assert.match(String(result.reason), /旋转/)
})

test('★ 带缩放的节点：**拒绝给数**', () => {
  const glb = makeGlb(docWith([0, 0, 0], [1, 1, 1], { scale: [2, 1, 1] }))
  const result = measureGlbBbox(glb)
  assert.equal(result.dims, undefined)
  assert.match(String(result.reason), /缩放/)
})

test('单位阵 matrix（纯平移）能量；非单位阵拒绝', () => {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1]
  const ok = measureGlbBbox(makeGlb(docWith([0, 0, 0], [2, 4, 6], { matrix: identity })))
  assert.ok(ok.dims)
  assert.deepEqual(
    ok.dims?.map((v) => Number(v.toFixed(6))),
    [2, 4, 6],
  )

  const scaled = [3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
  const bad = measureGlbBbox(makeGlb(docWith([0, 0, 0], [2, 4, 6], { matrix: scaled })))
  assert.equal(bad.dims, undefined)
})

test('不是 GLB / 太小：如实拒绝，不抛', () => {
  const notGlb = new Uint8Array(64).fill(0x41)
  const r1 = measureGlbBbox(notGlb)
  assert.equal(r1.dims, undefined)
  assert.match(String(r1.reason), /GLB/)

  const tiny = new Uint8Array(4)
  const r2 = measureGlbBbox(tiny)
  assert.equal(r2.dims, undefined)
})

test('没有 POSITION 的 min/max：如实拒绝', () => {
  const glb = makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [0, 0, 0], max: [1, 1, 1] }],
  })
  // 有 min/max，能量
  assert.ok(measureGlbBbox(glb).dims)

  const noAccessor = makeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 99 } }] }],
    accessors: [],
  })
  assert.equal(measureGlbBbox(noAccessor).dims, undefined)
})

test('★ 三个工具都注册且必填项声明完整', () => {
  const fake = { list: async () => [] }
  const tools = createModelSourceTools({
    models: fake as never,
    workDir: 'C:/tmp/workorders',
  })
  const names = tools.map((t) => t.name).sort()
  assert.deepEqual(names, ['hw_import_model_file', 'hw_list_missing_models', 'hw_model_workorder'])
  for (const tool of tools) {
    const params = tool.parameters as { required?: string[]; properties?: Record<string, unknown> }
    for (const key of params.required ?? []) {
      assert.ok(params.properties && key in params.properties, `${tool.name}: required 里的 ${key} 没在 properties 里`)
    }
  }
})

test('★ 缺几何清单：没有几何的型号出现在 missing 里', async () => {
  const fake = { list: async () => [] }
  const tools = createModelSourceTools({ models: fake as never, workDir: 'C:/tmp' })
  const list = tools.find((t) => t.name === 'hw_list_missing_models')
  assert.ok(list)
  const value = (await list.execute({}, { signal: new AbortController().signal } as never)) as {
    declaredTotal: number
    missing: Array<{ modelKey: string }>
  }
  assert.ok(value.declaredTotal > 0, '内置型号不可能为空')
  assert.equal(value.missing.length, value.declaredTotal, '没有任何已导入几何时，missing 应等于全量')
})
