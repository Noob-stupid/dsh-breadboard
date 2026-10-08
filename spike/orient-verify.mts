/**
 * 验证 `orientToContract` —— 直接调**真函数**，不复刻一份（复刻等于测副本，不是测代码）。
 *
 * 要证的只有一条，但它关乎端口安全：
 *   **任何输入下 det 都必须是 +1。** det = -1 就是反射 ⇒ 模型被镜像而端口不会，
 *   端口落到错误的一侧，且包围盒一模一样、查不出来。
 *
 * 跑法：node --experimental-strip-types spike/orient-verify.mts
 */
import { orientToContract } from '../src/scene/importer.ts'

let failures = 0
const check = (ok: boolean, label: string) => {
  if (!ok) failures++
  console.log(`   ${ok ? 'PASS' : '**FAIL**'}  ${label}`)
}

// ── ① 穷举全部 6 种尺寸序，外加几个病态输入 ────────────────────────────
console.log('\n① 全序穷举：det 必须恒为 +1（否则就是反射 = 镜像）\n')
const ORDERS: [string, [number, number, number]][] = [
  ['x>y>z', [30, 20, 10]],
  ['x>z>y', [30, 10, 20]],
  ['y>x>z', [20, 30, 10]],
  ['y>z>x', [10, 30, 20]],
  ['z>x>y', [20, 10, 30]],
  ['z>y>x', [10, 20, 30]],
]
for (const [label, [x, y, z]] of ORDERS) {
  const r = orientToContract({ x, y, z })
  const det = r.matrix.determinant()
  check(Math.abs(det - 1) < 1e-9, `${label.padEnd(6)} kind=${r.kind.padEnd(11)} det=${det.toFixed(6)}`)
}

console.log('\n② 病态输入：不能 NaN，也不能镜像\n')
for (const [label, size] of [
  ['全相等', { x: 10, y: 10, z: 10 }],
  ['一轴为 0', { x: 10, y: 0, z: 5 }],
  ['全 0', { x: 0, y: 0, z: 0 }],
  ['极小', { x: 1e-9, y: 1e-12, z: 5e-10 }],
] as [string, { x: number; y: number; z: number }][]) {
  const r = orientToContract(size)
  const det = r.matrix.determinant()
  check(Number.isFinite(det) && Math.abs(det - 1) < 1e-9, `${label.padEnd(8)} det=${det.toFixed(6)} ambiguous=${r.ambiguous}`)
}

// ── ③ 真实模型：把源尺寸喂进去，看是否落在契约声明的 size 上 ──────────
console.log('\n③ 真实模型（源尺寸来自 spike/glb-bbox.py 的实测，非推测）\n')
const CASES: { key: string; source: { x: number; y: number; z: number }; contract: { x: number; y: number; z: number } }[] = [
  {
    key: 'rpi-4b',
    source: { x: 92.86, y: 19.89, z: 58.5 },
    contract: { x: 0.085, y: 0.017, z: 0.056 },
  },
  {
    key: 'mpl3115a2',
    source: { x: 19.05, y: 17.78, z: 2.6 },
    contract: { x: 0.01905, y: 0.0026, z: 0.01778 },
  },
]

for (const { key, source, contract } of CASES) {
  const r = orientToContract(source)
  const det = r.matrix.determinant()
  // 源尺寸经旋转后 → 契约坐标
  const v = new (await import('three')).Vector3(source.x, source.y, source.z).applyMatrix4(r.matrix)
  const rotated = { x: Math.abs(v.x), y: Math.abs(v.y), z: Math.abs(v.z) }
  const scales = [contract.x / rotated.x, contract.y / rotated.y, contract.z / rotated.z]
  const drift = Math.max(...scales) / Math.min(...scales)

  console.log(`   ${key}  kind=${r.kind}  det=${det.toFixed(6)}  ambiguous=${r.ambiguous}`)
  console.log(
    `      源 ${source.x}×${source.y}×${source.z} mm  →  契约坐标 ${rotated.x.toFixed(3)}×${rotated.y.toFixed(3)}×${rotated.z.toFixed(3)} mm`,
  )
  console.log(`      声明 size ${contract.x * 1000}×${contract.y * 1000}×${contract.z * 1000} mm  ⇒  aspectDrift = ${drift.toFixed(4)}`)
  check(Math.abs(det - 1) < 1e-9, `${key} 不是反射`)
  check(drift < 1.15, `${key} 长宽比偏差 ${drift.toFixed(4)} < 1.15（不触发告警）`)
}

// ── ④ 人工覆盖（`HardwareModel.orientation`）────────────────────────────
console.log('\n④ 人工覆盖：24 种合法组合，det 必须全是 +1\n')
const AXES = ['+x', '-x', '+y', '-y', '+z', '-z'] as const
type Axis = (typeof AXES)[number]
const idx = (a: Axis) => (a[1] === 'x' ? 0 : a[1] === 'y' ? 1 : 2)
let combos = 0
let bad = 0
for (const up of AXES) {
  for (const length of AXES) {
    if (idx(up) === idx(length)) continue // 同轴 = 非法，另测
    combos++
    const r = orientToContract({ x: 30, y: 20, z: 10 }, { up, length })
    const det = r.matrix.determinant()
    if (!(Math.abs(det - 1) < 1e-9) || r.invalidOverride) bad++
  }
}
check(bad === 0, `${combos} 种合法组合，全部 det=+1 且未被判无效${bad ? `（${bad} 个不合格）` : ''}`)

console.log('\n   带符号的覆盖：符号必须真的生效（"板子朝哪面"就靠它）\n')
{
  // up='-z' 意思是"源模型的 −z 方向朝上" ⇒ M·(0,0,−1) 必须 = (0,1,0)
  const r = orientToContract({ x: 30, y: 20, z: 10 }, { up: '-z', length: '-x' })
  const upVec = new (await import('three')).Vector3(0, 0, -1).applyMatrix4(r.matrix)
  const lenVec = new (await import('three')).Vector3(-1, 0, 0).applyMatrix4(r.matrix)
  check(
    Math.abs(upVec.x) < 1e-9 && Math.abs(upVec.y - 1) < 1e-9 && Math.abs(upVec.z) < 1e-9,
    `up='-z' ⇒ 源的 −z 映到 +y   实得 (${upVec.x}, ${upVec.y}, ${upVec.z})`,
  )
  check(
    Math.abs(lenVec.x - 1) < 1e-9 && Math.abs(lenVec.y) < 1e-9 && Math.abs(lenVec.z) < 1e-9,
    `length='-x' ⇒ 源的 −x 映到 +x   实得 (${lenVec.x}, ${lenVec.y}, ${lenVec.z})`,
  )
}

console.log('\n   非法覆盖（up 与 length 同轴）——必须**退回自动规则**，不能产出退化矩阵\n')
{
  const r = orientToContract({ x: 30, y: 20, z: 10 }, { up: '+z', length: '+z' })
  const det = r.matrix.determinant()
  check(r.invalidOverride !== undefined, `报出了 invalidOverride`)
  check(Math.abs(det - 1) < 1e-9, `仍是合法旋转 det=${det.toFixed(6)}（不是 det=0 的坍塌）`)
  check(r.kind === 'z-up', `退回了自动规则（kind=${r.kind}）`)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}\n`)
process.exit(failures === 0 ? 0 : 1)
