/**
 * 联网设备契约 —— 冻结契约（owner: session-24ca6e69）
 * @module dsh-hardware-sandbox/contracts/network
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么这是**第二类**虚拟硬件，而不是"又一种设备"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * {@link VirtualDevice}（`device.ts`）的 `tick` 契约原文是：
 *
 *   > **`tick` 必须纯同步、无 IO、无真随机。**
 *
 * 这一条**从结构上**排除了联网设备 —— 它天生要做 IO，而且是**不可确定**的
 * （对面是个真服务器）。所以联网设备**不是** `VirtualDevice` 的一个实现，
 * 它是**并列的另一类**：
 *
 * | | 总线设备（I2C） | **联网设备** |
 * |---|---|---|
 * | 驱动 | **虚拟时钟**（可加速、可跳空） | **墙钟**（真实节拍） |
 * | 时序 | 确定性、可复现 | 依赖外部系统 |
 * | IO | 无（纯函数式） | **有**（HTTP） |
 * | 发起方 | **被动**（等被读） | **主动**（自己周期上报） |
 * | 进 SSOT | `virtualDevices` | `virtualDevices`（同一份真相） |
 *
 * ★ **为什么驱动源必须不同**（这条是本设计里最容易做错的地方）：
 *   虚拟时钟是**加速**的。智座设备 `report_interval_ms = 1000`，
 *   若把它挂在加速时钟上，一次 `advance(60)` 会瞬间打出 60 次真实 HTTP ——
 *   **把对方的服务器打爆**。所以联网设备按**墙钟**走，与虚拟时钟解耦。
 *   ⇒ 反过来说：**联网设备存在时，"虚拟时间"对它们没有意义**，
 *     界面与工具必须如实说明这一点，不能假装它们也在虚拟时间里跑。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 传输是**注入**的（与 `SimSpawner` 同一手法）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 设备不直接 `fetch`，而是拿一个 {@link NetworkTransport}。
 * 理由与 `SimEngine` 注入 spawner 完全一致：**内核零依赖宿主 API**（§10.3），
 * 且测试可以在**不联网**的情况下跑完整条逻辑。
 */

/* ─────────────────────── JSON 标量 ─────────────────────── */

/** JSON 标量。读数与协议配置都用它。 */
export type JsonScalar = number | string | boolean | null

/**
 * 扁平标量记录 —— **读数、配置、协议参数都用这个形状**。
 *
 * ★ 刻意**不支持嵌套**：目前所有已知协议（智座的 `config`、读数）都是扁平的。
 *   为一个还没出现的需求先设计嵌套，就是"猜"，而猜出来的结构一定会与真实需求错位。
 *   真需要时再扩 —— 那时有真实形状可依。
 */
export type JsonRecord = Readonly<Record<string, JsonScalar>>

/* ─────────────────────── 传输 ─────────────────────── */

export interface NetworkRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** 完整 URL（由适配器用 `endpoint` 拼出来）。 */
  readonly url: string
  /** 请求体（JSON 序列化）。GET 时为 undefined。 */
  readonly body?: JsonRecord
  readonly headers?: Readonly<Record<string, string>>
}

export interface NetworkResponse {
  /** HTTP 状态码。 */
  readonly status: number
  /** 解析后的 JSON（解析失败则 undefined）。 */
  readonly body?: unknown
  /** 原始文本，**失败诊断时必须有** —— 只报状态码等于丢掉线索。 */
  readonly text?: string
}

/**
 * 出网能力注入点。宿主半用真实 `fetch` 实现它；测试用假实现。
 *
 * ★ 实现**不应**在非 2xx 时抛 —— 把状态码如实返回，由适配器决定怎么解读。
 *   原因：智座把业务错误也放在 body 里（`{success:false, message:'…'}`），
 *   一律当异常抛会丢掉那句 message。
 */
export type NetworkTransport = (
  request: NetworkRequest,
  signal?: AbortSignal,
) => Promise<NetworkResponse>

/* ─────────────────────── 接入配置 ─────────────────────── */

/**
 * 一台联网设备的**接入配置** —— 描述"这台设备怎么连到外部系统"。
 *
 * ★ 它与**硬件型号**正交：同一个 `esp32-*` 型号可以是智座的座位传感器，
 *   也可以是别的协议。所以它挂在**组件实例**上（`ComponentSpec.network`），
 *   不是挂在模型库条目上。
 */
