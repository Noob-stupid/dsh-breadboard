/**
 * 装配状态（SSOT）契约 —— 冻结契约（owner: session-24ca6e69）
 * @module dsh-hardware-sandbox/contracts/assembly
 *
 * ★ 单一 SSOT 的意义（§6.1）：装配状态与虚拟设备状态**共用一份真相**，
 *   3D 场景是它的**投影**，不是副本（§4.2.4）。
 *
 * ★ 三 realm 提醒：SSOT 只存在于**宿主 Node 进程**。
 *   浏览器持有的是本快照的投影；Python shim 连快照都没有，只有代理。
 */
import type { DeviceSnapshot, Protocol } from './device.ts'
import type { NetworkBinding } from './network.ts'

/** 右手坐标系三元组。★ 单位：米（§4.2.1「1 单位 = 1 米」）。 */
export interface Vec3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** 端口引用。 */
export interface PortRef {
  readonly componentId: string
  readonly portId: string
}

/**
 * 组件上的一个端口。
 *
 * ★ `position` 是**组件局部坐标**（米），场景侧叠加组件世界变换得到世界坐标。
 *
 * ★★ 原点约定（x/y/z 三轴统一）：**组件局部坐标原点 = 该组件几何包围盒的中心**。
 *    端口坐标若越出 `±size/2` 就落在几何体外 —— 锚点会飘在板外、线缆端点连空气。
 *    这条由 `tests/model-library.test.ts` 对每个预置型号自动断言。
 *    取「居中」而非 CAD 惯用的「min 角」，决定性理由是**旋转枢轴**：
 *    Three.js 的 `mesh.rotation` 绕局部原点旋转，原点在角上会让组件绕角甩出去。
 */
/**
 * 引脚的方向。
 *
 * ★ 与 {@link Protocol} 是**两个正交的维度**：`protocol` 说"这是什么信号"，
 *   `direction` 说"电往哪边走"。真实硬件上两者互不决定 ——
 *   同一个 GPIO 可以配成输入或输出，而 I2C 的 SDA 天生双向。
 */
export type PortDirection = 'power' | 'ground' | 'io' | 'in' | 'out'

export interface Port {
  /**
   * **引脚的唯一标识**。
   *
   * ★★ 逐针建模后，**它必须按引脚编号唯一**（如 `P1`…`P40`），不能按功能命名 ——
   *   因为同一功能会出现在多个引脚上（树莓派的 `3V3` 在 pin1 和 pin17、
   *   `GND` 在 8 个引脚上、`5V` 在 2 和 4）。**用功能当 id 会撞号，而撞号的后果是静默的**：
   *   两个引脚共用一个 id，连接关系就分不清是哪一根。
   */
  readonly portId: string
  /**
   * **丝印名** —— 这个引脚在板上印的是什么，如 `'SDA'` / `'SCL'` / `'GPIO4'` / `'3V3'` / `'GND'`。
   * 一个引脚有多个功能时可以并列，如 `'GPIO2 · SDA1'`。
   */
  readonly name: string
  readonly protocol: Protocol
  /** 逻辑电平（伏）。L1 拓扑校验用，用于电压兼容判定。 */
  readonly voltage: number
  /**
   * **这个引脚的方向**。
   *
   * ★ 为什么需要它：方向原来只能从 `protocol` **猜** —— 而这是错的。
   *   真实硬件上同一个物理引脚常常**可输入也可输出**（GPIO 的默认状态），
   *   供电脚是**只能出**，而传感器的 SDA 是**双向**的。
   *   `protocol` 答不了这些，因为它描述的是**信号种类**，不是**电流方向**。
   *
   * | 值 | 含义 | 例子 |
   * |---|---|---|
   * | `'power'` | 只供电（出） | 树莓派 `3V3` / `5V` |
   * | `'ground'` | 地（双向回流） | `GND` |
   * | `'io'` | **可输入可输出**（真实 GPIO 的常态） | `GPIO17` |
   * | `'in'` | 只入 | 传感器的 `SDA`/`SCL`（从机只应答） |
   * | `'out'` | 只出 | 时钟 `SCLK` |
   *
   * 省略 = 未声明（不做方向校验）—— 但**新加的型号应当给出**，
   * 否则「把两个输出脚接在一起」这类错误依然检测不到。
   */
  readonly direction?: PortDirection
  readonly position: Vec3
  /** 端口的朝向（弧度），供线缆出口方向计算。 */
  readonly rotation?: Vec3
  /**
   * 已被哪根线占用；undefined = 空闲。
   *
   * ⚠️ 对 {@link Port.shared} 端口（总线），本字段只记**第一个**占用者以便前端置灰显示；
   *    完整占用关系以 `AssemblySnapshot.connections` 为准 —— 一条 I2C 总线上可以挂多个设备。
   */
  readonly occupiedBy?: string
  /**
   * 该端口是否为**共享总线**（一条线上可挂多个对端）。
   *
   * ★ I2C 是总线：一条 SDA/SCL 上可以挂多个从机，各自靠地址区分。
   *   若把 I2C 当独占端口建模，第二个设备永远连不上，
   *   而「同总线地址冲突」这条最该被发现的错误反而永远检测不出来。
   *   供电 / GPIO / UART 为点对点，默认独占（`shared` 省略即 false）。
   */
  readonly shared?: boolean
}

