/**
 * `subprocess-spawner` 适配器的测试
 *
 * ★ 这个文件专门盯住**三处"看起来对、实际错"**的地方（本项目失败族的形态）：
 *   ① 日志按**行**还是按 **chunk** —— 后者会让 `totalLines` 数字正常但含义是错的
 *   ② `done` 是否等到**流排空** —— 不等就会丢掉最后几行（通常正是报错那几行）
 *   ③ 探测 Python 时是否**真跑一次** —— 只看"解析成功"会选中 WindowsApps 存根
 */
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { test } from 'node:test'

import {
  LineSplitter,
  createSubprocessSpawner,
  probePythonInterpreter,
  type SubprocessLike,
} from '../src/host/subprocess-spawner.ts'

/* ─────────────────── 可控的假 subprocess ─────────────────── */

/** 手动驱动的可读流 —— 让测试能精确控制"先退出、后吐最后一行"这种时序。 */
class ManualStream extends Readable {
  override _read(): void {
    // 数据由测试手动 push，不需要拉取
  }
  pushText(text: string): void {
    this.push(text)
  }
  endStream(): void {
    this.push(null)
  }
}

/**
 * 让出一轮事件循环。
 *
 * ★ 必须等：`Readable` 的 `'data'` 是**异步投递**的，`push()` 之后立刻断言会看到空数组
 *   —— 那样测试会"因为观测太早"而失败，而不是因为代码错。（反过来也要小心：
 *   一个**永远**不 await 的断言会让真正的异步 bug 溜过去。）
 */
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface FakeProgram {
  readonly exitCode?: number | null
  /** 关闭 stdout 之前是否先触发进程退出（用来测"流排空"时序）。 */
  readonly exitBeforeEnd?: boolean
}

interface FakeSpawnRecord {
  readonly argv: readonly string[]
  readonly cwd: string
  readonly env: Record<string, string | undefined> | undefined
  readonly graceMs: number
  readonly stdout: ManualStream
  readonly stderr: ManualStream
  /** 触发"进程退出"。 */
  exit(): void
}

interface FakeHarness {
  readonly subprocess: SubprocessLike
  readonly records: FakeSpawnRecord[]
  readonly resolved: string[]
}

function makeHarness(options: {
  /** command → 解析后的绝对路径。缺省视为解析失败。 */
  readonly resolvable?: Record<string, string>
  readonly program?: FakeProgram
} = {}): FakeHarness {
  const records: FakeSpawnRecord[] = []
  const resolved: string[] = []

  const subprocess: SubprocessLike = {
    resolveExecutable: (command: string) => {
      const hit = options.resolvable?.[command]
      if (hit === undefined) return Promise.reject(new Error(`cannot resolve ${command}`))
      resolved.push(command)
      return Promise.resolve(hit)
    },
    spawn: (spec) => {
      const stdout = new ManualStream()
      const stderr = new ManualStream()
      let settle: ((value: { exitCode: number | null }) => void) | undefined
      const done = new Promise<{ exitCode: number | null }>((resolve) => {
        settle = resolve
      })
      const record: FakeSpawnRecord = {
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env,
        graceMs: spec.graceMs,
        stdout,
        stderr,
        exit: () => {
          settle?.({ exitCode: options.program?.exitCode ?? 0 })
        },
      }
      records.push(record)
      return { stdout, stderr, done, terminate: () => undefined }
    },
  }

  return { subprocess, records, resolved }
}

/* ─────────────────── ① LineSplitter ─────────────────── */

test('LineSplitter：跨 chunk 的半行会被缓冲，不会劈成两条', () => {
  const lines: string[] = []
  const splitter = new LineSplitter((line) => lines.push(line))

  splitter.push('hel')
  splitter.push('lo\nwor')
  splitter.push('ld\n')

  assert.deepEqual(lines, ['hello', 'world'], 'chunk 边界与行边界无关，必须缓冲')
})

test('LineSplitter：一个 chunk 里的多行会被逐条吐出', () => {
  const lines: string[] = []
  new LineSplitter((line) => lines.push(line)).push('a\nb\nc\n')
  assert.deepEqual(lines, ['a', 'b', 'c'])
})

test('LineSplitter：CRLF 行尾不留 \\r（否则日志里多一个不可见字符）', () => {
  const lines: string[] = []
  new LineSplitter((line) => lines.push(line)).push('a\r\nb\r\n')
  assert.deepEqual(lines, ['a', 'b'])
})

