/**
 * **可失败断言：`dsh.client.inject` 里的每个词都必须真的由宿主提供。**
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么需要它（被别人发现的问题，不是我们自己发现的）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 社区列表维护者核对我们的包时发现：`dsh.client.inject` 里写了一个
 * **宿主并不提供**的模块名（`@deepseek-ai/dsh-client-runtime`）。
 * 后果不是报错，而是 **注入静默失效** —— 界面上少个东西、日志里什么都没有。
 * ⇒ 这类错误**只能靠断言挡**：它长得和正确写法一模一样。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 提供集合从哪来：**一份有出处的显式清单**（不是自动扫描）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ 我第一版是**扫 node_modules** 推导的，**那是错的**：
 *   `@deepseek-ai/dsh-client-*` **不是 node_modules 里的包**，而是宿主
 *   在运行时提供的**客户端模块标识**；磁盘上没有可枚举的提供表。
 *   那一版会把 `dsh-client-ui-slots` 也判成不存在 —— 而面板正是用 slots 渲染的、
 *   它明明工作正常 ⇒ **那版断言会误伤正常条目**（比没有断言更坏：它会挡住发版，
 *   而挡的理由是假的）。
 *
 * ⇒ 现在读 `scripts/host-client-modules.json`：
 *   · 它是**转录**（出处写在那份文件里：维护者给的宿主模块表 + 本机实测），
 *   · 宿主升版时**必须跟着更新** —— 这一点在那个文件里已写明，
 *     免得下一个人以为是自动的。
 *
 * ⚠️ 只断言 `dsh.client.inject`（**前端**那条）。`peerDependencies` 里的同名条目
 *   **故意不动**：那是**兼容门控**读的东西（"我能跟哪个版本协作"），
 *   与"运行时宿主提供什么"是两码事 —— 一起删才是真改行为。
 */

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.dirname(here)

const manifestPath = path.join(here, 'host-client-modules.json')
let manifest
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
} catch (error) {
  console.error(
    `[inject-words] ✗ 读不到提供清单：${manifestPath}\n  ${String(error)}\n` +
      '  ★ 读不到就**不能**断言 —— 直接失败，而不是当成"没有要检查的东西"放行。',
  )
  process.exit(1)
}
const provided = new Set(manifest.provided ?? [])
if (provided.size === 0) {
  console.error('[inject-words] ✗ 提供清单是空的 —— 空清单会让断言永远失败（或永远通过），两种都没意义。')
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const inject = pkg?.dsh?.client?.inject ?? []
if (!Array.isArray(inject) || inject.length === 0) {
  console.log('[inject-words] dsh.client.inject 为空 —— 没有要断言的词。')
  process.exit(0)
}

const missing = inject.filter((word) => !provided.has(word))
console.log(`[inject-words] 提供清单 ${String(provided.size)} 条；inject ${String(inject.length)} 条`)
for (const word of inject) console.log(`  ${missing.includes(word) ? '✗' : '✓'} ${word}`)
if (missing.length > 0) {
  console.error(
    `\n[inject-words] ✗ 这些词宿主不提供：${missing.join(', ')}\n` +
      '  ⇒ 写进 inject 会**静默失效**（界面少个东西、日志什么都没有）。\n' +
      '  ⇒ 删掉它；若确认它该由宿主提供，请更新 scripts/host-client-modules.json 并注明出处\n' +
      '     （别按 node_modules 扫描推导 —— 那些名字不是包，见文件头说明）。',
  )
  process.exit(1)
}
console.log('[inject-words] ✓ 全部命中')
