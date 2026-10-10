/**
 * **软硬件项目**契约 —— owner: session-24ca6e69
 * @module dsh-hardware-sandbox/contracts/projects
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么要有"项目"这一层，而不是让用户一个个摆器件
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户的原话是：
 *
 *   > 右上角对话框下面应该可以选择**导入软硬件项目**，比如举例子，
 *   > 你得知道**导入的是智座项目**，并且**软硬件连接通了得有显示**
 *
 * 现在要跑通智座，得手工做四件事：放 ESP32 → 放两个 PIR → 连六根线 →
 * 配联网绑定（端点 / 设备号 / 协议 / 引脚映射）。**少一步就不通，而每一步都不报错。**
 *
 * ⇒ 这一层把"**一个真实的软硬件系统**"固化成一个可导入的对象：
 *   器件清单 + 接线 + 联网绑定 + **怎么判断它通了**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么这些是**数据**而不是代码
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 加一个新项目 = 在 {@link KNOWN_PROJECTS} 里加一条，**不动内核**。
 * 这与 `DEFAULT_NETWORK_ADAPTERS`（加协议）是同一个手法 ——
 * 而它成立的前提是**这份数据能表达真实项目里所有会变的东西**：
 * 接了哪几个器件、连到哪个脚、连的是哪个服务、**怎么算连上了**。
 *
 * ⚠️ 刻意**不做**的事：不在这里放"项目跑起来之后的状态"（是否在线、上报了几次）。
 *   那是**运行态**，属于设备注册表；这里是**装配图纸**。两者混在一起，
 *   一次 resync 就会把"图纸"和"现场"搅成同一份数据，然后谁都说不清哪个是真相。
 */

import type { NetworkBinding } from './network.ts'

/** 一个器件在项目里的位置（相对场景原点，米）。 */
export interface ProjectPart {
  /** 组件 id（项目内唯一）。★ 固定 id 而不是自动编号：接线表要引用它。 */
  readonly id: string
  /** 模型库键，如 `'esp32-seat-sensor'`。 */
  readonly hardwareModel: string
  readonly position: { readonly x: number; readonly y: number; readonly z: number }
  /** 欧拉角（弧度），省略 = 不转。 */
  readonly rotation?: { readonly x: number; readonly y: number; readonly z: number }
}

/** 一根线。`portId` 是**端口 id**（`E4`），不是丝印名（`GPIO23`）—— 见 `library.ts` 的说明。 */
export interface ProjectWire {
  readonly from: { readonly componentId: string; readonly portId: string }
  readonly to: { readonly componentId: string; readonly portId: string }
}

/**
 * **怎么判断"软硬件连接通了"**。
 *
 * ★ 这一条是用户明确要的（"软硬件连接通了得有显示"），而且**必须由项目自己定义**：
 *   智座的"通" = 设备注册上了 + 配置拉到了 + 最近一次上报成功。
 *   换成别的系统，判据完全不同（有的没有注册步骤、有的靠心跳）。
 *   ⇒ 内核只提供**原始事实**（注册了吗、上报成功几次），**判据留在项目里**。
 */
export interface ProjectLinkCheck {
  /**
   * 这几项**全部满足**才算"通"。
   *
   * | 判据 | 含义 |
   * |---|---|
   * | `registered` | 外部系统认得这台设备（智座：`POST /register` 成功过） |
   * | `config` | 拉到过配置（智座：`report_interval_ms` 等，没有它就不知道多久报一次） |
   * | `reported` | **至少成功上报过一次** |
   * | `reporting` | 最近一次上报是成功的（不是"曾经成功过"） |
   */
  readonly requires: readonly ('registered' | 'config' | 'reported' | 'reporting')[]
}

/** 一个可导入的软硬件项目。 */
export interface ProjectProfile {
  readonly id: string
  readonly label: string
  /** 一句话说明这个项目是什么 —— **给 agent 看的**，它会据此判断该不该导入。 */
  readonly description: string
  /**
   * 这个项目的**软件侧**在哪。
   *
   * ★ 放一个提示路径而不是去读它：插件**不假设自己能访问那个目录**
   *   （用户可能只装了插件、项目在另一台机器上）。它是给人和 agent 的线索。
   */
  readonly projectPathHint?: string
  /** 外部系统基址（不含路径）。 */
  readonly endpoint: string
  readonly parts: readonly ProjectPart[]
  readonly wires: readonly ProjectWire[]
  /**
   * 哪台器件出网 —— 通常是**主控**（智座里就是那块 ESP32 自己）。
   *
   * ★ 必须是 `parts` 里的 id：真机里**主控自己就是传感器节点**，
   *   而不是"另有一台联网设备"。若允许指向外部，接线关系就断了。
   */
  readonly networkComponentId: string
  readonly network: NetworkBinding
  readonly link: ProjectLinkCheck
}

