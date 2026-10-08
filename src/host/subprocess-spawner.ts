/**
 * 宿主 `subprocess` → {@link SimSpawner} 适配器（设计文档 §10 薄适配层）
 * @module dsh-hardware-sandbox/host/subprocess-spawner
 *
 * ★ 与 `routes.ts` / `tools.ts` 同属适配层：**结构等价**宿主类型，不 import 宿主包。
 *   §10.3 要求内核零依赖宿主 API；宿主接口若改名，改动收敛在本文件。
 *
 * ── 这个适配器要解决的三个**真实差异**（每一个做错了都很难查） ──
 *
 * ① **宿主刻意不暴露进程身份。**
 *    服务契约原文："Target identity remains provider-private" —— `SubprocessHandle` 上
 *    **没有 `pid`**（只有 `SubprocessTerminalHandle` 有）。所以这里**不编造** pid，
 *    拿不到就留空，由引擎决定不打印。编一个 `-1` 出来只会让日志**看着像诊断信息、实际是垃圾**。
 *
 * ② **流 vs 回调。**
 *    宿主给的是 `Readable` 流，引擎要的是 `onStdout/onStderr(text)` 回调。
 *    而且**必须按行切**：`bridge_client.py` 的 `log()` 文档写明"把**一行**日志上报给宿主"，
 *    所以引擎 `log` 数组的语义是**行**。若把原始 chunk 直接塞进去，
 *    `hw_get_sim_log` 的 `totalLines` 会变成"chunk 数"——数字看着正常，含义是错的。
 *    ⇒ 用 {@link LineSplitter} 缓冲半行，流结束时 flush 尾行。
 *
 * ③ **`done` 的语义比"进程退出"要宽。**
 *    宿主 `done` 只保证"退出事实"，**不保证 stdout 已经排空**。
 *    直接透传会**丢掉最后几行输出**（恰恰是最关键的报错）。
 *    ⇒ `done` 等**进程退出 + 两条流都结束**，两者齐了才解析。
 *
 * ★ `resolveExecutable` 存在的意义：宿主明确要求可执行文件在**它自己的执行世界**里解析
 *   （"Absolute paths are verified; bare names use the provider's scrubbed PATH"）。
 *   自己去拼 PATH 在远程/容器执行世界里必然错。所以这里先解析、再 spawn。
 */
import type { Readable } from 'node:stream'

import type { SimProcessHandle, SimSpawner } from '../core/sim/engine.ts'

/* ─────────────────── 结构等价的宿主类型 ─────────────────── */

interface SubprocessOutcomeLike {
  readonly exitCode: number | null
}

interface SubprocessHandleLike {
  readonly stdout?: Readable | undefined
  readonly stderr?: Readable | undefined
  readonly done: Promise<SubprocessOutcomeLike>
  terminate(): void
}

interface SubprocessSpawnSpecLike {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly stdio: {
    readonly stdin: 'ignore' | 'pipe' | { readonly data: string }
    readonly stdout: unknown
    readonly stderr: unknown
    readonly control?: 'pipe'
  }
  readonly graceMs: number
  readonly signal?: AbortSignal | undefined
  readonly env?: Record<string, string | undefined> | undefined
}

/** 结构等价于宿主 `subprocess` 服务（只用到这两个方法）。 */
export interface SubprocessLike {
  /**
   * 在宿主的执行世界里解析可执行文件。
   *
   * **可选**：老版本宿主可能没有它，那时退化为"原样使用 argv[0]"。
   * 不做硬依赖 —— 缺了它仿真仍应能跑（只是少了路径校验）。
   */
  resolveExecutable?(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string>
  spawn(spec: SubprocessSpawnSpecLike): SubprocessHandleLike
}

export interface SubprocessSpawnerOptions {
  /**
   * 终止宽限期（毫秒）—— 交给宿主的进程树级终止流程。
   * 默认 3000：足够 Python 跑完 `finally` 里的清理，又不至于让一次卡死的仿真拖太久。
   */
  readonly graceMs?: number
}

/* ─────────────────── 按行切分 ─────────────────── */

/**
 * 把任意切分的文本块还原成**行**。
 *
 * ★ 为什么不能直接 `chunk.split('\n')`：chunk 边界**与行边界无关**，
 *   一次 read 可能切在行中间。不缓冲就会把一行劈成两条日志（或多行并成一条）。
 */
export class LineSplitter {
  #buffer = ''
  readonly #emit: (line: string) => void

