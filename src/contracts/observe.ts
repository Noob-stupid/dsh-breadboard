/**
 * **真机观察（P1）** —— 让场景里的器件反映**真实硬件**的状态。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 这一层与"虚拟设备"是**相反方向**的
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 虚拟联网设备（`NetworkRegistry`）是**我们冒充设备**，主动向外部系统发 HTTP。
 * 真机观察是**我们去问**：真板 → （HTTP）→ 智座服务端 → **我们读服务端**。
 * ⇒ 它**不产生任何对外副作用**（只读），所以可以放心开着。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★★ 最重要的一条设计：**"查不到" ≠ "设备离线"**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 状态 | 含义 | 界面该说什么 |
 * |---|---|---|
 * | `ok` | 查到了，且数据是新的 | 真机在线，显示读数 |
 * | `stale` | **查到了，但数据本身很旧** | 真机**确实离线**（最后见到是 N 分钟前）|
 * | `error` | **我们查不到**（网络/鉴权/解析失败）| **"观察失败"**，**绝不能说成设备离线** |
 *
 * ⚠️⚠️ 把 `error` 报成"设备离线"是本项目最怕的那种错：**结论看起来合理、实际完全错误**，
 *   而且它会让人去查硬件（拔插、重启板子），真正的问题却在我们这边（地址写错/没登录）。
 *   ⇒ 两者**必须分开**，且 `error` 要带上**具体原因**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 墙钟，不是虚拟时钟
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 真机按**真实时间**走 ⇒ 轮询必须用**墙钟**，**不能**跟着虚拟时钟加速
 * （与联网设备同一个坑，见 `docs/07`：加速会把对方服务器打爆）。
 */

/**
 * 观察状态。
 *
 * ★★ 五态**必须分开**（每一个混淆都会得出"看起来合理、实际错误"的结论）：
 *
 * | 状态 | 含义 | 该去查什么 |
 * |---|---|---|
 * | `idle` | 还没查过 | —— |
 * | `ok` | 查到了，数据是新的 | —— |
 * | `stale` | **查到了，但数据很旧** ⇒ 真机确实离线 | 硬件（供电/网络）|
 * | `error` | **我们查不到**（网络/鉴权/解析失败）| **地址与鉴权**，与硬件无关 |
 * | `not_found` | 服务端答得好好的，**但没有这台设备** | `deviceId` 是否写错；或它还没上过线 |
 *
 * ⚠️ 我实测踩过一次：把 `not_found` 归进 `ok`，界面上就显示成
 *   「**✅ 真机在线**」而**根本没看到这台设备** —— 正是本项目最防的那类结论。
 */
export type ObserveStatus = 'idle' | 'ok' | 'stale' | 'error' | 'not_found'

/** 一次观察到的真机事实。 */
export interface ObservedDevice {
  /** 场景里的器件（观察结果挂到它身上）。 */
  readonly componentId: string
  /** 被观察的真机标识（智座里是 WiFi MAC）。 */
  readonly deviceId: string
  readonly source: string
  readonly status: ObserveStatus
  /** 上次**成功**取到数据的时刻（ISO）。`error` 时保留上一次成功值，便于判断"多久没看到了"。 */
  readonly lastSuccessAt?: string
  /** 数据本身的**年龄**（秒）—— 服务端说"最后见到是 N 秒前"。 */
  readonly dataAgeSec?: number
  /** 服务端判定的在线（数据新鲜时为 true）。 */
  readonly online?: boolean
  /** 读到的原始读数（智座：`{ir_front, ir_back}` 之类；取不到就是空）。 */
  readonly readings: Readonly<Record<string, boolean>>
  /** 人类可读的补充说明（错误原因 / 服务端原话）。 */
  readonly detail?: string
}

/**
 * **怎么把服务端的 JSON 变成"这台真机的事实"**。
 *
 * ★ 抽成函数是为了**能测**：映射逻辑（字段名、单位、判据）最容易写错，
 *   而它错了的表现是"读数看起来正常但对应错了"——最难查。
 */
export interface ObserveMapping {
  /** 从响应里找出这台设备。返回 `undefined` = **服务端没有这台设备**（不是错误）。 */
  readonly pick: (payload: unknown, deviceId: string) => unknown | undefined
  /** 从找到的那条记录里取"数据年龄（秒）"。 */
  readonly ageSec: (record: unknown) => number | undefined
  /** 从记录里取读数。 */
  readonly readings: (record: unknown) => Record<string, boolean>
}

/** 观察配置。 */
export interface ObserveConfig {
  readonly componentId: string
  readonly deviceId: string
  /** 只读的 JSON 地址（如 `http://127.0.0.1:5800/api/admin/sensor/devices`）。 */
  readonly url: string
  /** 轮询间隔（**墙钟**毫秒）。下限由调用方约束，避免把对方服务器打爆。 */
  readonly intervalMs: number
  /**
   * **超过这个年龄就算 `stale`（真机离线）**。
   * ★ 默认取服务端自己给的 `online_timeout_minutes`，取不到才用这个兜底。
   */
  readonly staleAfterSec: number
  /** 附加请求头（如登录后的 Cookie）—— 需要鉴权的接口用。 */
  readonly headers?: Readonly<Record<string, string>>
  readonly mapping: ObserveMapping
}

/** 轮询间隔下限（墙钟毫秒）。★ 这是**保护对方服务器**的硬约束，不是建议值。 */
export const MIN_OBSERVE_INTERVAL_MS = 2000