test('LineSplitter：flush 吐出没有换行符的尾行（否则最后一行永远丢）', () => {
  const lines: string[] = []
  const splitter = new LineSplitter((line) => lines.push(line))
  splitter.push('no newline at end')
  assert.deepEqual(lines, [], '还没有换行符 ⇒ 此时不该吐')
  splitter.flush()
  assert.deepEqual(lines, ['no newline at end'])
})

test('LineSplitter：flush 在空缓冲上是无操作（重复 flush 不产生空行）', () => {
  const lines: string[] = []
  const splitter = new LineSplitter((line) => lines.push(line))
  splitter.push('x\n')
  splitter.flush()
  splitter.flush()
  assert.deepEqual(lines, ['x'])
})

/* ─────────────────── ② createSubprocessSpawner ─────────────────── */

test('spawner：先解析可执行文件，再用解析后的路径 spawn', async () => {
  const harness = makeHarness({ resolvable: { python: 'C:/py/python.exe' } })
  const spawner = createSubprocessSpawner(harness.subprocess)

  const handle = await spawner({
    argv: ['python', 'main.py', '--flag'],
    cwd: 'C:/proj',
    env: { PYTHONPATH: 'x' },
    onStdout: () => undefined,
    onStderr: () => undefined,
  })

  assert.deepEqual(harness.resolved, ['python'])
  assert.equal(harness.records.length, 1)
  assert.deepEqual(
    harness.records[0]?.argv,
    ['C:/py/python.exe', 'main.py', '--flag'],
    'argv[0] 必须换成解析后的绝对路径，其余参数原样保留',
  )
  assert.equal(harness.records[0]?.cwd, 'C:/proj')

  harness.records[0]?.exit()
  harness.records[0]?.stdout.endStream()
  harness.records[0]?.stderr.endStream()
  await handle.done
})

test('spawner：stdout 按**行**回调（不是按 chunk）', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const spawner = createSubprocessSpawner(harness.subprocess)

  const lines: string[] = []
  const handle = await spawner({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: (line) => lines.push(line),
    onStderr: () => undefined,
  })

  const record = harness.records[0]
  assert.ok(record)
  // 故意切在行中间，模拟真实的 read 边界
  record.stdout.pushText('第一')
  record.stdout.pushText('行\n第二行\n残')
  await tick()
  assert.deepEqual(lines, ['第一行', '第二行'], '半行必须留到下一块，不能提前吐')

  record.exit()
  record.stdout.endStream()
  record.stderr.endStream()
  await handle.done

  assert.deepEqual(lines, ['第一行', '第二行', '残'], '尾行在流结束时补吐')
})

test('spawner：stderr 走 onStderr，不混进 stdout', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const spawner = createSubprocessSpawner(harness.subprocess)

  const out: string[] = []
  const err: string[] = []
  const handle = await spawner({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: (line) => out.push(line),
    onStderr: (line) => err.push(line),
  })

  const record = harness.records[0]
  assert.ok(record)
  record.stdout.pushText('正常输出\n')
  record.stderr.pushText('错误输出\n')

  record.exit()
  record.stdout.endStream()
  record.stderr.endStream()
  await handle.done

  assert.deepEqual(out, ['正常输出'])
  assert.deepEqual(err, ['错误输出'])
})

test('★ spawner：done 等到流排空 —— 进程先退出也不能丢最后几行', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const spawner = createSubprocessSpawner(harness.subprocess)

  const lines: string[] = []
  const handle = await spawner({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: (line) => lines.push(line),
    onStderr: () => undefined,
  })

  const record = harness.records[0]
  assert.ok(record)

  // ★ 关键时序：**进程先退出**，输出随后才排空。
  //   宿主 `done` 只保证"退出事实"，直接透传就会在这里丢掉 traceback。
  record.exit()
  record.stdout.pushText('Traceback (most recent call last):\n')
  record.stdout.pushText('ValueError: boom\n')
  record.stdout.endStream()
  record.stderr.endStream()

  await handle.done
  assert.deepEqual(
    lines,
    ['Traceback (most recent call last):', 'ValueError: boom'],
    'done 解析时最后几行必须已经在 log 里',
  )
})

