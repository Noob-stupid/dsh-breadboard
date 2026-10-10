/**
 * @dsh-breadboard/dsh-hardware-sandbox —— 插件宿主半入口
 *
 * 本文件是**宿主半（Node）**的组装点。它刻意保持单薄：
 * 内核逻辑全部在 src/core/**，且**零依赖 DSH 宿主 API**（§10.3 硬要求），
 * 因此内核可脱离宿主单测（`npm test`，67 项全绿）。
 * 与宿主打交道的一切都收在 src/host/**（薄适配层，§10）。
 *
 * ── 施工进度（顺序见 docs/01-项目定位.md §7） ──
 *   ① 虚拟时钟 + 确定性设备              ✅ T1/T2/T3/T5/T6 全绿
 *   ② BridgeServer(TCP) + bridge_client  ✅ 真 Python 走 shim 跑通（tests/python-shim.test.ts）
 *   ③ BME280 寄存器级行为模型            ✅ 含 BigInt 补偿与二分反解（tests/bme280.test.ts）
 *   ④ test-project 适配                  ⬜ 未开始（见 docs/06 §5：真实项目形态与 I2C 沙盒不同）
 *   ⑤ SimEngine + 工具注册               ✅ 引擎 + 4 个工具已接（本文件「仿真引擎与工具」段）
 *   ⑥ HostAdapter 接真实 DSH             ✅ AssemblyState(SSOT) + 路由 + 工具 + 模型库
 *   ⑦ 前端 Three.js 场景                 🔄 由 session-40f8f716 并行推进
 */
import z from '@deepseek-ai/schemastery'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { VirtualClock } from './core/vclock/virtual-clock.ts'
import { DeterministicTestDevice } from './core/devices/deterministic.ts'
import { AssemblyState } from './core/state/assembly-state.ts'
import { HardwareEventBus } from './core/events.ts'
import { DeviceRegistry } from './core/sim/device-registry.ts'
import { SimEngine } from './core/sim/engine.ts'
import { ModelStore } from './core/models/store.ts'
import { ProjectStore, validateProjectProfile } from './core/projects/store.ts'
import { seedPackagedModels } from './core/models/seed.ts'
import { StepPartsClient } from './core/models/step-parts.ts'
import { createRouteBundle, type HttpRoute, type UpgradeRoute } from './host/routes.ts'
import { createHardwareTools, type ToolRegistryLike } from './host/tools.ts'
import { createNetworkTools } from './host/network-tools.ts'
import { createProjectTools, projectStatuses } from './host/project-tools.ts'
import type { ProjectStatus } from './contracts/projects.ts'
import { createFetchTransport } from './host/fetch-transport.ts'
import { createChatSender, type AgentsLike } from './host/chat.ts'
import { DEFAULT_NETWORK_ADAPTERS, NetworkRegistry } from './core/sim/network-registry.ts'
import {
  createSubprocessSpawner,
  probePythonInterpreter,
  type SubprocessLike,
} from './host/subprocess-spawner.ts'
import { restingY } from './contracts/library.ts'
import { MODEL_MAX_BYTES, type HostCapabilities } from './contracts/protocol.ts'

/**
 * 宿主能力面。
 *
 * ★ 刻意用**结构化类型**而不是 import 宿主类型：
 *   §10.3 要求内核零依赖宿主 API；本文件就是那条边界。
 *   宿主接口若改名或迁移，改动收敛在此处，src/core/** 不受影响。
 */
interface WebServerLike {
  register(route: HttpRoute): () => void
  registerUpgrade(route: UpgradeRoute): () => void
}

interface AppContext {
  readonly webServer?: WebServerLike
  readonly subprocess?: unknown
  /** Cordis 的可选服务访问。**用它而不是硬 inject** —— 见下方搜索能力的降级说明。 */
  get?(name: string): unknown
  logger?: { info?(message: string): void; warn?(message: string): void }
  effect?(callback: () => (() => void) | void, label?: string): () => void
}

/** 结构等价的宿主 `web` 服务（只用到 search）。 */
interface WebSearchLike {
  search?(
    request: { readonly query: string; readonly maxResults?: number },
    signal?: AbortSignal,
  ): Promise<{
    readonly sources: readonly { url: string; title?: string; snippet?: string }[]
    readonly content?: string
  }>
}

export const name = '@dsh-breadboard/dsh-hardware-sandbox'

