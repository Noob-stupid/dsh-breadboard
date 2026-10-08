/**
 * @dsh-breadboard/dsh-hardware-sandbox — client（bundle 前端半）。
 *
 * ## 挂载方式（对**实时** client slot 树核实，2026-10-07）
 *
 * · `sidebar.panellist` 是 **list** 槽，注册需 `{ id, order, label }`。catalog 原文：
 *   「Each list id addresses the matching main panel」——所以 **id 必须与 `main` 的 key 字面相等**，
 *   否则点了图标中央列不会派发。
 * · `main` 是 root 作用域 **keyed** 槽，注册需 `{ key }`；含义「Central panel selected by sidebar entry id」。
 *   已占 key：conversation / plugins / schedules / connection-panel / task-board —— 我们取 `hardware-sandbox`。
 * · 组件契约是 **React 函数组件** `SlotComponent<P> = (props: P) => ReactNode`。
 *   （scaffold 生成的 `() => ({ render() {} })` 形状**不符合**该契约，已按契约重写。）
 *
 * ## 桥接（公约盒 `cv-muxwsfds-1xmitj`）
 * bundle 前端半**没有** `host.call`（该符号只在动态 Cordis 插件 runner 里）。
 * 一律走宿主半 `ctx.webServer.register(route)`，前端用 `fetch` / `WebSocket`。
 * 端点常量集中在 `src/scene/endpoints.ts`。
 */
import { PANEL_ID } from '../scene/endpoints.ts'
import { HardwareSandboxIcon } from './icon.ts'
import { HardwareSandboxPanel } from './panel.ts'
import type { ClientContext, SessionsFace } from './slots.ts'

/**
 * 服务注入声明。
 * ⚠️ 必须 export：缺了它 `apply` 里的 `ctx.slots` 拿不到服务。
 *
 * ★ `sessions` **故意不放进来**：它是可选的（只用于"面板里跟 DS 对话"），
 *   放进硬注入后一旦该服务缺失，**整个面板都挂不上**。
 *   改用 `ctx.get('sessions')` 可选获取 ⇒ 拿不到时只是对话不可用，场景照常工作。
 */
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  // ⚠️⚠️ **`register({` 必须写在同一行** —— 这不是风格问题，是**能不能装上的问题**。
  //
  //   `dsh-super-injector` 的注入前校验用的是一条**对格式敏感的正则**：
  //
  //   ```js
  //   new RegExp(`register\\(\\{[\\s\\S]{0,400}?name:\\s*['"](${SLOT_ALT})['"]`)
  //   ```
  //
  //   它要求 **`register(` 后紧跟 `{`**。写成
  //   ```ts
  //   ctx.slots.register(        // ← 这里换行
  //     { name: '…' },
  //   ```
  //   就**匹配不上** ⇒ 被误判成"缺合法 name" ⇒ **注入被阻断、插件装不上**。
  //
  //   ⇒ 这是**假阳性**（代码本身没错，是校验器的正则太窄）。但我们改不了校验器，
  //     而把它写成一行**零代价** —— 所以照它的形状写，并在这里写明缘由，
  //     免得下一个人"顺手格式化"回去、把插件又弄挂一次。
  //
  //   ★ 症状有多难查：插件列表显示"异常"、侧栏图标消失、**所有 `/api/*` 404**，
  //     而**报错信息说的是"缺 name"，代码里明明写着 name**。

  // ① 侧栏入口图标：id = PANEL_ID，中央列据此派发同名 key
  ctx.effect(
    () =>
      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30, // 已占：plugins 0 / schedules 10 / task-board 20 / connection-panel 200
          label: () => '硬件沙盒',
        }, HardwareSandboxIcon),
      ),
    'hardware-sandbox: sidebar entry',
  )

  // ② 中央面板：keyed 槽，key 必须与上面 id 一致
  //
  // ★ 用 `inject` 面把 `ctx.sessions` 带进组件：`main` 是 **root 作用域**，
  //   拿不到 session 类的标准 props，但它需要"给当前会话发消息"的能力。
  ctx.effect(
    () =>
      ctx.slots.inject('main', () =>
        ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
          inject: () => ({ sessions: ctx.get('sessions') as SessionsFace | undefined }),
        }, HardwareSandboxPanel),
      ),
    'hardware-sandbox: main panel',
  )

  ctx.logger?.info?.('[hardware-sandbox] client 半已注册 sidebar.panellist + main（key=' + PANEL_ID + '）')
}
