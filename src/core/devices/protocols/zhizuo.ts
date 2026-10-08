/**
 * 智座座位传感器协议适配器
 * @module dsh-hardware-sandbox/core/devices/protocols/zhizuo
 *
 * 对应项目：`D:\MAX_xiangmu`（Flask + SocketIO 的「智能选座与导航一体化系统」）。
 * 真机是「每个座位一个 ESP32 + 双红外」，按周期把读数 HTTP 上报。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 本文件里的每一条约定都是**从 app.py 读出来的**，不是推测的
 * ══════════════════════════════════════════════════════════════════════════
 *
 * | 约定 | 出处 |
 * |---|---|
 * | 统一信封 `{code, message, data}` | `api_response()`（app.py:270） |
 * | **HTTP 状态码 == `code`** | `return jsonify({...}), code` —— 所以 4xx 会真的抛 |
 * | 注册：`POST /api/sensor/device/register {device_id}` | app.py:3966 |
 * | 拉配置：`GET /api/sensor/device_config?device_id=` | app.py:3989 |
 * | 上报：`POST /api/sensor/report {seat_id, ir_front, ir_back}` | app.py:2075 |
 * | 上报返回**状态机的答复** `{seat_id, status, consecutive_empty}` | app.py:2185 |
 * | 配置字段：`ir_active_high` / `report_interval_ms` / `sensor_type` / `seat_id` … | `_device_config_payload()`（app.py:3950） |
 *
 * ── 两个**不报错但会做错**的地方（都编码在这里） ──
 *
 * ① **上报必须带 `device_id`，否则设备在线心跳不刷新。**
 *    app.py:2174 原文：`dev_id = data.get('device_id'); if dev_id: sdev.last_seen = now`。
 *    不带的话，设备**看起来**一直在上报，但面板上会显示"离线" ——
 *    因为在线判定读的是 `last_seen`。这是一个纯粹的静默失败。
 *
 * ② **`ir_active_high` 决定"遮挡时读到 1 还是 0"。**
 *    我们模拟的是**物理遮挡**，翻译成原始电平是**协议侧**的责任。
 *    搞反的症状是"**人坐下反而释放**"，且不报任何错。
 *
 * ── 状态机的一个关键行为（影响场景怎么写） ──
 *
 * 释放需要**连续 2 次空**（app.py:2144 `consecutive_empty >= 2`）。
 * ⇒ 只报一次空**不会**释放。这不是 bug，是真机行为，工具与文档必须如实说明。
 */
import type {
  JsonRecord,
  JsonScalar,
  NetworkCallContext,
  NetworkCallOutcome,
  NetworkProtocolAdapter,
  NetworkResponse,
} from '../../../contracts/network.ts'

export const ZHIZUO_PROTOCOL_ID = 'zhizuo-sensor'

/** 配置缺失时的上报间隔（毫秒）。与智座 `SensorDevice.report_interval_ms` 默认值一致。 */
const DEFAULT_INTERVAL_MS = 5000

/**
 * 把任意 JSON 值收成**扁平标量记录**。
 *
 * ★ 嵌套对象与数组**直接丢弃**，而不是 `String()` 一下塞进去 ——
 *   那会把 `{a:{b:1}}` 变成 `"[object Object]"`，看着有值、实际是垃圾。
 *   （与 `contracts/network.ts` 里"不猜嵌套结构"是同一条纪律。）
 */
function toRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, JsonScalar> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (item === null || typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      out[key] = item
    }
  }
  return out
}

/**
 * 内部：**未摊平**的信封解读结果。
 *
 * ★★ 为什么必须与对外的 `NetworkCallOutcome` 分开（这是实测踩出来的）：
 *   智座的 `data` 是**嵌套**的 —— 注册返回 `{registered, is_new, config:{…}}`，
 *   而设备真正要的 `config` 在**里面一层**。
 *   若在解读信封时就把 `data` 摊平成标量，`config` 这个**对象**会被直接丢掉，
 *   于是 `data['config']` 永远是 `undefined`，配置**永远拿不到** ——
 *   而表面上 `ok:true`、没有任何报错。典型的「看起来正常、实际全错」。
 *
 * ⇒ 信封解读保留**原始** `data`；由各适配器方法自己决定要哪一层、怎么摊平。
 */
interface RawOutcome {
  readonly ok: boolean
  readonly data: unknown
  readonly status: number
  readonly message?: string
}

/**
 * 解读统一信封（**保留原始 data**）。
 *
 * ★ 两层都要判：**HTTP 状态码**与**信封里的 `code`**。
 *   智座把两者设成同一个值，但**不能假设它们永远一致** ——
 *   代理、网关、或未来某次重构都可能只改一个。
 *   只看一层的话，另一层出错时我们会把它当成功。
 */
function unwrap(response: NetworkResponse): RawOutcome {
  const body = response.body
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      ok: false,
      data: undefined,
      status: response.status,
      message: `响应不是 {code,message,data} 信封（HTTP ${String(response.status)}）：${(response.text ?? '').slice(0, 200)}`,
    }
  }
  const envelope = body as Record<string, unknown>
  const code = typeof envelope['code'] === 'number' ? envelope['code'] : response.status
  const message = typeof envelope['message'] === 'string' ? envelope['message'] : undefined

  const httpOk = response.status >= 200 && response.status < 300
  const codeOk = code >= 200 && code < 300
  if (!httpOk || !codeOk) {
    return {
      ok: false,
      data: envelope['data'],
      status: response.status,
      message: message ?? `HTTP ${String(response.status)} / code ${String(code)}`,
    }
  }
  return {
    ok: true,
    data: envelope['data'],
    status: response.status,
    ...(message !== undefined ? { message } : {}),
  }
}