/** 一个已放置的组件。 */
export interface ComponentSpec {
  readonly id: string
  /** 模型库键，如 'rpi-4b' / 'bme280'。前端据此加载几何。 */
  readonly hardwareModel: string
  /** 展示名。 */
  readonly label: string
  /** 世界坐标（米）。★ 是**包围盒中心**，不是角点 —— 见 {@link Port.position} 的原点约定。 */
  readonly position: Vec3
  /** 欧拉角（弧度）。 */
  readonly rotation: Vec3
  readonly ports: readonly Port[]
  /**
   * **联网设备接入配置** —— 见 `contracts/network.ts`。
   *
   * ★ `undefined` = 这是一台**总线设备**（I2C），不是网络设备。
   *   一台组件**不会同时是两者**：联网设备的"行为"是主动出网，
   *   与"等被读"的总线设备是两种东西（`VirtualDevice.tick` 禁止 IO）。
   *
   * ★ 它挂在**组件实例**而不是模型库条目上：接入信息（endpoint / MAC / 座位绑定）
   *   是**这一台**的事，不是型号的事 —— 同一个 `esp32-*` 型号可以接不同的系统。
   */
  readonly network?: NetworkBinding
  /**
   * **已钉住**（右键菜单可切换）。钉住的组件**不可被移动**。
   *
   * ★★ 为什么它在 SSOT 而不在前端本地状态里（这条不是洁癖，是两条具体后果）：
   *
   *  ① **前端本地的"锁"不是锁，只是建议。** 移动走的是 `ClientAction.move_component`
   *     这条 action 路由 —— DS、另一个客户端、脚本都从这条路进来。
   *     只在 UI 层拦拖动，等于**只拦住了鼠标**，别的入口照样能移动它，
   *     而用户以为钉住了。⇒ **拦截必须落在 `AssemblyState.move()` 上**（它拒绝并给出原因）。
   *
   *  ② **本地存 = 第二本账。** 铁律①：SSOT 只在宿主，场景是投影。
   *     钉住状态若存在前端，一次 `resync`（快照替换场景）就会**静默丢掉**它 ——
   *     用户会发现"我钉住的又松了"，而没有任何报错。
   *
   * ★ 顺带的好处：DS 能从 `hw_get_assembly` **看见**它。否则用户钉住后让 DS 移动，
   *   DS 只会莫名其妙地失败。
   *
   * ⚠️ 只拦**移动**，不拦**删除**：钉住是"别乱动"，不是"别删"。
   *   删除是右键菜单里的显式动作，本身已是一次确认。
   */
  readonly pinned?: boolean
}

