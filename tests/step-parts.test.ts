/**
 * step.parts 客户端与一键导入测试。
 *
 * ★ 两处重点不是功能、是**安全与成本**：
 *   ① **下载前按元数据判上限** —— 一个 52MB 的模型不该先把流量花掉再被拒
 *   ② **SSRF 面为零** —— 客户端只给 `partId`，`glbUrl` 由宿主从 API 取
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { StepPartsClient, StepPartsError } from '../src/core/models/step-parts.ts'
import { ModelStore } from '../src/core/models/store.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { HardwareEventBus } from '../src/core/events.ts'
import { createRouteBundle, type HttpRoute, type UpgradeRoute } from '../src/host/routes.ts'
import { MODEL_ROUTES, type HostCapabilities, type ModelCandidate } from '../src/contracts/protocol.ts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 一个真 GLB 的最小字节（魔数 + 长度 12）。 */
const GLB = Buffer.concat([Buffer.from('glTF', 'ascii'), Buffer.alloc(8, 0)])

/** 造一个假的 step.parts API。 */
function fakeApi(parts: Record<string, unknown>, options: { glbBytes?: Buffer; failGlb?: boolean } = {}): typeof fetch {
  const glb = options.glbBytes ?? GLB
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

    if (url.includes('/parts?') || url.endsWith('/parts')) {
      // ★ 替身**不做过滤** —— 过滤是 step.parts API 的职责，客户端只负责映射。
      //   替身若自己实现一套匹配规则，就又是"替身与生产不一致"那类问题（失败族第 12 例）。
      return new Response(JSON.stringify({ items: Object.values(parts) }), { status: 200 })
    }

    if (url.includes('/preview/glb/') || url.endsWith('.glb')) {
      if (options.failGlb === true) return new Response('nope', { status: 500 })
      return new Response(glb, { status: 200, headers: { 'content-type': 'model/gltf-binary' } })
    }

    const id = url.split('/parts/')[1]
    if (id !== undefined && parts[id] !== undefined) {
      return new Response(JSON.stringify(parts[id]), { status: 200 })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const PICO = {
  id: 'raspberry_pi_pico',
  name: 'Raspberry Pi Pico',
  description: 'RP2040 microcontroller board.',
  category: 'electronics',
  family: 'raspberry-pi',
  tags: ['board', 'microcontroller'],
  attributes: {
    manufacturer: 'Raspberry Pi',
    model: 'Pico',
    boardLengthMm: 51,
    boardWidthMm: 21,
  },
  glbUrl: 'https://example.invalid/preview/glb/raspberry_pi_pico.glb',
  pngUrl: 'https://example.invalid/preview/png/raspberry_pi_pico.png',
  pageUrl: 'https://www.step.parts/parts/raspberry_pi_pico',
  byteSize: 1_721_557,
}

/* ─────────────────── 搜索与归一化 ─────────────────── */

test('搜索：原始条目归一化成候选（含厂商与板卡尺寸）', async () => {
  const client = new StepPartsClient({ fetchImpl: fakeApi({ raspberry_pi_pico: PICO }) })
  const found = await client.search('raspberry_pi_pico')

  assert.equal(found.length, 1)
  const c = found[0] as ModelCandidate
  assert.equal(c.source, 'step.parts')
  assert.equal(c.id, 'raspberry_pi_pico')
  assert.equal(c.name, 'Raspberry Pi Pico')
  assert.equal(c.manufacturer, 'Raspberry Pi', '厂商取自 attributes')
  assert.equal(c.category, 'electronics')
  assert.equal(c.importable, true)
  assert.deepEqual(c.tags, ['board', 'microcontroller'])
  // ★ 板卡尺寸可直接当契约 size 的初值
  assert.deepEqual(c.sizeMm, { length: 51, width: 21 })
  assert.ok(c.previewUrl !== undefined, '应带出预览图，让用户不必盲下大文件')
})

test('搜索：缺少 id 或 glbUrl 的条目被丢弃（不产生不可导入的候选）', async () => {
  const client = new StepPartsClient({
    fetchImpl: fakeApi({
      ok_part: PICO,
      no_glb: { id: 'no_glb', name: 'x' },
    }),
  })
  const found = await client.search('part')
  assert.equal(found.length, 1, '没有 glbUrl 的条目必须被丢掉 —— 它不可一键导入')
  assert.equal(found[0]?.id, 'raspberry_pi_pico')
})

test('搜索：网络失败抛 network，不静默返回空', async () => {
  const client = new StepPartsClient({
    fetchImpl: (() => Promise.reject(new Error('boom'))) as unknown as typeof fetch,
  })
  await assert.rejects(() => client.search('x'), (e: unknown) => {
    assert.ok(e instanceof StepPartsError)
    assert.equal(e.code, 'network')
    return true
  })
})

/* ─────────────────── ★ 上限：下载前判定 ─────────────────── */

test('★ 预检：源文件明显离谱时**不去下载**', async () => {
  let glbFetched = false
  const base = fakeApi({ big: { ...PICO, id: 'big', byteSize: 900 * 1024 * 1024 } })
  const spy = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.includes('/preview/glb/')) glbFetched = true
    return base(input as never, init)
  }) as typeof fetch

  const client = new StepPartsClient({ fetchImpl: spy, precheckBytes: 512 * 1024 * 1024 })
  await assert.rejects(
    () => client.download('big'),
    (e: unknown) => {
      assert.ok(e instanceof StepPartsError)
      assert.equal(e.code, 'too_large')
      assert.match(e.message, /未下载/, '错误信息应说明根本没下')
      return true
    },
  )
  assert.equal(glbFetched, false, '★ 预检拦下时 GLB 请求必须根本没发出')
})

