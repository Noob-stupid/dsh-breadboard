/**
 * **交叉验证：把内置型号的引脚表，与 PlatformIO 权威 variant 对照。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 这个脚本回答一个很具体的问题
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 内置型号（如 `esp32-seat-sensor`）的引脚表是**手打**的（来源是项目文档）。
 * 而 `pins_arduino.h` 是**编译器实际用的那份映射**。
 * 两者对不上 ⇒ **"看起来对但接错脚"**，而且**没人能发现**。
 * ⇒ 所以要用权威来源照一次 —— 这个脚本就是那次"照"。
 *
 * ## 用法
 * ```
 * node tools/crosscheck-model-pins.mjs <型号键> <pins_arduino.h 路径>
 * node tools/crosscheck-model-pins.mjs esp32-seat-sensor \
 *   "C:/.platformio/packages/framework-arduinoespressif32/variants/doitESP32devkitV1/pins_arduino.h"
 * ```
 *
 * ★ 路径**由调用方给**（不写死本机路径）—— 换台机器/换块板子都能用。
 * ★ 它只**报告**，不改任何东西：判定要不要改模型，由人决定。
 */

import { readFileSync } from 'node:fs'

import { HARDWARE_MODELS } from '../src/contracts/library.ts'
import { parsePinsArduino } from '../src/core/models/variant.ts'

const modelKey = process.argv[2]
const variantPath = process.argv[3]
const boardId = process.argv[4]
if (modelKey === undefined || variantPath === undefined || boardId === undefined) {
  console.error(
    '用法：node tools/crosscheck-model-pins.mjs <型号键> <pins_arduino.h 路径> <board id>\n' +
      '  ★ 第 3 个参数是**必须的**：它声明"这个型号就是这块板子"。\n' +
      '    别名表是**芯片专属**的 —— 拿 ESP32 的 variant 对树莓派模型，\n' +
      '    会报出"MOSI 从 GPIO23 变 GPIO10"这种**纯属胡说**的结论（实测过）。\n' +
      '  例：node tools/crosscheck-model-pins.mjs esp32-seat-sensor \\\n' +
      '        "C:/.platformio/packages/framework-arduinoespressif32/variants/doitESP32devkitV1/pins_arduino.h" \\\n' +
      '        esp32doit-devkit-v1',
  )
  process.exit(2)
}

const model = HARDWARE_MODELS[modelKey]
if (model === undefined) {
  console.error(`没有这个型号键：${modelKey}（可用：${Object.keys(HARDWARE_MODELS).join(', ')}）`)
  process.exit(2)
}

const authoritative = parsePinsArduino(readFileSync(variantPath, 'utf8'))
const gpiosInVariant = new Set(authoritative.map((pin) => pin.gpio))
console.log(`权威 variant：${authoritative.length} 条名字↔GPIO，覆盖 ${gpiosInVariant.size} 个 GPIO`)
console.log(`型号 ${modelKey}：${model.ports.length} 个端口`)
console.log(`★ 本次对照**假设** ${modelKey} 就是 ${boardId}（由调用方声明，脚本无法自己知道）\n`)

// ══════════════════════════════════════════════════════════════════════════
// ★★★ 这个对照**只能验一件事**：GPIO 编号对不对。
//      它**验不了"引脚表全不全"** —— 这一点我踩了两次，都记在这里：
// ══════════════════════════════════════════════════════════════════════════
//
// ⚠️ `pins_arduino.h` 是**芯片的别名表**（`A0`/`T1`/`SDA`… → GPIO），
//    **不是这块板子的排针清单**。所以：
//
//   ✗ 错法一（第一版）："模型有、variant 没有" ⇒ 判成不一致
//      → 实测把 GPIO16/17 判成错，而 **DOIT DevKit V1 排针上确实有这两个脚**
//      → 照它去改，就会**删掉真实的引脚** —— 正是这个检查本来要防的事故。
//
//   ✗ 错法二（第二版）："variant 有、模型没有" ⇒ 判成"模型缺脚"
//      → 实测报出 GPIO15，但 variant 说的是"**芯片**能被寻址"，不是"**排针**引出了"
//      → 同样是假警报。
//
//   ✅ 对法（本版）：**只对双方都出现的"别名"比 GPIO 号**。
//      · 模型里写了 `SDA`/`MOSI` 这类**别名**的端口 ⇒ 拿 variant 的同名别名比号；
//        号对不上 = **真 bug**（丝印与 GPIO 不符，接线会接错脚）。
//      · 覆盖不到的（型号自带丝印、电源脚、排针专属脚）⇒ 只列为**待人工确认**。
//
//   ⇒ 一句话：**它是一致性检查，不是完整性检查。**

