/**
 * `react` 的**测试替身**（不是实现，也不进包）。
 *
 * ## 为什么需要它
 *   `src/client/**`（浏览器半）跑的宿主是 React，而本仓库**不装 react**：
 *   它由宿主运行时的 `window.__ModuleLoader__` 提供（见 `docs/00` §2.3 的外部化白名单），
 *   所以 `node --test` 里 `import 'react'` 必然 `ERR_MODULE_NOT_FOUND`。
 *
 *   两条路：① 装一个真 react 当 devDependency；② 给一个**只够渲染函数组件**的替身。
 *   选 ②：本仓库的测试基线是"零重依赖、`npm test` 直接跑"，
 *   而我们要断言的只是"子树里有没有那个 `<a>`、它的属性对不对" ——
 *   **不需要 Fiber、不需要 DOM、不需要并发渲染**。
 *
 * ★ 替身的边界必须说清（否则它比没有更危险）：
 *   · `useState` **永不重渲染**、`useEffect` **永不执行**、`useCallback` 直接返回原函数。
 *   ⇒ 它验证的是**首次渲染的静态结构**，验证不了任何交互/副作用。
 *     需要交互的断言得放到浏览器里做，别指望这里。
 *   · 它**不校验 props 合法性**（真 React 会警告未知属性），所以这里全绿 ≠ 真 React 不报警。
 */
export function createElement(type, props, ...children) {
  const normalized =
    children.length === 0 ? undefined : children.length === 1 ? children[0] : children
  return {
    type,
    props: { ...(props ?? {}), children: normalized },
    /** 拍平后的子节点数组 —— 测试靠它做树遍历（React 元素本身没有这个字段）。 */
    children,
  }
}

export function useRef(initial) {
  return { current: initial }
}

export function useState(initial) {
  return [initial, () => undefined]
}

export function useEffect() {
  /* 刻意不执行：见文件头边界说明 */
}

export function useCallback(fn) {
  return fn
}