/** 一根已连接的线缆。 */
export interface ConnectionSpec {
  readonly cableId: string
  readonly from: PortRef
  readonly to: PortRef
  /** 协商出的协议（由 validateConnection 判定）。 */
  readonly protocol: Protocol
  /** 线缆颜色（十六进制），仅表现层使用。 */
  readonly color?: string
}

/** L1 拓扑校验/电气检查产生的一条警告。 */
export interface Warning {
  readonly code: WarningCode
  readonly severity: 'info' | 'warn' | 'error'
  /** 人话描述，直接给 DS 与用户看。 */
  readonly message: string
  /** 相关实体，供场景高亮。 */
  readonly refs?: readonly PortRef[]
}

/** 警告码。DS 按码分支处理（如 i2c_pullup_missing → 提示加上拉电阻，§8 流程 A）。 */
export type WarningCode =
  /**
   * **动作参数不合法**（如旋转角里带了 `NaN` / `Infinity`）。
   *
   * ★ 与 `unknown_hardware_model` 分开：那个是"找不到目标"，这个是"找到了但给的数不能用"。
   *   合成一个码，调用方会去检查组件 id，而真正的问题在数值上。
   */
  | 'bad_params'
  /** ★ 两端电流方向冲突（两个供电输出相接 / 两个输出驱动同一条线）—— Port.direction 的消费者。 */
  | 'direction_conflict'
  | 'protocol_mismatch'
  | 'port_occupied'
  | 'voltage_mismatch'
  | 'power_exceeded'
  | 'i2c_address_conflict'
  | 'i2c_pullup_missing'
  | 'unconnected_port'
  | 'unknown_hardware_model'
  /**
   * 组件已钉住，拒绝移动。
   *
   * ★ 它是一个**失败原因**而不是"提示"：移动请求被**明确拒绝**了。
   *   前端据此给出可操作的话（"先解开钉住"），而不是静默不动 —— 那会像卡住了。
   */
  | 'component_pinned'
  /**
   * 这一对端口之间**已经有线了**（完全重复的连接）。
   *
   * ★ 与 `port_occupied` 分开：那个是"端口被**别的**线占了"，这个是"**就是这一根**"。
   *   合成一个码的话，用户看到"端口被占用"会去找一根不存在的线。
   * ★ 注意：多个**不同**端口接到同一个端口是合法的（I2C 总线），不报此错。
   */
  | 'already_connected'

/** 供电汇总（L3 电气仿真的简化版，本期只做预算不超限判定）。 */
export interface PowerSummary {
  /** 总需求（瓦）。 */
  readonly demandW: number
  /** 总供给能力（瓦）。 */
  readonly budgetW: number
  readonly exceeded: boolean
}

/**
 * 装配状态快照 —— 前端场景渲染的唯一输入。
 *
 * ★ SceneSync 按 `revision` 做增量 diff；`revision` 单调递增，状态未变时不变。
 */
export interface AssemblySnapshot {
  readonly revision: number
  readonly components: readonly ComponentSpec[]
  readonly connections: readonly ConnectionSpec[]
  readonly warnings: readonly Warning[]
  readonly powerSummary: PowerSummary
  /** 主线 B 扩展：虚拟设备状态挂在同一份 SSOT 上（§6.1）。 */
  readonly virtualDevices: readonly DeviceSnapshot[]
}

/**
 * 场景 mesh 的 `userData` 反查约定（§4.2.4）。
 *
 * 拾取到任意 mesh 都能直接反查 SSOT 实体 —— **场景里不维护任何业务状态**。
 * 前端构建 mesh 时必须按此挂载，否则 PickDispatcher 反查不到。
 */
export interface MeshUserData {
  readonly componentId?: string
  readonly portId?: string
  readonly protocol?: Protocol
  readonly voltage?: number
  readonly cableId?: string
  readonly anchor?: string
}

/* ──────────────────────────── 事件桥（§6.2） ──────────────────────────── */

/** 事件来源。用于过滤自己发出的事件（§6.2：`if (event.source === 'ds') return`）。 */
export type EventSource = 'user' | 'ds' | 'sim'

