/**
 * Star 钩子测试（2026-10-12 加；2026-10-12 下半场改为**官方插件详情页**落点）。
 *
 * 用户要求（逐条对应到断言）：
 *   ① **落点 = 官方插件详情页** `plugins.detail.section`，靠右、内容最下方
 *   ② **判断"这一页是不是本插件"**：满足才渲染，不满足返回 `null`
 *   ③ **href 指向本仓**（`https://github.com/Noob-stupid/dsh-breadboard`）
 *   ④ **内联 svg**，整棵树里**没有** `<img>` / `<script>` / `<link>`
 *   ⑤ **观感**：无 background / box-shadow / border —— 不许出现"灰色颜色框"
 *
 * ## 为什么这些断言值得写（都是"能绿着错"的那种）
 *   · 常量写对了、但**没人把它挂进槽** —— 源码 grep 一样全绿 ⇒ 必须真的跑
 *     `apply()`，捕获注册**声明**（槽名/id/组件身份）。
 *   · `rel` 少一个 token（`noopener`）在肉眼与截图里**完全看不出来**，
 *     而 `target="_blank"` 会把 `window.opener` 交给外站 ⇒ 必须逐 token 断言。
 *   · background/box-shadow 是否真有，肉眼要"看"才知道 —— 上一版卡片钩子
 *     就是靠 `background: var(--dsw-alias-bg-layer-1)` + `box-shadow: 0 16px 0 …`
 *     拿到了一个"灰色颜色框"，被用户打回。⇒ 用机器**逐键**卡死。
 *
 * ## 为什么能在 `node --test` 里渲染 React 组件
 *   前端半运行时由宿主的 `window.__ModuleLoader__` 提供 `react`
 *   （见 `tsdown.config.ts` 的 `neverBundle`）—— 所以这个仓库**没有** react 依赖。
 *   本文件用 `module.registerHooks` 把 `'react'` 指到 `tests/doubles/react.ts`，
 *   于是不装任何重依赖也能把组件调一次、拿到它返回的元素树。
 *
 * ★ 替身的边界（见 `tests/doubles/react.ts` 文件头）：只渲染**首次静态结构**，
 *   不执行 `useEffect`、不重渲染。所以这里验证的是"钩子在不在、属性对不对"，
 *   **不是**"点它会不会开新标签页"，也**不是**"在真浏览器里长什么样"
 *   —— 后者只能在界面上看（见 README 的未验证项）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { PLUGIN_PACKAGE_NAME } from '../src/contracts/protocol.ts'

/** 替身模块的绝对 URL。 */
const REACT_DOUBLE_URL = pathToFileURL(path.join(import.meta.dirname, 'doubles', 'react.ts')).href

// ★ 只拦 `'react'` 这一个 specifier，其余一律交回默认解析 ——
//   替身越少越好：任何"顺手也替一下 three"的念头都会让这个测试开始验证不存在的东西。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: REACT_DOUBLE_URL, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

/**
 * ★ **必须 `await import`（不能在文件顶部 `import`）**：
 *   `star-hook.ts` 第一行就 `import { createElement } from 'react'`，
 *   而静态 import 的解析发生在**本模块体求值之前** —— 那时上面的
 *   `registerHooks` 还没执行，于是必然 `ERR_MODULE_NOT_FOUND: react`（实测踩到）。
 *   动态 import 在**调用时**才解析 ⇒ 替身已经就位。
 */
const hook = await import('../src/client/star-hook.ts')
const { GITHUB_MARK_ATTRS, GITHUB_MARK_PATH, GITHUB_MARK_SIZE, STAR_HINT_TEXT } = hook
const { STAR_LINK_ATTRS, STAR_LINK_STYLE, STAR_REPO_URL, STAR_ROW_STYLE } = hook

/** 替身 `createElement` 造出来的节点。 */
interface FakeElement {
  readonly type: unknown
  readonly props: Record<string, unknown>
  readonly children: readonly unknown[]
}

function isElement(node: unknown): node is FakeElement {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as { type?: unknown }).type !== 'undefined' &&
    Array.isArray((node as { children?: unknown }).children)
  )
}

/** 展开**函数组件**（替身刻意不自动渲染它们，只造元素）。 */
function expand(node: unknown): unknown {
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    return expand((node.type as (props: unknown) => unknown)(node.props))
  }
  return node
}