test('spawner：不给 pid（宿主刻意不暴露进程身份，不许编假值）', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const handle = await createSubprocessSpawner(harness.subprocess)({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: () => undefined,
    onStderr: () => undefined,
  })
  assert.equal(handle.pid, undefined)

  harness.records[0]?.exit()
  harness.records[0]?.stdout.endStream()
  harness.records[0]?.stderr.endStream()
  await handle.done
})

test('spawner：env 合并 process.env（只传那 4 个变量会让 Python 起不来）', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const handle = await createSubprocessSpawner(harness.subprocess)({
    argv: ['python'],
    cwd: '.',
    env: { PYTHONPATH: 'shim' },
    onStdout: () => undefined,
    onStderr: () => undefined,
  })

  const env = harness.records[0]?.env
  assert.equal(env?.PYTHONPATH, 'shim', '我们的变量必须生效')
  // ⚠️ Windows 上这个变量叫 `Path` 而不是 `PATH`（Node 的 env 对象**保留原始大小写**）。
  //    只查大写会得到 undefined，然后误判成"没继承" —— 测试自己踩的坑。
  const pathValue = env?.PATH ?? env?.Path
  assert.notEqual(pathValue, undefined, '基础变量必须继承，否则子进程起不来')

  harness.records[0]?.exit()
  harness.records[0]?.stdout.endStream()
  harness.records[0]?.stderr.endStream()
  await handle.done
})