/** 全部事件名。 */
export type HardwareEventName =
  | 'hardware/component_placed'
  | 'hardware/component_removed'
  | 'hardware/connection_made'
  | 'hardware/connection_removed'
  | 'hardware/connection_rejected'
  | 'hardware/state_changed'
  | 'hardware/sim_started'
  | 'hardware/sim_tick'
  | 'hardware/sim_fault_injected'
  | 'hardware/sim_ended'
  | 'hardware/arbitration_result'

/** 事件公共信封。 */
export interface HardwareEventBase {
  readonly source: EventSource
  /** 事件发生时的虚拟时刻（秒）。装配期事件为 0。 */
  readonly at: number
}

export interface ComponentPlacedEvent extends HardwareEventBase {
  readonly type: 'hardware/component_placed'
  readonly component: ComponentSpec
}

export interface ComponentRemovedEvent extends HardwareEventBase {
  readonly type: 'hardware/component_removed'
  readonly componentId: string
}

export interface ConnectionMadeEvent extends HardwareEventBase {
  readonly type: 'hardware/connection_made'
  readonly connection: ConnectionSpec
  readonly compatible: true
}

export interface ConnectionRemovedEvent extends HardwareEventBase {
  readonly type: 'hardware/connection_removed'
  readonly cableId: string
}

export interface ConnectionRejectedEvent extends HardwareEventBase {
  readonly type: 'hardware/connection_rejected'
  readonly from: PortRef
  readonly to: PortRef
  readonly reason: WarningCode
}

export interface StateChangedEvent extends HardwareEventBase {
  readonly type: 'hardware/state_changed'
  readonly revision: number
}

/**
 * 仿真推进事件。
 *
 * ★ 铁律②：本事件**必须节流/合并**后才允许发往前端。
 *   `advance(1.0)` 在 step=1ms 下产生 1000 次 tick —— 逐 tick 推前端会打死链路。
 *   宿主侧按 `minIntervalMs` 合并，前端收到的 `advancedMicros` 是**区间累计量**。
 */
export interface SimTickEvent extends HardwareEventBase {
  readonly type: 'hardware/sim_tick'
  readonly now: number
  readonly nowMicros: number
  /** 自上一次投递以来累计推进的虚拟时间（微秒）。 */
  readonly advancedMicros: number
  readonly devices: readonly DeviceSnapshot[]
}

export interface SimStartedEvent extends HardwareEventBase {
  readonly type: 'hardware/sim_started'
  readonly projectPath: string
  readonly mode: SimMode
  readonly duration: number
}

export interface SimEndedEvent extends HardwareEventBase {
  readonly type: 'hardware/sim_ended'
  readonly projectPath: string
  readonly exitCode: number | null
  readonly virtualElapsed: number
  readonly wallElapsedMs: number
}

export interface SimFaultInjectedEvent extends HardwareEventBase {
  readonly type: 'hardware/sim_fault_injected'
  readonly target: string
  readonly fault: import('./device.ts').DeviceFault
}

/** 视觉仲裁结果（§6.4，并行线，本期只有类型） */
export interface ArbitrationResultEvent extends HardwareEventBase {
  readonly type: 'hardware/arbitration_result'
  readonly trigger: 'dispute' | 'self_check' | 'event_loss'
  readonly globalConsistency: number
  readonly discrepancies: readonly {
    readonly type: 'missing_in_scene' | 'missing_in_state' | 'position_mismatch'
    readonly connectionId?: string
    readonly description: string
    readonly confidence: number
  }[]
}

/** 事件联合。 */
export type HardwareEvent =
  | ComponentPlacedEvent
  | ComponentRemovedEvent
  | ConnectionMadeEvent
  | ConnectionRemovedEvent
  | ConnectionRejectedEvent
  | StateChangedEvent
  | SimTickEvent
  | SimStartedEvent
  | SimEndedEvent
  | SimFaultInjectedEvent
  | ArbitrationResultEvent

/** 仿真模式（§5.4）。 */
export type SimMode = 'realtime' | 'accelerated'
