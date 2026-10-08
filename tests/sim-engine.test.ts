/**
 * SimEngine 端到端测试 —— **主线 B 闭环的验收**（设计文档 §5.1 / §0.4 P1、P2）。
 *
 * ★ 这条链走完，就意味着「项目代码语义等价地跑在虚拟硬件上」成立了：
 *
 *   真 Python 项目进程
 *     → import smbus（命中 shim）
 *     → 读芯片 ID / 26 字节校准 / 8 字节数据
 *     → **自己做 Bosch 定点补偿**
 *     → 打印温湿度气压
 *   宿主侧：BridgeServer → 虚拟时钟 → VirtualBME280（寄存器级）
 *
 * ★ 关键在于 **补偿是项目自己算的**，不是宿主算好给的 —— 这才是 §3.2「结果一致性」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { HardwareEventBus } from '../src/core/events.ts'
import { DeviceRegistry } from '../src/core/sim/device-registry.ts'
import { SimEngine, type SimSpawner } from '../src/core/sim/engine.ts'
import { restingY } from '../src/contracts/library.ts'
import type { HardwareEvent } from '../src/contracts/assembly.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHIM_ROOT = path.join(ROOT, 'project-shim')
const PYTHON = process.env.DSH_TEST_PYTHON ?? 'python'

/** 真 spawner：把 `SimSpawnRequest` 映射到 node:child_process。 */
const realSpawner: SimSpawner = (request) => {
  const child = spawn(request.argv[0] ?? PYTHON, request.argv.slice(1), {
    cwd: request.cwd,
    env: { ...process.env, ...request.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout?.on('data', (chunk: Buffer) => {
    request.onStdout(chunk.toString('utf8'))
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    request.onStderr(chunk.toString('utf8'))
  })

  return {
    // ★ 宿主刻意不暴露进程身份（`SubprocessHandle` 上没有 pid），生产适配器因此
    //   **不给 pid**。测试替身照做 —— 别用 `?? -1` 编一个假值：那正是
    //   「看着像诊断信息、实际是垃圾」。替身与生产不一致时，测试绿了也没意义。
    ...(child.pid !== undefined ? { pid: child.pid } : {}),
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
}

/** 起一套「装配 + 设备 + 引擎」的完整宿主。 */
function harness(): {
  clock: VirtualClock
  state: AssemblyState
  bus: HardwareEventBus
  engine: SimEngine
  events: HardwareEvent[]
  sensorTemperature: () => number
} {
  const clock = new VirtualClock({ step: 0.001 })
  const state = new AssemblyState()
  const bus = new HardwareEventBus()
  const registry = new DeviceRegistry({ clock, state })

  const events: HardwareEvent[] = []
  bus.on((event) => events.push(event))

  // 演示装配：树莓派 + BME280（bme280 会产生对应虚拟设备）
  state.place('rpi-4b', { x: -0.06, y: restingY('rpi-4b'), z: 0 })
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)

  const engine = new SimEngine({
    clock,
    state,
    bus,
    spawn: realSpawner,
    pythonPath: PYTHON,
    shimRoot: SHIM_ROOT,
    maxWallMs: 30_000,
  })

  return {
    clock,
    state,
    bus,
    engine,
    events,
    sensorTemperature: () => {
      const device = registry.deviceFor(sensor.value.id) as { temperature?: number } | undefined
      return device?.temperature ?? Number.NaN
    },
  }
}

test('★ 闭环：真 Python 项目对寄存器级 BME280 做自己的补偿计算', async () => {
  const h = harness()
  try {
    const result = await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })

    assert.equal(result.reason, 'exited', `应正常退出，实际 ${result.reason}：${result.log.join('\n')}`)
    assert.equal(result.exitCode, 0, `项目进程非零退出：${result.log.join('\n')}`)

    const line = result.log.find((l) => l.includes('"chipId"'))
    assert.ok(line, `未找到结果行。日志：\n${result.log.join('\n')}`)

    const payload = JSON.parse(line) as {
      chipId: number
      samples: Array<{ temperature: number; humidity: number; pressure: number }>
    }

    // 芯片 ID：证明项目真的读到了我们的寄存器级模型
    assert.equal(payload.chipId, 0x60, 'BME280 芯片 ID 必须是 0x60')
    assert.equal(payload.samples.length, 3)

    // ★ 关键：项目**自己算出来**的温度，必须落在虚拟器件的物理真值附近
    const truth = h.sensorTemperature()
    for (const sample of payload.samples) {
      assert.ok(
        Math.abs(sample.temperature - truth) < 0.5,
        `项目算得 ${sample.temperature}°C，器件真值 ${truth}°C —— 补偿链路不一致`,
      )
      // 量纲与量级合理性（不是恒为 0 或荒谬值）
      assert.ok(sample.pressure > 80_000 && sample.pressure < 120_000, `气压不合理：${sample.pressure}`)
      assert.ok(sample.humidity >= 0 && sample.humidity <= 100, `湿度不合理：${sample.humidity}`)
    }
  } finally {
    await h.engine.dispose()
  }
})

test('★ 虚拟时间预算：项目 sleep 再多也会在 duration 处停下', async () => {
  const h = harness()
  try {
    // 项目要跑 3 次 × (0.01 + 1) 秒 ≈ 3.03s 虚拟时间；给 1 秒预算 ⇒ 必然被截断
    const result = await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 1,
      mode: 'accelerated',
    })

    assert.equal(result.reason, 'budget', `应由预算终止，实际 ${result.reason}`)
    assert.ok(
      result.virtualElapsed <= 1.01,
      `虚拟耗时不得超出预算：${String(result.virtualElapsed)}s`,
    )
    assert.ok(
      result.log.some((l) => l.includes('预算用尽')),
      '应留下预算耗尽的日志',
    )
  } finally {
    await h.engine.dispose()
  }
})

