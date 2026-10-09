/**
 * 工具注册 —— 把内核能力暴露给 DS（设计文档 §5.4 / §10 薄适配层）
 * @module dsh-hardware-sandbox/host/tools
 *
 * ★ 与 `routes.ts` 同属适配层：**结构等价**宿主类型，不 import 宿主包。
 *   §10.3 要求内核零依赖宿主 API；宿主接口若改名，改动收敛在本文件。
 *
 * ★★ DSH 的 JSON Schema 方言 —— **两个位置不一样，这里是踩过的坑**：
 *
 *   DSH 内部有**两套** schema 形态（`packages/core/tools/src/schema.ts`）：
 *
 *   | 位置 | 形态 | `required` 怎么写 |
 *   |---|---|---|
 *   | `parameters`（**源方言**） | `ParameterSchemaSpec` | **每个属性里 `required: true`** |
 *   | `output.schema`（**已编译**） | `ValueSchemaSpec` / `JsonSchemaNode` | **对象级 `required: ['a','b']` 数组** |
 *
 *   `parameters` 的"属性内 `required: true`"是**给人写的源方言**，
 *   由 `defineTool()` 编译成标准 JSON Schema（见 `schema.ts` 的 `property-map-tail`：
 *   它把逐属性的 `required: true` 收集成对象级 `required` 数组）。
 *
 *   ⚠️ **我们不用 `defineTool`** —— §10.3 要求内核零依赖宿主 API，本文件刻意只做
 *      **结构等价类型**。⇒ **没有编译这一步，两边都必须自己写成标准 JSON Schema**：
 *      · `output.schema` 会过 `assertSupportedJsonSchema()`，写成源方言会**注册失败**
 *        （实测报错：`schema.properties.ok.required is not supported on type "boolean"`）
 *      · `parameters` **不做校验**、原样交给模型 ⇒ 写成源方言**不会报错**，
 *        但模型看到的是一个非法/无效的 schema，`required` 形同虚设 ——
 *        **静默失效，比注册失败更坏**
 *
 *   ★ 另：`output.schema` 还会在**每次调用后校验返回值**
 *     （`validateJsonSchemaValue(tool.output.schema, value)`），所以
 *     声明必须与**实际返回的形状**逐字段一致 —— 少一个字段、多一个字段都会失败。
 *     `tests/hardware-tools.test.ts` 用"声明键集合 == 实际返回键集合"把它钉住。
 *
 *   其他约定：对象级用 `additionalProperties: false`；`output` 必填。
 */
import type { SimEngine } from '../core/sim/engine.ts'
import type { AssemblyState } from '../core/state/assembly-state.ts'
import type { SimMode } from '../contracts/assembly.ts'
import type { DeviceFault, DeviceFaultType } from '../contracts/device.ts'

/* ─────────────────── 结构等价的宿主类型 ─────────────────── */

/** 内容块 —— 结构等价于宿主的 `ContentBlock`（只用到 text）。 */
export interface ContentBlockLike {
  readonly type: 'text'
  readonly text: string
}

interface ToolOutput {
  readonly schema: Record<string, unknown>
  readonly render: (args: unknown, value: unknown) => ContentBlockLike[]
}

/** 结构等价于宿主 `ToolDefinition`。 */
export interface HardwareToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: ToolOutput
  readonly execute: (args: unknown, exec: { signal?: AbortSignal }) => Promise<unknown>
}

/** 结构等价于宿主 `tools` 服务。 */
export interface ToolRegistryLike {
  register(definition: HardwareToolDefinition): () => void
}

/* ─────────────────── schema 片段 ─────────────────── */

const FAULT_TYPES: readonly DeviceFaultType[] = [
  'disconnect',
  'nack',
  'busy',
  'set_reading',
  'clear',
]

const text = (value: string): ContentBlockLike[] => [{ type: 'text', text: value }]

/** 把值安全地转成对象（模型可能传 null / 非对象）。 */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/* ─────────────────── 工具 ─────────────────── */

export interface HardwareToolDeps {
  readonly engine: SimEngine
  readonly state: AssemblyState
  /** 本机 Python 解释器路径（探测结果），用于工具描述里如实说明。 */
  readonly pythonPath: string
}

