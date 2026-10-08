/**
 * ModelStore 与模型路由测试。
 *
 * ★ 重点在两处**不是功能、是边界**的地方：
 *   ① **目录穿越** —— modelKey 会拼进文件路径，不校验就是漏洞
 *   ② **原子写入** —— 中断不能留下"看起来正常"的半截文件（本项目那个失败族）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { ModelStore, ModelStoreError } from '../src/core/models/store.ts'
import { AssemblyState } from '../src/core/state/assembly-state.ts'
import { HardwareEventBus } from '../src/core/events.ts'
import { createRouteBundle, type HttpRoute, type UpgradeRoute } from '../src/host/routes.ts'
import { MODEL_MAX_BYTES, MODEL_ROUTES } from '../src/contracts/protocol.ts'
import type { ImportedModelRecord } from '../src/contracts/protocol.ts'
import type { HostCapabilities } from '../src/contracts/protocol.ts'

/** 一个最小合法 GLB（只需要魔数，格式检测看的就是它）。 */
const GLB = Buffer.concat([Buffer.from('glTF', 'ascii'), Buffer.alloc(8, 0)])
/** 一个最小合法 glTF（JSON）。 */
const GLTF = Buffer.from('{"asset":{"version":"2.0"}}', 'utf8')

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'dsh-hw-models-'))
}

/* ─────────────────── 存储：基本读写 ─────────────────── */

