/**
 * **智座的真机观察适配器**（P1 的第一个具体实现）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 两个数据来源，分别给什么（实测确认，见 `D:\MAX_xiangmu`）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 来源 | 给什么 | 注意 |
 * |---|---|---|
 * | `GET /api/admin/sensor/devices` | **设备存活**：`device_id` / `last_seen_age_sec` / `online` / 绑定座位 | 需要 admin 登录（Cookie）|
 * | `seats` 表 / 座位形状的载荷 | **读数**：`ir_front` / `ir_back` / `status` | 智座的**读数存在座位上**，不在设备上 |
 *
 * ⚠️⚠️ **绝不能用 `GET /api/sensor/device_config` 做观察** ——
 *   那条路由**会把 `last_seen` 刷新成当前时间**（它本来是给设备拉配置用的）。
 *   ⇒ 用它做观察 = **我们一查，离线设备就变在线**，
 *     得出"设备在线"的结论而设备根本没插电 —— 典型的"看起来对实际全错"。
 *   ★ 这条实测于 `app.py`（该 handler 里确实有 `dev.last_seen = datetime.utcnow()`）。
 */

import type { ObserveConfig, ObserveMapping } from '../../contracts/observe.ts'

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 从载荷里把"设备列表"取出来（兼容 `{devices:[...]}` 与裸数组）。 */
function deviceList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter((r): r is Record<string, unknown> => r !== undefined)
  const record = asRecord(payload)
  if (record === undefined) return []
  const list = record.devices ?? record.seats ?? record.items
  if (Array.isArray(list)) return list.map(asRecord).filter((r): r is Record<string, unknown> => r !== undefined)
  return []
}

/** 智座设备标识的字段名（admin API 用 `device_id`，兼容几种写法）。 */
function deviceIdOf(record: Record<string, unknown>): string | undefined {
  for (const key of ['device_id', 'deviceId', 'mac', 'id']) {
    const value = record[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/**
 * **智座映射**。
 *
 * ★ `pick` 的三种结果语义不同，必须分清（这是本层最容易搞错的地方）：
 *   · 找到设备 → 正常；
 *   · 列表非空但**没有这台** → "服务端没见过它"（不是错误）；
 *   · 列表为空 → 同上（服务端里一台都没有）。
 */
export const ZHIZUO_OBSERVE_MAPPING: ObserveMapping = {
  pick: (payload, deviceId) => {
    const list = deviceList(payload)
    return list.find((record) => deviceIdOf(record) === deviceId)
  },
  ageSec: (record) => {
    const r = asRecord(record)
    if (r === undefined) return undefined
    // 服务端直接给了"最后见到是多久前"就用它（最准，且省去时钟漂移问题）
    const age = num(r.last_seen_age_sec) ?? num(r.age_sec)
    if (age !== undefined) return age
    // 否则用 last_seen 时间戳自己算
    const lastSeen = r.last_seen
    if (typeof lastSeen === 'string') {
      const parsed = Date.parse(lastSeen.endsWith('Z') ? lastSeen : `${lastSeen}Z`)
      if (Number.isFinite(parsed)) return Math.max(0, (Date.now() - parsed) / 1000)
    }
    return undefined
  },
  readings: (record) => {
    const r = asRecord(record)
    if (r === undefined) return {}
    const out: Record<string, boolean> = {}
    // ★ 智座的读数存在**座位**上（`ir_front` / `ir_back`），设备表里没有。
    //   两个形状都收：给什么读什么，读不到就是空（**不编**）。
    for (const key of ['ir_front', 'ir_back']) {
      const value = r[key]
      if (typeof value === 'boolean') out[key] = value
      else if (typeof value === 'number') out[key] = value !== 0
    }
    return out
  },
}

/** 组一份智座观察配置（把散落的字段约定收在一处，调用方不必记）。 */
export function zhizuoObserveConfig(input: {
  readonly componentId: string
  readonly deviceId: string
  readonly endpoint: string
  readonly intervalMs: number
  /** 服务端给的在线超时（秒）；取不到时用 180（智座默认 3 分钟）。 */
  readonly staleAfterSec?: number
  readonly headers?: Readonly<Record<string, string>>
}): ObserveConfig {
  const base = input.endpoint.replace(/\/+$/, '')
  return {
    componentId: input.componentId,
    deviceId: input.deviceId,
    // ★ 用 admin 设备表（**只读**），不用 device_config（那条会刷 last_seen，见文件头）
    url: `${base}/api/admin/sensor/devices`,
    intervalMs: input.intervalMs,
    staleAfterSec: input.staleAfterSec ?? 180,
    ...(input.headers !== undefined ? { headers: input.headers } : {}),
    mapping: ZHIZUO_OBSERVE_MAPPING,
  }
}
