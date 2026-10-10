/**
 * step.parts 客户端 —— 唯一一个「公共 API + 免鉴权 + 直接给 GLB」的模型来源
 * @module dsh-hardware-sandbox/core/models/step-parts
 *
 * ★★ 为什么是它（2026-10-07 核实，详见 `docs/05-模型来源与导入方案.md`）：
 *
 *   我们此前的核心障碍是「现成模型多为 STEP，而 three.js **没有** STEP loader」。
 *   **step.parts 为每件都生成了 GLB**，所以**不需要任何 CAD 转换管线**。
 *
 *   而且它是**唯一**能程序化直连的来源：
 *   | 来源 | 公共 API | 免登录 | 格式 |
 *   |---|---|---|---|
 *   | **step.parts** | ✅ | ✅ | **GLB 直链** |
 *   | Printables / Thingiverse | ❌ | ✅ | STL（可手动下） |
 *   | KiCad 3D | ❌ | ✅ | STEP+WRL，**仅芯片封装** |
 *   | GrabCAD / Ultra Librarian | ❌ | ❌ 要登录/注册 | STEP |
 *
 * ★ **SSRF 面为零的设计**：本模块只接受 **partId**，`glbUrl` 由**宿主自己**从 API 取，
 *   **URL 从不由客户端提供**。所以不存在"用户让宿主去抓任意地址"这条路。
 *
 * ★ **下载前先看 `byteSize`**：元数据里就有大小，**不满足上限的直接拒绝，不去下**。
 *   否则一个 52MB 的 Raspberry Pi 4B 会先把流量和时间花掉再被拒。
 */
import type { ModelCandidate } from '../../contracts/protocol.ts'

const DEFAULT_BASE = 'https://api.step.parts/v1'
const DEFAULT_TIMEOUT_MS = 20_000

export class StepPartsError extends Error {
  readonly code: 'network' | 'not_found' | 'too_large' | 'bad_response'
  constructor(code: StepPartsError['code'], message: string) {
    super(message)
    this.name = 'StepPartsError'
    this.code = code
  }
}

export interface StepPartsClientOptions {
  readonly baseUrl?: string
  /**
   * **GLB** 的下载上限（字节）。下载完成后按实际字节数强制判定。
   */
  readonly maxBytes?: number
  /**
   * 元数据 `byteSize` 的预检上限（字节）。
   *
   * ★★ **`byteSize` 是 STEP 文件的大小，不是 GLB 的** —— 实测：
   *   | 件 | `byteSize`(STEP) | 实际 GLB |
   *   |---|---|---|
   *   | Raspberry Pi Pico | 1.7 MB | **570 KB** |
   *   | Raspberry Pi 4 Model B | 50.1 MB | **5.7 MB** |
   *
   *   GLB 通常比 STEP 小一个数量级（step.parts 的 GLB 是**预览用**的简化几何）。
   *   所以**不能拿 `byteSize` 直接卡 `maxBytes`** —— 那会拒掉一大批其实装得下的件。
   *   预检只用来挡住**明显离谱**的（如 STEP 就几百 MB），真正的闸门是下载后的实际字节数。
   */
  readonly precheckBytes?: number
  readonly timeoutMs?: number
  /** 注入 fetch 以便测试。 */
  readonly fetchImpl?: typeof fetch
}

/** step.parts 原始条目（只声明我们用到的字段）。 */
interface RawPart {
  readonly id?: unknown
  readonly name?: unknown
  readonly description?: unknown
  readonly category?: unknown
  readonly family?: unknown
  readonly tags?: unknown
  readonly attributes?: unknown
  readonly glbUrl?: unknown
  readonly pngUrl?: unknown
  readonly pageUrl?: unknown
  readonly byteSize?: unknown
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 把原始条目归一化成 {@link ModelCandidate}。
 *
 * ★ `attributes` 里的 **`boardLengthMm` / `boardWidthMm` 直接给出板卡尺寸（毫米）** ——
 *   这正是契约 `size` 需要的（如树莓派 85×56mm），比从 GLB 反推 bbox 更可靠。
 *   **厚度仍缺**（需从几何量或人工补），所以这里只带出长宽。
 */
function toCandidate(raw: RawPart, baseUrl: string): ModelCandidate | undefined {
  const id = str(raw.id)
  const glbUrl = str(raw.glbUrl)
  if (id === undefined || glbUrl === undefined) return undefined

  const attributes = (raw.attributes ?? {}) as Record<string, unknown>
  const lengthMm = num(attributes['boardLengthMm'])
  const widthMm = num(attributes['boardWidthMm'])

  return {
    source: 'step.parts',
    id,
    name: str(raw.name) ?? id,
    ...(str(raw.description) !== undefined ? { description: str(raw.description)! } : {}),
    ...(str(attributes['manufacturer']) !== undefined
      ? { manufacturer: str(attributes['manufacturer'])! }
      : {}),
    ...(str(raw.category) !== undefined ? { category: str(raw.category)! } : {}),
    ...(str(raw.family) !== undefined ? { family: str(raw.family)! } : {}),
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    glbUrl,
    ...(str(raw.pngUrl) !== undefined ? { previewUrl: str(raw.pngUrl)! } : {}),
    ...(str(raw.pageUrl) !== undefined ? { pageUrl: str(raw.pageUrl)! } : {}),
    ...(num(raw.byteSize) !== undefined ? { byteSize: num(raw.byteSize)! } : {}),
    ...(lengthMm !== undefined || widthMm !== undefined
      ? { sizeMm: { ...(lengthMm !== undefined ? { length: lengthMm } : {}), ...(widthMm !== undefined ? { width: widthMm } : {}) } }
      : {}),
    /** 可直接一键导入（有 GLB 直链）。 */
    importable: true,
    apiUrl: `${baseUrl}/parts/${id}`,
  }
}

export class StepPartsClient {
  readonly #base: string
  readonly #maxBytes: number
  readonly #precheckBytes: number
  readonly #timeoutMs: number
  readonly #fetch: typeof fetch