test('put / get / list / delete 往返', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    assert.deepEqual(await store.list(), [], '空目录应返回空清单而不是报错')

    const record = await store.put('bme280', GLB)
    assert.equal(record.modelKey, 'bme280')
    assert.equal(record.format, 'glb')
    assert.equal(record.bytes, GLB.length)
    assert.ok(record.importedAt.length > 0)

    const found = await store.get('bme280')
    assert.ok(found)
    assert.deepEqual(found.bytes, GLB, '取回的字节必须逐字节相同')

    assert.equal((await store.list()).length, 1)
    assert.equal(await store.delete('bme280'), true)
    assert.equal(await store.get('bme280'), undefined)
    assert.equal(await store.delete('bme280'), false, '删不存在的应返回 false 而不是抛错')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('覆盖导入：同名再传一次应替换而不是叠加', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    await store.put('rpi-4b', GLB)
    await store.put('rpi-4b', GLTF)
    const found = await store.get('rpi-4b')
    assert.equal(found?.record.format, 'gltf')
    assert.deepEqual(found?.bytes, GLTF)
    assert.equal((await store.list()).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────── ★ 安全边界：目录穿越 ─────────────────── */

test('★ 目录穿越：各种恶意 modelKey 必须全部被拒', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    const evil = [
      '../escape',
      '../../etc/passwd',
      '..',
      '.',
      'a/b',
      'a\\b',
      '/absolute',
      'C:\\Windows\\x',
      '.hidden',
      '',
      'UPPER',
      'has space',
      'a'.repeat(65), // 超长
    ]

    for (const key of evil) {
      await assert.rejects(
        () => store.put(key, GLB),
        ModelStoreError,
        `恶意 modelKey 必须被拒：${JSON.stringify(key)}`,
      )
    }

    // ★ 关键：确认 root 之外**没有**被写出任何东西
    const parent = path.dirname(root)
    const siblings = await readdir(parent)
    assert.equal(
      siblings.some((name) => name === 'escape'),
      false,
      '不得在 root 之外创建目录',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('合法 modelKey 正常通过（边界另一侧）', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    for (const key of ['bme280', 'rpi-4b', 'led_5v', 'a', 'x.y', '0abc']) {
      await store.put(key, GLB)
    }
    assert.equal((await store.list()).length, 6)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────── 格式检测（不信 content-type，只信内容） ─────────────────── */

test('格式检测：按**内容**判定，不信扩展名、不信 content-type', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })

    assert.equal((await store.put('a', GLB)).format, 'glb')
    assert.equal((await store.put('b', GLTF)).format, 'gltf')
    // 前导空白不影响判定
    assert.equal((await store.put('c', Buffer.from('\n\n  {"asset":{"version":"2.0"}}', 'utf8'))).format, 'gltf')

    // ★ 任意 JSON **不是** glTF —— 规范要求 `asset` 字段，所以必须拒
    await assert.rejects(
      () => store.put('d', Buffer.from('{"x":1}', 'utf8')),
      ModelStoreError,
      '普通 JSON 不能被当成 glTF',
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('★ 放开后的格式都能被认出来（判据是「three 有没有 loader」）', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })

    // ASCII STL
    const asciiStl = Buffer.from('solid test\nfacet normal 0 0 1\nouter loop\nendloop\nendfacet\nendsolid', 'utf8')
    assert.equal((await store.put('stl_a', asciiStl)).format, 'stl')

    // 二进制 STL：80 字节头 + 面数 n + 50n 字节。
    // ★ 文件头**故意以 solid 开头** —— 导出软件常这么写，考验判据顺序（必须先判二进制）
    const header = Buffer.alloc(80, 0)
    header.write('solid binary', 0, 'ascii')
    const n = 2
    const count = Buffer.alloc(4)
    count.writeUInt32LE(n, 0)
    const binaryStl = Buffer.concat([header, count, Buffer.alloc(50 * n, 0)])
    assert.equal(
      (await store.put('stl_b', binaryStl)).format,
      'stl',
      '二进制 STL 的文件头也常以 solid 开头，必须先判二进制',
    )

    assert.equal((await store.put('ply', Buffer.from('ply\nformat ascii 1.0\nend_header', 'utf8'))).format, 'ply')
    assert.equal((await store.put('3mf', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).format, '3mf')
    assert.equal((await store.put('obj', Buffer.from('v 0 0 0\nv 1 0 0\nf 1 2 3\n', 'utf8'))).format, 'obj')
    assert.equal((await store.put('dae', Buffer.from('<?xml?><COLLADA xmlns="x"></COLLADA>', 'utf8'))).format, 'dae')
    assert.equal((await store.put('wrl', Buffer.from('#VRML V2.0 utf8\nShape{}', 'utf8'))).format, 'wrl')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('★ STEP 必须被明确拒绝，且理由点明「three 没有 loader」', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    const step = Buffer.from(
      "ISO-10303-21;\nHEADER;\nFILE_DESCRIPTION(('2;1'),'2;1');\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;",
      'utf8',
    )
    await assert.rejects(
      () => store.put('step', step),
      (error: unknown) => {
        assert.ok(error instanceof ModelStoreError)
        assert.match(
          error.message,
          /STEP/,
          '拒绝理由必须点明 STEP 不支持，而不是一句笼统的"格式不对"',
        )
        return true
      },
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('非模型文件一律拒绝，且不留下任何条目', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    for (const bad of [
      Buffer.from('PNG\x89', 'ascii'),
      Buffer.from('随便一段文字', 'utf8'),
      Buffer.from([0x00, 0x01, 0x02]),
    ]) {
      await assert.rejects(() => store.put('x', bad), ModelStoreError, '非模型文件必须被拒')
    }
    await assert.rejects(() => store.put('y', Buffer.alloc(0)), ModelStoreError, '空文件必须被拒')
    assert.equal((await store.list()).length, 0, '被拒的写入不得留下任何条目')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('超限拒绝', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root, maxBytes: 64 })
    await assert.rejects(() => store.put('big', Buffer.concat([GLB, Buffer.alloc(128)])), ModelStoreError)
    assert.equal((await store.list()).length, 0, '被拒的写入不得留下任何条目')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────── ★ 原子写入 ─────────────────── */

test('★ 原子写入：写入完成后目录里没有残留的临时文件', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    await store.put('bme280', GLB)
    const entries = await readdir(path.join(root, 'bme280'))
    assert.deepEqual(
      entries.sort(),
      ['meta.json', 'model.bin'],
      `不应留下 .tmp-* 残留，实际：${entries.join(', ')}`,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('★ 损坏的条目被跳过，而不是让整个清单打不开', async () => {
  const root = await tempRoot()
  try {
    const store = new ModelStore({ root })
    await store.put('good', GLB)

    // 手工造一个坏条目
    await mkdir(path.join(root, 'broken'), { recursive: true })
    await writeFile(path.join(root, 'broken', 'meta.json'), '{ 这不是 JSON', 'utf8')

    const list = await store.list()
    assert.equal(list.length, 1, '一条坏记录不该让整个清单失败')
    assert.equal(list[0]?.modelKey, 'good')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

/* ─────────────────── 路由 ─────────────────── */

/**
 * 复刻**宿主真实的**路由匹配规则。
 *
 * ★★ 这里踩过一个代价不小的坑：早先的替身写的是 `pathname.startsWith(candidate.path)`，
 *   而宿主实际规则是 `pathname === prefix || pathname.startsWith(prefix + '/')`
 *   （源码注释原文：**"Absolute pathname, no trailing slash"**）。
 *
 *   两条规则的差别在**前缀带尾斜杠**时才显形：带尾斜杠的前缀在宿主那边会被拼成 `.../model//`，
 *   永远匹配不上；而宽松的替身照样匹配 ⇒ **测试全绿、线上 404**。
 *
 *   ⇒ 教训：**测试替身的匹配/调度规则必须逐字复刻生产**，否则它证明的是替身自己。
 */
function startHost(routes: HttpRoute[], upgrades: UpgradeRoute[]): Promise<{ server: Server; base: string }> {
  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? '/', 'http://x').pathname

    // 精确表优先
    let route = routes.find((candidate) => candidate.kind === 'exact' && candidate.path === pathname)
    // 未命中则查前缀表：最长前缀胜出
    if (route === undefined) {
      route = routes
        .filter((candidate) => candidate.kind === 'prefix')
        .filter((candidate) => pathname === candidate.path || pathname.startsWith(`${candidate.path}/`))
        .sort((a, b) => b.path.length - a.path.length)[0]
    }

    if (route === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    void route.handler(req, res)
  })
  server.on('upgrade', (req, socket) => {
    socket.destroy()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, base: `http://127.0.0.1:${String(port)}` })
    })
  })
}

async function withRoutes(fn: (base: string, root: string) => Promise<void>): Promise<void> {
  const root = await tempRoot()
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
  const bundle = createRouteBundle({ state, bus, capabilities, models: store })
  const { server, base } = await startHost(bundle.http, bundle.upgrade)
  try {
    await fn(base, root)
  } finally {
    bundle.dispose()
    await new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => {
        resolve()
      })
    })
    await rm(root, { recursive: true, force: true })
  }
}

test('路由：空清单 → []', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.base}`)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), [])
  })
})

test('路由：上传 → 列出 → 取回 → 删除 全链路', async () => {
  await withRoutes(async (base) => {
    const upload = await fetch(`${base}${MODEL_ROUTES.base}/bme280`, {
      method: 'POST',
      body: GLB,
    })
    assert.equal(upload.status, 200)
    const body = (await upload.json()) as { ok: boolean; record: ImportedModelRecord }
    assert.equal(body.ok, true)
    assert.equal(body.record.format, 'glb')

    const list = (await (await fetch(`${base}${MODEL_ROUTES.base}`)).json()) as ImportedModelRecord[]
    assert.equal(list.length, 1)
    assert.equal(list[0]?.modelKey, 'bme280')

    const got = await fetch(`${base}${MODEL_ROUTES.base}/bme280`)
    assert.equal(got.status, 200)
    assert.equal(got.headers.get('content-type'), 'model/gltf-binary')
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), GLB, '取回的字节必须逐字节相同')

    const removed = await fetch(`${base}${MODEL_ROUTES.base}/bme280`, { method: 'DELETE' })
    assert.equal(removed.status, 200)

    assert.equal((await fetch(`${base}${MODEL_ROUTES.base}/bme280`)).status, 404)
  })
})

test('★ 路由：目录穿越必须被拒（且不写出任何文件）', async () => {
  await withRoutes(async (base, root) => {
    for (const evil of ['..%2Fescape', 'a%2Fb', '%2E%2E']) {
      const response = await fetch(`${base}${MODEL_ROUTES.base}/${evil}`, {
        method: 'POST',
        body: GLB,
      })
      assert.ok(
        response.status === 400 || response.status === 404,
        `恶意 key 必须被拒，实际 ${String(response.status)}（key=${evil}）`,
      )
    }
    const parent = path.dirname(root)
    assert.equal(
      (await readdir(parent)).includes('escape'),
      false,
      '不得在 root 之外创建任何东西',
    )
  })
})

test('路由：非法格式回 400 且带原因', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.base}/bme280`, {
      method: 'POST',
      body: Buffer.from('not a model', 'utf8'),
    })
    assert.equal(response.status, 400)
    const body = (await response.json()) as { reason?: string }
    assert.equal(body.reason, 'bad_format')
  })
})

