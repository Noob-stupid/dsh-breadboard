/**
 * 联网设备工具的测试
 *
 * ★ 与 `hardware-tools.test.ts` **同样的 schema 纪律**：
 *   · 不自己实现 JSON Schema 校验器（那会把"替身比生产宽松"的错误再犯一遍）
 *   · 只断言不需要 schema 语义就能判定的结构事实
 *   · "宿主到底收不收这个 schema" 由**线上注册**回答（capabilities.simTools）
 *
 * ★ 另外覆盖一条**安全性质**：添加设备**不该**让请求发出去。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createNetworkTools, NETWORK_DEVICE_MODEL } from '../src/host/network-tools.ts'
import type { HardwareToolDefinition } from '../src/host/tools.ts'
import { NetworkRegistry } from '../src/core/sim/network-registry.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import type { NetworkRequest, NetworkResponse, NetworkTransport } from '../src/contracts/network.ts'
import { ZHIZUO_PROTOCOL_ID } from '../src/core/devices/protocols/zhizuo.ts'

/* ─────────────────── 夹具 ─────────────────── */

interface FakeTransport {
  readonly transport: NetworkTransport
  readonly calls: { url: string; body?: unknown }[]
}

function makeTransport(): FakeTransport {
  const calls: { url: string; body?: unknown }[] = []
  const transport: NetworkTransport = (request: NetworkRequest): Promise<NetworkResponse> => {
    calls.push({ url: request.url, ...(request.body !== undefined ? { body: request.body } : {}) })
    if (request.url.includes('/device/register')) {
      return Promise.resolve({
        status: 200,
        body: {
          code: 200,
          message: 'ok',
          data: {
            registered: true,
            is_new: true,
            config: {
              device_id: 'AA:BB:CC:11:22:33',
              registered: true,
              ir_active_high: true,
              report_interval_ms: 1000,
              seat_id: 6,
              seat_label: 'A-4',
              floor_id: 3,
            },
          },
        },
      })
    }
    return Promise.resolve({
      status: 200,
      body: { code: 200, message: 'ok', data: { seat_id: 6, status: 'occupied', consecutive_empty: 0 } },
    })
  }
  return { transport, calls }
}

function makeTools(): { tools: HardwareToolDefinition[]; fake: FakeTransport; registry: NetworkRegistry; state: AssemblyState } {
  const fake = makeTransport()
  const state = new AssemblyState()
  const registry = new NetworkRegistry({ state, transport: fake.transport })
  const tools = createNetworkTools({
    registry,
    state,
    protocols: { [ZHIZUO_PROTOCOL_ID]: '智座座位传感器' },
  })
  return { tools, fake, registry, state }
}

function tool(tools: HardwareToolDefinition[], name: string): HardwareToolDefinition {
  const found = tools.find((t) => t.name === name)
  assert.ok(found, `找不到工具 ${name}`)
  return found
}

/**
 * 递归找源方言。
 *
 * ★★ 判据必须**精确到值的类型**：源方言的标志是 `required: true`（**布尔**），
 *   而 `required: ['x','y']`（**数组**）是**已编译**形态，在**任意嵌套层**都合法。
 *   早先只判"属性里有 required 这个键"，会把合法的嵌套对象 schema 误报成源方言 ——
 *   那是**校验器自己的 bug**（`docs/04` 第 9 例：是结构校验器把校验公式的 bug 抓了出来）。
 */
function findSourceDialect(node: unknown, path: string, out: string[]): void {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return
  const record = node as Record<string, unknown>
  const properties = record['properties']
  if (properties !== null && typeof properties === 'object' && !Array.isArray(properties)) {
    for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
      if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        // ★ 只认布尔 true；数组是合法的对象级 required
        if ((child as Record<string, unknown>)['required'] === true) {
          out.push(`${path}.properties.${key}.required`)
        }
      }
      findSourceDialect(child, `${path}.properties.${key}`, out)
    }
  }
  if (record['items'] !== undefined) findSourceDialect(record['items'], `${path}.items`, out)
  const oneOf = record['oneOf']
  if (Array.isArray(oneOf)) {
    oneOf.forEach((branch, index) => {
      findSourceDialect(branch, `${path}.oneOf[${String(index)}]`, out)
    })
  }
}