test('加速模式下虚拟时间远快于墙钟（这正是要预算而非计时的理由）', async () => {
  const h = harness()
  try {
    const result = await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })

    assert.ok(result.virtualElapsed > 2, `虚拟时间应推进若干秒，实际 ${String(result.virtualElapsed)}`)
    assert.ok(
      result.wallElapsedMs < result.virtualElapsed * 1000,
      `加速模式应远快于实时：虚拟 ${result.virtualElapsed.toFixed(2)}s vs 真实 ${String(result.wallElapsedMs)}ms`,
    )
  } finally {
    await h.engine.dispose()
  }
})

test('★ 事件桥：sim_started / sim_tick / sim_ended 都发出来了', async () => {
  const h = harness()
  try {
    await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })

    const types = h.events.map((event) => event.type)
    assert.ok(types.includes('hardware/sim_started'), '应发出 sim_started')
    assert.ok(types.includes('hardware/sim_ended'), '应发出 sim_ended')
    assert.ok(types.includes('hardware/sim_tick'), '应发出 sim_tick')
  } finally {
    await h.engine.dispose()
  }
})

test('★ 铁律②：sim_tick 被节流合并，不是逐 tick 一条', async () => {
  const h = harness()
  try {
    await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })

    const ticks = h.events.filter((event) => event.type === 'hardware/sim_tick')
    // 项目推进了 ~3 秒虚拟时间 = 3000 个时间片；若逐 tick 推送会有 3000 条
    assert.ok(ticks.length > 0, '应有 sim_tick')
    assert.ok(
      ticks.length < 100,
      `sim_tick 应被节流合并（实际 ${String(ticks.length)} 条，逐 tick 会是数千条）`,
    )

    // 累计量必须守恒：合并后的 advancedMicros 总和 ≈ 实际推进的虚拟时间
    const totalMicros = ticks.reduce(
      (sum, event) => sum + (event.type === 'hardware/sim_tick' ? event.advancedMicros : 0),
      0,
    )
    assert.ok(
      Math.abs(totalMicros / 1_000_000 - 3.03) < 0.2,
      `节流后累计推进量应守恒，实际 ${(totalMicros / 1_000_000).toFixed(3)}s`,
    )
  } finally {
    await h.engine.dispose()
  }
})

test('并发拒绝：同一份虚拟硬件不能被两个项目进程共享', async () => {
  const h = harness()
  try {
    const first = h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })
    // 第一次还在跑时提交第二次
    const second = await h.engine.run({
      projectPath: path.join(ROOT, 'tests'),
      entry: 'test_bme280_project.py',
      duration: 10,
      mode: 'accelerated',
    })

    assert.equal(second.ok, false)
    assert.equal(second.reason, 'error')
    assert.match(second.message ?? '', /已有仿真在运行/)

    await first
  } finally {
    await h.engine.dispose()
  }
})

test('注入不存在的目标时明确失败（不静默成功）', async () => {
  const h = harness()
  try {
    const injected = h.engine.injectFault('nonexistent-device', { type: 'disconnect' })
    assert.equal(injected, false, '找不到目标必须返回 false 并留日志')
    assert.ok(h.engine.log.some((l) => l.includes('未找到匹配')))
  } finally {
    await h.engine.dispose()
  }
})
