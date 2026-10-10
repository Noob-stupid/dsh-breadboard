/**
 * `seedPackagedModels` 的测试。
 *
 * ★★ 这个文件存在的**直接原因**：上一版种子逻辑内联在 `index.ts` 里、**没法测**，
 *   于是带着一个「Promise 永远 !== undefined」的 bug 上线 ——
 *   **每个键都被当成"已经有了"，一个模型都没补，而且不报错。**
 *   用户看到的现象就是「怎么还是这种建模呢，为什么又是这种单独方块」。
 *
 *   ⇒ 抽成函数 + 这组测试，就是不让那个 bug 再回来一次。
 *   ★ 全部依赖**注入**（不碰真实磁盘），所以跑得飞快、也不会有残留。
 */

import path from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { seedPackagedModels, type SeedDeps } from '../src/core/models/seed.ts'
import { ModelStore } from '../src/core/models/store.ts'

/** 造一个假的 world：包里有哪几个 key、用户已有哪几个、复制到哪去了。 */
function fakeWorld(options: {
  packaged: readonly string[]
  packagedWithoutModelBin?: readonly string[]
  existing?: readonly string[]
}) {
  const copied: { from: string; to: string }[] = []
  const madeDirs: string[] = []
  const asked: string[] = []

  const deps: SeedDeps = {
    packagedDir: '/pkg/models',
    store: {
      root: '/user/models',
      get: (modelKey: string) => {
        asked.push(modelKey)
        return Promise.resolve(
          (options.existing ?? []).includes(modelKey) ? { record: {}, bytes: Buffer.alloc(0) } : undefined,
        )
      },
    } as unknown as SeedDeps['store'],
    listDirs: () => Promise.resolve(options.packaged),
    // 包里那四个目录**同时有 meta.json 与 model.bin**
    exists: (file: string) =>
      Promise.resolve(!(options.packagedWithoutModelBin ?? []).some((key) => file.includes(key))),
    mkdir: (dir: string) => {
      madeDirs.push(dir)
      return Promise.resolve()
    },
    copyFile: (from: string, to: string) => {
      copied.push({ from, to })
      return Promise.resolve()
    },
  }
  return { deps, copied, madeDirs, asked }
}

test('★ 包里有的、用户没有的 ⇒ 补进去', async () => {
  const world = fakeWorld({ packaged: ['esp32-seat-sensor', 'hc-sr501'] })
  const outcome = await seedPackagedModels(world.deps)
  assert.deepEqual(outcome.seeded, ['esp32-seat-sensor', 'hc-sr501'])
  // ★ 每个 key **两个文件**：model.bin（几何）+ meta.json（宿主认不认得它）
  assert.equal(world.copied.length, 4, '两个 key × 两个文件')
  assert.ok(
    world.copied.some((item) => item.to.endsWith('meta.json')),
    '★ meta.json 必须一起复制 —— 只复制 model.bin 的话宿主认不出它，仍然是占位盒',
  )
  // ★ 用 path.join 拼期望值 —— 写死 '…/model.bin' 在 Windows 上必假（path.join 给的是反斜杠）。
  //   第一版就是这么写的，于是**测试失败了而代码是对的** —— 测试自己会骗人。
  assert.equal(world.copied[0]?.to, path.join('/user/models', 'esp32-seat-sensor', 'model.bin'))
})

test('★★ 用户已经有的 ⇒ **绝不覆盖**（他自己导入的那份更可信）', async () => {
  const world = fakeWorld({ packaged: ['rpi-4b', 'hc-sr501'], existing: ['rpi-4b'] })
  const outcome = await seedPackagedModels(world.deps)
  assert.deepEqual(outcome.seeded, ['hc-sr501'], '只补缺的那个')
  assert.deepEqual(outcome.skipped, ['rpi-4b'], '已有的进 skipped，不是静默丢掉')
  assert.equal(world.copied.length, 2, '只补缺的那个（× 两个文件）—— **不能**去复制 rpi-4b')
  assert.ok(!world.copied.some((item) => item.from.includes('rpi-4b')), 'rpi-4b 一个字都不该被复制')
})

test('★ 包里那条没有 model.bin ⇒ 跳过（不是崩溃）', async () => {
  const world = fakeWorld({ packaged: ['broken', 'good'], packagedWithoutModelBin: ['broken'] })
  const outcome = await seedPackagedModels(world.deps)
  assert.deepEqual(outcome.seeded, ['good'])
  assert.deepEqual(outcome.skipped, ['broken'])
})

test('★★ `get` 是 async —— 这个测试专门钉住"忘了 await"那个 bug', async () => {
  // 造一个 store：`get` 返回 Promise（**永远不是 undefined**），内容却表示"没有"。
  // 忘了 await 的写法会把它当成"已经有了"⇒ 一个都不补 ⇒ 本断言失败。
  const copied: string[] = []
  const outcome = await seedPackagedModels({
    packagedDir: '/pkg/models',
    store: {
      root: '/user/models',
      get: () => Promise.resolve(undefined), // ← 返回 Promise<undefined>
    } as unknown as SeedDeps['store'],
    listDirs: () => Promise.resolve(['esp32-seat-sensor']),
    exists: () => Promise.resolve(true),
    mkdir: () => Promise.resolve(),
    copyFile: (_from, to) => {
      copied.push(to)
      return Promise.resolve()
    },
  })
  assert.deepEqual(outcome.seeded, ['esp32-seat-sensor'], '必须真的补 —— 而不是把 Promise 当成"已有"')
  assert.equal(copied.length, 2, 'model.bin + meta.json')
})