/** 收集一棵子树的全部元素节点。 */
function collect(node: unknown, out: FakeElement[] = []): FakeElement[] {
  if (!isElement(node)) return out
  out.push(node)
  for (const child of node.children) collect(child, out)
  return out
}

/** 收集一棵子树里的全部文本。 */
function textOf(node: unknown): string {
  if (typeof node === 'string') return node
  if (!isElement(node)) return ''
  return node.children.map(textOf).join('')
}

/** 本插件详情页的 subject（`kind: 'bundle'` + 本仓包名）。 */
const OWN_SUBJECT = { kind: 'bundle', pkg: { name: PLUGIN_PACKAGE_NAME, installed: true, enabled: true, rows: [] } }

/** 别的插件的详情页。 */
const OTHER_SUBJECT = { kind: 'bundle', pkg: { name: '@someone-else/dsh-other', installed: true, enabled: true, rows: [] } }

/** 官方 item 页（**没有包名**，只有 id）。 */
const ITEM_SUBJECT = { kind: 'item', id: 'official-thing' }

/** 本插件的某个 row 页（`pkg` 是它所属的 bundle —— 但不是"详情页本身"）。 */
const ROW_SUBJECT = {
  kind: 'row',
  pkg: { name: PLUGIN_PACKAGE_NAME, installed: true, enabled: true, rows: [] },
  row: { rowId: 'main', moduleName: './lib/index.js', enabled: true },
}

/** 样式对象里**禁用**的属性名子串（用户红线：不许出现色块/边框/阴影）。 */
const FORBIDDEN_STYLE_KEYS = ['background', 'boxshadow', 'border', 'outline'] as const

/**
 * "写了等于没写"的取值：显式声明**透明/无**是**好事**（挡住以后有人顺手加底色），
 * 而 `background: rgba(20,26,34,.72)` / `box-shadow: 0 16px 0 …` 才是那个"灰色框"。
 */
const TRANSPARENT_VALUES = ['transparent', 'none', '0', ''] as const

/** 递归收集一个样式对象里的全部 `[键, 值]`。 */
function styleEntries(style: unknown, out: [string, unknown][] = []): [string, unknown][] {
  if (style === null || typeof style !== 'object') return out
  for (const [key, value] of Object.entries(style as Record<string, unknown>)) {
    out.push([key, value])
    styleEntries(value, out)
  }
  return out
}

/**
 * 断言一个样式对象里**没有任何**会造成"色块/边框/阴影"的**实际绘制**。
 *
 * ★ 逐键 + 盯值：只禁用**会画东西**的那些（不透明的 background / 非 none 的
 *   border / 非 none 的 box-shadow）。`background: transparent` 明确保留。
 */
function assertNoChrome(style: unknown, where: string): void {
  for (const [key, value] of styleEntries(style)) {
    const normalized = key.toLowerCase().replace(/-/g, '')
    if (!FORBIDDEN_STYLE_KEYS.some((forbidden) => normalized.includes(forbidden))) continue

    const raw = String(value).trim().toLowerCase()
    assert.ok(
      TRANSPARENT_VALUES.includes(raw as (typeof TRANSPARENT_VALUES)[number]),
      `${where} 的 ${key} 会画出东西（用户红线：不许出现灰色框/边框/阴影），实际值：${String(value)}`,
    )
  }
}

test('事实层：包名一处定义、目标仓库、内联 mark、两个 rel token', () => {
  // ① 包名唯一出处 —— 与 package.json 必须逐字一致（改名时漏改前端半会在这里红）
  const pkg = JSON.parse(
    readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8'),
  ) as { name: string }
  assert.equal(PLUGIN_PACKAGE_NAME, pkg.name, 'protocol.ts 的 PLUGIN_PACKAGE_NAME 必须等于 package.json 的 name')

  // ② href 指向本仓（用户点名要的断言）
  assert.equal(STAR_REPO_URL, 'https://github.com/Noob-stupid/dsh-breadboard')
  assert.equal(STAR_LINK_ATTRS.href, STAR_REPO_URL, '<a> 必须指向本仓库')
  assert.equal(STAR_LINK_ATTRS.target, '_blank')

  // ③ rel 两个 token 都要有：`target="_blank"` 会把 window.opener 交给新页面。
  const tokens = String(STAR_LINK_ATTRS.rel).split(/\s+/)
  assert.ok(tokens.includes('noreferrer'), `rel 缺 noreferrer：${STAR_LINK_ATTRS.rel}`)
  assert.ok(tokens.includes('noopener'), `rel 缺 noopener：${STAR_LINK_ATTRS.rel}`)

  // ④ 内联 SVG（不是外链图片）：几何必须是真路径，占位串/空串会让图标不可见。
  assert.ok(GITHUB_MARK_PATH.startsWith('M'), 'GitHub mark 必须是真路径数据')
  assert.ok(GITHUB_MARK_PATH.length > 200, `mark 路径太短，像是占位：${GITHUB_MARK_PATH.length}`)
  assert.equal(GITHUB_MARK_ATTRS.viewBox, '0 0 16 16', 'Octicons 的 16×16 视图')
  assert.equal(GITHUB_MARK_ATTRS.fill, 'currentColor', '颜色要跟随文字，不能写死')
  assert.equal(GITHUB_MARK_SIZE, 16, '用户要求 16×16')

  // ⑤ 文案
  assert.ok(STAR_HINT_TEXT.includes('Star'), `文案要说明是点 Star：${STAR_HINT_TEXT}`)
})