/** 从原始 `data` 里取某个**对象**字段并摊平（如 `config`）。 */
function nestedRecord(data: unknown, key: string): JsonRecord {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return {}
  return toRecord((data as Record<string, unknown>)[key])
}

/** 把网络层异常收成人话 —— 不让 `fetch failed` 这种话直接冒到用户面前。 */
function describeError(error: unknown, url: string): string {
  const raw = error instanceof Error ? error.message : String(error)
  return `请求 ${url} 失败：${raw}`
}

async function call(
  ctx: NetworkCallContext,
  url: string,
  init: { method: 'GET' | 'POST'; body?: JsonRecord },
): Promise<RawOutcome> {
  try {
    const response = await ctx.transport(
      {
        method: init.method,
        url,
        ...(init.body !== undefined ? { body: init.body } : {}),
        headers: { 'content-type': 'application/json' },
      },
      ctx.signal,
    )
    return unwrap(response)
  } catch (error) {
    return { ok: false, data: undefined, status: 0, message: describeError(error, url) }
  }
}

export const zhizuoSensorAdapter: NetworkProtocolAdapter = {
  id: ZHIZUO_PROTOCOL_ID,
  description:
    '智座（智能选座系统）的座位传感器设备：开机注册 → 拉配置 → 周期上报双红外读数。' +
    '释放需要连续 2 次"无人"上报（真机行为）。',
  readingKeys: ['ir_front', 'ir_back'],

  async register(ctx: NetworkCallContext): Promise<NetworkCallOutcome> {
    const raw = await call(ctx, `${ctx.endpoint}/api/sensor/device/register`, {
      method: 'POST',
      body: { device_id: ctx.deviceId },
    })
    if (!raw.ok) {
      return { ok: false, ...(raw.message !== undefined ? { message: raw.message } : {}) }
    }
    // ★ data = {registered, is_new, config:{…}} —— 设备真正要的是**里面那层** config
    return {
      ok: true,
      data: nestedRecord(raw.data, 'config'),
      ...(raw.message !== undefined ? { message: raw.message } : {}),
    }
  },

  async pullConfig(ctx: NetworkCallContext): Promise<NetworkCallOutcome> {
    const url = `${ctx.endpoint}/api/sensor/device_config?device_id=${encodeURIComponent(ctx.deviceId)}`
    const raw = await call(ctx, url, { method: 'GET' })
    if (!raw.ok) {
      return { ok: false, ...(raw.message !== undefined ? { message: raw.message } : {}) }
    }

    // ★ `registered:false` 是**明确状态**，不是"配置为空"。
    //   真机此时应回到注册流程 —— 所以用 needsRegister 把它变成**可执行信号**，
    //   而不是让调用方去猜 message 的措辞。
    if (toRecord(raw.data)['registered'] === false) {
      return {
        ok: false,
        needsRegister: true,
        message: '外部系统不认识这台设备（registered=false）—— 需要重新注册',
      }
    }
    return {
      ok: true,
      data: nestedRecord(raw.data, 'config'),
      ...(raw.message !== undefined ? { message: raw.message } : {}),
    }
  },

  async report(ctx: NetworkCallContext, reading: JsonRecord): Promise<NetworkCallOutcome> {
    // ★★ **配置优先**：座位绑定是服务端说的（管理员在面板上设）。
    //    只看 options 的后果很具体：面板上改了绑定，设备仍往**旧座位**上报，**且不报错**。
    //    options 只是"配置还没到手"时的兜底初值。
    const seatId = ctx.config?.['seat_id'] ?? ctx.options['seat_id']
    if (typeof seatId !== 'number') {
      return {
        ok: false,
        message:
          '这台设备还没有绑定座位（服务端配置与 options 里都没有 seat_id）—— ' +
          '真机此时也不知道自己在哪，请在智座面板上给它绑定座位',
      }
    }

    const url = `${ctx.endpoint}/api/sensor/report`
    const raw = await call(ctx, url, {
      method: 'POST',
      body: {
        seat_id: seatId,
        ir_front: reading['ir_front'] ?? 0,
        ir_back: reading['ir_back'] ?? 0,
        // ★★ 必须带！否则 `last_seen` 不刷新，设备"一直在上报"却显示"离线"。
        //    见文件头 ①。这是纯静默失败，所以这里写死并加注释。
        device_id: ctx.deviceId,
      },
    })
    if (!raw.ok) {
      return { ok: false, ...(raw.message !== undefined ? { message: raw.message } : {}) }
    }
    // data = {seat_id, status, consecutive_empty} —— 状态机的答复，本身就是扁平标量
    return {
      ok: true,
      data: toRecord(raw.data),
      ...(raw.message !== undefined ? { message: raw.message } : {}),
    }
  },

  intervalMs(config: JsonRecord | undefined): number {
    const raw = config?.['report_interval_ms']
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_INTERVAL_MS
    // 下限 50ms：防止服务端下发一个 0 把对方打爆（也保护我们自己）
    return Math.max(50, raw)
  },

  translate(config: JsonRecord | undefined, reading: JsonRecord): JsonRecord {
    // ★ `ir_active_high` 缺省为 true（与智座 `SensorDevice.ir_active_high` 默认一致）。
    const activeHigh = config?.['ir_active_high'] !== false
    const toRaw = (blocked: boolean): number => (activeHigh ? (blocked ? 1 : 0) : blocked ? 0 : 1)

    const out: Record<string, JsonScalar> = {}
    for (const [key, value] of Object.entries(reading)) {
      // 只对**布尔**读数做极性翻译：`true` = 物理遮挡。
      // 数字读数（如超声波的距离厘米）是**物理量**，不该被极性翻转。
      out[key] = typeof value === 'boolean' ? toRaw(value) : value
    }
    return out
  },
}
