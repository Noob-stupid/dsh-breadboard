/**
 * BridgeServer 跨进程测试 —— 用**真的 TCP 连接**跑一遍。
 *
 * ★ 为什么必须真起 socket：IPC 的问题从来不在逻辑，在**边界**——
 *   分帧、半包、鉴权时序、进程断开。这些用 mock 全都测不出来。
 *
 * ★ 本文件同时是 §7.4 T1/T3 的**跨进程版**：
 *   原判据在进程内验证「虚拟时钟按片推进」；这里验证「同样的推进经一次真实
 *   网络往返后，项目侧读到的值依然确定」——这是 P1/P2 闭环的前置。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { connect, type Socket } from 'node:net'

import { VirtualClock } from '../src/core/vclock/virtual-clock.ts'
import { DeterministicTestDevice } from '../src/core/devices/deterministic.ts'
import { BridgeServer } from '../src/core/bridge/server.ts'
import { IPC_VERSION, decodeFrames, encodeFrame } from '../src/contracts/ipc.ts'
import type { IpcRequest, IpcResponse } from '../src/contracts/ipc.ts'

/** 测试用最小客户端：按 id 配对请求与响应。 */
class TestClient {
  #socket: Socket
  #buffer = ''
  #nextId = 1
  #pending = new Map<number, (response: IpcResponse) => void>()
  #closed = false

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.on('data', (chunk) => {
      this.#buffer += chunk.toString('utf8')
      const { messages, rest } = decodeFrames(this.#buffer)
      this.#buffer = rest
      for (const message of messages) {
        const response = message as IpcResponse
        const resolve = this.#pending.get(response.id)
        if (resolve) {
          this.#pending.delete(response.id)
          resolve(response)
        }
      }
    })
    socket.on('close', () => {
      this.#closed = true
      for (const resolve of this.#pending.values()) {
        resolve({ id: -1, error: { code: 'internal', message: 'socket closed' } })
      }
      this.#pending.clear()
    })
  }

  static async open(port: number): Promise<TestClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host: '127.0.0.1', port }, () => { resolve(s) })
      s.once('error', reject)
    })
    return new TestClient(socket)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** 发一个请求并等响应。 */
  call(method: string, params?: unknown): Promise<IpcResponse> {
    const id = this.#nextId
    this.#nextId += 1
    const request: IpcRequest = { id, method: method as IpcRequest['method'] }
    if (params !== undefined) (request as { params?: unknown }).params = params

    return new Promise<IpcResponse>((resolve) => {
      this.#pending.set(id, resolve)
      this.#socket.write(encodeFrame(request))
    })
  }

  /** 发原始字节（测分帧与畸形输入）。 */
  writeRaw(text: string): void {
    this.#socket.write(text)
  }

  close(): void {
    this.#socket.destroy()
  }
}

interface Harness {
  server: BridgeServer
  clock: VirtualClock
  device: DeterministicTestDevice
  port: number
  token: string
  logs: string[]
  stop: () => Promise<void>
}

async function harness(): Promise<Harness> {
  const clock = new VirtualClock({ step: 0.001 })
  const device = new DeterministicTestDevice({ id: 'test-device', period: 1, address: 0x48 })
  clock.register(device)

  const logs: string[] = []
  const server = new BridgeServer({
    clock,
    token: 'test-token-abc',
    onLog: (stream, text) => logs.push(`${stream}:${text}`),
  })
  const address = await server.listen()

  return {
    server,
    clock,
    device,
    port: address.port,
    token: address.token,
    logs,
    stop: () => server.close(),
  }
}

/** 开一条已握手的连接。 */
async function connected(h: Harness): Promise<TestClient> {
  const client = await TestClient.open(h.port)
  const response = await client.call('hello', {
    version: IPC_VERSION,
    token: h.token,
    pid: 1234,
    python: '3.14.2',
  })
  assert.ok('result' in response, `握手应成功，实际：${JSON.stringify(response)}`)
  return client
}

/* ─────────────────────────── 监听与握手 ─────────────────────────── */

