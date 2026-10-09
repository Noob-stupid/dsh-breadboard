/**
 * 前端 ↔ 宿主 协议契约 —— 冻结契约（owner: session-24ca6e69）
 * @module dsh-hardware-sandbox/contracts/protocol
 *
 * ★ 为什么是 HTTP/WS 而不是 `host.call`：
 *   `host.call` 只存在于「动态 Cordis 插件」的 runner 路径（cordis-client-runner），
 *   **bundle 插件的前端半根本没有这个符号**（已对整个 checkout 做过 grep 核对）。
 *   本插件是 bundle 插件，所以桥接一律走宿主半 `ctx.webServer.register` + 前端 fetch。
 */
import type { AssemblySnapshot, HardwareEvent, Vec3 } from './assembly.ts'

/** 本插件的全部路由前缀。 */
export const ROUTE_PREFIX = '/@dsh-breadboard/dsh-hardware-sandbox' as const

/**
 * HTTP 路由（`ctx.webServer.register`）。
 *
 * ★ 唯一出处就是本文件。前端 `src/scene/endpoints.ts` 用
 *   `export { HTTP_ROUTES, ROUTE_PREFIX, WS_ROUTE } from '../contracts/protocol.ts'`
 *   **转出**（不是镜像、不是抄字面量）—— 因此不存在「两份需要手工同步」的分叉面。
 *   契约改了前端自动跟随。**不要在前端内联路径字面量。**
 */
export const HTTP_ROUTES = {
  /** GET  → AssemblySnapshot（含 virtualDevices）。场景首帧与轮询兜底。 */
  assembly: `${ROUTE_PREFIX}/api/assembly`,
  /** POST → 执行一个装配/仿真动作。body: ClientAction → ActionResult。 */
  action: `${ROUTE_PREFIX}/api/action`,
  /** GET  → 插件与宿主能力自检（§10.1 HostCapabilities）。 */
  capabilities: `${ROUTE_PREFIX}/api/capabilities`,
} as const

/** WebSocket 升级路由（`ctx.webServer.registerUpgrade`）。前端订阅事件流。 */
export const WS_ROUTE = `${ROUTE_PREFIX}/ws` as const

/**
 * 面板内浮层输入框 → 给当前会话发一条用户消息。
 *
 * ★★ 这条通道**是真的**，但很容易找错（我第一遍就找错了）：
 *
 *   | 看起来像 | 实际是什么 |
 *   |---|---|
 *   | `commands.execute(agent, line, …)` | 文档原文 **"execute a known command *without sending it to the model*"** —— 斜杠命令，**不产生对话轮次** |
 *   | `Session.append('user/message', …)` | 只往**日志**里写事件，**不驱动 agent loop** |
 *   | **`Agent.followup(input)`** | ✅ `send(input,'next-turn',true)` —— **就是"用户发消息、开新一轮"** |
 *
 *   前两个做出来的是"**看着像发了消息、其实模型没收到**"，正是本项目失败族的形态。
 *   出处：`packages/core/agent-loop/src/agent.ts`（`send`/`followup`/`steer`/`inject`）。
 *
 * ★ 消息形状（`packages/llm/llm/src/message.ts` 的 `createUserMessage`）：
 *   `{ id, role: 'user', content: [{ type:'text', text }], source: { kind:'user' } }`
 *   **我们结构等价地构造它**，不 import `@deepseek-ai/dsh-llm` ——
 *   那是核心包，运行时不在 profile 的 node_modules 里（只有 checkout 的 types），
 *   值导入会 ERR_MODULE_NOT_FOUND。§10.3 也要求内核零依赖宿主 API。
 */
export const CHAT_ROUTE = `${ROUTE_PREFIX}/api/chat` as const

export interface ChatSendRequest {
  /** 要发送的文本（非空）。 */
  readonly text: string
  /**
   * 目标会话 id。
   *
   * ★ 省略时退化为「**只有一个活动 Agent 就用它**」；有多个则**拒绝**。
   *   **绝不猜** —— 猜错会把消息发进别人的会话，那是不可接受的。
   */
  readonly sessionId?: string
}