/** variant 的别名 → GPIO。 */
const variantByName = new Map(authoritative.map((pin) => [pin.name, pin.gpio]))

/** 模型里出现的 GPIO 号（从丝印 `GPIO23 · VSPI_MOSI` 里取）。 */
const modelGpios = new Map()
const notGpio = []
for (const port of model.ports) {
  const match = /GPIO(\d+)/.exec(port.name)
  if (match === null) {
    notGpio.push(`${port.portId} = ${port.name}`)
    continue
  }
  modelGpios.set(Number(match[1]), port.portId)
}

/** ① 别名一致性：模型丝印里出现 variant 已知的别名 ⇒ 号必须一致。 */
const aliasChecked = []
const aliasMismatch = []
for (const port of model.ports) {
  // 丝印形如 `GPIO23 · VSPI_MOSI` / `SDA` / `A4` —— 逐个 token 找别名
  const tokens = port.name.split(/[·\s]+/).filter((token) => token !== '')
  const modelGpio = /GPIO(\d+)/.exec(port.name)?.[1]
  for (const token of tokens) {
    const known = variantByName.get(token)
    if (known === undefined) continue
    if (modelGpio === undefined) continue
    const expected = Number(modelGpio)
    aliasChecked.push(`${port.portId} ${token}`)
    if (known !== expected) {
      aliasMismatch.push(`${port.portId}：丝印说 ${token} = GPIO${expected}，而权威 variant 说 ${token} = GPIO${known}`)
    }
    break // 一个端口只比第一个命中的别名
  }
}

console.log(`① 别名一致性（**唯一能验的**）：比了 ${aliasChecked.length} 个共有别名`)
console.log(`   ✅ 一致：${aliasChecked.length - aliasMismatch.length}`)
console.log(`   ❌ 不一致：${aliasMismatch.length}`)
for (const line of aliasMismatch) console.log(`      ${line}`)
if (aliasMismatch.length === 0 && aliasChecked.length > 0) {
  console.log(`   ⇒ 模型里那些带别名的引脚，GPIO 号与**编译器实际用的映射**一致。`)
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ 跨芯片守卫：别名表是**芯片专属**的
// ══════════════════════════════════════════════════════════════════════════
//
// 实测：拿 **ESP32** 的 variant 去对 **树莓派** 模型，会报
//   「P19 丝印说 MOSI = GPIO10，权威 variant 说 MOSI = GPIO23」
// —— 这不是 bug，是**两个不同芯片的同名信号**。照它去"修"就会改坏模型。
// ⇒ 不一致占多数时，最可能的原因是**对错了芯片**，而不是模型全错。
const wrongChipSuspected = aliasChecked.length >= 2 && aliasMismatch.length * 2 > aliasChecked.length
if (wrongChipSuspected) {
  console.log(
    `\n⚠️⚠️ **看起来这不是同一颗芯片**：${String(aliasMismatch.length)}/${String(aliasChecked.length)} 个共有别名都不一致。\n` +
      '   别名表是芯片专属的（MOSI 在 ESP32 是 GPIO23、在树莓派是 GPIO10）\n' +
      `   ⇒ 先确认 ${modelKey} 到底是不是 ${boardId}，**不要照着这些"不一致"去改模型**。`,
  )
}

/** ② 覆盖不到的：只列出来，**不作判定**。 */
const uncovered = [...modelGpios.entries()]
  .filter(([gpio]) => !authoritative.some((pin) => pin.gpio === gpio))
  .sort((a, b) => a[0] - b[0])
  .map(([gpio, portId]) => `${portId} = GPIO${gpio}`)

console.log(`\n② variant 覆盖不到（**不作判定**）：${uncovered.length}`)
for (const line of uncovered) console.log(`      ${line}`)
console.log(`   ⇒ variant 是芯片别名表、不是排针清单 ⇒ 这些要按**板子的机械图/官方 pinout** 确认。`)
console.log(`   ⚠️ **不要**因为"variant 里没有"就删模型里的脚（GPIO16/17 就是这种）。`)

console.log(`\n非 GPIO 端口（电源/地/使能，variant 本来就不含）：${notGpio.length}`)
for (const line of notGpio) console.log(`      ${line}`)

// ★ 退出码只对**①**非 0：那是真 bug（丝印与 GPIO 不符 ⇒ 接线会接错脚）
process.exit(aliasMismatch.length === 0 ? 0 : 1)
