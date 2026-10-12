/**
 * 面板右下角的 **Star 钩子** —— 只有数据，**零 React 依赖**。
 *
 * ## 为什么单独一个文件
 *   "钩子长什么样"（href / rel / 内联 SVG 路径 / 文案 / 定位）是**可断言的事实**，
 *   而"把它渲染出来"是 `panel.ts` 的事。把**事实**与**渲染**分开之后，
 *   测试可以在**不起浏览器、不引 React**的前提下验证「链接指向本仓库」，
 *   而不是靠肉眼看截图 —— 截图看不出来的东西（`rel` 少了 `noopener`）正好是危险的那种。
 *
 * ## 两条硬约束（都是用户点名的）
 *   · **内联 SVG，不引外链图片**：GitHub mark 用 Octicons 的正统几何内联进 DOM
 *     （16×16 视图、`currentColor` 着色 ⇒ 跟随文字颜色）。
 *     外链图片在离线/被墙时就是**一个破图标**，而它偏偏出现在"想让人点 Star"的位置。
 *   · **`rel="noreferrer noopener"`**：`target="_blank"` 会让新页面拿到 `window.opener`，
 *     等于把本页面的控制权交给外站。两个 token 都要有，缺一个都不算达标。
 *
 * ## 形态来源
 *   控制台插件 0.5.42 的 Star 提示（**我们自己的代码**，同一套视觉语言）：
 *   15px 图标 + 次级灰小字 + hover 变主题色 + 键盘焦点环。
 *   本面板没有样式表（一律 React 内联 `style`），所以这里给的就是内联样式对象。
 */

/** 点 Star 的目标仓库。**这是本钩子唯一的功能目标**：仓库 URL（改名不改仓库）。 */
export const STAR_REPO_URL = 'https://github.com/Noob-stupid/dsh-breadboard'

/** 提示文案（中文，一句话）。 */
export const STAR_HINT_TEXT = '喜欢这个插件？去 GitHub 点个 Star'

/** 悬停标题（说明点击会发生什么，而不是重复文案）。 */
export const STAR_HINT_TITLE = '在新标签页打开 GitHub 项目'

/**
 * GitHub mark 的正统几何（GitHub Octicons，16×16 视图）。
 *
 * ★ 内联而不是外链：见文件头第 ① 条约束。
 */
export const GITHUB_MARK_PATH =
  'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656'

/** 图标尺寸（px）。与控制台那处一致。 */
export const GITHUB_MARK_SIZE = 15

/** `<svg>` 的属性（内联、`currentColor`、对读屏隐藏 —— 文案已经说明了它的意思）。 */
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
 * 钩子容器的定位。
 *
 * ★ 为什么 `bottom` 是 52px 而不是 12px —— **右下角已经被占了**：
 *   `ControlHint`（"拖动组件＝移动 · 拖动端口＝连线…"两行小字）就在 `right:12 / bottom:12`。
 *   贴到同一个位置会和它**叠在一起**，而用户明确要求「不改面板既有布局/行为」。
 *   ⇒ 钩子叠在提示**上方**（提示约 45px 高），仍然是**右下角**，谁也不挡谁。
 */
export const STAR_FOOT_STYLE = {
  position: 'absolute',
  right: '12px',
  bottom: '52px',
  display: 'flex',
  justifyContent: 'flex-end',
  /** 窄容器不溢出：宽度跟着面板走，左右各留 12px。 */
  maxWidth: 'calc(100% - 24px)',
} as const

/** `<a>` 的属性。`rel` 两个 token 都在 —— 见文件头第 ② 条约束。 */
export const STAR_LINK_ATTRS = {
  href: STAR_REPO_URL,
  target: '_blank',
  rel: 'noreferrer noopener',
  title: STAR_HINT_TITLE,
} as const

/** `<a>` 的样式（与面板既有 HUD 同一套暗色 + 等宽小字）。 */
export const STAR_LINK_STYLE = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  maxWidth: '100%',
  boxSizing: 'border-box',
  padding: '4px 8px',
  borderRadius: '6px',
  border: '1px solid rgba(120, 200, 255, 0.22)',
  background: 'rgba(20, 26, 34, 0.72)',
  color: 'rgba(200, 212, 232, 0.78)',
  font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  textDecoration: 'none',
} as const

/** 文案样式：允许在极窄容器里断行，而不是把容器撑出面板。 */
export const STAR_HINT_STYLE = {
  overflowWrap: 'anywhere',
} as const
