/**
 * **从 PlatformIO 的权威文件推导引脚表**（P0.4）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么走这条路（而不是"网上搜一份 pinout 图"）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 权威链是现成的、而且**就在编译器实际使用的那一层**：
 *
 * ```
 * platforms/<platform>/boards/<board>.json   →  build.variant = "esp32"
 *                                            →  build.mcu / name（板子的人话名字）
 * packages/framework-arduinoespressif32/variants/<variant>/pins_arduino.h
 *                                            →  static const uint8_t SDA = 21;
 * ```
 *
 * `pins_arduino.h` **就是编译器用来把 `SDA` 翻译成 GPIO21 的那份文件** ——
 * 比网上任何 pinout 图都硬（同一块板不同 revision / 封装、丝印相同但映射不同，
 * 照图写出来的定义**看起来对、接错脚**）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 它**给不出**什么（这决定了产出是"草稿"而不是"成品"）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 它给得出 | 它给不出 |
 * |---|---|
 * | **引脚名 ↔ GPIO 号**（`SDA = 21`）| **物理排布** —— 哪个脚在排针的哪个位置（决定 `portLayout`）|
 * | MCU / 板子名字 / flash 大小 | **电气语义** —— 哪个脚是 5V、哪个要上拉、哪个是 I2C |
 * | 板子 id 列表（242 个）| **丝印与 GPIO 的完整对应**（`SDA` 是功能名，不是丝印）|
 *
 * ⇒ 所以本模块产出的是**草稿 + 缺口清单**，不是能直接装的型号定义。
 *   **缺口必须由人/手册补** —— 这正是"扫描优先、定义兜底"的分界。
 */

/** 从 `pins_arduino.h` 里读出的一条引脚。 */
export interface VariantPin {
  /** 文件里的宏名（`SDA` / `TX` / `GPIO23`）—— 那是**功能名**，不是丝印。 */
  readonly name: string
  /** GPIO 号（该宏解析出来的数值）。 */
  readonly gpio: number
}

/** 从 board json 里读出的板子信息。 */
export interface BoardInfo {
  readonly id: string
  readonly name: string
  readonly mcu?: string
  readonly variant?: string
}

/**
 * 解析 `pins_arduino.h`。
 *
 * ★ 认两种写法（实测两种都存在）：
 *   · `static const uint8_t SDA = 21;`
 *   · `#define SDA 21`
 * ★ 只收**数值型**的：宏里出现表达式、字符串、别的宏名（如 `#define SS 5` 之后
 *   `#define MOSI SS`）都跳过 —— **宁缺勿错**：编不出来的号一旦写进定义，
 *   就是"看起来对但接错脚"。
 */
export function parsePinsArduino(text: string): VariantPin[] {
  const pins = new Map<string, number>()
  const lines = text.split(/\r?\n/)
  for (const line of lines) {
    const trimmed = line.trim()
    // 去掉行尾注释（`SDA = 21;  // I2C`）
    const code = trimmed.replace(/\/\/.*$/, '').trim()

    // 形式①：static const uint8_t NAME = N;
    const decl = /^static\s+const\s+uint8_t\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;/.exec(code)
    if (decl !== null) {
      const name = decl[1] ?? ''
      const value = Number(decl[2])
      if (name !== '' && Number.isInteger(value)) pins.set(name, value)
      continue
    }

    // 形式②：#define NAME N（纯数字）
    const define = /^#define\s+([A-Za-z_][A-Za-z0-9_]*)\s+(\d+)\s*$/.exec(code)
    if (define !== null) {
      const name = define[1] ?? ''
      const value = Number(define[2])
      // ★ 跳过明显的非引脚宏（头文件哨兵、USB 描述符等）
      if (name === '' || /^Pins_Arduino_h$|^USB_|_H$/.test(name)) continue
      if (Number.isInteger(value)) pins.set(name, value)
    }
  }
  // 按 GPIO 号排序：让草稿的阅读顺序稳定（同一份文件每次产出一样）
  return [...pins.entries()]
    .map(([name, gpio]) => ({ name, gpio }))
    .sort((a, b) => (a.gpio === b.gpio ? a.name.localeCompare(b.name) : a.gpio - b.gpio))
}

