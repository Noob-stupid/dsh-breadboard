/**
 * 模型导入：把**用户自己提供的** glTF/GLB 变成场景里的几何。
 *
 * ★ 为什么是"用户提供"而不是"我们采集"
 *   厂商条款约束的是**我们的**批量/自动化采集（"bulk or automated collection"），
 *   并明文保留"individual … in the ordinary course"。**用户自己导入文件，我们不采集、不分发** ——
 *   采集与再分发两个问题同时不存在。
 *   而且模型可以来自**任何**合法渠道（原厂官网 / GrabCAD / 用户自己的 CAD），
 *   那些根本不是 EDA 平台上的 Content。
 *
 * ★ 归一化：外部模型的原点/缩放/朝向由各家自己定，进来**必须**归一到我们的约定，
 *   否则端口锚点会飘出模型外（就是"坐标系混用"那个 bug 换个形式重演）。
 *   归一化目标**只能是契约声明的 `HardwareModel.size`** —— 对已有 modelKey，
 *   尺寸真源不因为换装而改变。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  MODEL_KEY_PATTERN,
  MODEL_MAX_BYTES,
  MODEL_ROUTES,
  modelItemUrl,
} from '../contracts/protocol.ts'
import type { ImportModelResult, ImportedModelList, ImportedModelRecord } from '../contracts/protocol.ts'
import type { ModelOrientation, SourceAxis, Vec3 } from '../contracts/index.ts'
import {
  createPlaceholder,
  disposeOwnedResources,
  type ModelAcquisition,
  type ModelAppearance,
  type ModelProvider,
} from './model-provider.ts'

/** 逐轴缩放比超过该倍数 ⇒ 模型与声明尺寸**长宽比不符**，必须可见告警。 */
const ASPECT_DRIFT_THRESHOLD = 1.15

/**
 * 尺寸排序"分不开"的判定倍数 —— 用于 {@link OrientationResult.ambiguous}。
 *
 * 为什么需要它：包围盒**只能**定出「最长 / 次长 / 最薄」这个**序**，
 * 定不出方向的正负，也定不出哪个面朝上。序**清晰**时按约定挑的那个旋转几乎必然对；
 * 序**不清晰**（两轴接近）时挑哪个纯属约定 ⇒ 必须老实说"这一个是挑的，不是量的"。
 */
const ORIENTATION_AMBIGUITY_RATIO = 1.15

/** 朝向归一化用了哪种约定（名字描述的是**源**模型的朝向）。 */
export type OrientationKind =
  /** 源本来就是 y = 厚（多数 glTF 导出）⇒ 不动。 */
  | 'identity'
  /** 源 z 轴朝上（CAD / STEP 导出的板卡常见）⇒ 转 Rx(-90°)。 */
  | 'z-up'
  /** 源 x 轴朝上 ⇒ 转 Rz(+90°)。 */
  | 'x-up'
  /** 源已是 y 朝上，但长/次长与契约相反 ⇒ 绕 y 轴转 90°。 */
  | 'y-up-swap'
  /** 人工指定（`HardwareModel.orientation`）—— 不是量出来的，是**人定的**。 */
  | 'override'

/** 朝向归一化的结果。 */
export interface OrientationResult {
  readonly kind: OrientationKind
  /** 源坐标 → 契约坐标的旋转矩阵。**恒为真旋转（det = +1）**。 */
  readonly matrix: THREE.Matrix4
  /** 尺寸序不清晰 ⇒ 这个旋转是"按约定挑的"，不是量出来的。 */
  readonly ambiguous: boolean
  /**
   * 人工覆盖**无效**的原因（`undefined` = 没问题）。
   *
   * ★ 无效时**退回自动规则**，而不是产出退化矩阵 ——
   *   覆盖写错（比如 `up` 与 `length` 落在同一条轴上）会让矩阵某一行全零、
   *   `det = 0`，模型直接塌成一张纸。**宁可回到自动规则并报出来，也不要渲染垃圾。**
   */
  readonly invalidOverride?: string
}