export interface ChatSendResult {
  readonly ok: boolean
  /** 实际投递到的会话。 */
  readonly sessionId?: string
  /** 新消息的 id（便于前端去重/回显）。 */
  readonly messageId?: string
  /** 失败原因（人话）。 */
  readonly reason?: string
}

/* ─────────────────────── 用户导入的模型（几何） ─────────────────────── */

/**
 * 模型导入路由。
 *
 * ★ **为什么是"用户导入"而不是"我们采集"**（这条决定了整个设计）：
 *   厂商条款约束的是**我们的**批量/自动化采集，且明文允许「个人按普通方式浏览、下载、使用单个项目」。
 *   用户自己下载一个模型文件**不在条款射程内**；而且模型可以来自**任何**合法渠道
 *   （原厂官网 / GrabCAD / 用户自己的 CAD），那些根本不是 "Content available on the Services"。
 *
 *   ⇒ **我们不采集、不分发**，因此：无采集合规问题、无再分发问题、无需第三方客户端、
 *     也不受"元件库只索引芯片"的类别错配限制（用户导入的是**他手上那个东西**）。
 *
 * ★ 存储位置：**宿主侧的用户数据目录**，**不在插件包内** —— 我们不分发任何第三方模型。
 *
 * ⚠️ 路由形态：宿主只支持 `exact` / `prefix` 两种匹配，**没有路径参数**。
 *   所以用「精确 `/api/model`（列表）+ 前缀 `/api/model/`（单项）」两条，
 *   由 handler 自己从前缀后解析 modelKey。
 */
export const MODEL_ROUTES = {
  /**
   * 模型 API 的基础路径。**列表用 exact 匹配它；单项用 prefix 匹配它。**
   *
   * · `GET <base>` → {@link ImportedModelList}（**裸数组**）
   * · `GET <base>/<key>` → 模型文件本体（`content-type` 按格式，`cache-control: no-store`）
   * · `POST <base>/<key>` → 上传字节 → `{ ok, record }`
   * · `DELETE <base>/<key>` → `{ ok: boolean }`（不存在时 404）
   *
   * ⚠️⚠️ **宿主约定：`WebRoute.path` 不能带尾斜杠**（源码注释原文 "Absolute pathname, no trailing slash"）。
   *   宿主匹配规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`，
   *   带尾斜杠会被拼成 `.../model//`，**永远匹配不上任何请求**。
   *   实测踩过：带尾斜杠时 GET 得到空 body 404、POST/DELETE 得到空 body 405，
   *   而 handler 一行日志都不会出现 —— 看起来像"路由注册失败"，实际是**匹配规则用错了**。
   *
   *   精确表先于前缀表匹配，所以 `<base>` 本身仍走列表路由。
   */
  base: `${ROUTE_PREFIX}/api/model`,
  /**
   * GET `?q=<查询词>` → `ModelSearchResult`。**面板内直接出结果列表**。
   *
   * ★ 走的是**宿主自带的搜索服务**（`ctx.web.search`），不是抓取某个厂商站点。
   *   这一点决定它是否合规：
   *   · 我们**不解析、不镜像、不索引**任何站点 —— 搜索由 harness 的搜索提供方完成
   *   · 我们**不批量采集** —— 每次都是用户主动发起的一次查询
   *   · 结果只是**链接**，用户点进去自己下载（条款明文允许的 "ordinary course"）
   *
   *   ⚠️ 对比：直接抓 EasyEDA/LCSC 的搜索页是 **403 + 条款明文禁止**（见 `docs/03` §8.5）。
   *   两者看着都像"搜索"，但一个走的是通用搜索、一个是自动化访问特定平台。
   */
  search: `${ROUTE_PREFIX}/api/model-search`,
  /**
   * POST `{ modelKey, partId }` → `{ ok, record }`。**一键导入**。
   *
   * ★ **SSRF 面为零**：客户端只给 **`partId`**，`glbUrl` 由**宿主自己**从 step.parts API 取。
   *   URL 从不由客户端提供，所以不存在"让宿主去抓任意地址"这条路。
   *
   * ★ 全程**不跳浏览器** —— 这正是不满足于通用搜索外链、而要做结构化候选的理由。
   */
  import: `${ROUTE_PREFIX}/api/model-import`,
} as const

