/**
 * **从 Espressif 官方文档源码提取 DevKit 排针表 → 生成型号定义**（P0.4 的第二条来源）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么需要它（PlatformIO variant 不够用）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `pins_arduino.h` 只给**别名 ↔ GPIO**，**没有**：
 *   · 物理脚位（哪个脚在排针的哪个位置）
 *   · 丝印（板上印的字）
 *   · 电气类型（电源 / 地 / 输入 / 双向）
 *
 * 而 Espressif 的官方 devkit 文档（`espressif/esp-dev-kits` 仓的 `.rst`）**三样都有**：
 *
 * ```
 * No.  Name  Type    Function
 * 1    3V3   P       3.3 V power supply
 * 4    4     I/O/T   RTC_GPIO4, GPIO4, TOUCH4, ADC1_CH3
 * 21   5V    P       5 V power supply
 * 22   G     G       Ground
 * ```
 *
 * ★★ **机械提取，不手抄**：44 个脚抄错一个就是"看起来对但接错脚"，而没人能发现。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 它**仍然给不出**外形尺寸（这一版如实标注，不编）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 实测：官方尺寸只有 DXF/PDF（`dl.espressif.com`），DXF 里外形不是 LINE/LWPOLYLINE
 * （解析不出），产品页 403。⇒ 本工具用**排针几何推算**尺寸，并在定义的 `_source.note`
 * 里**写明这是推算值**；拿到官方数字请替换。
 *
 * 用法：
 *   node tools/extract-devkit-header.mjs <user_guide.rst> <boardId> [模型键] > out.json
 */

import { readFileSync } from 'node:fs'

const rstPath = process.argv[2]
const boardId = process.argv[3]
const modelKey = process.argv[4] ?? boardId
if (rstPath === undefined || boardId === undefined) {
  console.error('用法：node tools/extract-devkit-header.mjs <user_guide.rst> <boardId> [模型键]')
  process.exit(2)
}

const lines = readFileSync(rstPath, 'utf8').split(/\r?\n/)

/** 解析所有 `J<n>` 标题后面的 grid table。 */
function parseHeaderTables() {
  const tables = []
  for (let i = 0; i < lines.length; i += 1) {
    const title = (lines[i] ?? '').trim()
    if (!/^J[0-9]+$/.test(title)) continue
    let j = i
    while (j < lines.length && !/^\s*No\.\s/.test(lines[j] ?? '')) j += 1
    // ★ 表头下面紧跟一条 `===` 分隔线，必须先跳过（否则行循环在第一个分隔线就 break）
    let k = j + 1
    while (k < lines.length && /^\s*===/.test(lines[k] ?? '')) k += 1
    const rows = []
    for (; k < lines.length; k += 1) {
      const line = lines[k] ?? ''
      if (/^\s*===/.test(line) || line.trim() === '') break
      const cells = line.trim().split(/\s{2,}/)
      if (cells.length < 3 || !/^\d+$/.test(cells[0] ?? '')) continue
      rows.push({ pin: Number(cells[0]), silk: cells[1] ?? '', type: cells[2] ?? '', funcs: cells.slice(3).join(' ') })
    }
    tables.push({ name: title, rows })
  }
  return tables
}

const tables = parseHeaderTables()
const allRows = tables.flatMap((table) => table.rows)
if (allRows.length === 0) {
  console.error('没解析出任何排针行 —— 文档格式可能变了（预期是 `No. Name Type Function` 的 grid table）')
  process.exit(1)
}

/** 电气类型 → 我们契约里的 protocol / voltage / direction。 */
function electrical(type, silk, funcs) {
  if (type === 'P') {
    // 电源脚：3V3 → 3.3V 只出；5V → 5V 只出
    return { protocol: 'power', voltage: silk.startsWith('5') ? 5 : 3.3, direction: 'power' }
  }
  if (type === 'G') return { protocol: 'power', voltage: 0, direction: 'ground' }
  if (type === 'I') return { protocol: 'gpio', voltage: 3.3, direction: 'in' }
  return { protocol: 'gpio', voltage: 3.3, direction: 'io' }
}

/** 从 Function 列里取 GPIO 号（`RTC_GPIO4, GPIO4, ...` → 4）。 */
function gpioOf(funcs) {
  const m = /\bGPIO(\d+)\b/.exec(funcs)
  return m === null ? undefined : Number(m[1])
}

// ── 排针几何：每排 22 脚、2.54mm 间距；两排间距按 0.1" 双排惯例 22.86mm ──
const PITCH = 0.00254
const ROW_GAP = 0.02286
const perHeader = Math.max(...tables.map((table) => table.rows.length))
const lengthM = PITCH * (perHeader - 1)

const ports = []
for (const [tableIndex, table] of tables.entries()) {
  // 第一排贴 -x 边，第二排贴 +x 边
  const x = tableIndex === 0 ? -ROW_GAP / 2 : ROW_GAP / 2
  for (const row of table.rows) {
    const elec = electrical(row.type, row.silk, row.funcs)
    const gpio = gpioOf(row.funcs)
    // ★ portId 用**脚位**（P1…P22 每排）—— 身份必须唯一；丝印可能重复（多个 GND）
    const portId = `${table.name}P${String(row.pin)}`
    // 丝印 + GPIO：人看丝印，agent 看 GPIO
    const name = gpio === undefined ? row.silk : `${row.silk} · GPIO${String(gpio)}`
    ports.push({
      portId,
      name,
      protocol: elec.protocol,
      voltage: elec.voltage,
      direction: elec.direction,
      // 沿 z 居中排布（排针在板子长边）
      position: { x, y: 0.003, z: -lengthM / 2 + PITCH * (row.pin - 1) },
    })
  }
}

const definition = {
  _source: {
    kind: 'espressif-official-docs',
    boardId,
    file: rstPath,
    extractedAt: new Date().toISOString(),
    note:
      '排针表（脚位/丝印/电气类型/GPIO）由官方文档 .rst **机械提取**。' +
      '⚠️ size 是**按排针几何推算**的（每排 22 脚 × 2.54mm；两排间距 22.86mm；高度估 10mm），' +
      '**不是官方外形尺寸** —— 官方只有 DXF/PDF，本机取不到（DXF 解析不出外形、产品页 403）。' +
      '拿到官方尺寸请替换 size。',
  },
  key: modelKey,
  label: `Espressif ${boardId}`,
  size: { x: ROW_GAP, y: 0.01, z: lengthM },
  powerDrawW: 0,
  powerSupplyW: 0,
  ports,
}

process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`)
console.error(`已生成：${String(ports.length)} 个端口（${tables.map((t) => `${t.name}=${String(t.rows.length)}`).join(', ')}）`)