  constructor(emit: (line: string) => void) {
    this.#emit = emit
  }

  push(chunk: string): void {
    this.#buffer += chunk
    let index = this.#buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.#buffer.slice(0, index)
      this.#buffer = this.#buffer.slice(index + 1)
      // Windows 的 \r\n：把行尾的 \r 去掉，否则日志里会多一个不可见字符
      this.#emit(line.endsWith('\r') ? line.slice(0, -1) : line)
      index = this.#buffer.indexOf('\n')
    }
  }

  /** 流结束时把没有换行符的尾行吐出来（否则最后一行永远丢失）。 */
  flush(): void {
    if (this.#buffer === '') return
    const rest = this.#buffer
    this.#buffer = ''
    this.#emit(rest.endsWith('\r') ? rest.slice(0, -1) : rest)
  }
}

/* ─────────────────── Python 解释器探测 ─────────────────── */

export interface PythonProbeResult {
  /** 解析后的可执行文件绝对路径。 */
  readonly path: string
  /** `Python 3.14.2` 里的版本号部分。 */
  readonly version: string
}

/** 默认探测顺序。 */
export const DEFAULT_PYTHON_CANDIDATES: readonly string[] = ['python', 'python3']

/** 从 `--version` 输出里抠版本号。匹配不到就说明这**不是**一个能用的解释器。 */
const VERSION_PATTERN = /Python\s+(\d+\.\d+\.\d+)/

/**
 * 探测一个可用的 Python 解释器。
 *
 * ★★ **为什么"解析得到"还不够，必须真跑一次 `--version`**：
 *   Windows 上 `python3` 常常解析到
 *   `%LOCALAPPDATA%\Microsoft\WindowsApps\python3.exe` —— 那是个**应用商店占位存根**，
 *   不是解释器。`resolveExecutable` 会**成功地**返回它（它确实存在于 PATH 上），
 *   但一跑就打印"Python was not found…"并以非零码退出。
 *
 *   实测本机：`python` → `E:\python314\python.exe`（真的 3.14.2）；
 *            `python3` → WindowsApps 存根（假的）。
 *   ⇒ 若只按"解析成功"取第一个候选，会**优先选中那个假的**，
 *     之后每一次仿真都以一个看不懂的退出码失败。所以探测必须**验证行为**。
 *
 * ★ `preferred` 非空时**只用它，不回落**：用户显式配置了路径，
 *   悄悄换一个解释器会让"我配的那个为什么不生效"变成一个查不出的问题。
 *   失败就如实返回 undefined，由调用方给出可操作的提示。
 *
 * @returns 找到可用解释器时返回它；一个都不行则 `undefined`（**不抛**）。
 */
export async function probePythonInterpreter(
  subprocess: SubprocessLike,
  options: {
    readonly preferred?: string
    readonly candidates?: readonly string[]
    readonly timeoutMs?: number
  } = {},
): Promise<PythonProbeResult | undefined> {
  const preferred = options.preferred?.trim()
  const candidates =
    preferred !== undefined && preferred !== ''
      ? [preferred]
      : (options.candidates ?? DEFAULT_PYTHON_CANDIDATES)
  const timeoutMs = options.timeoutMs ?? 10_000

  for (const candidate of candidates) {
    let executable: string
    try {
      executable =
        subprocess.resolveExecutable !== undefined
          ? await subprocess.resolveExecutable(candidate)
          : candidate
    } catch {
      continue // 解析不了就试下一个
    }

    try {
      const output = await runCapture(subprocess, executable, ['--version'], timeoutMs)
      const match = VERSION_PATTERN.exec(output)
      // ★ 拿不到版本号 ⇒ 这不是解释器（存根/损坏的安装），**继续试下一个**
      if (match?.[1] !== undefined) return { path: executable, version: match[1] }
    } catch {
      continue
    }
  }
  return undefined
}

/** 跑一个短命令并把 stdout+stderr 收成文本。 */
function runCapture(
  subprocess: SubprocessLike,
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let text = ''
    const handle = subprocess.spawn({
      argv: [executable, ...args],
      cwd: process.cwd(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 1000,
      env: { ...process.env },
    })
    const collect = (stream: Readable | undefined): void => {
      if (stream === undefined) return
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string | Buffer) => {
        text += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      })
    }
    collect(handle.stdout)
    collect(handle.stderr)