/** 一条搜索结果（宿主 `WebSearchSource` 的可序列化子集）—— **外链**，用户自己点进去下。 */
export interface ModelSearchSource {
  readonly url: string
  readonly title?: string
  readonly snippet?: string
}

/**
 * 一条**可一键导入的**模型候选（来自有公共 API 的来源，目前是 step.parts）。
 *
 * ★ 与 {@link ModelSearchSource} 的区别：那个是**外链**（用户自己去下），
 *   这个是**结构化的、宿主可代取的**。
 */
export interface ModelCandidate {
  /** 来源 id。目前只有 `'step.parts'`。 */
  readonly source: string
  /** 来源内的唯一 id —— 导入时**只传它**。 */
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly manufacturer?: string
  readonly category?: string
  readonly family?: string
  readonly tags: readonly string[]
  /** GLB 直链（宿主用它代取；**不从客户端接收**）。 */
  readonly glbUrl: string
  /** 预览图（PNG）。让用户不必盲下大文件。 */
  readonly previewUrl?: string
  /** 来源页面（想看详情时用）。 */
  readonly pageUrl?: string
  readonly byteSize?: number
  /**
   * 来源给出的**板卡尺寸（毫米）**。
   *
   * ★ 可直接当契约 `size` 的**初值**（`docs/03` §6.3 甲方案）—— 比从 GLB 反推 bbox 可靠。
   *   ⚠️ **厚度通常缺失**，需从几何量或人工补。
   */
  readonly sizeMm?: { readonly length?: number; readonly width?: number }
  /** 是否可一键导入（有 GLB 直链即为真）。 */
  readonly importable: boolean
  readonly apiUrl?: string
}

export interface ModelSearchResult {
  readonly query: string
  /** **可一键导入的候选**（step.parts）。优先展示这一组。 */
  readonly candidates: readonly ModelCandidate[]
  /** **外链**兜底（通用搜索），用户自己点进去下。 */
  readonly sources: readonly ModelSearchSource[]
  /** 搜索提供方生成的摘要（部分提供方有，如 Perplexity）。 */
  readonly content?: string
  /** 某个来源不可用时的说明（如宿主未提供 `web` 服务）。 */
  readonly unavailable?: string
}

/**
 * 判断一个 URL 是否**看起来是可直接导入的模型文件**。
 *
 * ★ 用途：搜索结果里如果直接指向 `.glb`/`.gltf`，界面就可以给「一键导入」，
 *   省掉"点进页面 → 找下载按钮 → 再回来导入"的三步。
 *   **只是启发式** —— 最终以服务端按内容检测的格式为准（不信扩展名、不信 content-type）。
 */
export function looksLikeModelFile(url: string): boolean {
  try {
    const pathname = new URL(url).pathname.toLowerCase()
    return pathname.endsWith('.glb') || pathname.endsWith('.gltf')
  } catch {
    return false
  }
}

/**
 * 构造单项模型的 URL。
 *
 * ★ 做成**函数**而不是让调用方自己拼 `base + key` —— 那样**必然会有人漏掉中间的斜杠**
 *   （实测：契约改成不带尾斜杠后，测试里 `itemPrefix + 'bme280'` 拼成了 `modelbme280`）。
 *   拼接规则收在一处，调用方就没有出错的机会。
 */
export function modelItemUrl(modelKey: string): string {
  return `${MODEL_ROUTES.base}/${encodeURIComponent(modelKey)}`
}

/**
 * modelKey 的合法形状。
 *
 * ★ **这是安全边界，不是风格约定**：modelKey 会**拼进文件名**。
 *   不做校验就等于开了一个目录穿越漏洞（`../../` 可写到任意路径）。
 *   所以：只允许小写字母数字与 `._-`，必须以字母数字开头，禁止 `..`。
 */
export const MODEL_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/

/**
 * 单个模型文件的大小上限（字节）。默认 **64 MiB**。
 *
 * ⚠️ 32 MiB 曾经不够用：实测 **Raspberry Pi 4 Model B 的 GLB 是 52,486,607 字节**。
 *   提到 64 MiB 后主流板卡都装得下；再大的会被明确拒绝而不是静默失败。
 */