test('路由：不支持的方法回 405', async () => {
  await withRoutes(async (base) => {
    const response = await fetch(`${base}${MODEL_ROUTES.base}/bme280`, { method: 'PUT' })
    assert.equal(response.status, 405)
  })
})

test('路由：未配置 models 时不注册模型路由（能力降级）', async () => {
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
    assert.equal(
      bundle.http.some((route) => route.path.startsWith(MODEL_ROUTES.base)),
      false,
      '没有存储就不该注册模型路由',
    )
  } finally {
    bundle.dispose()
  }
})

test('常量：上限是 64 MiB（32 MiB 装不下树莓派 4B 的 52MB GLB）', () => {
  assert.equal(MODEL_MAX_BYTES, 64 * 1024 * 1024)
})

/* ─────────────────── 节点数（性能画像的已知量） ─────────────────── */

/** 造一个最小但合法的 GLB：只有 JSON chunk，里面放 N 个空节点。 */
function makeGlb(nodeCount: number): Buffer {
  const json = Buffer.from(
    JSON.stringify({ asset: { version: '2.0' }, nodes: Array.from({ length: nodeCount }, () => ({})) }),
    'utf8',
  )
  const pad = (4 - (json.length % 4)) % 4
  const chunk = Buffer.concat([json, Buffer.alloc(pad, 0x20)])
  const header = Buffer.alloc(12)
  header.write('glTF', 0, 'ascii')
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + chunk.length, 8)
  const chunkHeader = Buffer.alloc(8)
  chunkHeader.writeUInt32LE(chunk.length, 0)
  chunkHeader.writeUInt32LE(0x4e4f534a, 4)
  return Buffer.concat([header, chunkHeader, chunk])
}

