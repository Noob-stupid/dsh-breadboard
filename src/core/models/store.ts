/**
 * ModelStore —— 用户导入的模型（几何）持久化
 * @module dsh-hardware-sandbox/core/models/store
 *
 * ★ **只存用户导入的东西，插件不分发任何第三方模型。**
 *   存储落在宿主侧的**用户数据目录**（不是插件包内），因此刷新、换机器、重装插件都不会丢。
 *
 * ★ 两条安全/健壮性要求，都不是可选项：
 *
 *   ① **modelKey 会拼进文件路径** ⇒ 不校验就是目录穿越漏洞。
 *      两道防线：正则白名单 **+** 解析后确认最终路径确实在 root 之内
 *      （只靠正则不够 —— 符号链接、Windows 短名、大小写折叠都可能绕过）。
 *
 *   ② **写入必须原子** ⇒ 先写临时文件再 `rename`。
 *      否则上传中断会在磁盘上留下一个**半截的模型文件**，
 *      而它看起来和正常文件一模一样 —— 属于本项目那个「看起来正常、实际全错」的失败族。
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

import {
  MODEL_KEY_PATTERN,
  MODEL_MAX_BYTES,
  type ImportedModelRecord,
  type ModelFormat,
} from '../../contracts/protocol.ts'

export class ModelStoreError extends Error {
  readonly code: 'bad_key' | 'too_large' | 'bad_format' | 'io'
  constructor(code: ModelStoreError['code'], message: string) {
    super(message)
    this.name = 'ModelStoreError'
    this.code = code
  }
}

export interface ModelStoreOptions {
  /** 存储根目录（用户数据目录下）。 */
  readonly root: string
  readonly maxBytes?: number
}

/** 每个模型一个子目录，避免扩展名歧义，也让 meta 与字节绑在一起。 */
const MODEL_FILE = 'model.bin'
const META_FILE = 'meta.json'

/** GLB 的魔数：ASCII 'glTF' 小端。 */
const GLB_MAGIC = 0x46546c67

/** 在前 n 字节里找 ASCII 片段。 */
function hasAscii(bytes: Uint8Array, text: string, limit = 4096): boolean {
  const needle = Buffer.from(text, 'ascii')
  const end = Math.min(bytes.length - needle.length, limit)
  for (let i = 0; i <= end; i += 1) {
    let hit = true
    for (let k = 0; k < needle.length; k += 1) {
      if (bytes[i + k] !== needle[k]) {
        hit = false
        break
      }
    }
    if (hit) return true
  }
  return false
}

/** 跳过前导空白后的起始文本（小写）。 */
function headText(bytes: Uint8Array, length = 64): string {
  let i = 0
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)) {
    i += 1
  }
  return Buffer.from(bytes.subarray(i, i + length)).toString('latin1').trim().toLowerCase()
}

/**
 * 二进制 STL 的**可靠判据**：文件头 80 字节 + 4 字节三角面数 n，其后恰好 50n 字节。
 *
 * ★ 必须**先于** ASCII 判断 —— 二进制 STL 的文件头也常常以 "solid" 开头
 *   （那是导出软件写的描述），只看前缀会把它误判成 ASCII。
 */
function isBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const triangles = view.getUint32(80, true)
  if (triangles === 0) return false
  return 84 + triangles * 50 === bytes.length
}

/**
 * 从字节判断格式 —— **不信扩展名、不信 content-type，只信内容**。
 *
 * 判据顺序有讲究，见 {@link isBinaryStl} 的说明。
 */
