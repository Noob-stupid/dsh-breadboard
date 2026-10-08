/**
 * DeviceRegistry —— 把**装配状态**与**虚拟设备**接起来
 * @module dsh-hardware-sandbox/core/sim/device-registry
 *
 * ★ 设计文档 §6.1 的关键一句：「虚拟设备状态挂在 `AssemblyState` 上，而非独立维护。
 *   这样 3D 场景、事件桥、仿真环境**共用一份真相**。」
 *
 *   本类就是那句话的执行体：**装配里放一个 BME280 组件 ⇒ 虚拟时钟上真的多一台 BME280 设备**。
 *   在此之前这两件事是分开的（演示装配有组件、时钟上却没有对应设备）。
 *
 * ★ 为什么用订阅而不是让调用方手动 sync：
 *   手动 sync 一旦有人忘了调，装配与设备就会**静默漂移** —— 而这类漂移的现场
 *   表现为「明明连了线却读不到值」，极难定位。订阅 SSOT 的变更通知可以从结构上杜绝。
 */
import type { ComponentSpec } from '../../contracts/assembly.ts'
import type { HardwareModel } from '../../contracts/library.ts'
import { findModel } from '../../contracts/library.ts'
import type { VirtualDevice } from '../../contracts/device.ts'
import type { VirtualClock } from '../vclock/virtual-clock.ts'
import type { AssemblyState } from '../state/assembly-state.ts'
import { VirtualBME280 } from '../devices/bme280.ts'

/**
 * 由组件造出对应的虚拟设备。
 * 返回 `undefined` 表示**该型号没有虚拟设备**（例如无源的面包板）—— 这是正常情况，不是错误。
 */
export type DeviceFactory = (component: ComponentSpec, model: HardwareModel) => VirtualDevice | undefined

/**
 * 默认设备工厂表。
 *
 * ★ 只有**有电气行为**的型号才登记在这里。面包板、LED 这类没有行为模型的型号
 *   刻意不登记 —— 它们出现在装配里但不产生设备，这是设计而非遗漏。
 */
export const DEFAULT_DEVICE_FACTORIES: Readonly<Record<string, DeviceFactory>> = {
  bme280: (component, model) =>
    new VirtualBME280({
      // 设备 id 直接用组件 id，便于「装配里的哪一块」与「总线上的哪一台」一一对应
      id: component.id,
      address: model.i2cAddress ?? 0x76,
    }),
}

export interface DeviceRegistryOptions {
  readonly clock: VirtualClock
  readonly state: AssemblyState
  /** 覆盖默认工厂表（测试用）。 */
  readonly factories?: Readonly<Record<string, DeviceFactory>>
}

export class DeviceRegistry {
  readonly #clock: VirtualClock
  readonly #state: AssemblyState
  readonly #factories: Readonly<Record<string, DeviceFactory>>
  /** componentId → 已注册的设备与其注销函数 */
  readonly #devices = new Map<string, { device: VirtualDevice; dispose: () => void }>()
  readonly #unsubscribe: () => void

  constructor(options: DeviceRegistryOptions) {
    this.#clock = options.clock
    this.#state = options.state
    this.#factories = options.factories ?? DEFAULT_DEVICE_FACTORIES

    // 订阅 SSOT 的结构性变更 —— 装配一变，设备跟着变
    this.#unsubscribe = this.#state.onChange(() => {
      this.sync()
    })
    this.sync()
  }

  /** 当前挂载的设备数（诊断用）。 */
  get deviceCount(): number {
    return this.#devices.size
  }

  /** 某个组件对应的设备（测试与诊断用）。 */
  deviceFor(componentId: string): VirtualDevice | undefined {
    return this.#devices.get(componentId)?.device
  }

  /**
   * 按当前装配调和设备集合。
   *
   * 三步：**先摘除消失的 → 再补齐新增的 → 最后把设备快照发布回 SSOT**。
   * 顺序不能反：先摘除能保证 id 不被复用（时钟对重复 id 是直接抛错的）。
   */
  sync(): void {
    const components = this.#state.components
    const present = new Set(components.map((component) => component.id))

    // ① 摘除已消失的组件对应的设备
    for (const [componentId, entry] of [...this.#devices]) {
      if (present.has(componentId)) continue
      entry.dispose()
      this.#devices.delete(componentId)
    }

    // ② 为新组件补齐设备
    for (const component of components) {
      if (this.#devices.has(component.id)) continue

      const factory = this.#factories[component.hardwareModel]
      if (factory === undefined) continue // 该型号没有虚拟设备，正常

      const model = findModel(component.hardwareModel)
      if (model === undefined) continue

      const device = factory(component, model)
      if (device === undefined) continue

      this.#devices.set(component.id, { device, dispose: this.#clock.register(device) })
    }

    // ③ 把设备快照发布回 SSOT —— 前端场景与 DS 都从这里读，不另开一份
    this.#state.setVirtualDevices(this.#clock.snapshotDevices())
  }

  /** 退订并注销全部设备。 */
  dispose(): void {
    this.#unsubscribe()
    for (const entry of this.#devices.values()) entry.dispose()
    this.#devices.clear()
  }
}