test('spawner：argv 为空时当场抛（不静默起一个空命令）', async () => {
  const harness = makeHarness()
  await assert.rejects(
    () =>
      createSubprocessSpawner(harness.subprocess)({
        argv: [],
        cwd: '.',
        env: {},
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
    /argv 为空/,
  )
  assert.equal(harness.records.length, 0, '不该 spawn 出任何东西')
})

test('spawner：解析失败时抛，而不是起一个必然失败的进程', async () => {
  const harness = makeHarness() // resolvable 为空 ⇒ 解析必失败
  await assert.rejects(
    () =>
      createSubprocessSpawner(harness.subprocess)({
        argv: ['python'],
        cwd: '.',
        env: {},
        onStdout: () => undefined,
        onStderr: () => undefined,
      }),
  )
  assert.equal(harness.records.length, 0)
})

test('spawner：宿主没有 resolveExecutable 时退化为原样使用 argv[0]', async () => {
  const records: string[][] = []
  const bare: SubprocessLike = {
    spawn: (spec) => {
      records.push([...spec.argv])
      const stdout = new ManualStream()
      const stderr = new ManualStream()
      stdout.push(null)
      stderr.push(null)
      return { stdout, stderr, done: Promise.resolve({ exitCode: 0 }), terminate: () => undefined }
    },
  }

  const handle = await createSubprocessSpawner(bare)({
    argv: ['python', 'main.py'],
    cwd: '.',
    env: {},
    onStdout: () => undefined,
    onStderr: () => undefined,
  })
  await handle.done

  assert.deepEqual(records, [['python', 'main.py']], '没有解析能力时不该自作主张改路径')
})

test('spawner：graceMs 可配，默认 3000', async () => {
  const harness = makeHarness({ resolvable: { python: 'py' } })
  const handle = await createSubprocessSpawner(harness.subprocess)({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: () => undefined,
    onStderr: () => undefined,
  })
  assert.equal(harness.records[0]?.graceMs, 3000)

  harness.records[0]?.exit()
  harness.records[0]?.stdout.endStream()
  harness.records[0]?.stderr.endStream()
  await handle.done

  const harness2 = makeHarness({ resolvable: { python: 'py' } })
  await createSubprocessSpawner(harness2.subprocess, { graceMs: 123 })({
    argv: ['python'],
    cwd: '.',
    env: {},
    onStdout: () => undefined,
    onStderr: () => undefined,
  })
  assert.equal(harness2.records[0]?.graceMs, 123)
})

/* ─────────────────── ③ probePythonInterpreter ─────────────────── */

/** 造一个"跑 --version 会打印 versionText"的假 subprocess。 */
function versionHarness(programs: Record<string, string>): SubprocessLike {
  return {
    resolveExecutable: (command: string) =>
      command in programs ? Promise.resolve(command) : Promise.reject(new Error('nope')),
    spawn: (spec) => {
      const stdout = new ManualStream()
      const stderr = new ManualStream()
      const text = programs[spec.argv[0] ?? ''] ?? ''
      stdout.push(text)
      stdout.push(null)
      stderr.push(null)
      return { stdout, stderr, done: Promise.resolve({ exitCode: 0 }), terminate: () => undefined }
    },
  }
}

test('probe：找到真的解释器就返回路径与版本', async () => {
  const found = await probePythonInterpreter(versionHarness({ python: 'Python 3.14.2\n' }))
  assert.deepEqual(found, { path: 'python', version: '3.14.2' })
})

test('★ probe：解析得到但**不是解释器**的候选必须被跳过（WindowsApps 存根）', async () => {
  // 本机实测：`python` 是真的，`python3` 解析到应用商店占位存根 ——
  // 它**能被解析**（确实在 PATH 上），但一跑就打印"Python was not found"。
  // 只看"解析成功"就会优先选中假的，之后每次仿真都以看不懂的退出码失败。
  const found = await probePythonInterpreter(
    versionHarness({
      python: 'Python 3.14.2\n',
      python3: 'Python was not found; run without arguments to install from the Microsoft Store\n',
    }),
  )
  assert.deepEqual(found, { path: 'python', version: '3.14.2' }, '必须跳过存根，落到真的那个')
})

test('★ probe：候选顺序里假的那个在前时，仍然能落到后面真的那个', async () => {
  const found = await probePythonInterpreter(
    versionHarness({
      python3: 'Python was not found; run without arguments to install from the Microsoft Store\n',
      python: 'Python 3.12.1\n',
    }),
    { candidates: ['python3', 'python'] },
  )
  assert.deepEqual(found, { path: 'python', version: '3.12.1' })
})

test('probe：一个都不行时返回 undefined（不抛，由调用方降级）', async () => {
  const found = await probePythonInterpreter(
    versionHarness({ python: 'Python was not found\n', python3: 'command not found\n' }),
  )
  assert.equal(found, undefined)
})

test('probe：解析全失败时返回 undefined', async () => {
  assert.equal(await probePythonInterpreter(versionHarness({})), undefined)
})

test('★ probe：显式配置的 preferred 不回落（否则"我配的为什么不生效"查不出来）', async () => {
  const found = await probePythonInterpreter(
    versionHarness({ python: 'Python 3.14.2\n' }),
    { preferred: 'my-python' }, // 解析不了
  )
  assert.equal(found, undefined, 'preferred 失败就该失败，不许悄悄换成别的解释器')
})

test('probe：preferred 可用时只试它', async () => {
  const found = await probePythonInterpreter(
    versionHarness({ 'my-python': 'Python 3.11.9\n', python: 'Python 3.14.2\n' }),
    { preferred: 'my-python' },
  )
  assert.deepEqual(found, { path: 'my-python', version: '3.11.9' })
})

test('probe：空白的 preferred 视为未配置，回到默认候选', async () => {
  const found = await probePythonInterpreter(versionHarness({ python: 'Python 3.14.2\n' }), {
    preferred: '   ',
  })
  assert.deepEqual(found, { path: 'python', version: '3.14.2' })
})

/* ─────────────────── ④ 真解释器冒烟（走真实 spawn） ─────────────────── */

test('spawner（真实）：用本机 Python 跑通一次，并按行收到输出', async () => {
  const { spawn } = await import('node:child_process')
  const real: SubprocessLike = {
    spawn: (spec) => {
      const child = spawn(spec.argv[0] ?? 'python', spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      return {
        stdout: child.stdout ?? undefined,
        stderr: child.stderr ?? undefined,
        done: new Promise((resolve) => {
          child.once('close', (exitCode) => {
            resolve({ exitCode })
          })
          child.once('error', () => {
            resolve({ exitCode: null })
          })
        }),
        terminate: () => {
          child.kill()
        },
      }
    },
  }

  const lines: string[] = []
  const handle = await createSubprocessSpawner(real)({
    argv: [process.env.DSH_TEST_PYTHON ?? 'python', '-c', 'print("a");print("b")'],
    cwd: process.cwd(),
    env: {},
    onStdout: (line) => lines.push(line),
    onStderr: () => undefined,
  })
  const outcome = await handle.done

  assert.equal(outcome.exitCode, 0)
  assert.deepEqual(lines, ['a', 'b'], '两行必须分成两条，不能并成一条 chunk')
})