/**
 * 需要宿主提供的服务。
 *
 * ★ `webServer` / `subprocess` / `tools` 都放在**硬依赖**里，而不是用 `ctx.get()` 探测。
 *   理由是这三者的缺失都属于**静默归零**：
 *   · 没有 `webServer` ⇒ 前端连不上，界面看着"加载了"却永远空白
 *   · 没有 `tools`     ⇒ 工具根本没注册，模型只会说"我没有这个能力"，没人知道为什么
 *   · 没有 `subprocess` ⇒ 仿真永远起不来
 *   硬依赖的语义是"**等到就绪再激活**"，于是这些能力要么可用、要么插件压根不激活，
 *   **不存在"激活了但功能悄悄没了"这一档**。宁可晚激活，不要假激活。
 *
 *   （对照：`web` 搜索服务走 `ctx.get()` 可选获取 —— 它缺失时面板会明确显示
 *     "搜索不可用"，是**可见的**降级，与上面三种静默归零性质不同。）
 */
export const inject = ['webServer', 'subprocess', 'tools']

export interface Config {
  /** 虚拟时钟最小时间片（秒）。默认 1ms。 */
  step: number
  /** 宿主事件循环让出预算（毫秒）。默认 1（实测最优，见 virtual-clock.ts）。 */
  yieldBudgetMs: number
  /** 单次 advance 的虚拟时长上限（秒）。 */
  maxAdvanceSeconds: number
  /** 启动时跑一次内核自检并打印结果。 */
  selfCheck: boolean
  /**
   * 启动时铺一套演示装配（树莓派 + BME280 + I2C 连线）。
   *
   * ⚠️ 这是**联调辅助**：让前端一连上就有内容可渲染，便于端到端验证。
   *    正式形态应由「新建项目」流程驱动，届时置 false。
   */
  seedDemo: boolean
  /** 本机 Python 解释器路径（主线 B 用）。留空表示未探测。 */
  pythonPath: string
  /**
   * 用户导入模型的存储目录。留空则用 `$DSH_HOME/dsh-hardware-sandbox/models`。
   *
   * ★ 落在**用户数据目录**，不是插件包内 —— 插件**不分发**任何第三方模型。
   */
  modelsDir: string
}

export const Config = z.object({
  step: z.number().min(0.000001).default(0.001),
  yieldBudgetMs: z.number().min(0).default(1),
  maxAdvanceSeconds: z.number().min(1).default(3600),
  selfCheck: z.boolean().default(true),
  seedDemo: z.boolean().default(true),
  pythonPath: z.string().default(''),
  modelsDir: z.string().default(''),
})

/**
 * 读取构建标记（由 `scripts/build.sh` 写入 `lib/build-stamp.json`）。
 *
 * ★ 为什么需要它：热重载**可能报成功但模块并未真正换掉**（实测踩过 ——
 *   接口全在、状态却是旧的，只能靠 revision 指纹反推）。有了构建标记，
 *   `GET /api/capabilities` 就能一眼确认**当前活着的到底是哪一次构建**，
 *   把「新代码没生效」和「新代码有 bug」这两件事区分开。
 *
 * 读不到就返回 undefined —— 这条路径**绝不能**让插件加载失败。
 */
function readBuildStamp(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const parsed = JSON.parse(readFileSync(path.join(here, 'build-stamp.json'), 'utf8')) as {
      builtAt?: string
    }
    return parsed.builtAt
  } catch {
    return undefined
  }
}

/**
 * 定位**随包发布**的 shim 目录（`lib/project-shim`）。
 *
 * ★★ 为什么这件事必须由构建脚本 + 这里**成对**保证：
 *   `SimEngine` 把项目进程的 `PYTHONPATH` 指向 shim —— `shim/` 提供 `smbus` 与
 *   `RPi.GPIO`，`project-shim/` 提供 `sitecustomize`。项目代码靠它才连得上虚拟硬件。
 *   而 `package.json` 的 `files` 只有 `["lib"]`，所以 `scripts/build.sh` 会把
 *   `project-shim/` 复制进 `lib/project-shim/`。
 *
 * ★ 为什么开发期发现不了：本地是 junction 直连源码目录，整个仓库都在，
 *   随便写个相对路径都能找到。**只有从 tgz 装出来才暴露** —— 又一例
 *   「看起来正常、实际全错」。
 *
 * ★ 按 `import.meta.url` 解析：junction 安装与 tgz 安装走**同一条**路径规则，
 *   不存在"开发能跑、装出来不能跑"的分叉。
 *
 * ★ 找不到**不抛**，返回 undefined 由调用方降级 —— 装配与 3D 场景不依赖 shim，
 *   不该被它拖垮。（构建脚本里另有一道断言，正常构建产物不会缺。）
 */
