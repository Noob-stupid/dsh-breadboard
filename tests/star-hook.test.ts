/**
 * Star 钩子测试（2026-10-12 加）。
 *
 * 用户要求：「**面板渲染后右下角钩子存在且 href 指向本仓**」。
 * 这条断言必须**真的渲染一次面板**才作数 —— 只 grep 源码里的 URL 是自欺：
 * 常量写对了、但没人把它挂进面板，源码 grep 一样全绿。
 *
 * ## 为什么能在 `node --test` 里渲染一个 React 组件
 *   `src/client/**` 是浏览器半，运行时由宿主的 `window.__ModuleLoader__` 提供 `react`
 *   （见 `docs/00` §2.3）——所以这个仓库**没有** react 依赖。
 *   本文件用 `module.registerHooks` 把 `'react'` 指到 `tests/doubles/react.ts`（自带的替身），
 *   于是**不装任何重依赖**也能把 `HardwareSandboxPanel()` 调一次、拿到它返回的元素树。
 *
 * ★ 替身的边界（见 `tests/doubles/react.ts` 文件头）：只渲染**首次静态结构**，
 *   不执行 `useEffect`、不重渲染。所以这里验证的是"钩子在不在、属性对不对"，
 *   **不是**"点它会不会开新标签页" —— 后者只能在真浏览器里看（见 README 的未验证项）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  GITHUB_MARK_ATTRS,
  GITHUB_MARK_PATH,
  STAR_FOOT_STYLE,
  STAR_HINT_TEXT,
  STAR_LINK_ATTRS,
  STAR_REPO_URL,
} from '../src/client/star-hook.ts'

/** 替身模块的绝对 URL（与 `tests/doubles/react.ts` 同一个文件）。 */
const REACT_DOUBLE_URL = pathToFileURL(path.join(import.meta.dirname, 'doubles', 'react.ts')).href

// ★ 只拦 `'react'` 这一个 specifier，其余一律交回默认解析 ——
//   替身越少越好：任何"顺手也替一下 three"的念头都会让这个测试开始验证不存在的东西。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'react') return { url: REACT_DOUBLE_URL, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

/** 替身 `createElement` 造出来的节点（React 元素的结构等价物）。 */
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

/**
 * 展开**函数组件**（替身刻意不自动渲染它们，只造元素）。
 *
 * ★ 只展开被指向的那一个：替身不实现 Fiber，递归展开整棵 HUD 树既没必要，
 *   也会把这个测试和一堆与 Star 钩子无关的组件绑在一起。
 */
function expand(node: unknown): unknown {
  if (!isElement(node)) return node
  if (typeof node.type === 'function') {
    return expand((node.type as (props: unknown) => unknown)(node.props))
  }
  return node
}

/** 收集一棵子树的全部节点。 */
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

const isRepoLink = (el: FakeElement): boolean =>
  el.type === 'a' && (el.props as { href?: unknown }).href === STAR_REPO_URL

test('Star 钩子的事实层：目标仓库、内联 mark、两个 rel token', () => {
  assert.equal(STAR_REPO_URL, 'https://github.com/Noob-stupid/dsh-breadboard')
  assert.equal(STAR_LINK_ATTRS.href, STAR_REPO_URL, '<a> 必须指向本仓库')
  assert.equal(STAR_LINK_ATTRS.target, '_blank')

  // ★ rel 两个 token 都要有：`target="_blank"` 会把 window.opener 交给新页面。
  const tokens = STAR_LINK_ATTRS.rel.split(/\s+/)
  assert.ok(tokens.includes('noreferrer'), `rel 缺 noreferrer：${STAR_LINK_ATTRS.rel}`)
  assert.ok(tokens.includes('noopener'), `rel 缺 noopener：${STAR_LINK_ATTRS.rel}`)

  // ★ 内联 SVG（不是外链图片）：几何必须是真路径，占位串/空串会让图标不可见。
  assert.ok(GITHUB_MARK_PATH.startsWith('M'), 'GitHub mark 必须是真路径数据')
  assert.ok(GITHUB_MARK_PATH.length > 200, `mark 路径太短，像是占位：${GITHUB_MARK_PATH.length}`)
  assert.equal(GITHUB_MARK_ATTRS.viewBox, '0 0 16 16', 'Octicons 的 16×16 视图')
  assert.equal(GITHUB_MARK_ATTRS.fill, 'currentColor', '颜色要跟随文字，不能写死')

  assert.ok(STAR_HINT_TEXT.includes('Star'), `文案要说明是点 Star：${STAR_HINT_TEXT}`)
})

test('★ 面板渲染后：右下角存在钩子，且 href 指向本仓', async () => {
  const { HardwareSandboxPanel, StarFoot } = await import('../src/client/panel.ts')

  const root = HardwareSandboxPanel({}) as unknown as FakeElement
  assert.equal(root.type, 'div', '面板根必须是 div')

  // ① 面板真的把它渲染出来了：**根节点最后一个子项就是 Star 钩子组件**
  //    （顺带证明"只在末尾追加" —— 既有子项一个没动、顺序没变）
  const appended = root.children[root.children.length - 1]
  assert.ok(isElement(appended), '面板根最后一项必须是元素')
  assert.equal(appended.type, StarFoot, '面板必须把 Star 钩子作为最后一个子项渲染')

  // ② 展开它，拿到真正落到 DOM 的那棵树
  const foot = expand(appended) as FakeElement
  assert.ok(isElement(foot), 'StarFoot 必须渲染出一个元素')

  // ③ 它在**右下角**：绝对定位 + 贴右边 + 贴下边
  const footStyle = foot.props.style as Record<string, unknown>
  assert.equal(footStyle.position, 'absolute')
  assert.equal(footStyle.right, STAR_FOOT_STYLE.right)
  assert.equal(typeof footStyle.bottom, 'string', '必须显式贴下边，否则不是"右下角"')
  assert.equal(Number.parseInt(String(footStyle.bottom), 10) > 0, true)
  assert.equal(
    footStyle.maxWidth,
    'calc(100% - 24px)',
    '窄容器不溢出：容器宽度必须跟着面板走（上限 = 面板宽度 − 左右各 12px）',
  )

  // ④ 链接就是本仓库（这条是用户点名要的断言）
  const nodes = collect(foot)
  const link = nodes.find(isRepoLink)
  assert.ok(link, `面板渲染结果里没有指向 ${STAR_REPO_URL} 的 <a>`)
  assert.equal(link.props.target, '_blank')
  assert.deepEqual(String(link.props.rel).split(/\s+/).sort(), ['noopener', 'noreferrer'])

  // ⑤ 图标是**内联 SVG**：整条链路上不得出现 <img>，也不得有第二个外链
  assert.equal(nodes.some((node) => node.type === 'img'), false, '不引外链图片')
  const svg = nodes.find((node) => node.type === 'svg')
  assert.ok(svg, 'GitHub mark 必须是内联 <svg>')
  const pathNode = collect(svg).find((node) => node.type === 'path') as FakeElement | undefined
  assert.ok(pathNode, '<svg> 里必须有 <path>')
  assert.equal(pathNode.props.d, GITHUB_MARK_PATH, 'mark 路径必须与事实层逐字一致')
  const externalUrls = nodes
    .flatMap((node) => [node.props.href, node.props.src])
    .filter((value): value is string => typeof value === 'string')
  assert.deepEqual(externalUrls, [STAR_REPO_URL], '钩子里只能有这一个外链')

  // ⑥ 文案在
  assert.ok(textOf(foot).includes(STAR_HINT_TEXT), `钩子文案缺失：${textOf(foot)}`)
})
