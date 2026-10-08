/**
 * SceneSync：把 `AssemblySnapshot`（宿主 SSOT 的投影）**调和**成场景图。
 *
 * ★ 铁律①（公约盒 `cv-muxwsfeb-s7frhb`）：前端**不许**持有业务状态的副本。
 *   本层的做法是——**场景图自己就是上一次投影**：
 *   · 不缓存 `AssemblySnapshot`，只缓存 `revision` 水位；
 *   · 增删改一律以「传入的快照」为准去对齐场景图，函数对同一快照幂等；
 *   · 实体身份全部挂在 `mesh.userData`（契约 `MeshUserData`，§4.2.4），
 *     于是拾取到任意 mesh 都能直接反查 SSOT 实体，场景里没有第二本账。
 *
 * ★ 铁律②：本层**只被 rAF 采样驱动**。`apply()` 首行做 `revision` 短路，
 *   因此相机每帧动、宿主 tick 上千次，都不会触发一次多余的场景重建。
 *   宿主虚拟时钟的 tick 从不逐条推到这里。
 *
 * ★ 坐标约定（契约 `contracts/library.ts` 已写死，**不要各写一份**）：
 *   **组件局部坐标原点 = 几何包围盒中心（bbox center）**，x/y/z 三轴统一。
 *   所以 `mesh.position = ComponentSpec.position` 可直接赋值，**无需 translate 偏移**，
 *   旋转也绕自身中心（这正是选居中而非角原点的决定性理由：角原点一转就甩出去）。
 *   几何**尺寸**从契约取，本层只保留颜色/材质。
 *
 * ★ 数据来源是 `SnapshotSource`（`net.ts` 的 `SnapshotChannel` 实现它），
 *   便于单测时换成假实现——本文件不直接碰网络。
 */
import * as THREE from 'three'
import type { AssemblySnapshot, ComponentSpec, MeshUserData, Vec3 } from '../contracts/index.ts'
// ★ 值导入：几何尺寸的唯一出处（共享契约，宿主与前端读同一份）
import { findModel } from '../contracts/library.ts'
import type { SceneHost, SceneLayer } from './host.ts'
import { ProceduralModelProvider, type ModelProvider } from './model-provider.ts'
import type { SnapshotSource } from './net.ts'

/**
 * 前端**表现层**参数：型号 → 基础色。
 *
 * ★ 几何尺寸**不在这里** —— 唯一出处是 `contracts/library.ts` 的 `HardwareModel.size`。
 *   本表只回答「长什么样」；「多大」由契约说话，宿主与前端共用同一份尺寸真相。
 */
const MODEL_COLOR: Readonly<Record<string, number>> = {
  'rpi-4b': 0x2f6f4f,
  bme280: 0x3a6ea5,
  'led-5v': 0xd94f4f,
  breadboard: 0xd8d8d8,
}

const FALLBACK_COLOR = 0x8a8f98

/**
 * 契约里查不到型号时的兜底尺寸（米）。
 * ★ 目的是「未知型号也要能渲染」—— 不白屏、不抛错。
 */
const FALLBACK_SIZE: Vec3 = { x: 0.02, y: 0.01, z: 0.02 }

/**
 * 端口锚点半径 = 组件**水平短边**的这个比例。
 *
 * ★ 按比例而不是固定世界尺寸：否则 55mm 的 ESP32 与 165mm 的面包板
 *   会得到视觉重量完全不同的锚点。
 * ★ 取 `min(size.x, size.z)`（水平短边）而不是三轴最小值 ——
 *   板卡普遍很薄（树莓派 17mm、BME280 只有 3mm），按三轴最小值会让锚点小到看不见。
 */
const PORT_RADIUS_RATIO = 0.03
/** 半径上下限（米）：防止极小/极大组件上锚点消失或糊成一片。 */
const PORT_RADIUS_MIN = 0.0006
const PORT_RADIUS_MAX = 0.002
/** 端口锚点直径 / 最近邻端口间距。 **必须 < 1**，否则相邻锚点互相重叠。 */
const PORT_MARKER_DENSITY = 0.8

