/**
 * 交互控制层（设计文档 §4.2.2「交互控制（交互层核心）」）。
 *
 * 四件事：
 *   ① 添加组件（由硬件面板调 {@link InteractionLayer.placeModel}）
 *   ② 拖动组件（pointer 拖拽 + 地面平面投射）
 *   ③ 端口磁吸连线（从端口拖出，靠近目标端口即吸附）
 *   ④ 拔线（点击线缆）
 *
 * ★ 铁律①（公约盒 `cv-muxwsfeb-s7frhb`）：本层**不持有业务状态**。
 *   拖拽期间允许**本地跟手**（否则手感是坏的），但——
 *   · **松手必须发 action**，让宿主 SSOT 成为真相；
 *   · 动作结束（无论成败）由 `onActionSettled` **无条件强制重同步**，把本地跟手的位置抹掉。
 *   ⇒ 本地永远不产生「第二本账」。
 *
 * ★ 铁律②：本层只处理用户输入，不参与 tick 推送。
 *
 * ★ 事件抢占：拖拽组件期间必须**关闭 OrbitControls**（§4.2.2 明写），
 *   否则相机旋转与组件拖拽会同时响应同一个 pointer 序列。
 */
import * as THREE from 'three'
// ★ 值导入：落位高度必须用契约的 restingY，否则板子会陷进地面
import { restingY } from '../contracts/library.ts'
import type { ClientAction, ActionResult } from '../contracts/protocol.ts'
import type { SceneHost, SceneLayer } from './host.ts'
import type { SnapshotSource } from './net.ts'

/** 端口引用。 */
export interface PortRef {
  readonly componentId: string
  readonly portId: string
}

/** 界面提示。 */
export interface Notice {
  readonly text: string
  readonly severity: 'info' | 'warn' | 'error'
}

/**
 * 「此刻该给哪个端口飘标签」。
 *
 * `anchor` 是端口的锚点对象 —— 每帧取它的世界坐标投到屏幕，标签才跟得住相机。
 * 这里交出 `Object3D` 而不是屏幕坐标：**场景层不知道屏幕**，
 * 投影与 DOM 归 UI 层（`client/port-tooltip.ts`）。
 */
export interface PortFocus {
  readonly componentId: string
  readonly portId: string
  /** `Port.name`（丝印名，如 'SDA' / 'VCC'）；查不到时退回 `portId`。 */
  readonly name: string
  readonly anchor: THREE.Object3D
}

export interface InteractionLayerOptions {
  /** 快照来源（拾取时反查 SSOT 实体用）。 */
  readonly source: SnapshotSource
  /** 派发动作给宿主 SSOT。 */
  readonly dispatch: (action: ClientAction) => Promise<ActionResult>
  /** 界面提示（连接被拒等）——**必须让用户看得见**，不能只写 console。 */
  readonly onNotice?: (notice: Notice) => void
  /** 拖拽期间冻结某组件的位置，避免宿主快照把跟手的 mesh 拽回去。 */
  readonly onPositionLock?: (componentId: string | undefined) => void
  /**
   * **动作结束时无条件调用**（成功 / 被拒 / 抛异常三条路径都会走到）——
   * 用于把本地跟手的位置抹掉，按 SSOT 重新调和一次。
   *
   * ★ 为什么不能只在"被拒"时调用：
   *   动作被拒 ⇒ 宿主状态没变 ⇒ `revision` 没变 ⇒ `SceneSyncLayer.apply()` **按 revision 短路**
   *   ⇒ 本地被拖动过的 mesh 会**留在错误位置**，成为第二本账。
   *   短路本身没错，错在它的前提「revision 没变 ⇒ 本地也没变」被一条新路径（动作被拒）破坏了
   *   —— 而那條路径**在写这个优化时还不存在**。
   */
  readonly onActionSettled?: () => void
  /** 端口磁吸距离（米）。指针射线到端口世界坐标的距离小于它才算吸上。 */
  readonly snapDistance?: number
  /**
   * 请求一个右键菜单（命中组件或线缆时）。
   * 坐标是**客户端坐标**，供 UI 层定位菜单。
   */
  readonly onContextMenu?: (
    target: { componentId?: string; cableId?: string },
    position: { x: number; y: number },
  ) => void
  /**
   * 当前活着的端口锚点清单。**必填** —— 见 `nearestPort()` 的说明。
   *
   * ★ 为什么是**必填**而不是可选：可选 = 忘了传就静默失去端口拾取，
   *   而且症状是"有时候不好使"，最难查。**让它编译不过，比让它运行时安静地坏掉好。**
   */
  readonly portMarkers: () => readonly THREE.Object3D[]
  /**
   * 悬停/拖线时该飘标签的端口（`undefined` = 收起来）。
   *
   * ★ 用户的原始要求：「选中或鼠标悬浮变色时，应该在那里漂浮接口文字提示小子，
   *   告诉这是哪个接口」—— 光变色只说明"这是某个端口"，**说不出是哪个**。
   *   端口球太小，丝印在模型上根本读不到（尤其 13px 量级）。
   */
  readonly onPortFocus?: (focus: PortFocus | undefined) => void
}

