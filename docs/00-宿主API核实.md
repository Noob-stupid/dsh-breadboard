# 第 0 周交付物 · DSH 宿主 API 核实

> 对应设计文档 §0.2「DSH 宿主 API 核实（硬前提，1 天）」与 §0.3「.dsh-plugin 接口被删除的先例」。
>
> **核实方式**：① 实时 `cordis_inspect`（host `Service` / client `Builtins`、`Slots`）——读的是**当下活着的运行时**，不是文档；② 源码核对 `D:\dsh\deepseek-harness`（DSH 完整 checkout）。
>
> **核实时间**：2026-10-07 ┃ **宿主版本**：DSH desktop, profile `desktop`

---

## 1. 结论：全部硬前提成立

| # | 文档依赖的能力 | 对应章节 | 结论 | 证据 |
|---|---|---|---|---|
| 1 | 注册工具给 DS | §5.4 | ✅ | 服务 `tools.register(definition: ToolDefinition): () => void` |
| 2 | **外部进程**（主线 B 硬前提） | §10.1 `externalProcess` | ✅ | 服务 `subprocess.spawn(spec): SubprocessHandle` |
| 3 | 宿主 HTTP 路由 | §5.4 工具接口 | ✅ | 服务 `webServer.register(route)` / `registerUpgrade` / `registerFallback` |
| 4 | 3D 全屏面板挂载点 | §4.2 | ✅ | client slot `main`（keyed，域开放，仅 `conversation` 被占）+ `sidebar.panellist`（list） |
| 5 | 前端打包含 three.js | §4.2.1 | ✅ | tsdown `alwaysBundle: id => !CLIENT_EXTERNALS.includes(id)` → 非外部依赖一律内联 |
| 6 | 前端插入样式 | §4.2.3 | ✅ | client builtin `styles.insert(css): () => void` |
| 7 | 前端持有 React | §4.2 | ✅ | client builtin `React`（无 JSX 变换，`React.createElement`） |
| 8 | 定时/节流原语 | §7.3 | ✅ | 服务 `timer`：`timeout` / `interval` / `throttle` / `debounce` |
| 9 | 读写项目文件 | §6.5 | ✅ | 服务 `fs`：`readText` / `writeText` / `listDir` / `watch` … |
| 10 | 注入系统提示词 | §8 流程 B | ✅ | 服务 `systemPrompt.section` / `context` / `tools` / `variable` |
| 11 | 持久化 | §6.1 | ✅ | 服务 `storage` + `storageDomain` |

> **重要**：§0.3 担心的 `.dsh-plugin` 接口**在本版运行时中并不存在**——现行 API 是 **Cordis 服务化**的（`ctx.tools` / `ctx.subprocess` / `ctx.webServer` / `ctx.slots`），且**可运行时自省**（本文件即由自省产出）。所以「接口被直接删除」这一具体风险形态已经改变；**适配层仍然要做，但理由换成 §10.2 的另外两条**（可脱离宿主单测、能力探测降级）。

---

## 2. 关键契约（实现直接照此写）

### 2.1 宿主半（Node）——Cordis bundle 插件

```ts
export const name = "@dsh-breadboard/dsh-hardware-sandbox"
export const inject = ['tools', 'subprocess', 'webServer', 'timer', 'fs']
export const Config = z.object({ /* schemastery */ })
export function apply(ctx: AppContext, config: Config): void { /* ... */ }
```

工具定义：`ToolDefinition extends ToolSchema`，字段含 `name` / `description` / `parameters` / `execute(args, exec)`。

### 2.2 进程（§1.0 的 IPC 承载）——`subprocess.spawn` 无默认值

```ts
subprocess.spawn({
  argv: readonly string[],          // argv[0] = 程序，不经 shell
  cwd: string,
  stdio: { stdin, stdout, stderr }, // 三个显式；'pipe' | 'inherit' | { maxBytes, spill? }
  graceMs: number,                  // SIGTERM → graceMs → SIGKILL
  signal?: AbortSignal,
  env?: NodeJS.ProcessEnv,          // 合并到已擦洗的父环境上（undefined = 墓碑，删除该键）
}): SubprocessHandle
```