/**
 * 端口锚点半径：**优先按"与最近邻端口的距离"定，而不是按器件尺寸定**。
 *
 * ★ 为什么改：契约改成**逐针**之后（rpi-4b 6 → 40、esp32 0 → 30），
 *   旧的"按板子短边 ×3%"给出 ~1.7mm 半径 ⇒ 直径 3.4mm；
 *   而排针间距在模型里是 **2.32mm**（真 2.54mm 被缩放压过，见 `HardwareModel.size` 的说明）
 *   ⇒ **相邻锚点重叠，40 个锚点糊成一条**。器件的"大小"和它的"端口密度"是两回事。
 *
 * ★ 少数端口（bme280 只有 4 个）时最近邻距离很大 ⇒ 用旧公式兜底并夹在上下限之间，
 *   否则会得到一块巨大的圆盘。
 */
function portMarkerRadius(spec: ComponentSpec, size: Vec3): number {
  const fallback = Math.min(
    PORT_RADIUS_MAX,
    Math.max(PORT_RADIUS_MIN, Math.min(size.x, size.z) * PORT_RADIUS_RATIO),
  )
  const ports = spec.ports
  if (ports.length < 2) return fallback

  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < ports.length; i++) {
    for (let j = i + 1; j < ports.length; j++) {
      const a = ports[i]?.position
      const b = ports[j]?.position
      if (!a || !b) continue
      const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
      if (d > 1e-9 && d < nearest) nearest = d
    }
  }
  if (!Number.isFinite(nearest)) return fallback
  const byDensity = (nearest * PORT_MARKER_DENSITY) / 2
  // 上限仍用旧公式的两倍：密排时按密度，稀疏时不至于缩成一个点
  return Math.min(fallback * 2, Math.max(PORT_RADIUS_MIN, byDensity))
}

/** 未指定颜色时的线缆色。 */
const DEFAULT_CABLE_COLOR = 0x66ccff

/** 线缆半径（米）—— 0.8mm，接近真实跳线，不是屏幕上的一条 1px 线。 */
const CABLE_RADIUS = 0.0008
/**
 * 走线净空（米）：抬到两端端口最高点之上这么多。
 * 保证线从组件**上方**跨过，而不是穿过板子。
 */
const CABLE_CLEARANCE = 0.014

/** 告警高亮色。 */
const WARNING_COLOR = 0xff5533

interface ComponentVisual {
  /**
   * 组件根：承载**位置/旋转**与 `MeshUserData`。
   * 几何作为子节点挂上去 —— 因为真几何可能是 glTF 的**整棵子树**，不是单个 mesh。
   * ★ 端口锚点也挂在 root 上：它们的位置由**契约**决定，不受几何归一化缩放影响。
   */
  readonly root: THREE.Group
  /** 当前几何槽（占位盒；换装后是归一化过的真模型）。 */
  slot: THREE.Object3D
  readonly portMarkers: THREE.Mesh[]
  /** 释放**本次获取**（占位）。共享的模型资源归 provider，不在此释放。 */
  readonly release: () => void
  /** 取消在途的异步换装（组件被删时）。 */
  cancelSwap: () => void
  /** 告警高亮框（懒建：没有告警的组件不背这个盒子）。 */
  highlight?: THREE.Mesh
  /**
   * 钉住标记（懒建）。
   *
   * ★ 必须有**可见标记**：否则用户拖不动却不知道为什么 ——
   *   "没反应"和"被钉住"在界面上必须能分开。
   */
  pinMarker?: THREE.Mesh
  /** 端口签名：变了才重建锚点，避免每次 revision 变更都 churn。 */
  portSignature: string
  /** 是否已经换上**真几何**（决定端口锚点的默认可见性）。 */
  swapped: boolean
  /** 锚点整体的默认可见性（交互层高亮时会临时覆盖单个锚点）。 */
  markersVisible: boolean
}