function detectFormat(bytes: Uint8Array): ModelFormat {
  const head = headText(bytes)

  // ── glTF 家族 ──
  if (bytes.length >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, 4)
    if (view.getUint32(0, true) === GLB_MAGIC) return 'glb'
  }
  if (head.startsWith('{') && hasAscii(bytes, '"asset"')) return 'gltf'

  // ── 3D 打印与交换格式 ──
  if (isBinaryStl(bytes)) return 'stl'
  if (head.startsWith('solid') && hasAscii(bytes, 'facet')) return 'stl'
  if (head.startsWith('ply')) return 'ply'
  // 3MF 是 zip 容器
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return '3mf'
  // OBJ：有顶点行与面行（只认顶点不够 —— 很多文本文件都有 "v "）
  if (head.includes('v ') && (hasAscii(bytes, '\nf ') || hasAscii(bytes, '\nvn '))) return 'obj'
  if (hasAscii(bytes, '<COLLADA')) return 'dae'
  if (hasAscii(bytes, 'Kaydara FBX Binary') || hasAscii(bytes, 'FBXHeaderExtension')) return 'fbx'
  if (head.startsWith('#vrml')) return 'wrl'

  throw new ModelStoreError(
    'bad_format',
    '认不出这个模型格式。支持：glb / gltf / stl / obj / ply / 3mf / dae / fbx / wrl。' +
      '⚠️ **STEP / IGES 不支持** —— three.js 没有对应 loader，收下来也渲染不了，所以明确拒绝而不是静默存下。',
  )
}

/**
 * 数一个 glTF/GLB 里有多少**节点**（数不出来就返回 `undefined`）。
 *
 * ★★ 为什么要记这个数（**它是性能画像里最容易被忽略的一个量**）：
 *   实测踩到 —— `nearestPort()` 在**每次鼠标移动**时做一次 `scene.traverse()`。
 *   占位盒时代全场景 **1 个节点**，这行代码的成本是 1，**完全隐形**；
 *   换上真树莓派模型后是 **2067 个节点**，成本凭空涨**三个数量级**，
 *   而它**不报错、只是变卡**。
 *
 *   ⇒ **"换真几何会改变性能画像，不只是好看一点。"**
 *     任何「每帧 / 每次输入做一次全树遍历」的写法，在占位物阶段都测不出来。
 *     **把节点数在导入时量出来并记进记录**，就让这个量从"事后才发现"变成"一开始就知道"。
 *
 * ⚠️ 数的是 **`nodes` 而不是 `meshes`**：`Object3D.traverse()` 访问的是**节点**，
 *   遍历成本由它决定（一个 node 可以不带 mesh）。
 */
function countGltfNodes(bytes: Uint8Array): number | undefined {
  try {
    // GLB：12 字节头 + 第一个 chunk 头（8 字节），随后是 JSON
    if (bytes.length < 20) return undefined
    const magic = bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46 // 'glTF'
    if (!magic) return undefined
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(4, true) !== 2) return undefined
    const chunkLength = view.getUint32(12, true)
    const chunkType = view.getUint32(16, true)
    if (chunkType !== 0x4e4f534a) return undefined // 'JSON'
    const end = Math.min(20 + chunkLength, bytes.length)
    const json = new TextDecoder().decode(bytes.subarray(20, end))
    const parsed = JSON.parse(json) as { nodes?: unknown }
    return Array.isArray(parsed.nodes) ? parsed.nodes.length : 0
  } catch {
    // ★ 数不出来**不是错误** —— 它只是元数据，绝不能因此让导入失败
    return undefined
  }
}

export class ModelStore {
  readonly #root: string
  readonly #maxBytes: number

  constructor(options: ModelStoreOptions) {
    this.#root = path.resolve(options.root)
    this.#maxBytes = options.maxBytes ?? MODEL_MAX_BYTES
  }

  get root(): string {
    return this.#root
  }

  /**
   * 校验 modelKey 并解析出它的目录。
   *
   * ★ **两道防线**：正则白名单 + 解析后确认在 root 之内。
   */
  #dirOf(modelKey: string): string {
    if (!MODEL_KEY_PATTERN.test(modelKey)) {
      throw new ModelStoreError(
        'bad_key',
        `modelKey 不合法：${JSON.stringify(modelKey)} —— 只允许小写字母数字与 . _ -，且以字母数字开头`,
      )
    }
    const dir = path.resolve(this.#root, modelKey)
    // 第二道防线：即使正则被绕过，也不允许逃出 root
    const prefix = this.#root.endsWith(path.sep) ? this.#root : this.#root + path.sep
    if (!dir.startsWith(prefix)) {
      throw new ModelStoreError('bad_key', `modelKey 解析后越出存储根目录：${modelKey}`)
    }
    return dir
  }

