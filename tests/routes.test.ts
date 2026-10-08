/**
 * 前后端桥端到端测试 —— 用**真的 HTTP 服务器 + 真的 WebSocket** 跑一遍。
 *
 * ★ 为什么值得：单元测试证明「函数对」，但这层要证明的是
 *   「前端 fetch 得到东西、WS 收得到推送」—— 只有真起服务器才算数。
 *   这也是前端 owner 端到端联调前，我这边能给出的最强证据。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'

import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { HardwareEventBus } from '../src/core/events.ts'
import { createRouteBundle, type HttpRoute, type UpgradeRoute } from '../src/host/routes.ts'
import { HTTP_ROUTES, WS_ROUTE } from '../src/contracts/protocol.ts'
import { restingY } from '../src/contracts/library.ts'
import type { HostCapabilities } from '../src/contracts/protocol.ts'
import type { AssemblySnapshot } from '../src/contracts/assembly.ts'
import type { ActionResult } from '../src/contracts/protocol.ts'

/** 复刻宿主 webServer 的派发语义（exact/prefix 匹配 + upgrade）。 */
function startHost(routes: HttpRoute[], upgrades: UpgradeRoute[]): Promise<{ server: Server; base: string; ws: string }> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = routes.find((candidate) =>
      candidate.kind === 'exact' ? candidate.path === pathname : pathname.startsWith(candidate.path),
    )
    if (!route) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    const route = upgrades.find((candidate) => candidate.path === pathname)
    if (!route) {
      socket.destroy()
      return
    }
    void route.handler(req, socket, head)
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, base: `http://127.0.0.1:${String(port)}`, ws: `ws://127.0.0.1:${String(port)}` })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
}

/** 起一套带演示装配的完整宿主桥。 */
async function harness(): Promise<{
  base: string
  ws: string
  state: AssemblyState
  bus: HardwareEventBus
  server: Server
  dispose: () => void
  stop: () => Promise<void>
}> {
  const state = new AssemblyState()
  const bus = new HardwareEventBus()

  const pi = state.place('rpi-4b', { x: -0.06, y: restingY('rpi-4b'), z: 0 })
  assert.ok(pi.ok)
  const sensor = state.place('bme280', { x: 0.02, y: restingY('bme280'), z: 0 })
  assert.ok(sensor.ok)
  assert.ok(
    state.connect({ componentId: pi.value.id, portId: 'P3' }, { componentId: sensor.value.id, portId: 'SDA' }).ok,
  )

  const capabilities = (): HostCapabilities => ({
    scene: true,
    externalProcess: true,
    renderCapture: false,
    vision: false,
    version: 'test',
  })

  const bundle = createRouteBundle({ state, bus, capabilities })
  const { server, base, ws } = await startHost(bundle.http, bundle.upgrade)

  return {
    base,
    ws,
    state,
    bus,
    server,
    dispose: bundle.dispose,
    stop: async () => {
      bundle.dispose()
      await closeServer(server)
    },
  }
}

test('GET /api/capabilities 返回能力探测结果', async () => {
  const host = await harness()
  try {
    const response = await fetch(`${host.base}${HTTP_ROUTES.capabilities}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store', '快照不得被缓存')

    const body = (await response.json()) as HostCapabilities
    assert.equal(body.externalProcess, true, '主线 B 的硬前提必须在能力里如实反映')
    assert.equal(body.scene, true)
  } finally {
    await host.stop()
  }
})

test('GET /api/assembly 返回带演示装配的快照', async () => {
  const host = await harness()
  try {
    const response = await fetch(`${host.base}${HTTP_ROUTES.assembly}`)
    assert.equal(response.status, 200)

    const snapshot = (await response.json()) as AssemblySnapshot
    assert.equal(snapshot.components.length, 2)
    assert.equal(snapshot.connections.length, 1)
    assert.equal(snapshot.connections[0]?.protocol, 'i2c')
    assert.ok(snapshot.revision > 0)

    // 端口占用必须已填（前端据此置灰）
    const pi = snapshot.components.find((component) => component.hardwareModel === 'rpi-4b')
    assert.ok(pi?.ports.find((port) => port.portId === 'P3')?.occupiedBy)

    // I2C 连上后应有上拉提示（§8 流程 A）
    assert.ok(snapshot.warnings.some((warning) => warning.code === 'i2c_pullup_missing'))
  } finally {
    await host.stop()
  }
})

test('POST /api/action 成功改动状态并回带快照', async () => {
  const host = await harness()
  try {
    const before = host.state.revision
    const response = await fetch(`${host.base}${HTTP_ROUTES.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'place_component', hardwareModel: 'led-5v', position: { x: 0.1, y: 0.005, z: 0 } }),
    })
    assert.equal(response.status, 200)

    const result = (await response.json()) as ActionResult
    assert.equal(result.ok, true)
    assert.ok(result.snapshot)
    assert.equal(result.snapshot.components.length, 3)
    assert.ok(host.state.revision > before)
  } finally {
    await host.stop()
  }
})