    const timer = setTimeout(() => {
      try {
        handle.terminate()
      } catch {
        // 终止失败也要让 promise 落地，否则探测会挂住插件启动
      }
      reject(new Error(`探测超时（${String(timeoutMs)}ms）：${executable}`))
    }, timeoutMs)

    // ★★ **必须等流排空，不能只等 `done`。**
    //   宿主 `done` 只保证"退出事实"，此刻 `'data'` 可能还没投递完 ⇒ `text` 是空的
    //   ⇒ 一个**明明可用**的解释器被判成不可用。这是静默误判：没有任何报错，
    //   只是仿真"莫名其妙"跑不起来。与适配器里 `done` 的处理是同一个道理。
    void Promise.all([
      handle.done,
      streamEnded(handle.stdout),
      streamEnded(handle.stderr),
    ]).then(
      () => {
        clearTimeout(timer)
        resolve(text)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

/**
 * 等一条流结束。
 *
 * ★ `'end'` / `'close'` / `'error'` **三个都要挂**（同一个幂等的 settle）：
 *   · `'end'` 是正常排空
 *   · `'close'` 覆盖被终止、没有 `'end'` 的情况
 *   · `'error'` 防止 promise **永不解析** —— 那会让 `done` 挂住，
 *     表现为仿真"卡死到墙钟兜底超时"，比直接报错难查得多
 */
function streamEnded(stream: Readable | undefined): Promise<void> {
  if (stream === undefined) return Promise.resolve()
  if (stream.readableEnded) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const settle = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    stream.once('end', settle)
    stream.once('close', settle)
    stream.once('error', settle)
  })
}

/* ─────────────────── 适配器 ─────────────────── */

/**
 * 把宿主的 `subprocess` 服务包成引擎要的 {@link SimSpawner}。
 *
 * 返回的函数**可能抛**（argv 为空、可执行文件解析失败）—— 引擎在 `try` 里调用它，
 * 会把失败如实报成 `reason='error'`，不会静默。
 */
export function createSubprocessSpawner(
  subprocess: SubprocessLike,
  options: SubprocessSpawnerOptions = {},
): SimSpawner {
  const graceMs = options.graceMs ?? 3000

  return async (request): Promise<SimProcessHandle> => {
    const [command, ...rest] = request.argv
    if (command === undefined || command === '') {
      throw new Error('SimSpawner：argv 为空 —— 无法确定要运行的可执行文件')
    }

    // ① 在执行世界里解析可执行文件。解析不了就**当场抛**，
    //    而不是等子进程以一个看不懂的错误码退出。
    let executable = command
    if (subprocess.resolveExecutable !== undefined) {
      executable = await subprocess.resolveExecutable(command, { ...request.env })
    }

    // ② 起进程。stdout/stderr 用 'pipe' —— 引擎要的是流式回调，不是收集式读取。
    //
    // ★ env 显式合并 `process.env`：宿主契约说 spawn "applies no defaults"，
    //   而子进程需要 PATH 等基础变量（Windows 上还关系到 DLL 查找）。
    //   只传我们那 4 个变量会让 Python 起不来 —— 而症状是"进程立刻退出、日志空白"，
    //   极难归因。合并是**严格更安全**的选择。
    const handle = subprocess.spawn({
      argv: [executable, ...rest],
      cwd: request.cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs,
      env: { ...process.env, ...request.env },
    })

    // ③ 流 → 按行回调
    const wire = (stream: Readable | undefined, emit: (line: string) => void): Promise<void> => {
      if (stream === undefined) return Promise.resolve()
      const splitter = new LineSplitter(emit)
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string | Buffer) => {
        splitter.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
      })
      // 流结束后补吐没有换行符的尾行 —— 否则最后一行永远丢失
      return streamEnded(stream).then(() => {
        splitter.flush()
      })
    }

    const stdoutDone = wire(handle.stdout, request.onStdout)
    const stderrDone = wire(handle.stderr, request.onStderr)

    return {
      // ★ 不给 pid：宿主刻意不暴露进程身份。见文件头 ①。
      done: (async () => {
        const outcome = await handle.done
        // ③ 等流排空，否则**丢掉最后几行**（通常正是报错那几行）
        await Promise.all([stdoutDone, stderrDone])
        return { exitCode: outcome.exitCode }
      })(),
      terminate: () => {
        handle.terminate()
      },
    }
  }
}
