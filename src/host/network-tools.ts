/**
 * 联网设备工具 —— 把第二类虚拟硬件暴露给 DS（设计文档 §5.4 / §10 薄适配层）
 * @module dsh-hardware-sandbox/host/network-tools
 *
 * ★ 与 `tools.ts` 同属适配层，**同样的 schema 纪律**（详见 `tools.ts` 文件头）：
 *   · `parameters` 与 `output.schema` **都要写成已编译的标准 JSON Schema**
 *     （对象级 `required: [...]` 数组，**不是**逐属性 `required: true`）
 *     因为我们不用 `defineTool`，没有编译那一步
 *   · `output.schema` 会在**每次调用后校验返回值** ⇒ 声明必须与实际返回逐字段一致
 *
 * ★ 与仿真工具分开成两个文件：它们管的是**两类不同的虚拟硬件**，
 *   混在一起会让人以为"联网设备也是挂在虚拟时钟上的"。
 */
import type { NetworkRegistry } from '../core/sim/network-registry.ts'
import type { NetworkedDevice } from '../core/devices/networked.ts'
import type { AssemblyState } from '../core/state/assembly-state.ts'
import type { JsonRecord, JsonScalar } from '../contracts/network.ts'
import type { ContentBlockLike, HardwareToolDefinition } from './tools.ts'

/** 联网设备型号（`library.ts` 里那个无端口型号）。 */
export const NETWORK_DEVICE_MODEL = 'esp32-seat-sensor'

export interface NetworkToolDeps {
  readonly registry: NetworkRegistry
  readonly state: AssemblyState
  /** 已知协议 id → 说明，供工具描述与校验使用。 */
  readonly protocols: Readonly<Record<string, string>>
}

const text = (value: string): ContentBlockLike[] => [{ type: 'text', text: value }]

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/** 把设备快照整理成**固定形状**（键集恒定，可选键用 undefined 占位由 JSON 丢弃）。 */
function deviceView(componentId: string, device: NetworkedDevice): Record<string, unknown> {
  const snap = device.snapshot()
  return {
    componentId,
    label: snap.label,
    protocol: snap.protocol,
    deviceId: snap.deviceId,
    endpoint: snap.endpoint,
    status: snap.status,
    running: device.running,
    reports: snap.reports,
    failures: snap.failures,
    reading: { ...snap.reading },
    config: { ...(snap.config ?? {}) },
    lastError: snap.lastError ?? null,
    lastReportAt: snap.lastReportAt ?? null,
  }
}