test('POST /api/action 非法动作返回 400', async () => {
  const host = await harness()
  try {
    const response = await fetch(`${host.base}${HTTP_ROUTES.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    })
    assert.equal(response.status, 400)
  } finally {
    await host.stop()
  }
})

test('GET /api/action 被拒（只接受 POST）', async () => {
  const host = await harness()
  try {
    const response = await fetch(`${host.base}${HTTP_ROUTES.action}`)
    assert.equal(response.status, 405)
  } finally {
    await host.stop()
  }
})

test('未知路径 404', async () => {
  const host = await harness()
  try {
    assert.equal((await fetch(`${host.base}/api/nope`)).status, 404)
  } finally {
    await host.stop()
  }
})

test('★ WS /ws 连接即收到 hello + 当前快照', async () => {
  const host = await harness()
  const socket = new WebSocket(`${host.ws}${WS_ROUTE}`)
  try {
    const hello = await new Promise<{ kind: string; snapshot: AssemblySnapshot }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('未在 3s 内收到 hello')) }, 3000)
      socket.once('message', (raw) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(raw)) as { kind: string; snapshot: AssemblySnapshot })
      })
      socket.once('error', reject)
    })

    assert.equal(hello.kind, 'hello')
    assert.equal(hello.snapshot.components.length, 2, '首帧就应带完整快照，前端不必再轮询')
  } finally {
    socket.close()
    await host.stop()
  }
})

test('★ WS 会推送事件桥上的事件（前端据此实时同步）', async () => {
  const host = await harness()
  const socket = new WebSocket(`${host.ws}${WS_ROUTE}`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => { resolve() }) // hello
      socket.once('error', reject)
    })

    const eventPromise = new Promise<{ kind: string; event: { type: string } }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('未在 3s 内收到事件推送')) }, 3000)
      socket.once('message', (raw) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(raw)) as { kind: string; event: { type: string } })
      })
    })

    // 通过 HTTP 改状态 → 事件应经 WS 推给前端
    await fetch(`${host.base}${HTTP_ROUTES.action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'place_component', hardwareModel: 'led-5v', position: { x: 0.1, y: 0.005, z: 0 } }),
    })

    const message = await eventPromise
    assert.equal(message.kind, 'event')
    assert.equal(message.event.type, 'hardware/component_placed')
  } finally {
    socket.close()
    await host.stop()
  }
})

test('WS resync 请求返回最新快照', async () => {
  const host = await harness()
  const socket = new WebSocket(`${host.ws}${WS_ROUTE}`)
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('message', () => { resolve() })
      socket.once('error', reject)
    })

    const framePromise = new Promise<{ kind: string; snapshot: AssemblySnapshot }>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('未在 3s 内收到 snapshot')) }, 3000)
      socket.once('message', (raw) => {
        clearTimeout(timer)
        resolve(JSON.parse(String(raw)) as { kind: string; snapshot: AssemblySnapshot })
      })
    })

    socket.send(JSON.stringify({ kind: 'resync' }))
    const frame = await framePromise
    assert.equal(frame.kind, 'snapshot')
    assert.equal(frame.snapshot.components.length, 2)
  } finally {
    socket.close()
    await host.stop()
  }
})

test('dispose 之后事件不再推给已关闭的连接（热重载不残留）', async () => {
  const host = await harness()
  const socket = new WebSocket(`${host.ws}${WS_ROUTE}`)
  await new Promise<void>((resolve, reject) => {
    socket.once('message', () => { resolve() })
    socket.once('error', reject)
  })

  // dispose 必须退订事件桥，否则插件热重载后会重复推送
  host.dispose()
  assert.equal(host.bus.listenerCount, 0, '事件订阅必须被退订')

  // 退订之后，再改状态不应再产生任何 WS 消息
  let received = 0
  socket.on('message', () => { received += 1 })
  host.bus.emit({ type: 'hardware/state_changed', source: 'ds', at: 0, revision: 99 })
  await new Promise<void>((resolve) => setTimeout(resolve, 60))
  assert.equal(received, 0, 'dispose 后不应再推送事件')

  socket.close()
  await closeServer(host.server)
})
