/**
 * **工具链工具**（P3）—— 让 agent 能把固件烧到真板上。
 *
 * ★ 适配器在 `core/toolchain/platformio.ts`（纯逻辑、已测）；这里只负责：
 *   找到 CLI → 说清缺什么 → 把结果**照实**转给 agent（含"这不证明什么"）。
 */

import {
  findPlatformioCli,
  flashFirmware,
  type ToolchainIo,
} from '../core/toolchain/platformio.ts'
import { asRecord, text, type HardwareToolDefinition } from './tools.ts'

export interface ToolchainToolDeps {
  /** PlatformIO CLI 的候选路径（用户路径优先，见适配器里的说明）。 */
  readonly cliCandidates: readonly string[]
  readonly io: ToolchainIo
}

export function createToolchainTools(deps: ToolchainToolDeps): HardwareToolDefinition[] {
  return [
    {
      name: 'hw_flash_firmware',
      description:
        '**把固件烧到真板上**（走 PlatformIO 的 `pio run -t upload`）。' +
        '★ 需要：本机装了 PlatformIO（**不在 PATH 也行** —— 会去常见安装位找）、板子插在电脑上、' +
        '工程目录里有 `platformio.ini`。' +
        '★★ **`exit 0` 只说明"上传工具报告成功"，不证明板子重启并跑起来了** —— ' +
        '要确认那件事，看串口输出（hw_read_serial）或外部系统是否收到上报。' +
        '★ 失败会把**日志尾部**带回来（真正的原因通常是 esptool 最后那几行），' +
        '并列出常见原因：板子没插 / 端口被占用 / 串口驱动没装 / 芯片型号与工程不符。' +
        '★ 烧录是**墙钟**操作（十几秒到几分钟），不能用虚拟时钟加速。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectPath: { type: 'string', description: 'PlatformIO 工程目录（含 platformio.ini）的绝对路径' },
          port: { type: 'string', description: '上传端口，如 COM7（不填则用 PlatformIO 自己找的）' },
          environment: { type: 'string', description: 'platformio.ini 里的 env 名（如 esp32dev），不填用默认' },
        },
        required: ['projectPath'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            reason: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['ok'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          if (result.ok !== true) return text(`烧录未完成：${String(result.reason ?? '未知原因')}`)
          return text(String(result.message ?? ''))
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const projectPath = typeof input.projectPath === 'string' ? input.projectPath : ''
        if (projectPath === '') return { ok: false, reason: '需要 projectPath（PlatformIO 工程目录）' }
        if (!(await deps.io.exists(projectPath))) {
          return { ok: false, reason: `工程目录不存在：${projectPath}` }
        }

        const cli = await findPlatformioCli(deps.cliCandidates, deps.io)
        if (cli === undefined) {
          // ★ 说清"找过哪些地方" —— 否则用户只会看到"没装"，而它可能装在别处
          return {
            ok: false,
            reason:
              '没找到 PlatformIO CLI。找过这些位置：\n  ' +
              deps.cliCandidates.join('\n  ') +
              '\n★ 装好了但装在别处 ⇒ 设环境变量 PLATFORMIO_CORE_DIR 指向它。',
          }
        }

        const port = typeof input.port === 'string' ? input.port : undefined
        const environment = typeof input.environment === 'string' ? input.environment : undefined
        const result = await flashFirmware({
          cli,
          projectDir: projectPath,
          ...(port !== undefined && port !== '' ? { port } : {}),
          ...(environment !== undefined && environment !== '' ? { environment } : {}),
          io: deps.io,
        })

        if (!result.ok) {
          return {
            ok: false,
            reason: `${result.summary}\nCLI：${result.cli ?? cli}\n--- 日志尾部 ---\n${result.logTail ?? '（没有输出）'}`,
          }
        }
        return {
          ok: true,
          message: `${result.summary}\nCLI：${result.cli ?? cli}\n--- 日志尾部 ---\n${result.logTail ?? ''}`,
        }
      },
    },
  ]
}
