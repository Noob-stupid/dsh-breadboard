/**
 * **软硬件项目**契约 —— owner: session-24ca6e69
 * @module dsh-breadboard/contracts/projects
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
 * 加一个新项目 = 在 {@link SAMPLE_PROJECTS} 里加一条，**不动内核**。
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
  /**
   * **这个项目需要哪些型号的建模**（"建模台账"）。
   *
   * ★★ 用户要的行为：**切换项目时建模跟着项目走** ——
   *   A 项目 → A 的建模；切到 B → B 的建模；B 还没建 → **B 对应"空建模待建"**。
   *
   * ★ 但**几何本身仍存在全局库**（`models/<型号键>/`），不随项目切换：
   *   `esp32-seat-sensor` 这种通用主控会被多个项目引用；存 N 份的话，
   *   改了 A 的几何、B 还是旧的 ⇒ **"看起来对实际全错"**。
   *   ⇒ 项目拥有的是"**需求清单**"，不是"几何副本"；库里没有的型号在界面上
   *     显示为 **❌ 待建**（场景里是占位盒），并给出"去建 / 去导"的入口。
   *
   * ★ 省略时**由 `parts` 的型号去重推导** —— 这样"装配里已经有的"永远进台账，
   *   不需要谁记得去登记。扫描（`op:'scan-body'`）的结果可以再**补充**它
   *   （例如项目需要但装配里还没摆的型号）。
   */
  readonly requiredModels?: readonly string[]
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

/**
 * **随包样例** —— ⚠️ **不是内置项目**。新用户的项目列表是**空的**。
 *
 * ★★ 第一版这里叫 `KNOWN_PROJECTS`，把智座硬编码成"内置项目"。用户把这层说透了：
 *
 *   > 别人的插件应该是自己添加项目才对，而不是我们这个懂吗，
 *   > 别人是自己导入他们的项目，**是空的**
 *
 *   对。**智座是我们的演示，不是别人的项目。** 硬编码进来等于告诉所有用户
 *   "你只能跑这一个系统" —— 而这是个**沙盒**。
 *
 * ⇒ 这里只是**一份可以导入的样例**（等价于放在 `examples/` 里的 JSON）。
 *   真正生效的项目在 `~/.dsh/dsh-hardware-sandbox/projects/*.json`，
 *   **由用户自己添加 / 导入**（见 `core/projects/store.ts`）。
 *
 * ⚠️ 谁都不该在启动时自动把这里的东西写进用户目录 —— 那又变成"内置"了。
 *   只有用户**显式点导入**时才落盘。
 */
export const SAMPLE_PROJECTS: Readonly<Record<string, ProjectProfile>> = {
  [ZHIZUO_SEAT_NODE.id]: ZHIZUO_SEAT_NODE,
}

/** 项目 id 列表（给界面与工具枚举）。 */
export function projectIds(): readonly string[] {
  return Object.keys(SAMPLE_PROJECTS)
}

/**
 * 台账里的一项：**某个型号的建模有没有**。
 */
export interface ModelNeed {
  readonly modelKey: string
  /** 型号的人话名字（来自 `HARDWARE_MODELS`；查不到就回退成键名）。 */
  readonly label: string
  /**
   * 全局模型库里**已经有几何**。
   *
   * ★ `false` 时场景里那个器件是**占位盒**（不是"看不见"，是"看着像但有假"）——
   *   所以界面必须把"待建"说出来，而不是让用户以为那就是模型。
   */
  readonly hasGeometry: boolean
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
  /**
   * **建模台账** —— 这个项目要哪些型号的几何、现在有没有。
   *
   * ★★ 用户要的效果："**切成 B 项目，如果还没建模，那就是 B 项目对应空建模待建**"。
   *   ⇒ 切换项目时看的**不是**全局模型库，而是这个项目的台账：
   *     每一项要么 ✅ 有几何、要么 ❌ 待建，缺的给"去建/去导"的入口。
   *
   * ★ 型号集 = `requiredModels`（扫描补充过就用它）∪ `parts` 里出现的型号 ——
   *   取并集是刻意的：**装配里已经摆着的**永远该进台账，
   *   而扫描可能还额外发现"项目需要但还没摆上来"的。
   */
  readonly modelNeeds: readonly ModelNeed[]
  /** 台账里 **❌ 待建**的型号键（给"缺什么"一个直接可用的清单）。 */
  readonly missingModels: readonly string[]
  /**
   * **完整图纸**。
   *
   * ★ 带上它是为了让界面能**导出**（用户原话：「这个也能**选择路径保存**」）——
   *   导出要的是整份 `ProjectProfile`，而状态里原本只有摘要。
   * ★ 一份项目只有几 KB，随列表一起发不构成负担；分两条路由反而多一次往返，
   *   而且"列表里有、详情拉不到"是另一类要单独处理的失败态。
   */
  readonly profile: ProjectProfile
}