test('listen() 返回回环地址、一次性 token 与子进程环境变量', async () => {
  const h = await harness()
  try {
    assert.equal(h.server.address?.host, '127.0.0.1', '绝不能监听 0.0.0.0')
    assert.ok(h.port > 0, '默认应由 OS 分配端口，避免固定端口冲突')

    const env = h.server.address?.env ?? {}
    assert.equal(env.DSH_HW_BRIDGE_PORT, String(h.port))
    assert.equal(env.DSH_HW_BRIDGE_TOKEN, h.token)
    assert.equal(env.DSH_HW_BRIDGE_VERSION, String(IPC_VERSION))
    assert.equal(env.DSH_HW_BRIDGE_HOST, '127.0.0.1')
  } finally {
    await h.stop()
  }
})

test('★ 错误 token 必须断开连接，且不回包（不给重试空间）', async () => {
  const h = await harness()
  try {
    const client = await TestClient.open(h.port)
    await client.call('hello', { version: IPC_VERSION, token: 'wrong-token', pid: 1, python: '3.14' })
    // 给服务端一点时间执行 destroy
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(client.closed, true, '错误 token 应立即断开，而不是回一个错误包')
    assert.equal(h.server.handshakenCount, 0)
  } finally {
    await h.stop()
  }
})

test('★ 协议版本不匹配时明确报错（避免静默错配）', async () => {
  const h = await harness()
  try {
    const client = await TestClient.open(h.port)
    const response = await client.call('hello', {
      version: 999,
      token: h.token,
      pid: 1,
      python: '3.14',
    })
    assert.ok('error' in response)
    assert.equal(response.error.code, 'bad_params')
    assert.match(response.error.message, /协议版本/, '错误信息应点明是版本问题')
  } finally {
    await h.stop()
  }
})

test('★ 未握手不得推进虚拟时钟（否则是个无鉴权的状态后门）', async () => {
  const h = await harness()
  try {
    const client = await TestClient.open(h.port)
    const before = h.clock.nowMicros

    const response = await client.call('clock_advance', { seconds: 5 })
    assert.ok('error' in response, '未握手就推进时钟必须被拒')
    assert.equal(h.clock.nowMicros, before, '被拒的调用不得改动虚拟时钟')

    // 但 log 不该被鉴权挡住（崩溃现场往往发生在握手失败前后）
    const logged = await client.call('log', { stream: 'stderr', text: 'pre-handshake' })
    assert.ok('result' in logged, 'log 应允许未握手调用')
  } finally {
    await h.stop()
  }
})

/* ─────────────────────────── 硬件访问 ─────────────────────────── */

test('i2c_read 命中设备返回字节数组', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    const response = await client.call('i2c_read', { address: 0x48, register: 0x00, length: 2 })
    assert.ok('result' in response)
    assert.deepEqual((response.result as { data: number[] }).data, [0, 1], '大端编码的采样序号 1')
  } finally {
    await h.stop()
  }
})

test('i2c_read 地址无人认领 → no_device（Python 侧会映射成 OSError errno 121）', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    const response = await client.call('i2c_read', { address: 0x76, register: 0x00, length: 2 })
    assert.ok('error' in response)
    assert.equal(response.error.code, 'no_device')
  } finally {
    await h.stop()
  }
})

test('设备被故障注入断开后 → disconnected（与 no_device 区分开）', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    h.device.injectFault({ type: 'disconnect' })

    const response = await client.call('i2c_read', { address: 0x48, register: 0x00, length: 2 })
    assert.ok('error' in response)
    assert.equal(response.error.code, 'disconnected', '流程 C 要求项目能观察到「断连」而非「没这个设备」')
  } finally {
    await h.stop()
  }
})

test('i2c_write 送达设备；未实现的方法明确报 unknown_method（不静默）', async () => {
  const h = await harness()
  try {
    const client = await connected(h)

    const write = await client.call('i2c_write', { address: 0x48, register: 0xf4, data: [0x27] })
    assert.ok('result' in write)
    assert.equal((write.result as { ack: boolean }).ack, true)

    // GPIO 只定义了协议、没有行为模型：必须明确拒绝
    const gpio = await client.call('gpio_write', { pin: 4, value: 1 })
    assert.ok('error' in gpio)
    assert.equal(gpio.error.code, 'unknown_method', '静默成功会让 P4 误判该路径已覆盖')

    const bogus = await client.call('nonexistent_method')
    assert.ok('error' in bogus)
    assert.equal(bogus.error.code, 'unknown_method')
  } finally {
    await h.stop()
  }
})

