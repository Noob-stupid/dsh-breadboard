/**
 * 本插件用到的最小 `slots` 服务面（**结构化类型**）。
 *
 * 为什么不 `import type { SlotsService } from '@deepseek-ai/dsh-client-ui-slots'`：
 *   该包只在前端运行时由 ModuleLoader 提供，**没有**被 scripts/build.sh 链接进 node_modules，
 *   直接 import 会让 tsc 解析失败。这里按实时 slot 树核实到的契约做结构化声明，
 *   运行时形状一致，且让前端半可独立编译。
 *
 * 契约来源：client `Service:slots` 实时自省（2026-10-07）。
 */

/** `slots.register(options, component)` 的 options。keyed 槽用 `key`；list 槽用 `id`。 */
export interface SlotRegistrationOptions {
  /** **必填**：slot 名（如 `'main'` / `'sidebar.panellist'`）。缺它报 "slot undefined is not declared"。 */
  name: string
  /** keyed 槽的 cell key。 */
  key?: string
  /** list 槽的 cell id。 */
  id?: string
  /** list 槽排序，升序。 */
  order?: number
  /** 显示文本；thunk 会在每次投影时重读（便于跟随 locale）。 */
  label?: string | (() => string)
  /** 同槽内的优先级。 */
  priority?: number
  /**
   * 注入面：返回值会作为 **props** 传给组件（`ComposedProps` 里的 `InjectFace`）。
   *
   * 用它把 `ctx` 上的服务带进根作用域组件 —— 根作用域组件拿不到 session 类的标准 props。
   */
  inject?: (...args: never[]) => Record<string, unknown>
}

/** 组件契约：**React 函数组件**。`SlotComponent<P> = (props: P) => ReactNode`。 */
export type SlotComponent<P> = (props: P) => unknown

export interface SlotsService {
  // 组件参数用 `any`：真实的 typed face 是 `SlotComponent<never>` 参与交叉类型，
  // 在 strictFunctionTypes 下无法把带具体 props 的组件赋给 `(props: never) => unknown`。
  // 这里只求「形状对得上、能独立编译」，不复制宿主的类型体操。
  register(options: SlotRegistrationOptions, component: SlotComponent<any>): () => void
  /**
   * 等待某个 slot 被声明后安装贡献；返回幂等卸载函数。
   * callback 返回 disposer 或 disposer 的可迭代集合。
   */
  inject(
    key: string,
    callback: () => (() => void) | Iterable<() => void>,
  ): () => void
}

/**
 * 客户端 `sessions` 服务面（结构化）。
 *
 * ★ 契约来源：`packages/client/ui-slots/src/renderer.ts:62` 的 `SessionMaybeProvideInfo`
 *   与 client `Service:sessions` 的引用类型 `ISession` / `SessionBinding`（源码级）。
 *
 * ⚠️ `currentProvideInfo` 是**属性**不是方法 —— 运行时服务目录（只枚举方法）里看不到它。
 *   **目录 ≠ 能力全集**：判"有没有"要看契约与源码。
 */
export interface SessionsFace {
  /** 当前会话的原子投影。`sessionId` 在无会话模式下为 `undefined`。 */
  readonly currentProvideInfo: {
    getSnapshot(): { readonly sessionId?: string }
    subscribe(fn: () => void): () => void
  }
  /** 借用一个**已被 retain** 的会话绑定；未 retain 时返回 `undefined`。 */
  binding(id: string):
    | {
        readonly sessionId: string
        readonly session?: {
          prompt?(
            content: readonly { readonly type: 'text'; readonly text: string }[],
            mode: 'queue' | 'steer',
          ): Promise<unknown>
        }
      }
    | undefined
}

/** 前端半的 Cordis 上下文面（只声明本插件用到的部分）。 */
export interface ClientContext {
  slots: SlotsService
  /**
   * 可选服务获取（带 undefined 检查）。
   *
   * ★ 用它取 `'sessions'` 而**不**放进硬 `inject`：硬注入一旦该服务缺失，
   *   **整个面板都挂不上**；可选获取则退化为"对话不可用"，场景照常工作。
   */
  get(name: string): unknown
  effect(callback: () => void | (() => void), label?: string): () => void
  logger?: {
    info?(message: string): void
    warn?(message: string): void
  }
}
