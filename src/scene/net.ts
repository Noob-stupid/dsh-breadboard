/**
 * 宿主快照通道：首帧 GET + WebSocket 订阅 + 动作派发。
 *
 * ★ 铁律①（公约盒 `cv-muxwsfeb-s7frhb`）：本类**不解释**业务语义，只把宿主推来的快照原样缓存
 *   一份供场景采样。它**没有**「直接改状态」的接口 —— 一切变更必须 POST `/action`
 *   交给宿主 SSOT 裁决。前端永远不是第二本账。
 *
 * ★ 铁律②：WS 上的 `hardware/sim_tick` 已在**宿主侧**节流合并（契约 protocol.ts 已写明），
 *   前端不得自行逐 tick 处理；这里只做「收到事件 → 节流后请求全量重同步」。
 *
 * ★ 端点一律来自 `./endpoints.ts`（其本身转出自冻结契约），本文件不内联路径字面量。
 */
import type { AssemblySnapshot } from '../contracts/assembly.ts'
import type {
  ActionResult,
  ClientAction,
  ClientToHostMessage,
  HostCapabilities,
  HostToClientMessage,
} from '../contracts/protocol.ts'
import { HTTP_ROUTES, webSocketUrl } from './endpoints.ts'

/** 断线重连退避（毫秒），用尽后停在最后一档反复重试。 */
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000] as const

/**
 * 收到事件后请求全量重同步的最小间隔（毫秒）。
 * 事件风暴（如 1000 次 tick 合并后仍连续投递）时靠它兜底，避免打爆宿主。
 */
const RESYNC_THROTTLE_MS = 250

/** 场景层只需要「同步取到最新快照」这一个能力 —— 便于测试时用假实现替换。 */
export interface SnapshotSource {
  /** 同步返回当前最新快照；`undefined` 表示尚未收到。 */
  latest(): AssemblySnapshot | undefined
}

/** 需要触发全量重同步的事件（装配类变更；sim_tick 不在此列）。 */
const RESYNC_ON_EVENT = new Set<string>([
  'hardware/component_placed',
  'hardware/component_removed',
  'hardware/connection_made',
  'hardware/connection_removed',
  'hardware/connection_rejected',
  'hardware/state_changed',
])

export class SnapshotChannel implements SnapshotSource {
  private snapshot: AssemblySnapshot | undefined
  private socket: WebSocket | undefined
  private stopped = true
  private attempt = 0
  private reconnectTimer: number | undefined
  private resyncTimer: number | undefined
  private lastResyncAt = 0
  private readonly listeners = new Set<(snapshot: AssemblySnapshot) => void>()

  /** 当前最新快照（同步读）。场景每帧采样它。 */
  latest(): AssemblySnapshot | undefined {
    return this.snapshot
  }

  /** 订阅快照变更；返回退订函数。 */
  onChange(listener: (snapshot: AssemblySnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 拉首帧快照并建立 WS 订阅。失败不抛——WS 重连会兜底。 */
  async start(): Promise<void> {
    this.stopped = false
    await this.fetchSnapshot()
    this.openSocket()
  }

  /** 断开并停止重连。 */
  stop(): void {
    this.stopped = true
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.resyncTimer !== undefined) {
      clearTimeout(this.resyncTimer)
      this.resyncTimer = undefined
    }
    const socket = this.socket
    this.socket = undefined
    if (socket) {
      socket.onopen = null
      socket.onmessage = null
      socket.onclose = null
      socket.onerror = null
      try {
        socket.close()
      } catch {
        /* 已关闭 */
      }
    }
  }

  /** POST 一个动作给宿主 SSOT。前端不本地预测结果。 */
  async dispatch(action: ClientAction): Promise<ActionResult> {
    const response = await fetch(HTTP_ROUTES.action, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(action),
    })
    if (!response.ok) {
      return { ok: false, reason: `http_${response.status}` }
    }
    const result = (await response.json()) as ActionResult
    // 成功时宿主会顺带回一份新快照，省一次往返
    if (result.ok && result.snapshot) this.publish(result.snapshot)
    return result
  }

  /** 探测宿主能力（§10.1）。主线 B 依赖 `externalProcess`。 */
  async fetchCapabilities(): Promise<HostCapabilities | undefined> {
    try {
      const response = await fetch(HTTP_ROUTES.capabilities)
      if (!response.ok) return undefined
      return (await response.json()) as HostCapabilities
    } catch {
      return undefined
    }
  }

  /** 主动请求全量重同步（受节流约束）。 */
  requestResync(): void {
    const now = Date.now()
    const wait = Math.max(0, RESYNC_THROTTLE_MS - (now - this.lastResyncAt))
    if (this.resyncTimer !== undefined) return
    this.resyncTimer = setTimeout(() => {
      this.resyncTimer = undefined
      this.lastResyncAt = Date.now()
      this.send({ kind: 'resync' })
    }, wait) as unknown as number
  }

  /* ─────────────────────────── 内部 ─────────────────────────── */

  private publish(snapshot: AssemblySnapshot): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        console.error('[hardware-sandbox] snapshot listener failed', err)
      }
    }
  }

  private async fetchSnapshot(): Promise<void> {
    try {
      const response = await fetch(HTTP_ROUTES.assembly)
      if (!response.ok) return
      this.publish((await response.json()) as AssemblySnapshot)
    } catch {
      /* WS 重连兜底 */
    }
  }

  private send(message: ClientToHostMessage): void {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      /* 发送失败由 onclose 触发重连 */
    }
  }

  private openSocket(): void {
    if (this.stopped) return
    const socket = new WebSocket(webSocketUrl(window.location))
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      // 断线期间可能错过变更，握手后补一次全量
      this.send({ kind: 'resync' })
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      this.handleMessage(event.data)
    }

    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined
      this.scheduleReconnect()
    }

    socket.onerror = () => {
      // 错误后浏览器必然再派发 close，重连交给 onclose，避免双触发
    }
  }

  private handleMessage(raw: string): void {
    let message: HostToClientMessage
    try {
      message = JSON.parse(raw) as HostToClientMessage
    } catch {
      return
    }
    switch (message.kind) {
      case 'hello':
      case 'snapshot':
        this.publish(message.snapshot)
        break
      case 'event':
        // 装配类事件 → 节流请求全量；sim_tick 只驱动设备气泡，不动装配图
        if (RESYNC_ON_EVENT.has(message.event.type)) this.requestResync()
        break
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const index = Math.min(this.attempt, RECONNECT_BACKOFF_MS.length - 1)
    const delay = RECONNECT_BACKOFF_MS[index] ?? 8000
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.openSocket()
    }, delay) as unknown as number
  }
}