test('★ `byteSize` 量的是 **STEP**，不能直接卡 GLB 上限（这是实测踩过的坑）', async () => {
  // 树莓派 4B 实测：byteSize(STEP) 50.1MB，而实际 GLB 只有 5.7MB。
  // 若拿 byteSize 卡 maxBytes=32MB，这个件会被**错误地拒掉**。
  const client = new StepPartsClient({
    fetchImpl: fakeApi({ pi4: { ...PICO, id: 'pi4', byteSize: 52_486_607 } }),
    maxBytes: 32 * 1024 * 1024,
  })
  const { bytes } = await client.download('pi4')
  assert.ok(bytes.length > 0, 'STEP 50MB 但 GLB 很小 ⇒ 应当放行，而不是拿 STEP 尺寸卡')
})

test('★ 实检：下载到的 GLB 真的超限才拒（并说明已丢弃）', async () => {
  const client = new StepPartsClient({
    // 元数据说很小，实际下下来很大 —— 实检必须按**实际字节数**判
    fetchImpl: fakeApi({ sneaky: { ...PICO, id: 'sneaky', byteSize: 1000 } }, {
      glbBytes: Buffer.concat([Buffer.from('glTF', 'ascii'), Buffer.alloc(4096, 0)]),
    }),
    maxBytes: 1024,
  })
  await assert.rejects(
    () => client.download('sneaky'),
    (e: unknown) => {
      assert.ok(e instanceof StepPartsError)
      assert.equal(e.code, 'too_large')
      assert.match(e.message, /已丢弃/)
      return true
    },
  )
})

test('上限内正常下载，且按**内容**校验 GLB 魔数', async () => {
  const client = new StepPartsClient({ fetchImpl: fakeApi({ p: PICO }), maxBytes: 32 * 1024 * 1024 })
  const { bytes, candidate } = await client.download('p')
  assert.deepEqual(bytes, GLB)
  assert.equal(candidate.id, 'raspberry_pi_pico')
})

test('下载到的内容不是 GLB ⇒ 明确报错（不信 content-type）', async () => {
  const client = new StepPartsClient({
    fetchImpl: fakeApi({ p: PICO }, { glbBytes: Buffer.from('PNG\x89 not a glb', 'utf8') }),
  })
  await assert.rejects(() => client.download('p'), (e: unknown) => {
    assert.ok(e instanceof StepPartsError)
    assert.equal(e.code, 'bad_response')
    assert.match(e.message, /glTF 魔数/)
    return true
  })
})

test('下载失败 ⇒ network，不返回半截数据', async () => {
  const client = new StepPartsClient({ fetchImpl: fakeApi({ p: PICO }, { failGlb: true }) })
  await assert.rejects(() => client.download('p'), (e: unknown) => {
    assert.ok(e instanceof StepPartsError)
    assert.equal(e.code, 'network')
    return true
  })
})