test('★ 包内目录读不到 ⇒ 报 failure，但**不抛**（不能拖垮插件启动）', async () => {
  const outcome = await seedPackagedModels({
    packagedDir: '/does/not/exist',
    store: { root: '/user/models', get: () => Promise.resolve(undefined) } as unknown as SeedDeps['store'],
    listDirs: () => Promise.reject(new Error('ENOENT')),
  })
  assert.deepEqual(outcome.seeded, [])
  assert.match(outcome.failure ?? '', /ENOENT/, '原因要如实报出来')
})

test('★ 中途失败 ⇒ 已补的**如实保留**，不假装什么都没发生', async () => {
  const copied: string[] = []
  const outcome = await seedPackagedModels({
    packagedDir: '/pkg/models',
    store: { root: '/user/models', get: () => Promise.resolve(undefined) } as unknown as SeedDeps['store'],
    listDirs: () => Promise.resolve(['a', 'b', 'c']),
    exists: () => Promise.resolve(true),
    mkdir: () => Promise.resolve(),
    copyFile: (_from, to) => {
      // ★ 同样要平台无关：	o 在 Windows 上是反斜杠
      if (to.endsWith(path.join('c', 'model.bin'))) return Promise.reject(new Error('disk full'))
      copied.push(to)
      return Promise.resolve()
    },
  })
  assert.deepEqual(outcome.seeded, ['a', 'b'], 'a、b 真的补进去了，必须报出来')
  assert.ok(outcome.failure !== undefined, 'c 失败要有原因')
})

/* ─────────── ★★ 往返测试：补完之后 **store 真的读得出来吗** ─────────── */

test('★★ 往返：seed 之后 `ModelStore` 必须**认得出**补进去的模型', async () => {
  // ⚠️⚠️ 这条测试存在的理由很具体：上面那几条断言的是"我调用 copyFile 了吗"，
  //   而**真正要保证的是"补完之后宿主读得出来吗"**。
  //   第一版只复制 `model.bin`、不复制 `meta.json` —— 文件在磁盘上、日志说"已补齐 N 个"，
  //   而 `ModelStore.list()` / `get()` 都按 `meta.json` 认模型 ⇒ **宿主完全看不见它** ⇒ 仍然是占位盒。
  //   上面那几条测试**全部通过**，用户看到的仍然全是方块。
  //   ⇒ 必须用**真实目录**跑一次端到端，断言"读得出来"。
  const pkg = await mkdtemp(path.join(tmpdir(), 'dsh-seed-pkg-'))
  const user = await mkdtemp(path.join(tmpdir(), 'dsh-seed-user-'))
  try {
    // 造一个"包内模型"：meta.json + model.bin（**两份都要**，这就是真实形状）
    const src = path.join(pkg, 'demo-model')
    await mkdir(src, { recursive: true })
    await writeFile(path.join(src, 'meta.json'), JSON.stringify({ modelKey: 'demo-model', format: 'glb', bytes: 3 }), 'utf8')
    await writeFile(path.join(src, 'model.bin'), Buffer.from([1, 2, 3]))

    const store = new ModelStore({ root: user })
    assert.deepEqual(await store.list(), [], '一开始用户目录是空的')

    const outcome = await seedPackagedModels({ packagedDir: pkg, store })
    assert.deepEqual(outcome.seeded, ['demo-model'])

    // ★★ 这才是真正的验收标准：**store 认得出它**
    const listed = await store.list()
    assert.equal(listed.length, 1, '★ 补完之后 store.list() 必须看得到它')
    assert.equal(listed[0]?.modelKey, 'demo-model')

    const got = await store.get('demo-model')
    assert.ok(got !== undefined, '★ store.get() 也必须读得出来')
    assert.equal(got.bytes.length, 3, '字节数要对得上')
  } finally {
    await rm(pkg, { recursive: true, force: true })
    await rm(user, { recursive: true, force: true })
  }
})

test('★★ 往返：**已经在用户目录里的，种子之后内容不变**（不被包里那份覆盖）', async () => {
  const pkg = await mkdtemp(path.join(tmpdir(), 'dsh-seed-pkg-'))
  const user = await mkdtemp(path.join(tmpdir(), 'dsh-seed-user-'))
  try {
    const src = path.join(pkg, 'demo-model')
    await mkdir(src, { recursive: true })
    await writeFile(path.join(src, 'meta.json'), JSON.stringify({ modelKey: 'demo-model', format: 'glb', bytes: 3 }), 'utf8')
    await writeFile(path.join(src, 'model.bin'), Buffer.from([1, 2, 3]))

    // 用户自己导入过一份**不一样**的（10 字节）
    const dst = path.join(user, 'demo-model')
    await mkdir(dst, { recursive: true })
    await writeFile(path.join(dst, 'meta.json'), JSON.stringify({ modelKey: 'demo-model', format: 'glb', bytes: 10 }), 'utf8')
    await writeFile(path.join(dst, 'model.bin'), Buffer.alloc(10, 9))

    const store = new ModelStore({ root: user })
    const outcome = await seedPackagedModels({ packagedDir: pkg, store })
    assert.deepEqual(outcome.seeded, [], '已经有了 ⇒ 不补')
    assert.deepEqual(outcome.skipped, ['demo-model'])

    const got = await store.get('demo-model')
    assert.equal(got?.bytes.length, 10, '★ 用户那份**一个字都不该被改**')
    assert.equal(got?.bytes[0], 9)
  } finally {
    await rm(pkg, { recursive: true, force: true })
    await rm(user, { recursive: true, force: true })
  }
})