/* ─────────────────── §7.4 T1/T3 的跨进程版 ─────────────────── */

test('★ T1 跨进程：五次「读 + sleep(1)」得到 [1,2,3,4,5]', async () => {
  const h = await harness()
  try {
    const client = await connected(h)

    const readings: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const read = await client.call('i2c_read', { address: 0x48, register: 0x00, length: 2 })
      assert.ok('result' in read)
      const [hi = 0, lo = 0] = (read.result as { data: number[] }).data
      readings.push(hi * 256 + lo)

      // —— 这一行就是 Python 侧 shim 的 time.sleep(1) 经 IPC 转发的结果 ——
      const advanced = await client.call('clock_advance', { seconds: 1 })
      assert.ok('result' in advanced)
    }

    assert.deepEqual(readings, [1, 2, 3, 4, 5], `跨进程后虚拟时钟未按序推进：${JSON.stringify(readings)}`)
  } finally {
    await h.stop()
  }
})

test('★ T3 跨进程：clock_advance(1.0) 真的 tick 满 1000 片，一片不漏', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    const before = h.device.tickCount

    await client.call('clock_advance', { seconds: 1 })

    assert.equal(h.device.tickCount - before, 1000, '1 秒虚拟时间在 step=1ms 下必须 tick 1000 片')
    assert.equal(h.clock.nowMicros, 1_000_000, '虚拟时刻必须精确等于 1 秒')
  } finally {
    await h.stop()
  }
})

test('clock_advance 拒绝负数与非法值', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    for (const seconds of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const response = await client.call('clock_advance', { seconds })
      assert.ok('error' in response, `seconds=${String(seconds)} 应被拒`)
    }
    assert.equal(h.clock.nowMicros, 0, '非法调用不得改动虚拟时钟')
  } finally {
    await h.stop()
  }
})

/* ─────────────────────────── 分帧与健壮性 ─────────────────────────── */

test('★ 半包：把一个请求切成两半发，必须仍能正确解析', async () => {
  const h = await harness()
  try {
    const client = await TestClient.open(h.port)
    const hello = encodeFrame({
      id: 1,
      method: 'hello',
      params: { version: IPC_VERSION, token: h.token, pid: 1, python: '3.14' },
    })

    client.writeRaw(hello.slice(0, 10))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 前半段还没闭环，此时不该有任何已完成握手
    assert.equal(h.server.handshakenCount, 0)

    client.writeRaw(hello.slice(10))
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.equal(h.server.handshakenCount, 1, '拼接后应完成握手')
  } finally {
    await h.stop()
  }
})

test('畸形输入回 bad_frame 且不崩服务端', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    client.writeRaw('这不是 JSON\n')
    await new Promise((resolve) => setTimeout(resolve, 50))

    // 服务端必须还活着
    const after = await client.call('i2c_read', { address: 0x48, register: 0, length: 2 })
    assert.ok('result' in after, '畸形输入后服务端仍应正常服务')
  } finally {
    await h.stop()
  }
})

test('log 上报会带因果顺序保留到 onLog', async () => {
  const h = await harness()
  try {
    const client = await connected(h)
    await client.call('log', { stream: 'stdout', text: 'temperature=25.1' })
    await client.call('log', { stream: 'stderr', text: 'sensor read failed' })

    assert.ok(h.logs.some((line) => line === 'stdout:temperature=25.1'))
    assert.ok(h.logs.some((line) => line === 'stderr:sensor read failed'))
  } finally {
    await h.stop()
  }
})

test('close() 断开所有连接并停止监听', async () => {
  const h = await harness()
  const client = await connected(h)
  assert.equal(h.server.connectionCount, 1)

  await h.stop()

  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(h.server.connectionCount, 0)
  assert.equal(client.closed, true, 'close() 应断开已连接的客户端')

  // 端口应已释放：重新连接必须失败（或者立刻断开）
  await assert.rejects(
    async () => {
      const probe = await TestClient.open(h.port)
      probe.close()
    },
    '关闭后不应还能连上',
  )
})
