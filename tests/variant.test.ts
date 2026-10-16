/**
 * 从 PlatformIO 权威文件推导引脚表 —— 解析器与发现链。
 *
 * ★ 测试**不依赖本机装没装 PlatformIO**：用假 io + 夹具目录树。
 *   本机真实链路的验证是另一回事（那是"能不能用"），
 *   这里验的是"逻辑对不对"（那是"是不是一直对"）。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  draftForBoard,
  findVariantFile,
  listBoards,
  parseBoardJson,
  parsePinsArduino,
  platformioRoots,
  VARIANT_GAPS,
  type VariantIo,
} from '../src/core/models/variant.ts'

/* ─────────────────── 解析 pins_arduino.h ─────────────────── */

const SAMPLE = `
#ifndef Pins_Arduino_h
#define Pins_Arduino_h

#define USB_VID 0x303A
#define USB_PID 0x1001

static const uint8_t TX = 1;
static const uint8_t RX = 3;
static const uint8_t SDA = 21;
static const uint8_t SCL = 22;
static const uint8_t SS    = 5;    // 片选
#define LED_BUILTIN 2
#define NOT_A_PIN -1
#define ALIAS SDA
`

test('解析两种写法：static const uint8_t 与 #define', () => {
  const pins = parsePinsArduino(SAMPLE)
  const byName = new Map(pins.map((pin) => [pin.name, pin.gpio]))
  assert.equal(byName.get('TX'), 1)
  assert.equal(byName.get('SDA'), 21)
  assert.equal(byName.get('SCL'), 22)
  assert.equal(byName.get('SS'), 5) // 行尾注释不影响
  assert.equal(byName.get('LED_BUILTIN'), 2)
})

test('★ 非引脚宏必须跳过（头文件哨兵 / USB 描述符 / 负号 / 别名）', () => {
  const pins = parsePinsArduino(SAMPLE)
  const names = pins.map((pin) => pin.name)
  assert.ok(!names.includes('Pins_Arduino_h'), '头文件哨兵不该被当引脚')
  assert.ok(!names.includes('USB_VID'), 'USB 描述符不该被当引脚')
  assert.ok(!names.includes('USB_PID'))
  assert.ok(!names.includes('NOT_A_PIN'), '负数不该被当引脚')
  assert.ok(!names.includes('ALIAS'), '别名（非数字）不该被当引脚 —— 宁缺勿错')
})

test('★ 输出按 GPIO 号排序（同一份文件每次产出一样，草稿才好读）', () => {
  const pins = parsePinsArduino(SAMPLE)
  const gpios = pins.map((pin) => pin.gpio)
  assert.deepEqual(gpios, [...gpios].sort((a, b) => a - b))
})

test('空文件 / 没有引脚 ⇒ 空数组（由调用方判"解析不出东西"）', () => {
  assert.deepEqual(parsePinsArduino('#ifndef X\n#endif\n'), [])
})

/* ─────────────────── 解析 board json ─────────────────── */

test('board json：取 name / mcu / variant', () => {
  const info = parseBoardJson('esp32dev', JSON.stringify({ name: 'Espressif ESP32 Dev Module', build: { mcu: 'esp32', variant: 'esp32' } }))
  assert.equal(info?.id, 'esp32dev')
  assert.equal(info?.name, 'Espressif ESP32 Dev Module')
  assert.equal(info?.mcu, 'esp32')
  assert.equal(info?.variant, 'esp32')
})

test('board json：坏 JSON ⇒ undefined（不抛，由调用方跳过这一个）', () => {
  assert.equal(parseBoardJson('broken', '{ not json'), undefined)
  assert.equal(parseBoardJson('arr', '[]'), undefined)
})

/* ─────────────────── 候选根目录（用户路径优先） ─────────────────── */

test('★ 根目录按用户路径优先：env 在最前，且去重', () => {
  const roots = platformioRoots({ PLATFORMIO_CORE_DIR: 'D:\\pio', USERPROFILE: 'C:\\Users\\x' }, 'C:\\Users\\x')
  assert.equal(roots[0], 'D:\\pio', '环境变量必须最优先')
  assert.equal(new Set(roots).size, roots.length, '不能有重复')
  assert.ok(roots.some((root) => root.includes('.platformio')), '要包含惯例路径')
})

test('没有 env 时仍然给出惯例路径（不依赖某个环境变量）', () => {
  const roots = platformioRoots({}, '/home/u')
  assert.ok(roots.some((root) => root === '/home/u/.platformio'))
})

/* ─────────────────── 发现链（假 io + 夹具树） ─────────────────── */

