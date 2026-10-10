/**
 * 宿主半路由 —— 前端 ↔ 宿主 的桥（设计文档 §10 的「薄适配层」）
 * @module dsh-hardware-sandbox/host/routes
 *
 * ★ 为什么是 HTTP/WS 而不是 `host.call`：
 *   `host.call` 只存在于「动态 Cordis 插件」的 runner 路径（cordis-client-runner），
 *   **bundle 插件的前端半没有这个符号**（已对整个 checkout 核对过）。
 *   本插件是 bundle 插件，所以一律走 `ctx.webServer.register` + 前端 fetch。
 *
 * ★ 为什么这里自定义 `HttpRoute` / `UpgradeRoute` 结构而不 import 宿主类型：
 *   §10.3 要求「内核零依赖宿主 API，一律走 hostAdapter.*」。本文件就是那一层。
 *   结构上与宿主 `WebRoute` / `WebUpgradeRoute` 等价（`kind`/`path`/`handler`），
 *   但宿主接口改名或迁移时，改动**收敛在本文件**，内核不受影响。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'

import type { ProjectStatus } from '../contracts/projects.ts'
import type { AssemblyState } from '../core/state/assembly-state.ts'
import type { HardwareEventBus } from '../core/events.ts'
import type { ModelStore } from '../core/models/store.ts'
import { ModelStoreError } from '../core/models/store.ts'
import type { StepPartsClient } from '../core/models/step-parts.ts'
import { StepPartsError } from '../core/models/step-parts.ts'
import type { HardwareEvent } from '../contracts/assembly.ts'
import type { ChatSendRequest, ChatSendResult, ClientAction, ClientToHostMessage, HostCapabilities, HostToClientMessage, ModelSearchResult, ModelSearchSource } from '../contracts/protocol.ts'
import { CHAT_ROUTE, HTTP_ROUTES, MODEL_MAX_BYTES, MODEL_ROUTES, WS_ROUTE } from '../contracts/protocol.ts'

/** 结构等价于宿主 `WebRoute`。 */
export interface HttpRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 结构等价于宿主 `WebUpgradeRoute`。 */
export interface UpgradeRoute {
  readonly path: string
  readonly handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
}

/**
 * 搜索能力注入点。宿主半用 `ctx.web.search` 实现它。
 *
 * ★ 为什么是注入而不是直接调宿主服务：§10.3「内核零依赖宿主 API」。
 *   宿主搜索接口若改名，改动收敛在 `index.ts` 一处。
 *
 * ★ 它只负责**通用搜索那一半**（外链）；结构化候选由 {@link StepPartsClient} 提供。
 *   两半在搜索路由里合成完整的 `ModelSearchResult`。
 */
export type ModelSearcher = (query: string) => Promise<{
  readonly sources: readonly ModelSearchSource[]
  readonly content?: string
  readonly unavailable?: string
}>

/** 安全地把未知值当对象用（模型/请求体可能传 null 或非对象）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 搜索结果的可变构造形态（对外仍是只读的 `ModelSearchResult`）。 */
interface MutableSearchResult {
  query: string
  candidates: ModelSearchResult['candidates']
  sources: ModelSearchResult['sources']
  content?: string
  unavailable?: string
}

export interface RouteDeps {
  readonly state: AssemblyState
  readonly bus: HardwareEventBus
  /** 能力探测结果（§10.1）。用函数以便随环境变化。 */
  readonly capabilities: () => HostCapabilities
  /** 用户导入模型的存储。省略则模型路由不注册。 */
  readonly models?: ModelStore
  /** 搜索能力。省略则搜索路由不注册（界面应降级为"只给外链"）。 */
  readonly search?: ModelSearcher
  /**
   * step.parts 客户端 —— **结构化候选 + 一键导入**。
   * 省略则搜索只返回外链（用户自己下载后手动导入）。
   */
  readonly stepParts?: StepPartsClient
  /**
   * 面板浮层输入框的投递口（见 `host/chat.ts`）。
   * 省略则聊天路由不注册（界面应隐藏输入框，而不是给一个发不出去的框）。
   */
  readonly chat?: (request: ChatSendRequest) => ChatSendResult
  /** handler 抛错时的上报口（默认静默）。 */
  readonly onError?: (error: unknown) => void
  /**
   * **项目**：状态查询 + 导入样例 + 删除（省略则项目路由不注册）。
   *
   * ★ 传**一组函数**而不是注册表本身（与 `capabilities` 同一手法）：
   *   路由层不必知道 `ProjectStore` 的存在，也不必知道"连通"怎么算 ——
   *   它只负责把数据发给前端、把用户的操作转下去。判据一变，这里一行都不用改。
   *
   * ★ 为什么"导入样例"和"删除"走 HTTP 而**不是** ClientAction：
   *   action 那条路的语义是"**改装配**"（放器件、连线、钉住），进的是 SSOT；
   *   而项目的增删是"**改用户目录里的文件**"，与装配状态无关。
   *   塞进 action 会让 `AssemblyState` 平白多出一个它管不着的东西。
   */
  readonly projects?: {
    readonly list: () => Promise<readonly ProjectStatus[]>
    /** 把随包样例装进用户目录。**只有用户显式导入时才调**（默认列表是空的）。 */
    readonly importSample: (projectId: string) => Promise<boolean>
    readonly remove: (projectId: string) => Promise<boolean>
  }
}

