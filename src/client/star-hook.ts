/**
 * 官方**插件详情页**底部的 **Star 钩子** —— 只有数据与一个纯展示组件。
 *
 * ## 它长在哪里（这是用户点名的位置）
 *   官方 `@deepseek-ai/dsh-client-ui-plugin-manager` 的插件详情页向**任意插件**
 *   开放了三个插槽，本钩子用其中的 **`plugins.detail.section`**
 *   （契约原文：「Sections under a detail page's own content」）。
 *   该 slot 由页面渲染成 `.detailSections` 的**最后一个子节点** ⇒
 *   落点就是**页面内容最下方**（见 `index.ts` 的注册处）。
 *
 * ## 为什么"每个插件只能给自己那页加"
 *   owner props 是 `PluginDetailProps { subject }`，而 `subject` 里
 *   **没有 repository / homepage**（见官方 `slot-contract.d.ts` 的
 *   `PluginPackageRef`：name / version? / installed / enabled / rows[]）。
 *   ⇒ 无法从 subject 推出"这个插件的仓库在哪"，只能**认包名**：
 *     这一页讲的正是本插件时才渲染，别的插件的页返回 `null`（官方 item 页
 *     只有 `kind: 'item'` + `id`，连包名都没有 ⇒ 同样不渲染）。
 *
 * ## 观感（用户点名的红线，照着卡片插件那次的教训）
 *   · **不许任何背景色块 / 边框 / 阴影** —— 上一版卡片钩子用了
 *     `background: var(--dsw-alias-bg-layer-1)` + `box-shadow: 0 16px 0 …`
 *     做"滚动遮挡兜底"，结果被读成"一个灰色颜色框 / 满宽色带"。
 *     这里一律 `transparent`，并且**不做 sticky**（sticky 必须靠不透明背景
 *     才能不糊住正文 —— 那就又回到色块了）。普通流里一行右对齐，
 *     不遮任何内容，是本任务的正确解。
 *   · **小元素、靠右**：容器 `alignSelf: 'flex-end'`（`.detailSections` 是
 *     column flex ⇒ 这一条就是右对齐），宽度自适应内容，窄宽度只换行不溢出。
 *   · 内容是**内联 GitHub mark SVG + 中文文案**，不引外链图片/字体/脚本。
 *
 * ## 安全
 *   槽未声明时 `inject` 静默等待（老框架上只是不显示），不会让插件挂掉。
 */
import { createElement } from 'react'
import { PLUGIN_PACKAGE_NAME } from '../contracts/protocol.ts'

/** 点 Star 的目标仓库。**这是本钩子唯一的功能目标**（仓库 URL，改名不改仓库）。 */
export const STAR_REPO_URL = 'https://github.com/Noob-stupid/dsh-breadboard'

/** 提示文案（中文，一句话）。 */
export const STAR_HINT_TEXT = '喜欢这个插件？去 GitHub 点个 Star'

/** 悬停标题（说明点击会发生什么，而不是重复文案）。 */
export const STAR_HINT_TITLE = '在新标签页打开 GitHub 项目'

/**
 * GitHub mark 的正统几何（GitHub Octicons，16×16 视图）。
 *
 * ★ 内联而不是外链：外链图片在离线/被墙时就是**一个破图标**，
 *   而它偏偏出现在"想让人点 Star"的位置。
 */
export const GITHUB_MARK_PATH =
  'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'

/** 图标尺寸（px）。用户要求 16×16 这一档。 */
export const GITHUB_MARK_SIZE = 16

/** `<svg>` 的属性（内联、`currentColor` 着色、对读屏隐藏 —— 文案已说明其含义）。 */
export const GITHUB_MARK_ATTRS = {
  width: GITHUB_MARK_SIZE,
  height: GITHUB_MARK_SIZE,
  viewBox: '0 0 16 16',
  fill: 'currentColor',
  'aria-hidden': 'true',
  focusable: 'false',
  style: { flex: 'none', display: 'block' },
} as const