interface CableVisual {
  readonly mesh: THREE.Mesh
  readonly material: THREE.MeshStandardMaterial
  /** 走线几何：端点变化时**整体重建**（tube 不能原地改点）。 */
  geometry: THREE.TubeGeometry
  /** 走线签名：端点没变就不重建。 */
  routeSignature: string
}

export interface SceneSyncLayerOptions {
  /** 快照来源（同步读）。 */
  readonly source: SnapshotSource
  /**
   * 几何来源。默认 `ProceduralModelProvider`（按契约尺寸的占位盒）。
   * 接入外部几何（远程建模库 / 本地 glTF）时只换这一个实现 —— 归一化契约见
   * `model-provider.ts` 文件头。
   */
  readonly models?: ModelProvider
}

export class SceneSyncLayer implements SceneLayer {
  private readonly source: SnapshotSource
  private readonly group = new THREE.Group()
  private readonly components = new Map<string, ComponentVisual>()
  private readonly cables = new Map<string, CableVisual>()

  /** 端口锚点共用几何/材质（图层级，dispose 时统一释放）。 */
  /**
   * 端口锚点共用几何：**单位球**，实际大小由每个锚点的 `scale` 决定。
   *
   * ★ 分段数从 8×6 提到 16×12：原来那个太粗，小球在屏幕上就是个**发虚的多边形团** ——
   *   用户反馈的"太模糊"主要来自这里，不是材质问题。
   */
  /**
   * 端口锚点几何：**扁平圆柱**（半径 1、高 0.12），不是球。
   *
   * ★ 为什么不是球：契约改成逐针后（rpi-4b 40 个），球会糊成一条；
   *   而且用户明确说了「不用弄圆球」。扁圆柱贴在引脚上读作"这一根针"。
   * ★ 为什么不留成零厚度的圆片：那样相机一压低就侧过来看不见了。
   */
  private readonly portGeometry = new THREE.CylinderGeometry(1, 1, 0.12, 16)
  /**
   * ★ 用**受光**材质而不是 `MeshBasicMaterial`：后者不参与光照，
   *   球体没有任何明暗过渡，看上去就是一块平的色斑。
   */
  private readonly portMaterial = new THREE.MeshStandardMaterial({
    color: 0xffd479,
    emissive: 0xffa62b,
    emissiveIntensity: 0.35,
    roughness: 0.35,
    metalness: 0.25,
  })

  private readonly models: ModelProvider
  /** 场景卸载时 abort；供未来的异步几何来源取消在途请求。 */
  private readonly abort = new AbortController()

  private host: SceneHost | undefined
  private detachFrame: (() => void) | undefined

  /** 已**渲染**到的 revision（水位），用于短路。 */
  private appliedRevision = -1
  /** 已**观察到**的 revision，用于决定是否需要重绘。 */
  private seenRevision = -1
  /**
   * 位置冻结的组件 id（拖拽期间）。
   * 拖拽时本地跟手，若此刻宿主推来新快照把 mesh 拽回原位，手感会抖；
   * 故拖拽期间**只跳过这一个组件的位置/旋转写入**，其余照常调和。
   */
  private positionLockId: string | undefined
  /** 已卸载：异步换装回调据此丢弃迟到的结果，不再往已拆的场景里塞对象。 */
  private disposed = false

  constructor(options: SceneSyncLayerOptions) {
    this.source = options.source
    this.models = options.models ?? new ProceduralModelProvider()
    this.group.name = 'sandbox.assembly'
  }

  attach(host: SceneHost): void {
    this.host = host
    host.scene.add(this.group)
    // 每帧只做「revision 变了没」的廉价比对；真正重建留给 apply()
    this.detachFrame = host.addFrameCallback(() => {
      this.poll()
    })
  }

  /**
   * 由 `SceneHost` 在**重绘前**调用。
   * 首行按 revision 短路 —— 相机移动导致的每帧重绘不会重复重建场景。
   */
  apply(): void {
    const snapshot = this.source.latest()
    if (!snapshot) return
    if (snapshot.revision === this.appliedRevision) return
    this.appliedRevision = snapshot.revision
    this.reconcile(snapshot)
  }

