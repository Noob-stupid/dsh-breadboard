/**
 * 从**插件面板里**给当前会话发消息。
 *
 * ## 两条通道，主路 + 显式降级
 *
 * | | ① 客户端 `session.prompt()`（**主路**） | ② 宿主路由 `POST /api/chat`（降级） |
 * |---|---|---|
 * | 准入（校验 / 排队 / `promptError` 镜像） | ✅ **走官方入口** | ❌ 绕过 |
 * | 附件（图片 / 文件） | ✅ | ❌ |
 * | 队列语义（`updateQueue` / FIFO / cancel） | ✅ | ❌ |
 * | 运行时验证状态 | 未验证 | **已实测** |
 *
 * ★ 为什么主路选①：**"能跑通"不等于"形态对"**。② 是往 inbox 里直接塞消息，
 *   绕过了所有准入 —— 那会让附件、队列、错误镜像全部失效。
 *
 * ★ 为什么保留②：① 的**最后一环**（`prompt()` 是否真驱动一轮）尚未运行时验证。
 *   ② 已实测（`ok:true` + messageId，且消息确实触发了新一轮）。
 *   降级有**明确触发条件**（① 失败），不是"两条路随便走"。
 *
 * ★ **① 一经验证通过，② 与 `via` 字段一并删除** —— 不留死代码、不留两条真相。
 *
 * ## ⚠️ 已知盲区（**未修，待定**）
 *
 * 降级**只在 ① 返回 `ok:false` 时触发**。而「**被接受、其实没送到**」这种静默失败
 * 不会产生 `ok:false` ⇒ **降级不触发 ⇒ 我们永远不知道**。
 *
 * ### 自然的修法有陷阱，别照做
 * 把降级条件改成「**没观测到送达**」（等一小段时间看消息是否出现）——
 * **会导致重复发送**：
 * ```
 * ① prompt() 被接受，但慢 —— 3 秒后才送达
 * ② 等 2 秒没看到 ⇒ 判定失败 ⇒ 走降级路由再发一次
 * ⇒ 用户发了一句，模型收到两条
 * ```
 * **重复发送比没送到更坏**：没送到用户看得见（消息没出现）；
 * **重复发送是静默的** —— 消息出现了，用户以为正常，模型却看到两遍。
 * 又是同一个族，只是这次藏在**补偿逻辑**里。
 *
 * ### 正确形态：**三态**，而不是两态
 * | 观测 | 判定 | 动作 |
 * |---|---|---|
 * | 观测到消息出现 | `confirmed` | 成功，`via:'client'` |
 * | `prompt()` 返回失败 | `failed` | **安全降级**（什么都没被接受，不会重发） |
 * | 被接受但未观测到（超时） | `unconfirmed` | **⚠️ 不自动降级** —— 交用户决定 |
 *
 * `unconfirmed` 的界面要给「**改用降级通道重发**」按钮，而不是替用户赌一把：
 * 用户点重发是**知情决定**；我们自动重发是**替他赌，赌输了还看不出来**。
 *
 * ### 观测手段（机制待定，未实现）
 * `SessionBinding` 上还有 `eventSource: SessionEventSource`：
 * `prompt()` 前记下当前 seq → 等 `user/message` 事件出现 → 出现即 `confirmed`。
 *
 * ### 为什么**现在不做**
 * ① 那条主路**尚未验证是否可用**。若它根本不通，② 和这套观测会**一起被删掉** ——
 * 为一个可能不存在的通道建观测机制是提前投入。
 * **先拿到"① 是否可用"的答案，再决定要不要建三态。**
 *
 * ### ★ 复访触发条件（**写触发条件本身也要能被触发**）
 * ⚠️ 一个自然的措辞是"`via === 'client'` 显示了绿、而消息没出现" ——
 *   **但那个条件永远不会成立**：绿在当前实现里**不可达**
 *   （无法确认送达就不给绿，见 `hud.ts` 的 tone 注释）。
 *   **一个永不触发的触发条件比没有更糟** —— 它制造虚假的安全感。
 *
 * ⇒ **真正的触发条件是**：
 *   ```
 *   用户报告：「提示说『已提交（走准入）』，但会话里始终没有这条消息」
 *   ```
 *   那一刻这个盲区就从**假设**变成**已证实**，此时才值得建观测机制。
 *   （用户手动做的那次测试**本身就是观测**，只是没有自动化。）
 *
 * ## 两个已验证的前提
 *
 * · **bundle 插件的客户端半拿得到 `ctx.sessions`** —— 实测已安装插件的 `client.js`：
 *   多个 bundle 的客户端半 `inject` 里就有 `"sessions"`。
 *   （`host.call` 不存在是因为它是**动态 runner 专有内建符号**，与普通客户端服务不同。）
 * · **当前会话 id** 来自 `ctx.sessions.currentProvideInfo.getSnapshot().sessionId` ——
 *   它是**用户当前选中**的会话（契约注释：*"Current session id, absent while the
 *   application is in no-session mode"*）。宿主侧不知道用户在看哪个，所以 id 只能由客户端给。
 *   ⚠️ 它是**属性**不是方法，`cordis_inspect_query` 的服务目录（只枚举方法）里看不到。
 */