/** 解析 PlatformIO 的 board json（只取我们需要的字段）。 */
export function parseBoardJson(id: string, text: string): BoardInfo | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined
  // ★ 数组也是 object —— 必须显式排除，否则 `[]` 会被当成一块"没有字段的板子"。
  //   （实测：测试当场抓到这条漏判。）
  if (Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const build = (record.build ?? {}) as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : id
  const mcu = typeof build.mcu === 'string' ? build.mcu : undefined
  const variant = typeof build.variant === 'string' ? build.variant : undefined
  return { id, name, ...(mcu !== undefined ? { mcu } : {}), ...(variant !== undefined ? { variant } : {}) }
}

/**
 * PlatformIO 的**候选根目录**。
 *
 * ★ 按**用户路径**优先，而不是写死本机路径（`C:\.platformio` 只是 Windows 的一种可能）：
 *   环境变量 → 用户主目录 → 平台惯例路径。**换台机器也成立。**
 */
export function platformioRoots(env: Record<string, string | undefined>, home: string): string[] {
  const roots: string[] = []
  const fromEnv = env.PLATFORMIO_CORE_DIR
  if (fromEnv !== undefined && fromEnv !== '') roots.push(fromEnv)
  // Linux/macOS 与 Windows 的默认位置
  roots.push(`${home}/.platformio`)
  if (env.USERPROFILE !== undefined && env.USERPROFILE !== '') roots.push(`${env.USERPROFILE}\\.platformio`)
  // Windows 上另一种常见位置（本机实测就在这里）
  roots.push('C:\\.platformio')
  return [...new Set(roots)]
}

/** 板子 → 引脚表**草稿**（含缺口清单）。 */
export interface BoardPinDraft {
  readonly board: BoardInfo
  /** `pins_arduino.h` 的绝对路径（**出处** —— 必须随草稿一起给用户看）。 */
  readonly source: string
  readonly pins: readonly VariantPin[]
  /**
   * **缺口**（推不出来的部分）。
   * ★ 这一段不是免责声明，是**下一步要做什么**：
   *   不知道物理排布就没法定 `portLayout`；不知道电气语义就没法定 voltage/direction。
   */
  readonly gaps: readonly string[]
}

/* ─────────────────────── 发现（io 注入 ⇒ 可测） ─────────────────────── */

/** 读盘用的最小依赖。 */
export interface VariantIo {
  /** 列目录（不存在应抛）。 */
  readonly listDirs: (dir: string) => Promise<readonly string[]>
  /** 列文件（不存在应抛）。 */
  readonly listFiles: (dir: string) => Promise<readonly string[]>
  readonly readText: (file: string) => Promise<string>
  readonly exists: (path: string) => Promise<boolean>
  readonly join: (...parts: string[]) => string
}

/**
 * 在候选根目录里找**所有** board json。
 *
 * ★ 多个 platform 都要扫（esp32 / stm32 / …），因为"哪块板子在哪"由用户的
 *   PlatformIO 安装决定，我们不该假设只有一种。
 */
export async function listBoards(
  roots: readonly string[],
  io: VariantIo,
): Promise<{ boards: BoardInfo[]; platforms: string[] }> {
  const boards: BoardInfo[] = []
  const platforms: string[] = []
  for (const root of roots) {
    const platformsDir = io.join(root, 'platforms')
    let platformNames: readonly string[]
    try {
      platformNames = await io.listDirs(platformsDir)
    } catch {
      continue // 这个根不存在 —— 正常（用户可能没装 PlatformIO 或装在别处）
    }
    for (const platform of platformNames) {
      const boardsDir = io.join(platformsDir, platform, 'boards')
      let files: readonly string[]
      try {
        files = await io.listFiles(boardsDir)
      } catch {
        continue
      }
      platforms.push(platform)
      for (const file of files) {
        if (!file.endsWith('.json')) continue
        const id = file.replace(/\.json$/, '')
        try {
          const info = parseBoardJson(id, await io.readText(io.join(boardsDir, file)))
          if (info !== undefined) boards.push(info)
        } catch {
          // 单个板子文件读不出来不该让整次列举失败
        }
      }
    }
  }
  // 去重（同一个板子可能在多个根里都有）
  const seen = new Set<string>()
  const unique = boards.filter((board) => (seen.has(board.id) ? false : (seen.add(board.id), true)))
  return { boards: unique, platforms: [...new Set(platforms)] }
}

