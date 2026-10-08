/**
 * 几何来源（`ModelProvider`）—— 场景与「几何从哪来」之间的**唯一接缝**。
 *
 * ★ 为什么需要这一层
 *   外部几何（用户导入的 glTF）**必然是异步**的，而渲染循环是同步的：
 *   `SceneSyncLayer.apply()` 在 rAF 里被同步调用。若让异步渗进去，后面全是竞态。
 *   本层用「**同步占位 + 异步换装**」把异步挡在门外 —— 兜底永远存在，场景永不白屏。
 *
 * ★ 归一化契约（任何实现的硬要求）
 *   1. **缩放到契约声明的 `HardwareModel.size`**，**不是**缩放到模型自己的包围盒。
 *      端口坐标由 `size` 派生并被其校验 —— 两者不一致 ⇒ 端口锚点飘出模型外。
 *      ⚠️ 对**已有 modelKey**，`size` **只**来自 `HARDWARE_MODELS`；导入的几何只是**换装**，
 *      不允许改写尺寸（否则出现第二个尺寸真源）。
 *   2. **原点 = 包围盒中心**（`contracts/library.ts` 写死的约定）。
 *   3. **朝向对齐**：x = 长 / y = 厚 / z = 宽。朝向**自动归一化**，但用的是
 *      **旋转**（det = +1），**不是轴置换** —— 置换在 6 种尺寸序里有 3 种是反射，
 *      会把模型**镜像**而 `Port.position` 不会跟着镜像，端口就跑到错误的一侧，
 *      且**包围盒完全相同**、查不出来。见 `importer.ts` 的 `orientToContract`。
 *      约定本身（哪条轴算"上"）是**量不出来的**，所以尺寸序不清晰时报告里标
 *      `orientationAmbiguous`，由 per-model override 兜底 —— 不在这里猜。
 *   4. 逐轴缩放若使长宽比偏差超阈值 ⇒ **用户可见的告警**，不能只写 console：
 *      长宽比不符通常意味着「模型错了或 `size` 错了」，这是该被发现的信号。
 *      ⚠️ 朝向已归一化之后，这条告警的含义**变窄了**：它不再表示"没转向"，
 *      而是**声明尺寸与模型形状本身不符** —— 更值得查，不是更不值得。
 *
 * ★ 所有权规则（唯一，用于消灭双释放）
 *   **谁创建谁释放。** 由此推出两条，取决于资源的创建次数：
 *   · **占位对象**：每次 `acquire` 新建 ⇒ **每次 `acquire` 的 `dispose()` 释放它**。
 *   · **解析后的模型资源**（几何/材质）：解析昂贵，**按 modelKey 缓存、只创建一次** ⇒
 *     **由 provider 在 `dispose()` 时统一释放**；实例的 `dispose()` **不得**碰它们。
 *
 *   ⚠️ 这看似违反「禁止缓存」，其实不是 —— 那条约束的**目的**是「所有权唯一」，
 *   不是「禁止缓存」。真正要禁的是**"缓存的资源被实例释放"**（释放一个会弄坏另一个）。
 *   实例拿到的是 `clone()`，它**共享**几何/材质但**不拥有**它们，所以它无权释放。
 *
 * ★ 静态资源（字体/贴图等）不在此层职责内。
 */
import * as THREE from 'three'
import type { ModelOrientation, Vec3 } from '../contracts/index.ts'

/** 表现层参数：占位对象的观感（真几何保留它自己的材质）。 */
export interface ModelAppearance {
  /** 占位几何的基色。 */
  readonly color: number
}

/** 一次几何获取。 */
export interface ModelAcquisition {
  /**
   * 同步占位对象：**首帧必须立刻可用**。
   * 拾取（`userData`）与端口锚点在占位上即已生效，不依赖真几何到位。
   */
  readonly placeholder: THREE.Object3D
  /**
   * 异步换装：解析为真几何；`null` = 保留占位（表示"没有"或"拿不到"，**不重试风暴**）。
   *
   * ★ 约定：失败也必须 `resolve(null)`，**不要 reject** —— 渲染层不该处理异常。
   */
  readonly ready: Promise<THREE.Object3D | null>
  /** 释放**本次获取**（即占位对象）。共享的模型资源归 provider，不在此释放。 */
  dispose(): void
}

/** 几何来源。按型号键解析几何。 */
export interface ModelProvider {
  /**
   * @param modelKey   - `ComponentSpec.hardwareModel`（即模型库键）
   * @param size       - **契约声明的**包围盒尺寸（米）。归一化的目标就是它。
   * @param appearance - 占位对象的观感
   * @param signal     - 取消信号（场景卸载时 abort）
   * @param orientation- **人工朝向覆盖**（`HardwareModel.orientation`）。
   *   ★ 为什么要一路传进来：契约里声明了它，而声明了却没人消费的字段**比没有更糟** ——
   *     有人填了、什么都没发生、也没人告诉他。**要么接线，要么别声明。**
   *   省略 = 实现自己按包围盒定朝向（见 `importer.ts` 的 `orientToContract`）。
   */
  acquire(
    modelKey: string,
    size: Vec3,
    appearance: ModelAppearance,
    signal: AbortSignal,
    orientation?: ModelOrientation,
  ): ModelAcquisition
  /** 释放 provider 持有的共享资源（缓存的模型几何/材质）。 */
  dispose(): void
}

/** 建一个居中的占位盒（原点 = 包围盒中心，符合契约）。 */
export function createPlaceholder(size: Vec3, color: number): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(size.x, size.y, size.z)
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.65, metalness: 0.1 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'placeholder'
  return mesh
}

/** 释放一棵对象树里**自己拥有**的几何与材质。 */
export function disposeOwnedResources(object: THREE.Object3D): void {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh
    mesh.geometry?.dispose?.()
    const material = mesh.material
    if (Array.isArray(material)) for (const item of material) item.dispose()
    else material?.dispose?.()
  })
}

/**
 * 默认实现：程序化图元（一个盒子）。
 *
 * 尺寸**由调用方从契约取好后传入** —— 本实现不自己维护尺寸表，
 * 避免与 `contracts/library.ts` 形成第二份真相（依赖方向：契约 → provider）。
 * `ready` 立即解析为 `null`（没有外部几何可换）。
 */
export class ProceduralModelProvider implements ModelProvider {
  acquire(_modelKey: string, size: Vec3, appearance: ModelAppearance, _signal: AbortSignal): ModelAcquisition {
    const placeholder = createPlaceholder(size, appearance.color)
    let disposed = false
    return {
      placeholder,
      ready: Promise.resolve(null),
      dispose: () => {
        if (disposed) return
        disposed = true
        disposeOwnedResources(placeholder)
      },
    }
  }

  dispose(): void {
    // 无共享资源
  }
}