/** 默认磁吸距离：1.2cm。端口锚点很小，靠射线命中太苛刻，故用"射到点的距离"。 */
const DEFAULT_SNAP_DISTANCE = 0.012

/**
 * **按下时**判定"抓到端口"的邻近半径（米）。
 *
 * ★ 为什么与 `DEFAULT_SNAP_DISTANCE`（悬停用的 12mm）**不是同一个数**：
 *   悬停宽容没有代价（只是亮一下），而按下宽容**会抢走组件拖动**。
 *   逐针之后引脚间距只有 **2.3mm**，若按下也用 12mm，整条排针（44mm × 5mm）
 *   会连成一片"端口区"，**组件就再也拖不动了**。
 *
 * ⇒ 取 **3mm ≈ 1.3 个引脚间距**：手指/鼠标够得着，又不会吞掉板身。
 * ⚠️ 这个数是**按端口密度定的**，不是拍脑袋 —— 换更密的排针时要跟着调。
 */
const PORT_GRAB_DISTANCE = 0.003
/** 悬停色：绿。**只换颜色和可见性，不换尺寸**。 */
/**
 * 悬停高亮色。
 *
 * ★★ 改成**橙色**（2026-10-08，用户要求）。原来的绿 `0x5ef08a` 在**真实模型**上不够醒目 ——
 *   树莓派/ESP32 的 GLB 是**纯白单色**（`baseColorFactor` 全 `(1,1,1,1)`、无贴图、无顶点色），
 *   靠光照出灰白层次；**绿在这种底色上对比度不足**。
 *   ⇒ 橙在灰白底上**跳得出来**，而且与拖线起点的琥珀（{@link PORT_SELECTED_COLOR}）同族，
 *     读作"这里可以接线"。
 */
const PORT_HOVER_COLOR = 0xff8c1a
/** 拖线起点色：琥珀（与预览线同族），读作"这根线锚在这一端"。 */
const PORT_SELECTED_COLOR = 0xffd479
/** 指针位移小于该像素数才算「点击」而非「拖拽/旋转」。 */
const CLICK_SLOP_PX = 4
/** 装配体分组名（与 `SceneSyncLayer` 约定）。 */
const ASSEMBLY_GROUP = 'sandbox.assembly'

type Mode = 'idle' | 'component' | 'cable'

