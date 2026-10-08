/**
 * 场景宿主：Three.js 渲染管线（渲染器 / 相机 / OrbitControls / 视口自适应 / rAF 采样）。
 *
 * 职责边界（公约盒 `cv-muxwsfeb-s7frhb` 铁律②）：
 *   本文件只负责「把投影画出来」，**不持有任何业务状态**。
 *   业务状态唯一真相在宿主 Node（SSOT）；本层每帧**拉取**投影，绝不接受逐 tick 推送。
 *
 * 采样模型：
 *   rAF 循环每帧调用 `frameCallbacks`（SceneSync 在此做「版本号变了没」的廉价比对），
 *   只有 `invalidate()` 被调用过才真正 `layer.apply()` + `render()`。
 *   于是 `advance(1.0)`（1000 次 tick）不会变成 1000 次渲染 —— 渲染次数只与显示刷新率相关。
 *
 * 单位（公约盒 `cv-muxwsfe1-3wn53s`）：1 场景单位 = 1 米；角度 = 弧度。
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * 机位预设顺序**固定不可变**（公约盒：视觉仲裁要求可复现）。
 * 不要重排、不要在中间插入。
 */
export const CAMERA_PRESETS = ['top', 'front', 'isometric'] as const
export type CameraPreset = (typeof CAMERA_PRESETS)[number]

/** 相机到目标的默认距离（米）。装配体本期按 1m 尺度标定；后续可换成包围盒自适应。 */
const DEFAULT_VIEW_DISTANCE = 1.1

/** 每帧回调：SceneSync 在这里「采样」投影层，而不是被宿主 tick 推送。 */
export type FrameCallback = (host: SceneHost) => void

/**
 * 可插拔图层。
 *
 * `apply()` 必须**幂等且廉价**——它会在每次重绘前被调用。
 * 真正的重活放在检测到版本变化之后自行短路。
 */
export interface SceneLayer {
  /** 挂载到场景（建 mesh / 加辅助物）。构造期调用一次。 */
  attach(host: SceneHost): void
  /**
   * 采样最新投影并更新场景；允许被高频调用，必须**幂等且廉价**。
   *
   * **可选**：只有「把数据投影成场景」的图层才需要它。
   * 纯输入型图层（如 `InteractionLayer`）没有投影可采样，不应被迫实现一个空方法。
   */
  apply?(): void
  /** 释放 GPU 资源。 */
  dispose(): void
}

export interface SceneHostOptions {
  /** 容器不可见（宽或高为 0）时跳过本帧。默认 true。 */
  skipWhenHidden?: boolean
}

export class SceneHost {
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly renderer: THREE.WebGLRenderer
  readonly controls: OrbitControls

  private readonly container: HTMLElement
  private readonly skipWhenHidden: boolean
  private readonly resizeObserver: ResizeObserver
  private readonly frameCallbacks = new Set<FrameCallback>()
  private readonly layers: SceneLayer[] = []
  private readonly detachDom: () => void
  private readonly detachControls: () => void
  private rafHandle: number | null = null
  private needsRender = true
  private disposed = false

  constructor(container: HTMLElement, options: SceneHostOptions = {}) {
    this.container = container
    this.skipWhenHidden = options.skipWhenHidden ?? true

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0f1218)

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    const canvas = this.renderer.domElement
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    container.appendChild(canvas)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 0.05
    this.controls.maxDistance = 50
    this.controls.target.set(0, 0, 0)