test('★ 观感红线：容器与链接的样式里没有 background / box-shadow / border', () => {
  assertNoChrome(STAR_ROW_STYLE, 'STAR_ROW_STYLE')
  assertNoChrome(STAR_LINK_STYLE, 'STAR_LINK_STYLE')

  // 反过来确认这些"透明声明"真的在（不是靠"没写"侥幸过关）：
  // 写了 `background: transparent` 才算明确表态 —— 也挡住"以后有人顺手加底色"。
  assert.equal(STAR_LINK_STYLE.background, 'transparent')
  assert.equal(STAR_LINK_STYLE.border, 'none')
  assert.equal(STAR_LINK_STYLE.boxShadow, 'none')
})

test('★ 靠右且不遮内容：普通流里右对齐（不是 sticky / fixed 浮层）', () => {
  // `.detailSections` 是 column flex ⇒ alignSelf:flex-end 即"靠右"
  assert.equal(STAR_ROW_STYLE.alignSelf, 'flex-end')
  assert.equal(STAR_ROW_STYLE.justifyContent, 'flex-end')
  assert.equal(STAR_ROW_STYLE.maxWidth, '100%', '窄宽度不得溢出')
  assert.equal(STAR_ROW_STYLE.flexWrap, 'wrap', '窄到装不下时换行而不是撑宽页面')
  assert.equal(
    styleEntries(STAR_ROW_STYLE).filter(([key]) => key === 'position').length,
    0,
    '不得用 position:sticky/fixed —— sticky 必须配不透明背景才不糊住正文，那就又回到色块了',
  )
})

test('★ 条件渲染：本插件详情页才渲染；其它 subject 一律 null', async () => {
  const { StarRow } = await import('../src/client/star-hook.ts')

  // ① 别的插件的 bundle 页 ⇒ 不渲染
  assert.equal(StarRow({ subject: OTHER_SUBJECT }), null, '别的插件的详情页不得出现本插件的星')
  // ② 官方 item 页（没有 pkg）⇒ 不渲染
  assert.equal(StarRow({ subject: ITEM_SUBJECT }), null, '官方 item 页没有包名，不得渲染')
  // ③ 本插件的 row 页 ⇒ 不渲染（那是同一个包的另一页，不是详情页本身）
  assert.equal(StarRow({ subject: ROW_SUBJECT }), null, 'row 页不得渲染')
  // ④ subject 缺失 / 空对象 ⇒ 不渲染（不抛错）
  assert.equal(StarRow({}), null)
  assert.equal(StarRow({ subject: undefined }), null)
  assert.equal(StarRow({ subject: {} }), null)

  // ⑤ 本插件详情页 ⇒ 渲染
  const tree = StarRow({ subject: OWN_SUBJECT })
  assert.ok(isElement(tree), '本插件详情页必须渲染出元素')
})