/** 归一化结果报告 —— 供界面做**用户可见**的告警。 */
export interface NormalizationReport {
  /** **朝向归一化之后**的包围盒尺寸（米）。与 `targetSize` 逐轴对应。 */
  readonly modelSize: Vec3
  /** **归一化之前**的原始包围盒尺寸（米）。只用于诊断"到底怎么摆的"。 */
  readonly sourceSize: Vec3
  /** 归一化目标（= 契约声明的 `size`）。 */
  readonly targetSize: Vec3
  /** 各轴缩放比（`target / model`）。 */
  readonly scale: Vec3
  /** `max(scale) / min(scale)`；趋近 1 表示未变形。 */
  readonly aspectDrift: number
  /** 用了哪种朝向约定。 */
  readonly orientation: OrientationKind
  /** 朝向是按约定挑的（尺寸序不清晰）⇒ 需要人工确认。 */
  readonly orientationAmbiguous: boolean
  /**
   * `HardwareModel.orientation` **写错了**（`up` 与 `length` 同轴）⇒ 已退回自动规则。
   * 非 `undefined` 就是数据错误，必须让用户看见。
   */
  readonly invalidOrientationOverride?: string
  /** 朝向归一化之后，最长轴仍与目标的最长轴不同 ⇒ 连约定都没救回来。 */
  readonly suspectOrientation: boolean
}

/**
 * 定出「源坐标 → 契约坐标（x=长 / y=厚 / z=宽）」的旋转。
 *
 * ★ 为什么必须是**旋转**，不能是**轴置换**
 *   把三边按长短直接指派给 x/y/z，得到的是一个**置换矩阵**；而 6 种指派里有 **3 种
 *   det = -1（反射）** —— 恰好包含两个真实传感器用到的那一种（源 x>y>z）。
 *   反射会把**模型镜像**，而 `Port.position` 是**手写在归一化坐标系里**的、不会被
 *   一起镜像 ⇒ 板子左右反过来，**端口落到错误的一侧**。
 *   而这两种做法**包围盒一模一样**，任何按尺寸做的检查都发现不了。
 *   ⇒ 本函数只产出 det = +1 的矩阵（枚举验证见 `spike/orient-check.mjs`）。
 *
 * ★ 约定（**量不出来**的那部分，明写在这里，不藏着）
 *   · **最薄的那条轴 = 源模型的"上"**，映到 **+y** —— 板卡/模块都是扁的。
 *   · 其余两轴里**较长的那条映到 +x**。
 *   · 最后一条轴的符号由 det = +1 定出，**不自由**。
 *   这三条把候选从 **4 个**（同一个包围盒对应 4 个真旋转）缩到 1 个。
 *   剩下的不确定性交给 `ambiguous` 与 per-model override，**不在这里猜**。
 *
 * @param override 人工指定（`HardwareModel.orientation`）。**给了就用它，且带符号** ——
 *   符号正是"板子朝哪面 / 长边朝哪头"那个量不出来的自由度。写法无效时**退回自动规则**
 *   并把原因放进 {@link OrientationResult.invalidOverride}（见那里的说明）。
 */
export function orientToContract(sourceSize: Vec3, override?: ModelOrientation): OrientationResult {
  const dims = [sourceSize.x, sourceSize.y, sourceSize.z]
  const order = [0, 1, 2].sort((a, b) => dims[b] - dims[a]) // 长 → 短

  const auto = { length: order[0], up: order[2] }
  let lengthIndex = auto.length
  let upIndex = auto.up
  let signLength = 1
  let signUp = 1
  let kind: OrientationKind =
    auto.length === 0 && auto.up === 1
      ? 'identity'
      : auto.up === 2
        ? 'z-up'
        : auto.up === 0
          ? 'x-up'
          : 'y-up-swap'
  let invalidOverride: string | undefined

  if (override) {
    const up = parseSourceAxis(override.up)
    const length = parseSourceAxis(override.length)
    if (up.index === length.index) {
      invalidOverride =
        `orientation.up 与 orientation.length 落在同一条轴（都是 ${override.up[1]}）` +
        `—— 一条轴不可能同时映到 +y 和 +x。已退回自动规则。`
    } else {
      // ★ 人工指定是**人定的**，不是量出来的 ⇒ 不再谈 ambiguous
      upIndex = up.index
      signUp = up.sign
      lengthIndex = length.index
      signLength = length.sign
      kind = 'override'
    }
  }

  // 行 = 新轴，列 = 源轴：新 x ← 源 length；新 y ← 源 up；新 z ← 剩下那条。
  const remaining = [0, 1, 2].find((axis) => axis !== lengthIndex && axis !== upIndex) ?? 0
  const cols = [lengthIndex, upIndex, remaining]
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  m[0][cols[0]] = signLength
  m[1][cols[1]] = signUp
  // ★ 第三轴的符号**不是自由参数**，它由 det = +1 反解出来 —— 这正是"不会镜像"的全部保证。
  m[2][cols[2]] = permutationSign(cols) * signLength * signUp

  return {
    kind,
    invalidOverride,
    ambiguous:
      !override &&
      (dims[upIndex] * ORIENTATION_AMBIGUITY_RATIO > dims[remaining] ||
        dims[remaining] * ORIENTATION_AMBIGUITY_RATIO > dims[lengthIndex]),
    matrix: new THREE.Matrix4().set(
      m[0][0], m[0][1], m[0][2], 0,
      m[1][0], m[1][1], m[1][2], 0,
      m[2][0], m[2][1], m[2][2], 0,
      0, 0, 0, 1,
    ),
  }
}

