/**
 * SVG path → ASCII raster，只为回答一个问题：**它到底画出了什么？**
 *
 * 为什么需要它：SVG path 的错误是**静默**的 —— 语法错、子路径跑到形体外面、
 * evenodd 数错交叉次数，浏览器都不会报错，只是**画出来不对**（或什么都不画）。
 * 而 `tsc` 通过、`npm run build:client` 通过、`dev_reload_package` 回 `client ✓`
 * 全都发生在**近端**，没有一个能看见远端。
 *
 * 支持：M/L/H/V/C/S/Q/T/A/Z 绝对+相对。够用了（本图标只用 M/C/A/Z）。
 * 渲染：evenodd 交叉计数（跨**全部**子路径统一计数，这正是 evenodd 的定义）。
 *
 * 用法：node spike/svg-ascii.mjs [size]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const HUD = path.resolve(here, '../src/client/hud.ts')

// ── 1. 从 hud.ts 里抓出 d 字符串（跟着源码走，不复制一份） ──────────────
const src = fs.readFileSync(HUD, 'utf8')
const i = src.indexOf("fillRule: 'evenodd'")
if (i < 0) throw new Error('没找到 fillRule: evenodd —— hud.ts 结构变了')
const j = src.indexOf('d:', i)
const k = src.indexOf('}),', j)
const D = [...src.slice(j, k).matchAll(/'([^']*)'/g)].map((m) => m[1]).join('')
if (!D.startsWith('M')) throw new Error(`d 抓取失败：${JSON.stringify(D.slice(0, 40))}`)

// ── 2. tokenize ────────────────────────────────────────────────────────
const ARGS = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 }
const toks = []
for (const m of D.matchAll(/([MmLlHhVvCcSsQqTtAaZz])|(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g)) {
  if (m[1]) toks.push({ c: m[1] })
  else toks.push({ n: parseFloat(m[2]) })
}

// ── 3. 椭圆弧端点参数化 → 中心参数化（W3C 附录 F.6.5） ──────────────────
function arc(x0, y0, rx, ry, phiDeg, large, sweep, x1, y1, seg = 64) {
  rx = Math.abs(rx)
  ry = Math.abs(ry)
  if (rx === 0 || ry === 0) return [[x1, y1]]
  const phi = (phiDeg * Math.PI) / 180
  const cp = Math.cos(phi)
  const sp = Math.sin(phi)
  const dx = (x0 - x1) / 2
  const dy = (y0 - y1) / 2
  const xp = cp * dx + sp * dy
  const yp = -sp * dx + cp * dy
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry)
  if (lam > 1) {
    const s = Math.sqrt(lam)
    rx *= s
    ry *= s
  }
  const den = rx * rx * yp * yp + ry * ry * xp * xp
  const num = rx * rx * ry * ry - den
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den))
  if (large === sweep) co = -co
  const cxp = (co * rx * yp) / ry
  const cyp = (-co * ry * xp) / rx
  const cx = cp * cxp - sp * cyp + (x0 + x1) / 2
  const cy = sp * cxp + cp * cyp + (y0 + y1) / 2
  const ang = (ux, uy, vx, vy) => {
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy)
    let a = Math.acos(Math.min(1, Math.max(-1, (ux * vx + uy * vy) / (len || 1))))
    if (ux * vy - uy * vx < 0) a = -a
    return a
  }
  const ux = (xp - cxp) / rx
  const uy = (yp - cyp) / ry
  const vx = (-xp - cxp) / rx
  const vy = (-yp - cyp) / ry
  const t0 = ang(1, 0, ux, uy)
  let dt = ang(ux, uy, vx, vy)
  if (!sweep && dt > 0) dt -= 2 * Math.PI
  if (sweep && dt < 0) dt += 2 * Math.PI
  const out = []
  for (let s = 1; s <= seg; s++) {
    const t = t0 + (dt * s) / seg
    const ex = rx * Math.cos(t)
    const ey = ry * Math.sin(t)
    out.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy])
  }
  return out
}

// ── 4. 展开成子路径多边形 ──────────────────────────────────────────────
const subs = []
let cur = null
let x = 0
let y = 0
let sx = 0
let sy = 0
let prevC = null
let prevQ = null
let p = 0
let cmd = null
while (p < toks.length) {
  if (toks[p].c) {
    cmd = toks[p].c
    p++
    if (cmd === 'Z' || cmd === 'z') {
      if (cur) {
        cur.push([sx, sy])
        subs.push(cur)
        cur = null
      }
      x = sx
      y = sy
      continue
    }
  }
  const rel = cmd === cmd.toLowerCase()
  const C = cmd.toUpperCase()
  const need = ARGS[C]
  const a = []
  for (let q = 0; q < need; q++) a.push(toks[p++].n)
  const ox = rel ? x : 0
  const oy = rel ? y : 0
  let nx = x
  let ny = y
  let pts = []
  if (C === 'M') {
    if (cur) subs.push(cur)
    nx = ox + a[0]
    ny = oy + a[1]
    cur = [[nx, ny]]
    sx = nx
    sy = ny
    cmd = rel ? 'l' : 'L' // 后续隐式 lineto
  } else if (C === 'L') {
    nx = ox + a[0]
    ny = oy + a[1]
    pts = [[nx, ny]]
  } else if (C === 'H') {
    nx = ox + a[0]
    pts = [[nx, ny]]
  } else if (C === 'V') {
    ny = oy + a[0]
    pts = [[nx, ny]]
  } else if (C === 'C' || C === 'S') {
    let c1x, c1y, c2x, c2y
    if (C === 'C') {
      c1x = ox + a[0]
      c1y = oy + a[1]
      c2x = ox + a[2]
      c2y = oy + a[3]
      nx = ox + a[4]
      ny = oy + a[5]
    } else {
      c1x = prevC ? 2 * x - prevC[0] : x
      c1y = prevC ? 2 * y - prevC[1] : y
      c2x = ox + a[0]
      c2y = oy + a[1]
      nx = ox + a[2]
      ny = oy + a[3]
    }
    prevC = [c2x, c2y]
    for (let s = 1; s <= 32; s++) {
      const t = s / 32
      const u = 1 - t
      pts.push([
        u * u * u * x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * nx,
        u * u * u * y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * ny,
      ])
    }
  } else if (C === 'A') {
    pts = arc(x, y, a[0], a[1], a[2], a[3] ? 1 : 0, a[4] ? 1 : 0, ox + a[5], oy + a[6])
    nx = ox + a[5]
    ny = oy + a[6]
  } else {
    throw new Error(`未实现的命令 ${cmd}`)
  }
  if (C !== 'C' && C !== 'S') prevC = null
  if (C !== 'Q' && C !== 'T') prevQ = null
  if (cur && pts.length) cur.push(...pts)
  x = nx
  y = ny
}
if (cur) subs.push(cur)

// ── 5. evenodd 判定：对**全部**子路径统一数交叉（这就是 evenodd 的定义）──
const edges = []
for (const s of subs) {
  for (let q = 0; q + 1 < s.length; q++) edges.push([s[q][0], s[q][1], s[q + 1][0], s[q + 1][1]])
}
function filled(px, py) {
  let c = 0
  for (const [x1, y1, x2, y2] of edges) {
    if (y1 > py !== y2 > py) {
      const xi = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)
      if (px < xi) c++
    }
  }
  return (c & 1) === 1
}

// ── 6. 输出 ────────────────────────────────────────────────────────────
console.log(`子路径 ${subs.length} 个：`)
subs.forEach((s, n) => {
  const xs = s.map((q) => q[0])
  const ys = s.map((q) => q[1])
  console.log(
    `  [${n}] 点${String(s.length).padStart(3)}  包围盒 x[${Math.min(...xs).toFixed(2)},${Math.max(...xs).toFixed(2)}] y[${Math.min(...ys).toFixed(2)},${Math.max(...ys).toFixed(2)}]`,
  )
})

/** 判定「子路径 n 是否完整落在形体轮廓内」——这是负空间能否成立的前提。 */
console.log('\n各子路径相对【子路径 0（身体）】的内外关系：')
const bodyEdges = []
for (let q = 0; q + 1 < subs[0].length; q++)
  bodyEdges.push([subs[0][q][0], subs[0][q][1], subs[0][q + 1][0], subs[0][q + 1][1]])