import { CHAT_ROUTE } from '../contracts/protocol.ts'
import type { ChatSendResult } from '../contracts/protocol.ts'
import type { SessionsFace } from './slots.ts'

export interface SendOutcome extends ChatSendResult {
  /**
   * 实际走通的通道。
   *
   * ★ 存在的意义是**让"客户端通道到底通不通"变成可观测的** ——
   *   而不是靠"没报错所以应该通了"来推断。
   */
  readonly via?: 'client' | 'route'
}

/** 取用户**当前选中**的会话 id。 */
export function currentSessionId(sessions: SessionsFace | undefined): {
  sessionId?: string
  reason?: string
} {
  if (sessions === undefined) {
    return { reason: '客户端未注入 sessions 服务（拿不到"当前会话"）' }
  }
  try {
    const snapshot = sessions.currentProvideInfo.getSnapshot()
    if (snapshot.sessionId === undefined) {
      return { reason: '当前没有打开的会话（无会话模式下无法发送）' }
    }
    return { sessionId: snapshot.sessionId }
  } catch (error) {
    return { reason: `读取当前会话失败：${String(error)}` }
  }
}

/** ① 客户端准入路径（主路）。 */
async function sendViaClient(
  sessions: SessionsFace,
  sessionId: string,
  text: string,
): Promise<SendOutcome> {
  let binding: ReturnType<SessionsFace['binding']>
  try {
    binding = sessions.binding(sessionId)
  } catch (error) {
    return { ok: false, reason: `取会话绑定失败：${String(error)}` }
  }
  const session = binding?.session
  if (session?.prompt === undefined) {
    // `binding()` 只借出**已被 retain** 的会话；未 retain 就取不到句柄
    return { ok: false, reason: `会话 ${sessionId} 未被 retain，拿不到发送句柄` }
  }
  try {
    // 'queue' = 追加一轮（'steer' 会打断正在跑的那轮）
    await session.prompt([{ type: 'text', text }], 'queue')
    return { ok: true, sessionId, via: 'client' }
  } catch (error) {
    return { ok: false, reason: `客户端发送失败：${String(error)}` }
  }
}

/** ② 宿主路由（降级；已实测，但绕过准入）。 */
async function sendViaRoute(sessionId: string, text: string): Promise<SendOutcome> {
  try {
    const response = await fetch(CHAT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, sessionId }),
    })
    if (!response.ok) {
      return { ok: false, reason: `聊天路由返回 HTTP ${response.status}` }
    }
    const result = (await response.json()) as ChatSendResult
    return { ...result, via: result.ok ? 'route' : undefined }
  } catch (error) {
    return { ok: false, reason: `路由请求失败：${String(error)}` }
  }
}

/**
 * 给**当前会话**发一条文本消息。
 *
 * ★ 失败原因**逐条分类**，并把两条通道的失败原因**都**带回来 ——
 *   第一次试就能看出卡在哪一环，不用重来一遍。
 */
export async function sendToCurrentSession(
  sessions: SessionsFace | undefined,
  text: string,
): Promise<SendOutcome> {
  const { sessionId, reason } = currentSessionId(sessions)
  if (sessionId === undefined || sessions === undefined) {
    return { ok: false, reason: reason ?? '拿不到当前会话 id' }
  }

  const viaClient = await sendViaClient(sessions, sessionId, text)
  if (viaClient.ok) return viaClient

  const viaRoute = await sendViaRoute(sessionId, text)
  if (viaRoute.ok) return viaRoute

  return {
    ok: false,
    sessionId,
    reason: `客户端通道失败（${viaClient.reason}）；宿主路由也失败（${viaRoute.reason}）`,
  }
}