test('★ 渲染结果：内联 svg、指向本仓的 <a>、全树无 img/script/link', async () => {
  const { StarRow } = await import('../src/client/star-hook.ts')

  const tree = StarRow({ subject: OWN_SUBJECT }) as unknown as FakeElement
  const nodes = collect(tree)

  // ① 链接就是本仓库（用户点名要的断言）
  const link = nodes.find((node) => node.type === 'a')
  assert.ok(link, '渲染结果里必须有 <a>')
  assert.equal(link.props.href, STAR_REPO_URL, `<a> 必须指向 ${STAR_REPO_URL}`)
  assert.equal(link.props.target, '_blank')
  assert.deepEqual(String(link.props.rel).split(/\s+/).sort(), ['noopener', 'noreferrer'])

  // ② 图标是内联 SVG，且路径与事实层逐字一致
  const svg = nodes.find((node) => node.type === 'svg')
  assert.ok(svg, 'GitHub mark 必须是内联 <svg>')
  assert.equal(svg.props.viewBox, GITHUB_MARK_ATTRS.viewBox)
  assert.equal(svg.props.fill, 'currentColor')
  const pathNode = collect(svg).find((node) => node.type === 'path')
  assert.ok(pathNode, '<svg> 里必须有 <path>')
  assert.equal(pathNode.props.d, GITHUB_MARK_PATH, 'mark 路径必须与事实层逐字一致')

  // ③ 整棵树里没有 img / script / link —— 不引外链图片、不引第三方脚本/样式
  for (const banned of ['img', 'script', 'link', 'iframe']) {
    assert.equal(
      nodes.some((node) => node.type === banned),
      false,
      `不得出现 <${banned}>：不引第三方图片/字体/脚本`,
    )
  }

  // ④ 全树只有**一个**外链，且就是本仓
  const externalUrls = nodes
    .flatMap((node) => [node.props.href, node.props.src])
    .filter((value): value is string => typeof value === 'string')
  assert.deepEqual(externalUrls, [STAR_REPO_URL], '钩子里只能有这一个外链')

  // ⑤ 文案在
  assert.ok(textOf(tree).includes(STAR_HINT_TEXT), `钩子文案缺失：${textOf(tree)}`)

  // ⑥ 渲染出来的元素树上也逐键复查一次"没有色块"（常量对了、渲染时被改掉也算错）
  assertNoChrome(tree.props.style, '渲染出的容器')
  assertNoChrome(link.props.style, '渲染出的 <a>')
})

test('★ 真的把它注册进了 plugins.detail.section（不只是常量写对了）', async () => {
  const { apply } = await import('../src/client/index.ts')

  interface Registration {
    readonly options: { name: string; id?: string; order?: number }
    readonly component: unknown
  }
  const injectedKeys: string[] = []
  const registrations: Registration[] = []

  const ctx = {
    slots: {
      inject(key: string, callback: () => unknown) {
        injectedKeys.push(key)
        callback()
        return () => undefined
      },
      register(options: Registration['options'], component: unknown) {
        registrations.push({ options, component })
        return () => undefined
      },
    },
    get() {
      return undefined
    },
    effect(callback: () => unknown) {
      callback()
      return () => undefined
    },
    logger: { info() {}, warn() {} },
  }

  apply(ctx as never)

  // ① 槽名必须正是官方详情页的 section 槽
  assert.ok(
    injectedKeys.includes('plugins.detail.section'),
    `必须 inject 'plugins.detail.section'，实际：${JSON.stringify(injectedKeys)}`,
  )

  const star = registrations.find((entry) => entry.options.name === 'plugins.detail.section')
  assert.ok(star, '必须向 plugins.detail.section 注册一个条目')
  assert.equal(star.options.id, 'breadboard-star', 'list 槽靠 id 寻址，id 必须稳定')
  assert.equal(typeof star.options.order, 'number')

  // ② 注册上去的**就是** star-hook 导出的那个组件（而不是碰巧某个函数）
  const { StarRow } = await import('../src/client/star-hook.ts')
  assert.equal(star.component, StarRow, '注册的组件必须是 StarRow 本体')

  // ③ 它对本插件详情页真的产出内容（注册 → 渲染这条链是通的）
  const rendered = expand(
    (star.component as (props: unknown) => unknown)({ subject: OWN_SUBJECT }),
  )
  assert.ok(isElement(rendered), '注册的组件在本插件详情页必须渲染出元素')
  assert.ok(
    collect(rendered).some((node) => node.type === 'a' && node.props.href === STAR_REPO_URL),
    '渲染结果里必须能走到指向本仓的 <a>',
  )

  // ④ 既有两处注册**没被动过**（本任务只做加法）
  assert.deepEqual(
    registrations.map((entry) => entry.options.name),
    ['sidebar.panellist', 'main', 'plugins.detail.section'],
    '注册顺序与集合必须只多出详情页那一项',
  )
})
