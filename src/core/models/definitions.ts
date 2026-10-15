/**
 * **数据驱动的型号定义** —— 让"加一块新板子"变成"只加数据"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要它（这是"硬件适配通用"的**基础设施**，不是锦上添花）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 现在所有型号都**硬编码在 `library.ts` 的 TS 里**。后果是：
 *   · 加一块新板子 = **改代码 + 重新构建 + 重新发版**；
 *   · 别人想加自己手上的板子 ⇒ **必须改我们的仓库** ⇒ 生态不可能形成。
 *
 * 而用户给这个插件的最终目的很明确：**基本上所有硬件都能适配通用**。
 * 我们**不可能自己适配所有硬件** ⇒ 唯一可行的形态是：
 *   **我们定接口与数据格式，生态往里填硬件。**
 *
 * ⇒ 于是判据（见 `docs/08-硬件在环日程.md` 的 L1/L2/L3）：
 *   接一块全新板子 **只加一条型号定义（数据） = L1 = 理想**。
 *   这个文件就是让 L1 成立的那层基础设施。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 三条设计纪律
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. **内置型号不可被外部覆盖**。第三方定义若与内置键同名 ⇒ **拒绝并说明**。
 *    ⚠️ 若允许覆盖，别人发一个 `rpi-4b` 定义就能**悄悄改掉**所有用户的树莓派引脚表 ——
 *    而界面上什么都看不出来。这属于本项目失败族里最坏的一类：
 *    **看起来对，实际全错，且没有报错**。
 * 2. **失败要说清是哪个字段**。校验错误带路径（如 `ports[2].portId`），
 *    而不是笼统的"定义不合法" —— 写定义的人多半不是我们，报错必须能自己修。
 * 3. **解析不等于能用**。除了字段校验，还要真的跑一遍 `resolveModel()`
 *    （它会算端口坐标、并做**结构性布局校验**）⇒ 规则本身不合理（如"一排比板子还长"）
 *    在**加载时**就被拦下，而不是等摆上去才发现。
 */

import type { HardwareModelSource } from '../../contracts/library.ts'
import { HARDWARE_MODELS, resolveModel, setExternalModels } from '../../contracts/library.ts'

/** 解析结果：成功给 source，失败给**带字段路径的原因**。 */
export type ModelDefParse =
  | { readonly ok: true; readonly source: HardwareModelSource }
  | { readonly ok: false; readonly reason: string }

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 解析一条**外部型号定义**（来自 JSON 数据）。
 *
 * ★ 只做校验与转换，**不注册** —— 注册由 {@link buildRegistry} 统一决定
 *   （那里才谈"能不能覆盖内置"这种全局问题）。
 */
