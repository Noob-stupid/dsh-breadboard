/**
 * AssemblyState —— 装配状态（SSOT）· 设计文档 §6.1
 * @module dsh-hardware-sandbox/core/state/assembly-state
 *
 * ★ 单一真相源。三 realm 里**只有宿主持有它**：
 *   浏览器是它的投影（§4.2.4「场景是状态的投影，不是副本」），
 *   Python shim 是它的代理（连快照都没有）。
 *
 * ★ 一条刻意的设计决策：**端口占用不落在 Port 上，而是从 connections 推导**。
 *   契约里 `Port.occupiedBy` 是可选字段，但本类**不维护**它 —— 快照生成时才填。
 *   理由：若同时在 `ports[].occupiedBy` 和 `connections` 里记一份占用关系，
 *   就是第二本账，两者一旦不同步，视觉仲裁拿到的「事实」就是错的。
 *   ⇒ 占用关系只有 connections 一个出处。
 */
import type {
  AssemblySnapshot,
  ComponentSpec,
  ConnectionSpec,
  Port,
  PortRef,
  PowerSummary,
  Vec3,
  Warning,
  WarningCode,
} from '../../contracts/assembly.ts'
import type { DeviceSnapshot, Protocol } from '../../contracts/device.ts'
import type { NetworkBinding } from '../../contracts/network.ts'
import type { ActionResult, ClientAction } from '../../contracts/protocol.ts'
// 模型库是**共享契约**（宿主半与前端场景半都要读），所以位于 contracts/ 而非 core/
import { findModel, instantiate } from '../../contracts/library.ts'

/** 状态变更结果。失败时带可读原因码（复用 WarningCode）。 */
export type StateResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: WarningCode }

const ok = <T>(value: T): StateResult<T> => ({ ok: true, value })
const fail = <T>(reason: WarningCode): StateResult<T> => ({ ok: false, reason })

/** 端口电平兼容容差（伏）。差超过它就判 voltage_mismatch。 */
const VOLTAGE_TOLERANCE_V = 0.5

/** 解析出的端口 + 它所属的组件。 */
interface ResolvedPort {
  readonly component: ComponentSpec
  readonly port: Port
}

export class AssemblyState {
  #components = new Map<string, ComponentSpec>()
  #connections = new Map<string, ConnectionSpec>()
  /** 虚拟设备状态也挂在本 SSOT 上（§6.1 主线 B 扩展）。由 SimEngine 写入。 */
  #virtualDevices: DeviceSnapshot[] = []
  /** 联网设备（第二类虚拟硬件）。**与总线设备分开存、分开写**，见 `setNetworkDevices`。 */
  #networkDevices: DeviceSnapshot[] = []
  #revision = 0
  /** 结构性变更的订阅者。★ 虚拟设备发布**不**触发它（见 setVirtualDevices）。 */
  #listeners = new Set<() => void>()
  /** id 生成计数器 —— 用计数器而非随机，保证回放可复现（对齐 P3 的确定性要求）。 */
  #componentSeq = 0
  #cableSeq = 0

  get revision(): number {
    return this.#revision
  }

  /**
   * 订阅**结构性变更**（放置/移除/移动/连线/拔线/重置）。
   *
   * ★ 虚拟设备发布（{@link setVirtualDevices}）**不**触发订阅者 —— 否则
   *   「设备注册表监听变更 → 发布设备快照 → 又触发变更」会形成死循环。
   *   revision 仍会递增（前端要靠它做 diff），只是不通知结构性订阅者。
   */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** 结构性变更：递增 revision 并通知订阅者。 */
  #touch(): void {
    this.#revision += 1
    for (const listener of [...this.#listeners]) {
      try {
        listener()
      } catch {
        // 单个订阅者抛错不应影响其它订阅者，也不应让状态变更失败
      }
    }
  }