  /**
   * 某型号的**几何来源变了**（如用户刚导入/清除了模型文件）：
   * 拆掉该型号所有组件的视觉，并强制重调和让它们按新几何重建。
   *
   * 为什么必须显式做：`apply()` 按 `revision` 短路，而"导入一个模型文件"
   * **不会改变装配状态**（组件还在原处）⇒ revision 不变 ⇒ 不重建 ⇒ 用户导入完看不见变化。
   */
  rebuildModel(modelKey: string): void {
    const snapshot = this.source.latest()
    if (snapshot) {
      for (const spec of snapshot.components) {
        if (spec.hardwareModel !== modelKey) continue
        const visual = this.components.get(spec.id)
        if (!visual) continue
        this.group.remove(visual.root)
        this.disposeVisual(visual)
        this.components.delete(spec.id)
      }
    }
    this.forceResync()
  }

  /**
   * 当前场景里**活着的**端口锚点清单。
   *
   * ★ 为什么由本层提供，而不是让交互层自己去 `scene.traverse()` 找：
   *   锚点是**本层创建、本层销毁**的（`disposeVisual()` 里清空 `portMarkers`）。
   *   消费方自己去场景里重新"发现"一遍，等于维护**第二本账** ——
   *   而那本账只能在"装配 `revision` 变了"时被刷新，可是
   *   **`rebuildModel()` 销毁并重建锚点、却不改 `revision`**（导入/清除模型走的正是这条路）
   *   ⇒ 缓存里全是已销毁的对象 ⇒ **端口拾取静默失效**（悬浮与拖线起点一起坏）。
   *
   *   ⇒ **问持有者，就没有"什么时候该失效"这个问题。** 不缓存、不猜键、不订阅。
   *     代价是每次调用 O(组件数) —— 而端口总数是个位到几十，比随后的射线检测便宜得多。
   */
  portMarkers(): readonly THREE.Object3D[] {
    const out: THREE.Object3D[] = []
    for (const visual of this.components.values()) {
      for (const marker of visual.portMarkers) {
        // 刚被重建、正在摘下的锚点跳过 —— 交给消费方的**永远是活对象**
        if (marker.parent) out.push(marker)
      }
    }
    return out
  }

  /** 冻结某组件的位置（拖拽期间用）；传 `undefined` 解冻。 */
  setPositionLock(componentId: string | undefined): void {
    this.positionLockId = componentId
  }

  /**
   * 强制按当前快照重新调和一次 —— 用于**动作被拒**后抹掉本地跟手的位置。
   *
   * 为什么需要它：`apply()` 按 `revision` 短路，而"动作被拒"时宿主状态没变、
   * `revision` 也不变 ⇒ 本地被拖动过的 mesh 会**留在错误位置**，成为第二本账。
   * 这里只降渲染水位（不动 `seenRevision`，避免与 `poll()` 打架）。
   */
  forceResync(): void {
    this.appliedRevision = -1
    this.host?.invalidate()
  }