    // ── 场景家具（非业务状态）───────────────────────────────
    const grid = new THREE.GridHelper(4, 40, 0x2a3242, 0x1b212c)
    grid.name = 'sandbox.grid'
    this.scene.add(grid)

    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1f28, 1.6)
    hemi.name = 'sandbox.hemi'
    this.scene.add(hemi)

    const key = new THREE.DirectionalLight(0xffffff, 1.4)
    key.position.set(1.6, 2.4, 1.8)
    key.name = 'sandbox.key'
    this.scene.add(key)

    // 相机变化（含阻尼过程）→ 标脏。比依赖 controls.update() 的返回值更跨版本稳妥。
    const onControlsChange = (): void => { this.invalidate() }
    this.controls.addEventListener('change', onControlsChange)
    this.detachControls = () => { this.controls.removeEventListener('change', onControlsChange) }

    this.resizeObserver = new ResizeObserver(() => { this.resize() })
    this.resizeObserver.observe(container)
    this.detachDom = () => { canvas.remove() }

    this.applyCameraPreset('isometric')
    this.resize()
  }

  /** 挂一个可插拔图层并立即 attach；返回卸载函数（解绑 + dispose 图层）。 */
  addLayer(layer: SceneLayer): () => void {
    if (this.disposed) throw new Error('SceneHost already disposed')
    this.layers.push(layer)
    layer.attach(this)
    this.invalidate()
    return () => {
      const i = this.layers.indexOf(layer)
      if (i >= 0) this.layers.splice(i, 1)
      layer.dispose()
      this.invalidate()
    }
  }

  /** 注册每帧回调（SceneSync 的采样点）。返回解绑函数。 */
  addFrameCallback(cb: FrameCallback): () => void {
    this.frameCallbacks.add(cb)
    return () => { this.frameCallbacks.delete(cb) }
  }

  /** 标记「下一帧需要重绘」。 */
  invalidate(): void {
    this.needsRender = true
  }

  /** 切到固定顺序的机位预设（可复现）。 */
  applyCameraPreset(preset: CameraPreset): void {
    const d = DEFAULT_VIEW_DISTANCE
    const p = this.camera.position
    switch (preset) {
      case 'top':
        // 正上方；留极小 z 偏移，避免 lookAt 与 up 共线导致姿态退化
        p.set(0, d, 0.0001)
        break
      case 'front':
        p.set(0, 0, d)
        break
      case 'isometric':
        p.set(d * 0.62, d * 0.62, d * 0.62)
        break
    }
    this.camera.up.set(0, 1, 0)
    this.controls.target.set(0, 0, 0)
    this.camera.lookAt(this.controls.target)
    this.controls.update()
    this.invalidate()
  }

  /** 容器尺寸变化时调用（ResizeObserver 已自动调用）。 */
  resize(): void {
    if (this.disposed) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    if (w <= 0 || h <= 0) return
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h, false)
    this.invalidate()
  }

  /** 启动 rAF 采样循环。 */
  start(): void {
    if (this.disposed || this.rafHandle !== null) return
    const loop = (): void => {
      this.rafHandle = requestAnimationFrame(loop)
      this.frame()
    }
    this.rafHandle = requestAnimationFrame(loop)
  }

  /** 停止 rAF 采样循环（面板切走时用；仿真本身在宿主侧继续跑）。 */
  stop(): void {
    if (this.rafHandle !== null) {
      cancelAnimationFrame(this.rafHandle)
      this.rafHandle = null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.stop()
    this.resizeObserver.disconnect()
    this.detachControls()
    for (const layer of [...this.layers]) {
      try {
        layer.dispose()
      } catch (err) {
        console.error('[hardware-sandbox] layer dispose failed', err)
      }
    }
    this.layers.length = 0
    this.frameCallbacks.clear()
    this.controls.dispose()
    this.scene.clear()
    this.renderer.dispose()
    this.detachDom()
  }

  private frame(): void {
    if (this.disposed) return
    if (this.skipWhenHidden && !this.isVisible()) return

    // 采样永远跑（廉价版本比对）；重绘由 needsRender 把关
    for (const cb of this.frameCallbacks) {
      try {
        cb(this)
      } catch (err) {
        console.error('[hardware-sandbox] frame callback failed', err)
      }
    }

    // 阻尼需要每帧 update；相机变化会派发 'change' → invalidate()
    this.controls.update()

    if (!this.needsRender) return
    this.needsRender = false

    for (const layer of this.layers) {
      try {
        layer.apply?.()
      } catch (err) {
        console.error('[hardware-sandbox] layer apply failed', err)
      }
    }
    this.renderer.render(this.scene, this.camera)
  }

  private isVisible(): boolean {
    return this.container.clientWidth > 0 && this.container.clientHeight > 0
  }
}
