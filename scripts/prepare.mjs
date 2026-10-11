/**
 * `prepare` —— **让"从 git 装"也能开箱即用**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 它补的是一个具体的洞
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `.gitignore` 排除了 `lib/`（构建产物不入库），而 `scripts` 里**原本没有 `prepare`**：
 *
 * | 装法 | 有 `lib/` 吗 | 结果 |
 * |---|---|---|
 * | `npm i <tarball>`（我们发的包） | ✅ 包里带着 | **开箱即用** |
 * | `npm i github:Noob-stupid/dsh-breadboard` | ❌ 被 gitignore | **装完是坏的**（没有入口） |
 *
 * ⇒ 加这个脚本，让 git 装法也能用。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 两条纪律：**别做多余的活**、**失败不许拖垮安装**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * **① 已经有 `lib/` 就不构建。** `prepare` 会在 `npm install`（本地开发）与
 *   `npm pack` 前都跑 —— 每次都全量构建既慢，又可能在打包时**改动产物**
 *   （让"我测过的那个包"和"发出去的那个包"不是同一份）。
 *
 * **② 构建失败只警告，`exit 0`。** 这是刻意反直觉的一步：
 *   一个构建失败**大概率**意味着环境缺东西（没装 devDeps、没有 bash）。
 *   若让 `prepare` 非零退出，**整个 install 会失败** —— 用户连包都装不上，
 *   而且错误信息指向 npm 而不是真正的原因。
 *   ⇒ 我们让 install 成功、**把"没有构建"这件事喊出来**，由使用者决定怎么办。
 *     这正是本项目那条纪律：**可见的失败 > 静默的成功**（但这里连"成功"都算不上，
 *     所以必须**显眼**）。
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const entry = path.join(root, 'lib', 'index.js')

if (existsSync(entry)) {
  console.log('[dsh-hardware-sandbox] lib/ 已存在，跳过构建。')
  process.exit(0)
}

console.log('[dsh-hardware-sandbox] 没有 lib/，尝试构建…')
const script = path.join(root, 'scripts', 'build.sh')
const result = spawnSync('bash', [script], { cwd: root, stdio: 'inherit', shell: false })

if (result.status === 0 && existsSync(entry)) {
  console.log('[dsh-hardware-sandbox] 构建完成。')
  process.exit(0)
}

// ★ ② 只警告，不失败 —— 详见文件头
console.warn(
  '\n[dsh-hardware-sandbox] ⚠️ 没能构建出 lib/，插件**不会有入口**。\n' +
    '  装法一（推荐）：用我们发布的 tgz —— 包里**已经带着** lib/。\n' +
    '  装法二：在本目录手动跑 `bash scripts/build.sh`（需要 bash + 已装 devDependencies）。\n' +
    `  诊断：exit=${String(result.status ?? 'null')} error=${String(result.error ?? '无')}\n`,
)
process.exit(0)