/** POST body 上限，防止超大请求打爆内存。 */
const MAX_BODY_BYTES = 256 * 1024

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    // 快照必须实时，禁止任何中间层缓存
    'cache-control': 'no-store',
  })
  res.end(body)
}

/**
 * 把 handler 包成「异常也能读出原因」的形态。
 *
 * ★ 为什么必须包：路由 handler 里抛出的异常会被宿主 webserver 吞掉，客户端只看到
 *   一个**空 body 的 400**。实测踩过：`/api/capabilities` 返回 400 空 body，
 *   没有任何线索指向「handler 里访问了已失效的 ctx」。
 *   宁可把内部错误回给本地前端（同机同源、非敏感），也不要留一个无法诊断的 400。
 */
function guarded(route: HttpRoute, onError: (error: unknown) => void): HttpRoute {
  return {
    ...route,
    handler: (req, res) => {
      const fail = (error: unknown): void => {
        onError(error)
        if (!res.headersSent) sendJson(res, 500, { error: 'handler_failed', message: String(error) })
      }
      try {
        const result = route.handler(req, res)
        if (result instanceof Promise) result.catch(fail)
      } catch (error) {
        fail(error)
      }
    },
  }
}

/** 读取并解析 JSON body（带上限）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(buffer)
  }
  if (total === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/**
 * 读取**二进制** body（模型上传用，带上限）。
 *
 * ★ 上限在**读取过程中**就生效，不是读完再判 —— 否则一个超大请求会先把内存吃掉。
 */
async function readBinaryBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    total += buffer.length
    if (total > maxBytes) {
      throw new ModelStoreError('too_large', `上传超过上限 ${String(maxBytes)} 字节`)
    }
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/**
 * 把一次动作翻译成对应的事件（§6.2 事件表）。
 *
 * ★ 写入顺序铁律是「状态 → 场景 → 事件」：
 *   状态在本函数调用前已改完；场景是前端的事（它收到事件后自行同步）；
 *   事件在这里发。**绝不先改场景再补状态**。
 */
function eventsForAction(action: ClientAction, state: AssemblyState, at: number): HardwareEvent[] {
  const snapshot = state.snapshot()
  const base = { source: 'user' as const, at }

  switch (action.kind) {
    case 'place_component': {
      const placed = snapshot.components.findLast((component) => component.hardwareModel === action.hardwareModel)
      return placed ? [{ ...base, type: 'hardware/component_placed', component: placed }] : []
    }
    case 'remove_component':
      return [{ ...base, type: 'hardware/component_removed', componentId: action.componentId }]
    case 'move_component':
      return [{ ...base, type: 'hardware/state_changed', revision: snapshot.revision }]
    case 'set_pinned':
      // 钉住/解开不改变拓扑，只是组件的一个属性 → 用通用状态变更事件让场景重调和。
      return [{ ...base, type: 'hardware/state_changed', revision: snapshot.revision }]
    case 'set_rotation':
      // 旋转同理：不改变拓扑，只是组件的一个属性。
      return [{ ...base, type: 'hardware/state_changed', revision: snapshot.revision }]
    case 'import_project':
      // 切换项目是**大改**（清场 + 重建 + 重新绑定）⇒ 让场景**整份重来**。
      // 走 diff 的话旧器件会被逐条删除、新器件逐条新增，中间态里线和端口对不上，
      // 看起来像闪烁 —— 而"闪一下"和"真的错了"在界面上分不出来。
      return [{ ...base, type: 'hardware/state_changed', revision: snapshot.revision }]
    case 'connect': {
      const made = snapshot.connections.findLast(
        (connection) =>
          connection.from.componentId === action.from.componentId &&
          connection.to.componentId === action.to.componentId,
      )
      return made ? [{ ...base, type: 'hardware/connection_made', connection: made, compatible: true }] : []
    }
    case 'disconnect':
      return [{ ...base, type: 'hardware/connection_removed', cableId: action.cableId }]
    default: {
      const exhaustive: never = action
      throw new Error(`未知动作：${JSON.stringify(exhaustive)}`)
    }
  }
}

