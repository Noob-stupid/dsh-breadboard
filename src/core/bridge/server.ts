/**
 * BridgeServer —— IPC 服务端（设计文档 §1.0 / §1.1 / §7.2）
 * @module dsh-hardware-sandbox/core/bridge/server
 *
 * ★ 架构位置：虚拟硬件权威侧在宿主，本类是**唯一**把外部项目进程的硬件访问接进权威状态的入口。
 *   Python 侧 shim 只做序列化转发，不含任何硬件语义。
 *
 * ★ 三个设计决策（理由见 contracts/ipc.ts 文件头）：
 *   ① TCP 回环（Windows 无 unix socket，且顺带支持 attach 形态）
 *   ② NDJSON 分帧（对齐 DSH 自带 Python SDK 的风格，抓包可读）
 *   ③ 一次性 token（否则回环上任何进程都能推进虚拟时钟、篡改 SSOT）
 *
 * ★ 本类**零依赖宿主 API**（§10.3），只用 node:net —— 因此可脱离 DSH 直接单测。
 */
import { createServer, type Server, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'

import type { VirtualClock } from '../vclock/virtual-clock.ts'
import { microsToSeconds, secondsToMicros } from '../../contracts/time.ts'
import type { VirtualDevice } from '../../contracts/device.ts'
import {
  IPC_ENV,
  IPC_MAX_FRAME_BYTES,
  IPC_METHODS_REQUIRING_HELLO,
  IPC_VERSION,
  decodeFrames,
  encodeFrame,
} from '../../contracts/ipc.ts'
import type {
  IpcClockAdvanceParams,
  IpcErrorCode,
  IpcGpioReadParams,
  IpcGpioWriteParams,
  IpcHelloParams,
  IpcI2CReadParams,
  IpcI2CWriteParams,
  IpcLogParams,
  IpcMethod,
  IpcRequest,
  IpcResponse,
} from '../../contracts/ipc.ts'

export interface BridgeServerOptions {
  /** 虚拟时钟 —— `clock_advance` 会真的推进它并按时间片 tick 所有设备。 */
  readonly clock: VirtualClock
  /** 设备来源。默认取 `clock.listDevices()`（设备登记在时钟上，天然同一份）。 */
  readonly devices?: () => readonly VirtualDevice[]
  /** 监听端口。默认 0（OS 分配，避免固定端口冲突）。 */
  readonly port?: number
  /** 监听地址。默认 127.0.0.1 —— **绝不要**改成 0.0.0.0。 */
  readonly host?: string
  /** 指定 token；省略则随机生成。 */
  readonly token?: string
  /** 项目进程的日志（shim 主动上报，保留与硬件访问的因果顺序）。 */
  readonly onLog?: (stream: 'stdout' | 'stderr', text: string) => void
  /** 插件版本，握手里回给 shim 便于对照排查。 */
  readonly hostVersion?: string
  /**
   * 虚拟时间预算（微秒）。超出后 `clock_advance` 会被**截断**且不再推进。
   *
   * ★ 为什么预算必须在这里执行，而不是引擎里计时：
   *   仿真的 `duration` 是**虚拟秒**，而虚拟时钟**只由 `clock_advance` 推进**。
   *   墙钟计时会在 accelerated 模式下完全失效 —— 5 秒虚拟时间可能只花 100ms 真实时间
   *   （实测：含 `sleep(1)×5` 的脚本真实耗时约 100ms）。**只有推进时钟的地方才知道该停。**
   */
  readonly virtualBudgetMicros?: number
  /** 预算耗尽时回调（引擎据此终止项目进程）。 */
  readonly onBudgetExhausted?: () => void
  /**
   * 每次推进之后回调（可 await）。
   * realtime 模式的限速落点 —— 引擎在这里按虚拟/真实时间比率补等待。
   */
  readonly onAdvance?: (result: { nowMicros: number; advancedMicros: number }) => void | Promise<void>
}

/** 监听成功后回填给项目进程的连接参数。 */
export interface BridgeAddress {
  readonly host: string
  readonly port: number
  readonly token: string
  /** 直接可用的子进程环境变量（喂给 `subprocess.spawn` 的 `env`）。 */
  readonly env: Readonly<Record<string, string>>
}

/** 默认每个仿真都是新 token：上一次残留的进程连不上新一次仿真。 */
function createToken(): string {
  return randomBytes(24).toString('hex')
}

/** 每个连接的状态。 */
interface Connection {
  readonly socket: Socket
  buffer: string
  /** hello 是否已通过鉴权。未通过前只能调 `hello` 与 `log`。 */
  handshaken: boolean
  remote: string
}

export class BridgeServer {
  readonly #clock: VirtualClock
  readonly #devices: () => readonly VirtualDevice[]
  readonly #port: number
  readonly #host: string
  readonly #token: string
  readonly #onLog: ((stream: 'stdout' | 'stderr', text: string) => void) | undefined
  readonly #hostVersion: string
  readonly #virtualBudgetMicros: number | undefined
  readonly #onBudgetExhausted: (() => void) | undefined
  readonly #onAdvance:
    | ((result: { nowMicros: number; advancedMicros: number }) => void | Promise<void>)
    | undefined

  /** 预算是否已耗尽。引擎据此终止项目进程。 */
  #budgetExhausted = false

  #server: Server | undefined
  #address: BridgeAddress | undefined
  readonly #connections = new Set<Connection>()

  constructor(options: BridgeServerOptions) {
    this.#clock = options.clock
    this.#devices = options.devices ?? (() => this.#clock.listDevices())
    this.#port = options.port ?? 0
    // ★ 默认只监听回环。改成 0.0.0.0 等于把虚拟硬件暴露到局域网。
    this.#host = options.host ?? '127.0.0.1'
    this.#token = options.token ?? createToken()
    this.#onLog = options.onLog
    this.#hostVersion = options.hostVersion ?? '0.0.1'
    this.#virtualBudgetMicros = options.virtualBudgetMicros
    this.#onBudgetExhausted = options.onBudgetExhausted
    this.#onAdvance = options.onAdvance
  }

  /** 虚拟时间预算是否已耗尽。 */
  get budgetExhausted(): boolean {
    return this.#budgetExhausted
  }

  get address(): BridgeAddress | undefined {
    return this.#address
  }

  get connectionCount(): number {
    return this.#connections.size
  }

  /** 已通过握手的连接数（诊断用：能区分「连上了但没鉴权」与「压根没连」）。 */
  get handshakenCount(): number {
    let count = 0
    for (const connection of this.#connections) if (connection.handshaken) count += 1
    return count
  }

  /** 开始监听。返回回填给项目进程的连接参数。 */
  listen(): Promise<BridgeAddress> {
    if (this.#server) throw new Error('BridgeServer 已在监听')

    const server = createServer((socket) => {
      this.#onConnection(socket)
    })
    this.#server = server

    return new Promise<BridgeAddress>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, () => {
        const info = server.address()
        if (info === null || typeof info === 'string') {
          reject(new Error('BridgeServer 监听地址异常'))
          return
        }
        const address: BridgeAddress = {
          host: this.#host,
          port: info.port,
          token: this.#token,
          env: {
            [IPC_ENV.host]: this.#host,
            [IPC_ENV.port]: String(info.port),
            [IPC_ENV.token]: this.#token,
            [IPC_ENV.version]: String(IPC_VERSION),
          },
        }
        this.#address = address
        resolve(address)
      })
    })
  }

  /** 关闭监听并断开所有连接（**不**推进虚拟时钟）。 */
  async close(): Promise<void> {
    for (const connection of this.#connections) connection.socket.destroy()
    this.#connections.clear()

    const server = this.#server
    this.#server = undefined
    this.#address = undefined
    if (!server) return

    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve()
      })
    })
  }

  /* ─────────────────────────── 连接处理 ─────────────────────────── */

  #onConnection(socket: Socket): void {
    const connection: Connection = {
      socket,
      buffer: '',
      handshaken: false,
      remote: `${socket.remoteAddress ?? '?'}:${String(socket.remotePort ?? 0)}`,
    }
    this.#connections.add(connection)
    socket.setNoDelay(true) // 请求-响应往返多，禁 Nagle 降低延迟

    socket.on('data', (chunk) => {
      this.#onData(connection, chunk.toString('utf8'))
    })
    socket.on('error', () => {
      // 项目进程崩溃/被杀是常态，不视为服务端错误
      this.#connections.delete(connection)
    })
    socket.on('close', () => {
      this.#connections.delete(connection)
    })
  }

  #onData(connection: Connection, text: string): void {
    connection.buffer += text
    if (connection.buffer.length > IPC_MAX_FRAME_BYTES) {
      // 畸形/超长输入：直接断开，避免内存被打爆
      this.#reply(connection, { id: 0, error: { code: 'bad_frame', message: 'frame too large' } })
      connection.socket.destroy()
      return
    }

    let decoded: { messages: unknown[]; rest: string }
    try {
      decoded = decodeFrames(connection.buffer)
    } catch (error) {
      this.#reply(connection, { id: 0, error: { code: 'bad_frame', message: String(error) } })
      connection.buffer = ''
      return
    }

    connection.buffer = decoded.rest
    for (const message of decoded.messages) {
      void this.#handle(connection, message)
    }
  }

  async #handle(connection: Connection, raw: unknown): Promise<void> {
    if (raw === null || typeof raw !== 'object') {
      this.#reply(connection, { id: 0, error: { code: 'bad_frame', message: 'not an object' } })
      return
    }
    const request = raw as Partial<IpcRequest>
    if (typeof request.id !== 'number' || typeof request.method !== 'string') {
      this.#reply(connection, { id: 0, error: { code: 'bad_frame', message: 'missing id or method' } })
      return
    }

    const id = request.id
    const method = request.method as IpcMethod

    // ── 鉴权门：未握手只能调 hello / log ──
    if (!connection.handshaken && method !== 'hello' && method !== 'log') {
      this.#reply(connection, {
        id,
        error: { code: 'bad_params', message: `method ${method} requires hello handshake first` },
      })
      return
    }

    try {
      const result = await this.#dispatch(method, request.params, connection)
      if (result === SKIP_REPLY) return
      this.#reply(connection, { id, result })
    } catch (error) {
      if (error instanceof IpcError) {
        this.#reply(connection, { id, error: { code: error.code, message: error.message } })
      } else {
        this.#reply(connection, { id, error: { code: 'internal', message: String(error) } })
      }
    }
  }

  async #dispatch(method: IpcMethod, params: unknown, connection: Connection): Promise<unknown> {
    switch (method) {
      case 'hello':
        return this.#hello(params, connection)
      case 'log':
        return this.#log(params)
      case 'i2c_read':
        return this.#i2cRead(params)
      case 'i2c_write':
        return this.#i2cWrite(params)
      case 'clock_advance':
        return this.#clockAdvance(params)
      case 'gpio_write':
        return this.#gpioWrite(params)
      case 'gpio_read':
        return this.#gpioRead(params)
      default: {
        // 未实现的方法必须明确报错，而不是静默返回 undefined ——
        // 静默会让 P4「拦截完整性」排查时误以为该路径已覆盖。
        throw new IpcError('unknown_method', `未实现的方法：${String(method)}`)
      }
    }
  }

  #hello(params: unknown, connection: Connection): unknown {
    const input = params as Partial<IpcHelloParams> | undefined
    if (input === undefined || typeof input.token !== 'string') {
      throw new IpcError('bad_params', 'hello 缺少 token')
    }
    // ★ 定长比较不是必须的（token 是本地一次性随机串，无时序侧信道威胁模型），
    //   但必须**失败即断**，不给任何重试空间。
    if (input.token !== this.#token) {
      connection.socket.destroy()
      return SKIP_REPLY
    }
    if (input.version !== IPC_VERSION) {
      throw new IpcError(
        'bad_params',
        `协议版本不匹配：shim=${String(input.version)} host=${String(IPC_VERSION)}`,
      )
    }
    connection.handshaken = true
    this.#onLog?.('stdout', `[bridge] 项目进程已连接 ${connection.remote} python=${String(input.python)}`)
    return {
      ok: true,
      hostVersion: this.#hostVersion,
      devices: this.#devices().map((device) => device.id),
    }
  }

  #log(params: unknown): unknown {
    const input = params as Partial<IpcLogParams> | undefined
    const text = typeof input?.text === 'string' ? input.text : ''
    const stream = input?.stream === 'stderr' ? 'stderr' : 'stdout'
    this.#onLog?.(stream, text)
    return { ok: true }
  }

  /**
   * I2C 读 —— 依次问每台设备，第一台应答的胜出。
   *
   * ★ 一台都不应答时抛 `no_device`（Python 侧映射成 OSError errno 121），
   *   这样项目的 `except OSError` 分支与真实硬件行为一致（§3.2 异常一致）。
   */
  #i2cRead(params: unknown): unknown {
    const input = params as Partial<IpcI2CReadParams> | undefined
    if (
      input === undefined ||
      typeof input.address !== 'number' ||
      typeof input.register !== 'number' ||
      typeof input.length !== 'number'
    ) {
      throw new IpcError('bad_params', 'i2c_read 需要 address / register / length')
    }
    if (input.length < 0 || input.length > 256) {
      throw new IpcError('bad_params', `i2c_read 的 length 越界：${String(input.length)}`)
    }

    const devices = this.#devices()
    for (const device of devices) {
      if (device.onI2CRead === undefined) continue
      const bytes = device.onI2CRead({
        address: input.address,
        register: input.register,
        length: input.length,
      })
      if (bytes === null) continue // 不是我的地址，交给下一台
      return { data: Array.from(bytes) }
    }

    // 区分「地址上没设备」与「设备存在但被故障注入断开」——流程 C 要靠这个差别
    const disconnected = devices.filter((device) => device.snapshot().status === 'disconnected')
    if (disconnected.length > 0) {
      throw new IpcError(
        'disconnected',
        `0x${input.address.toString(16)} 无应答；${String(disconnected.length)} 台设备处于断开状态`,
      )
    }
    throw new IpcError('no_device', `0x${input.address.toString(16)} 无应答（总线上无设备认领该地址）`)
  }

  #i2cWrite(params: unknown): unknown {
    const input = params as Partial<IpcI2CWriteParams> | undefined
    if (
      input === undefined ||
      typeof input.address !== 'number' ||
      typeof input.register !== 'number' ||
      !Array.isArray(input.data)
    ) {
      throw new IpcError('bad_params', 'i2c_write 需要 address / register / data')
    }
    const data = Uint8Array.from(input.data as number[])

    for (const device of this.#devices()) {
      if (device.onI2CWrite === undefined) continue
      device.onI2CWrite({ address: input.address, register: input.register, data, payload: data })
      return { ack: true }
    }
    throw new IpcError('no_device', `0x${input.address.toString(16)} 无应答`)
  }

  /**
   * 推进虚拟时钟 —— 整个闭环的心跳（§7.2）。
   *
   * ★ 这一步会按时间片 tick 所有设备；`advance` 内部按墙钟预算让出事件循环（T6），
   *   所以不会把宿主饿死。项目进程在这一往返期间是**阻塞**的，这正是确定性仿真要的效果。
   */
  async #clockAdvance(params: unknown): Promise<unknown> {
    const input = params as Partial<IpcClockAdvanceParams> | undefined
    if (input === undefined || typeof input.seconds !== 'number' || !Number.isFinite(input.seconds)) {
      throw new IpcError('bad_params', 'clock_advance 需要 seconds')
    }
    if (input.seconds < 0) {
      throw new IpcError('bad_params', `clock_advance 不接受负数：${String(input.seconds)}`)
    }

    const before = this.#clock.nowMicros

    // ★ 虚拟时间预算：超出部分**截断**，而不是报错。
    //   报错会让项目进程看到一个它无法理解的异常（真实硬件上 sleep 不会失败）；
    //   截断则表现为"时间不再前进"，由引擎在外面终止进程 —— 对项目代码是透明的。
    let seconds = input.seconds
    const budget = this.#virtualBudgetMicros
    if (budget !== undefined) {
      const remaining = budget - before
      if (remaining <= 0) {
        this.#budgetExhausted = true
        this.#onBudgetExhausted?.()
        return { nowMicros: before, advancedMicros: 0 }
      }
      const requested = secondsToMicros(seconds)
      if (requested >= remaining) {
        seconds = microsToSeconds(remaining)
        this.#budgetExhausted = true
      }
    }

    const result = await this.#clock.advance(seconds)
    await this.#onAdvance?.({ nowMicros: result.nowMicros, advancedMicros: result.nowMicros - before })

    if (this.#budgetExhausted) this.#onBudgetExhausted?.()
    return {
      nowMicros: result.nowMicros,
      advancedMicros: result.nowMicros - before,
    }
  }

  #gpioWrite(params: unknown): unknown {
    const input = params as Partial<IpcGpioWriteParams> | undefined
    if (input === undefined || typeof input.pin !== 'number') {
      throw new IpcError('bad_params', 'gpio_write 需要 pin / value')
    }
    // 本期只实现协议，行为模型后置（§9.2 协议只支持 I2C）。
    // 但**必须**明确回应，不能静默 —— 静默会让 P4 误判该路径已覆盖。
    throw new IpcError('unknown_method', 'gpio_write 已定义协议但行为模型尚未实现（本期范围外）')
  }

  #gpioRead(params: unknown): unknown {
    const input = params as Partial<IpcGpioReadParams> | undefined
    if (input === undefined || typeof input.pin !== 'number') {
      throw new IpcError('bad_params', 'gpio_read 需要 pin')
    }
    throw new IpcError('unknown_method', 'gpio_read 已定义协议但行为模型尚未实现（本期范围外）')
  }

  #reply(connection: Connection, response: IpcResponse): void {
    if (connection.socket.destroyed) return
    connection.socket.write(encodeFrame(response))
  }
}

/** 内部错误：带 IPC 错误码，会被翻译成失败响应。 */
class IpcError extends Error {
  readonly code: IpcErrorCode
  constructor(code: IpcErrorCode, message: string) {
    super(message)
    this.name = 'IpcError'
    this.code = code
  }
}

/** 特殊返回值：已自行处理，不要再回包（例如鉴权失败已断开）。 */
const SKIP_REPLY = Symbol('skip-reply')