export const MODEL_MAX_BYTES = 64 * 1024 * 1024

/**
 * 可导入的几何格式 —— **以「three.js 有对应 loader」为准**，不是以"看起来像 3D"为准。
 *
 * ★★ 为什么必须放开到这么多种（这是一处真实的产品缺陷，不是完备性偏好）：
 *
 *   最初只收 `glb`/`gltf`，结果是**用户搜到模型却导不进来**：
 *
 *   | 来源 | 给什么格式 | 备注 |
 *   |---|---|---|
 *   | GrabCAD | STEP 为主 | **要登录**才能下载 |
 *   | **Printables / Thingiverse** | **STL** | **免费、免登录** ← 最可及的一类 |
 *   | SnapEDA / Ultra Librarian / DigiKey | STEP | 要注册 |
 *   | **KiCad 3D 库** | **STEP + WRL** | **开源、免登录、可直连**，但**只有芯片封装** |
 *
 *   ⇒ 世界里现成的模型**绝大多数不是 glTF**。只收 glTF 等于把最可及的那些来源全挡在门外。
 *
 *   ⚠️ **STEP / IGES 仍然不收** —— three.js **没有**对应 loader（实测 `examples/jsm/loaders/` 下不存在）。
 *     收下来也渲染不了，只会让用户以为成功了。**宁可明确拒绝，也不要静默存一个打不开的文件。**
 */
export type ModelFormat =
  | 'glb' // 二进制 glTF
  | 'gltf' // JSON glTF
  | 'stl' // 3D 打印社区主流（Printables / Thingiverse）
  | 'obj' // 通用交换格式
  | 'ply'
  | '3mf'
  | 'dae' // Collada
  | 'fbx'
  | 'wrl' // VRML —— KiCad 3D 库的格式

/** 一条已导入模型的记录。 */
export interface ImportedModelRecord {
  readonly modelKey: string
  /** 文件格式。由**内容**判定，不看扩展名、不信 content-type。 */
  readonly format: ModelFormat
  /** 字节数。 */
  readonly bytes: number
  /**
   * glTF/GLB 的**节点数**（其它格式或数不出来时省略）。
   *
   * ★★ 为什么记这个（它是性能画像里最容易被忽略的量）：
   *   实测踩到 —— 有一处在**每次鼠标移动**时做 `scene.traverse()`。
   *   占位盒时代全场景 **1 个节点**，成本是 1，**完全隐形**；
   *   真树莓派模型 **2067 个节点**，成本涨**三个数量级**，而它**不报错、只是变卡**。
   *
   *   ⇒ **换真几何会改变性能画像，不只是"好看一点"。**
   *     在导入时量出来，就让这个量从"事后才发现"变成"一开始就知道"。
   *
   * ⚠️⚠️ **但这个数是两种成本的代理，而两者的修法完全不同** ——
   *   **看到它涨了，并不能直接推出该修哪一边**：
   *
   *   | 成本 | 随 `nodes` 的关系 | 修法 |
   *   |---|---|---|
   *   | **遍历**（`traverse` / `getObjectByName`） | 每次调用 ×1 遍 | **缓存** / 按场景重建失效 |
   *   | **绘制**（draw call） | **每帧一遍** | **合并几何** / 实例化 —— **缓存救不了** |
   *
   *   2067 个 mesh ⇒ **每帧 2067 次 draw call**（three.js 不会自动批处理）。
   *   这一份是**模型自身的结构**，不是调用方式，所以缓存对它无效。
   *
   *   ⇒ **用户报"卡"时，先量 `renderer.info.render.calls`，不要先找 `traverse`：**
   *     · 数量级 ≈ `nodes` ⇒ **绘制瓶颈** ⇒ 合并同材质 primitive
   *     · 远小于 `nodes` ⇒ three.js 已在批 ⇒ 回头找剩下的遍历
   *
   * ⚠️⚠️ **合并几何不是纯赚 —— 它会造出一个新的成本，而那个成本不告警：**
   *
   *   | | 合并前 | 合并后 |
   *   |---|---|---|
   *   | 绘制 | 2067 次 draw call / 帧 | **1 次** ✅ |
   *   | **拾取**（点一下） | 逐个测 2067 个 mesh 的**包围球**，射线只穿过少数几个 ⇒ 只测那几个的三角形 | **一个 mesh、无空间加速结构 ⇒ 逐个测全部 ~125k 三角形** ❌ |
   *
   *   （JS 里量级约 **5–15ms / 次点击**。点击频率下可接受，但**它是同一族的动作：
   *    修一个成本的时候造出另一个成本，而新的那个不会告警**。）
   *
   * ⚠️⚠️ **合并之后，这个数就不再描述场景了。**
   *   `nodes` 描述的是**文件**；合并后场景里只有 1 个 mesh。
   *   ⇒ 它从"场景成本的代理"**退化成"文件结构的记录"**。
   *   这不算错，但**必须说清** —— 否则有人拿它预测运行时成本会**高估 2000 倍**，
   *   然后去找一个**不存在**的性能问题。（**反向的同一个错。**）
   *
   * ⚠️ 是 **节点数不是 mesh 数**：`Object3D.traverse()` 访问节点，遍历成本由它决定。
   */
  readonly nodes?: number
  /** 导入时间（ISO 串）。 */
  readonly importedAt: string
  /**
   * 该模型**经用户确认**的尺寸（米）。
   *
   * ⚠️ **只在「用户自定义的新型号」上出现。**
   *   对**已有 `modelKey`**（如 `bme280`），`size` 一律以 `HARDWARE_MODELS` 为准 ——
   *   导入的几何只是**换装**，会被归一化到那个已声明的 `size`。
   *   ⇒ **不产生第二个尺寸真源。**
   *
   *   对新 key，这个值来自「模型自身 bbox 作为**初值** → 用户在界面上确认/修正」。
   *   bbox 只是**提议**，确认后的值才是权威。
   */
  readonly size?: { readonly x: number; readonly y: number; readonly z: number }
  /** 用户为该模型填的展示名（可选）。 */
  readonly label?: string
}