/** `'+x'` → `{ index: 0, sign: 1 }`。 */
function parseSourceAxis(value: SourceAxis): { index: number; sign: number } {
  const index = value[1] === 'x' ? 0 : value[1] === 'y' ? 1 : 2
  return { index, sign: value[0] === '-' ? -1 : 1 }
}

/** 置换的符号：偶置换 +1，奇置换 -1。 */
function permutationSign(p: readonly number[]): number {
  let sign = 1
  for (let i = 0; i < p.length; i++)
    for (let j = i + 1; j < p.length; j++) if (p[i] > p[j]) sign = -sign
  return sign
}

/** modelKey 合法性 —— 与宿主同一把尺子（防御性重复校验，别只信服务端）。 */
export function isValidModelKey(modelKey: string): boolean {
  return MODEL_KEY_PATTERN.test(modelKey)
}

/**
 * 把外部模型归一到「**包围盒中心原点** + 契约声明的尺寸 + 契约朝向」。
 *
 * 三步：① 按包围盒定出朝向旋转 → ② 转过去再量、并平移到中心 → ③ 逐轴缩放到目标。
 *
 * ★ 为什么不先缩再转：缩放是**逐轴**的、朝向相关。轴还没摆正就缩，
 *   等于把"长"的缩放比用在"厚"上 —— 正是那种**包围盒看着对、东西是歪的**的错。
 *
 * @returns 包裹层（外层 Group 承载缩放，原对象的变换不被破坏）与报告
 */
export function normalizeToSize(
  object: THREE.Object3D,
  targetSize: Vec3,
  override?: ModelOrientation,
): { object: THREE.Object3D; report: NormalizationReport } {
  // ① 先量**源**尺寸，据此定朝向
  const sourceBox = new THREE.Box3().setFromObject(object)
  const sourceSize = sourceBox.getSize(new THREE.Vector3())
  const orientation = orientToContract({ x: sourceSize.x, y: sourceSize.y, z: sourceSize.z }, override)

  // ② 套一层承载旋转。position 在 T·R·S 里**后于**旋转作用，
  //    所以下面用 position 平移与旋转无耦合 —— 先转后移，两步不打架。
  const oriented = new THREE.Group()
  oriented.name = 'imported-oriented'
  oriented.add(object)
  oriented.quaternion.setFromRotationMatrix(orientation.matrix)

  // ③ 转完再量：此时的尺寸才和 `targetSize` 逐轴对应
  const rotatedBox = new THREE.Box3().setFromObject(oriented)
  const modelSize = rotatedBox.getSize(new THREE.Vector3())
  oriented.position.sub(rotatedBox.getCenter(new THREE.Vector3()))

  // ④ 逐轴缩放到目标尺寸（wrapper 只承载缩放，且 centered 后缩放不破坏居中）
  const scale = new THREE.Vector3(
    axisScale(targetSize.x, modelSize.x),
    axisScale(targetSize.y, modelSize.y),
    axisScale(targetSize.z, modelSize.z),
  )
  const wrapper = new THREE.Group()
  wrapper.name = 'imported-normalized'
  wrapper.add(oriented)
  wrapper.scale.copy(scale)

  const values = [scale.x, scale.y, scale.z]
  const aspectDrift = Math.max(...values) / Math.min(...values)
  const report: NormalizationReport = {
    modelSize: { x: modelSize.x, y: modelSize.y, z: modelSize.z },
    sourceSize: { x: sourceSize.x, y: sourceSize.y, z: sourceSize.z },
    targetSize,
    scale: { x: scale.x, y: scale.y, z: scale.z },
    aspectDrift,
    orientation: orientation.kind,
    orientationAmbiguous: orientation.ambiguous,
    invalidOrientationOverride: orientation.invalidOverride,
    suspectOrientation:
      orientation.kind === 'identity' && longestAxis(modelSize) !== longestAxis(targetSize),
  }
  return { object: wrapper, report }
}