  constructor(options: StepPartsClientOptions = {}) {
    this.#base = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '')
    this.#maxBytes = options.maxBytes ?? 64 * 1024 * 1024
    // 预检宽松得多：byteSize 量的是 STEP，而我们要下的是小得多的 GLB
    this.#precheckBytes = options.precheckBytes ?? 512 * 1024 * 1024
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.#fetch = options.fetchImpl ?? fetch
  }

  async #getJson(url: string): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.#timeoutMs)
    try {
      const response = await this.#fetch(url, { signal: controller.signal })
      if (response.status === 404) throw new StepPartsError('not_found', `step.parts 上找不到：${url}`)
      if (!response.ok) {
        throw new StepPartsError('network', `step.parts 返回 HTTP ${String(response.status)}`)
      }
      return await response.json()
    } catch (error) {
      if (error instanceof StepPartsError) throw error
      throw new StepPartsError('network', `访问 step.parts 失败：${String(error)}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 搜索。返回可直接渲染、也可直接导入的候选列表。 */
  async search(query: string, limit = 20): Promise<ModelCandidate[]> {
    const url = `${this.#base}/parts?q=${encodeURIComponent(query)}&pageSize=${String(Math.max(1, Math.min(50, limit)))}`
    const body = (await this.#getJson(url)) as { items?: unknown }
    const items = Array.isArray(body.items) ? (body.items as RawPart[]) : []
    return items
      .map((raw) => toCandidate(raw, this.#base))
      .filter((candidate): candidate is ModelCandidate => candidate !== undefined)
  }

  /** 取单件元数据。 */
  async get(partId: string): Promise<ModelCandidate> {
    const body = (await this.#getJson(`${this.#base}/parts/${encodeURIComponent(partId)}`)) as RawPart
    const candidate = toCandidate(body, this.#base)
    if (candidate === undefined) {
      throw new StepPartsError('bad_response', `step.parts 返回的条目缺少 id 或 glbUrl：${partId}`)
    }
    return candidate
  }

  /**
   * 下载某件的 GLB。
   *
   * ★ **两道闸门，量的是不同的东西**：
   *   ① 预检：`byteSize`（**STEP** 大小）≤ {@link StepPartsClientOptions.precheckBytes} —— 只挡明显离谱的
   *   ② 实检：下载后的**实际字节数** ≤ {@link StepPartsClientOptions.maxBytes} —— 这才是真正的闸门
   *
   *   不能用 `byteSize` 直接卡 `maxBytes`：它量的是 STEP，而 GLB 通常小一个数量级
   *   （实测树莓派 4B：STEP 50.1MB → GLB 5.7MB）。那样会拒掉一大批其实装得下的件。
   *
   * ★ 下载后用**内容**校验（GLB 魔数），不信 content-type、不信扩展名。
   */
  async download(partId: string): Promise<{ bytes: Buffer; candidate: ModelCandidate }> {
    const candidate = await this.get(partId)

    if (candidate.byteSize !== undefined && candidate.byteSize > this.#precheckBytes) {
      throw new StepPartsError(
        'too_large',
        `「${candidate.name}」的源文件有 ${(candidate.byteSize / 1024 / 1024).toFixed(0)}MB，` +
          `超过预检上限 ${(this.#precheckBytes / 1024 / 1024).toFixed(0)}MB —— 未下载`,
      )
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, this.#timeoutMs * 6) // 下载给更长的超时
    let bytes: Buffer
    try {
      const response = await this.#fetch(candidate.glbUrl, { signal: controller.signal })
      if (!response.ok) {
        throw new StepPartsError('network', `下载 GLB 失败：HTTP ${String(response.status)}`)
      }
      bytes = Buffer.from(await response.arrayBuffer())
    } catch (error) {
      if (error instanceof StepPartsError) throw error
      throw new StepPartsError('network', `下载 GLB 失败：${String(error)}`)
    } finally {
      clearTimeout(timer)
    }

    // ★ 真正的闸门：按**实际下载到的**字节数判
    if (bytes.length > this.#maxBytes) {
      throw new StepPartsError(
        'too_large',
        `GLB 实际有 ${(bytes.length / 1024 / 1024).toFixed(1)}MB，超过上限 ` +
          `${(this.#maxBytes / 1024 / 1024).toFixed(0)}MB —— 已丢弃`,
      )
    }
    // 内容校验：GLB 魔数 'glTF'
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x46546c67) {
      throw new StepPartsError('bad_response', '下载到的内容不是 GLB（缺少 glTF 魔数）')
    }

    return { bytes, candidate }
  }
}
