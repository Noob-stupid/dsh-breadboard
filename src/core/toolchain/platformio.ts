/**
 * **烧录适配器**（P3）—— 把固件烧到真板上（走 PlatformIO）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 两条纪律（这个项目反复吃过的亏）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 1. **`exit 0` ≠ "板子真的重启了"。**
 *    PlatformIO 退出 0 只说明**它那侧的上传工具报告成功** —— 那是**证据**，不是结论。
 *    ⇒ 返回值里分开写："上传工具报告成功" + "这不证明板子重启了（要看串口/服务端）"。
 *    本项目失败族里 `ok:true ≠ 效果发生` 就是这个形状。
 *
 * 2. **失败要把日志尾部带回来。**
 *    "烧录失败"四个字对排查毫无用处；用户需要看到 `esptool` 到底说了什么
 *    （找不到端口 / 校验失败 / 芯片型号不符）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 找不到 CLI / 没有端口 —— **说清缺什么**，不要静默
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 本机实测：PlatformIO **装是装了**（`C:\.platformio\penv\Scripts\platformio.exe`，
 * Core 6.1.19），但**不在 PATH** ⇒ 只看 PATH 会得出"没装"的**错误结论**。
 */

/** 运行一个外部命令的结果（注入 ⇒ 可测）。 */
export interface ToolRunResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export interface ToolchainIo {
  readonly exists: (path: string) => Promise<boolean>
  readonly join: (...parts: string[]) => string
  /** 运行命令。★ 不抛：非 0 退出是**正常返回值**，由调用方判断。 */
  readonly run: (command: string, args: readonly string[], cwd: string) => Promise<ToolRunResult>
}

/** 烧录结果。 */
export interface FlashResult {
  readonly ok: boolean
  /** 上传工具报告的退出码（`ok:false` 时也要给）。 */
  readonly exitCode?: number
  /** 用的 CLI 路径（**出处** —— 出问题时要能复现）。 */
  readonly cli?: string
  /** 人类可读结论（含"这不证明什么"）。 */
  readonly summary: string
  /** 日志尾部（失败时最关键）。 */
  readonly logTail?: string
}

/**
 * PlatformIO CLI 的候选路径。
 *
 * ★ 按**用户路径**优先（env → 主目录 → 平台惯例），不写死本机路径。
 * ★ 本机实测：装在 `C:\.platformio\penv\Scripts\`，**不在 PATH** ——
 *   所以候选里必须有这些位置，否则会误判成"没装"。
 */
export function platformioCliCandidates(
  env: Record<string, string | undefined>,
  home: string,
  platform: string,
): string[] {
  const exe = platform === 'win32' ? 'platformio.exe' : 'platformio'
  const roots: string[] = []
  const fromEnv = env.PLATFORMIO_CORE_DIR
  if (fromEnv !== undefined && fromEnv !== '') roots.push(fromEnv)
  roots.push(`${home}/.platformio`)
  if (env.USERPROFILE !== undefined && env.USERPROFILE !== '') roots.push(`${env.USERPROFILE}\\.platformio`)
  roots.push('C:\\.platformio')
  const bins = platform === 'win32' ? ['penv/Scripts', 'penv/bin'] : ['penv/bin', 'penv/Scripts']
  const out: string[] = []
  for (const root of roots) {
    for (const bin of bins) out.push(`${root.replace(/\\/g, '/')}/${bin}/${exe}`)
  }
  return [...new Set(out)]
}

/** 找到第一个存在的 CLI；都没有则 `undefined`（调用方据此说清"没装/在哪装"）。 */
export async function findPlatformioCli(candidates: readonly string[], io: ToolchainIo): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await io.exists(candidate)) return candidate
  }
  return undefined
}

/** 取日志尾部（失败时给人看的是最后几行，不是开头）。 */
export function tail(text: string, lines = 12): string {
  const all = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  return all.slice(-lines).join('\n')
}

/**
 * **烧录**：`pio run -t upload`（可选 `-e <env>` / `--upload-port <port>`）。
 *
 * ★ 参数拼装与判定都收在这里 ⇒ 工具层只负责把结果说清楚。
 */
export async function flashFirmware(input: {
  readonly cli: string
  readonly projectDir: string
  readonly environment?: string
  readonly port?: string
  readonly io: ToolchainIo
}): Promise<FlashResult> {
  const args = ['run', '-t', 'upload']
  if (input.environment !== undefined && input.environment !== '') args.push('-e', input.environment)
  if (input.port !== undefined && input.port !== '') args.push('--upload-port', input.port)

  let result: ToolRunResult
  try {
    result = await input.io.run(input.cli, args, input.projectDir)
  } catch (error) {
    return {
      ok: false,
      cli: input.cli,
      summary: `起不了 PlatformIO：${String(error instanceof Error ? error.message : error)}`,
    }
  }

  const combined = `${result.stdout}\n${result.stderr}`
  if (result.exitCode !== 0) {
    return {
      ok: false,
      exitCode: result.exitCode,
      cli: input.cli,
      summary:
        `烧录失败（退出码 ${String(result.exitCode)}）。★ 常见原因：板子没插 / 端口被占用 / ` +
        '串口驱动没装 / 芯片型号与工程不符。下面是要看的日志尾部。',
      logTail: tail(combined),
    }
  }

  return {
    ok: true,
    exitCode: 0,
    cli: input.cli,
    summary:
      '上传工具**报告成功**（退出码 0）。' +
      '⚠️ 这**不证明**板子真的重启并跑起来了 —— 那是另一件事，要看串口输出或服务端是否收到上报。',
    logTail: tail(combined, 6),
  }
}
