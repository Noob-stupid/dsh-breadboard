/**
 * 面板浮层输入框 → 会话 的投递逻辑
 *
 * ★ 本文件盯住的核心是**一条安全性质**：**绝不猜目标会话**。
 *   猜错会把消息发进别人的会话，而且**没有任何提示** —— 属于失败族。
 *   所以"多会话且未指定"必须**拒绝**，不是"挑一个"。
 *
 * ★ 另外钉住消息形状：它是**结构等价构造**的（不 import `@deepseek-ai/dsh-llm`），
 *   形状若漂移不会有编译错误 ⇒ 这里显式断言字段。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createChatSender, type AgentLike, type AgentsLike } from '../src/host/chat.ts'

/* ─────────────────── 夹具 ─────────────────── */

interface Spy {
  readonly agent: AgentLike
  readonly received: unknown[]
}

function makeAgent(id: string, mode: 'followup' | 'send' | 'none' = 'followup', throws = false): Spy {
  const received: unknown[] = []
  const record = (input: unknown): void => {
    if (throws) throw new Error('投递炸了')
    received.push(input)
  }
  if (mode === 'followup') return { agent: { id, followup: record }, received }
  if (mode === 'send') return { agent: { id, send: (message) => { record(message) } }, received }
  return { agent: { id }, received }
}

function makeAgents(spies: Spy[]): AgentsLike {
  return {
    list: () => spies.map((s) => s.agent),
    get: (id) => spies.find((s) => s.agent.id === id)?.agent,
  }
}

let counter = 0
const fixedId = (): string => `msg-${String((counter += 1))}`

/* ─────────────────── ① 前置校验 ─────────────────── */

test('没有 agents 服务时明确拒绝（不静默）', () => {
  const send = createChatSender(undefined)
  const result = send({ text: '你好' })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /agents/)
})

test('空文本被拒（不往会话里塞空消息）', () => {
  const spy = makeAgent('s1')
  const send = createChatSender(makeAgents([spy]))
  for (const text of ['', '   ', '\n\t ']) {
    const result = send({ text })
    assert.equal(result.ok, false, `"${text}" 应当被拒`)
  }
  assert.equal(spy.received.length, 0, '一次都不该投递')
})

test('文本两端空白被裁掉', () => {
  const spy = makeAgent('s1')
  const send = createChatSender(makeAgents([spy]), fixedId)
  assert.equal(send({ text: '  你好  ' }).ok, true)
  const message = spy.received[0] as { content: { text: string }[] }
  assert.equal(message.content[0]?.text, '你好')
})

/* ─────────────────── ② ★ 目标解析：绝不猜 ─────────────────── */

test('★ 指定了 sessionId 就发给它', () => {
  const a = makeAgent('s1')
  const b = makeAgent('s2')
  const send = createChatSender(makeAgents([a, b]), fixedId)

  const result = send({ text: 'hi', sessionId: 's2' })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 's2')
  assert.equal(a.received.length, 0, '不该发给 s1')
  assert.equal(b.received.length, 1)
})

test('★ 指定的 sessionId 不存在时**拒绝**，不退化到别的会话', () => {
  const a = makeAgent('s1')
  const send = createChatSender(makeAgents([a]), fixedId)

  const result = send({ text: 'hi', sessionId: 'nope' })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /找不到会话/)
  assert.equal(a.received.length, 0, '★ 绝不能"找不到就随便挑一个"')
})

test('只有一个活动会话时退化使用它', () => {
  const only = makeAgent('s1')
  const send = createChatSender(makeAgents([only]), fixedId)
  const result = send({ text: 'hi' })
  assert.equal(result.ok, true)
  assert.equal(result.sessionId, 's1')
  assert.equal(only.received.length, 1)
})

test('★ 多个活动会话且未指定 ⇒ **拒绝**，并列出候选', () => {
  const a = makeAgent('s1')
  const b = makeAgent('s2')
  const c = makeAgent('s3')
  const send = createChatSender(makeAgents([a, b, c]), fixedId)

  const result = send({ text: 'hi' })
  assert.equal(result.ok, false, '★ 必须拒绝 —— 猜错会把消息发进别人的会话，且无提示')
  assert.match(result.reason ?? '', /3 个活动会话/)
  assert.match(result.reason ?? '', /s1/)
  assert.match(result.reason ?? '', /s3/)
  for (const spy of [a, b, c]) assert.equal(spy.received.length, 0)
})

test('没有活动会话时拒绝', () => {
  const send = createChatSender(makeAgents([]))
  const result = send({ text: 'hi' })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /没有活动会话/)
})

test('空字符串的 sessionId 视为未指定（走退化路径）', () => {
  const only = makeAgent('s1')
  const send = createChatSender(makeAgents([only]), fixedId)
  assert.equal(send({ text: 'hi', sessionId: '' }).ok, true)
})

/* ─────────────────── ③ ★ 消息形状 ─────────────────── */

test('★ 消息形状与 createUserMessage 逐字段等价', () => {
  const spy = makeAgent('s1')
  const send = createChatSender(makeAgents([spy]), () => 'fixed-id')
  const result = send({ text: '你好世界' })

  assert.equal(result.messageId, 'fixed-id')
  const message = spy.received[0] as Record<string, unknown>
  assert.deepEqual(message, {
    id: 'fixed-id',
    role: 'user',
    content: [{ type: 'text', text: '你好世界' }],
    source: { kind: 'user' },
  })
})

test('消息被冻结（与 createMessage 的 freezeMessage 一致）', () => {
  const spy = makeAgent('s1')
  createChatSender(makeAgents([spy]), fixedId)({ text: 'hi' })
  assert.equal(Object.isFrozen(spy.received[0]), true)
})

/* ─────────────────── ④ 宿主 API 变更 / 异常 ─────────────────── */

test('★ 会话上没有 followup/send 时**明确拒绝**（宿主 API 可能已变更）', () => {
  const bare = makeAgent('s1', 'none')
  const send = createChatSender(makeAgents([bare]), fixedId)
  const result = send({ text: 'hi' })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /followup\/send/)
  assert.equal(bare.received.length, 0)
})

test('只有 send 没有 followup 时走 send(msg, "next-turn", true)', () => {
  const received: unknown[] = []
  const agent: AgentLike = {
    id: 's1',
    send: (message, target, wakeup) => {
      received.push({ message, target, wakeup })
    },
  }
  const send = createChatSender(makeAgents([{ agent, received: [] }]), fixedId)
  assert.equal(send({ text: 'hi' }).ok, true)
  const call = received[0] as { target: string; wakeup: boolean }
  assert.equal(call.target, 'next-turn', '必须是"开新一轮"，不是插进当前轮')
  assert.equal(call.wakeup, true, '不唤醒就不会真的跑')
})

test('投递抛异常时返回原因，不往外抛（否则会变成空 body 500）', () => {
  const boom = makeAgent('s1', 'followup', true)
  const send = createChatSender(makeAgents([boom]), fixedId)
  const result = send({ text: 'hi' })
  assert.equal(result.ok, false)
  assert.match(result.reason ?? '', /投递失败/)
})

test('成功时返回 sessionId 与 messageId（前端要用来回显去重）', () => {
  const spy = makeAgent('s1')
  const send = createChatSender(makeAgents([spy]), () => 'm-1')
  assert.deepEqual(send({ text: 'hi' }), { ok: true, sessionId: 's1', messageId: 'm-1' })
})