/**
 * 容器样式：**普通流里的一行，右对齐**。
 *
 * ★ 无 background / border / box-shadow（用户红线）——
 *   `tests/star-hook.test.ts` 会遍历这两个样式对象**逐键**断言这一点。
 * ★ `alignSelf: 'flex-end'` 靠的是宿主的 `.detailSections`
 *   （`display:flex; flex-direction:column; gap:32px`）⇒ 这一条即"靠右"。
 *   为了在**不是 flex 容器**的宿主里也不跑偏，同时给 `display:flex` +
 *   `justifyContent:flex-end`（两个都无害，任何一个生效都是右对齐）。
 * ★ `flexWrap: 'wrap'` + `maxWidth: '100%'`：窄宽度**换行**而不是把页面撑宽。
 */
export const STAR_ROW_STYLE = {
  alignSelf: 'flex-end',
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  maxWidth: '100%',
  minWidth: '0',
} as const

/**
 * `<a>` 的样式：小字次级灰、**完全透明**（没有框、没有底、没有阴影）。
 *
 * ★ `color` 用宿主主题令牌并带兜底值：两个主题都跟着走，拿不到令牌时也有颜色。
 * ★ hover / focus 只改**文字色与下划线**（以及焦点环）—— 都不产生色块。
 */
export const STAR_LINK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '2px 0',
  color: 'var(--dsw-alias-label-secondary, #8a8a8a)',
  font: '12px/16px inherit',
  textDecoration: 'none',
  background: 'transparent',
  border: 'none',
  boxShadow: 'none',
} as const

/** 文案样式：允许在极窄容器里断行，而不是把容器撑出页面。 */
export const STAR_HINT_STYLE = {
  overflowWrap: 'anywhere',
} as const

/** `<a>` 的属性。`target="_blank"` 必须配 `rel` 两个 token（见测试）。 */
export const STAR_LINK_ATTRS = {
  href: STAR_REPO_URL,
  target: '_blank',
  rel: 'noreferrer noopener',
  title: STAR_HINT_TITLE,
} as const

/**
 * 详情页 `subject` 的**结构面**（只声明本钩子读的字段）。
 * 出处：官方 `dsh-client-ui-plugin-manager/lib/types/client/slot-contract.d.ts`
 * 的 `PluginsSubject` / `PluginPackageRef`。**不 import 那个包**（前端运行时
 * 才提供，编译期解析不到）。
 */
export interface PluginDetailSubject {
  readonly kind?: string
  readonly pkg?: { readonly name?: string }
}

/**
 * **判据**：这一页讲的正是本插件吗？
 *
 * ★ 必须有 `kind === 'bundle'`：row 页的 `pkg` 是**它所属的 bundle**，
 *   不判 kind 的话"我自己的某个 row 页"也会长出 Star 钩子（那是同一个包的另一页，
 *   不是详情页本身）。
 */
export function isOwnPluginPage(subject: PluginDetailSubject | undefined): boolean {
  if (subject === undefined || subject === null) return false
  return subject.kind === 'bundle' && subject.pkg?.name === PLUGIN_PACKAGE_NAME
}

/**
 * 钩子组件：**纯展示**（不读快照、不发请求、不参与装配与仿真）。
 *
 * ★ 只有本插件的 bundle 详情页才渲染；其它 subject 一律 `null`
 *   —— 空注册，页面无痕。
 */
export function StarRow(props: { readonly subject?: PluginDetailSubject }): unknown {
  if (!isOwnPluginPage(props?.subject)) return null

  return createElement(
    'div',
    { 'data-dsh-breadboard-star': 'section', style: STAR_ROW_STYLE },
    createElement(
      'a',
      { ...STAR_LINK_ATTRS, style: STAR_LINK_STYLE },
      createElement('svg', GITHUB_MARK_ATTRS, createElement('path', { d: GITHUB_MARK_PATH })),
      createElement('span', { style: STAR_HINT_STYLE }, STAR_HINT_TEXT),
    ),
  )
}