  dispose(): void {
    this.disposed = true
    this.abort.abort()
    this.detachFrame?.()
    this.detachFrame = undefined

    for (const visual of this.components.values()) this.disposeVisual(visual)
    this.components.clear()

    for (const cable of this.cables.values()) this.disposeCable(cable)
    this.cables.clear()

    this.portGeometry.dispose()
    this.portMaterial.dispose()
    this.group.removeFromParent()
    this.host = undefined
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  /** 观察：revision 前进 → 标脏，让 host 触发一次重绘（进而走 apply()）。 */
  private poll(): void {
    const snapshot = this.source.latest()
    if (!snapshot || snapshot.revision === this.seenRevision) return
    this.seenRevision = snapshot.revision
    this.host?.invalidate()
  }

  private reconcile(snapshot: AssemblySnapshot): void {
    this.reconcileComponents(snapshot)
    // 线缆端点要用组件的世界变换，先刷新一次矩阵
    this.group.updateMatrixWorld(true)
    this.reconcileCables(snapshot)
    this.applyWarnings(snapshot)
  }

  private reconcileComponents(snapshot: AssemblySnapshot): void {
    const present = new Set<string>()

    for (const spec of snapshot.components) {
      present.add(spec.id)
      let visual = this.components.get(spec.id)
      if (!visual) {
        visual = this.createVisual(spec)
        this.components.set(spec.id, visual)
        this.group.add(visual.root)
      }

      if (spec.id !== this.positionLockId) {
        visual.root.position.set(spec.position.x, spec.position.y, spec.position.z)
        visual.root.rotation.set(spec.rotation.x, spec.rotation.y, spec.rotation.z)
      }

      const data: MeshUserData = { componentId: spec.id }
      visual.root.userData = data

      // ★ 钉住状态**只从快照读**，前端不存 —— 本地存就是第二本账，
      //   一次 resync 就会静默丢掉它（用户会看到"我钉住的又松了"，且无任何报错）。
      this.applyPinned(visual, spec.pinned === true)

      const signature = portSignature(spec)
      if (signature !== visual.portSignature) {
        this.rebuildPortMarkers(spec, visual)
        visual.portSignature = signature
      }
    }

    for (const [id, visual] of this.components) {
      if (present.has(id)) continue
      this.group.remove(visual.root)
      this.disposeVisual(visual)
      this.components.delete(id)
    }
  }

  private reconcileCables(snapshot: AssemblySnapshot): void {
    const present = new Set<string>()

    for (const connection of snapshot.connections) {
      const from = this.portWorld(connection.from.componentId, connection.from.portId, snapshot)
      const to = this.portWorld(connection.to.componentId, connection.to.portId, snapshot)
      // 端点组件/端口尚未落到场景（或已被删）时跳过，等下一次 revision
      if (!from || !to) continue
      present.add(connection.cableId)

      // ★ 横平竖直走线：所有线段都平行于坐标轴
      const points = routePoints(from, to)
      const signature = signatureOfRoute(points)

      let cable = this.cables.get(connection.cableId)
      if (!cable) {
        const geometry = buildCableGeometry(points)
        const material = new THREE.MeshStandardMaterial({
          color: cableColor(connection.color),
          roughness: 0.55,
          metalness: 0.05,
        })
        const mesh = new THREE.Mesh(geometry, material)
        mesh.name = `cable:${connection.cableId}`
        cable = { mesh, geometry, material, routeSignature: signature }
        this.cables.set(connection.cableId, cable)
        this.group.add(mesh)
      } else if (cable.routeSignature !== signature) {
        // 端点动了 ⇒ 整条走线重建（tube 的顶点无法原地改）
        const geometry = buildCableGeometry(points)
        cable.mesh.geometry = geometry
        cable.geometry.dispose()
        cable.geometry = geometry
        cable.routeSignature = signature
      }

      const data: MeshUserData = { cableId: connection.cableId, protocol: connection.protocol }
      cable.mesh.userData = data
    }

    for (const [id, cable] of this.cables) {
      if (present.has(id)) continue
      this.group.remove(cable.mesh)
      this.disposeCable(cable)
      this.cables.delete(id)
    }
  }

  /**
   * 按告警给相关组件加高亮外框（`info` 级不打扰）。
   *
   * ★ 为什么是**外框**而不是改材质自发光：
   *   真几何的材质是**按 modelKey 缓存共享**的（实例只拿到 `clone()`），
   *   改一个实例的 `emissive` 会**点亮所有同型号组件** —— 那正是共享资源被实例状态污染。
   *   外框是每实例独有的对象，不碰任何共享资源。
   */
  private applyWarnings(snapshot: AssemblySnapshot): void {
    const flagged = new Set<string>()
    for (const warning of snapshot.warnings) {
      if (warning.severity === 'info') continue
      for (const ref of warning.refs ?? []) flagged.add(ref.componentId)
    }
    for (const [id, visual] of this.components) {
      const on = flagged.has(id)
      if (!on) {
        if (visual.highlight) visual.highlight.visible = false
        continue
      }
      if (!visual.highlight) visual.highlight = this.createHighlight(visual)
      visual.highlight.visible = true
    }
  }

  /** 告警外框：略大于几何包围盒的半透明红框。 */
  private createHighlight(visual: ComponentVisual): THREE.Mesh {
    const box = new THREE.Box3().setFromObject(visual.slot).getSize(new THREE.Vector3())
    const geometry = new THREE.BoxGeometry(
      Math.max(box.x, 1e-4) * 1.06,
      Math.max(box.y, 1e-4) * 1.06,
      Math.max(box.z, 1e-4) * 1.06,
    )
    const material = new THREE.MeshBasicMaterial({
      color: WARNING_COLOR,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'warning-highlight'
    visual.root.add(mesh)
    return mesh
  }

  /**
   * 按快照里的 `pinned` 反映钉住标记。
   *
   * ★ **只反映，不记住** —— 状态源永远是快照。前端不许存一份"我以为的钉住状态"：
   *   那就是第二本账，一次 `resync` 就会静默丢掉它。
   */
  private applyPinned(visual: ComponentVisual, pinned: boolean): void {
    if (!pinned) {
      if (visual.pinMarker) visual.pinMarker.visible = false
      return
    }
    if (!visual.pinMarker) visual.pinMarker = this.createPinMarker(visual)
    visual.pinMarker.visible = true
  }

  /** 钉住标记：组件正上方悬浮的小八面体（琥珀色）。 */
  private createPinMarker(visual: ComponentVisual): THREE.Mesh {
    const box = new THREE.Box3().setFromObject(visual.slot)
    const size = box.getSize(new THREE.Vector3())
    const radius = Math.max(Math.max(size.x, size.z) * 0.11, 0.0012)
    const geometry = new THREE.OctahedronGeometry(radius)
    const material = new THREE.MeshStandardMaterial({
      color: 0xffc266,
      emissive: 0xff9a2b,
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.3,
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = 'pin-marker'
    // 放在几何**顶面之上**留一点空隙（组件原点是包围盒中心 ⇒ 顶面在 box.max.y）
    mesh.position.set(0, box.max.y + radius * 1.8, 0)
    visual.root.add(mesh)
    return mesh
  }

  private createVisual(spec: ComponentSpec): ComponentVisual {
    // ★ 尺寸唯一出处 = 契约（contracts/library.ts）。
    //   原点约定 = 包围盒中心（契约写死），故 root.position 可直接用 ComponentSpec.position，
    //   不需要任何 translate 偏移；旋转亦绕自身中心。
    const size = findModel(spec.hardwareModel)?.size ?? FALLBACK_SIZE
    const color = MODEL_COLOR[spec.hardwareModel] ?? FALLBACK_COLOR
    // `orientation` 一路传到归一化：契约声明了它，就得有人消费
    const acquisition = this.models.acquire(spec.hardwareModel, size, { color }, this.abort.signal, findModel(spec.hardwareModel)?.orientation)

    const root = new THREE.Group()
    root.name = `component:${spec.id}`
    root.add(acquisition.placeholder)

    let cancelled = false
    const visual: ComponentVisual = {
      root,
      slot: acquisition.placeholder,
      portMarkers: [],
      release: acquisition.dispose,
      cancelSwap: () => {
        cancelled = true
      },
      portSignature: '',
      swapped: false,
      markersVisible: true,
    }

    // ★ 异步换装：真几何到位后**原地替换**占位。
    //   所有权清楚，所以这里没有"换装后旧几何归谁释放"的悬念：
    //   · 占位 —— 由 `acquisition.dispose()` 释放（即便已从树上摘下也无妨）
    //   · 真几何 —— 归 provider 的缓存，实例释放**不得**碰它
    void acquisition.ready
      .then((better) => {
        if (cancelled || !better || this.disposed) return
        root.remove(acquisition.placeholder)
        root.add(better)
        visual.slot = better
        visual.swapped = true
        // ★ 真几何里**引脚本身是可见的** ⇒ 锚点标记就该退场。
        //   用户：「只有排针高亮不就行了，不用弄圆球」—— 40 个标记压在真引脚上是噪音。
        //   高亮仍然起作用：交互层会让**指着的那一个**临时可见（见 interaction.ts）。
        this.setPortMarkersVisible(visual, false)
        this.host?.invalidate()
      })
      .catch(() => {
        // Provider 约定 resolve(null) 而不 reject；这里只是兜底，不重试
      })

    return visual
  }

  /**
   * 端口锚点挂在组件 mesh 下，随组件世界变换自动跟随。
   *
   * ★ 尺寸**不再按板子大小取，而是按"与最近邻端口的距离"取**。
   *   契约改成**逐针**之后（rpi-4b 6 → 40、esp32 0 → 30），
   *   按 `min(size.x, size.z) × 3%` 算出来是 ~1.7mm 半径 ⇒ 直径 3.4mm，
   *   而排针间距被缩放压到 **2.32mm** ⇒ **相邻锚点互相重叠，40 个球糊成一条**。
   *   ⇒ 锚点大小必须**由端口自身的密度决定**，而不是由器件尺寸决定。
   *
   * ★ 形状从**圆球**改成**扁平圆柱**（用户：「只有排针高亮不就行了，不用弄圆球」）。
   *   扁的贴在引脚上读作"这一根针"，圆的读作"这里有个球"。
   */
  private rebuildPortMarkers(spec: ComponentSpec, visual: ComponentVisual): void {
    for (const marker of visual.portMarkers) {
      marker.removeFromParent()
    }
    visual.portMarkers.length = 0

    const size = findModel(spec.hardwareModel)?.size ?? FALLBACK_SIZE
    const radius = portMarkerRadius(spec, size)

    for (const port of spec.ports) {
      const marker = new THREE.Mesh(this.portGeometry, this.portMaterial)
      marker.position.set(port.position.x, port.position.y, port.position.z)
      // 单位圆柱（半径 1、高 0.12）⇒ 用 scale 定大小。
      // ★ 交互层改的是**材质与可见性**，不改 scale —— 两套反馈不并存，见 interaction.ts
      marker.scale.set(radius, radius, radius)
      marker.name = `port:${spec.id}:${port.portId}`
      const data: MeshUserData = {
        componentId: spec.id,
        portId: port.portId,
        protocol: port.protocol,
        voltage: port.voltage,
      }
      marker.userData = data
      visual.root.add(marker)
      visual.portMarkers.push(marker)
    }

    // 占位盒阶段锚点要可见（否则用户没有"接哪儿"的视觉线索）；
    // 换上**真模型**之后引脚本身就是可见的 ⇒ 由 `setPortMarkersVisible` 关掉。
    this.setPortMarkersVisible(visual, visual.swapped)
  }

  /** 端口锚点整体的默认可见性（交互层的高亮会临时覆盖单个锚点）。 */
  setPortMarkersVisible(visual: ComponentVisual, visible: boolean): void {
    visual.markersVisible = visible
    for (const marker of visual.portMarkers) marker.visible = visible
  }

  /** 端口局部坐标 → 世界坐标（`Port.position` 是组件局部坐标）。 */
  private portWorld(
    componentId: string,
    portId: string,
    snapshot: AssemblySnapshot,
  ): THREE.Vector3 | undefined {
    const visual = this.components.get(componentId)
    if (!visual) return undefined
    const spec = snapshot.components.find((candidate) => candidate.id === componentId)
    if (!spec) return undefined
    const port = spec.ports.find((candidate) => candidate.portId === portId)
    if (!port) return undefined
    const local = new THREE.Vector3(port.position.x, port.position.y, port.position.z)
    return visual.root.localToWorld(local)
  }

  private disposeVisual(visual: ComponentVisual): void {
    visual.cancelSwap()
    for (const marker of visual.portMarkers) marker.removeFromParent()
    visual.portMarkers.length = 0
    // 只释放**本次获取**（占位）；真几何归 provider 的缓存，实例无权释放
    visual.release()
    const highlight = visual.highlight
    if (highlight) {
      highlight.removeFromParent()
      highlight.geometry.dispose()
      const material = highlight.material
      if (Array.isArray(material)) for (const item of material) item.dispose()
      else material.dispose()
      visual.highlight = undefined
    }
    const pinMarker = visual.pinMarker
    if (pinMarker) {
      pinMarker.removeFromParent()
      pinMarker.geometry.dispose()
      const material = pinMarker.material
      if (Array.isArray(material)) for (const item of material) item.dispose()
      else material.dispose()
      visual.pinMarker = undefined
    }
    visual.root.clear()
  }

  private disposeCable(cable: CableVisual): void {
    cable.geometry.dispose()
    cable.material.dispose()
  }
}

/** 端口签名：id + 局部坐标。变了才需要重建锚点。 */
function portSignature(spec: ComponentSpec): string {
  return spec.ports
    .map((port) => `${port.portId}@${port.position.x},${port.position.y},${port.position.z}`)
    .join('|')
}

/** 线缆颜色：契约给的是十六进制字符串，解析失败则回落默认色。 */
function cableColor(color: string | undefined): number {
  if (!color) return DEFAULT_CABLE_COLOR
  try {
    return new THREE.Color(color).getHex()
  } catch {
    return DEFAULT_CABLE_COLOR
  }
}

/**
 * 横平竖直走线（Manhattan routing）。
 *
 * 路径一律由**平行于坐标轴的线段**组成：
 * ```
 * a ──(垂直抬升)──▶ 走线高度 ──(沿 X)──▶ ──(沿 Z)──▶ ──(垂直落下)──▶ b
 * ```
 *
 * ★ 为什么不用两点直连：直连是**斜线**，多条连接叠在一起时无法分辨哪条去哪，
 *   俯视图里就是一团乱麻。横平竖直让每条线都能被追踪 —— 这也正是真实线束
 *   与 PCB 走线的组织方式。
 */
function routePoints(a: THREE.Vector3, b: THREE.Vector3): THREE.Vector3[] {
  // 抬到两端端口最高点之上：线从组件**上方**跨过，而不是穿过板子
  const height = Math.max(a.y, b.y) + CABLE_CLEARANCE
  const raw = [
    a.clone(),
    new THREE.Vector3(a.x, height, a.z),
    new THREE.Vector3(b.x, height, a.z),
    new THREE.Vector3(b.x, height, b.z),
    b.clone(),
  ]
  // 去掉重合点：零长度线段会让曲线切线出现 NaN
  const out: THREE.Vector3[] = []
  for (const point of raw) {
    const last = out[out.length - 1]
    if (last && last.distanceToSquared(point) < 1e-12) continue
    out.push(point)
  }
  return out
}

/** 走线签名：端点没变就不重建几何（重建 tube 比挪顶点贵得多）。 */
function signatureOfRoute(points: readonly THREE.Vector3[]): string {
  return points.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)},${p.z.toFixed(6)}`).join('|')
}

/** 沿走线生成**有粗细**的线缆；折线走 tube，拐角是干净的直角。 */
function buildCableGeometry(points: readonly THREE.Vector3[]): THREE.TubeGeometry {
  const path = new THREE.CurvePath<THREE.Vector3>()
  for (let index = 0; index < points.length - 1; index += 1) {
    path.add(new THREE.LineCurve3(points[index], points[index + 1]))
  }
  const length = path.getLength()
  // 每 2mm 一段并夹在 [8, 240]：够平滑，又不会为长线生成过多三角形
  const tubularSegments = Math.max(8, Math.min(240, Math.round(length / 0.002)))
  return new THREE.TubeGeometry(path, tubularSegments, CABLE_RADIUS, 6, false)
}