/** 造一棵假的 PlatformIO 树。 */
function fakeIo(files: Record<string, string>, dirs: Record<string, string[]>): VariantIo {
  return {
    listDirs: async (dir) => {
      const entry = dirs[dir]
      if (entry === undefined) throw new Error(`ENOENT ${dir}`)
      return entry
    },
    listFiles: async (dir) => {
      const entry = dirs[dir]
      if (entry === undefined) throw new Error(`ENOENT ${dir}`)
      return entry
    },
    readText: async (file) => {
      const entry = files[file]
      if (entry === undefined) throw new Error(`ENOENT ${file}`)
      return entry
    },
    exists: async (candidate) => files[candidate] !== undefined,
    join: (...parts) => parts.join('/'),
  }
}

const ROOT = '/pio'
const TREE = fakeIo(
  {
    [`${ROOT}/platforms/espressif32/boards/esp32dev.json`]: JSON.stringify({
      name: 'Espressif ESP32 Dev Module',
      build: { mcu: 'esp32', variant: 'esp32' },
    }),
    [`${ROOT}/platforms/espressif32/boards/no_variant.json`]: JSON.stringify({ name: '无 variant 板', build: {} }),
    [`${ROOT}/packages/framework-arduinoespressif32/variants/esp32/pins_arduino.h`]: SAMPLE,
  },
  {
    [`${ROOT}/platforms`]: ['espressif32'],
    [`${ROOT}/platforms/espressif32/boards`]: ['esp32dev.json', 'no_variant.json'],
    [`${ROOT}/packages`]: ['framework-arduinoespressif32', 'tool-esptoolpy'],
  },
)

test('listBoards：扫出板子（多个 platform 都扫）', async () => {
  const { boards, platforms } = await listBoards([ROOT], TREE)
  assert.deepEqual(platforms, ['espressif32'])
  assert.deepEqual(boards.map((b) => b.id).sort(), ['esp32dev', 'no_variant'])
})

test('findVariantFile：只在 framework-arduino* 包里找', async () => {
  assert.equal(await findVariantFile([ROOT], 'esp32', TREE), `${ROOT}/packages/framework-arduinoespressif32/variants/esp32/pins_arduino.h`)
  assert.equal(await findVariantFile([ROOT], 'nope', TREE), undefined)
})

test('★ draftForBoard：成功路径带**出处**与**缺口清单**', async () => {
  const result = await draftForBoard([ROOT], 'esp32dev', TREE)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.draft.board.name, 'Espressif ESP32 Dev Module')
  assert.match(result.draft.source, /pins_arduino\.h$/, '必须给出来源文件')
  assert.ok(result.draft.pins.some((pin) => pin.name === 'SDA' && pin.gpio === 21))
  // ★ 缺口必须**每次都给**（漏给一次就会有人把草稿当成品）
  assert.equal(result.draft.gaps.length, VARIANT_GAPS.length)
  assert.ok(result.draft.gaps.some((gap) => gap.includes('物理排布')))
  assert.ok(result.draft.gaps.some((gap) => gap.includes('电气语义')))
})

test('★ draftForBoard：找不到就说清**为什么**（不返回空表让人猜）', async () => {
  const noRoots = await draftForBoard(['/nope'], 'esp32dev', TREE)
  assert.equal(noRoots.ok, false)
  if (!noRoots.ok) assert.match(noRoots.reason, /没找到 PlatformIO/)

  const unknown = await draftForBoard([ROOT], 'not-a-board', TREE)
  assert.equal(unknown.ok, false)
  if (!unknown.ok) assert.match(unknown.reason, /没有这块板子/)

  const noVariant = await draftForBoard([ROOT], 'no_variant', TREE)
  assert.equal(noVariant.ok, false)
  if (!noVariant.ok) assert.match(noVariant.reason, /没有 build\.variant/)

  // ★ 夹具要"板子能读出来、但 variant 文件不在" —— 只给目录不给 pins 文件
  const missingFile = await draftForBoard(
    [ROOT],
    'esp32dev',
    fakeIo(
      {
        [`${ROOT}/platforms/espressif32/boards/esp32dev.json`]: JSON.stringify({
          name: 'Espressif ESP32 Dev Module',
          build: { mcu: 'esp32', variant: 'esp32' },
        }),
      },
      {
        [`${ROOT}/platforms`]: ['espressif32'],
        [`${ROOT}/platforms/espressif32/boards`]: ['esp32dev.json'],
        [`${ROOT}/packages`]: [],
      },
    ),
  )
  assert.equal(missingFile.ok, false)
  if (!missingFile.ok) assert.match(missingFile.reason, /找不到 variant/)
})