/** 单轴缩放比。模型该轴为 0 时返回 1，避免除零产生 NaN 污染整棵树。 */
function axisScale(target: number, actual: number): number {
  if (!Number.isFinite(actual) || Math.abs(actual) < 1e-9) return 1
  return target / actual
}

/** 最长轴的下标：0=x 1=y 2=z。 */
function longestAxis(size: Vec3): number {
  if (size.x >= size.y && size.x >= size.z) return 0
  return size.y >= size.z ? 1 : 2
}

/* ─────────────────────────── 宿主侧登记表 ─────────────────────────── */

/**
 * 已导入模型的登记表（宿主为持久化真相）。
 *
 * 这里只做**同步读缓存 + 异步刷新**：场景每帧采样时要能同步拿到 URL，
 * 不能等网络。
 */
export class ModelRegistry {
  private records: readonly ImportedModelRecord[] = []
  private loaded = false

  /** 已导入清单（同步读）。 */
  list(): readonly ImportedModelRecord[] {
    return this.records
  }

  /** 是否已经成功拉过一次清单。 */
  isLoaded(): boolean {
    return this.loaded
  }

  find(modelKey: string): ImportedModelRecord | undefined {
    return this.records.find((record) => record.modelKey === modelKey)
  }

  /** 该 modelKey 是否有可用的导入模型。 */
  has(modelKey: string): boolean {
    return this.find(modelKey) !== undefined
  }

  /** 取模型字节的 URL（供 `GLTFLoader` 用）；未导入则 `undefined`。 */
  urlFor(modelKey: string): string | undefined {
    if (!isValidModelKey(modelKey)) return undefined
    // ★ 用契约的 `modelItemUrl()` 拼，**不自己拼** ——
    //   详情：宿主 `WebRoute.path` **不能带尾斜杠**，匹配规则是
    //   `pathname === prefix || pathname.startsWith(prefix + '/')`。
    //   自己拼一旦漏斜杠（`modelbme280`）或前缀带尾斜杠（`.../model//`），
    //   症状是**空 body 404 / 405 且 handler 一行日志都不出** —— 极难查。
    return this.has(modelKey) ? modelItemUrl(modelKey) : undefined
  }

  /** 从宿主拉最新清单。失败不抛 —— 没导过模型也能正常用场景。 */
  async refresh(): Promise<void> {
    try {
      const response = await fetch(MODEL_ROUTES.base)
      if (!response.ok) return
      // 用契约的 `ImportedModelList`（裸数组）而不是内联标注 —— 形状由契约说话
      const data = (await response.json()) as ImportedModelList
      this.records = Array.isArray(data) ? data : []
      this.loaded = true
    } catch {
      /* 宿主不可达时保持空清单 */
    }
  }

  /** 上传一个模型文件。返回宿主的裁决结果。 */
  async upload(modelKey: string, file: File): Promise<ImportModelResult> {
    if (!isValidModelKey(modelKey)) {
      return { ok: false, reason: 'invalid_model_key' }
    }
    if (file.size > MODEL_MAX_BYTES) {
      return { ok: false, reason: 'too_large' }
    }
    try {
      const response = await fetch(modelItemUrl(modelKey), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: file,
      })
      const result = (await response.json()) as ImportModelResult
      if (result.ok) await this.refresh()
      return result
    } catch (error) {
      return { ok: false, reason: String(error) }
    }
  }

  /** 删除一个已导入模型。 */
  async remove(modelKey: string): Promise<boolean> {
    if (!isValidModelKey(modelKey)) return false
    try {
      const response = await fetch(modelItemUrl(modelKey), { method: 'DELETE' })
      if (!response.ok) return false
      await this.refresh()
      return true
    } catch {
      return false
    }
  }
}

/* ─────────────────────────── Provider ─────────────────────────── */

export interface ImportedModelProviderOptions {
  readonly registry: ModelRegistry
  /** 归一化报告回调 —— **必须让用户看得见**（长宽比/朝向异常）。 */
  readonly onNormalized?: (modelKey: string, report: NormalizationReport) => void
}

/**
 * 用**用户导入的 glTF** 换装；没有导入的型号回落到占位盒。
 *
 * 缓存策略见 `model-provider.ts` 的所有权规则：解析结果按 modelKey 缓存一次，
 * 实例拿 `clone()`（共享几何/材质但不拥有），释放权归 provider。
 */