export function createNetworkTools(deps: NetworkToolDeps): HardwareToolDefinition[] {
  const { registry, state } = deps
  const protocolIds = Object.keys(deps.protocols)

  return [
    /* ── ① 添加一台联网设备 ── */
    {
      name: 'hw_network_add',
      description:
        '在虚拟场景里添加一台**联网设备**（第二类虚拟硬件：主动向外部系统发 HTTP 的设备，' +
        '如座位传感器）。注意它**不会自动开始发请求** —— 还要用 hw_network_control 启动。' +
        `已知协议：${protocolIds.map((id) => `${id}（${deps.protocols[id] ?? ''}）`).join('；')}`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          componentId: { type: 'string', description: '组件 id（如 esp1）。必须唯一。' },
          protocol: { type: 'string', enum: protocolIds, description: '协议适配器 id。' },
          endpoint: { type: 'string', description: '外部系统基址，如 http://127.0.0.1:5800（不含路径）。' },
          deviceId: { type: 'string', description: '设备自报身份（智座里是 WiFi MAC，如 AA:BB:CC:11:22:33）。' },
          position: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              z: { type: 'number' },
            },
            required: ['x', 'y', 'z'],
            description: '场景坐标（米）。省略则放在原点附近。',
          },
        },
        required: ['componentId', 'protocol', 'endpoint', 'deviceId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            componentId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['ok', 'componentId'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          return result.ok === true
            ? text(
                `已添加联网设备 ${String(result.componentId)}（**尚未启动**）。` +
                  '用 hw_network_control 启动它才会开始向外部系统发请求。',
              )
            : text(`添加失败：${String(result.reason ?? '未知原因')}`)
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const componentId = typeof input.componentId === 'string' ? input.componentId : ''
        const protocol = typeof input.protocol === 'string' ? input.protocol : ''
        const endpoint = typeof input.endpoint === 'string' ? input.endpoint : ''
        const deviceId = typeof input.deviceId === 'string' ? input.deviceId : ''
        if (componentId === '' || protocol === '' || endpoint === '' || deviceId === '') {
          throw new Error('hw_network_add 需要 componentId / protocol / endpoint / deviceId')
        }

        const pos = asRecord(input.position)
        const position = {
          x: typeof pos.x === 'number' ? pos.x : 0.1,
          y: typeof pos.y === 'number' ? pos.y : 0.0075,
          z: typeof pos.z === 'number' ? pos.z : 0.1,
        }

        const placed = state.place(NETWORK_DEVICE_MODEL, position, componentId, {
          network: { protocol, endpoint, deviceId },
        })
        if (!placed.ok) return { ok: false, componentId, reason: placed.reason }

        // 未知协议会被注册表记进 problems —— 如实报出来，不让用户以为加成功了
        const problem = registry.problems.get(componentId)
        if (problem !== undefined) return { ok: false, componentId, reason: problem }

        return { ok: true, componentId }
      },
    },

    /* ── ② 观察 ── */
    {
      name: 'hw_network_devices',
      description:
        '列出场景里全部**联网设备**及其状态：协议、外部系统地址、在线状态、上报/失败次数、' +
        '当前读数、外部系统下发的配置。用于确认"设备到底连上没有、有没有在真的上报"。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer' },
            devices: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  componentId: { type: 'string' },
                  label: { type: 'string' },
                  protocol: { type: 'string' },
                  deviceId: { type: 'string' },
                  endpoint: { type: 'string' },
                  status: { type: 'string' },
                  running: { type: 'boolean' },
                  reports: { type: 'integer' },
                  failures: { type: 'integer' },
                  reading: { type: 'object', additionalProperties: true },
                  config: { type: 'object', additionalProperties: true },
                  lastError: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                  lastReportAt: { oneOf: [{ type: 'string' }, { type: 'null' }] },
                },
                required: [
                  'componentId',
                  'label',
                  'protocol',
                  'deviceId',
                  'endpoint',
                  'status',
                  'running',
                  'reports',
                  'failures',
                  'reading',
                  'config',
                  'lastError',
                  'lastReportAt',
                ],
              },
            },
            problems: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  componentId: { type: 'string' },
                  reason: { type: 'string' },
                },
                required: ['componentId', 'reason'],
              },
            },
          },
          required: ['count', 'devices', 'problems'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const devices = (result.devices as Array<Record<string, unknown>>) ?? []
          const problems = (result.problems as Array<Record<string, unknown>>) ?? []
          if (devices.length === 0 && problems.length === 0) {
            return text('场景里还没有联网设备。用 hw_network_add 添加一台。')
          }
          const lines = devices.map((d) => {
            const reading = asRecord(d.reading)
            const config = asRecord(d.config)
            const bits = [
              `${String(d.componentId)} [${String(d.protocol)}] ${String(d.status)}${d.running === true ? '（运行中）' : '（已停止）'}`,
              `  → ${String(d.endpoint)}  设备号 ${String(d.deviceId)}`,
              `  上报 ${String(d.reports)} 次 / 失败 ${String(d.failures)} 次` +
                (config['seat_id'] !== undefined ? `  绑定座位 ${String(config['seat_id'])}` : '  **未绑定座位**'),
              `  当前读数 ${JSON.stringify(reading)}`,
              ...(d.lastReportAt !== null && d.lastReportAt !== undefined
                ? [`  最近上报 ${String(d.lastReportAt)}`]
                : []),
              ...(d.lastError !== null && d.lastError !== undefined
                ? [`  ⚠️ 最近错误：${String(d.lastError)}`]
                : []),
            ]
            return bits.join('\n')
          })
          const problemLines = problems.map(
            (p) => `⚠️ ${String(p.componentId)}：${String(p.reason)}`,
          )
          return text([...lines, ...problemLines].join('\n\n'))
        },
      },
      execute: async () => ({
        count: registry.deviceCount,
        devices: registry.devices().map((device) => deviceView(device.id, device)),
        problems: [...registry.problems].map(([componentId, reason]) => ({ componentId, reason })),
      }),
    },

    /* ── ③ 控制 ── */
    {
      name: 'hw_network_control',
      description:
        '启动 / 停止联网设备，或注入"掉线"故障。' +
        '**只有 start 会让请求真正发出去** —— 设备被添加进来时是停止的，' +
        '这是刻意的（默认不该产生外部副作用）。' +
        'disconnect 用于验证外部系统能否正确识别设备离线。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'disconnect', 'clear'],
            description: 'start 启动 | stop 停止 | disconnect 注入掉线故障 | clear 清除故障',
          },
          componentId: { type: 'string', description: '组件 id。省略则对全部联网设备生效。' },
        },
        required: ['action'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string' },
            affected: { type: 'array', items: { type: 'string' } },
          },
          required: ['action', 'affected'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const affected = (result.affected as string[]) ?? []
          return text(
            affected.length === 0
              ? '没有匹配的联网设备（先用 hw_network_add 添加）'
              : `已对 ${affected.join(', ')} 执行 ${String(result.action)}`,
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const action = typeof input.action === 'string' ? input.action : ''
        const componentId = typeof input.componentId === 'string' ? input.componentId : undefined

        if (action === 'start') {
          const started = await registry.start(componentId)
          return { action, affected: started.map((d) => d.id) }
        }
        if (action === 'stop') {
          return { action, affected: registry.stop(componentId).map((d) => d.id) }
        }
        if (action === 'disconnect' || action === 'clear') {
          const targets =
            componentId === undefined
              ? registry.devices()
              : registry.devices().filter((d) => d.id === componentId)
          for (const device of targets) device.injectFault({ type: action })
          return { action, affected: targets.map((d) => d.id) }
        }
        throw new Error(`hw_network_control 不认识的 action："${action}"`)
      },
    },

    /* ── ④ 设置物理读数 ── */
    {
      name: 'hw_network_set_reading',
      description:
        '设置某台联网设备的**物理读数**（如双红外是否被遮挡），设备会按自己的节奏上报出去。' +
        '★ 读数是**物理量**（true = 被遮挡），不是电平 —— ' +
        '具体发 1 还是 0 由协议按外部系统下发的配置（如 ir_active_high）翻译。' +
        '★ 注意：智座的座位释放需要**连续 2 次"无人"上报**，只报一次不会释放。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          componentId: { type: 'string', description: '组件 id。' },
          reading: {
            type: 'object',
            additionalProperties: true,
            description: '读数对象，如 {"ir_front": true, "ir_back": true}（true = 被遮挡）。',
          },
        },
        required: ['componentId', 'reading'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            componentId: { type: 'string' },
            reading: { type: 'object', additionalProperties: true },
            reason: { type: 'string' },
          },
          required: ['ok', 'componentId', 'reading'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          return result.ok === true
            ? text(
                `${String(result.componentId)} 的读数已设为 ${JSON.stringify(result.reading)}；` +
                  '设备会在下一个上报周期把它发出去（可用 hw_network_devices 观察上报次数）。',
              )
            : text(`设置失败：${String(result.reason ?? '未知原因')}`)
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const componentId = typeof input.componentId === 'string' ? input.componentId : ''
        const device = registry.deviceFor(componentId)
        if (device === undefined) {
          return { ok: false, componentId, reading: {}, reason: '找不到这台联网设备' }
        }

        // ★ 只收 JSON 标量：嵌套值会被 `toRecord` 丢掉，那等于静默丢数据
        const raw = asRecord(input.reading)
        const reading: Record<string, JsonScalar> = {}
        for (const [key, value] of Object.entries(raw)) {
          if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            reading[key] = value
          }
        }
        if (Object.keys(reading).length === 0) {
          return { ok: false, componentId, reading: {}, reason: 'reading 里没有可用的标量字段' }
        }

        device.setReading(reading as JsonRecord)
        return { ok: true, componentId, reading: { ...device.snapshot().reading } }
      },
    },
  ]
}
