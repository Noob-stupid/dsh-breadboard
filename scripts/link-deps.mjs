#!/usr/bin/env node
/**
 * 链接构建期 / 运行期依赖 —— 可重复执行（幂等）。
 *
 * ★ 为什么必须有这个脚本（而不是把链接写在 build.sh 里）：
 *   `npm install` 会**清掉** node_modules 里它不认识的 junction
 *   （实测：装一个 `ws` 就顺带删掉了 @deepseek-ai/* 与 @standard-schema）。
 *   被删之后 tsc 会报模块找不到、插件运行时会 ERR_MODULE_NOT_FOUND，
 *   而报错现场的成因非常不直观。
 *   所以链接必须能**在 npm install 之后自动重建** ⇒ 挂到 postinstall 上。
 *
 * ★ 找不到 checkout 时**不报错退出 0** —— postinstall 绝不能因为环境缺 checkout
 *   而把 `npm install` 整个搞失败。
 *
 * ★ 关于 schemastery：它是本项目**唯一**需要运行时 JS 的 @deepseek-ai 依赖
 *   （其余全是 `import type`，编译期擦除，有 .d.ts 就够）。
 *   checkout 的 vendor/ 是源码态只有 lib/types，链它会让插件加载时
 *   ERR_MODULE_NOT_FOUND: .../schemastery/lib/index.mjs。
 *   因此优先用 profile 里宿主实际加载的**已构建**副本。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NM = path.join(ROOT, 'node_modules')

const warn = (message) => console.warn(`[link-deps] ${message}`)
const info = (message) => console.log(`[link-deps] ${message}`)

/** 解析 dsh 源码 checkout。 */
function resolveCheckout() {
  const fromEnv = process.env.DSH_CHECKOUT
  if (fromEnv && fs.existsSync(path.join(fromEnv, 'packages'))) return fromEnv

  const home = os.homedir()
  const candidates = [
    path.join(home, 'dsh-harness'),
    path.join(home, 'dsh'),
    path.join(home, '.dsh', 'dsh-harness'),
    'D:/dsh/deepseek-harness',
  ]
  return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'packages')))
}

/** 把一个已存在的目录链到 node_modules/<spec>（先删后建，幂等）。 */
function link(spec, target, label) {
  if (!fs.existsSync(target)) {
    warn(`跳过 ${spec}：目标不存在 ${target}`)
    return false
  }
  const linkPath = path.join(NM, spec)
  fs.rmSync(linkPath, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(linkPath), { recursive: true })
  fs.symlinkSync(path.resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  if (label) info(`${spec.padEnd(32)} <- ${label}`)
  return true
}

const checkout = resolveCheckout()
if (!checkout) {
  warn('未找到 dsh 源码 checkout（设 DSH_CHECKOUT 可指定）；跳过链接，仅影响编译/运行，不影响 npm install')
  process.exit(0)
}

info(`checkout: ${checkout}`)
fs.mkdirSync(path.join(NM, '@deepseek-ai'), { recursive: true })

// @standard-schema/spec：schemastery 的依赖，从 pnpm store 里挖出来
fs.rmSync(path.join(NM, '@standard-schema'), { recursive: true, force: true })
const pnpmDir = path.join(checkout, 'node_modules', '.pnpm')
if (fs.existsSync(pnpmDir)) {
  const entry = fs
    .readdirSync(pnpmDir)
    .find((name) => name.toLowerCase().startsWith('@standard-schema+spec@'))
  if (entry) {
    link('@standard-schema/spec', path.join(pnpmDir, entry, 'node_modules', '@standard-schema', 'spec'))
  }
}

// ① 编译期依赖：项目里全是 `import type`，只要有 .d.ts 即可 ⇒ 链 checkout 源码
link('@deepseek-ai/cordis', path.join(checkout, 'vendor', 'cordis'))
link('cosmokit', path.join(checkout, 'vendor', 'cosmokit'))
link('@deepseek-ai/dsh-tools', path.join(checkout, 'packages', 'core', 'tools'))
link('@deepseek-ai/dsh-llm', path.join(checkout, 'packages', 'llm', 'llm'))
link('@deepseek-ai/dsh-system-prompt', path.join(checkout, 'packages', 'core', 'system-prompt'))
link('@types/node', path.join(checkout, 'node_modules', '@types', 'node'))

// ② 运行时依赖：schemastery 是值导入，必须拿到**已构建**的 JS
const profileNm = path.join(
  process.env.DSH_PROFILE_DIR ?? path.join(os.homedir(), '.dsh', 'profiles', 'desktop'),
  'node_modules',
)
const builtSchemastery = path.join(profileNm, '@deepseek-ai', 'schemastery')
const hasBuilt =
  fs.existsSync(path.join(builtSchemastery, 'lib', 'index.mjs')) ||
  fs.existsSync(path.join(builtSchemastery, 'lib', 'index.cjs'))

if (hasBuilt) {
  link('@deepseek-ai/schemastery', builtSchemastery, 'profile 已构建副本')
} else {
  warn('未找到已构建的 schemastery，回退 checkout 源码（只够 tsc 编译，运行时会缺 lib/index.mjs）')
  link('@deepseek-ai/schemastery', path.join(checkout, 'vendor', 'schemastery'))
}

info('依赖链接完成')