export interface NetworkBinding {
  /** 协议适配器 id，如 `'zhizuo-sensor'`。 */
  readonly protocol: string
  /** 外部系统基址，如 `'http://127.0.0.1:5800'`。**不含**路径。 */
  readonly endpoint: string
  /** 设备自报的身份（智座里是 WiFi MAC，形如 `AA:BB:CC:11:22:33`）。 */
  readonly deviceId: string
  /** 协议特定的附加参数（如座位绑定）。 */
  readonly options?: JsonRecord
  /**
   * ★★ **读数 ← 板上的哪个引脚** —— 把「装配里接了什么」和「上报什么」连起来。
   *
   * ```ts
   * pinMap: { ir_front: 'GPIO23', ir_back: 'GPIO27' }   // 键 = 读数名，值 = 端口丝印名
   * ```
   *
   * ★ 为什么需要它（这是"硬件在环"这句话的**实际含义**）：
   *   没有它时，读数只能由 `hw_network_set_reading` **直接设**——那测的是**协议**，
   *   数字**从哪来的**完全没被检验。有了它，读数由**实际接线**决定：
   *
   * ```text
   *   遮挡装配里的 PIR  →  沿接线找到 ESP32 的 GPIO23  →  按本表映射到 ir_front  →  上报
   * ```
   *
   * ⇒ **PIR 没接上，遮挡就没有任何效果** —— 这不是缺点，恰恰是**可被测出来的真实行为**
   *   （真机上把 PIR 拔了，就是不会有读数变化）。
   *
   * ⚠️ 值是**端口的丝印名**（`Port.name`），不是 `portId` —— 因为这里的语义是
   *   "**板子上印着 GPIO23 的那个脚**"，而 `portId`（`E4`）是我们的内部编号，**接线员的语言里没有它**。
   *   名字里带复用后缀（如 `'GPIO23 · VSPI_MOSI'`）时按**前缀匹配**（见 `matchesPin`）。
   */
  readonly pinMap?: Readonly<Record<string, string>>
}

/* ─────────────────────── 协议适配器 ─────────────────────── */

/** 一次协议调用的结果。 */
export interface NetworkCallOutcome {
  readonly ok: boolean
  /** 响应体里对设备有用的那部分（协议自己挑出来）。 */
  readonly data?: JsonRecord
  /** 失败原因（**人话**，直接给 DS 与用户看）。 */
  readonly message?: string
  /**
   * 外部系统**不认识这台设备**（如智座 `registered:false`）。
   *
   * ★ 单独一个字段而不是让调用方从 message 里猜：它是**可执行的信号**
   *   （"该回去重新注册了"），而 message 是给人看的。混在一起就必然有人去正则匹配文案。
   */
  readonly needsRegister?: boolean
}

/** 适配器每次调用拿到的上下文。 */
export interface NetworkCallContext {
  readonly transport: NetworkTransport
  readonly endpoint: string
  readonly deviceId: string
  readonly options: JsonRecord
  /**
   * 设备**当前**的配置（外部系统下发的那份），未拿到时为 undefined。
   *
   * ★★ 为什么必须传进来（这是实测暴露的契约缺口）：
   *   设备"该上报哪个座位"**是服务端告诉它的** —— 智座 `_device_config_payload()`
   *   返回 `seat_id`/`seat_label`/`floor_id`，管理员在面板上绑定。
   *   早先 `report()` 只看 `options.seat_id`（创建时写死的），于是：
   *   · 面板上改了绑定 ⇒ 设备仍往**旧座位**上报（**而且不报错**）
   *   · 创建时没写 options ⇒ 直接报"没绑定座位"，**即使服务端已经绑好了**
   *   ⇒ 适配器需要看得到配置，才能以**服务端**为准。
   *
   * ★ 优先级约定：**配置 > options**。配置是权威（管理员在面板上设的），
   *   options 只是"配置还没到手"时的兜底初值。
   */
  readonly config?: JsonRecord
  readonly signal?: AbortSignal
}

/**
 * 协议适配器 —— 「某一种联网设备怎么说话」的全部知识。
 *
 * ★ 加一个新协议 = 加一个适配器，**不动内核**。这是这条线可扩展的唯一原因。
 */