const inBody = (px, py) => {
  let c = 0
  for (const [x1, y1, x2, y2] of bodyEdges) {
    if (y1 > py !== y2 > py) {
      const xi = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)
      if (px < xi) c++
    }
  }
  return (c & 1) === 1
}
for (let n = 1; n < subs.length; n++) {
  let out = 0
  let tot = 0
  const s = subs[n]
  for (let q = 0; q + 1 < s.length; q++) {
    for (const t of [0.25, 0.5, 0.75]) {
      const px = s[q][0] + (s[q + 1][0] - s[q][0]) * t
      const py = s[q][1] + (s[q + 1][1] - s[q][1]) * t
      tot++
      if (!inBody(px, py)) out++
    }
  }
  console.log(
    `  [${n}] 边界采样 ${tot} 点，落在身体**外**的 ${out} 点 ${out === 0 ? '✓' : `✗ ← ${((out / tot) * 100).toFixed(1)}% 越界`}`,
  )
}

// 越界部分会怎样？—— 身体外 + 该子路径内 ⇒ 交叉数 1 ⇒ **奇 ⇒ 被填**（不是洞）
console.log('\n★ 若上面有 ✗：越界那一段渲染成【实心块】而不是洞（交叉数 1，奇）。')
console.log('  这就是 evenodd 的坑：**漏在外面的负空间会翻回来变成正空间**。')

