/**
 * 宿主半入口冒烟测试。
 *
 * 验证 `src/index.ts` 这个**组装点**本身可用：
 *   · 插件导出形状正确（name / inject / Config / apply）
 *   · Config 的默认值能正确解析
 *   · apply() 能在最小 mock ctx 下跑起来（不依赖任何宿主服务）
 *   · 启动自检真的跑完并报「通过」
 *
 * ★ 这条测试的价值：内核单测证明算法对，入口冒烟证明**插件能被真的装起来**。
 *   两者都绿，才算「① 可交付」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply, Config, inject, name } from '../src/index.ts'
import type { Config as PluginConfig } from '../src/index.ts'
import { CHAT_ROUTE, HTTP_ROUTES, MODEL_ROUTES, WS_ROUTE } from '../src/contracts/protocol.ts'

/** 最小 mock ctx —— 只提供 apply() 实际用到的 logger（info 与 warn 都收）。 */
function mockContext(): {
  logger: { info(message: string): void; warn(message: string): void }
  logs: string[]
} {
  const logs: string[] = []
  return {
    logs,
    logger: {
      info(message: string): void {
        logs.push(message)
      },
      warn(message: string): void {
        logs.push(message)
      },
    },
  }
}

/** 等到日志里出现包含 `needle` 的行（或超时）。 */
async function waitForLog(logs: string[], needle: string, timeoutMs = 2000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = logs.find((line) => line.includes(needle))
    if (hit !== undefined) return hit
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
  }
  return undefined
}

test('插件导出形状正确', () => {
  assert.equal(name, '@dsh-breadboard/dsh-hardware-sandbox')
  assert.ok(Array.isArray(inject), 'inject 必须是数组（Cordis 服务注入声明）')
  assert.equal(typeof apply, 'function')
  assert.ok(Config, 'Config schema 必须导出，否则宿主无法投影配置')
})

test('Config 默认值可解析（宿主不传任何配置也能跑）', () => {
  const resolved = Config({}) as PluginConfig
  assert.equal(resolved.step, 0.001)
  assert.equal(resolved.yieldBudgetMs, 1, '让出预算默认必须是实测最优的 1ms')
  assert.equal(resolved.maxAdvanceSeconds, 3600)
  assert.equal(resolved.selfCheck, true)
  assert.equal(resolved.seedDemo, true, '联调期默认铺演示装配，便于前端一连上就有内容')
  assert.equal(resolved.pythonPath, '', '默认不猜 Python 路径')
})

test('Config 越界值被 schema 拒绝', () => {
  assert.throws(() => Config({ step: 0 }), 'step 必须为正')
  assert.throws(() => Config({ yieldBudgetMs: -1 }), 'yieldBudgetMs 不得为负')
})

test('apply() 在最小 mock ctx 下可运行，并打印内核就绪', () => {
  const { logger, logs } = mockContext()
  apply({ logger } as never, {
    step: 0.001,
    yieldBudgetMs: 1,
    maxAdvanceSeconds: 3600,
    selfCheck: false,
    seedDemo: false,
    pythonPath: '',
  })

  const ready = logs.find((line) => line.includes('虚拟时钟内核就绪'))
  assert.ok(ready, `未打印内核就绪日志，实际日志：${JSON.stringify(logs)}`)
  assert.ok(ready.includes('yieldBudgetMs=1ms'), '就绪日志应带上实际生效的让出预算')
})

test('缺 webServer 时降级而不抛错（§10.3 能力探测）', () => {
  const { logger, logs } = mockContext()
  // 不提供 webServer —— 内核仍须可用，只是没有前后端桥
  apply({ logger } as never, {
    step: 0.001,
    yieldBudgetMs: 1,
    maxAdvanceSeconds: 3600,
    selfCheck: false,
    seedDemo: false,
    pythonPath: '',
  })
  assert.ok(
    logs.some((line) => line.includes('webServer')),
    '缺少 webServer 时应当明确告警，而不是静默失败',
  )
})