export class InteractionLayer implements SceneLayer {
  private readonly options: InteractionLayerOptions
  private readonly snapDistance: number
  private readonly raycaster = new THREE.Raycaster()
  private readonly pointer = new THREE.Vector2()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly preview: THREE.Line
  private readonly previewGeometry: THREE.BufferGeometry
  private readonly previewMaterial: THREE.LineBasicMaterial
  /**
   * 端口高亮的两个**共享**材质。
   *
   * ★ 契约改成**逐针**之后（rpi-4b 40 个端口），锚点在真模型上是**默认隐藏**的 ——
   *   因为引脚本身就在模型里，40 个标记压上去只是噪音（用户：「不用弄圆球」）。
   *   ⇒ **"高亮"现在同时管两件事：把它变可见 + 上色。**
   *
   * ★ 换材质而不是改颜色：锚点材质是图层级**共享**的，改色会点亮所有同型号端口。
   * ★ `MeshBasicMaterial`（不受光）：高亮要跳出来，受光会随角度变暗。
   */
  private readonly portHoverMaterial: THREE.MeshBasicMaterial
  private readonly portSelectedMaterial: THREE.MeshBasicMaterial
  /** 被换掉材质/可见性的锚点 → 它们的**原值**（用于还回去）。 */
  private readonly highlighted = new Map<
    THREE.Mesh,
    { material: THREE.Material | THREE.Material[]; visible: boolean }
  >()

  private host: SceneHost | undefined
  private mode: Mode = 'idle'
  private dragComponentId: string | undefined
  /** 拖拽起点的 y —— 保持组件原有高度（将来放到面包板上也成立）。 */
  private dragStartY = 0
  private fromPort: PortRef | undefined
  /** 拖线起点的锚点，**开始拖时查一次存下来**（详见 `beginCableDrag`）。 */
  private dragSourceMarker: THREE.Object3D | undefined
  private hoverMarker: THREE.Object3D | undefined
  private hoverPort: PortRef | undefined
  private pendingCableId: string | undefined
  private pointerDownAt = { x: 0, y: 0 }
  private moved = false