test('不存在的 partId ⇒ not_found', async () => {
  const client = new StepPartsClient({ fetchImpl: fakeApi({ p: PICO }) })
  await assert.rejects(() => client.download('nope'), (e: unknown) => {
    assert.ok(e instanceof StepPartsError)
    assert.equal(e.code, 'not_found')
    return true
  })
})

/* ─────────────────── 路由 ─────────────────── */

function startHost(routes: HttpRoute[], upgrades: UpgradeRoute[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname
    let route = routes.find((c) => c.kind === 'exact' && c.path === pathname)
    if (route === undefined) {
      route = routes
        .filter((c) => c.kind === 'prefix')
        .filter((c) => pathname === c.path || pathname.startsWith(`${c.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]
    }
    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (_req, socket) => {
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, base: `http://127.0.0.1:${String(port)}` })
    })
  })
}

async function withRoutes(fn: (base: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'dsh-hw-sp-'))
  const store = new ModelStore({ root })
  const state = new AssemblyState()
  const bus = new HardwareEventBus()
  const capabilities = (): HostCapabilities => ({
    scene: true,
    externalProcess: true,
    renderCapture: false,
    vision: false,
    version: 'test',
  })
  const stepParts = new StepPartsClient({ fetchImpl: fakeApi({ raspberry_pi_pico: PICO }) })
  const bundle = createRouteBundle({ state, bus, capabilities, models: store, stepParts })
  const { server, base } = await startHost(bundle.http, bundle.upgrade)
  try {
    await fn(base)
  } finally {
    bundle.dispose()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
    await rm(root, { recursive: true, force: true })
  }
}

test('路由：搜索返回**候选**（可一键导入）', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.search}?q=raspberry_pi_pico`)
    assert.equal(response.status, 200)
    const body = (await response.json()) as { candidates: ModelCandidate[]; unavailable?: string }
    assert.equal(body.candidates.length, 1)
    assert.equal(body.candidates[0]?.importable, true)
    // 没配通用搜索 ⇒ 应有说明，而不是静默少一半
    assert.match(body.unavailable ?? '', /通用搜索/)
  })
})

test('★ 路由：一键导入 —— 客户端只给 partId，全程不跳浏览器', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.import}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelKey: 'rpi-4b', partId: 'raspberry_pi_pico' }),
    })
    assert.equal(response.status, 200)
    const body = (await response.json()) as { ok: boolean; record?: { format: string; bytes: number } }
    assert.equal(body.ok, true)
    assert.equal(body.record?.format, 'glb')

    // 导入后立刻能从清单里看到
    const list = (await (await fetch(`${base}${MODEL_ROUTES.base}`)).json()) as unknown[]
    assert.equal(list.length, 1)
  })
})

test('路由：导入缺参数回 400；GET 回 405', async () => {
  await withRoutes(async (base) => {
    const missing = await fetch(`${base}${MODEL_ROUTES.import}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelKey: 'x' }),
    })
    assert.equal(missing.status, 400)

    assert.equal((await fetch(`${base}${MODEL_ROUTES.import}`)).status, 405)
  })
})

test('路由：partId 不存在回 502（上游失败，不是我们的 4xx）', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.import}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelKey: 'x', partId: 'does_not_exist' }),
    })
    assert.equal(response.status, 502)
    const body = (await response.json()) as { reason?: string }
    assert.equal(body.reason, 'not_found')
  })
})

test('路由：未配 stepParts 时不注册搜索与导入（能力降级）', () => {
  const state = new AssemblyState()
  const bus = new HardwareEventBus()
  const bundle = createRouteBundle({
    state,
    bus,
    capabilities: () => ({
      scene: true,
      externalProcess: true,
      renderCapture: false,
      vision: false,
      version: 'test',
    }),
  })
  try {
    const paths = bundle.http.map((r) => r.path)
    assert.equal(paths.includes(MODEL_ROUTES.search), false)
    assert.equal(paths.includes(MODEL_ROUTES.import), false)
  } finally {
    bundle.dispose()
  }
})