/**
 * `GET <MODEL_ROUTES.base>` 的响应 —— **裸数组**，不是 `{ models: [...] }` 包装。
 *
 * ★ 为什么补这个别名：路由实现是 `sendJson(res, 200, await models.list())`，
 *   而契约里原本**只声明了单条记录**（{@link ImportedModelRecord}）。
 *   前端于是只能写内联标注 `as readonly ImportedModelRecord[]`（`src/scene/importer.ts` 就是这样）
 *   —— 那份标注**不在契约里**，改起来没人知道要跟着改。
 *
 * ★ 保持**裸数组**而不是改成包装对象：前端已经按裸数组写好了，
 *   为了"更好看"去改形状 = 让对方的代码当场失效。
 *   契约的价值是**把既有事实写准**，不是把既有事实改样。
 */
export type ImportedModelList = readonly ImportedModelRecord[]

/** 上传模型的响应。 */
export interface ImportModelResult {
  readonly ok: boolean
  readonly record?: ImportedModelRecord
  readonly reason?: string
}

/** 前端发给宿主的动作（POST /action 的 body）。 */
export type ClientAction =
  | { readonly kind: 'place_component'; readonly hardwareModel: string; readonly position: { x: number; y: number; z: number } }
  | { readonly kind: 'remove_component'; readonly componentId: string }
  | { readonly kind: 'move_component'; readonly componentId: string; readonly position: { x: number; y: number; z: number } }
  /**
   * 钉住 / 解开一个组件（右键菜单）。
   *
   * ★ 用**显式的 `pinned` 布尔**而不是 `toggle`：
   *   toggle 在"界面以为的状态"与"SSOT 实际状态"不一致时（如刚 resync 完）
   *   会**朝反方向**执行，而且没人能发现。显式值让重复点击是幂等的。
   */
  | { readonly kind: 'set_pinned'; readonly componentId: string; readonly pinned: boolean }
  /**
   * **旋转组件**（欧拉角，弧度，绕**自身几何包围盒中心**）。
   *
   * ★ 与 `set_pinned` 一样用**显式值**而不是增量（`+90°`）：增量在"界面以为的角度"
   *   与"SSOT 实际角度"不一致时（刚 resync 完、或上一次拖动被拒）会**朝错误的方向累加**，
   *   而且没人能发现。显式值让重放与重试都是幂等的。
   */
  | { readonly kind: 'set_rotation'; readonly componentId: string; readonly rotation: Vec3 }
  | { readonly kind: 'connect'; readonly from: { componentId: string; portId: string }; readonly to: { componentId: string; portId: string } }
  | { readonly kind: 'disconnect'; readonly cableId: string }