// 眼点 [3] 必须落在眼斑 [2] 内，否则它自己会翻成洞
if (subs.length >= 4) {
  const pe = []
  for (let q = 0; q + 1 < subs[2].length; q++)
    pe.push([subs[2][q][0], subs[2][q][1], subs[2][q + 1][0], subs[2][q + 1][1]])
  const inPatch = (px, py) => {
    let c = 0
    for (const [x1, y1, x2, y2] of pe) {
      if (y1 > py !== y2 > py) {
        const xi = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)
        if (px < xi) c++
      }
    }
    return (c & 1) === 1
  }
  let out = 0
  let tot = 0
  const s = subs[3]
  for (let q = 0; q + 1 < s.length; q++)
    for (const t of [0.25, 0.5, 0.75]) {
      tot++
      if (!inPatch(s[q][0] + (s[q + 1][0] - s[q][0]) * t, s[q][1] + (s[q + 1][1] - s[q][1]) * t)) out++
    }
  console.log(
    `\n  [3] 相对【眼斑 [2]】：边界采样 ${tot} 点，落在眼斑**外**的 ${out} 点 ${out === 0 ? '✓' : `✗ ← ${((out / tot) * 100).toFixed(1)}% 越界`}`,
  )
}

// ── 7. 分类渲染：每个像素按"被几个子路径包住"上色 ──────────────────────
// 这才是能看出 evenodd 是否画出预期结构的东西。单纯黑白看不出 1 层和 3 层。
const subEdges = subs.map((s) => {
  const e = []
  for (let q = 0; q + 1 < s.length; q++) e.push([s[q][0], s[q][1], s[q + 1][0], s[q + 1][1]])
  return e
})
function depth(px, py) {
  const hit = []
  subEdges.forEach((e, n) => {
    let c = 0
    for (const [x1, y1, x2, y2] of e) {
      if (y1 > py !== y2 > py) {
        const xi = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1)
        if (px < xi) c++
      }
    }
    if (c & 1) hit.push(n)
  })
  return hit
}

const LEGEND = {
  bodyOnly: '██', // 只在身体里 → 实心
  hole: '··', // 偶数层 → 洞
  dot: '▓▓', // 奇数层但层数≥3 → 被填回来（眼点）
  spill: 'XX', // **不在身体里，却被填** ← 负空间漏出去了
}

function render(size, label) {
  const sx = 24 / size
  const stats = { bodyOnly: 0, hole: 0, dot: 0, spill: 0 }
  const rows = []
  for (let r = 0; r < size; r++) {
    let line = ''
    for (let c = 0; c < size; c++) {
      const px = (c + 0.5) * sx
      const py = (r + 0.5) * sx
      const hit = depth(px, py)
      let k
      if (hit.length === 0) k = null
      else if (hit.length % 2 === 0) k = 'hole'
      else if (!hit.includes(0)) k = 'spill'
      else if (hit.length === 1) k = 'bodyOnly'
      else k = 'dot'
      if (k) stats[k]++
      line += k ? LEGEND[k] : '  '
    }
    rows.push(line)
  }
  const tot = size * size
  console.log(`\n── ${label} ──`)
  console.log(
    `   实心 ${((stats.bodyOnly / tot) * 100).toFixed(1)}%  洞 ${((stats.hole / tot) * 100).toFixed(1)}%  眼点 ${((stats.dot / tot) * 100).toFixed(1)}%` +
      (stats.spill ? `   ★越界被填 ${stats.spill} px (${((stats.spill / tot) * 100).toFixed(1)}%)` : '   越界 0 px ✓'),
  )
  console.log('   ' + '──'.repeat(size))
  rows.forEach((l, r) => {
    console.log(String(r).padStart(2) + ' ' + l)
  })
}

const want = parseInt(process.argv[2] ?? '0', 10)
render(want || 32, want ? `${want}×${want}` : '32×32')
if (!want) render(13, '13×13（真实使用尺寸）')
console.log('\n图例： ██ 实心   ·· 洞   ▓▓ 眼点（洞中之实）   XX 负空间越界被翻成实心')
