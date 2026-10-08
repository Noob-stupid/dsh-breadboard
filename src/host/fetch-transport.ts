/**
 * 真实 `fetch` 实现的出网能力（设计文档 §10 薄适配层）
 * @module dsh-hardware-sandbox/host/fetch-transport
 *
 * ★ 与 `subprocess-spawner.ts` 同属适配层：把宿主能力包成内核要的**注入点**。
 *   内核（`core/**`）因此零依赖宿主 API，测试可以塞假传输、不联网跑完整条逻辑。
 *
 * ── 三处刻意的选择 ──
 *
 * ① **非 2xx 不抛，如实返回状态码。**
 *    智座把业务错误也放在 body 里（`{code,message,data}`），一律当异常抛会丢掉那句 message，
 *    而 message 恰恰是给用户看的唯一线索。
 *
 * ② **超时必须有，且要有上限。**
 *    没有超时的话，一个不响应的外部系统会让设备永远卡在"上报中"——
 *    而 `NetworkedDevice` 的并发守卫会让**后续所有上报全部被挡掉**（`#busy` 一直是 true）。
 *    症状是"设备在线但再也不上报了"，极难归因。
 *
 * ③ **body 解析失败不抛。**
 *    对面可能返回 HTML 错误页。此时要保留**原始文本**（`text`）供诊断 ——
 *    只说"JSON 解析失败"等于把唯一的线索扔掉。
 */

import type { NetworkRequest, NetworkResponse, NetworkTransport } from '../contracts/network.ts'

export interface FetchTransportOptions {
  /** 单次请求超时（毫秒）。默认 10s。 */
  readonly timeoutMs?: number
  /** 注入 fetch 以便测试。 */
  readonly fetchImpl?: typeof fetch
}

export function createFetchTransport(options: FetchTransportOptions = {}): NetworkTransport {
  const timeoutMs = options.timeoutMs ?? 10_000
  const doFetch = options.fetchImpl ?? fetch

  return async (request: NetworkRequest, signal?: AbortSignal): Promise<NetworkResponse> => {
    // 把外部 signal 与自己的超时合成一个 —— 少一个都可能挂住
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new Error(`请求超时（${String(timeoutMs)}ms）`))
    }, timeoutMs)
    const onAbort = (): void => {
      controller.abort(signal?.reason)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      const response = await doFetch(request.url, {
        method: request.method,
        headers: { 'content-type': 'application/json', ...(request.headers ?? {}) },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal: controller.signal,
      })

      const text = await response.text()
      let body: unknown
      try {
        body = text === '' ? undefined : JSON.parse(text)
      } catch {
        // ★ 不抛：保留 text 供诊断（对面可能返回 HTML 错误页）
        body = undefined
      }
      return { status: response.status, body, text }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