function resolveShimRoot(): string | undefined {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    const candidate = path.join(here, 'project-shim')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

/** 铺一套可渲染的演示装配。★ 走正常 API，保证与用户操作同一条路径。 */
function seedDemoAssembly(state: AssemblyState, log: (message: string) => void): void {
  // ══════════════════════════════════════════════════════════════════════════
  // ★★ 演示装配 = **智座（智能选座系统）座位节点的真实接法**
  // ══════════════════════════════════════════════════════════════════════════
  //
  // ★ 依据是那个项目自己的文档 `docs/烧录与PIR接线操作指南.md`，不是编的：
  //
  //   > 需要的东西：1 块 **ESP32 开发板**、**HC-SR501（PIR 人体感应模块）** 推荐 2 个、杜邦线
  //   >
  //   > | HC-SR501 引脚 | 连到 ESP32 | 说明 |
  //   > |---|---|---|
  //   > | `VCC` | **5V** | HC-SR501 工作电压较高，5V 更稳 |
  //   > | `OUT`（第 1 个） | **`GPIO23`**（→ 固件 `ir_front`） | 检测到人体移动时输出 HIGH |
  //   > | `OUT`（第 2 个） | **`GPIO27`**（→ 固件 `ir_back`） | 第二个传感器接这个 |
  //   > | `GND` | **`GND`** | 两个传感器共地 |
  //
  // ★ 为什么演示装配换成这个（而不是树莓派 + BME280）：
  //   用户的原话是「**你弄那个 D:/MAX_xiangmu 里的真实硬件需求做演示不就行了**」——
  //   用一个**真实项目真正在用的**接线，比用一个凑出来的教学例子有价值得多：
  //   它既能验证沙盒，也能被那个项目**端到端地检验**（虚拟设备发 HTTP 到真服务）。
  //
  // ★ 逐针建模在这里**立刻有了用处**：`GPIO23` 与 `GPIO27` 是两个**具体的引脚**，
  //   而不是"某个 GPIO 端口"。接错一根，`unconnected_port` 会指名道姓地说出是哪个脚。
  const board = state.place('esp32-seat-sensor', { x: 0, y: restingY('esp32-seat-sensor'), z: 0 })
  if (!board.ok) {
    log(`演示装配：放置 ESP32 失败（${board.reason}）`)
    return
  }
  const front = state.place('hc-sr501', { x: -0.05, y: restingY('hc-sr501'), z: -0.03 })
  if (!front.ok) {
    log(`演示装配：放置 PIR#1（ir_front）失败（${front.reason}）`)
    return
  }
  const back = state.place('hc-sr501', { x: -0.05, y: restingY('hc-sr501'), z: 0.03 })
  if (!back.ok) {
    log(`演示装配：放置 PIR#2（ir_back）失败（${back.reason}）`)
    return
  }

  // 引脚对照（ESP32 DevKit V1 的 30 针表）：
  //   E29 = 5V   E14 = GND   E4 = GPIO23   E19 = GPIO27
  //
  // ★ 5V 与 GND 标记为 `shared`：**它们在这条装配里是"电源轨"** ——
  //   两个 PIR 共用同一路 5V 与同一个地，真机上就是面包板的两条轨。
  //   （单看一个排针脚确实只插得下一根杜邦线；`shared` 表达的是**轨**，不是**脚**。）
  const wiring: readonly (readonly [string, string, string, string])[] = [
    ['VCC', '5V', 'E29', 'PIR#1 供电'],
    ['GND', 'GND', 'E14', 'PIR#1 共地'],
    ['OUT', 'GPIO23（ir_front）', 'E4', 'PIR#1 信号'],
    ['VCC', '5V', 'E29', 'PIR#2 供电'],
    ['GND', 'GND', 'E14', 'PIR#2 共地'],
    ['OUT', 'GPIO27（ir_back）', 'E19', 'PIR#2 信号'],
  ]
  const targets = [front, front, front, back, back, back]
  for (let i = 0; i < wiring.length; i += 1) {
    const [pirPort, boardName, boardPort, note] = wiring[i] as readonly [string, string, string, string]
    const target = targets[i]
    if (!target?.ok) continue
    const link = state.connect(
      { componentId: target.value.id, portId: pirPort },
      { componentId: board.value.id, portId: boardPort },
    )
    if (!link.ok) {
      log(`演示装配：连线失败（${note}：${pirPort} → ${boardName}，${link.reason}）`)
      return
    }
  }
  log(
    `演示装配就绪：ESP32 DevKit + 2×HC-SR501（智座座位节点真实接法：` +
      `5V/GND 共轨，OUT1→GPIO23=ir_front，OUT2→GPIO27=ir_back；revision=${String(state.revision)}）`,
  )
}

export function apply(ctx: AppContext, config: Config): void {
  const log = (message: string): void => {
    ctx.logger?.info?.(`[dsh-hardware-sandbox] ${message}`)
  }
  const warn = (message: string): void => {
    ctx.logger?.warn?.(`[dsh-hardware-sandbox] ${message}`)
  }

  /**
   * **项目状态的惰性 provider** —— 声明在**函数顶层**，因为它要跨两个块用：
   * 路由块（约 L420）要把它交出去，联网设备块（约 L563）才能把它接上。
   * 声明在那两个块里面任一个，另一边就看不见（**作用域不是缩进，是块**）。
   *
   * ★ 为什么需要"惰性"：`NetworkRegistry` 建得比路由晚。若路由直接引用它，
   *   拿到的是 TDZ 里的 `undefined`，一调用就抛 —— 而**抛在路由里 = 界面永远转圈**。
   */
  let projectStatusProvider: (() => Promise<readonly ProjectStatus[]>) | undefined


  const clock = new VirtualClock({
    step: config.step,
    yieldBudgetMs: config.yieldBudgetMs,
    maxAdvanceSeconds: config.maxAdvanceSeconds,
  })
  const state = new AssemblyState()
  const bus = new HardwareEventBus()

  // ★ 把装配状态与虚拟设备接起来（§6.1「共用一份真相」）。
  //   必须在 seedDemo **之前**建：否则演示装配里的 BME280 不会有对应设备。
  //   建好之后，往后任何放置/移除都会自动同步设备，无需调用方记得手动 sync。
  const registry = new DeviceRegistry({ clock, state })

  // 用户导入模型的存储 —— 落在**用户数据目录**（`DSH_HOME` 优先，与 web 进程 homedir 可能不一致）。
  // ★ 不放插件包内：插件**不分发**任何第三方模型，这是这条路径在许可上干净的根本原因。
  //
  // ⚠️ 用 `?.trim()` 而不是 `!== ''`：宿主正常会经 schemastery 填默认值，但**直接调用方
  //   （测试、异常装配）可能传 undefined** —— 那时 `undefined !== ''` 为真，会把 undefined
  //   传进 path.resolve 直接抛。**不要假设配置总是完整的。**
  const dshHome = process.env.DSH_HOME ?? path.join(homedir(), '.dsh')
  const configuredModelsDir = config.modelsDir?.trim()
  const modelsRoot =
    configuredModelsDir !== undefined && configuredModelsDir !== ''
      ? configuredModelsDir
      : path.join(dshHome, 'dsh-hardware-sandbox', 'models')
  const models = new ModelStore({ root: modelsRoot })

  /**
   * **用户的项目存储** —— 默认是个空目录。
   *
   * ★ 与模型目录**分开**：模型是基础设施（可能几 MB、导入一次基本不动），
   *   项目是小 JSON 且会被 agent 反复改。混在一起时，"清空模型"之类的操作
   *   会**顺手把项目也删了**，而那时没人会想到。
   */
  const projectStore = new ProjectStore({
    root: path.join(dshHome, 'dsh-hardware-sandbox', 'projects'),
  })
  log(`用户模型目录：${modelsRoot}`)

  // ★★ 种子：把**随包发布的模型**补进用户目录
  //
  //   ⚠️⚠️ 补的是一个"开箱即用"的洞，代价很具体：
  //     模型原来只存在于用户目录（`~/.dsh/.../models`），**不在仓库里**
  //     （`.gitignore` 还把 `models/` 排除了）⇒ **别人 clone / 装上这个插件后，
  //     一个模型都没有 ⇒ 场景里全是占位方块**。
  //     用户原话：「**怎么还是这种建模呢……别的 agent 到时候是否也会这样呢**」——
  //     **会，只要模型不随插件走。**
  //
  //   ★ 逻辑全部在 `core/models/seed.ts` —— **抽出去是为了能测**。
  //     上一版这段是内联的，而它带着一个「Promise 永远 !== undefined」的 bug
  //     （见那个文件的注释），**因为没法测所以没抓住**。
  void (async () => {
    const { fileURLToPath } = await import('node:url')
    // lib/index.js → 上一级就是插件根目录
    const packagedDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'models')
    const outcome = await seedPackagedModels({ packagedDir, store: models })
    if (outcome.seeded.length > 0) {
      log(
        `已从插件包补齐 ${String(outcome.seeded.length)} 个预置模型：` +
          `${outcome.seeded.join(', ')}（缺哪个补哪个，未覆盖你导入的）`,
      )
    }
    if (outcome.failure !== undefined) {
      log(`预置模型补齐跳过：${outcome.failure}`)
    }
  })()

  // step.parts 客户端 —— 唯一「公共 API + 免鉴权 + 直接给 GLB」的来源（见 docs/05）。
  // ★ 上限与存储一致：**下载前按元数据判定**，超限的根本不去下。
  const stepParts = new StepPartsClient({ maxBytes: MODEL_MAX_BYTES })

  ctx.effect?.(
    () => () => {
      registry.dispose()
    },
    'dsh-hardware-sandbox: device-registry',
  )

  if (config.seedDemo) seedDemoAssembly(state, log)
  log(`虚拟设备已挂载 ${String(registry.deviceCount)} 台`)

  /* ── 仿真工具注册结果（外部可观测指纹） ──
   *
   * ★ 在路由段**之前**声明：`capabilities()` 在路由段里被闭包捕获，
   *   而工具注册段在路由段之后才跑。声明在前，闭包才能读到后写入的值。
   *   （若声明在工具段，`capabilities` 根本引用不到它。）
   */
  const registeredToolNames: string[] = []
  let simNote: string | undefined

  /* ─────────────────── 前后端路由（§10 薄适配层） ─────────────────── */

  const webServer = ctx.webServer
  if (!webServer) {
    // ★ 这一支**正常情况下永远不会走到** —— `webServer` 在 `inject` 里是硬依赖，
    //   宿主保证它在 apply 之前就绪。留着它纯粹是防御"结构等价类型"被喂进
    //   非 Cordis 的 ctx（测试替身、手工装配）。
    //   ⚠️ 别把它当成"优雅降级"的证据：真正的降级手段是**硬依赖**（见 inject 的注释）。
    warn('宿主未提供 webServer 服务 —— 前后端桥不可用（这不该发生：webServer 是硬依赖）')
  } else {
    // ★ 能力探测在 **apply 时算一次**，不在每次请求时读 ctx。
    //   实测踩过：把 `ctx.subprocess` 留在请求期读取，一旦该 fiber 的 ctx 失效，
    //   handler 就抛异常，而宿主 webserver 会把它吞成一个**空 body 的 400**，
    //   现场完全无法诊断。能力值本来就是静态的，没理由每次请求重算。
    const externalProcess = ctx.subprocess !== undefined
    const buildStamp = readBuildStamp()

    // ★ 搜索能力用 `ctx.get('web')` **可选获取**，不写进 `inject`。
    //   写进 inject 意味着"必须等这个服务就绪才激活" —— 若某套 composition 没有 web，
    //   整个插件就永远不激活（连 3D 场景都用不了）。**宁可降级，不要不激活。**
    const web = ctx.get?.('web') as WebSearchLike | undefined
    const searcher =
      typeof web?.search === 'function'
        ? async (query: string) => {
            const result = await web.search!({ query, maxResults: 20 })
            return {
              query,
              sources: result.sources.map((source) => ({
                url: source.url,
                ...(source.title !== undefined ? { title: source.title } : {}),
                ...(source.snippet !== undefined ? { snippet: source.snippet } : {}),
              })),
              ...(result.content !== undefined ? { content: result.content } : {}),
            }
          }
        : undefined

    if (searcher === undefined) {
      warn('宿主未提供 web 搜索服务 —— 面板内的模型搜索将不可用（仍可手动下载后导入）')
    }

    // ★ 聊天投递口：`agents` 走 `ctx.get` 可选获取（与 `web` 同理 ——
    //   拿不到就**不注册路由**，并由 capabilities.chat 告诉前端**隐藏输入框**，
    //   而不是给用户一个发不出去的框）。
    //
    // ⚠️ 必须先判服务再建 sender：`createChatSender` **总是返回一个函数**
    //   （拿不到 agents 时它返回的是"永远拒绝"的那个）。若直接判 `chatSender !== undefined`，
    //   条件**恒为真** ⇒ 路由照注册、`capabilities.chat` 报 true，
    //   而实际每次都失败 —— 前端于是显示一个**永远发不出去的输入框**。
    //   这正是"看起来正常、实际全错"。（本项目的 entry-smoke 测试当场抓到了它。）
    const agentsService = ctx.get?.('agents') as AgentsLike | undefined
    const chatSender = agentsService === undefined ? undefined : createChatSender(agentsService)
    if (agentsService === undefined) {
      warn('宿主未提供 agents 服务 —— 面板浮层输入框不可用（capabilities.chat 会缺省）')
    }

    const capabilities = (): HostCapabilities => ({
      scene: true,
      externalProcess,
      renderCapture: false, // 视觉仲裁本期后置
      vision: false,
      // ★ 报告**实际会用**的解释器：config 为空时引擎用的是裸名 `python`
      //   （由宿主在自己的执行世界里解析）。报告空字符串会让外部观测
      //   与真实行为不一致 —— 那正是"看起来正常、实际全错"的入口。
      pythonPath: config.pythonPath?.trim() || 'python',
      version: '0.0.1',
      ...(buildStamp ? { build: buildStamp } : {}),
      simTools: [...registeredToolNames],
      ...(simNote !== undefined ? { simNote } : {}),
      ...(chatSender !== undefined ? { chat: true } : {}),
    })

    const bundle = createRouteBundle({
      state,
      bus,
      capabilities,
      models,
      stepParts,
      ...(searcher !== undefined ? { search: searcher } : {}),
      ...(chatSender !== undefined ? { chat: chatSender } : {}),
      // ★ 项目状态给界面用（"智座连通了没有"）。与 hw_list_projects **同一个函数**。
      //
      // ⚠️ 用**惰性 provider**：`NetworkRegistry` 在下面才建（约 L557），
      //   而路由在这里就要交出去。直接写变量名会拿到 TDZ 里的 `undefined` ——
      //   那时 `projectStatuses` 一调用就抛，而**抛在路由里 = 界面永远转圈**。
      //   ⇒ 这里只交一个"等会儿再算"的闭包；真算的时候注册表一定已经在了。
      projects: {
        list: () => projectStatusProvider?.() ?? Promise.resolve([]),
        // ★ 只有**用户显式点导入**时才把样例落盘 —— 启动时不写。
        //   启动就写等于又变成"内置项目"，而用户要的是"**别人是空的**"。
        importSample: async (projectId: string) =>
          (await projectStore.importSample(projectId)) !== undefined,
        // ★ 用户从文件选的图纸**不受我们控制** ⇒ 入口就校验，并说清是哪一种坏。
        //   少了这一步，坏数据会走到 importProject，表现是
        //   「导入成功但场景里什么都没有」，而调用方只看到 ok:true。
        save: async (profile: unknown) => {
          const checked = validateProjectProfile(profile)
          if (!checked.ok) return checked.reason
          try {
            await projectStore.save(checked.profile)
            return undefined
          } catch (error) {
            return String(error)
          }
        },
        remove: (projectId: string) => projectStore.remove(projectId),
      },
      onError: (error) => {
        warn(`路由 handler 抛错：${String(error)}`)
      },
    })

    // ★★ 必须**接住** register / registerUpgrade 返回的注销函数。
    //   实测踩过一个大坑：丢弃它们 ⇒ 每次卸载/重载旧路由都留在 webserver 路由表里；
    //   新代码注册时撞重复路径抛错，被 catch 吞成一条看不见的 warning；
    //   于是插件**一直由旧代码在服务**，表现是一个**空 body 的 400**，
    //   现场完全没有线索。这类「静默服务旧代码」比崩溃难查得多。
    const disposers: Array<() => void> = []
    try {
      for (const route of bundle.http) disposers.push(webServer.register(route))
      for (const route of bundle.upgrade) disposers.push(webServer.registerUpgrade(route))
      log(
        `已注册 ${String(bundle.http.length)} 条 HTTP 路由与 ${String(bundle.upgrade.length)} 条 WS 路由`,
      )
    } catch (error) {
      // 注册失败必须**显式可见**：先把自己已注册的收回去，再把原因喊出来
      warn(`路由注册失败（已回滚本次注册）：${String(error)}`)
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch {
          // 回滚失败也要继续回滚其余条目
        }
      }
    }

    // 卸载时：注销路由 + 退订事件 + 关闭 WebSocket。
    // 三者缺一都会让热重载残留 —— 路由残留的后果见上面那段注释。
    ctx.effect?.(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            // 单条注销失败不应阻断其余清理
          }
        }
        bundle.dispose()
      },
      'dsh-hardware-sandbox: routes',
    )
  }

  /* ─────────────────── 仿真引擎与工具（§5.4 / §10 薄适配层） ─────────────────── */

  // ★ pythonPath 为空时用**裸名** `python`，交给宿主的 `resolveExecutable` 在
  //   **它自己的执行世界**里解析（宿主契约明确要求如此）。自己拼 PATH 在远程/容器
  //   执行世界里必然错 —— 而症状只是"进程起不来"，极难归因。
  const pythonPath = config.pythonPath?.trim() || 'python'
  const shimRoot = resolveShimRoot()

  if (shimRoot === undefined) {
    // ★ 这是**构建错误**，不是运行期状况：build.sh 应当已把 project-shim/ 复制进 lib/。
    //   明确喊出来，而不是让仿真在 PYTHONPATH 指向空目录时神秘失败。
    simNote = '未找到 lib/project-shim（构建脚本应把 project-shim/ 复制进 lib/）'
    warn(`未找到 lib/project-shim —— 仿真工具不会注册（${simNote}）`)
  } else {
    const engine = new SimEngine({
      clock,
      state,
      bus,
      spawn: createSubprocessSpawner(ctx.subprocess as SubprocessLike),
      pythonPath,
      shimRoot,
    })

    // ★ `tools` 是硬依赖（见 inject），这里正常情况下一定有值。
    const toolRegistry = ctx.get?.('tools') as ToolRegistryLike | undefined
    if (toolRegistry === undefined) {
      simNote = '宿主 ctx 上取不到 tools 服务'
      warn(`宿主未提供 tools 服务 —— 硬件工具不会注册（${simNote}）`)
    } else {
      const toolDisposers: Array<() => void> = []
      try {
        for (const definition of createHardwareTools({ engine, state, pythonPath })) {
          toolDisposers.push(toolRegistry.register(definition))
          registeredToolNames.push(definition.name)
        }
        log(`已注册 ${String(toolDisposers.length)} 个硬件工具：${registeredToolNames.join(', ')}`)
      } catch (error) {
        // 与路由注册同样的教训：**必须接住并回滚**，否则半注册状态既难查又难清
        simNote = `工具注册失败：${String(error)}`
        warn(`工具注册失败（已回滚本次注册）：${String(error)}`)
        registeredToolNames.length = 0
        for (const dispose of toolDisposers.reverse()) {
          try {
            dispose()
          } catch {
            // 单条注销失败不应阻断其余清理
          }
        }
      }
      ctx.effect?.(
        () => () => {
          for (const dispose of toolDisposers) {
            try {
              dispose()
            } catch {
              // 同上
            }
          }
        },
        'dsh-hardware-sandbox: tools',
      )
    }

    // ★ 必须回收：引擎持有**正在监听的项目桥 TCP 端口**与**子进程**。
    //   不回收 ⇒ 每次热重载泄漏一个监听端口 + 一个孤儿进程（路由残留同族的坑）。
    ctx.effect?.(
      () => () => {
        void engine.dispose()
      },
      'dsh-hardware-sandbox: sim-engine',
    )
  }

  /* ─────────────────── 联网设备（第二类虚拟硬件） ───────────────────
   *
   * ★★ **刻意放在 `shimRoot` 判断之外**：联网设备**完全不需要 Python**
   *   —— 它出网走 HTTP，不经过 shim / IPC / 虚拟时钟。
   *   放进那个分支就等于把"shim 没打包好"和"联网设备用不了"绑死，
   *   而这两件事毫无关系。
   */
  {
    // ★ 注册表就位 ⇒ 现在可以真算了
    projectStatusProvider = async () => {
      const { projects: profiles } = await projectStore.list()
      return projectStatuses(state, networkRegistry, profiles)
    }

    const networkRegistry = new NetworkRegistry({
      state,
      transport: createFetchTransport({ timeoutMs: 10_000 }),
    })

    const toolRegistry = ctx.get?.('tools') as ToolRegistryLike | undefined
    if (toolRegistry === undefined) {
      warn('宿主未提供 tools 服务 —— 联网设备工具不会注册')
    } else {
      const networkDisposers: Array<() => void> = []
      try {
        const protocols: Record<string, string> = {}
        for (const [id, adapter] of Object.entries(DEFAULT_NETWORK_ADAPTERS)) {
          protocols[id] = adapter.description
        }
        for (const definition of createNetworkTools({ registry: networkRegistry, state, protocols })) {
          networkDisposers.push(toolRegistry.register(definition))
          registeredToolNames.push(definition.name)
        }
        log(`已注册 ${String(networkDisposers.length)} 个联网设备工具`)

        // ★★ 项目工具：一次导入一个**真实软硬件系统**
        //   （器件 + 接线 + 联网绑定 + **连通判据**）
        //   ★ 放在同一个 try 里：它与联网工具共用 `networkRegistry`，
        //     注册失败要一起回滚，不能留下"一半装了"的状态。
        for (const definition of createProjectTools({ registry: networkRegistry, state, projects: projectStore })) {
          networkDisposers.push(toolRegistry.register(definition))
          registeredToolNames.push(definition.name)
        }
        log('已注册项目导入工具（hw_list_projects / hw_import_project）')
      } catch (error) {
        warn(`联网设备工具注册失败（已回滚）：${String(error)}`)
        registeredToolNames.length = 0
        for (const dispose of networkDisposers.reverse()) {
          try {
            dispose()
          } catch {
            // 单条注销失败不应阻断其余清理
          }
        }
      }
      ctx.effect?.(
        () => () => {
          for (const dispose of networkDisposers) {
            try {
              dispose()
            } catch {
              // 同上
            }
          }
        },
        'dsh-hardware-sandbox: network-tools',
      )
    }

    // ★ 必须回收：注册表持有**正在周期发 HTTP 的设备**。
    //   不回收 ⇒ 热重载后旧设备继续往外部系统发包（而且是看不见的）。
    ctx.effect?.(
      () => () => {
        networkRegistry.dispose()
      },
      'dsh-hardware-sandbox: network-registry',
    )
  }

  /* ── Python 解释器探测：**只为诊断**，不阻断启动 ──
   *
   * ★ 必须**真跑一次 `--version`**，不能只看"解析得到"：
   *   Windows 上 `python3` 常解析到应用商店占位存根，解析成功但一跑就失败。
   *   实测本机 `python` 是真的（3.14.2）、`python3` 是存根。
   *   详见 `subprocess-spawner.ts` 的 `probePythonInterpreter`。
   */
  void (async () => {
    const subprocess = ctx.subprocess as SubprocessLike | undefined
    if (subprocess === undefined) return
    const preferred = config.pythonPath?.trim()
    try {
      const found = await probePythonInterpreter(subprocess, {
        ...(preferred !== undefined && preferred !== '' ? { preferred } : {}),
      })
      if (found === undefined) {
        warn(
          `未探测到可用的 Python 解释器（试过：${preferred !== undefined && preferred !== '' ? preferred : 'python, python3'}）` +
            ' —— 仿真工具会失败；请在插件配置里设置 pythonPath',
        )
      } else {
        log(`Python 解释器：${found.path}（${found.version}）`)
      }
    } catch (error) {
      warn(`Python 探测异常：${String(error)}`)
    }
  })()

  /* ─────────────────── 内核自检 ─────────────────── */

  log(
    `虚拟时钟内核就绪（step=${String(config.step)}s, yieldBudgetMs=${String(config.yieldBudgetMs)}ms）`,
  )

  if (!config.selfCheck) return

  void (async () => {
    try {
      // ★ 自检用**自己的时钟**，不碰仿真的那一台。
      //   否则自检设备会混进 `snapshot().virtualDevices`，在 3D 场景里冒出一台
      //   莫名其妙的「确定性设备」，还会污染设备注册表对装配的投影。
      const selfCheckClock = new VirtualClock({ step: 0.001, yieldBudgetMs: 0 })
      const device = new DeterministicTestDevice({ id: 'self-check', period: 1 })
      const dispose = selfCheckClock.register(device)

      const readings: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const bytes = device.onI2CRead({ address: device.address, register: 0x00, length: 2 })
        readings.push(bytes ? (bytes[0] ?? 0) * 256 + (bytes[1] ?? 0) : -1)
        await selfCheckClock.advance(1)
      }
      dispose()

      const ok = readings.join(',') === '1,2,3,4,5'
      log(
        ok
          ? `内核自检通过：readings=[${readings.join(',')}] tickCount=${String(device.tickCount)}`
          : `内核自检失败：readings=[${readings.join(',')}]（期望 1,2,3,4,5）`,
      )
    } catch (error) {
      log(`内核自检异常：${String(error)}`)
    }
  })()
}