/** 动作执行结果。 */
export interface ActionResult {
  readonly ok: boolean
  /** 失败原因码（复用 WarningCode）。 */
  readonly reason?: string
  /** 成功时的新快照，省一次往返。 */
  readonly snapshot?: AssemblySnapshot
}

/**
 * 宿主推给前端的消息。
 *
 * ★ 铁律②：`event` 里的 `hardware/sim_tick` **已在宿主侧节流合并**，
 *   前端拿到的 `advancedMicros` 是区间累计量，不是逐 tick 一条。
 */
export type HostToClientMessage =
  | { readonly kind: 'hello'; readonly revision: number; readonly snapshot: AssemblySnapshot }
  | { readonly kind: 'snapshot'; readonly snapshot: AssemblySnapshot }
  | { readonly kind: 'event'; readonly event: HardwareEvent }

/** 前端发给宿主的 WS 消息。 */
export type ClientToHostMessage =
  | { readonly kind: 'resync' }
  | { readonly kind: 'ping'; readonly t: number }

/**
 * 宿主能力探测结果（§10.1 HostCapabilities）。
 *
 * ★ 内核据此降级：`externalProcess === false` 时主线 B 不可用，
 *   插件仍应提供主线 A（3D 协作），只是禁用仿真按钮。
 */
export interface HostCapabilities {
  /** 3D 场景可用（前端 bundle 已加载）。 */
  readonly scene: boolean
  /** 外部进程可用（★ 主线 B 的硬前提）。 */
  readonly externalProcess: boolean
  /** 多角度渲染可用（视觉仲裁依赖，本期后置）。 */
  readonly renderCapture: boolean
  /** 视觉分析工具可用（视觉仲裁依赖，本期后置）。 */
  readonly vision: boolean
  /** 本机 Python 解释器探测结果，如 'E:\\python314\\python.exe'；undefined = 不可用。 */
  readonly pythonPath?: string
  /**
   * 构建标记（构建时刻的 ISO 时间串）。
   *
   * ★ 存在的理由很具体：热重载**可能报成功但模块并未真正换掉**（实测踩过）。
   *   没有它，你无法区分「新代码没生效」与「新代码有 bug」——只能靠 revision 之类的
   *   间接指纹去猜。有了它，`GET /api/capabilities` 一眼就能确认**当前活着的是哪一次构建**。
   */
  readonly build?: string
  /**
   * **实际注册成功**的硬件工具名。
   *
   * ★ 为什么要暴露它：工具注册失败是**静默**的 —— 模型只会说"我没有这个能力"，
   *   界面上看不出任何异常，日志也未必看得到。把真实名单摆在这里，就把
   *   「工具没注册」与「注册了但调用失败」这两件事分开了。
   *   与 `build` 同一个理由：**外部可观测的指纹**优于靠现象反推。
   *
   * 空数组 = 一个都没接上（原因见 {@link HostCapabilities.simNote}）。
   */
  readonly simTools?: readonly string[]
  /** 仿真工具未能注册时的**具体原因**（成功时为 undefined）。 */
  readonly simNote?: string
  /**
   * 面板浮层输入框**可用**（`POST /api/chat` 已注册且能解析到会话）。
   *
   * ★ 必须可观测：拿不到 agents 服务时路由根本不注册，
   *   而界面若照常显示输入框，用户会对着一个**发不出去的框**打字 ——
   *   看起来正常、实际全错。前端据此**隐藏**输入框而不是禁用。
   */
  readonly chat?: boolean
  readonly version: string
}