export function parseModelDefinition(raw: unknown): ModelDefParse {
  if (!isRecord(raw)) return { ok: false, reason: '定义必须是一个对象' }

  const key = raw.key
  if (typeof key !== 'string' || key === '') return { ok: false, reason: 'key 缺失或不是字符串' }
  if (!KEY_PATTERN.test(key)) {
    return {
      ok: false,
      reason: `key 不合法（${key}）：只允许小写字母/数字/连字符，且不超过 64 字符`,
    }
  }

  const label = raw.label
  if (typeof label !== 'string' || label === '') {
    return { ok: false, reason: 'label 缺失或不是字符串（它是界面上显示的名字）' }
  }

  const size = raw.size
  if (!isRecord(size)) return { ok: false, reason: 'size 缺失（应为 {x,y,z}，单位米）' }
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = num(size[axis])
    if (value === undefined) return { ok: false, reason: `size.${axis} 缺失或不是有限数字` }
    // ⚠️ 尺寸必须为正：0 或负数会让包围盒退化，而**退化后的体积/落位计算不会报错**，
    //    只会让器件看起来"贴在地上"或"消失"，排查起来毫无线索。
    if (value <= 0) return { ok: false, reason: `size.${axis} 必须为正数（当前 ${String(value)}）` }
  }

  const ports = raw.ports
  // ★★ **允许空数组** —— 无源件（如面包板）本来就没有电气端口。
  //   ⚠️ 我第一版要求"至少一个端口"，**往返测试立刻抓到**：内置的 `breadboard`
  //     就是 `ports: []`。所以那条规则会让"外部数据格式"表达不了我们自己的型号。
  //   ⇒ 仍然**要求字段存在且是数组**（`ports` 整个缺失是典型的写漏，要拦），
  //     但**不要求非空**。
  if (!Array.isArray(ports)) {
    return { ok: false, reason: 'ports 缺失或不是数组（无源件可以给空数组 []，但字段要在）' }
  }
  const seen = new Set<string>()
  const checkedPorts: Record<string, unknown>[] = []
  for (let i = 0; i < ports.length; i += 1) {
    const port = ports[i]
    if (!isRecord(port)) return { ok: false, reason: `ports[${String(i)}] 不是对象` }
    const portId = port.portId
    if (typeof portId !== 'string' || portId === '') {
      return { ok: false, reason: `ports[${String(i)}].portId 缺失或不是字符串` }
    }
    // ★ 重复 portId 是**静默灾难**：两个端口共用一个身份 ⇒ 连接关系分不清是哪一根，
    //   而拓扑校验、导线渲染一切"正常"。必须在加载时就拦。
    if (seen.has(portId)) {
      return { ok: false, reason: `ports[${String(i)}].portId 重复：${portId}（每个引脚的身份必须唯一）` }
    }
    seen.add(portId)
    if (typeof port.name !== 'string' || port.name === '') {
      return { ok: false, reason: `ports[${String(i)}].name 缺失（它是丝印名，如 GPIO23）` }
    }
    if (typeof port.protocol !== 'string' || port.protocol === '') {
      return { ok: false, reason: `ports[${String(i)}].protocol 缺失（i2c/spi/uart/gpio/power 之一）` }
    }
    const voltage = num(port.voltage)
    if (voltage === undefined) {
      return { ok: false, reason: `ports[${String(i)}].voltage 缺失或不是有限数字` }
    }
    // ★★ **0 是合法的** —— 它是地（GND）的电压，不是"没填"。
    //   ⚠️ 我第一版写成"`<= 0` 就拒绝"，**往返测试立刻抓到**：
    //     内置型号里有 14 个端口声明 `voltage: 0`（全是 GND）
    //     ⇒ 那个校验器会让"外部数据格式"**表达不了我们自己的型号**，
    //       于是"只加数据就能加板子"这句话就是假的（只是把硬编码换了个地方）。
    //   ⇒ 拒绝**负数**与非有限值；**0 照收**。
    if (voltage < 0) {
      return { ok: false, reason: `ports[${String(i)}].voltage 不能为负（当前 ${String(voltage)}）` }
    }
    if (typeof port.direction !== 'string' || port.direction === '') {
      return { ok: false, reason: `ports[${String(i)}].direction 缺失（power/ground/io/in/out 之一）` }
    }
    checkedPorts.push(port)
  }

  const source = { ...raw, ports: checkedPorts } as unknown as HardwareModelSource

  // ★★ **解析 ≠ 能用**：真的跑一遍 resolveModel（算端口坐标 + 结构性布局校验）。
  try {
    resolveModel(source)
  } catch (error) {
    return { ok: false, reason: `定义无法解析成可用型号：${String(error instanceof Error ? error.message : error)}` }
  }

  return { ok: true, source }
}

/** 一个文件加载失败的记录 —— **必须被调用方报出来**，不能吞。 */
export interface ModelDefFailure {
  readonly source: string
  readonly reason: string
}

/** 加载结果：注册成功的键 + 每一条失败的原因。 */
export interface ModelDefLoadResult {
  readonly registered: readonly string[]
  /** 与内置或彼此**同名**而被拒绝的键（这不是错误，是刻意的保护，但要说出来）。 */
  readonly rejected: readonly ModelDefFailure[]
  readonly failures: readonly ModelDefFailure[]
}