  get components(): readonly ComponentSpec[] {
    return [...this.#components.values()]
  }

  get connections(): readonly ConnectionSpec[] {
    return [...this.#connections.values()]
  }

  findComponent(componentId: string): ComponentSpec | undefined {
    return this.#components.get(componentId)
  }

  findConnection(cableId: string): ConnectionSpec | undefined {
    return this.#connections.get(cableId)
  }

  /**
   * 主线 B 写入**总线设备**状态（`DeviceRegistry` 用）。
   *
   * ★ 只递增 revision、**不通知结构性订阅者** —— 见 {@link onChange} 的说明。
   *
   * ⚠️ **只写总线这一半**。联网设备走 {@link setNetworkDevices}。
   *   早先只有这一个 setter，若两个注册表都调它，**后写的会把先写的整个覆盖掉** ——
   *   而症状是"设备时有时无"，取决于谁后跑。⇒ 拆成两个字段，**各自只有一个写者**。
   */
  setVirtualDevices(devices: readonly DeviceSnapshot[]): void {
    this.#virtualDevices = [...devices]
    this.#revision += 1
  }

  /**
   * 写入**联网设备**状态（`NetworkRegistry` 用）。
   *
   * ★ 与 {@link setVirtualDevices} 是两个字段、两个写者，互不覆盖；
   *   对外仍在 `snapshot().virtualDevices` 里**合并成一份**（单一 SSOT，§6.1）。
   *   这是「所有权唯一」与「一份真相」同时满足的写法。
   */
  setNetworkDevices(devices: readonly DeviceSnapshot[]): void {
    this.#networkDevices = [...devices]
    this.#revision += 1
  }

  /* ─────────────────────────── 变更操作 ─────────────────────────── */

  /**
   * 放置组件。位置单位米（§4.2.1）。
   *
   * @param options.network —— 见 `contracts/network.ts`。给了它就是一台**联网设备**。
   *   ★ 用可选对象而不是第 4 个位置参数：调用方常常只想给 id 不给 network，
   *     位置参数会逼出 `place(m, p, 'x', undefined)` 这种读不懂的调用。
   */
  place(
    hardwareModel: string,
    position: Vec3,
    id?: string,
    options?: { readonly network?: NetworkBinding },
  ): StateResult<ComponentSpec> {
    const model = findModel(hardwareModel)
    if (!model) return fail<ComponentSpec>('unknown_hardware_model')

    // 供电预算：把**待放置的这台**同时计入需求与供给再判定。
    // ★ 必须同时计入供给 —— 否则第一台供电源自己就过不了预算（需求 3W > 预算 0W），
    //   形成「没有电源就放不下电源」的死锁。
    const projectedDemand = this.#demandW() + model.powerDrawW
    const projectedBudget = this.#budgetW() + model.powerSupplyW
    if (projectedDemand > projectedBudget) return fail<ComponentSpec>('power_exceeded')

    const componentId = id ?? `c${String((this.#componentSeq += 1))}`
    if (this.#components.has(componentId)) return fail<ComponentSpec>('port_occupied')

    const created = instantiate(componentId, hardwareModel, position)
    if (!created) return fail<ComponentSpec>('unknown_hardware_model')

    const component: ComponentSpec =
      options?.network === undefined ? created : { ...created, network: options.network }

    this.#components.set(componentId, component)
    this.#touch()
    return ok(component)
  }

  /** 移除组件，并连带移除挂在它身上的全部线缆。 */
  remove(componentId: string): StateResult<{ removedCables: string[] }> {
    if (!this.#components.has(componentId)) return fail<{ removedCables: string[] }>('unknown_hardware_model')

    const removedCables: string[] = []
    for (const connection of [...this.#connections.values()]) {
      if (connection.from.componentId === componentId || connection.to.componentId === componentId) {
        this.#connections.delete(connection.cableId)
        removedCables.push(connection.cableId)
      }
    }
    this.#components.delete(componentId)
    this.#touch()
    return ok({ removedCables })
  }

  /**
   * 移动组件。位置单位米。
   *
   * ★ **钉住的组件拒绝移动**，且是**明确失败**（带原因），不是静默忽略。
   *   拦截落在这里而不是 UI 层 —— 因为移动走的是 action 路由，
   *   DS / 另一个客户端 / 脚本都从这条路进来。**只拦鼠标不叫锁。**
   */
  move(componentId: string, position: Vec3): StateResult<ComponentSpec> {
    const existing = this.#components.get(componentId)
    if (!existing) return fail<ComponentSpec>('unknown_hardware_model')
    if (existing.pinned === true) return fail<ComponentSpec>('component_pinned')
    const updated: ComponentSpec = { ...existing, position }
    this.#components.set(componentId, updated)
    this.#touch()
    return ok(updated)
  }

  /**
   * 钉住 / 解开一个组件。
   *
   * ★ 幂等：`pinned` 已是目标值时**不递增 revision**（避免无意义的场景重调和）。
   */
  setPinned(componentId: string, pinned: boolean): StateResult<ComponentSpec> {
    const existing = this.#components.get(componentId)
    if (!existing) return fail<ComponentSpec>('unknown_hardware_model')
    if ((existing.pinned === true) === pinned) return ok(existing)
    const updated: ComponentSpec = { ...existing, pinned }
    this.#components.set(componentId, updated)
    this.#touch()
    return ok(updated)
  }

  /** 连线。校验不通过时返回失败原因，且**不改动状态**。 */
  connect(from: PortRef, to: PortRef): StateResult<ConnectionSpec> {
    const check = this.validateConnection(from, to)
    if (!check.ok) return fail<ConnectionSpec>(check.reason)

    const cableId = `w${String((this.#cableSeq += 1))}`
    const connection: ConnectionSpec = { cableId, from, to, protocol: check.protocol }
    this.#connections.set(cableId, connection)
    this.#touch()
    return ok(connection)
  }

  /** 拔出线缆。 */
  disconnect(cableId: string): StateResult<{ cableId: string }> {
    if (!this.#connections.has(cableId)) return fail<{ cableId: string }>('port_occupied')
    this.#connections.delete(cableId)
    this.#touch()
    return ok({ cableId })
  }

  /** 执行一个来自前端的动作（`POST /api/action`）。 */
  applyAction(action: ClientAction): ActionResult {
    switch (action.kind) {
      case 'place_component': {
        const result = this.place(action.hardwareModel, action.position)
        return this.#toActionResult(result)
      }
      case 'remove_component':
        return this.#toActionResult(this.remove(action.componentId))
      case 'move_component':
        return this.#toActionResult(this.move(action.componentId, action.position))
      case 'set_pinned':
        return this.#toActionResult(this.setPinned(action.componentId, action.pinned))
      case 'connect':
        return this.#toActionResult(this.connect(action.from, action.to))
      case 'disconnect':
        return this.#toActionResult(this.disconnect(action.cableId))
      default: {
        const exhaustive: never = action
        throw new Error(`未知动作：${JSON.stringify(exhaustive)}`)
      }
    }
  }

  #toActionResult<T>(result: StateResult<T>): ActionResult {
    return result.ok
      ? { ok: true, snapshot: this.snapshot() }
      : { ok: false, reason: result.reason, snapshot: this.snapshot() }
  }

  /* ─────────────────────────── 校验（§6.2） ─────────────────────────── */

  /**
   * 连线校验。顺序与设计文档 §6.2 的 `validateConnection` 一致：
   * 协议 → 占用 → 电平 → 供电预算。
   */
  validateConnection(from: PortRef, to: PortRef): { ok: true; protocol: Protocol } | { ok: false; reason: WarningCode } {
    const a = this.#resolvePort(from)
    const b = this.#resolvePort(to)
    if (!a || !b) return { ok: false, reason: 'unknown_hardware_model' }

    // 不能把组件连到自己身上
    if (from.componentId === to.componentId) return { ok: false, reason: 'protocol_mismatch' }

    if (a.port.protocol !== b.port.protocol) return { ok: false, reason: 'protocol_mismatch' }

    // ★★ 拒绝**完全重复**的连接（同一对端口之间已有一根线）。
    //
    //   ⚠️ 与「多个不同端口接到同一个端口」是两回事 —— 后者是合法的（I2C 是总线，
    //      `I2C1→传感器` 与 `I2C2→同一个传感器` 都有意义，界面上可以把线合并显示）。
    //      这里拒的是 `from`/`to` **两端都相同**的那种：它不表达任何新信息。
    //
    //   ★ 为什么必须拒而不是静默忽略：实测踩到用户把 `I2C2→c2.I2C` 连了 3 次，
    //     结果① 场景里叠了 3 条一模一样的线，② 地址冲突检查把**一个器件算成三个**
    //     并报出假错误（那一处已另行按器件去重）。⇒ 静默忽略会让界面显示"连上了"
    //     而实际什么都没发生；明确拒绝才能让用户知道"这根线已经在了"。
    //   ★ 判据是「**同一根线**」而不是「同一个方向」：`A→B` 与 `B→A` 在物理上是**同一根线**，
    //     只拦同方向的话，反着再连一次就能造出第二根 —— 而那会重新触发下面那个
    //     「一个器件被算成多个」的假冲突（实测那条路径是真实存在的）。
    for (const existing of this.#connections.values()) {
      const sameWire =
        (existing.from.componentId === from.componentId &&
          existing.from.portId === from.portId &&
          existing.to.componentId === to.componentId &&
          existing.to.portId === to.portId) ||
        (existing.from.componentId === to.componentId &&
          existing.from.portId === to.portId &&
          existing.to.componentId === from.componentId &&
          existing.to.portId === from.portId)
      if (sameWire) return { ok: false, reason: 'already_connected' }
    }

    // ★ 共享总线端口（I2C）允许多个对端；点对点端口（power/gpio/uart/spi）独占。
    if (!a.port.shared && this.#occupantOf(from) !== undefined) {
      return { ok: false, reason: 'port_occupied' }
    }
    if (!b.port.shared && this.#occupantOf(to) !== undefined) {
      return { ok: false, reason: 'port_occupied' }
    }

    if (Math.abs(a.port.voltage - b.port.voltage) > VOLTAGE_TOLERANCE_V) {
      return { ok: false, reason: 'voltage_mismatch' }
    }

    // ★★ `direction` 的**唯一消费者** —— 它就是为了这条检查而存在的。
    //
    //   ⚠️ 加 `Port.direction` 时我**先只加了字段、没加消费者**，
    //      被并行会话当场指出："**声明了没人消费，正是我们刚立过的那条坑**"（`orientation` / `nodes`）。
    //      这条检查就是补上的那个消费者 —— **字段没有消费者就不该存在**。
    //
    //   两类**真实的接线事故**，都是"看起来接上了、其实在打架"：
    //
    //   | 情形 | 后果 | 为什么 `protocol` 抓不到 |
    //   |---|---|---|
    //   | **两个供电输出接在一起**（`power`↔`power`） | 两个电源互相灌电流 | 两端 `protocol` 都是 `'power'`，**完全一致** |
    //   | **两个输出驱动同一条线**（`out`↔`out`） | 推挽对冲、发热 | 两端 `protocol` 也都是 `'gpio'`/`'spi'` |
    //
    //   ⇒ `protocol` 描述**信号种类**，`direction` 描述**电流方向** —— 这两件事正交，
    //     所以前者永远答不了后者的题。
    //
    //   ⚠️ 注意 `power`↔`in` 是**正常的**（树莓派 3V3 → 传感器 VCC），不要拦。
    //     受电方在模型里标 `'in'`，正是为了把"供电"和"受电"分开 —— 见 `library.ts`。
    const dirA = a.port.direction
    const dirB = b.port.direction
    if (dirA === 'power' && dirB === 'power') return { ok: false, reason: 'direction_conflict' }
    if (dirA === 'out' && dirB === 'out') return { ok: false, reason: 'direction_conflict' }

    if (this.#demandW() > this.#budgetW()) return { ok: false, reason: 'power_exceeded' }

    return { ok: true, protocol: a.port.protocol }
  }

  #resolvePort(ref: PortRef): ResolvedPort | undefined {
    const component = this.#components.get(ref.componentId)
    if (!component) return undefined
    const port = component.ports.find((candidate) => candidate.portId === ref.portId)
    if (!port) return undefined
    return { component, port }
  }

  /** 端口的占用者（cableId）。★ 从 connections 推导，不落在 Port 上。 */
  #occupantOf(ref: PortRef): string | undefined {
    for (const connection of this.#connections.values()) {
      if (connection.from.componentId === ref.componentId && connection.from.portId === ref.portId) {
        return connection.cableId
      }
      if (connection.to.componentId === ref.componentId && connection.to.portId === ref.portId) {
        return connection.cableId
      }
    }
    return undefined
  }

  /* ─────────────────────────── 派生量 ─────────────────────────── */

  powerSummary(): PowerSummary {
    const demandW = this.#demandW()
    const budgetW = this.#budgetW()
    return { demandW, budgetW, exceeded: demandW > budgetW }
  }

  #demandW(): number {
    let total = 0
    for (const component of this.#components.values()) {
      total += findModel(component.hardwareModel)?.powerDrawW ?? 0
    }
    return total
  }

  #budgetW(): number {
    let total = 0
    for (const component of this.#components.values()) {
      total += findModel(component.hardwareModel)?.powerSupplyW ?? 0
    }
    return total
  }

  /** L1 拓扑与电气检查产生的警告。 */
  warnings(): Warning[] {
    const warnings: Warning[] = []

    // ① 未知型号
    for (const component of this.#components.values()) {
      if (!findModel(component.hardwareModel)) {
        warnings.push({
          code: 'unknown_hardware_model',
          severity: 'error',
          message: `组件 ${component.id} 的型号 ${component.hardwareModel} 不在预置模型库中`,
        })
      }
    }

    // ② 供电超预算
    const power = this.powerSummary()
    if (power.exceeded) {
      warnings.push({
        code: 'power_exceeded',
        severity: 'error',
        message: `供电超预算：需求 ${power.demandW.toFixed(2)}W > 预算 ${power.budgetW.toFixed(2)}W`,
      })
    }

    // ③ 悬空端口 —— ★★ **按组件聚合，不逐端口**
    //
    // ⚠️⚠️ 原来是一条端口一条告警。**逐针建模之后这个形状就崩了**：
    //   40 针的排针只接了 4 根 ⇒ **36 条一模一样的 `unconnected_port`**。
    //   而 `unconnected_port` 本来是给**3 端口的模块**设计的
    //   （"你连了 VCC 和 SDA，SCL 忘了"）—— **对排针来说，36 个脚没接是正常状态，不是异常**。
    //
    //   ★ 后果比"多"严重：这些告警**界面看不见**（`sync` 跳过 `info`，client 不渲染 warnings），
    //     它们**全部流向 `hw_get_assembly` 的工具输出** ⇒ 每次调用都往 AI 上下文里灌 36 个同样的词，
    //     **并且把唯一有信息的那条（`i2c_pullup_missing`）埋在第 37 位**。
    //     ⇒ **我加逐针正是为了让"SCL 忘了"能被报出来，结果它被自己制造的噪音盖住了。**
    //
    //   ⇒ **信号一点不丢**：`refs` 里仍然列出**每一个**未连接端口（结构化数据），
    //     只是**人读的那一句**合成一条。
    //
    //   ★ 教训：**改了基数的数据结构，要回头看所有按它计数的东西。**
    //     与"换真几何会改变性能画像"是同一类 —— **基数变了，代价跟着变，而它不会告警**。
    for (const component of this.#components.values()) {
      const dangling = component.ports.filter(
        (port) => this.#occupantOf({ componentId: component.id, portId: port.portId }) === undefined,
      )
      if (dangling.length === 0) continue
      const shown = dangling.slice(0, 6).map((port) => port.portId)
      const suffix = dangling.length > shown.length ? ` …（共 ${String(dangling.length)} 个）` : ''
      warnings.push({
        code: 'unconnected_port',
        severity: 'info',
        message: `${component.label} ${String(dangling.length)} 个引脚未连接：${shown.join(', ')}${suffix}`,
        refs: dangling.map((port) => ({ componentId: component.id, portId: port.portId })),
      })
    }

    // ④ I2C 上拉电阻（§8 流程 A：DS 会提示「I2C 需要 4.7kΩ 上拉」）
    const i2cConnections = [...this.#connections.values()].filter((c) => c.protocol === 'i2c')
    if (i2cConnections.length > 0) {
      warnings.push({
        code: 'i2c_pullup_missing',
        severity: 'info',
        message: 'I2C 总线需要 4.7kΩ 上拉电阻（虚拟场景已自动添加，真实搭建时记得加）',
      })
    }

    // ⑤ I2C 地址冲突：同一条总线上出现重复的从机地址
    warnings.push(...this.#detectAddressConflicts())

    return warnings
  }

  #detectAddressConflicts(): Warning[] {
    /** 总线键（主机侧 componentId:portId）→ 该总线上的 (地址 → 设备组件) */
    const buses = new Map<string, Map<number, ComponentSpec[]>>()

    for (const connection of this.#connections.values()) {
      if (connection.protocol !== 'i2c') continue

      const fromComponent = this.#components.get(connection.from.componentId)
      const toComponent = this.#components.get(connection.to.componentId)
      const fromAddress = fromComponent ? findModel(fromComponent.hardwareModel)?.i2cAddress : undefined
      const toAddress = toComponent ? findModel(toComponent.hardwareModel)?.i2cAddress : undefined

      // 有地址的一侧是从机（device），另一侧是总线主机（host）
      const deviceRef = fromAddress !== undefined ? connection.from : connection.to
      const hostRef = fromAddress !== undefined ? connection.to : connection.from
      const address = fromAddress ?? toAddress
      if (address === undefined) continue

      const deviceComponent = this.#components.get(deviceRef.componentId)
      if (!deviceComponent) continue

      // ★ 总线键必须用**主机侧**端口 —— 用从机侧会把「同一条总线上的两个从机」
      //   分到两个不同的桶里，地址冲突永远检测不出来。
      const busKey = `${hostRef.componentId}:${hostRef.portId}`
      const bus = buses.get(busKey) ?? new Map<number, ComponentSpec[]>()
      const owners = bus.get(address) ?? []
      // ★★ 必须按**器件**去重，不能按**连接**计数。
      //   实测踩到：用户把 `I2C2→c2.I2C` 连了 3 次（重复连线），于是同一个 BME280
      //   被 push 了 3 次 ⇒ `owners.length === 3 >= 2` ⇒ 报出
      //   **"总线上有 3 个设备都用地址 0x76"** —— 而总线上其实只有**一个**器件。
      //   这是一条**假错误**：用户看到 error 却不知道该改什么（他没法"改其中一个的 SDO 接法"，
      //   因为根本没有第二个器件）。⇒ 判据是「**有几个器件**」，不是「有几条线」。
      if (!owners.some((owner) => owner.id === deviceComponent.id)) owners.push(deviceComponent)
      bus.set(address, owners)
      buses.set(busKey, bus)
    }

    const warnings: Warning[] = []
    for (const [busKey, bus] of buses) {
      for (const [address, owners] of bus) {
        if (owners.length < 2) continue
        const component = this.#components.get(busKey.split(':')[0] ?? '')
        warnings.push({
          code: 'i2c_address_conflict',
          severity: 'error',
          message:
            `${component?.label ?? busKey} 的 I2C 总线上有 ${String(owners.length)} 个设备` +
            `都用地址 0x${address.toString(16).toUpperCase()} —— 必须改其中一个的 SDO 接法`,
          refs: owners.map((owner) => ({ componentId: owner.id, portId: 'I2C' })),
        })
      }
    }
    return warnings
  }

  /* ─────────────────────────── 快照 ─────────────────────────── */

  /**
   * 生成快照 —— 前端场景渲染的唯一输入。
   *
   * ★ 端口占用在这里才填进 `occupiedBy`（从 connections 推导），
   *   保证快照里的占用关系与 connections 永远一致。
   */
  snapshot(): AssemblySnapshot {
    const components: ComponentSpec[] = [...this.#components.values()].map((component) => ({
      ...component,
      ports: component.ports.map((port) => {
        const occupant = this.#occupantOf({ componentId: component.id, portId: port.portId })
        return occupant === undefined ? { ...port } : { ...port, occupiedBy: occupant }
      }),
    }))

    return {
      revision: this.#revision,
      components,
      connections: this.connections,
      warnings: this.warnings(),
      powerSummary: this.powerSummary(),
      // ★ 两类虚拟硬件在这里**合并成一份**：调用方（前端/DS）不需要知道有几类。
      //   但各自仍只有一个写者（见两个 setter）—— 一份真相 ≠ 一个字段。
      virtualDevices: [...this.#virtualDevices, ...this.#networkDevices],
    }
  }

  /** 清空（保留计数器，保证同一次会话内 id 不复用）。 */
  reset(): void {
    this.#components.clear()
    this.#connections.clear()
    this.#virtualDevices = []
    this.#networkDevices = []
    this.#touch()
  }
}
