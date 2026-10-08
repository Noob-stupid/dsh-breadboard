/**
 * 性能尺子 —— **默认关**，打开后在左下角显示每帧的 `calls / triangles / fps`。
 *
 * ★ 为什么是"尺子"而不是"优化"
 *   项目里已经有一条模式：把原本看不见的量变成可见（`capabilities`、`build` 指纹、`nodes`）。
 *   性能是唯一还没被做成可见的那一类 —— 于是"快不快"只能靠感觉，而感觉没有基线。
 *   **没有尺子的时候，你量不出"不慢"。** "用户没报"只等于"没人量过"。
 *
 * ★ 为什么不趁现在把 2067 个 primitive 合并掉
 *   因为**没有证据**。合并会把 2067 次 draw call 换成 1 次，**同时**把"点一下"的代价
 *   从"射线穿过的那几个 mesh 的三角形"变成"全部 ~125k 个三角形"
 *   —— **修一个成本，造出另一个成本，而新的那个不会告警。**
 *   所以顺序是：**先架尺子 → 读出数 → 再决定动不动刀。**
 *
 * ★ 为什么默认关：用户明确说过「尽量不占用大面积」。
 *   **架在架子上，不是贴在墙上** —— 需要时拿起来就有，平时不占地方。
 *
 * ★ 纯读取：只读 `renderer.info`，不碰渲染参数、不改任何行为。
 */
import type { SceneHost } from '../scene/host.ts'

/** 采样间隔：**不要每帧刷新 DOM** —— 那会用测量本身污染被测量的东西。 */
const SAMPLE_INTERVAL_MS = 500

export class PerfMeter {
  private readonly element: HTMLDivElement
  private readonly host: SceneHost
  private readonly detachFrame: () => void
  private visible = false
  private frames = 0
  private windowStartedAt = 0
  private lastText = ''

  constructor(container: HTMLElement, host: SceneHost) {
    this.host = host
    const element = document.createElement('div')
    element.className = 'sandbox-perf-meter'
    Object.assign(element.style, {
      position: 'absolute',
      left: '12px',
      bottom: '12px',
      display: 'none',
      padding: '3px 7px',
      borderRadius: '4px',
      background: 'rgba(10, 14, 20, 0.72)',
      border: '1px solid rgba(120, 200, 255, 0.22)',
      color: '#cfe6ff',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: '2',
    } satisfies Partial<CSSStyleDeclaration>)
    container.appendChild(element)
    this.element = element
    // ★ 在**帧回调**里读：`renderer.info` 每次 render 会重置，
    //   所以这里读到的就是**上一帧**的计数（差一帧，对尺子无所谓）。
    this.detachFrame = host.addFrameCallback(this.sample)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.frames = 0
    this.windowStartedAt = 0
    this.element.style.display = visible ? 'block' : 'none'
    if (!visible) this.lastText = ''
  }

  isVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    this.detachFrame()
    this.element.remove()
  }

  private readonly sample = (host: SceneHost): void => {
    if (!this.visible) return
    const now = performance.now()
    this.frames++
    if (this.windowStartedAt === 0) {
      this.windowStartedAt = now
      return
    }
    const elapsed = now - this.windowStartedAt
    if (elapsed < SAMPLE_INTERVAL_MS) return

    const info = host.renderer.info.render
    const fps = (this.frames * 1000) / elapsed
    const text = `calls ${info.calls}\ntris  ${info.triangles}\nfps   ${fps.toFixed(0)}`
    // 只有内容变了才写 DOM
    if (text !== this.lastText) {
      this.element.textContent = text
      this.lastText = text
    }
    this.frames = 0
    this.windowStartedAt = now
  }
}