export interface NetworkProtocolAdapter {
  readonly id: string
  /** 一句话说明，给 DS 与界面看。 */
  readonly description: string
  /**
   * 本协议**上报哪些读数键**（如 `['ir_front','ir_back']`）。
   *
   * ★ 存在的理由：界面与工具要据此生成默认读数。
   *   没有它，调用方只能硬编码键名 —— 那就是把协议知识漏到了内核里。
   */
  readonly readingKeys: readonly string[]
  /** 开机注册。 */
  register(ctx: NetworkCallContext): Promise<NetworkCallOutcome>
  /** 周期拉配置（"改配置免重烧"靠它）。 */
  pullConfig(ctx: NetworkCallContext): Promise<NetworkCallOutcome>
  /** 上报一次读数。 */
  report(ctx: NetworkCallContext, reading: JsonRecord): Promise<NetworkCallOutcome>
  /**
   * 从配置里取上报间隔（毫秒）。配置缺失时给**默认值**。
   *
   * ★ 由适配器决定而不是内核定死：间隔是协议概念（智座从服务端下发）。
   */
  intervalMs(config: JsonRecord | undefined): number
  /**
   * 把**物理读数**翻译成**协议要发的原始值**（可选）。
   *
   * ★ 典型用途：智座的 `ir_active_high` —— 它决定"遮挡时读到 1 还是 0"。
   *   搞反的症状是**"人坐下反而释放"，且不报任何错**，所以这段翻译
   *   必须待在**协议自己**这里，而不是散在调用方。
   */
  translate?(config: JsonRecord | undefined, reading: JsonRecord): JsonRecord
  /**
   * **默认引脚映射**：读数名 → 板上的引脚丝印名（如 `{ ir_front: 'GPIO23' }`）。
   *
   * ★ 它属于**协议**而不是某一台设备：智座的固件写死了「`ir_front` 读 GPIO23、
   *   `ir_back` 读 GPIO27」——**换一台设备也是这两个脚**。
   *   所以默认值放这里，`NetworkBinding.pinMap` 只在需要**逐台覆盖**时才写。
   *
   * ★ 有了它，`hw_set_occlusion` 才能把「遮挡装配里的 PIR」传导到读数上 ——
   *   见 {@link NetworkBinding.pinMap} 的说明。
   */
  readonly defaultPinMap?: Readonly<Record<string, string>>
}

/* ─────────────────────── 设备状态 ─────────────────────── */

/**
 * 联网设备的生命周期状态。
 *
 * ★ 映射到 {@link DeviceSnapshot.status}（`ok`/`busy`/`disconnected`/`faulted`）
 *   时是**满射**的，所以不需要扩 `DeviceStatus` —— 前端已有的着色逻辑直接可用：
 *   `idle`/`registering` → `busy`，`online` → `ok`，`error` → `faulted`，`stopped` → `disconnected`
 */
export type NetworkDeviceStatus =
  | 'idle'          // 已创建，未启动
  | 'registering'   // 正在注册
  | 'online'        // 注册成功、周期上报中
  | 'error'         // 最近一次调用失败（**可恢复** —— 下一轮成功就回 online）
  | 'stopped'       // 已停止

/** 把联网设备状态映射到通用 `DeviceStatus`（前端着色用）。 */
export function toDeviceStatus(status: NetworkDeviceStatus): 'ok' | 'busy' | 'disconnected' | 'faulted' {
  switch (status) {
    case 'online':
      return 'ok'
    case 'idle':
    case 'registering':
      return 'busy'
    case 'error':
      return 'faulted'
    case 'stopped':
      return 'disconnected'
  }
}

/** 一台联网设备的运行快照（供 SSOT 投影与 DS 观察）。 */
export interface NetworkDeviceSnapshot {
  readonly id: string
  readonly label: string
  readonly protocol: string
  readonly endpoint: string
  readonly deviceId: string
  readonly status: NetworkDeviceStatus
  /** 外部系统下发的配置（最近一次拿到的）。 */
  readonly config?: JsonRecord
  /** 当前待上报的物理读数。 */
  readonly reading: JsonRecord
  /** 成功上报次数。 */
  readonly reports: number
  /** 失败次数（**不清零** —— 清掉就看不出"一直在失败但偶尔成功"）。 */
  readonly failures: number
  /** 最近一次错误（人话）。成功一次后**保留**，便于回看。 */
  readonly lastError?: string
  /** 最近一次成功上报的时刻（墙钟，ISO 串）。 */
  readonly lastReportAt?: string
  /**
   * 虚拟时间对这台设备**没有意义** —— 它按墙钟走。
   *
   * ★ 显式放在快照里，而不是靠调用方记得：界面若把联网设备的时刻
   *   画在虚拟时间轴上，用户会以为它跟着仿真加速。
   */
  readonly wallClockDriven: true
}
