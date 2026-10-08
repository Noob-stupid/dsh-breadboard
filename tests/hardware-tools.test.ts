/**
 * 硬件工具的 schema 与返回值一致性
 *
 * ★ 这个文件是为一个**真实踩过的注册失败**写的：
 *
 *   工具的 `output.schema` 原来写成了 `parameters` 的**源方言**
 *   （逐属性 `required: true`），宿主 `tools.register()` 直接拒绝：
 *
 *     JsonSchemaError: unsupported JSON schema:
 *       schema.properties.ok.required is not supported on type "boolean"; …
 *
 *   而症状是**完全静默**的 —— 工具一个都没注册，模型只会说"我没有这个能力"。
 *   是 `GET /api/capabilities` 的 `simTools` 指纹才把它照出来的。
 *
 * ── 本文件**刻意不做**的事 ──
 *
 * ★ 不自己实现一个 JSON Schema 校验器。
 *   本项目已经栽过一次"测试替身的规则比生产松"（见 docs/04）：替身说通过、
 *   线上 404。自己写一个校验器就是把同一个错误再犯一遍 —— 我的实现一旦
 *   与宿主的 `assertSupportedJsonSchema` 有出入，测试就会给出**虚假的安心**。
 *
 * ⇒ 这里只断言**不需要 schema 语义就能判定**的结构事实：
 *   ① 任何位置都不出现源方言的逐属性 `required`
 *   ② `required` 数组里的名字都在 `properties` 里
 *   ③ 工具**实际返回**的对象：键都在 `properties` 里（`additionalProperties: false` 的要求）
 *      且 `required` 里的键**都在**返回值里
 *
 *   "宿主到底收不收这个 schema" 由**线上注册**回答（capabilities 的 simTools），
 *   不由本文件回答。
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import { createHardwareTools, type HardwareToolDefinition } from '../src/host/tools.ts'
import { SimEngine } from '../src/core/sim/engine.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { HardwareEventBus } from '../src/core/events.ts'
import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { restingY } from '../src/contracts/library.ts'

/* ─────────────────── 被测对象 ─────────────────── */

/** 起一台「立即退出的假项目进程」的引擎 —— 不真起进程，但走完整条 `SimEngine.run` 流程。 */
function makeEngine(): { engine: SimEngine; state: AssemblyState } {
  const clock = new VirtualClock({ step: 0.001 })
  const state = new AssemblyState()
  const bus = new HardwareEventBus()

  const engine = new SimEngine({
    clock,
    state,
    bus,
    pythonPath: 'python',
    shimRoot: '/nonexistent-shim',
    // 立即退出、无输出的假进程
    spawn: () => ({
      done: Promise.resolve({ exitCode: 0 }),
      terminate: () => undefined,
    }),
    wallNow: () => 0,
  })
  return { engine, state }
}

function makeTools(): HardwareToolDefinition[] {
  const { engine, state } = makeEngine()
  return createHardwareTools({ engine, state, pythonPath: 'python' })
}

const toolByName = (tools: HardwareToolDefinition[], name: string): HardwareToolDefinition => {
  const found = tools.find((tool) => tool.name === name)
  assert.ok(found, `找不到工具 ${name}`)
  return found
}

/* ─────────────────── ① 源方言不得出现 ─────────────────── */

/**
 * 递归找出所有"属性里带 `required`"的位置。
 *
 * ★★ 判据必须**精确到值的类型**：源方言的标志是 `required: true`（**布尔**），
 *   而 `required: ['x','y']`（**数组**）是**已编译**形态，在**任意嵌套层**都合法。
 *   只判"属性里有 required 这个键"会把合法的嵌套对象 schema 误报成源方言 ——
 *   那是**校验器自己的 bug**（`docs/04` 第 9 例：结构校验器把校验公式的 bug 抓了出来）。
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

  const items = record['items']
  if (items !== undefined) findSourceDialect(items, `${path}.items`, out)

  const oneOf = record['oneOf']
  if (Array.isArray(oneOf)) {
    oneOf.forEach((branch, index) => {
      findSourceDialect(branch, `${path}.oneOf[${String(index)}]`, out)
    })
  }
}

test('★ 回归：任何 schema 都不得用源方言的逐属性 `required`', () => {
  for (const tool of makeTools()) {
    for (const [label, schema] of [
      ['parameters', tool.parameters],
      ['output.schema', tool.output.schema],
    ] as const) {
      const found: string[] = []
      findSourceDialect(schema, `${tool.name}.${label}`, found)
      assert.deepEqual(
        found,
        [],
        `${tool.name} 的 ${label} 用了源方言（属性内 required: true）。` +
          '我们不用 defineTool，没有编译这一步，必须写成对象级 required 数组。',
      )
    }
  }
})

test('★ 回归：output.schema 必须用对象级 required 数组声明必填项', () => {
  const tools = makeTools()
  const run = toolByName(tools, 'hw_run_simulation')
  assert.deepEqual(
    (run.output.schema as { required?: unknown }).required,
    ['ok', 'reason', 'virtualElapsed', 'wallElapsedMs', 'log'],
    'exitCode 可为 null 且 message 可选，不该进 required',
  )
})

test('output.schema 的 required 名字都在 properties 里', () => {
  for (const tool of makeTools()) {
    const schema = tool.output.schema as { required?: unknown; properties?: Record<string, unknown> }
    const required = schema.required
    if (required === undefined) continue
    assert.ok(Array.isArray(required), `${tool.name}.output.schema.required 必须是数组`)
    for (const key of required as string[]) {
      assert.ok(
        Object.hasOwn(schema.properties ?? {}, key),
        `${tool.name}: required 里的 "${key}" 不在 properties 里`,
      )
    }
  }
})

test('parameters 的 required 名字都在 properties 里', () => {
  for (const tool of makeTools()) {
    const schema = tool.parameters as { required?: unknown; properties?: Record<string, unknown> }
    const required = schema.required
    if (required === undefined) continue
    assert.ok(Array.isArray(required), `${tool.name}.parameters.required 必须是数组`)
    for (const key of required as string[]) {
      assert.ok(
        Object.hasOwn(schema.properties ?? {}, key),
        `${tool.name}: parameters.required 里的 "${key}" 不在 properties 里`,
      )
    }
  }
})

/* ─────────────────── ② 返回值必须落在声明里 ─────────────────── */