export function createHardwareTools(deps: HardwareToolDeps): HardwareToolDefinition[] {
  const { engine, state } = deps

  return [
    /* ── ① 运行仿真 ── */
    {
      name: 'hw_run_simulation',
      description:
        '在虚拟硬件上运行一个真实的项目代码（Python）。' +
        '项目进程通过 shim 访问虚拟 I2C 设备；`duration` 是**虚拟时间秒数**，' +
        '加速模式下会远快于真实时间。返回项目输出与虚拟/真实耗时。' +
        (deps.pythonPath ? `本机 Python：${deps.pythonPath}` : '⚠️ 未探测到 Python 解释器。'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectPath: {
            type: 'string',
            description: '项目根目录（绝对路径）。',
          },
          entry: {
            type: 'string',
            description: '入口脚本（相对 projectPath）。默认 main.py。',
          },
          duration: {
            type: 'number',
            description: '**虚拟**时间长度（秒）。项目 sleep 再多也会在此处停下。',
          },
          mode: {
            type: 'string',
            enum: ['accelerated', 'realtime'],
            description: 'accelerated（默认，尽可能快）或 realtime（按真实节拍限速，便于观察）。',
          },
        },
        required: ['projectPath', 'duration'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            // ★ `SimRunResult.exitCode` 是 `number | null`（进程被信号杀死时为 null），
            //   写成 `integer` 会让**返回值校验**在 null 时失败。
            exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
            virtualElapsed: { type: 'number' },
            wallElapsedMs: { type: 'number' },
            log: { type: 'array', items: { type: 'string' } },
            message: { type: 'string' },
          },
          required: ['ok', 'reason', 'virtualElapsed', 'wallElapsedMs', 'log'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const lines = Array.isArray(result.log) ? (result.log as string[]) : []
          const head = lines.slice(0, 40).join('\n')
          const more = lines.length > 40 ? `\n…（共 ${String(lines.length)} 行，完整日志用 hw_get_sim_log 取）` : ''
          return text(
            `仿真结束：reason=${String(result.reason)} exitCode=${String(result.exitCode ?? 'null')}\n` +
              `虚拟耗时 ${Number(result.virtualElapsed ?? 0).toFixed(3)}s / 真实耗时 ${String(result.wallElapsedMs)}ms\n` +
              `--- 项目输出 ---\n${head}${more}`,
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const projectPath = typeof input.projectPath === 'string' ? input.projectPath : ''
        if (projectPath === '') throw new Error('hw_run_simulation 需要 projectPath')
        const duration = typeof input.duration === 'number' ? input.duration : Number.NaN
        if (!Number.isFinite(duration) || duration <= 0) {
          throw new Error('hw_run_simulation 的 duration 必须是正的秒数（虚拟时间）')
        }
        const mode: SimMode = input.mode === 'realtime' ? 'realtime' : 'accelerated'

        return engine.run({
          projectPath,
          ...(typeof input.entry === 'string' ? { entry: input.entry } : {}),
          duration,
          mode,
        })
      },
    },

    /* ── ② 注入故障 / 改变环境 ── */
    {
      name: 'hw_inject_fault',
      description:
        '在仿真运行期间（或运行前）对虚拟硬件注入故障或改变环境值。' +
        '用于验证项目的异常处理：例如 disconnect 后项目是否能观察到 OSError 并正确捕获。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: {
            type: 'string',
            description: '目标设备：设备/组件 id，或 "型号:地址" 形式（如 bme280:0x76）。',
          },
          type: {
            type: 'string',
            enum: [...FAULT_TYPES],
            description:
              'disconnect（拔线）| nack | busy | set_reading（强制读数，需配 readings）| clear（清除全部故障）',
          },
          readings: {
            type: 'object',
            additionalProperties: true,
            description: 'type=set_reading 时的目标值，如 {"temperature": -40}。',
          },
        },
        required: ['target', 'type'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            injected: { type: 'boolean' },
            target: { type: 'string' },
            type: { type: 'string' },
          },
          required: ['injected', 'target', 'type'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          return text(
            result.injected === true
              ? `已向 ${String(result.target)} 注入故障 ${String(result.type)}`
              : `未找到匹配 ${String(result.target)} 的设备 —— 故障未注入（检查设备是否已随装配创建）`,
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const target = typeof input.target === 'string' ? input.target : ''
        const type = typeof input.type === 'string' ? input.type : ''
        if (target === '' || type === '') throw new Error('hw_inject_fault 需要 target 与 type')

        const fault: DeviceFault = {
          type: type as DeviceFaultType,
          ...(input.readings !== undefined
            ? { readings: asRecord(input.readings) as Record<string, number> }
            : {}),
        }
        const injected = engine.injectFault(target, fault)
        return { injected, target, type }
      },
    },

    /* ── ③ 读仿真输出 ── */
    {
      name: 'hw_get_sim_log',
      description: '读取最近一次（或正在进行的）仿真的项目输出日志。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          tail: {
            type: 'integer',
            description: '只取最后 N 行。省略则返回全部（上限 2000 行）。',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            running: { type: 'boolean' },
            totalLines: { type: 'integer' },
            lines: { type: 'array', items: { type: 'string' } },
          },
          required: ['running', 'totalLines', 'lines'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const lines = Array.isArray(result.lines) ? (result.lines as string[]) : []
          return text(
            `${result.running === true ? '（仿真进行中）' : ''}共 ${String(result.totalLines)} 行：\n` +
              lines.join('\n'),
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const all = [...engine.log]
        const tail = typeof input.tail === 'number' && input.tail > 0 ? Math.floor(input.tail) : all.length
        return {
          running: engine.running,
          totalLines: all.length,
          lines: tail >= all.length ? all : all.slice(-tail),
        }
      },
    },

    /* ── ④ 装配状态速览（DS 观察拓扑用） ── */
    {
      name: 'hw_get_assembly',
      description:
        '读取当前装配状态（SSOT）的摘要：组件、连线、告警、供电、虚拟设备。' +
        '用于 DS 在运行仿真前确认"虚拟场景里到底连了什么"。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            revision: { type: 'integer' },
            components: { type: 'array', items: { type: 'object', additionalProperties: true } },
            connections: { type: 'array', items: { type: 'object', additionalProperties: true } },
            warnings: { type: 'array', items: { type: 'object', additionalProperties: true } },
            // ★ `AssemblySnapshot` 有 **6** 个字段 —— 早先漏了 `powerSummary`，
            //   而 `additionalProperties: false` 会让**每次调用都校验失败**。
            //   顶层逐字段声明（可校验），内层用 `additionalProperties: true` 放宽
            //   （子结构属于各契约的细节，逐一镜像必然漂移）。
            powerSummary: { type: 'object', additionalProperties: true },
            virtualDevices: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
          required: ['revision', 'components', 'connections', 'warnings', 'powerSummary', 'virtualDevices'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const components = (result.components as Array<Record<string, unknown>>) ?? []
          const connections = (result.connections as Array<Record<string, unknown>>) ?? []
          const warnings = (result.warnings as Array<Record<string, unknown>>) ?? []
          const devices = (result.virtualDevices as Array<Record<string, unknown>>) ?? []

          const lines = [
            `revision=${String(result.revision)}`,
            `组件（${String(components.length)}）：` +
              components.map((c) => `${String(c.id)}(${String(c.hardwareModel)})`).join(' '),
            `连线（${String(connections.length)}）：` +
              connections
                .map((c) => {
                  const from = asRecord(c.from)
                  const to = asRecord(c.to)
                  return `${String(from.componentId)}.${String(from.portId)}→${String(to.componentId)}.${String(to.portId)}[${String(c.protocol)}]`
                })
                .join(' '),
            `虚拟设备（${String(devices.length)}）：` +
              devices.map((d) => `${String(d.id)}:${String(d.label)}`).join(' ') || '（无）',
            // ★★ 告警必须**连 message 一起印**，不能只印 `severity/code`。
            //
            //   ⚠️ 原来只有 `info/unconnected_port info/i2c_pullup_missing` 这种标记 ——
            //     于是**聚合出来的那句话从来没离开过状态**：
            //     状态里是「Raspberry Pi 4B 36 个引脚未连接：P2, P4, P7, …」，
            //     而唯一读者看到的是「info/unconnected_port」。
            //     ⇒ 它拿到 2 条之后，**连"有 36 个引脚没接"都看不出来**，只能再去翻 `refs`。
            //
            //   ★ 这与"改了基数的数据结构要回头看计数的东西"是**同一个形状**：
            //     **修好了载荷，而通往唯一消费者的管道还在丢它。**
            //
            //   `refs` 不带（可能几百个），但**话得说出来** —— 截断到 120 字符。
            `告警（${String(warnings.length)}）：` +
              warnings
                .map((w) => {
                  const detail = String(w.message ?? '').trim()
                  const shown = detail.length > 120 ? `${detail.slice(0, 120)}…` : detail
                  return `${String(w.severity)}/${String(w.code)}${shown ? ` — ${shown}` : ''}`
                })
                .join('\n  ') || '（无）',
          ]
          return text(lines.join('\n'))
        },
      },
      execute: async () => state.snapshot(),
    },

    /* ── ★★ 修改装配：让 agent 真的能"创作 / 连线" ── */
    //
    // ⚠️⚠️ 这个工具补的是一个**真实缺口**：在此之前，`createHardwareTools` 只有
    //   **读**（`hw_get_assembly`）和**仿真**（`hw_run_simulation` 等）——
    //   **DS 没有任何办法放器件、连线、移动、旋转。**
    //   能力一直在宿主里（`/api/action` 那条路由，界面在用），**只是没暴露成工具**。
    //   ⇒ 别的用户装上这个插件后，他的 agent **只能看，不能动手**。
    //
    // ★ 为什么是**一个**工具而不是六个（`hw_place` / `hw_move` / `hw_connect` …）：
    //   这六个动词的参数形状**就是契约里的 `ClientAction` 联合**。
    //   拆成六个工具就得在六处重复维护"哪些参数合法"，而**契约一改就会漏**。
    //   一个工具 + 契约类型 ⇒ 加动作时这里**一行都不用改**。
    //
    //   ⚠️ 代价要说清楚：**这个工具对 LLM 比六个具名工具难用** ——
    //     它得自己拼对 action 的形状。所以下面把**每一种动作的样例**写进描述里，
    //     而且这件事**正是"技能（Skill）"要承担的**：工具给能力，技能给用法。
    {
      name: 'hw_edit_assembly',
      description:
        '修改虚拟装配（放器件 / 移动 / 旋转 / 连线 / 拔线 / 删除 / 钉住）。' +
        '`action` 就是契约里的 ClientAction，常用形状：\n' +
        '· 放器件 {"kind":"place_component","hardwareModel":"hc-sr501","position":{"x":0,"y":0.0108,"z":0}}\n' +
        '· 移动   {"kind":"move_component","componentId":"c2","position":{"x":0.05,"y":0.0108,"z":0}}\n' +
        '· 旋转   {"kind":"set_rotation","componentId":"c2","rotation":{"x":0,"y":1.5708,"z":0}}（弧度，绕自身中心）\n' +
        '· 连线   {"kind":"connect","from":{"componentId":"c2","portId":"OUT"},"to":{"componentId":"c1","portId":"E4"}}\n' +
        '· 拔线   {"kind":"disconnect","cableId":"w1"}\n' +
        '· 删除   {"kind":"remove_component","componentId":"c2"}\n' +
        '· 钉住   {"kind":"set_pinned","componentId":"c1","pinned":true}\n' +
        '★ 先 `hw_get_assembly` 看清有哪些组件与端口 id，再改。' +
        '★ 失败会给出**原因码**（如 protocol_mismatch / voltage_mismatch / port_occupied / component_pinned），' +
        '照着原因改，不要盲试。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'object',
            additionalProperties: true,
            description: '要执行的 ClientAction，见工具描述里的样例。',
          },
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
            revision: { type: 'number' },
          },
          required: ['ok', 'revision'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          if (result.ok !== true) {
            return text(`装配修改被拒：${String(result.reason ?? '未知原因')}（现在还是 revision=${String(result.revision)}）`)
          }
          return text(`装配已修改（revision=${String(result.revision)}）。用 hw_get_assembly 看结果。`)
        },
      },
      execute: async (args) => {
        const action = asRecord(asRecord(args).action)
        const result = state.applyAction(action as never)
        return { ok: result.ok, revision: state.revision, ...(result.reason !== undefined ? { reason: result.reason } : {}) }
      },
    },
  ]
}