`SubprocessHandle`：`pid` / `stdin` / `stdout` / `stderr` / `collected`（关流后仍可读，按字节偏移取增量）/ `done` / `terminate()` / `waitForExit(signal?)`。

> **★ 终止是进程树级别的**：Windows 走 `taskkill /T`，POSIX 打 detached 进程组。这正是 §9.3「进程隔离」要的能力，白拿。

### 2.3 前端半（浏览器）——client bundle 插件

```ts
export const inject = ['slots']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: 'hardware-sandbox', label: () => '硬件沙盒', component: () => (...)
  })), 'label')
}
```

- `package.json` 需 `"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-slots"], "platform": "web" } }`
- 产物格式：tsdown → CJS，外层包 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })`
- 外部化白名单（**不打包**）：`react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-runtime/client`
- 其余（**含 `three`**）一律内联进 `lib/client.js`

### 2.4 两套 RPC，别用错（已踩实）

| | 适用形态 | 宿主半 | 前端半 | 载荷 |
|---|---|---|---|---|
| **A. 动态 Cordis 插件**（`cordis_run` / `tool.view.cordis`） | 沙箱内联插件 | `harness.handle(method, fn)` | `host.call(method, args)` | **仅 JSON**；省略入参过线为 `null` |
| **B. bundle 插件**（本项目采用） | 真实 npm 包 | `ctx.webServer.register(route)` | `fetch(...)` | HTTP/WS |

> **本项目走 B**。理由：需要 Three.js、需要长驻虚拟时钟、需要独立于会话存活——这些都不适合沙箱内联插件。
> 已核对：`host.call` **只**出现在动态 runner 路径（`cordis-client-runner`），bundle 前端包中**不存在**该符号。

### 2.5 前端座位拓扑（§4.2 的落点）

```text
root
├── main                    [keyed]  中央面板，按 sidebar 条目 id 派发  ★ 3D 场景主座位
│                                    域开放；实测已占 5 个：conversation / plugins /
│                                    schedules / connection-panel / task-board
├── shell.overlay           [list]   全框浮动层（HUD / 故障告警）
├── sidebar
│   ├── sidebar.panellist   [list]   全局面板图标  ★ 入口按钮
│   │                                ★ catalog 原文：「Each list id addresses the matching
│   │                                  main panel」—— 其 id 必须**字面等于** main 的 key，
│   │                                  否则点了图标中央面板不派发
│   │                                ownerProps = { size: number; active: boolean }
│   ├── sidebar.settings → settings.section [list]   ★ 配置页
│   └── ...
└── sidebar.right
    ├── sidebar.right.pane.tab        [keyed]  ★ 仿真控制台／日志面板
    └── ...
