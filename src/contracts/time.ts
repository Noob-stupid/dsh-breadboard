/**
 * 虚拟时间原语 —— 冻结契约（owner: session-24ca6e69）
 * @module dsh-hardware-sandbox/contracts/time
 *
 * ★ 设计要点：虚拟时间的**权威表示是整数微秒**（{@link Micros}），浮点秒只是便利视图。
 *
 * 为什么不用浮点秒做权威：
 *   `0.001` 在二进制浮点里不可精确表示。`advance(1.0)` 在 step=1ms 下要累加 1000 次，
 *   累加结果不是 1.0（实测约 1.0000000000000007）。这类残差会随仿真时长累积，
 *   最终让「确定性读数」在某个时刻多跳一格 —— 而 P3/T1 要求的正是**逐次确定**。
 *   用整数微秒后，累加是精确整数运算，残差恒为 0。
 */

/** 整数微秒。虚拟时间的唯一权威单位。 */
export type Micros = number

/** 1 秒 = 1_000_000 微秒。 */
export const MICROS_PER_SECOND = 1_000_000 as const

/** 秒 → 整数微秒（四舍五入，消除二进制浮点表示误差）。 */
export function secondsToMicros(seconds: number): Micros {
  return Math.round(seconds * MICROS_PER_SECOND)
}

/** 整数微秒 → 秒（仅用于对外展示与场景插值，不参与累加）。 */
export function microsToSeconds(micros: Micros): number {
  return micros / MICROS_PER_SECOND
}

/**
 * 一个时间片的上下文，随每次 `tick` 传给设备。
 *
 * 设备应当**优先使用整数微秒字段**（`nowMicros` / `deltaMicros`）做周期性判断，
 * 浮点字段仅供直接计算物理量（如 `temp += rate * ctx.delta`）。
 */
export interface TickContext {
  /** 本片时长（秒）。 */
  readonly delta: number
  /** 本片结束时的虚拟时刻（秒）。 */
  readonly now: number
  /** 本片时长（整数微秒）—— 权威值。 */
  readonly deltaMicros: Micros
  /** 本片结束时的虚拟时刻（整数微秒）—— 权威值。 */
  readonly nowMicros: Micros
  /** 本片在本次 advance 内的序号，自 0 起。 */
  readonly slice: number
  /** 本次 advance 的序号，自 1 起。用于设备区分「同一次推进」与「跨次推进」。 */
  readonly advanceId: number
}