/** 找某个 variant 的 `pins_arduino.h`（在候选根里逐个找）。 */
export async function findVariantFile(
  roots: readonly string[],
  variant: string,
  io: VariantIo,
): Promise<string | undefined> {
  for (const root of roots) {
    const packagesDir = io.join(root, 'packages')
    let packages: readonly string[]
    try {
      packages = await io.listDirs(packagesDir)
    } catch {
      continue
    }
    for (const pkg of packages) {
      if (!pkg.startsWith('framework-arduino')) continue
      const candidate = io.join(packagesDir, pkg, 'variants', variant, 'pins_arduino.h')
      if (await io.exists(candidate)) return candidate
    }
  }
  return undefined
}

/** 缺口清单 —— ★ 抽成常量是为了**每处都说同样的话**（不然一处漏说就有人以为草稿是成品）。 */
export const VARIANT_GAPS: readonly string[] = [
  '物理排布：variant 只给"名字 ↔ GPIO 号"，**不知道哪个脚在排针的哪个位置** ⇒ `portLayout`（间距/几排/贴哪条边）要另找（板子的机械图/官方 pinout 图）。',
  '电气语义：variant **不含**"哪个脚是 5V / 哪个要上拉 / 哪个是 I2C" ⇒ `voltage`/`direction` 要按数据手册填（本工具给的草稿一律按 3.3V / io 占位）。',
  '丝印：`SDA`/`TX` 是**功能名**，不等于板子上印的字；丝印要以板子实物或官方图为准。',
]

/**
 * 给一块板子生成**引脚表草稿**。
 *
 * ★ 找不到就**说清为什么**（没装 PlatformIO / 板子 id 写错 / variant 缺文件），
 *   而不是返回一个空表让调用方猜。
 */
export async function draftForBoard(
  roots: readonly string[],
  boardId: string,
  io: VariantIo,
): Promise<{ ok: true; draft: BoardPinDraft } | { ok: false; reason: string }> {
  const { boards } = await listBoards(roots, io)
  if (boards.length === 0) {
    return {
      ok: false,
      reason:
        '在这些位置都没找到 PlatformIO 的 platforms/*/boards（可能没装 PlatformIO，或装在别处 —— ' +
        '可用 PLATFORMIO_CORE_DIR 指定）。',
    }
  }
  const board = boards.find((candidate) => candidate.id === boardId)
  if (board === undefined) {
    return { ok: false, reason: `没有这块板子：${boardId}（共找到 ${String(boards.length)} 块，可用 hw_scan_board_pins({list:true}) 看）` }
  }
  if (board.variant === undefined) {
    return { ok: false, reason: `${boardId} 的 board json 里没有 build.variant，无法定位 pins_arduino.h` }
  }
  const source = await findVariantFile(roots, board.variant, io)
  if (source === undefined) {
    return {
      ok: false,
      reason: `找不到 variant "${board.variant}" 的 pins_arduino.h（framework-arduino* 包可能没装）`,
    }
  }
  const pins = parsePinsArduino(await io.readText(source))
  if (pins.length === 0) {
    return { ok: false, reason: `${source} 里没解析出任何引脚（文件格式可能不是预期的两种写法）` }
  }
  return { ok: true, draft: { board, source, pins, gaps: VARIANT_GAPS } }
}

