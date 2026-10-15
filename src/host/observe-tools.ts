/**
 * **真机观察工具**（P1）—— agent 能开始/停止观察真机，并看到它的状态。
 *
 * ★ 为什么要有工具而不只是界面：真机在环的**第一步是"能看到真机状态"**，
 *   而 agent 是最需要这个能力的一方（它要据此判断"现在到底连没连上真机"）。
 */

import type { AssemblyState } from '../core/state/assembly-state.ts'
import type { RealDeviceObserver } from '../core/sim/observer.ts'
import { zhizuoObserveConfig } from '../core/sim/zhizuo-observe.ts'
import { asRecord, text, type HardwareToolDefinition } from './tools.ts'

export interface ObserveToolDeps {
  readonly observer: RealDeviceObserver
  /**
   * 装配状态 —— 用来**校验器件真的存在**。
   *
   * ★ 为什么必须校验：观察一个不存在的 `componentId`（如打错的 `c99`）**不会报错**，
   *   只是"什么都不会发生" —— 用户以为在观察真机，其实挂在一个空 id 上。
   *   这类"静默无效"正是本项目最防的一种。
   */
  readonly state: AssemblyState
}

/** 观察状态 → 人话（★ `error` 与 `stale` **必须分开说**）。 */
function describeStatus(status: string): string {
  switch (status) {
    case 'ok':
      return '✅ 真机在线'
    case 'stale':
      return '⚠️ 真机离线（数据很旧）'
    case 'error':
      // ★★ 这句是这一层最重要的措辞：**查不到不等于设备离线**
      return '❌ 观察失败（我们查不到服务端 —— **不代表设备离线**，先查地址/鉴权）'
    case 'not_found':
      // ★ 与上面两种都不同：通路是好的，只是**没有这台设备**
      return '⚠️ 服务端里没有这台设备（deviceId 写错？或它还没上过线）'
    default:
      return '— 还没查到'
  }
}

export function createObserveTools(deps: ObserveToolDeps): HardwareToolDefinition[] {
  const { observer, state } = deps
  return [
    {
      name: 'hw_watch_device',
      description:
        '**观察一台真机**（真机在环的第一步）：定时**只读**查询外部系统，把真机状态映射到场景器件上。' +
        '★ 与 hw_network_add 的区别：那是**我们冒充设备**主动发请求（虚拟设备）；' +
        '这个是**我们去问**真实设备的状态（只读，无对外副作用）。' +
        '★ 智座：`source: "zhizuo"` 时读 `GET /api/admin/sensor/devices`（需要 admin 登录时的 Cookie，用 headers 传）。' +
        '⚠️⚠️ **绝不要用 `/api/sensor/device_config` 做观察** —— 那条路由会刷新 `last_seen`，' +
        '一查就让离线设备变在线，会得出完全错误的结论。' +
        '★★ **`error`（我们查不到）与 `stale`（真机确实离线）是两件事**，别混：' +
        '前者要查地址/鉴权，后者才是硬件不在线。' +
        '★ 轮询走**墙钟**（真机按真实时间走，不能加速），间隔下限 2 秒 —— 这是保护对方服务器的硬约束。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status'],
            description: 'start 开始观察 / stop 停止 / status 只看当前状态（不带参数默认 status）',
          },
          componentId: { type: 'string', description: '场景里的器件 id（如 c1）' },
          deviceId: { type: 'string', description: '真机标识（智座是 WiFi MAC，如 AA:BB:CC:11:22:33）' },
          endpoint: { type: 'string', description: '外部系统基址，如 http://127.0.0.1:5800' },
          source: { type: 'string', enum: ['zhizuo'], description: '协议/映射（目前只有 zhizuo）' },
          intervalMs: { type: 'number', description: '轮询间隔（墙钟毫秒，下限 2000）' },
          cookie: { type: 'string', description: '需要鉴权时带的 Cookie（智座 admin 接口需要）' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            // ★ 人话输出必须声明在 schema 里：宿主会按 schema 校验返回值，
            //   没声明的字段会让调用**整体失败**（实测踩过：返回 message 被拒）。
            message: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          // ★ 失败必须**看得见**：只渲染 message 的话，`ok:false` + `reason`
          //   会输出成**空字符串** —— 工具"什么都没说"，而调用方以为没结果。
          //   （实测踩过：观察一个不存在的器件 id，返回为空。）
          if (result.ok !== true) return text(`观察未开始：${String(result.reason ?? '未知原因')}`)
          return text(String(result.message ?? ''))
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const action = typeof input.action === 'string' ? input.action : 'status'

        if (action === 'stop') {
          const componentId = typeof input.componentId === 'string' ? input.componentId : ''
          if (componentId === '') return { ok: false, reason: '缺少 componentId' }
          const stopped = observer.stop(componentId)
          return { ok: true, message: stopped ? `已停止观察 ${componentId}` : `${componentId} 本来就没在观察` }
        }

        if (action === 'status') {
          const entries = observer.list()
          if (entries.length === 0) {
            return { ok: true, message: '当前没有在观察任何真机。用 action:"start" 开始。' }
          }
          const lines = entries.map((entry) => {
            const device = entry.device
            const readings = Object.entries(device.readings)
              .map(([key, value]) => `${key}=${value ? '遮挡' : '无人'}`)
              .join(' ')
            return (
              `· ${device.componentId}（${device.deviceId}）${describeStatus(device.status)}\n` +
              `    轮询 ${String(entry.polls)} 次，失败 ${String(entry.failures)} 次` +
              (device.dataAgeSec === undefined ? '' : `，数据年龄 ${String(Math.round(device.dataAgeSec))} 秒`) +
              (readings === '' ? '' : `\n    读数：${readings}`) +
              (device.detail === undefined ? '' : `\n    ${device.detail}`)
            )
          })
          return { ok: true, message: lines.join('\n') }
        }

        const componentId = typeof input.componentId === 'string' ? input.componentId : ''
        const deviceId = typeof input.deviceId === 'string' ? input.deviceId : ''
        const endpoint = typeof input.endpoint === 'string' ? input.endpoint : ''
        if (componentId === '' || deviceId === '' || endpoint === '') {
          return { ok: false, reason: 'start 需要 componentId / deviceId / endpoint' }
        }
        const intervalMs = typeof input.intervalMs === 'number' ? input.intervalMs : 5000
        const cookie = typeof input.cookie === 'string' && input.cookie !== '' ? input.cookie : undefined
        // ★ 先校验器件真的存在：观察一个**打错的 id 不会报错**，只会静默无效 ——
        //   用户以为在观察真机，其实挂在一个空 id 上。这类"静默无效"必须拦。
        const components = state.snapshot().components.map((component) => component.id)
        if (!components.includes(componentId)) {
          return {
            ok: false,
            reason: `场景里没有器件 ${componentId}（现有：${components.join(', ') === '' ? '空' : components.join(', ')}）`,
          }
        }
        const actual = observer.start(
          zhizuoObserveConfig({
            componentId,
            deviceId,
            endpoint,
            intervalMs,
            ...(cookie !== undefined ? { headers: { cookie } } : {}),
          }),
        )
        return {
          ok: true,
          message:
            `已开始观察 ${componentId} ← ${endpoint}（每 ${String(actual / 1000)} 秒，墙钟）。\n` +
            '★ 记住：**观察失败 ≠ 设备离线** —— 用 hw_watch_device({action:"status"}) 看是哪一种。',
        }
      },
    },
  ]
}