/** 按 additionalProperties:false + required 检查返回值（宿主的两条实际规则）。 */
function checkShape(t: HardwareToolDefinition, value: unknown): void {
  const schema = t.output.schema as { properties?: Record<string, unknown>; required?: readonly string[] }
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${t.name} 必须返回对象`)
  const keys = Object.keys(value as Record<string, unknown>)
  const declared = Object.keys(schema.properties ?? {})
  const undeclared = keys.filter((k) => !declared.includes(k))
  assert.deepEqual(undeclared, [], `${t.name} 返回了未声明字段 ${undeclared.join(', ')}`)
  for (const key of schema.required ?? []) {
    assert.ok(Object.hasOwn(value as object, key), `${t.name} 缺少必填字段 "${key}"`)
  }
}

/* ─────────────────── ① schema 纪律 ─────────────────── */

test('★ 联网工具：任何 schema 都不得用源方言的逐属性 required', () => {
  for (const t of makeTools().tools) {
    for (const [label, schema] of [
      ['parameters', t.parameters],
      ['output.schema', t.output.schema],
    ] as const) {
      const found: string[] = []
      findSourceDialect(schema, `${t.name}.${label}`, found)
      assert.deepEqual(found, [], `${t.name}.${label} 用了源方言`)
    }
  }
})

test('联网工具：required 名字都在 properties 里', () => {
  for (const t of makeTools().tools) {
    for (const schema of [t.parameters, t.output.schema] as Record<string, unknown>[]) {
      const required = schema['required']
      if (required === undefined) continue
      assert.ok(Array.isArray(required), `${t.name}: required 必须是数组`)
      const properties = (schema['properties'] ?? {}) as Record<string, unknown>
      for (const key of required as string[]) {
        assert.ok(Object.hasOwn(properties, key), `${t.name}: required 里的 "${key}" 不在 properties 里`)
      }
    }
  }
})

/* ─────────────────── ② 安全性质 ─────────────────── */

test('★★ hw_network_add 只添加，**不发出任何请求**（默认无外部副作用）', async () => {
  const { tools, fake, registry } = makeTools()
  const result = await tool(tools, 'hw_network_add').execute(
    {
      componentId: 'esp1',
      protocol: ZHIZUO_PROTOCOL_ID,
      endpoint: 'http://127.0.0.1:5800',
      deviceId: 'AA:BB:CC:11:22:33',
    },
    {},
  )
  checkShape(tool(tools, 'hw_network_add'), result)
  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(fake.calls.length, 0, '★ 添加不等于启动，一次请求都不该发出')
  assert.equal(registry.deviceCount, 1)
  registry.dispose()
})

test('hw_network_add：未知协议如实报失败（不让用户以为加成功了）', async () => {
  const { tools, registry } = makeTools()
  const result = await tool(tools, 'hw_network_add').execute(
    { componentId: 'espX', protocol: 'nope', endpoint: 'http://x', deviceId: 'AA' },
    {},
  )
  assert.equal((result as { ok: boolean }).ok, false)
  assert.match((result as { reason: string }).reason, /未知协议/)
  registry.dispose()
})

test('hw_network_add：组件 id 重复时失败，不静默覆盖', async () => {
  const { tools, registry } = makeTools()
  const args = {
    componentId: 'esp1',
    protocol: ZHIZUO_PROTOCOL_ID,
    endpoint: 'http://127.0.0.1:5800',
    deviceId: 'AA:BB:CC:11:22:33',
  }
  await tool(tools, 'hw_network_add').execute(args, {})
  const again = await tool(tools, 'hw_network_add').execute(args, {})
  assert.equal((again as { ok: boolean }).ok, false)
  registry.dispose()
})

/* ─────────────────── ③ 端到端（假传输） ─────────────────── */

test('★ 添加 → 启动 → 设读数 → 观察：走完整条链路', async () => {
  const { tools, fake, registry } = makeTools()

  await tool(tools, 'hw_network_add').execute(
    {
      componentId: 'esp1',
      protocol: ZHIZUO_PROTOCOL_ID,
      endpoint: 'http://127.0.0.1:5800',
      deviceId: 'AA:BB:CC:11:22:33',
    },
    {},
  )

  const started = await tool(tools, 'hw_network_control').execute({ action: 'start' }, {})
  checkShape(tool(tools, 'hw_network_control'), started)
  assert.deepEqual((started as { affected: string[] }).affected, ['esp1'])
  assert.ok(fake.calls.some((c) => c.url.includes('/device/register')), 'start 之后应当真的注册了')

  const setResult = await tool(tools, 'hw_network_set_reading').execute(
    { componentId: 'esp1', reading: { ir_front: true, ir_back: true } },
    {},
  )
  checkShape(tool(tools, 'hw_network_set_reading'), setResult)
  assert.equal((setResult as { ok: boolean }).ok, true)

  const device = registry.deviceFor('esp1')
  assert.ok(device)
  const reported = await device.reportOnce()
  assert.equal(reported, true)

  const reportCall = fake.calls.find((c) => c.url.includes('/sensor/report'))
  assert.ok(reportCall, '应当发出了一次上报')
  assert.deepEqual(reportCall.body, {
    seat_id: 6, // ★ 来自**服务端配置**，不是 options
    ir_front: 1,
    ir_back: 1,
    device_id: 'AA:BB:CC:11:22:33', // ★ 心跳靠它
  })

  const listed = await tool(tools, 'hw_network_devices').execute({}, {})
  checkShape(tool(tools, 'hw_network_devices'), listed)
  const view = listed as { count: number; devices: Record<string, unknown>[]; problems: unknown[] }
  assert.equal(view.count, 1)
  assert.equal(view.devices[0]?.['componentId'], 'esp1')
  assert.equal(view.devices[0]?.['status'], 'online')
  assert.equal(view.devices[0]?.['reports'], 1)
  assert.equal(view.devices[0]?.['lastError'], null, '没有错误时用 null 占位，键集恒定')

  registry.dispose()
})

test('★ 未启动时设读数不报错，但**不发请求**', async () => {
  const { tools, fake, registry } = makeTools()
  await tool(tools, 'hw_network_add').execute(
    { componentId: 'esp1', protocol: ZHIZUO_PROTOCOL_ID, endpoint: 'http://x', deviceId: 'AA' },
    {},
  )
  const result = await tool(tools, 'hw_network_set_reading').execute(
    { componentId: 'esp1', reading: { ir_front: true } },
    {},
  )
  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(fake.calls.length, 0, '没启动就不该有任何请求')
  registry.dispose()
})

test('hw_network_set_reading：嵌套值被拒绝（不静默丢数据）', async () => {
  const { tools, registry } = makeTools()
  await tool(tools, 'hw_network_add').execute(
    { componentId: 'esp1', protocol: ZHIZUO_PROTOCOL_ID, endpoint: 'http://x', deviceId: 'AA' },
    {},
  )
  const result = await tool(tools, 'hw_network_set_reading').execute(
    { componentId: 'esp1', reading: { nested: { a: 1 } } },
    {},
  )
  assert.equal((result as { ok: boolean }).ok, false, '全是嵌套值时应当明确失败')
  registry.dispose()
})

test('hw_network_set_reading：找不到设备时如实报失败', async () => {
  const { tools, registry } = makeTools()
  const result = await tool(tools, 'hw_network_set_reading').execute(
    { componentId: 'nope', reading: { ir_front: true } },
    {},
  )
  assert.equal((result as { ok: boolean }).ok, false)
  assert.match((result as { reason: string }).reason, /找不到/)
  registry.dispose()
})

test('★ hw_network_control：disconnect 后停止上报，clear 后恢复', async () => {
  const { tools, fake, registry } = makeTools()
  await tool(tools, 'hw_network_add').execute(
    {
      componentId: 'esp1',
      protocol: ZHIZUO_PROTOCOL_ID,
      endpoint: 'http://127.0.0.1:5800',
      deviceId: 'AA:BB:CC:11:22:33',
    },
    {},
  )
  await tool(tools, 'hw_network_control').execute({ action: 'start' }, {})
  const device = registry.deviceFor('esp1')
  assert.ok(device)

  await tool(tools, 'hw_network_control').execute({ action: 'disconnect' }, {})
  const before = fake.calls.length
  assert.equal(await device.reportOnce(), false)
  assert.equal(fake.calls.length, before, '断开时不该发请求')

  await tool(tools, 'hw_network_control').execute({ action: 'clear' }, {})
  assert.equal(await device.reportOnce(), true, 'clear 之后应当恢复')

  registry.dispose()
})

test('hw_network_control：不认识的 action 必须抛', async () => {
  const { tools, registry } = makeTools()
  await assert.rejects(
    () => tool(tools, 'hw_network_control').execute({ action: 'explode' }, {}),
    /不认识的 action/,
  )
  registry.dispose()
})

/* ─────────────────── ④ render 不抛 ─────────────────── */

test('联网工具：render 对畸形值不抛', () => {
  for (const t of makeTools().tools) {
    for (const value of [null, undefined, 42, 'str', [], {}]) {
      const blocks = t.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${t.name}.render 必须返回内容块`)
      assert.equal(blocks[0]?.type, 'text')
    }
  }
})

test('联网设备型号常量与库一致（防止工具与库分叉）', () => {
  assert.equal(NETWORK_DEVICE_MODEL, 'esp32-seat-sensor')
})
