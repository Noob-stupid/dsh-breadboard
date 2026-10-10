/**
 * **随包预置模型的补齐**（seed）—— owner: session-24ca6e69
 * @module dsh-hardware-sandbox/core/models/seed
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要它：一个"别人装上也一样"的问题
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 模型原来只存在于**用户目录**（`~/.dsh/dsh-hardware-sandbox/models`），
 * 而它**不在仓库里**（`.gitignore` 还把 `models/` 排除了）。
 *
 * ⇒ **任何人 clone / 装上这个插件后，一个模型都没有 ⇒ 场景里全是占位方块。**
 *
 * 用户的原话是：
 *
 *   > 为什么又是这种单独方块呢？……**别的 agent 到时候是否也会这样呢**
 *
 * **会，只要模型不随插件走。** 这个模块就是那条修复：
 * 包里带一份，启动时把**缺的**补进用户目录。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 三条纪律（每一条都对应一个具体的坏后果）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 只补缺的，绝不覆盖。**
 *   用户自己导入/替换过的模型是**他更信的那份**。被包里那份盖掉，症状是
 *   「我明明换过，怎么又变回去了」，而且**不报错**。
 *
 * **② 失败不影响启动。**
 *   种子是锦上添花。读不到包内目录（打包方式变了、路径不对）就照常跑，
 *   只是没有预置模型 —— **不能因为补模型失败就让整个插件起不来**。
 *
 * **③ 补了哪几个要说出来。**
 *   否则「为什么有模型」和「为什么没有」都无从判断 —— 这条是本项目一贯的纪律：
 *   **可见的失败 > 静默的成功**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 只发**我们自己生成的**模型
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 从 step.parts 导入的（`rpi-4b` / `mpl3115a2` / `mpr121`）是**第三方模型**，
 * **插件不分发它们** —— 这条在 `index.ts` 的模型目录注释里原本就写着。
 * 用户在界面上按需导入即可。
 *
 * 而演示装配用的恰好**全是自产模型**（`esp32-seat-sensor` + 2×`hc-sr501`），
 * ⇒ **开箱即用**。
 */

import { access, copyFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'

import type { ModelStore } from './store.ts'

/** 补齐结果 —— **两个清单都要给**，否则调用方分不清"补过了"和"本来就有"。 */
export interface SeedOutcome {
  /** 这次真的补进去的 modelKey。 */
  readonly seeded: readonly string[]
  /** 包里没有 model.bin、或用户已经有了 —— 跳过的。 */
  readonly skipped: readonly string[]
  /** 整个补齐动作失败的原因（如包内目录不存在）。**有值也不代表插件坏了。** */
  readonly failure?: string
}

/** seed 的依赖，全部可注入 —— 这样它能**不碰真实文件系统**地被测。 */
export interface SeedDeps {
  /** 包内预置模型目录（`<插件根>/models`）。 */
  readonly packagedDir: string
  /** 用户模型库。 */
  readonly store: ModelStore
  /** 复制实现，默认 `node:fs/promises` 的 `copyFile`。 */
  readonly copyFile?: (from: string, to: string) => Promise<void>
  /** 递归建目录，默认 `node:fs/promises` 的 `mkdir`。 */
  readonly mkdir?: (dir: string) => Promise<void>
  /** 目录列举，默认 `node:fs/promises` 的 `readdir`。 */
  readonly listDirs?: (dir: string) => Promise<readonly string[]>
  /** 判断文件存在，默认 `node:fs/promises` 的 `access`。 */
  readonly exists?: (file: string) => Promise<boolean>
}

const MODEL_FILE = 'model.bin'
/**
 * ★★ **元数据也必须复制** —— 这是第一版漏掉的，后果很隐蔽：
 *
 *   `ModelStore.list()` 是**按目录里的 `meta.json` 认模型**的（读不到就跳过该目录），
 *   而 `get()` 也是**同时读 `meta.json` 与 `model.bin`**。
 *   ⇒ 只复制 `model.bin` 的结果是：**文件在磁盘上、看得见，但宿主完全认不出它**
 *     ⇒ 场景里**仍然是占位盒**，而种子日志会兴高采烈地说"已补齐 N 个"。
 *
 *   ★ 更值得记的是**它为什么没被测试抓住**：那版测试断言的是
 *     「我调用 copyFile 了吗」——**测的是机制，不是结果**。
 *     而真正要断言的是一句「**补完之后 store 读得出来吗**」。
 *     ⇒ 所以下面加了一条用**真实临时目录**跑的往返测试（`seed-roundtrip`）。
 *     这与本项目失败族里那条 `ok:true ≠ 效果发生` 是同一个形状。
 */
const META_FILE = 'meta.json'

/**
 * 把包内预置模型补进用户模型库。
 *
 * ★ 与 `ModelStore.get()` 打交道时**必须 await** —— 它是 async 的。
 *   第一版写成 `if (store.get(k) !== undefined) continue`，
 *   而 **Promise 永远 `!== undefined`** ⇒ **每个键都被当成"已经有了"** ⇒ 一个都没补，
 *   **而且不报错**。这与本项目失败族里那条 `ok:true ≠ 效果发生` 是同一个形状：
 *   **拿"有个对象回来了"当成"内容是我要的"**。
 */
export async function seedPackagedModels(deps: SeedDeps): Promise<SeedOutcome> {
  const copyFileImpl = deps.copyFile ?? ((from: string, to: string) => copyFile(from, to))
  const mkdirImpl = deps.mkdir ?? ((dir: string) => mkdir(dir, { recursive: true }))
  const listDirsImpl =
    deps.listDirs ??
    (async (dir: string) => {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    })
  const existsImpl =
    deps.exists ??
    (async (file: string) => {
      try {
        await access(file)
        return true
      } catch {
        return false
      }
    })

  const seeded: string[] = []
  const skipped: string[] = []
  try {
    const keys = await listDirsImpl(deps.packagedDir)
    for (const key of keys) {
      const source = path.join(deps.packagedDir, key, MODEL_FILE)
      if (!(await existsImpl(source))) {
        skipped.push(key) // 包里这条没有 model.bin
        continue
      }
      // ★ ① **await**：`get` 是 async，Promise 永远不是 undefined
      if ((await deps.store.get(key)) !== undefined) {
        skipped.push(key) // 用户已经有了 → 不碰
        continue
      }
      const targetDir = path.join(deps.store.root, key)
      await mkdirImpl(targetDir)
      // ★★ **两个文件都要**：`model.bin` 是几何，`meta.json` 是"宿主认不认得它"。
      //   只复制前者 ⇒ 文件在磁盘上但 `list()` / `get()` 都看不见它 ⇒ **仍然是占位盒**。
      await copyFileImpl(source, path.join(targetDir, MODEL_FILE))
      const sourceMeta = path.join(deps.packagedDir, key, META_FILE)
      if (await existsImpl(sourceMeta)) {
        await copyFileImpl(sourceMeta, path.join(targetDir, META_FILE))
      }
      seeded.push(key)
    }
    return { seeded, skipped }
  } catch (error) {
    // ★ ② 失败**不是启动失败** —— 把已经补进去的如实报出来，并带上原因
    return { seeded, skipped, failure: String(error) }
  }
}
