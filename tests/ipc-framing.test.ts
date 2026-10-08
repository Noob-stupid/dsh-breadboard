/**
 * IPC 分帧测试 —— NDJSON 的边界情况。
 *
 * ★ 为什么单独测：TCP 是**字节流不是消息流**。一次 `data` 事件可能拿到
 *   半个帧、一个整帧、或三个半帧。分帧写错的表现是「大部分时候正常、
 *   偶发 JSON 解析失败」，而且只在高负载下出现 —— 属于最难查的一类 bug。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  IPC_VERSION,
  IPC_ENV,
  IPC_METHODS_REQUIRING_HELLO,
  encodeFrame,
  decodeFrames,
} from '../src/contracts/ipc.ts'
import type { IpcRequest, IpcResponse } from '../src/contracts/ipc.ts'

test('单帧往返', () => {
  const request: IpcRequest = { id: 1, method: 'i2c_read', params: { address: 0x76, register: 0x88, length: 2 } }
  const wire = encodeFrame(request)
  assert.ok(wire.endsWith('\n'), '帧必须以换行结尾（换行是唯一分隔符）')

  const { messages, rest } = decodeFrames(wire)
  assert.deepEqual(messages, [request])
  assert.equal(rest, '', '完整帧解析后不应有剩余')
})

test('一个 chunk 里塞多个帧', () => {
  const a: IpcRequest = { id: 1, method: 'hello' }
  const b: IpcRequest = { id: 2, method: 'clock_advance', params: { seconds: 1 } }
  const c: IpcRequest = { id: 3, method: 'log', params: { stream: 'stdout', text: 'hi' } }

  const { messages, rest } = decodeFrames(encodeFrame(a) + encodeFrame(b) + encodeFrame(c))
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[1], b)
  assert.equal(rest, '')
})

test('★ 半个帧：剩余部分必须留在 rest 里，不能丢也不能当成坏帧', () => {
  const request: IpcRequest = { id: 7, method: 'i2c_read', params: { address: 0x48, register: 0, length: 2 } }
  const wire = encodeFrame(request)

  // 模拟 TCP 把一个帧切成两半
  for (let cut = 0; cut < wire.length; cut += 1) {
    const first = wire.slice(0, cut)
    const second = wire.slice(cut)

    const step1 = decodeFrames(first)
    assert.equal(step1.messages.length, 0, `切在 ${String(cut)} 时不应产出半成品消息`)
    assert.equal(step1.rest, first, `切在 ${String(cut)} 时未完成字节必须原样留在 rest`)

    // 把 rest 接上后半个帧，应当恰好解析出这一帧
    const step2 = decodeFrames(step1.rest + second)
    assert.equal(step2.messages.length, 1, `切在 ${String(cut)} 时拼接后应解析出完整帧`)
    assert.deepEqual(step2.messages[0], request)
    assert.equal(step2.rest, '')
  }
})

test('空行被忽略（不产出畸形消息）', () => {
  const { messages, rest } = decodeFrames('\n\n  \n')
  assert.deepEqual(messages, [])
  assert.equal(rest, '')
})

test('响应帧形状：成功与失败互斥且都带 id', () => {
  const ok: IpcResponse = { id: 10, result: { data: [1, 2] } }
  const bad: IpcResponse = { id: 11, error: { code: 'no_device', message: 'no ack at 0x76' } }

  assert.deepEqual(decodeFrames(encodeFrame(ok)).messages[0], ok)
  assert.deepEqual(decodeFrames(encodeFrame(bad)).messages[0], bad)
})

test('二进制走 number[]，且 JSON 往返后逐字节相等', () => {
  const data = [0x00, 0x60, 0xb6, 0xff, 0x80]
  const { messages } = decodeFrames(encodeFrame({ id: 1, result: { data } }))
  assert.deepEqual((messages[0] as { result: { data: number[] } }).result.data, data)
})

test('环境变量名与协议版本是稳定常量（两侧硬编码，改动即破坏兼容）', () => {
  assert.equal(IPC_ENV.host, 'DSH_HW_BRIDGE_HOST')
  assert.equal(IPC_ENV.port, 'DSH_HW_BRIDGE_PORT')
  assert.equal(IPC_ENV.token, 'DSH_HW_BRIDGE_TOKEN')
  assert.equal(IPC_VERSION, 1)
})

test('★ 未握手前不允许调用会改状态的方法（防止未鉴权推进虚拟时钟）', () => {
  assert.ok(IPC_METHODS_REQUIRING_HELLO.includes('clock_advance'), '推进虚拟时钟必须先鉴权')
  assert.ok(IPC_METHODS_REQUIRING_HELLO.includes('i2c_read'))
  assert.ok(IPC_METHODS_REQUIRING_HELLO.includes('i2c_write'))
  assert.equal(
    IPC_METHODS_REQUIRING_HELLO.includes('hello'),
    false,
    'hello 自己当然不能在「需要 hello」的名单里',
  )
  assert.equal(IPC_METHODS_REQUIRING_HELLO.includes('log'), false, '日志不该被鉴权挡住')
})