export function createHttpRoutes(deps: RouteDeps): HttpRoute[] {
  const { state, bus } = deps
  const onError = deps.onError ?? ((): void => undefined)

  // ★ 必须显式标注数组类型：直接 `return [...].map(...)` 会丢掉上下文类型，
  //   `kind: 'exact'` 会放宽成 string，handler 参数也会退化成 any。
  const routes: HttpRoute[] = [
    {
      kind: 'exact',
      path: HTTP_ROUTES.capabilities,
      handler: (_req, res) => {
        sendJson(res, 200, deps.capabilities())
      },
    },
    {
      kind: 'exact',
      path: HTTP_ROUTES.assembly,
      handler: (_req, res) => {
        // 前端首帧与轮询兜底。按 revision 做客户端 diff，未变时前端自行短路。
        sendJson(res, 200, state.snapshot())
      },
    },
    // ★ 项目：GET 列表 / POST 导入样例或删除
    //   （省略 deps.projects 时不注册 —— 前端据此隐藏项目面板，
    //    而不是给一个永远转圈的面板）
    ...(deps.projects === undefined
      ? []
      : [
          {
            kind: 'exact' as const,
            path: HTTP_ROUTES.projects,
            handler: async (req: IncomingMessage, res: ServerResponse) => {
              const projects = deps.projects
              if (projects === undefined) return
              if (req.method === 'GET') {
                // ★ 项目现在是**用户目录里的文件** ⇒ 每次现读（会变），不能缓存
                sendJson(res, 200, await projects.list())
                return
              }
              if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, reason: 'method_not_allowed' })
                return
              }
              const body = asRecord(await readJsonBody(req))
              const op = typeof body.op === 'string' ? body.op : ''
              const projectId = typeof body.projectId === 'string' ? body.projectId : ''
              if (projectId === '') {
                sendJson(res, 400, { ok: false, reason: '缺少 projectId' })
                return
              }
              if (op === 'import-sample') {
                const done = await projects.importSample(projectId)
                sendJson(res, done ? 200 : 404, {
                  ok: done,
                  ...(done ? {} : { reason: `没有这个样例："${projectId}"` }),
                })
                return
              }
              if (op === 'delete') {
                const done = await projects.remove(projectId)
                sendJson(res, done ? 200 : 404, {
                  ok: done,
                  ...(done ? {} : { reason: `没有这个项目："${projectId}"` }),
                })
                return
              }
              sendJson(res, 400, { ok: false, reason: `不认识的 op："${op}"（可用 import-sample / delete）` })
            },
          },
        ]),
    {
      kind: 'exact',
      path: HTTP_ROUTES.action,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method_not_allowed' })
          return
        }

        let action: ClientAction
        try {
          action = (await readJsonBody(req)) as ClientAction
        } catch (error) {
          sendJson(res, 400, { ok: false, reason: `bad_request: ${String(error)}` })
          return
        }
        if (action === undefined || typeof action !== 'object' || !('kind' in action)) {
          sendJson(res, 400, { ok: false, reason: 'bad_request: missing kind' })
          return
        }

        const result = state.applyAction(action)

        // 状态已改完 → 发事件（场景由前端收到事件后同步）
        if (result.ok) {
          for (const event of eventsForAction(action, state, 0)) bus.emit(event)
        }
        sendJson(res, 200, result)
      },
    },
  ]

  /* ── 用户导入的模型（几何） ──
   *
   * ★ 宿主路由**没有路径参数**（只有 exact / prefix），所以拆成两条：
   *   精确 `/api/model`（列表）+ 前缀 `/api/model/`（单项，key 由 handler 自己解析）。
   *
   * ★ 存储的是**用户自己导入的东西**，插件不分发任何第三方模型 ——
   *   这也是这条路径在许可上干净的根本原因。
   */
  const models = deps.models
  if (models !== undefined) {
    routes.push({
      kind: 'exact',
      path: MODEL_ROUTES.base,
      handler: async (_req, res) => {
        sendJson(res, 200, await models.list())
      },
    })

    routes.push({
      kind: 'prefix',
      path: MODEL_ROUTES.base,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://x').pathname
        // ★ 前缀**不带尾斜杠**（宿主约定），所以 key 从 prefix.length + 1 开始切。
        //   宿主保证 pathname 要么等于 prefix（那条走 exact 的 list 路由），要么以 `prefix/` 开头。
        const raw = pathname.startsWith(`${MODEL_ROUTES.base}/`)
          ? pathname.slice(MODEL_ROUTES.base.length + 1)
          : ''
        const modelKey = decodeURIComponent(raw)

        if (modelKey === '' || modelKey.includes('/')) {
          sendJson(res, 400, { ok: false, reason: 'bad_request: modelKey 不能为空或含 /' })
          return
        }

        try {
          if (req.method === 'GET') {
            const found = await models.get(modelKey)
            if (found === undefined) {
              sendJson(res, 404, { ok: false, reason: 'not_found' })
              return
            }
            const body = found.bytes
            res.writeHead(200, {
              'content-type':
                found.record.format === 'glb' ? 'model/gltf-binary' : 'model/gltf+json',
              'content-length': body.length,
              'cache-control': 'no-store',
            })
            res.end(body)
            return
          }

          if (req.method === 'POST') {
            const bytes = await readBinaryBody(req, MODEL_MAX_BYTES)
            const record = await models.put(modelKey, bytes)
            sendJson(res, 200, { ok: true, record })
            return
          }

          if (req.method === 'DELETE') {
            const removed = await models.delete(modelKey)
            sendJson(res, removed ? 200 : 404, { ok: removed })
            return
          }

          sendJson(res, 405, { ok: false, reason: 'method_not_allowed' })
        } catch (error) {
          if (error instanceof ModelStoreError) {
            // 校验类失败回 400（含目录穿越、格式不符、超限），其余回 500
            sendJson(res, error.code === 'io' ? 500 : 400, {
              ok: false,
              reason: error.code,
              message: error.message,
            })
            return
          }
          throw error
        }
      },
    })
  }

  /* ── 模型搜索：**step.parts 优先（可一键导入）+ 通用搜索兜底（外链）** ──
   *
   * ★ 为什么分两组而不是只留一组：
   *   · **step.parts** 给的是**结构化候选 + GLB 直链** ⇒ 可以**一键导入，全程不跳浏览器**
   *   · **通用搜索** 给的是**外链** ⇒ 覆盖 step.parts 没有的型号，但用户得自己去下
   *   两组并存，界面优先展示能一键导入的那组。
   *
   * ★ 两者都不涉及"抓取厂商站点"：一个走公开 API，一个走宿主搜索服务。
   */
  const search = deps.search
  const stepParts = deps.stepParts
  if (search !== undefined || stepParts !== undefined) {
    routes.push({
      kind: 'exact',
      path: MODEL_ROUTES.search,
      handler: async (req, res) => {
        const query = new URL(req.url ?? '/', 'http://x').searchParams.get('q')?.trim() ?? ''
        if (query === '') {
          sendJson(res, 400, { ok: false, reason: 'bad_request: 缺少查询词 q' })
          return
        }
        if (query.length > 200) {
          sendJson(res, 400, { ok: false, reason: 'bad_request: 查询词过长' })
          return
        }

        const result: MutableSearchResult = { query, candidates: [], sources: [] }
        const notes: string[] = []

        // ① step.parts —— 结构化候选，可一键导入
        if (stepParts !== undefined) {
          try {
            result.candidates = await stepParts.search(query, 20)
          } catch (error) {
            // 单个来源失败不应让整个搜索失败 —— 通用搜索仍可能给出结果
            notes.push(`step.parts 搜索失败：${String(error)}`)
          }
        } else {
          notes.push('未配置 step.parts 客户端，无法提供一键导入候选')
        }

        // ② 通用搜索 —— 外链兜底
        if (search !== undefined) {
          try {
            const web = await search(query)
            result.sources = web.sources
            if (web.content !== undefined) result.content = web.content
            if (web.unavailable !== undefined) notes.push(web.unavailable)
          } catch (error) {
            notes.push(`通用搜索失败：${String(error)}`)
          }
        } else {
          notes.push('宿主未提供通用搜索服务')
        }

        if (notes.length > 0) result.unavailable = notes.join('；')
        sendJson(res, 200, result)
      },
    })
  }

  /* ── 一键导入：客户端只给 partId，glbUrl 由宿主自己从 API 取 ── */
  if (models !== undefined && stepParts !== undefined) {
    routes.push({
      kind: 'exact',
      path: MODEL_ROUTES.import,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method_not_allowed' })
          return
        }

        const body = asRecord(await readJsonBody(req))
        const modelKey = typeof body['modelKey'] === 'string' ? body['modelKey'] : ''
        const partId = typeof body['partId'] === 'string' ? body['partId'] : ''
        if (modelKey === '' || partId === '') {
          sendJson(res, 400, { ok: false, reason: 'bad_request: 需要 modelKey 与 partId' })
          return
        }

        try {
          // ★ 客户端**从不**提供 URL —— glbUrl 由宿主从 step.parts API 取，SSRF 面为零
          const { bytes, candidate } = await stepParts.download(partId)
          const record = await models.put(modelKey, bytes)
          sendJson(res, 200, { ok: true, record, candidate })
        } catch (error) {
          if (error instanceof StepPartsError) {
            sendJson(res, error.code === 'too_large' ? 413 : 502, {
              ok: false,
              reason: error.code,
              message: error.message,
            })
            return
          }
          if (error instanceof ModelStoreError) {
            sendJson(res, 400, { ok: false, reason: error.code, message: error.message })
            return
          }
          throw error
        }
      },
    })
  }

  /* ── 面板浮层输入框 → 会话（见 host/chat.ts 的长注释） ──
   *
   * ★ 为什么是 POST 而不是 WebSocket：这是一次性的请求-应答（"发出去了吗、发给谁了"），
   *   没有持续流。走 WS 反而要自己造关联 id 来配对回执。
   * ★ 结果**始终回 200 + `{ok:false, reason}`**（除非请求体本身不合法）——
   *   投递失败是**业务结果**不是传输错误，前端要能拿到那句 reason 显示给用户。
   */
  const chat = deps.chat
  if (chat !== undefined) {
    routes.push({
      kind: 'exact',
      path: CHAT_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, reason: 'method_not_allowed' })
          return
        }
        const body = asRecord(await readJsonBody(req))
        const text = typeof body['text'] === 'string' ? body['text'] : ''
        const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] : undefined
        const result = chat({ text, ...(sessionId !== undefined ? { sessionId } : {}) })
        sendJson(res, 200, result)
      },
    })
  }

  return routes.map((route) => guarded(route, onError))
}