  constructor(options: InteractionLayerOptions) {
    this.options = options
    this.snapDistance = options.snapDistance ?? DEFAULT_SNAP_DISTANCE

    this.previewGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(),
      new THREE.Vector3(),
    ])
    this.previewMaterial = new THREE.LineBasicMaterial({
      color: 0xffd479,
      depthTest: false, // 预览线要压在几何之上，否则会被组件挡住
      transparent: true,
      opacity: 0.9,
    })
    this.preview = new THREE.Line(this.previewGeometry, this.previewMaterial)
    this.preview.name = 'sandbox.connect-preview'
    this.preview.renderOrder = 999
    this.preview.visible = false
    // 注：线缆现在是**有粗细的实体**（TubeGeometry/Mesh），射线照常命中，
    // 不再需要放宽 `raycaster.params.Line` 的阈值。

    this.portHoverMaterial = new THREE.MeshBasicMaterial({ color: PORT_HOVER_COLOR, depthTest: false })
    this.portHoverMaterial.name = 'sandbox.port-hover-material'
    this.portSelectedMaterial = new THREE.MeshBasicMaterial({
      color: PORT_SELECTED_COLOR,
      depthTest: false,
    })
    this.portSelectedMaterial.name = 'sandbox.port-selected-material'
  }

  attach(host: SceneHost): void {
    this.host = host
    host.scene.add(this.preview)
    const canvas = host.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('contextmenu', this.onContextMenu)
  }

  dispose(): void {
    const host = this.host
    if (host) {
      const canvas = host.renderer.domElement
      canvas.removeEventListener('pointerdown', this.onPointerDown)
      canvas.removeEventListener('pointermove', this.onPointerMove)
      canvas.removeEventListener('pointerup', this.onPointerUp)
      canvas.removeEventListener('pointercancel', this.onPointerUp)
      canvas.removeEventListener('pointerleave', this.onPointerLeave)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
      host.controls.enabled = true
    }
    this.setHover(undefined, undefined)
    this.preview.removeFromParent()
    this.previewGeometry.dispose()
    this.previewMaterial.dispose()
    // 先把材质与可见性还回去再释放高亮材质 —— 否则残留的锚点会指向已释放的材质
    for (const [mesh, saved] of this.highlighted) {
      mesh.material = saved.material
      mesh.visible = saved.visible
    }
    this.highlighted.clear()
    this.portHoverMaterial.dispose()
    this.portSelectedMaterial.dispose()
    this.host = undefined
  }

  /**
   * 在**当前视野中心**的地面位置放置一个型号。
   * 由硬件面板调用 —— 面板只负责「点了哪个型号」，落点与高度归交互层。
   *
   * ★ `position.y` 必须用契约的 `restingY(modelKey)`（= `size.y / 2`）：
   *   契约的原点约定是**包围盒中心**，所以"平放在地面"就是中心抬到半厚。
   *   写 0 会让板子**陷进地面**（这正是 spike 里反复强调的那个坑）。
   */
  async placeModel(modelKey: string): Promise<void> {
    const host = this.host
    if (!host) return
    const point = this.groundPointAtScreenCenter()
    await this.dispatch({
      kind: 'place_component',
      hardwareModel: modelKey,
      position: { x: point.x, y: restingY(modelKey), z: point.z },
    })
  }

  /* ─────────────────────────── 输入 ─────────────────────────── */

  private onPointerDown = (event: PointerEvent): void => {
    const host = this.host
    if (!host || event.button !== 0) return
    if (!this.updatePointer(event)) return

    this.pointerDownAt = { x: event.clientX, y: event.clientY }
    this.moved = false
    this.pendingCableId = undefined

    // 端口锚点优先（它们小且嵌在组件上）
    const direct = this.pickDirect()
    if (direct?.port) {
      this.beginCableDrag(event, direct.port)
      return
    }
    // ★★ 邻近判定必须在**组件命中之前**（2026-10-08 第二次修）
    //
    //   ⚠️ 第一版写成 `if (!direct?.componentId) { …邻近… }` —— **正好写反了**：
    //     用户点在**引脚**上时，射线打中的是**引脚几何**（属于该组件）
    //     ⇒ `direct.componentId` 有值 ⇒ 邻近兜底**根本不执行** ⇒ 落到拖组件。
    //     而"点在引脚上"**正是**要抓线的那种情况。
    //
    //   ⇒ 正确顺序：**先问"离哪个端口够近"，再问"打中了谁"**。
    //     半径取 3mm（≈1.3 个引脚间距）—— 见 `PORT_GRAB_DISTANCE` 的说明。
    const near = this.nearestPort(PORT_GRAB_DISTANCE)
    if (near) {
      this.beginCableDrag(event, near.ref)
      return
    }

    if (direct?.cableId) {
      // 线缆：先记下，等 pointerup 且未移动才算「点击拔线」
      this.pendingCableId = direct.cableId
      return
    }
    if (direct?.componentId) {
      this.beginComponentDrag(event, direct.componentId)
    }
    // 空白处：交给 OrbitControls，本层不介入
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.updatePointer(event)) return

    const dx = event.clientX - this.pointerDownAt.x
    const dy = event.clientY - this.pointerDownAt.y
    if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX) this.moved = true

    if (this.mode === 'component') {
      this.updateComponentDrag()
      return
    }
    if (this.mode === 'cable') {
      this.updateCableDrag()
      return
    }
    // 空闲态：端口悬停高亮
    const near = this.nearestPort(this.snapDistance)
    this.setHover(near?.marker, near?.ref)
  }

  private onPointerUp = (event: PointerEvent): void => {
    const host = this.host
    if (!host) return
    if (event.button !== 0) return

    const mode = this.mode
    this.mode = 'idle'
    // 拖拽结束一律恢复相机控制
    host.controls.enabled = true

    if (mode === 'component' && this.dragComponentId) {
      const componentId = this.dragComponentId
      this.dragComponentId = undefined
      this.options.onPositionLock?.(undefined)
      const mesh = this.findComponentMesh(componentId)
      if (mesh) {
        // ★ 松手必须发 action —— 本地跟手只是手感，真相在宿主
        void this.dispatch({
          kind: 'move_component',
          componentId,
          position: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
        })
      }
      host.invalidate()
      return
    }

    if (mode === 'cable' && this.fromPort) {
      const from = this.fromPort
      const target = this.hoverPort
      this.fromPort = undefined
      this.dragSourceMarker = undefined
      this.preview.visible = false
      this.setHover(undefined, undefined)
      if (target && !sameRef(from, target)) {
        void this.dispatch({ kind: 'connect', from, to: target })
      } else if (target) {
        this.notice('不能把端口连到它自己', 'info')
      } else {
        this.notice('没有吸附到目标端口，已取消连接', 'info')
      }
      host.invalidate()
      return
    }

    // 未拖动 ⇒ 视为点击：线缆 → 拔线
    if (!this.moved && this.pendingCableId) {
      const cableId = this.pendingCableId
      this.pendingCableId = undefined
      void this.dispatch({ kind: 'disconnect', cableId })
    }
  }

  /**
   * 右键 → 请求菜单。命中组件或线缆才弹，空白处交还给浏览器默认菜单。
   *
   * ★ 这里**只负责"请求"**，菜单本身由 UI 层渲染 —— 场景层不该长出 DOM。
   */
  private onContextMenu = (event: MouseEvent): void => {
    if (!this.host) return
    if (!this.updatePointer(event)) return
    const hit = this.pickDirect()
    if (!hit) return
    event.preventDefault()
    this.options.onContextMenu?.(
      { componentId: hit.componentId, cableId: hit.cableId },
      { x: event.clientX, y: event.clientY },
    )
  }

  private onPointerLeave = (): void => {
    if (this.mode === 'idle') this.setHover(undefined, undefined)
  }

  /* ─────────────────────────── 拖拽 ─────────────────────────── */

  private beginComponentDrag(event: PointerEvent, componentId: string): void {
    const host = this.host
    const mesh = this.findComponentMesh(componentId)
    if (!host || !mesh) return

    // ★ 钉住检查：**前端不是"锁"，只是提前告知**。
    //   真正的拦截在宿主 SSOT 的 `move()` —— DS、其他客户端、脚本都从 action 路由进来，
    //   只拦鼠标等于只拦住了鼠标。这里拦是为了**不让用户白拖一场**。
    if (this.isPinned(componentId)) {
      this.notice('该组件已钉住 —— 右键选「解开钉住」后可移动', 'warn')
      return
    }

    this.mode = 'component'
    this.dragComponentId = componentId
    this.dragStartY = mesh.position.y
    // ★ 关掉 OrbitControls，否则两者抢同一个 pointer 序列
    host.controls.enabled = false
    this.options.onPositionLock?.(componentId)
    this.capturePointer(event)
  }

  /** 钉住状态**只从快照读** —— 前端不存一份，否则就是第二本账。 */
  private isPinned(componentId: string): boolean {
    const spec = this.options.source.latest()?.components.find((item) => item.id === componentId)
    return spec?.pinned === true
  }

  private updateComponentDrag(): void {
    const host = this.host
    const id = this.dragComponentId
    if (!host || !id) return
    const mesh = this.findComponentMesh(id)
    if (!mesh) return
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3())
    if (!point) return
    mesh.position.set(point.x, this.dragStartY, point.z)
    host.invalidate()
  }

  private beginCableDrag(event: PointerEvent, from: PortRef): void {
    const host = this.host
    if (!host) return
    this.mode = 'cable'
    this.fromPort = from
    // ★ 起点锚点在这里**查一次就存下来**。
    //   `getObjectByName` 会遍历整棵场景树，而真树莓派模型有 2000+ 节点 ——
    //   放进 `pointermove`（拖线时每帧都走）就是每帧一次全树遍历。
    this.dragSourceMarker =
      this.hoverMarker && this.hoverPort && sameRef(this.hoverPort, from)
        ? this.hoverMarker
        : this.findPortMarker(from.componentId, from.portId)
    host.controls.enabled = false
    this.capturePointer(event)
    // 起点转琥珀；标签改跟起点 —— 拖起来后指针会离开它，但两者都不该消失
    this.applyPortHighlights()
    this.refreshPortFocus()
  }

  private updateCableDrag(): void {
    const host = this.host
    const from = this.fromPort
    const marker = this.dragSourceMarker
    if (!host || !from || !marker) return

    const start = marker.getWorldPosition(new THREE.Vector3())
    const end = this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3()) ?? start.clone()
    this.previewGeometry.setFromPoints([start, end])
    this.preview.visible = true

    const near = this.nearestPort(this.snapDistance)
    // 不能吸到自己
    if (near && sameRef(near.ref, from)) this.setHover(undefined, undefined)
    else this.setHover(near?.marker, near?.ref)

    host.invalidate()
  }

  /* ─────────────────────────── 拾取 ─────────────────────────── */

  /** 只用到坐标，故接受任何带 clientX/clientY 的事件（pointer / mouse / contextmenu）。 */
  private updatePointer(event: { clientX: number; clientY: number }): boolean {
    const host = this.host
    if (!host) return false
    const rect = host.renderer.domElement.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.pointer, host.camera)
    return true
  }

  /** 直接射线命中：端口 → 线缆 → 组件（按 `MeshUserData` 反查，§4.2.4）。 */
  private pickDirect(): { componentId?: string; cableId?: string; port?: PortRef } | undefined {
    const host = this.host
    const group = host?.scene.getObjectByName(ASSEMBLY_GROUP)
    if (!group) return undefined

    const hits = this.raycaster.intersectObject(group, true)
    for (const hit of hits) {
      // ① 自身即带语义：端口锚点（componentId + portId）与线缆
      const data = hit.object.userData as Record<string, unknown>
      if (typeof data.componentId === 'string' && typeof data.portId === 'string') {
        return { port: { componentId: data.componentId, portId: data.portId } }
      }
      if (typeof data.cableId === 'string') return { cableId: data.cableId }
      // ② 否则**向上找组件根** —— 真几何是 glTF 的整棵子树，命中的往往是深层子节点，
      //    而 `MeshUserData` 只挂在组件根上。
      const owner = findComponentAncestor(hit.object)
      if (owner) return { componentId: owner }
    }
    return undefined
  }

  /**
   * 最近的端口：用**射线到端口世界坐标的距离**判定，而不是直接命中。
   * 端口锚点只有 1.6mm，靠命中太苛刻；磁吸本来就该"够近就吸"。
   *
   * ★ 这里原来有个**按装配 `revision` 缓存**的锚点表，是错的 ——
   *   `SceneSyncLayer.rebuildModel()` **销毁并重建锚点却不改 `revision`**
   *   （导入/清除模型走的就是这条路）⇒ 缓存一直"有效"，里面全是死对象 ⇒
   *   **悬浮与拖线起点判定一起静默失效**（用户报的"有时候变绿有时候不变绿"）。
   *   ⇒ 改成**问持有者**（`options.portMarkers`），不缓存、不猜键。
   */
  private nearestPort(maxDistance: number): { ref: PortRef; marker: THREE.Object3D } | undefined {
    const markers = this.options.portMarkers()

    let best: { ref: PortRef; marker: THREE.Object3D } | undefined
    let bestDistance = maxDistance
    const world = new THREE.Vector3()
    for (const marker of markers) {
      marker.getWorldPosition(world)
      const distance = this.raycaster.ray.distanceToPoint(world)
      if (distance >= bestDistance) continue
      const data = marker.userData as Record<string, unknown>
      bestDistance = distance
      best = {
        ref: { componentId: String(data.componentId), portId: String(data.portId) },
        marker,
      }
    }
    return best
  }

  private findComponentMesh(componentId: string): THREE.Object3D | undefined {
    return this.host?.scene.getObjectByName(`component:${componentId}`)
  }

  private findPortMarker(componentId: string, portId: string): THREE.Object3D | undefined {
    return this.host?.scene.getObjectByName(`port:${componentId}:${portId}`)
  }

  /**
   * 设置端口悬停。
   *
   * ★ **变色，不放大。** 用户的原始要求就是这个，而我第一版做成了"独立指示球" ——
   *   实现上是变色，观感上是个更大的球，于是被提了第二次。
   *   ⇒ 现在直接换锚点自己的材质：几何、`scale`、拾取包围盒**一律不动**。
   */
  private setHover(marker: THREE.Object3D | undefined, ref: PortRef | undefined): void {
    this.hoverMarker = marker
    this.hoverPort = ref
    this.applyPortHighlights()
    this.refreshPortFocus()
  }

  /**
   * 重算该高亮哪些端口 —— **声明式**：算期望集合，再与现状求差。
   *
   * ★ 悬停（绿）+ 拖线起点（琥珀）**可以同时活着**（拖线时指针在目标之间移动）。
   *   写成"设置时顺手清掉上一个"必然漏掉起点、或把原值记错 ⇒ 声明式没有这个状态空间。
   * ★ 现在还要管**可见性**：真模型上的锚点默认隐藏（引脚本身就在模型里），
   *   高亮得先把它变出来。**原值 material 与 visible 一起记、一起还。**
   *
   * ★★ 实测（`spike/raycast-visible.mjs`，three r180）：**射线检测完全无视 `visible`** ——
   *   隐藏的 mesh 照样被命中，**父级 Group 隐藏也照样被命中**。
   *   两个后果，方向相反，都必须知道：
   *   · 好消息：隐藏锚点**不会**弄坏"从端口起拖线"（`pickDirect()` 仍找得到它）。
   *   · 坏消息：隐藏锚点**仍然是点击目标** —— 用户会点到一个**看不见的东西**上，
   *     得到的是"开始拖线"而不是"移动组件"，**而且不知道为什么**。
   *   ⇒ **悬停高亮不是装饰，它是让这些隐形点击区变得诚实的东西**：
   *     指针扫过时那个引脚会亮，用户**在按下之前**就看得到自己会抓到什么。
   */
  private applyPortHighlights(): void {
    const desired = new Map<THREE.Mesh, THREE.Material>()
    const hoverMesh = this.hoverMarker as THREE.Mesh | undefined
    if (hoverMesh?.isMesh) desired.set(hoverMesh, this.portHoverMaterial)

    // 起点**最后**写入 ⇒ 指针悬在起点自己身上时显示琥珀（它是"锚"，不是"目标"）
    const source =
      this.mode === 'cable' && this.fromPort ? (this.dragSourceMarker as THREE.Mesh | undefined) : undefined
    if (source?.isMesh) desired.set(source, this.portSelectedMaterial)

    for (const [mesh, saved] of [...this.highlighted]) {
      if (desired.has(mesh)) continue
      mesh.material = saved.material
      mesh.visible = saved.visible
      this.highlighted.delete(mesh)
    }
    for (const [mesh, material] of desired) {
      if (!this.highlighted.has(mesh)) {
        this.highlighted.set(mesh, { material: mesh.material, visible: mesh.visible })
      }
      if (mesh.material !== material) mesh.material = material
      mesh.visible = true
    }
  }

  /**
   * 把"当前该给谁飘标签"报出去。
   *
   * 优先级：悬停的端口 > 拖线起点（拖起来后指针会离开起点，但标签不该消失）。
   * DOM 由 `panel.ts` 那层渲染 —— **场景层不碰 DOM**。
   */
  private refreshPortFocus(): void {
    const callback = this.options.onPortFocus
    if (!callback) return
    const ref = this.hoverPort ?? (this.mode === 'cable' ? this.fromPort : undefined)
    // ★ 锚点**手上就有**，不要再查树：悬停时 `hoverMarker` 就是它；
    //   拖线起点在 `beginCableDrag` 时存了下来。原来这里走 `getObjectByName`，
    //   而它在**每次 pointermove** 都被调用 —— 真树莓派模型下就是每帧一次全树遍历。
    const anchor = this.hoverPort
      ? this.hoverMarker
      : this.mode === 'cable'
        ? this.dragSourceMarker
        : undefined
    if (!ref || !anchor) {
      callback(undefined)
      return
    }
    callback({
      componentId: ref.componentId,
      portId: ref.portId,
      name: this.portDisplayName(ref),
      anchor,
    })
  }

  /** 端口的丝印名；查不到就退回 `portId`（**永远别给出空标签**）。 */
  private portDisplayName(ref: PortRef): string {
    const spec = this.options.source.latest()?.components.find((item) => item.id === ref.componentId)
    return spec?.ports.find((port) => port.portId === ref.portId)?.name ?? ref.portId
  }

  /* ─────────────────────────── 派发 ─────────────────────────── */

  private async dispatch(action: ClientAction): Promise<void> {
    try {
      const result = await this.options.dispatch(action)
      if (!result.ok) {
        // ★ 被拒必须让用户看得见，**且给出可操作的下一步** —— 只报错误码等于没说
        this.notice(rejectionMessage(result.reason), 'warn')
      }
    } catch (error) {
      this.notice(`动作派发失败：${String(error)}`, 'error')
    } finally {
      // ★ 无条件重调和 —— 三条路径（成功 / !ok / throw）都会让本地偏离投影：
      //   成功时宿主可能调整过位置（吸附/避让）；被拒与异常时宿主状态**根本没变**。
      //   分支会漏，`finally` 不会。
      this.options.onActionSettled?.()
    }
  }

  private notice(text: string, severity: Notice['severity']): void {
    this.options.onNotice?.({ text, severity })
  }

  /** 屏幕中心射到地面的点；打不到（相机平视）时退到原点。 */
  private groundPointAtScreenCenter(): THREE.Vector3 {
    const host = this.host
    if (!host) return new THREE.Vector3(0, 0, 0)
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), host.camera)
    const point = this.raycaster.ray.intersectPlane(this.groundPlane, new THREE.Vector3())
    return point ?? new THREE.Vector3(0, 0, 0)
  }

  private capturePointer(event: PointerEvent): void {
    const canvas = this.host?.renderer.domElement
    // 指针移出画布时仍能收到 pointerup，否则会卡在拖拽态
    try {
      canvas?.setPointerCapture(event.pointerId)
    } catch {
      /* 某些环境不支持，忽略 */
    }
  }
}

