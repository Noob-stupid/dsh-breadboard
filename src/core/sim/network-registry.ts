/**
 * NetworkRegistry —— 把**装配状态**与**联网设备**接起来
 * @module dsh-hardware-sandbox/core/sim/network-registry
 *
 * 与 `DeviceRegistry` 是**并列**的两件事，不是它的扩展：
 * 那个管"等被读"的总线设备（虚拟时钟驱动），这个管"主动出网"的联网设备（墙钟驱动）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 关键安全决定：**放进来 ≠ 开始发请求**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 总线设备放进场景就"活着"是**无害的** —— 它只是等着被读，不产生任何副作用。
 *
 * **联网设备不是**。它一旦启动就**真的往外发 HTTP**：
 *   · 用户拖一个组件进场景，不该因此让某个真实服务器开始收包
 *   · 更不该在用户没注意时**持续**收包（间隔由对面配置，可能是 1 秒）
 *
 * ⇒ 放进来的设备停在 `idle`，**必须显式启动**（工具 / 界面按钮）。
 *   这条不是保守，是"**默认不该有外部副作用**"。
 *
 * ★ 与 `DeviceRegistry` 同样的订阅式调和：手动 sync 一旦有人忘了调，
 *   装配与设备就**静默漂移**，而现场表现为"明明放上去了却没有这台设备"。
 */
import type { ComponentSpec } from '../../contracts/assembly.ts'
import type { NetworkProtocolAdapter, NetworkTransport } from '../../contracts/network.ts'
import type { AssemblyState } from '../state/assembly-state.ts'
import { NetworkedDevice } from '../devices/networked.ts'
import { zhizuoSensorAdapter, ZHIZUO_PROTOCOL_ID } from '../devices/protocols/zhizuo.ts'

/**
 * 内置协议适配器表。
 *
 * ★ 加一个新协议 = 在这里加一行，**不动内核**。这是这条线可扩展的唯一原因。
 */
export const DEFAULT_NETWORK_ADAPTERS: Readonly<Record<string, NetworkProtocolAdapter>> = {
  [ZHIZUO_PROTOCOL_ID]: zhizuoSensorAdapter,
}

export interface NetworkRegistryOptions {
  readonly state: AssemblyState
  /** 出网能力（宿主半给真实 fetch，测试给假的）。 */
  readonly transport: NetworkTransport
  /** 覆盖默认适配器表（测试用）。 */
  readonly adapters?: Readonly<Record<string, NetworkProtocolAdapter>>
  /** 定时器/墙钟注入（测试用），透传给每台设备。 */
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, ms: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}

export class NetworkRegistry {
  readonly #state: AssemblyState
  readonly #transport: NetworkTransport
  readonly #adapters: Readonly<Record<string, NetworkProtocolAdapter>>
  readonly #options: NetworkRegistryOptions
  /** componentId → 设备 */
  readonly #devices = new Map<string, NetworkedDevice>()
  /** 创建时遇到的问题（如未知协议）—— **可见**，不静默丢弃。 */
  readonly #problems = new Map<string, string>()
  readonly #unsubscribe: () => void

  constructor(options: NetworkRegistryOptions) {
    this.#state = options.state
    this.#transport = options.transport
    this.#adapters = options.adapters ?? DEFAULT_NETWORK_ADAPTERS
    this.#options = options

    this.#unsubscribe = this.#state.onChange(() => {
      this.sync()
    })
    this.sync()
  }

  get deviceCount(): number {
    return this.#devices.size
  }

  /** 当前创建失败的原因（componentId → 原因）。空 = 没有失败。 */
  get problems(): ReadonlyMap<string, string> {
    return this.#problems
  }

  deviceFor(componentId: string): NetworkedDevice | undefined {
    return this.#devices.get(componentId)
  }

  /** 全部联网设备（供工具与诊断遍历）。 */
  devices(): readonly NetworkedDevice[] {
    return [...this.#devices.values()]
  }

  /**
   * 按当前装配调和设备集合。
   *
   * ★ 与 `DeviceRegistry.sync` 一样是三步，但**没有第③步的 publish 收尾**：
   *   联网设备的状态是**异步变化**的（HTTP 回来才变），所以发布靠设备的
   *   `onChange` 回调，而不是靠调和这一刻的快照。调和只负责建/删。
   */
  sync(): void {
    const components = this.#state.components
    const present = new Set(components.map((component) => component.id))

    // ① 摘除消失的（**先停再删** —— 否则会留下一个还在发请求的孤儿）
    for (const [componentId, device] of [...this.#devices]) {
      if (present.has(componentId)) continue
      device.stop()
      this.#devices.delete(componentId)
      this.#problems.delete(componentId)
    }

    // ② 为新组件补齐
    for (const component of components) {
      if (this.#devices.has(component.id)) continue
      const binding = component.network
      if (binding === undefined) continue // 总线设备，不是我们管的

      const adapter = this.#adapters[binding.protocol]
      if (adapter === undefined) {
        // ★ 未知协议**记下来并可见** —— 静默忽略会让用户以为"放上去了但没反应"
        this.#problems.set(
          component.id,
          `未知协议 "${binding.protocol}"（已注册：${Object.keys(this.#adapters).join(', ')}）`,
        )
        continue
      }

      const device = new NetworkedDevice({
        id: component.id,
        label: component.label,
        binding,
        adapter,
        transport: this.#transport,
        ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
        ...(this.#options.setTimer !== undefined ? { setTimer: this.#options.setTimer } : {}),
        ...(this.#options.clearTimer !== undefined ? { clearTimer: this.#options.clearTimer } : {}),
        onChange: () => {
          this.#publish()
        },
      })
      this.#devices.set(component.id, device)
      this.#problems.delete(component.id)
    }

    this.#publish()
  }

  /** 启动某台（或全部）设备。**这是唯一会让请求真正发出去的动作。** */
  async start(componentId?: string): Promise<readonly NetworkedDevice[]> {
    const targets =
      componentId === undefined
        ? [...this.#devices.values()]
        : ([this.#devices.get(componentId)].filter(Boolean) as NetworkedDevice[])
    for (const device of targets) await device.start()
    return targets
  }

  /** 停止某台（或全部）。 */
  stop(componentId?: string): readonly NetworkedDevice[] {
    const targets =
      componentId === undefined
        ? [...this.#devices.values()]
        : ([this.#devices.get(componentId)].filter(Boolean) as NetworkedDevice[])
    for (const device of targets) device.stop()
    return targets
  }

  /**
   * 把联网设备的快照发布回 SSOT。
   *
   * ★ 走 `setNetworkDevices` 而**不是** `setVirtualDevices` —— 后者是总线设备那一半，
   *   两个写者会互相覆盖（详见 `AssemblyState` 上两个 setter 的注释）。
   */
  #publish(): void {
    this.#state.setNetworkDevices(this.#devices.size === 0 ? [] : [...this.#devices.values()].map((d) => d.toDeviceSnapshot()))
  }

  dispose(): void {
    this.#unsubscribe()
    for (const device of this.#devices.values()) device.stop()
    this.#devices.clear()
    this.#problems.clear()
    this.#publish()
  }
}

/** 组件是不是联网设备（供工具/界面判断）。 */
export function isNetworkComponent(component: ComponentSpec): boolean {
  return component.network !== undefined
}