/**
 * WebSocket 升级路由。
 *
 * ★ 握手必须自己来：宿主的 `registerUpgrade` 只给原始 socket 与 `head`，
 *   协议协商（Sec-WebSocket-Accept 等）由本路由负责。这也是引入 `ws` 的原因 ——
 *   手写帧解析（掩码/分片/ping-pong/close）不值得，且容易出隐蔽 bug。
 */
export function createUpgradeRoutes(deps: RouteDeps): { routes: UpgradeRoute[]; dispose: () => void } {
  const { state, bus } = deps
  const wss = new WebSocketServer({ noServer: true })

  const broadcast = (message: HostToClientMessage): void => {
    const payload = JSON.stringify(message)
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.send(payload)
    }
  }

  // 事件桥 → 所有已连接前端。★ 必须持有退订函数，否则卸载后仍会往已关闭的 socket 写。
  const unsubscribe = bus.on((event) => {
    broadcast({ kind: 'event', event })
  })

  wss.on('connection', (socket: WebSocket) => {
    // 首帧：连接即拿到当前快照，前端不必再等一次轮询
    const hello: HostToClientMessage = {
      kind: 'hello',
      revision: state.revision,
      snapshot: state.snapshot(),
    }
    socket.send(JSON.stringify(hello))

    socket.on('message', (raw) => {
      let message: ClientToHostMessage
      try {
        message = JSON.parse(String(raw)) as ClientToHostMessage
      } catch {
        return
      }
      if (message.kind === 'resync') {
        const frame: HostToClientMessage = { kind: 'snapshot', snapshot: state.snapshot() }
        socket.send(JSON.stringify(frame))
      } else if (message.kind === 'ping') {
        socket.send(JSON.stringify({ kind: 'pong', t: message.t }))
      }
    })

    socket.on('error', () => {
      // 前端断线是常态（切页面/刷新），不视为错误
    })
  })

  return {
    routes: [
      {
        path: WS_ROUTE,
        handler: (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (client) => {
            wss.emit('connection', client, req)
          })
        },
      },
    ],
    dispose: () => {
      unsubscribe()
      for (const client of wss.clients) client.terminate()
      wss.close()
    },
  }
}

/**
 * 一次性组装全部路由 + 卸载钩子。
 * ★ `dispose` 必须被真的调用（挂到 ctx.effect 上），否则插件热重载会残留
 *   事件订阅与 WebSocket 连接 —— 表现为「卸载了还在推消息」。
 */
export function createRouteBundle(deps: RouteDeps): {
  http: HttpRoute[]
  upgrade: UpgradeRoute[]
  dispose: () => void
} {
  const http = createHttpRoutes(deps)
  const upgrade = createUpgradeRoutes(deps)
  return { http, upgrade: upgrade.routes, dispose: upgrade.dispose }
}
