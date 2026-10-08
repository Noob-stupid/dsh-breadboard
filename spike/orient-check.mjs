/**
 * 「最长轴→x、最薄轴→y」到底是不是一个**旋转**？
 *
 * 为什么必须问：`Port.position` 是**手写在归一化坐标系里**的，而 GLB 只是外观。
 * 若朝向归一化用**轴置换**实现，而那个置换是**反射**（det = -1），
 * 模型会被**镜像**，而端口不会 —— 板子上左右会反过来，端口落到错误的一侧。
 * 而且**包围盒一模一样**，任何按尺寸做的检查都发现不了。
 *
 * 本脚本枚举立方体的全部 24 个**真旋转**，回答两件事：
 *   ① 6 种尺寸排序里，哪些的"排序后直接指派 x/y/z"是反射；
 *   ② 包围盒排序把朝向**确定到几个解**（剩多少不确定性）。
 */
const AXES = ['x', 'y', 'z']

/** 全部 3x3 带符号置换矩阵中 det = +1 的那些（= 立方体的 24 个真旋转）。 */
function properRotations() {
  const out = []
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ]
  for (const p of perms) {
    for (let sign = 0; sign < 8; sign++) {
      const m = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ]
      for (let row = 0; row < 3; row++) m[row][p[row]] = sign >> row & 1 ? -1 : 1
      // det of a signed permutation = sign(perm) * prod(signs)
      const sgn = (q) => {
        let s = 1
        for (let i = 0; i < 3; i++)
          for (let j = i + 1; j < 3; j++) if (q[i] > q[j]) s = -s
        return s
      }
      const prod = [-1, 1, 1].map((_, r) => (sign >> r & 1 ? -1 : 1)).reduce((a, b) => a * b, 1)
      if (sgn(p) * prod === 1) out.push(m)
    }
  }
  return out
}

/** 矩阵 m 作用在尺寸 d 上，得到的新包围盒尺寸。 */
function applyDims(m, d) {
  const out = [0, 0, 0]
  for (let row = 0; row < 3; row++)
    for (let col = 0; col < 3; col++) if (m[row][col]) out[row] = d[col]
  return out
}

/** 朴素实现：按尺寸排序后**直接指派**到 x/y/z（等价于一个置换矩阵）。 */
function naivePermutation(d) {
  const order = [0, 1, 2].sort((a, b) => d[b] - d[a]) // 长 → 短
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  // order[0](最长) → x(row 0)，order[1](次长) → z(row 2)，order[2](最薄) → y(row 1)
  m[0][order[0]] = 1
  m[2][order[1]] = 1
  m[1][order[2]] = 1
  return m
}

function det3(m) {
  return (
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  )
}

const rots = properRotations()
console.log(`立方体真旋转数：${rots.length}（应为 24）\n`)

// 代表尺寸：用真实模型的近似值，保证排序明确
const SAMPLES = {
  'rpi-4b      (x>z>y，本就合规)': [92.86, 19.89, 58.5],
  'mpl3115a2   (x>y>z)': [19.05, 17.78, 2.6],
  'mpr121      (x>y>z)': [33.02, 19.05, 1.6],
  '假想 y>x>z': [10, 30, 5],
  '假想 z>x>y': [10, 3, 30],
  '假想 z>y>x': [3, 10, 30],
}

console.log('① 朴素"排序后指派"是不是真旋转？')
console.log('   （det = -1 ⇒ 反射 ⇒ 模型被镜像 ⇒ 端口跑到错误的一侧，且包围盒查不出来）\n')
for (const [label, d] of Object.entries(SAMPLES)) {
  const m = naivePermutation(d)
  const det = det3(m)
  const order = [0, 1, 2].sort((a, b) => d[b] - d[a]).map((i) => AXES[i]).join('>')
  console.log(
    `   ${label.padEnd(30)} 排序 ${order.padEnd(6)}  det = ${det > 0 ? '+1 旋转 ✓' : '-1 反射 ✗ 会镜像'}`,
  )
}

console.log('\n② 包围盒排序把朝向确定到什么程度？')
console.log('   （能匹配同一包围盒的**真旋转**有几个 —— 多出来的就是"量不出来的自由度"）\n')
for (const [label, d] of Object.entries(SAMPLES)) {
  const want = applyDims(naivePermutation(d), d) // 目标：new_x 最大、new_z 次之、new_y 最小
  const fits = rots.filter((m) => {
    const nd = applyDims(m, d)
    return nd[0] === want[0] && nd[1] === want[1] && nd[2] === want[2]
  })
  console.log(
    `   ${label.padEnd(30)} 匹配包围盒的真旋转：${fits.length} 个` +
      (fits.length > 1 ? `  ← 其中 ${fits.length - 1} 个量不出来，只能靠约定` : ''),
  )
}