```

---

## 3. 待核实项

> 第二轮已全部结清。

| # | 项 | 结论 |
|---|---|---|
| 1 | `ToolDefinition.parameters` 的 schema 方言 | ✅ **JSON Schema**，非 schemastery。`packages/llm/llm/src/types.ts:312-316`：`interface ToolSchema { … /** JSON Schema object for the arguments. */ parameters: Record<string, unknown> }`；注册时经 `assertSupportedJsonSchema` 校验，**只接受 DSH 支持的子集**。schemastery 只用于插件 `Config`，与工具参数无关 |
| 2 | bundle 前端半能否用 Typert `ctx.remote.*` | ⬜ 未验证，**已不需要**：§2.4-B（`webServer.register` + fetch）已足够，前端已按此实现 |
| 3 | `three` 打包体积 / 类型 | ✅ 已装 `three@0.180.0` + `@types/three@0.180.0`（**版本必须对齐** —— three 官方**不发**类型，靠 DefinitelyTyped，故 `@types/three` 是必需项，缺了会 TS7016/TS2307）。`three/examples/jsm/*` 有 exports map，可直接解析。打包体积待 `build:client` 后补 |
| 4 | 本机 Python 可用性 | ✅ `python` = `E:\python314\python.exe`（3.14.2）、`py` = 3.14.2；`python3` 是 WindowsApps 存根（**不可用**）。⇒ shim 注入按 `PYTHONPATH` + `sitecustomize` 走 |
| 5 | 加速模式下 `advance()` 让出事件循环的收益量化 | ✅ 已量化并入判据 **T6**，见 `02-步骤①-虚拟时钟内核.md` §2。结论：让出预算默认 **1ms**；判据须盯 **分位数**而非 max |

---

## 4. 第二轮复核的三项补充

### 4.1 脚手架生成物有两处模板 bug（建议回修 `dev_scaffold_plugin`）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `src/client/index.ts` | `component: () => ({ render(){} })` **形状错误**。真实契约是 `SlotComponent<P> = (props: P) => ReactNode`（`packages/client/ui-slots/src/index.ts:370`），即 React 函数组件 |
| 2 | `src/index.ts` | 模板残留的**守护 agent 循环**（每 60s 唤醒 LLM），与本插件无关；注入后会空跑 LLM 调用 |

### 4.2 ★ 运行时依赖链接：`vendor/*` 是源码态

checkout 的 `vendor/schemastery`、`vendor/cordis` **只有 `lib/types/`，没有 JS 产物**。

- `cordis` / `dsh-tools` / `dsh-llm` / `dsh-system-prompt` 在本项目里**全是 `import type`**，编译期擦除 ⇒ 链 checkout 源码没问题。
- **`schemastery` 是值导入**（`import z from …` 用于 `Config`），必须有 JS ⇒ 链 checkout 会让插件加载时报 `ERR_MODULE_NOT_FOUND: .../schemastery/lib/index.mjs`。
- 且 checkout 版是 **3.18.1**，连声明的 peer 范围 `^3.18.2` 都不满足。

**修正**：`build.sh` 优先链 **profile 里宿主实际加载的已构建副本**（`$DSH_PROFILE_DIR/node_modules/…`，实测 3.18.4），找不到才回退 checkout 并告警。

### 4.3 构建环境备忘

- `DSH_CHECKOUT=D:\dsh\deepseek-harness`
- bash 在 `E:\Git\bin\bash.exe`（**不在 PATH**，但存在）
- **测试不需要 bash、不需要编译**：`npm test` 走 Node 24 原生类型擦除，直跑 `.ts`

### 4.4 ★ 热重载与路由注册：一个「静默服务旧代码」的陷阱

**`webServer.register(route)` / `registerUpgrade(route)` 返回注销函数，必须接住并在卸载时调用。**

丢弃它的后果**不是报错**，而是一条极难诊断的链路：

```text
丢弃 disposer
  → 每次热重载，旧路由仍留在 webserver 路由表
  → 新代码注册时撞重复路径抛错
  → 被 try/catch 吞成一条看不见的 warning
  → 插件**一直由旧代码在服务**
  → 表现：某个 handler 返回**空 body 的 400**，现场毫无线索
```

**实测经过**：`/api/assembly` 与 `/api/action` 正常，唯独 `/api/capabilities` 返回空 400。
排除了三种猜测（命名空间冲突 / handler 抛异常 / 重复实例注册）后，
用注入器的 `dev_clear_routes` 删掉该前缀下的全部条目 → 重载 → 立刻恢复。
**根因是注册返回值被丢弃**，不是任何外部因素。

**正确写法**：

```ts
const disposers: Array<() => void> = []
try {
  for (const route of routes) disposers.push(webServer.register(route))
} catch (error) {
  warn(`路由注册失败：${String(error)}`)          // ← 必须显式可见，不能只 log
  for (const dispose of disposers.reverse()) dispose()  // ← 失败要回滚本次注册
}
ctx.effect(() => () => { for (const d of disposers) d(); /* 其它清理 */ }, 'label')
```

**修复后验证**：连续两次热重载，**不需要** `dev_clear_routes`，路由全部正常。

**附带教训**：路由 handler 应当包一层护栏，把异常回成 JSON（`500 {error, message}`）。
宿主 webserver 会吞掉 handler 异常并回**空 body 的 400** —— 那是最没有信息量的失败形态。
宁可把内部错误回给同机同源的前端，也不要留一个无法诊断的 400。

**排查这类问题的工具**：`dev_clear_routes {prefix}` —— 专为「插件热重载残留路由」设计的自愈工具，无需重启。