/**
 * 把若干条定义合成注册表并装上。
 *
 * ★ 冲突处理（这就是纪律 1 的落点）：
 *   · 与**内置**同名 ⇒ 拒绝（**内置优先，外部不得覆盖**）；
 *   · 外部彼此同名 ⇒ 保留**先出现**的那条，后到的拒绝并记原因。
 */
export function buildRegistry(
  defs: readonly { readonly source: string; readonly raw: unknown }[],
): { readonly models: Readonly<Record<string, ReturnType<typeof resolveModel>>>; readonly result: ModelDefLoadResult } {
  const models: Record<string, ReturnType<typeof resolveModel>> = {}
  const registered: string[] = []
  const rejected: ModelDefFailure[] = []
  const failures: ModelDefFailure[] = []

  for (const def of defs) {
    const parsed = parseModelDefinition(def.raw)
    if (!parsed.ok) {
      failures.push({ source: def.source, reason: parsed.reason })
      continue
    }
    const key = parsed.source.key
    if (HARDWARE_MODELS[key] !== undefined) {
      rejected.push({
        source: def.source,
        reason: `键 ${key} 与**内置型号**同名 —— 外部定义不得覆盖内置（否则会悄悄改掉所有用户的引脚表）`,
      })
      continue
    }
    if (models[key] !== undefined) {
      rejected.push({ source: def.source, reason: `键 ${key} 与另一条外部定义重复（保留先出现的那条）` })
      continue
    }
    models[key] = resolveModel(parsed.source)
    registered.push(key)
  }

  return { models, result: { registered, rejected, failures } }
}

/** 把注册表装到 `library.ts` 的查找路径上（内置仍然优先）。 */
export function applyRegistry(models: Readonly<Record<string, ReturnType<typeof resolveModel>>>): void {
  setExternalModels(models)
}

/* ─────────────────────────── 从目录加载 ─────────────────────────── */

/** 读盘用的最小依赖（注入进来 ⇒ 测试能塞假目录，不碰真实文件系统）。 */
export interface ModelDefIo {
  readonly listJson: (dir: string) => Promise<readonly string[]>
  readonly readText: (file: string) => Promise<string>
}

/**
 * **汇总多个目录**后一次注册（内置优先、外部彼此不覆盖）。
 *
 * ★ 为什么不逐目录注册：`applyRegistry` 是**整体替换**外部表 ——
 *   逐目录注册会让**后一个目录丢掉前一个目录**的定义
 *   （而日志里两条都"成功"了 ⇒ 典型的静默丢失）。
 * ★ 目录不存在 ⇒ 跳过（用户没有这个目录是正常状态）；
 *   但**目录里的文件坏了 / JSON 语法错必须报出来** ——
 *   那是"用户以为加上了、其实没加上"的典型场景。
 */
export async function loadModelDefs(
  dirs: readonly string[],
  io: ModelDefIo,
  log: (message: string) => void = () => {},
): Promise<ModelDefLoadResult> {
  const defs: { source: string; raw: unknown }[] = []
  const failures: ModelDefFailure[] = []
  for (const dir of dirs) {
    let files: readonly string[]
    try {
      files = await io.listJson(dir)
    } catch {
      continue // 目录不在是正常状态
    }
    for (const file of files) {
      try {
        defs.push({ source: file, raw: JSON.parse(await io.readText(file)) })
      } catch (error) {
        failures.push({
          source: file,
          reason: `读不出/不是合法 JSON：${String(error instanceof Error ? error.message : error)}`,
        })
      }
    }
  }
  const { models, result } = buildRegistry(defs)
  applyRegistry(models)
  const merged: ModelDefLoadResult = {
    registered: result.registered,
    rejected: result.rejected,
    failures: [...failures, ...result.failures],
  }
  for (const item of merged.rejected) log(`[model-defs] 拒绝 ${item.source}：${item.reason}`)
  for (const item of merged.failures) log(`[model-defs] 失败 ${item.source}：${item.reason}`)
  if (merged.registered.length > 0) log(`[model-defs] 已加载 ${String(merged.registered.length)} 个外部型号：${merged.registered.join(', ')}`)
  return merged
}
