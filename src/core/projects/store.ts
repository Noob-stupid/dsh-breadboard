/**
 * **项目存储** —— 用户自己的软硬件项目（默认**空**）。
 * @module dsh-hardware-sandbox/core/projects/store
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么从"硬编码常量"改成"用户文件"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 第一版把智座写死在 `SAMPLE_PROJECTS` 里。用户的原话把问题说透了：
 *
 *   > **别人的插件应该是自己添加项目才对，而不是我们这个懂吗，
 *   > 别人是自己导入他们的项目，是空的**
 *
 * 对的。**智座是我们的演示，不是别人的项目。** 把我们的东西硬编码进插件，
 * 等于告诉所有用户"你只能跑这一个系统" —— 而这是个**沙盒**。
 *
 * ⇒ 项目改成**用户目录里的 JSON**（与 `ModelStore` 同一手法）：
 *   · 新用户打开是**空的**
 *   · 别人**导入/添加自己的**项目
 *   · 智座降级成 `examples/zhizuo-seat-node.json` —— **一份可以导入的样例**，不是内置项
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么与 ModelStore 分开，而不是塞进同一个目录
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 两者形状像（都是"用户目录 + 一堆文件"），但**生命周期完全不同**：
 *   模型 = 二进制 GLB，可能几 MB，导入一次基本不动；
 *   项目 = 小 JSON，**会被 agent 反复改**（加个器件、换个引脚）。
 * 混在一起，`清空模型` 之类的操作会**顺手把项目也删了**，而那时没人会想到。
 */

import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { SAMPLE_PROJECTS, type ProjectProfile } from '../../contracts/projects.ts'

/** 存储错误的原因码。**给人看的原因**由调用方拼，这里只给机器可判定的。 */
export type ProjectStoreErrorCode = 'bad_id' | 'not_found' | 'io' | 'bad_json' | 'bad_shape'

export class ProjectStoreError extends Error {
  readonly code: ProjectStoreErrorCode
  constructor(code: ProjectStoreErrorCode, message: string) {
    super(message)
    this.name = 'ProjectStoreError'
    this.code = code
  }
}

export interface ProjectStoreOptions {
  /** 项目目录（`~/.dsh/dsh-hardware-sandbox/projects`）。 */
  readonly root: string
}

/**
 * 项目 id 的合法性。
 *
 * ★ 只允许 `[a-z0-9-]`：id 会变成**文件名**，放任它会出现
 *   `../` 之类越出目录的路径（与 `ModelStore` 的 `bad_key` 同一条理由）。
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 项目的落盘形状。★ 加一个 `format` 版本号：将来改结构时能识别旧文件。 */
interface ProjectFile {
  readonly format: 1
  readonly profile: ProjectProfile
}

/**
 * 校验一份**用户给的**项目定义。
 *
 * ★★ 为什么必须校验：图纸可能是**用户从文件选的**（手写、别人给的、agent 生成的），
 *   **不受我们控制**。少了这一步，坏数据会一路走到 `importProject` ——
 *   那时的表现是「**导入成功，但场景里什么都没有**」，而调用方只看到 `ok:true`。
 *   ⇒ 能判的都在**入口**判掉，并且**说清是哪一种坏**。
 *
 * ⚠️ 判的是**能不能用**，不是"完不完美"：多出来的字段一律保留
 *   （不认识的字段不该让导入失败 —— 那会把"格式演进"变成"旧文件全废"）。
 */
