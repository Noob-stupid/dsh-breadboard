/**
 * **型号定义工具**（让 agent 能一键写/装一条型号定义）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要 agent 侧的工具，而不只是界面按钮
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 界面那个「添加型号定义」要用户**自己准备好 JSON**。而引脚表这件事，
 * **AI 恰恰比人快**（查手册、对齐字段、按丝印排布）—— 但前提是它**有工具可调**。
 * 没有工具，界面上的"让 AI 帮我写"就只是一句话术：**用户点了，agent 没有手**。
 *
 * ⇒ 这个工具就是那只手：`hw_save_model_definition`。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 与界面路由**共用同一段实现**（`installModelDefinition`）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 校验 → 撞内置检查 → 落盘 → 立即重载。两处各写一份迟早漂移，
 * 典型症状是"界面能装、agent 报错方式不同"，而用户不知道为什么。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 工具描述里必须写清的**纪律**（这是防"看起来对实际全错"的地方）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * · **引脚表要有权威来源**（厂商数据手册 / PlatformIO variant / CubeMX 数据库）。
 *   手打错的引脚表**比没有更坏** —— 它会产出"看起来对但接错脚"的校验。
 * · **不确定就停下来问用户**，不要编一个看起来合理的引脚顺序。
 * · 内置型号**不可覆盖**（撞名会被拒）。
 */

import { installModelDefinition, type ModelDefLoadResult } from '../core/models/definitions.ts'
import { asRecord, text, type HardwareToolDefinition } from './tools.ts'

export interface ModelDefToolDeps {
  /** 用户型号定义目录（落盘处）。 */
  readonly dir: string
  /** 立即重载（读目录，不必重载插件）。 */
  readonly reload: () => Promise<ModelDefLoadResult>
  /** 落盘用的最小 io（注入 ⇒ 测试可塞假的，不碰真实文件系统）。 */
  readonly writeFile: (file: string, text: string) => Promise<void>
  readonly mkdir: (dir: string) => Promise<void>
  readonly join: (dir: string, name: string) => string
}

export function createModelDefTools(deps: ModelDefToolDeps): HardwareToolDefinition[] {
  return [
    {
      name: 'hw_save_model_definition',
      description:
        '**保存一个型号定义**（数据驱动）—— 让插件认识一块新硬件：能摆、能按真实丝印连线、能校验电压/方向/I2C 上拉。' +
        '★ 校验通过才落盘，**落盘后立即生效**（不必重载插件）。' +
        '★ 形状（字段说明见插件包里的 `model-defs/example-8pin-module.json`）：\n' +
        '{\n' +
        '  key: "stm32f103c8t6"        （小写字母/数字/连字符；**不能与内置型号同名**）\n' +
        '  label: "STM32F103C8T6（Blue Pill）"\n' +
        '  size: { x: 0.0533, y: 0.011, z: 0.0229 }   （**米**，包围盒）\n' +
        '  powerDrawW: 0, powerSupplyW: 0\n' +
        '  ports: [{ portId:"P1", name:"VBAT", protocol:"power", voltage:3.3, direction:"in" }, ...]\n' +
        '  portLayout: { edge:"+z", pitch:0.00254, count:40, inset:0.001, rows:2, rowPitch:0.02292 }\n' +
        '}\n' +
        '★ `portId` 是**身份**（P1…P40），必须唯一 —— 一块板有多个 GND，用功能名当身份会撞号且**静默**。' +
        '`name` 才是丝印（GPIO23 / GND）。' +
        '★ `voltage: 0` 是**合法的**（那是 GND，不是没填）。' +
        '★ 端口要么给每个 `position`、要么给 `portLayout`（两者都缺会被拒）。' +
        '★★ **引脚表必须有权威来源**（厂商数据手册 / PlatformIO 的 variant 文件 / CubeMX 数据库）：' +
        '**手打错的引脚表比没有更坏** —— 它会产出"看起来对但接错脚"的校验，而没人能发现。' +
        '**不确定就停下来问用户**，不要编一个看起来合理的引脚顺序。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          definition: {
            type: 'object',
            additionalProperties: true,
            description: '完整的型号定义（见工具描述里的形状）。',
          },
        },
        required: ['definition'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            key: { type: 'string' },
            reason: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          // ★ 失败必须**看得见**（只渲染 message 会让 ok:false 输出空字符串）
          if (result.ok !== true) return text(`型号定义未保存：${String(result.reason ?? '未知原因')}`)
          return text(String(result.message ?? ''))
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const result = await installModelDefinition({
          dir: deps.dir,
          reload: deps.reload,
          definition: input.definition,
          writeFile: deps.writeFile,
          mkdir: deps.mkdir,
          join: deps.join,
        })
        if (!result.ok) return { ok: false, key: result.key ?? '', reason: result.reason ?? '未知原因' }
        const failures = result.outcome?.failures ?? []
        const rejected = result.outcome?.rejected ?? []
        return {
          ok: true,
          key: result.key ?? '',
          message:
            `已保存型号定义 ${String(result.key)}（${String(result.file)}）。\n` +
            '现在可以用 hw_edit_assembly({kind:"place_component", hardwareModel:"' +
            String(result.key) +
            '"}) 把它摆进场景，并按真实丝印连线。\n' +
            '★ 外观（.glb）是另一件事：用 hw_edit_assembly 摆上去后，在 ② 换装模型 里给它导模型。' +
            (failures.length + rejected.length === 0
              ? ''
              : `\n⚠️ 同时有 ${String(failures.length + rejected.length)} 条别的定义没装上（用 GET /api/catalog 或看日志）。`),
        }
      },
    },
  ]
}