function sameRef(a: PortRef | undefined, b: PortRef | undefined): boolean {
  if (!a || !b) return false
  return a.componentId === b.componentId && a.portId === b.portId
}

/**
 * 把宿主的**拒绝原因码**翻成**可操作**的人话。
 *
 * ★ 只显示原因码（如 `component_pinned`）等于没说：用户知道"被拒了"，
 *   但不知道**下一步该干什么**。拒绝提示的价值全在"然后呢"。
 */
function rejectionMessage(reason: string | undefined): string {
  switch (reason) {
    case 'component_pinned':
      return '该组件已钉住 —— 右键选「解开钉住」后再移动'
    case 'protocol_mismatch':
      return '协议不匹配：这两个端口不能相连'
    case 'port_occupied':
      return '该端口已被占用，先拔掉原来的线'
    case 'already_connected':
      // ★ 与 `port_occupied` 分开说：那条是"被别的线占了"，这条是"这根本就是同一根线"。
      //   混成一句，用户会去拔一根不存在的线。
      return '这两个端口之间已经有线了（同一对端口只连一次）'
    case 'voltage_mismatch':
      return '电平不匹配：直接相连可能损坏器件'
    case 'power_exceeded':
      return '供电超限：当前电源带不动这些器件'
    case 'i2c_address_conflict':
      return 'I2C 地址冲突：同一条总线上有两个相同地址的器件'
    case 'unknown_hardware_model':
      return '未知型号：这个型号不在模型库里'
    default:
      return `操作被拒绝（${reason ?? '未知原因'}）`
  }
}

/**
 * 从命中的对象**向上**找带 `componentId` 的祖先（组件根）。
 *
 * 为什么需要：导入的真几何是 glTF 的整棵子树，射线命中的是深处的某个 mesh，
 * 而 `MeshUserData` 挂在组件根上 —— 不做这一步，用户点模型本体就选不中组件。
 */
function findComponentAncestor(object: THREE.Object3D): string | undefined {
  let node: THREE.Object3D | null = object
  while (node) {
    const data = node.userData as Record<string, unknown>
    if (typeof data.componentId === 'string') return data.componentId
    node = node.parent
  }
  return undefined
}
