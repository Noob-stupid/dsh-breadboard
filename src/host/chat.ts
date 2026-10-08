/**
 * 面板浮层输入框 → 会话（设计文档 §10 薄适配层）
 * @module dsh-hardware-sandbox/host/chat
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 这条通道很容易找错 —— 我第一遍就找错了，记在这里免得再犯
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 看起来像"发消息"的 | 实际是 |
 * |---|---|
 * | `commands.execute(agent, line, …)` | 文档原文 **"execute a known command *without sending it to the model*"** —— 斜杠命令，**不产生对话轮次** |
 * | `Session.append('user/message', …)` | 只往**日志**写事件，**不驱动 agent loop** |
 * | **`Agent.followup(input)`** | ✅ `send(input,'next-turn',true)` —— **就是"用户发消息、开新一轮"** |
 *
 * 前两个做出来的东西是「**看着像发了消息、其实模型没收到**」——
 * 正是本项目失败族的形态。所以这里只走第三条。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 消息是**结构等价构造**的，不 import `@deepseek-ai/dsh-llm`
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `createUserMessage({content, source})` 的运行时实现只是
 * `freezeMessage({ ...input, id: randomUUID(), role: 'user' })` ——
 * 所以结构等价构造是**逐字段相同**的。
 *
 * 为什么不直接 import：`dsh-llm` 是**核心包**，运行时不在 profile 的 `node_modules` 里
 * （只有 checkout 的 `lib/types`，没有构建产物），值导入会 ERR_MODULE_NOT_FOUND。
 * §10.3 也要求内核零依赖宿主 API。
 *
 * ⚠️ **代价**：形状若漂移，我们不会在编译期知道。
 *    ⇒ 所以这里对**方法是否存在**做显式检查（`followup` / `send`），
 *      缺失就**明确拒绝**，而不是静默调一个不存在的函数。
 *      形状本身的最终判据是端到端：消息真的出现在会话里。
 */

import type { ChatSendRequest, ChatSendResult } from '../contracts/protocol.ts'

/** 结构等价于宿主 `Agent`（只用到这几项）。 */
export interface AgentLike {
  readonly id: string
  /** `send(input, 'next-turn', true)` —— 用户发消息、开新一轮。 */
  followup?(input: unknown): void
  send?(message: unknown, target: 'next-turn' | 'next-step', wakeup: boolean): void
}

/** 结构等价于宿主 `agents` 服务。 */
export interface AgentsLike {
  list(): readonly AgentLike[]
  get(id: string): AgentLike | undefined
}

/**
 * 构造一条用户消息（结构等价于 `createUserMessage`）。
 *
 * ★ `source: { kind: 'user' }` 不能省：界面靠它区分"人说的"与"模型说的"。
 */
function buildUserMessage(text: string, id: string): unknown {
  return Object.freeze({
    id,
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: { kind: 'user' },
  })
}

/** 解析目标 Agent。**绝不猜** —— 猜错会把消息发进别人的会话。 */
function resolveAgent(
  agents: AgentsLike,
  sessionId: string | undefined,
): { agent: AgentLike } | { reason: string } {
  if (sessionId !== undefined && sessionId !== '') {
    const found = agents.get(sessionId)
    if (found === undefined) return { reason: `找不到会话 "${sessionId}"（可能已归档或未加载）` }
    return { agent: found }
  }

  const live = agents.list()
  if (live.length === 0) return { reason: '当前没有活动会话' }
  if (live.length === 1) {
    const only = live[0]
    if (only === undefined) return { reason: '当前没有活动会话' }
    return { agent: only }
  }
  // ★ 多会话且没指定 ⇒ **拒绝**，并把候选列出来让人/前端去选。
  //   退化猜测在这里是不可接受的：消息发错会话没有任何提示。
  return {
    reason:
      `有 ${String(live.length)} 个活动会话，无法确定发给哪一个 —— ` +
      `请在请求里带上 sessionId。候选：${live.map((a) => a.id).join(', ')}`,
  }
}

/**
 * 造一个"发消息给会话"的函数。
 *
 * @returns 成功时 `{ok:true, sessionId, messageId}`；失败时 `{ok:false, reason}`（**不抛**，
 *   因为这是前端调用的路径，抛出去只会变成一个没有 body 的 500）。
 */
export function createChatSender(
  agents: AgentsLike | undefined,
  newId: () => string = () => crypto.randomUUID(),
): (request: ChatSendRequest) => ChatSendResult {
  return (request: ChatSendRequest): ChatSendResult => {
    if (agents === undefined) {
      return { ok: false, reason: '宿主未提供 agents 服务 —— 无法投递消息' }
    }

    const text = typeof request.text === 'string' ? request.text.trim() : ''
    if (text === '') return { ok: false, reason: 'text 不能为空' }

    const resolved = resolveAgent(agents, request.sessionId)
    if ('reason' in resolved) return { ok: false, reason: resolved.reason }
    const { agent } = resolved

    const messageId = newId()
    const message = buildUserMessage(text, messageId)

    // ★ 方法存在性检查：宿主 API 若改名，这里**明确拒绝**，
    //   而不是静默调一个 undefined（那会抛 TypeError 变成空 body 500，现场无线索）。
    try {
      if (typeof agent.followup === 'function') {
        agent.followup(message)
      } else if (typeof agent.send === 'function') {
        agent.send(message, 'next-turn', true)
      } else {
        return {
          ok: false,
          reason: `会话 "${agent.id}" 上没有 followup/send 方法 —— 宿主 API 可能已变更`,
        }
      }
    } catch (error) {
      return { ok: false, reason: `投递失败：${error instanceof Error ? error.message : String(error)}` }
    }

    return { ok: true, sessionId: agent.id, messageId }
  }
}