export function validateProjectProfile(
  raw: unknown,
): { ok: true; profile: ProjectProfile } | { ok: false; reason: string } {
  if (raw === null || typeof raw !== 'object') return { ok: false, reason: '不是一个对象' }
  const box = raw as Record<string, unknown>
  const id = box.id
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
    return { ok: false, reason: `id 不合法："${String(id)}"（只允许小写字母、数字、连字符，最长 64）` }
  }
  if (!Array.isArray(box.parts) || box.parts.length === 0) {
    return { ok: false, reason: 'parts 缺失或为空 —— 一个器件都没有的项目没法导入' }
  }
  const partIds = new Set<string>()
  for (const [index, item] of box.parts.entries()) {
    if (item === null || typeof item !== 'object') return { ok: false, reason: `parts[${String(index)}] 不是对象` }
    const part = item as Record<string, unknown>
    if (typeof part.id !== 'string' || part.id === '') return { ok: false, reason: `parts[${String(index)}].id 缺失` }
    if (typeof part.hardwareModel !== 'string' || part.hardwareModel === '') {
      return { ok: false, reason: `parts[${String(index)}].hardwareModel 缺失` }
    }
    const position = part.position as Record<string, unknown> | undefined
    if (
      position === undefined ||
      typeof position.x !== 'number' ||
      typeof position.y !== 'number' ||
      typeof position.z !== 'number'
    ) {
      return { ok: false, reason: `parts[${String(index)}].position 缺失或不是 {x,y,z} 数字` }
    }
    if (partIds.has(part.id)) return { ok: false, reason: `器件 id 重复："${part.id}"` }
    partIds.add(part.id)
  }
  if (!Array.isArray(box.wires)) return { ok: false, reason: 'wires 缺失（可以是空数组）' }
  for (const [index, item] of box.wires.entries()) {
    const wire = item as Record<string, unknown> | null
    for (const side of ['from', 'to'] as const) {
      const end = wire?.[side] as Record<string, unknown> | undefined
      if (end === undefined || typeof end.componentId !== 'string' || typeof end.portId !== 'string') {
        return { ok: false, reason: `wires[${String(index)}].${side} 缺失 componentId / portId` }
      }
      // ★ 引用必须对得上 —— 对不上的线在导入时会**静默连不上**
      if (!partIds.has(end.componentId)) {
        return {
          ok: false,
          reason: `wires[${String(index)}].${side}.componentId="${end.componentId}" 不在 parts 里`,
        }
      }
    }
  }
  const networkComponentId = box.networkComponentId
  if (typeof networkComponentId !== 'string' || !partIds.has(networkComponentId)) {
    return {
      ok: false,
      reason: `networkComponentId="${String(networkComponentId)}" 不在 parts 里 —— 出网的那台必须是项目里的器件`,
    }
  }
  if (box.network === null || typeof box.network !== 'object') {
    return { ok: false, reason: 'network 缺失（出网绑定）' }
  }
  // ★★ `link` 必须校验 —— 这条是**实测抓出来的**：
  //   我手写了一份没写 `link` 的图纸，`save` 通过了，然后**列表路由直接抛**
  //   （`projectStatuses` 读 `project.link.requires`）。
  //   ⇒ 症状是"导入成功，但整个项目面板变成一条红字错误" —— 比导入失败更糟。
  //
  // ⚠️ 刻意**不给默认值**（比如 `[]` = 永远算连通）：那会让一份没写判据的图纸
  //   **自称已连通**，而它可能连都没连过。"不知道"和"通了"必须分开。
  const link = box.link as Record<string, unknown> | undefined
  if (link === null || typeof link !== 'object' || !Array.isArray(link.requires)) {
    return {
      ok: false,
      reason:
        'link.requires 缺失 —— 必须写明"怎么算连通"（如 ["registered","config","reported","reporting"]），' +
        '否则没法判断这个项目到底通没通',
    }
  }
  return { ok: true, profile: box as unknown as ProjectProfile }
}

export class ProjectStore {
  readonly root: string

  constructor(options: ProjectStoreOptions) {
    this.root = options.root
  }

  #fileOf(projectId: string): string {
    if (!ID_PATTERN.test(projectId)) {
      throw new ProjectStoreError('bad_id', `项目 id 不合法："${projectId}"（只允许小写字母、数字、连字符）`)
    }
    return path.join(this.root, `${projectId}.json`)
  }

  /**
   * 列出全部项目。
   *
   * ★ **目录不存在 = 返回空数组，不是报错** —— 新用户就是没有项目，
   *   那不是"出错了"。报错会让界面显示一条红字，而其实一切正常。
   * ★ 单个文件坏了**只跳过它**，不影响别的：一个手写的坏 JSON
   *   不该让整个项目列表消失。
   */
  async list(): Promise<{ projects: ProjectProfile[]; broken: string[] }> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return { projects: [], broken: [] } // 目录还不存在 = 一个项目都没有
    }
    const projects: ProjectProfile[] = []
    const broken: string[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        projects.push(await this.#readOne(path.join(this.root, name)))
      } catch {
        broken.push(name)
      }
    }
    return { projects, broken }
  }

  async #readOne(file: string): Promise<ProjectProfile> {
    const text = await readFile(file, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new ProjectStoreError('bad_json', `${file} 不是合法 JSON`)
    }
    const box = parsed as Partial<ProjectFile> & Partial<ProjectProfile>
    // 兼容两种形状：带 format 包装的，和直接就是 profile 的（手写方便）
    const profile = (box.profile ?? box) as ProjectProfile
    if (typeof profile?.id !== 'string' || !Array.isArray(profile.parts)) {
      throw new ProjectStoreError('bad_shape', `${file} 缺少 id / parts`)
    }
    return profile
  }

  async get(projectId: string): Promise<ProjectProfile | undefined> {
    try {
      return await this.#readOne(this.#fileOf(projectId))
    } catch (error) {
      if (error instanceof ProjectStoreError && error.code === 'bad_id') throw error
      return undefined
    }
  }

  async save(profile: ProjectProfile): Promise<void> {
    const file = this.#fileOf(profile.id)
    try {
      await mkdir(this.root, { recursive: true })
      const payload: ProjectFile = { format: 1, profile }
      await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } catch (error) {
      throw new ProjectStoreError('io', `写入项目失败：${String(error)}`)
    }
  }

  async remove(projectId: string): Promise<boolean> {
    const file = this.#fileOf(projectId)
    try {
      await rm(file)
      return true
    } catch {
      return false
    }
  }

  /**
   * **把随包样例装进用户目录**（用户明确要导入时才调）。
   *
   * ⚠️ 与 `seedPackagedModels` **不同**：那个是启动时自动补齐（模型是"基础设施"），
   *   这个是**用户显式导入**（项目是"他的东西"）。
   *   ⇒ 新用户的项目列表**默认是空的**，这正是用户要的。
   */
  async importSample(projectId: string): Promise<ProjectProfile | undefined> {
    const sample = SAMPLE_PROJECTS[projectId]
    if (sample === undefined) return undefined
    await this.save(sample)
    return sample
  }
}