  /** 列出全部已导入模型。单个条目损坏时**跳过它而不是整个失败**。 */
  async list(): Promise<ImportedModelRecord[]> {
    let entries: string[]
    try {
      entries = await readdir(this.#root)
    } catch {
      return [] // 目录还不存在 = 一个都没导入
    }

    const records: ImportedModelRecord[] = []
    for (const name of entries) {
      try {
        const meta = await readFile(path.join(this.#root, name, META_FILE), 'utf8')
        records.push(JSON.parse(meta) as ImportedModelRecord)
      } catch {
        // 损坏的条目跳过 —— 一条坏记录不该让整个清单打不开
      }
    }
    return records.sort((a, b) => a.modelKey.localeCompare(b.modelKey))
  }

  /** 读取某个模型的记录与字节。 */
  async get(modelKey: string): Promise<{ record: ImportedModelRecord; bytes: Buffer } | undefined> {
    const dir = this.#dirOf(modelKey)
    try {
      const [metaText, bytes] = await Promise.all([
        readFile(path.join(dir, META_FILE), 'utf8'),
        readFile(path.join(dir, MODEL_FILE)),
      ])
      return { record: JSON.parse(metaText) as ImportedModelRecord, bytes }
    } catch {
      return undefined
    }
  }

  /**
   * 写入（覆盖）一个模型。
   *
   * ★ **原子**：先写临时文件 → `rename`。中断只会留下一个 `.tmp-*`，不会污染正式文件。
   */
  async put(
    modelKey: string,
    bytes: Uint8Array,
    extra: { size?: ImportedModelRecord['size']; label?: string } = {},
  ): Promise<ImportedModelRecord> {
    const dir = this.#dirOf(modelKey)

    if (bytes.length === 0) {
      throw new ModelStoreError('bad_format', '文件是空的')
    }
    if (bytes.length > this.#maxBytes) {
      throw new ModelStoreError(
        'too_large',
        `模型文件 ${String(bytes.length)} 字节，超过上限 ${String(this.#maxBytes)} 字节`,
      )
    }

    const format = detectFormat(bytes)
    const record: ImportedModelRecord = {
      modelKey,
      format,
      bytes: bytes.length,
      importedAt: new Date().toISOString(),
      ...(countGltfNodes(bytes) !== undefined ? { nodes: countGltfNodes(bytes)! } : {}),
      ...(extra.size !== undefined ? { size: extra.size } : {}),
      ...(extra.label !== undefined ? { label: extra.label } : {}),
    }

    await mkdir(dir, { recursive: true })

    const suffix = randomBytes(6).toString('hex')
    const tmpModel = path.join(dir, `${MODEL_FILE}.tmp-${suffix}`)
    const tmpMeta = path.join(dir, `${META_FILE}.tmp-${suffix}`)
    try {
      await writeFile(tmpModel, bytes)
      await writeFile(tmpMeta, JSON.stringify(record, null, 2), 'utf8')
      // rename 在同一目录内是原子的
      await rename(tmpModel, path.join(dir, MODEL_FILE))
      await rename(tmpMeta, path.join(dir, META_FILE))
    } catch (error) {
      await rm(tmpModel, { force: true }).catch(() => undefined)
      await rm(tmpMeta, { force: true }).catch(() => undefined)
      throw new ModelStoreError('io', `写入模型失败：${String(error)}`)
    }

    return record
  }

  /** 删除。返回是否真的删掉了东西。 */
  async delete(modelKey: string): Promise<boolean> {
    const dir = this.#dirOf(modelKey)
    try {
      await stat(dir)
    } catch {
      return false
    }
    await rm(dir, { recursive: true, force: true })
    return true
  }
}
