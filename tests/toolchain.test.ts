/**
 * 烧录适配器的正反面。
 *
 * ★ 这里最重要的两条断言不是"参数拼对了"，而是**说法的边界**：
 *   · `exit 0` 只能说"上传工具报告成功"，**不能说板子重启了**；
 *   · 失败必须带回**日志尾部**（"烧录失败"四个字没法排查）。
 */

import { strict as assert } from 'node:assert'
import test from 'node:test'

import {
  findPlatformioCli,
  flashFirmware,
  platformioCliCandidates,
  tail,
  type ToolchainIo,
  type ToolRunResult,
} from '../src/core/toolchain/platformio.ts'

/** 可控的假 io：记录调用、按脚本返回。 */
function makeIo(script: ToolRunResult, existing: readonly string[] = []): { io: ToolchainIo; calls: { command: string; args: readonly string[]; cwd: string }[] } {
  const calls: { command: string; args: readonly string[]; cwd: string }[] = []
  const io: ToolchainIo = {
    exists: async (path) => existing.includes(path),
    join: (...parts) => parts.join('/'),
    run: async (command, args, cwd) => {
      calls.push({ command, args, cwd })
      return script
    },
  }
  return { io, calls }
}

/* ───────────────── 候选路径（用户路径优先） ───────────────── */

test('★ CLI 候选按用户路径优先：env 最前，且**包含不在 PATH 的常见安装位**', () => {
  const candidates = platformioCliCandidates({ PLATFORMIO_CORE_DIR: 'D:\\pio', USERPROFILE: 'C:\\Users\\x' }, 'C:\\Users\\x', 'win32')
  assert.ok(candidates[0]?.startsWith('D:/pio'), '环境变量必须最优先')
  assert.ok(
    candidates.some((c) => c.includes('C:/.platformio/penv/Scripts/platformio.exe')),
    '★ 本机实测 PlatformIO 就装在这里、且不在 PATH —— 候选里必须有它，否则会误判"没装"',
  )
  assert.equal(new Set(candidates).size, candidates.length, '不能有重复')
})

test('非 Windows 用 penv/bin/platformio', () => {
  const candidates = platformioCliCandidates({}, '/home/u', 'linux')
  assert.ok(candidates.some((c) => c.endsWith('/penv/bin/platformio')))
  assert.ok(!candidates.some((c) => c.endsWith('.exe')))
})

test('findPlatformioCli：返回第一个存在的；都没有 ⇒ undefined', async () => {
  const { io } = makeIo({ exitCode: 0, stdout: '', stderr: '' }, ['/a/penv/bin/platformio'])
  assert.equal(await findPlatformioCli(['/x/platformio', '/a/penv/bin/platformio'], io), '/a/penv/bin/platformio')
  assert.equal(await findPlatformioCli(['/x/platformio'], io), undefined)
})

/* ───────────────── 烧录：参数与判定 ───────────────── */

test('烧录参数：默认只 `run -t upload`；给了 env/port 才加', async () => {
  const a = makeIo({ exitCode: 0, stdout: 'ok', stderr: '' })
  await flashFirmware({ cli: 'pio', projectDir: '/proj', io: a.io })
  assert.deepEqual(a.calls[0]?.args, ['run', '-t', 'upload'])
  assert.equal(a.calls[0]?.cwd, '/proj', '★ 必须在工程目录里跑')

  const b = makeIo({ exitCode: 0, stdout: 'ok', stderr: '' })
  await flashFirmware({ cli: 'pio', projectDir: '/proj', environment: 'esp32dev', port: 'COM7', io: b.io })
  assert.deepEqual(b.calls[0]?.args, ['run', '-t', 'upload', '-e', 'esp32dev', '--upload-port', 'COM7'])
})

test('★★ exit 0 只能说"上传工具报告成功"——**不能说板子重启了**', async () => {
  const { io } = makeIo({ exitCode: 0, stdout: 'Writing at 0x1000... Hash of data verified.', stderr: '' })
  const result = await flashFirmware({ cli: 'pio', projectDir: '/proj', io })
  assert.equal(result.ok, true)
  assert.match(result.summary, /报告成功/)
  // ★ 这条断言是防止有人把"退出 0"写成"烧录成功、板子已在运行"
  assert.match(result.summary, /不证明/)
  assert.match(result.summary, /串口|服务端/)
})

test('★ 失败必须带回**日志尾部**（"烧录失败"四个字没法排查）', async () => {
  const log = ['Compiling .pio/build/esp32dev/src/main.cpp.o', 'Linking .pio/build/esp32dev/firmware.elf']
  for (let i = 0; i < 30; i += 1) log.push(`line ${String(i)}`)
  log.push('A fatal error occurred: Failed to connect to ESP32: No serial data received.')
  const { io } = makeIo({ exitCode: 2, stdout: log.join('\n'), stderr: '' })
  const result = await flashFirmware({ cli: 'pio', projectDir: '/proj', io })
  assert.equal(result.ok, false)
  assert.equal(result.exitCode, 2)
  assert.match(result.logTail ?? '', /Failed to connect to ESP32/, '要能看到真正的原因那一行')
  assert.match(result.summary, /板子没插|端口被占用|驱动|型号/)
  // 尾部只留最后几行，不要把整篇编译日志倒给用户
  assert.ok((result.logTail ?? '').split('\n').length <= 12)
})

test('起不了进程 ⇒ 明确失败（不是静默 ok）', async () => {
  const io: ToolchainIo = {
    exists: async () => true,
    join: (...parts) => parts.join('/'),
    run: async () => {
      throw new Error('ENOENT: 找不到 pio')
    },
  }
  const result = await flashFirmware({ cli: 'pio', projectDir: '/proj', io })
  assert.equal(result.ok, false)
  assert.match(result.summary, /起不了 PlatformIO/)
  assert.match(result.summary, /ENOENT/)
})

test('tail：取最后 N 行、丢空行', () => {
  assert.equal(tail('a\n\nb\nc\n', 2), 'b\nc')
  assert.equal(tail('', 3), '')
})