test('★ 提供 webServer 时注册 HTTP 与 WS 路由', () => {
  const { logger, logs } = mockContext()
  const registered: string[] = []
  const upgraded: string[] = []

  apply(
    {
      logger,
      webServer: {
        register(route: { path: string }) {
          registered.push(route.path)
          return () => undefined
        },
        registerUpgrade(route: { path: string }) {
          upgraded.push(route.path)
          return () => undefined
        },
      },
      subprocess: {},
    } as never,
    {
      step: 0.001,
      yieldBudgetMs: 1,
      maxAdvanceSeconds: 3600,
      selfCheck: false,
      seedDemo: true,
      pythonPath: '',
    },
  )

  assert.deepEqual(
    registered.sort(),
    [
      HTTP_ROUTES.action,
      HTTP_ROUTES.assembly,
      HTTP_ROUTES.capabilities,
      // ★ 模型路由注册**两条**，路径串相同：exact（列表）+ prefix（单项）。
      //   精确表先于前缀表匹配，所以 `<base>` 本身仍走列表。
      MODEL_ROUTES.base,
      MODEL_ROUTES.base,
      MODEL_ROUTES.search,
      MODEL_ROUTES.import,
    ].sort(),
  )
  assert.deepEqual(upgraded, [WS_ROUTE])
  assert.ok(
    logs.some((line) => line.includes('演示装配就绪')),
    `seedDemo 应铺出可渲染内容，日志：${JSON.stringify(logs)}`,
  )
})

test('★ 有 agents 服务时才注册聊天路由（否则前端会拿到一个永远发不出去的输入框）', () => {
  const { logger } = mockContext()
  const registered: string[] = []

  apply(
    {
      logger,
      webServer: {
        register(route: { path: string }) {
          registered.push(route.path)
          return () => undefined
        },
        registerUpgrade() {
          return () => undefined
        },
      },
      subprocess: {},
      // ★ 关键：提供 agents。`createChatSender` **总是返回一个函数**，
      //   所以入口必须先判**服务**在不在，不能判 sender 在不在 ——
      //   判 sender 的话条件恒为真，路由会照注册、capabilities.chat 报 true，
      //   而实际每次都失败（前端于是显示一个永远发不出去的框）。
      get(name: string) {
        return name === 'agents' ? { list: () => [], get: () => undefined } : undefined
      },
    } as never,
    {
      step: 0.001,
      yieldBudgetMs: 1,
      maxAdvanceSeconds: 3600,
      selfCheck: false,
      seedDemo: false,
      pythonPath: '',
    },
  )

  assert.ok(
    registered.includes(CHAT_ROUTE),
    `有 agents 时应当注册 ${CHAT_ROUTE}，实际注册了：${JSON.stringify(registered)}`,
  )
})

test('启动自检真的跑完，且在真实宿主环境下 T1 断言成立', async () => {
  const { logger, logs } = mockContext()
  apply({ logger } as never, {
    step: 0.001,
    yieldBudgetMs: 1,
    maxAdvanceSeconds: 3600,
    selfCheck: true,
    seedDemo: false,
    pythonPath: '',
  })

  const passed = await waitForLog(logs, '内核自检通过')
  assert.ok(
    passed,
    `自检未通过或未完成。日志：${JSON.stringify(logs)}`,
  )
  // T1 的核心断言必须逐字成立
  assert.ok(passed.includes('readings=[1,2,3,4,5]'), `自检读数序列不对：${passed}`)
  // 5 次 advance(1.0) 在 step=1ms 下应 tick 满 5000 片
  assert.ok(passed.includes('tickCount=5000'), `自检片数不对：${passed}`)
})

test('关闭自检时不产生自检日志（selfCheck 开关有效）', async () => {
  const { logger, logs } = mockContext()
  apply({ logger } as never, {
    step: 0.001,
    yieldBudgetMs: 1,
    maxAdvanceSeconds: 3600,
    selfCheck: false,
  })

  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  assert.equal(
    logs.some((line) => line.includes('内核自检')),
    false,
    'selfCheck=false 时不应跑自检',
  )
})