export class ImportedModelProvider implements ModelProvider {
  private readonly registry: ModelRegistry
  private readonly onNormalized: ((modelKey: string, report: NormalizationReport) => void) | undefined
  /** 归一化后的原型（每个 modelKey 一份）。 */
  private readonly prototypes = new Map<string, THREE.Object3D>()
  /** 在途解析（同一 modelKey 并发只解析一次）。 */
  private readonly pending = new Map<string, Promise<THREE.Object3D | null>>()

  constructor(options: ImportedModelProviderOptions) {
    this.registry = options.registry
    this.onNormalized = options.onNormalized
  }

  acquire(
    modelKey: string,
    size: Vec3,
    appearance: ModelAppearance,
    signal: AbortSignal,
    orientation?: ModelOrientation,
  ): ModelAcquisition {
    const placeholder = createPlaceholder(size, appearance.color)
    let disposed = false
    return {
      placeholder,
      ready: this.load(modelKey, size, signal, orientation),
      dispose: () => {
        if (disposed) return
        disposed = true
        // ★ 只释放本次新建的占位；缓存的模型资源归 provider
        disposeOwnedResources(placeholder)
      },
    }
  }

  dispose(): void {
    for (const prototype of this.prototypes.values()) disposeOwnedResources(prototype)
    this.prototypes.clear()
    this.pending.clear()
  }

  /**
   * 丢弃某型号的缓存原型 —— 用户**重新导入**了该型号的新文件时必须调用，
   * 否则会一直用旧模型（缓存比导入新）。
   */
  invalidate(modelKey: string): void {
    const prototype = this.prototypes.get(modelKey)
    if (prototype) {
      disposeOwnedResources(prototype)
      this.prototypes.delete(modelKey)
    }
    this.pending.delete(modelKey)
  }

  private async load(
    modelKey: string,
    size: Vec3,
    signal: AbortSignal,
    orientation?: ModelOrientation,
  ): Promise<THREE.Object3D | null> {
    // ★ 缓存按 modelKey —— 这里隐含"同一型号的 orientation 不变"。
    //   成立，因为 `orientation` 是**契约数据**（`library.ts`），不是用户运行时输入；
    //   改了它要连 `invalidate(modelKey)` 一起走（用户重新导入走的就是那条路）。
    const cached = this.prototypes.get(modelKey)
    if (cached) return cached.clone()

    const inflight = this.pending.get(modelKey)
    if (inflight) return (await inflight)?.clone() ?? null

    const task = this.parseAndNormalize(modelKey, size, signal, orientation)
    this.pending.set(modelKey, task)
    const prototype = await task
    this.pending.delete(modelKey)
    if (!prototype) return null
    this.prototypes.set(modelKey, prototype)
    return prototype.clone()
  }

  private async parseAndNormalize(
    modelKey: string,
    size: Vec3,
    signal: AbortSignal,
    orientation?: ModelOrientation,
  ): Promise<THREE.Object3D | null> {
    const url = this.registry.urlFor(modelKey)
    if (!url) {
      // ★★ **这条必须出声。** 原来它是 `return null` 一句了事 —— 于是
      //   "清单没拉到" 与 "模型文件不存在" 与 "加载失败" 三种情况**在外部完全一样**：
      //   场景里都是占位盒，而且**不报错、不告警、控制台干净**。
      //   实测代价：用户看到"怎么变成占位盒了"，而**没有任何一处能指出为什么**。
      //   ⇒ 静默兜底 = 把「没验」伪装成「验过了」，正是本项目失败族的第 1 形态。
      console.warn(
        `[hardware-sandbox] ${modelKey}：清单里没有它 ⇒ 保留占位盒。` +
          `（registry.isLoaded()=${String(this.registry.isLoaded())}，` +
          `清单条数=${String(this.registry.list().length)}）`,
      )
      return null
    }
    try {
      const gltf = await new GLTFLoader().loadAsync(url)
      // GLTFLoader 不支持 abort；加载完再检查，避免把已卸载场景的对象塞回去
      if (signal.aborted) return null
      const { object, report } = normalizeToSize(gltf.scene, size, orientation)
      this.onNormalized?.(modelKey, report)
      return object
    } catch (error) {
      // 拿不到就保留占位 —— 不重试风暴，不白屏。
      // ★ 但**必须把原因打出来**：否则"加载失败"与"根本没导入"在界面上无法区分。
      console.warn(
        `[hardware-sandbox] ${modelKey}：真模型加载失败 ⇒ 保留占位盒。url=${url}`,
        error,
      )
      return null
    }
  }
}
