/**
 * 前端场景层用到的端点 —— **不自己定义路径，一律从冻结契约转出**。
 *
 * ★ 唯一出处：`src/contracts/protocol.ts`（owner: session-24ca6e69）。
 *   本文件只做「转出 + 便利函数」，**绝不内联路径字面量** —— 否则契约一改就静默分叉。
 *
 * ★ 转出而非镜像：`protocol.ts` 注释里要求「前端那份必须字面一致、改一处要同时改另一处」，
 *   那是**镜像**方案（两份定义、存在分叉面）。这里用 `export ... from` 直接转出，
 *   **只有一份定义**，不存在需要手工同步的第二处 —— 契约改了前端自动跟随。
 *
 * 实测过的教训：契约在 owner 手上会继续修订。我曾读到一次**中途态**（无 `/api`、
 * 路径为 `/snapshot` 与 `/events`）就据此下了结论，结果契约随后冻结回 `/api/**`。
 * 所以前端只认**当前文件内容**，并且必须 import 转出 —— 抄下来的那一刻就可能已过期。
 */
import { WS_ROUTE } from '../contracts/protocol.ts'

export { HTTP_ROUTES, ROUTE_PREFIX, WS_ROUTE } from '../contracts/protocol.ts'

/**
 * 面板 id。
 *
 * 必须**字面相等**地同时用作：
 *   · `sidebar.panellist` 的 `id`（list 槽，全局面板图标）
 *   · `main` 的 `key`（keyed 槽，中央面板）
 *
 * 依据：`sidebar.panellist` catalog 原文「Each list id addresses the matching main panel;
 * the sidebar owns the button and resolves its label from list metadata.」
 * 二者不一致 = 点了图标但中央面板不派发。
 */
export const PANEL_ID = 'hardware-sandbox'

/**
 * 由 `WS_ROUTE` 构造绝对 `ws://` / `wss://` 地址。
 *
 * 浏览器里 `fetch` 吃相对路径，但 `WebSocket` 构造函数**必须**拿绝对 URL。
 */
export function webSocketUrl(location: { protocol: string; host: string }): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${WS_ROUTE}`
}
