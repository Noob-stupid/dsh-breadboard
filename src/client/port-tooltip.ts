/**
 * 端口名浮标 —— 悬停/拖线时在端口旁边浮出 `Port.name`。
 *
 * ★ 用户的原话：「选中或鼠标悬浮**变色**时，应该在那里漂浮**接口文字提示小子**，
 *   告诉这是哪个接口」。光变色只说明"这是某个端口"，**说不出是哪个** ——
 *   端口球在屏幕上只有几个像素，模型自带的丝印根本读不到。
 *
 * ★ 为什么用 **HTML 浮层**而不是 `Sprite` / `CSS2DRenderer`：
 *   · 文字在任何缩放/DPI 下都是**清晰**的（Sprite 要烤纹理，放大会糊）；
 *   · 样式、圆角、字体直接吃 CSS，不用管 `CanvasTexture` 的尺寸/内存/释放；
 *   · 不需要为了一个标签把 `CSS2DRenderer` 叠一层（那会再引入一条渲染循环）。
 *
 * ★ 为什么投影更新走 `addFrameCallback` 而不是 React state：
 *   每帧 `setState` 会让整棵树 60fps 重渲染。这里直接改 `transform`，
 *   **完全不经过 React** —— 标签是纯 DOM，与渲染树无关。
 */
import * as THREE from 'three'
import type { SceneHost } from '../scene/host.ts'
import type { PortFocus } from '../scene/interaction.ts'

/** 标签相对端口的像素偏移：抬到锚点上方。 */
const LABEL_OFFSET_Y = -14
/** 标签最大宽度（像素）。丝印名可能很长（实测有 `I2C1 (SDA1/SCL1 · pin3/5)`）。 */
const LABEL_MAX_WIDTH = 240

/**
 * 把 `portId` 与 `name` 切成「主 + 副」。
 *
 * ★ 契约约定（见 `Port.name`）：`name` **只承载增量信息**（丝印/引脚），
 *   标识由 `portId` 给；**`name === portId` 合法且常见**（`VCC` / `GND`）——
 *   消费方**判等即可，不必剥前缀**。
 *
 * ★ 这条我改过一次：`name` 原本写成 `I2C1 (SDA1/SCL1 · pin3/5)`（把 id 也塞了进去），
 *   于是我在这里写了套"剥掉 portId 前缀"的解析。那是**在管理问题** ——
 *   源头把 `name` 改成纯增量（`SDA1/SCL1 · pin3/5`）之后，解析就没必要了。
 *   **能用"消灭问题"解决的，不要用"管理问题"解决**：判等不会因为前缀形式变了而失效。
 */
function splitLabel(focus: PortFocus): { head: string; tail: string } {
  const { portId, name } = focus
  if (!name || name === portId) return { head: portId, tail: '' }
  return { head: portId, tail: name }
}

export class PortTooltip {
  private readonly element: HTMLDivElement
  private readonly headElement: HTMLSpanElement
  private readonly tailElement: HTMLSpanElement
  private readonly container: HTMLElement
  private readonly host: SceneHost
  private readonly detachFrame: () => void
  private readonly projected = new THREE.Vector3()
  private focus: PortFocus | undefined
  /** 缓存标签宽度，避免每帧读 `offsetWidth`（会强制同步布局）。 */
  private measuredWidth = 0
  private measuredFor = ''
  private renderedTail = ''

  constructor(container: HTMLElement, host: SceneHost) {
    this.container = container
    this.host = host
    const element = document.createElement('div')
    element.className = 'sandbox-port-tooltip'
    Object.assign(element.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      // ★ 不吃指针事件 —— 否则标签会挡住它自己标注的那个端口，悬停开始闪烁
      pointerEvents: 'none',
      display: 'none',
      padding: '3px 7px',
      borderRadius: '4px',
      background: 'rgba(10, 14, 20, 0.86)',
      border: '1px solid rgba(120, 200, 255, 0.35)',
      color: '#e8f4ff',
      font: '12px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'nowrap',
      userSelect: 'none',
      // 丝印名可能很长 —— 夹住宽度并省略，别让它糊住半个场景
      maxWidth: `${LABEL_MAX_WIDTH}px`,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      // 压在画布之上：容器是 stacking context，画布 z 默认 auto
      zIndex: '2',
      // 起始位置在锚点上方的中心，用 translate 抵消自身尺寸
      transform: 'translate(-50%, -100%)',
    } satisfies Partial<CSSStyleDeclaration>)
    container.appendChild(element)
    this.element = element
    // 主行（portId，亮）+ 副行（丝印余量，暗）。结构建一次，之后只改 textContent。
    this.headElement = document.createElement('span')
    this.tailElement = document.createElement('span')
    this.tailElement.style.color = 'rgba(160, 200, 230, 0.75)'
    this.tailElement.style.marginLeft = '5px'
    element.append(this.headElement, this.tailElement)
    this.detachFrame = host.addFrameCallback(this.update)
  }

  /** 显示/切换标签；`undefined` = 收起。 */
  setFocus(focus: PortFocus | undefined): void {
    this.focus = focus
    if (!focus) {
      this.element.style.display = 'none'
      return
    }
    const { head, tail } = splitLabel(focus)
    if (this.measuredFor !== head || this.renderedTail !== tail) {
      // 文字换了 ⇒ 先写入再量一次宽度（只在换端口时发生，不是每帧）
      this.headElement.textContent = head
      this.tailElement.textContent = tail
      this.tailElement.style.display = tail ? 'inline' : 'none'
      this.element.style.display = 'block'
      this.measuredWidth = this.element.offsetWidth
      this.measuredFor = head
      this.renderedTail = tail
    }
    this.element.style.display = 'block'
    this.update(this.host)
  }

  dispose(): void {
    this.detachFrame()
    this.element.remove()
    this.focus = undefined
  }

  /**
   * 每帧把端口的**世界坐标**投到屏幕。相机一转，标签就得跟 ——
   * 这是它唯一需要每帧做的事。
   */
  private readonly update = (host: SceneHost): void => {
    const focus = this.focus
    if (!focus) return
    // 矩阵可能还停在上一帧（组件刚被拖动/宿主刚推快照），先刷新再取世界坐标
    focus.anchor.updateWorldMatrix(true, false)
    focus.anchor.getWorldPosition(this.projected)
    this.projected.project(host.camera)

    // z > 1 ⇒ 在相机**背后**。投影公式对背后的点照样给坐标，不判会看到"幽灵标签"。
    if (this.projected.z > 1) {
      this.element.style.display = 'none'
      return
    }

    const width = this.container.clientWidth
    const height = this.container.clientHeight
    const rawX = (this.projected.x * 0.5 + 0.5) * width
    const rawY = (-this.projected.y * 0.5 + 0.5) * height
    // 贴边时别被裁掉（容器是 overflow:hidden）
    const half = this.measuredWidth / 2
    const x = Math.min(Math.max(rawX, half + 2), Math.max(half + 2, width - half - 2))
    const y = Math.max(rawY + LABEL_OFFSET_Y, 2)

    this.element.style.display = 'block'
    this.element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`
  }
}
