/**
 * Python shim 跨进程端到端验证 —— 设计文档 §7.4 T1 与 §8 流程 C 的**真实验证**。
 *
 * ★ 这是本项目第一次让「真的 Python 进程」跑在「真的虚拟硬件」上：
 *   宿主起 BridgeServer → spawn 一个 Python 子进程 → 子进程 `import smbus`
 *   命中 shim → `time.sleep(1)` 被换成 `clock_advance` → 读数由虚拟设备决定。
 *
 * ★ 与 tests/bridge-server.test.ts 的区别：那边用 Node 写的假客户端，
 *   这边是**真的 Python 解释器 + 真的 shim 代码**。shim 的注入机制
 *   （PYTHONPATH + sitecustomize）只有在这里才被真正验证。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { DeterministicTestDevice } from '../src/core/devices/deterministic.ts'
import { BridgeServer } from '../src/core/bridge/server.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIM_ROOT = path.join(ROOT, 'project-shim')
const SHIM_MODULES = path.join(SHIM_ROOT, 'shim')

/** Python 解释器。本机实测 `python` = E:\python314\python.exe；`python3` 是 WindowsApps 存根，不可用。 */
const PYTHON = process.env.DSH_TEST_PYTHON ?? 'python'

interface ChildResult {
  code: number | null
  stdout: string
  stderr: string
}

/** 起一个 Python 子进程，注入 shim 环境。 */
function runProject(
  script: string,
  env: Record<string, string>,
  onSpawn?: (child: ReturnType<typeof spawn>) => void,
): Promise<ChildResult> {
  const separator = process.platform === 'win32' ? ';' : ':'

  const child = spawn(PYTHON, [path.join(ROOT, 'tests', script)], {
    cwd: ROOT,
    env: {
      ...process.env,
      // ★ 注入机制：shim 目录在前（提供 smbus / RPi），project-shim 在后（提供 sitecustomize）
      PYTHONPATH: [SHIM_MODULES, SHIM_ROOT].join(separator),
      PYTHONIOENCODING: 'utf-8',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  onSpawn?.(child)

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`Python 子进程超时。stdout=${stdout} stderr=${stderr}`))
    }, 30_000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })
}

/** 宿主侧：起时钟 + 确定性设备 + BridgeServer。 */
async function startHost(onLog?: (stream: string, text: string) => void): Promise<{
  clock: VirtualClock
  device: DeterministicTestDevice
  server: BridgeServer
  env: Record<string, string>
  stop: () => Promise<void>
}> {
  const clock = new VirtualClock({ step: 0.001 })
  const device = new DeterministicTestDevice({ id: 'test-device', period: 1, address: 0x48 })
  clock.register(device)

  const server = new BridgeServer(
    onLog === undefined
      ? { clock }
      : { clock, onLog: (stream, text) => { onLog(stream, text) } },
  )
  const address = await server.listen()

  return {
    clock,
    device,
    server,
    env: address.env,
    stop: () => server.close(),
  }
}

test('★ T1 端到端：真 Python 进程经 shim 读到 [1,2,3,4,5]', async () => {
  const host = await startHost()
  try {
    const result = await runProject('test_clock.py', host.env)

    assert.equal(
      result.code,
      0,
      `Python 子进程非零退出。stdout=${result.stdout} stderr=${result.stderr}`,
    )

    const line = result.stdout.trim().split('\n').at(-1)
    assert.ok(line, `子进程没有输出 JSON。stdout=${result.stdout} stderr=${result.stderr}`)
    const payload = JSON.parse(line) as { readings: number[] }

    assert.deepEqual(
      payload.readings,
      [1, 2, 3, 4, 5],
      `虚拟时钟未按序推进：${JSON.stringify(payload.readings)}`,
    )

    // ★ 宿主侧交叉断言：虚拟时钟确实被 Python 的 sleep 推进了整整 5 秒
    assert.equal(host.clock.nowMicros, 5_000_000, '五次 sleep(1) 应精确推进 5 秒虚拟时间')
  } finally {
    await host.stop()
  }
})

test('★ T3 端到端：Python 的 5 次 sleep(1) 让设备被 tick 满 5000 片', async () => {
  const host = await startHost()
  try {
    await runProject('test_clock.py', host.env)
    assert.equal(
      host.device.tickCount,
      5000,
      `时间片有丢失：期望 5000 片，实际 ${String(host.device.tickCount)}`,
    )
  } finally {
    await host.stop()
  }
})

test('★ 流程 C：故障注入后 Python 侧必须观察到 OSError（errno 121，与真实硬件一致）', async () => {
  // ★ 注入必须**由事件触发**，不能靠墙钟：
  //   虚拟 sleep 是瞬时的，整个脚本 100ms 就跑完了，「等 700ms 再注入」永远赶不上。
  //   这里让项目读完第一次后发一个就绪信号，宿主收到立即注入。
  let injected = false
  const host = await startHost((_stream, text) => {
    if (text.includes('READY_FOR_FAULT') && !injected) {
      injected = true
      host.device.injectFault({ type: 'disconnect' })
    }
  })

  try {
    const result = await runProject('test_fault.py', host.env)

    assert.equal(injected, true, '就绪信号没收到，故障没注入')
    assert.equal(result.code, 0, `Python 子进程非零退出。stderr=${result.stderr}`)

    const lines = result.stdout.trim().split('\n')
    const outcome = JSON.parse(lines.at(-1) ?? '{}') as {
      raised: boolean
      errno?: number
      is_oserror?: boolean
    }

    assert.equal(
      outcome.raised,
      true,
      '断连后项目必须观察到异常 —— 否则 §8 流程 C 的「建议加 try/except」根本无从谈起',
    )
    assert.equal(outcome.is_oserror, true, '异常必须是 OSError，否则项目的 except OSError 分支走不到')
    assert.equal(outcome.errno, 121, 'errno 必须是 121（EREMOTEIO），与真实 Linux smbus 一致')
  } finally {
    await host.stop()
  }
})

test('未注入 DSH_HW_BRIDGE_* 时 shim 完全惰性（不改变项目行为）', async () => {
  // 只挂 PYTHONPATH，不给回连参数：sitecustomize 应当什么都不做
  const result = await runProject(
    'test_clock.py',
    // 显式清空，覆盖父进程可能残留的值
    { DSH_HW_BRIDGE_HOST: '', DSH_HW_BRIDGE_PORT: '', DSH_HW_BRIDGE_TOKEN: '' },
  )

  // 此时 smbus 仍是 shim（在 PYTHONPATH 上会命中），但没有回连参数，
  // 所以硬件访问必须以 BridgeError(no_bridge) 明确失败，而不是静默返回假数据。
  assert.notEqual(result.code, 0, '没有回连参数时硬件访问必须失败，不能假装成功')
  assert.match(
    result.stderr + result.stdout,
    /DSH_HW_BRIDGE|no_bridge|BridgeError|未找到/,
    `失败信息应点明是缺少回连参数。实际 stderr=${result.stderr} stdout=${result.stdout}`,
  )
})