test('★ 导入时记下**节点数** —— 让性能画像从"事后才发现"变成"一开始就知道"', async () => {
  const dir = await tempRoot()
  const store = new ModelStore({ root: dir })
  const record = await store.put('many', makeGlb(2067))
  assert.equal(record.nodes, 2067, '★ 真树莓派是 2067 个节点；这个量必须在导入时可见')
  await rm(dir, { recursive: true, force: true })
})

test('节点数会**持久化**（重新读到还在，不是只活在这一次调用里）', async () => {
  const dir = await tempRoot()
  const store = new ModelStore({ root: dir })
  await store.put('many', makeGlb(42))
  const reread = await store.list()
  assert.equal(reread[0]?.nodes, 42)
  await rm(dir, { recursive: true, force: true })
})

test('★ 数不出来时**省略字段，绝不让导入失败**（它只是元数据）', async () => {
  const dir = await tempRoot()
  const store = new ModelStore({ root: dir })
  // 一个合法的**二进制 STL**（1 个三角形 ⇒ 84 + 50 = 134 字节）：
  // 它没有"节点"这个概念，所以 `nodes` 必须是 undefined，而导入本身要成功。
  const stl = Buffer.alloc(134, 0)
  stl.writeUInt32LE(1, 80)
  const record = await store.put('plain', stl)
  assert.equal(record.nodes, undefined)
  assert.ok(record.bytes > 0, '导入本身必须成功')
  await rm(dir, { recursive: true, force: true })
})