/* ─────────────────────── 内置项目 ─────────────────────── */

/**
 * **智座（智能选座系统）座位传感器节点**。
 *
 * 接线与固件定义来自项目自己的文档（`D:\MAX_xiangmu`）：
 * - `docs/烧录与PIR接线操作指南.md` —— `OUT1→GPIO23(ir_front)`、`OUT2→GPIO27(ir_back)`
 * - `DEMO/platformio.ini` —— `board = esp32dev`（DOIT ESP32 DevKit V1，**GPIO23/27 都在**）
 * - 服务端 `python app.py 127.0.0.1 5800`
 *
 * ★ 端口 id 与丝印的对应（**接线表用的是 id**）：
 *   `E4` = GPIO23、`E19` = GPIO27、`E29` = 5V、`E14` = GND
 *   —— 见 `library.ts` 的 `esp32-seat-sensor`。
 */
const ZHIZUO_SEAT_NODE: ProjectProfile = {
  id: 'zhizuo-seat-node',
  label: '智座 · 座位传感器节点',
  description:
    '智座（智能选座系统）的一个座位节点：ESP32 DevKit V1 + 2× HC-SR501 红外，' +
    '开机向智座服务端注册、拉配置，然后按配置的周期上报双红外读数；' +
    '智座据此判定座位 occupied / free（释放需要连续 2 次"无人"）。',
  projectPathHint: 'D:\\MAX_xiangmu',
  endpoint: 'http://127.0.0.1:5800',
  parts: [
    { id: 'c1', hardwareModel: 'esp32-seat-sensor', position: { x: 0, y: 0.0063, z: 0 } },
    { id: 'c2', hardwareModel: 'hc-sr501', position: { x: -0.05, y: 0.0108, z: 0.03 } },
    { id: 'c3', hardwareModel: 'hc-sr501', position: { x: 0.05, y: 0.0108, z: 0.03 } },
  ],
  wires: [
    // PIR #1（前红外）→ GPIO23
    { from: { componentId: 'c2', portId: 'VCC' }, to: { componentId: 'c1', portId: 'E29' } },
    { from: { componentId: 'c2', portId: 'GND' }, to: { componentId: 'c1', portId: 'E14' } },
    { from: { componentId: 'c2', portId: 'OUT' }, to: { componentId: 'c1', portId: 'E4' } },
    // PIR #2（后红外）→ GPIO27
    { from: { componentId: 'c3', portId: 'VCC' }, to: { componentId: 'c1', portId: 'E29' } },
    { from: { componentId: 'c3', portId: 'GND' }, to: { componentId: 'c1', portId: 'E14' } },
    { from: { componentId: 'c3', portId: 'OUT' }, to: { componentId: 'c1', portId: 'E19' } },
  ],
  // ★ 那块 ESP32 **自己**出网（真机就是这样，不是另有一台联网设备）
  networkComponentId: 'c1',
  network: {
    protocol: 'zhizuo-sensor',
    endpoint: 'http://127.0.0.1:5800',
    deviceId: 'AA:BB:CC:11:22:33',
  },
  // ★ 智座的"通"：注册过 + 拉到过配置 + 成功上报过 + 最近一次也是成功的
  link: { requires: ['registered', 'config', 'reported', 'reporting'] },
}

/** 内置项目表。★ 加项目 = 在这里加一条，**不动内核**。 */
export const KNOWN_PROJECTS: Readonly<Record<string, ProjectProfile>> = {
  [ZHIZUO_SEAT_NODE.id]: ZHIZUO_SEAT_NODE,
}

/** 项目 id 列表（给界面与工具枚举）。 */
export function projectIds(): readonly string[] {
  return Object.keys(KNOWN_PROJECTS)
}

/**
 * 一个项目**当前**的状态 —— 给界面与工具用（运行态，不是图纸）。
 *
 * ★ 与 {@link ProjectProfile} 分开是有意的：那个是**装配图纸**（不会变），
 *   这个是**现场读数**（一直在变）。混在一起，一次 resync 就分不清哪个是真相。
 */
export interface ProjectStatus {
  readonly id: string
  readonly label: string
  readonly description: string
  /** 图纸上那几个器件**都在场景里**。 */
  readonly imported: boolean
  /** 软硬件连通（判据见 {@link ProjectLinkCheck}）。 */
  readonly linkUp: boolean
  /** 还没满足的判据（**要给人看** —— "没通"必须说清差什么）。 */
  readonly missing: readonly string[]
  /** 人类可读的判据说明，键是判据名。 */
  readonly requirements: Readonly<Record<string, string>>
}