/**
 * 按 `additionalProperties: false` + `required` 两条规则检查返回值。
 *
 * ★ 这两条正是宿主 `validateJsonSchemaValue` 在**每次调用后**执行的检查
 *   （`packages/core/tools/src/index.ts`），也是实际会失败的两种情形：
 *   多一个没声明的字段、少一个必填字段。
 */
function checkShape(
  tool: HardwareToolDefinition,
  value: unknown,
): void {
  const schema = tool.output.schema as {
    properties?: Record<string, unknown>
    required?: readonly string[]
  }
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${tool.name} 的返回值必须是对象`)
  const keys = Object.keys(value as Record<string, unknown>)
  const declared = Object.keys(schema.properties ?? {})

  const undeclared = keys.filter((key) => !declared.includes(key))
  assert.deepEqual(
    undeclared,
    [],
    `${tool.name} 返回了未声明的字段 ${undeclared.join(', ')} —— ` +
      'additionalProperties: false 会让宿主校验失败',
  )

  for (const key of schema.required ?? []) {
    assert.ok(
      Object.hasOwn(value as object, key),
      `${tool.name} 的返回值缺少必填字段 "${key}"`,
    )
  }
}

test('★ hw_get_assembly 的返回值与声明逐字段一致（AssemblySnapshot 有 6 个字段）', async () => {
  const { engine, state } = makeEngine()
  // 铺一套真实装配：这样快照里 components/connections/virtualDevices 都非空
  state.place('rpi-4b', { x: 0, y: restingY('rpi-4b'), z: 0 })
  state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })

  const tool = toolByName(createHardwareTools({ engine, state, pythonPath: 'python' }), 'hw_get_assembly')
  const value = await tool.execute({}, {})

  checkShape(tool, value)
  // ★ 这一条是专门为"漏了 powerSummary"写的
  assert.ok(
    Object.hasOwn(value as object, 'powerSummary'),
    'AssemblySnapshot 有 powerSummary，声明里漏了就会每次调用都校验失败',
  )
})

test('hw_get_sim_log 的返回值与声明一致', async () => {
  const tool = toolByName(makeTools(), 'hw_get_sim_log')
  checkShape(tool, await tool.execute({}, {}))
  checkShape(tool, await tool.execute({ tail: 5 }, {}))
})

test('hw_inject_fault 的返回值与声明一致（含未命中设备的情形）', async () => {
  const tool = toolByName(makeTools(), 'hw_inject_fault')
  checkShape(tool, await tool.execute({ target: 'bme280:0x76', type: 'disconnect' }, {}))
})

test('★ hw_run_simulation 的返回值与声明一致', async () => {
  const tool = toolByName(makeTools(), 'hw_run_simulation')
  const value = await tool.execute({ projectPath: '/tmp/proj', duration: 1 }, {})
  checkShape(tool, value)
  // exitCode 允许 null —— 声明里必须是 oneOf，不能是裸 integer
  const exitSchema = (tool.output.schema as {
    properties?: Record<string, unknown>
  }).properties?.['exitCode']
  assert.ok(
    exitSchema !== null && typeof exitSchema === 'object' && 'oneOf' in (exitSchema as object),
    'exitCode 可为 null，声明必须是 oneOf[integer, null]',
  )
})

/* ─────────────────── ③ 参数校验必须在 execute 里自己兜住 ─────────────────── */

test('hw_run_simulation：缺少 projectPath 时抛（不能静默跑一个空路径）', async () => {
  const tool = toolByName(makeTools(), 'hw_run_simulation')
  await assert.rejects(() => tool.execute({ duration: 1 }, {}), /projectPath/)
})

test('hw_run_simulation：duration 非正时抛', async () => {
  const tool = toolByName(makeTools(), 'hw_run_simulation')
  await assert.rejects(() => tool.execute({ projectPath: '/tmp/p', duration: 0 }, {}), /duration/)
  await assert.rejects(() => tool.execute({ projectPath: '/tmp/p', duration: -1 }, {}), /duration/)
})

test('hw_inject_fault：缺少 target/type 时抛', async () => {
  const tool = toolByName(makeTools(), 'hw_inject_fault')
  await assert.rejects(() => tool.execute({ type: 'nack' }, {}), /target/)
  await assert.rejects(() => tool.execute({ target: 'x' }, {}), /type/)
})

/* ─────────────────── ④ render 不得抛 ─────────────────── */

test('render 对畸形值不抛（模型可能传 null / 非对象）', () => {
  for (const tool of makeTools()) {
    for (const value of [null, undefined, 42, 'str', [], {}]) {
      const blocks = tool.output.render({}, value)
      assert.ok(Array.isArray(blocks) && blocks.length > 0, `${tool.name}.render 必须返回内容块`)
      assert.equal(blocks[0]?.type, 'text')
    }
  }
})

test('render 返回 text 块且非空', () => {
  for (const tool of makeTools()) {
    const blocks = tool.output.render({}, {})
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0]?.type, 'text')
    assert.ok((blocks[0]?.text ?? '').length > 0)
  }
})
