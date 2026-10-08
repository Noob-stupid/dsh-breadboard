/**
 * BME280 寄存器级行为模型（设计文档 §5.2）
 * @module dsh-hardware-sandbox/core/devices/bme280
 *
 * ★ 这是 §3.2「语义等价」真正被考验的地方。判据是三条：**结果一致 / 路径覆盖 / 异常一致**。
 *
 * ── 核心设计决策：物理真值 + **数值反解** ──
 *
 * 设备内部存的是**物理量**（温度 °C、湿度 %RH、气压 Pa），因为 `tick(dt)` 做漂移时
 * 物理量才是自然的自变量。
 *
 * 但项目读到的必须是**原始 ADC**（20 位/16 位），因为真实项目会自己套一段
 * Bosch 补偿算法把它换算成物理量。所以读出时要**反解**：求 `adc` 使得
 * `补偿(adc) == 我们的物理值`。
 *
 * 为什么值得这么做（而不是直接返回"算好的物理值"）：
 *   项目代码里那段补偿算法（读 26 字节校准 + 做定点运算）**必须真的被执行到**。
 *   如果我们返回算好的值，项目的补偿分支就成了死代码 —— 而它在真实硬件上是要跑的。
 *   反解之后，**项目自己算出来的**就是我们的物理值，这才是「结果一致性」的硬证据。
 *
 * 反解用**二分法**：补偿函数在各自区间内单调，24 次迭代足以覆盖 20 位量程。
 * 读操作相对 tick 很稀疏，这点计算量可以忽略。
 *
 * ── 覆盖的路径（对应 §3.2 的「路径覆盖」）──
 *   · 芯片 ID / 复位值 / 状态寄存器
 *   · **26 字节校准寄存器**（做补偿的项目必读）
 *   · 湿度校准的 0xE1–0xE7 非连续布局（很多手写驱动在这里翻车）
 *   · ctrl_meas / ctrl_hum / config 写入
 *   · 软复位
 *   · 强制模式下的 measuring 状态位
 */
import type {
  DeviceFault,
  DeviceSnapshot,
  I2CReadRequest,
  I2CReadResult,
  I2CWriteRequest,
  VirtualDevice,
} from '../../contracts/device.ts'
import type { TickContext } from '../../contracts/time.ts'
import { microsToSeconds } from '../../contracts/time.ts'

/* ─────────────────────────── 寄存器地址 ─────────────────────────── */

const REG_ID = 0xd0
const REG_RESET = 0xe0
const REG_CTRL_HUM = 0xf2
const REG_STATUS = 0xf3
const REG_CTRL_MEAS = 0xf4
const REG_CONFIG = 0xf5

const REG_CALIB_00 = 0x88 // 26 字节：0x88–0xA1
const REG_CALIB_26 = 0xa1
const REG_CALIB_H = 0xe1 // 湿度校准：0xE1–0xE7（非连续）

const REG_DATA = 0xf7 // 0xF7–0xFE：press(3) temp(3) hum(2)

const CHIP_ID_BME280 = 0x60
const RESET_MAGIC = 0xb6

/** 20 位 ADC 量程。 */
const ADC20_MAX = 0xfffff
/** 16 位 ADC 量程。 */
const ADC16_MAX = 0xffff

/**
 * 一次强制模式转换的虚拟耗时（微秒）。
 *
 * ★ 这个值有语义意义：真实 BME280 在强制模式下写完 `ctrl_meas` 后
 *   **必须等转换完成才能读数据**（典型 1× 过采样约 1–2ms，高过采样可达 40ms）。
 *   项目里 `write_byte_data(0xF4, …); time.sleep(0.01); read_i2c_block_data(0xF7,…)`
 *   这个 sleep 不是装饰 —— 这里让它真的有意义（measuring 位在期间保持为 1）。
 */
const CONVERSION_MICROS = 10_000

/* ─────────────────────────── 校准数据 ─────────────────────────── */

/**
 * 校准系数。
 *
 * ★ 默认值取 **Bosch 数据手册的示例值** —— 好处是可以用手册里给出的
 *   期望输出做交叉验证（见 tests/bme280.test.ts），比自造数据可信得多。
 */
export interface Bme280Calibration {
  readonly digT1: number
  readonly digT2: number
  readonly digT3: number
  readonly digP1: number
  readonly digP2: number
  readonly digP3: number
  readonly digP4: number
  readonly digP5: number
  readonly digP6: number
  readonly digP7: number
  readonly digP8: number
  readonly digP9: number
  readonly digH1: number
  readonly digH2: number
  readonly digH3: number
  readonly digH4: number
  readonly digH5: number
  readonly digH6: number
}

/** Bosch 数据手册 3.4 节的示例校准值。 */
export const DATASHEET_CALIBRATION: Bme280Calibration = {
  digT1: 27504,
  digT2: 26435,
  digT3: -1000,
  digP1: 36477,
  digP2: -10685,
  digP3: 3024,
  digP4: 2855,
  digP5: 140,
  digP6: -7,
  digP7: 15500,
  digP8: -14600,
  digP9: 6000,
  digH1: 75,
  digH2: 350,
  digH3: 0,
  digH4: 290,
  digH5: 50,
  digH6: 30,
}

/* ───────────────────── 补偿算法（Bosch 整数版） ───────────────────── */

/*
 * ★★ 必须用 BigInt —— 这里踩过一个会让结果**完全错误却不报错**的坑：
 *
 *   JavaScript 的位运算符是 **32 位**的，而 Bosch 的补偿算法是按 **int64** 写的。
 *   实测：
 *     1 << 47        → 32768        （应为 140737488355328）
 *     (2**31) >> 12  → -524288      （符号溢出）
 *     (4.3e9) >> 12  → 1228         （应为 ~1049804）
 *
 *   气压补偿里 `(1<<47) + var1` 与 `p<<31` 都远超 32 位，中间量还超过 2^53
 *   （最大约 5e18），所以**既不能用位运算、也不能用 Number**。
 *   用 BigInt 才能与 C 参考实现的语义逐位一致。
 *
 * ★ 另一处刻意偏离 C API：`t_fine` 用**显式参数**传递，不用模块级全局变量。
 *   C 版靠全局量在函数间传递状态，一旦调用顺序变了就会静默算错；
 *   显式参数让依赖关系写在签名上。
 */

/** 温度补偿结果。`tFine` 是气压/湿度补偿必须的中间量。 */
export interface TemperatureResult {
  /** 中间量，气压与湿度补偿都要用。 */
  readonly tFine: number
  /** 温度，单位 0.01 °C（"5123" = 51.23 °C）。 */
  readonly temperature: number
}

/** 温度补偿。 */
export function compensateTemperature(cal: Bme280Calibration, adcT: number): TemperatureResult {
  const adc = BigInt(adcT)
  const digT1 = BigInt(cal.digT1)
  const digT2 = BigInt(cal.digT2)
  const digT3 = BigInt(cal.digT3)

  const var1 = (((adc >> 3n) - (digT1 << 1n)) * digT2) >> 11n
  const shifted = (adc >> 4n) - digT1
  const var2 = (((shifted * shifted) >> 12n) * digT3) >> 14n
  const tFine = var1 + var2

  return { tFine: Number(tFine), temperature: Number((tFine * 5n + 128n) >> 8n) }
}

/** 气压补偿。返回 Q24.8 定点值（"24674867" = 96386.2 Pa）。 */
export function compensatePressure(cal: Bme280Calibration, adcP: number, tFine: number): number {
  const tf = BigInt(tFine)
  const digP1 = BigInt(cal.digP1)
  const digP2 = BigInt(cal.digP2)
  const digP3 = BigInt(cal.digP3)
  const digP4 = BigInt(cal.digP4)
  const digP5 = BigInt(cal.digP5)
  const digP6 = BigInt(cal.digP6)
  const digP7 = BigInt(cal.digP7)
  const digP8 = BigInt(cal.digP8)
  const digP9 = BigInt(cal.digP9)

  let var1 = tf - 128000n
  let var2 = var1 * var1 * digP6
  var2 += (var1 * digP5) << 17n
  var2 += digP4 << 35n
  var1 = ((var1 * var1 * digP3) >> 8n) + ((var1 * digP2) << 12n)
  var1 = (((1n << 47n) + var1) * digP1) >> 33n
  if (var1 === 0n) return 0

  let p = 1048576n - BigInt(adcP)
  p = (((p << 31n) - var2) * 3125n) / var1
  const v1 = (digP9 * (p >> 13n) * (p >> 13n)) >> 25n
  const v2 = (digP8 * p) >> 19n
  p = ((p + v1 + v2) >> 8n) + (digP7 << 4n)
  return Number(p)
}

/** 湿度补偿。返回 Q22.10 定点值（"47445" = 46.333 %RH）。 */
export function compensateHumidity(cal: Bme280Calibration, adcH: number, tFine: number): number {
  const tf = BigInt(tFine)
  const digH1 = BigInt(cal.digH1)
  const digH2 = BigInt(cal.digH2)
  const digH3 = BigInt(cal.digH3)
  const digH4 = BigInt(cal.digH4)
  const digH5 = BigInt(cal.digH5)
  const digH6 = BigInt(cal.digH6)

  // ★ 注意：C 版右侧整个表达式用的是**赋值前**的 v_x1_u32r，这里保持同样语义
  const base = tf - 76800n
  const first = ((BigInt(adcH) << 14n) - (digH4 << 20n) - digH5 * base + 16384n) >> 15n
  const second =
    ((((((base * digH6) >> 10n) * (((base * digH3) >> 11n) + 32768n)) >> 10n) + 2097152n) * digH2 +
      8192n) >>
    14n
  let v = first * second
  v -= (((v >> 15n) * (v >> 15n)) >> 7n) * digH1 >> 4n
  if (v < 0n) v = 0n
  if (v > 419430400n) v = 419430400n
  return Number(v >> 12n)
}

/* ─────────────────────────── 反解 ─────────────────────────── */

/**
 * 二分反解：求 `adc` 使 `f(adc) ≈ target`。
 *
 * @param f - 在区间内单调的函数
 * @param target - 目标值
 * @param max - ADC 上限（温度/气压 20 位，湿度 16 位）
 * @param increasing - f 是否随 adc 递增（**气压是递减的**）
 */
function solveAdc(
  f: (adc: number) => number,
  target: number,
  max: number,
  increasing: boolean,
): number {
  let low = 0
  let high = max
  // 24 次迭代把区间缩到 2^20/2^24，远超 20 位量程所需
  for (let i = 0; i < 24; i += 1) {
    const mid = (low + high) >> 1
    const below = increasing ? f(mid) < target : f(mid) > target
    if (below) low = mid
    else high = mid
  }
  return (low + high) >> 1
}

/* ─────────────────────────── 设备 ─────────────────────────── */

export interface Bme280Options {
  readonly id?: string
  /** I2C 从机地址。默认 0x76（SDO 接 GND），与设计文档 §5.2 / §8 一致。 */
  readonly address?: number
  /** 固定种子 —— 保证可复现（§0.4 P3 的要求）。 */
  readonly seed?: number
  /** 校准系数。默认取数据手册示例值。 */
  readonly calibration?: Bme280Calibration
  /** 初始温度（°C）。 */
  readonly temperature?: number
  /** 初始相对湿度（%RH）。 */
  readonly humidity?: number
  /** 初始气压（Pa）。 */
  readonly pressure?: number
  /**
   * 每个时间片的漂移幅度倍率。
   * 设 0 可得到**完全静止**的传感器（测试用），此时读数只由初始值决定。
   */
  readonly driftScale?: number
}

/** 线性同余伪随机 —— 自带种子，跨平台可复现（不用 Math.random）。 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return state / 4294967296
  }
}

export class VirtualBME280 implements VirtualDevice {
  readonly id: string
  readonly kind = 'sensor' as const
  readonly address: number
  readonly calibration: Bme280Calibration

  /** 寄存器文件。0x88–0xA1 与 0xE1–0xE7 在校准后写入。 */
  readonly #registers = new Map<number, number>()

  /** 物理真值 —— `tick` 漂移的自然自变量。 */
  #temperature: number
  #humidity: number
  #pressure: number

  #status: DeviceSnapshot['status'] = 'ok'
  /**
   * 强制模式转换完成的虚拟时刻（微秒）。0 = 无进行中的转换。
   *
   * ★ 设备必须自己记住「现在几点」——`onI2CWrite` 拿不到 TickContext。
   *   每次 `tick` 更新 {@link #nowMicros}，写入时据此推算完成时刻。
   */
  #measuringUntilMicros = 0
  /** 最近一次 tick 的虚拟时刻。 */
  #nowMicros = 0
  #ctrlMeas = 0
  #ctrlHum = 0
  #config = 0

  readonly #rng: () => number
  readonly #driftScale: number

  constructor(options: Bme280Options = {}) {
    this.id = options.id ?? 'bme280'
    this.address = options.address ?? 0x76
    this.calibration = options.calibration ?? DATASHEET_CALIBRATION
    this.#temperature = options.temperature ?? 25
    this.#humidity = options.humidity ?? 60
    this.#pressure = options.pressure ?? 101325
    this.#rng = makeRng(options.seed ?? 42)
    this.#driftScale = options.driftScale ?? 1

    this.#loadCalibration()
    this.#writeRaw(REG_ID, CHIP_ID_BME280)
    this.#writeRaw(REG_STATUS, 0x00)
  }

  /* ── 物理量（供测试与 DS 观察） ── */

  get temperature(): number {
    return this.#temperature
  }
  get humidity(): number {
    return this.#humidity
  }
  get pressure(): number {
    return this.#pressure
  }

  /* ── 校准寄存器装载 ── */

  #loadCalibration(): void {
    const cal = this.calibration
    this.#writeU16(0x88, cal.digT1)
    this.#writeI16(0x8a, cal.digT2)
    this.#writeI16(0x8c, cal.digT3)
    this.#writeU16(0x8e, cal.digP1)
    this.#writeI16(0x90, cal.digP2)
    this.#writeI16(0x92, cal.digP3)
    this.#writeI16(0x94, cal.digP4)
    this.#writeI16(0x96, cal.digP5)
    this.#writeI16(0x98, cal.digP6)
    this.#writeI16(0x9a, cal.digP7)
    this.#writeI16(0x9c, cal.digP8)
    this.#writeI16(0x9e, cal.digP9)
    this.#writeRaw(0xa0, 0x00) // 保留
    this.#writeRaw(REG_CALIB_26, cal.digH1 & 0xff)

    // ★ 湿度校准 0xE1–0xE7 是**非连续 12 位布局**，手写驱动最容易在这里错
    this.#writeI16(0xe1, cal.digH2)
    this.#writeRaw(0xe3, cal.digH3 & 0xff)
    // dig_H4: 0xE4 = 高 8 位，0xE5[3:0] = 低 4 位
    this.#writeRaw(0xe4, (cal.digH4 >> 4) & 0xff)
    // dig_H5: 0xE6 = 高 8 位，0xE5[7:4] = 低 4 位
    this.#writeRaw(0xe6, (cal.digH5 >> 4) & 0xff)
    this.#writeRaw(0xe5, ((cal.digH5 & 0x0f) << 4) | (cal.digH4 & 0x0f))
    this.#writeRaw(0xe7, cal.digH6 & 0xff)
  }

  #writeRaw(register: number, value: number): void {
    this.#registers.set(register & 0xff, value & 0xff)
  }
  #writeU16(register: number, value: number): void {
    this.#writeRaw(register, value & 0xff)
    this.#writeRaw(register + 1, (value >> 8) & 0xff)
  }
  #writeI16(register: number, value: number): void {
    this.#writeU16(register, value < 0 ? value + 0x10000 : value)
  }
  #readRaw(register: number): number {
    return this.#registers.get(register & 0xff) ?? 0
  }

  /* ── 由物理真值反解出原始 ADC ── */

  /** 温度：20 位，随 adc 递增。 */
  #rawTemperature(): number {
    const target = Math.round(this.#temperature * 100)
    return solveAdc(
      (adc) => compensateTemperature(this.calibration, adc).temperature,
      target,
      ADC20_MAX,
      true,
    )
  }

  /** 气压：20 位，**随 adc 递减**（adc 越大表示压力越小）。 */
  #rawPressure(tFine: number): number {
    const target = Math.round(this.#pressure * 256)
    return solveAdc(
      (adc) => compensatePressure(this.calibration, adc, tFine),
      target,
      ADC20_MAX,
      false,
    )
  }

  /** 湿度：16 位，随 adc 递增。 */
  #rawHumidity(tFine: number): number {
    const target = Math.round(this.#humidity * 1024)
    return solveAdc(
      (adc) => compensateHumidity(this.calibration, adc, tFine),
      target,
      ADC16_MAX,
      true,
    )
  }

  /**
   * 一次算出 0xF7–0xFE 的 8 个数据字节。
   *
   * ★ 必须**整块算一次**而不是每个寄存器算一次：每次反解要跑 24 轮二分，
   *   逐字节算就是 8×3×24 轮 BigInt 运算 —— 而它们本来就该来自同一次采样。
   *   （真实器件的一次转换也是三个量同时锁存。）
   */
  #dataBytes(): Uint8Array {
    const adcT = this.#rawTemperature()
    const tFine = compensateTemperature(this.calibration, adcT).tFine
    const adcP = this.#rawPressure(tFine)
    const adcH = this.#rawHumidity(tFine)

    return Uint8Array.from([
      (adcP >> 12) & 0xff,
      (adcP >> 4) & 0xff,
      (adcP << 4) & 0xf0,
      (adcT >> 12) & 0xff,
      (adcT >> 4) & 0xff,
      (adcT << 4) & 0xf0,
      (adcH >> 8) & 0xff,
      adcH & 0xff,
    ])
  }

  /* ── VirtualDevice 实现 ── */

  /**
   * 按时间片漂移物理量。
   *
   * ★ 必须返回 `nextEventIn() === null`（需要每一个时间片）：
   *   漂移是**积分型**的，结果与 tick 次数相关，跳空会改变结果（见 virtual-clock.ts 的取舍说明）。
   */
  tick(ctx: TickContext): void {
    this.#nowMicros = ctx.nowMicros

    if (this.#measuringUntilMicros !== 0 && ctx.nowMicros >= this.#measuringUntilMicros) {
      this.#measuringUntilMicros = 0
      this.#writeRaw(REG_STATUS, this.#readRaw(REG_STATUS) & ~0x08)
    }

    if (this.#driftScale === 0) return

    // 随机漂移仅用于演示；种子固定 ⇒ 可复现（§0.4）
    const dt = microsToSeconds(ctx.deltaMicros)
    this.#temperature += (this.#rng() - 0.5) * 0.1 * this.#driftScale * dt
    this.#humidity += (this.#rng() - 0.5) * 0.2 * this.#driftScale * dt
    this.#pressure += (this.#rng() - 0.5) * 4 * this.#driftScale * dt
  }

  /** 积分型模型：需要每一个时间片。 */
  nextEventIn(): number | null {
    return null
  }

  onI2CRead(request: I2CReadRequest): I2CReadResult {
    if (request.address !== this.address) return null
    if (this.#status === 'disconnected') return null

    // 数据区整块算一次（三个量同时锁存），其余寄存器直接查表
    const data = this.#dataBytes()
    const out = new Uint8Array(request.length)
    for (let i = 0; i < request.length; i += 1) {
      const register = (request.register + i) & 0xff
      out[i] =
        register >= REG_DATA && register <= 0xfe
          ? (data[register - REG_DATA] ?? 0)
          : this.#readRaw(register)
    }
    return out
  }

  onI2CWrite(request: I2CWriteRequest): void {
    if (request.address !== this.address) return

    switch (request.register) {
      case REG_RESET:
        if (request.data[0] === RESET_MAGIC) {
          // 软复位：清控制寄存器与状态，物理量与校准保留（真实器件也是保留校准的）
          this.#ctrlMeas = 0
          this.#ctrlHum = 0
          this.#config = 0
          this.#measuringUntilMicros = 0
          this.#writeRaw(REG_STATUS, 0x00)
          this.#writeRaw(REG_CTRL_MEAS, 0x00)
          this.#writeRaw(REG_CTRL_HUM, 0x00)
          this.#writeRaw(REG_CONFIG, 0x00)
        }
        return
      case REG_CTRL_HUM:
        this.#ctrlHum = request.data[0] ?? 0
        this.#writeRaw(REG_CTRL_HUM, this.#ctrlHum)
        return
      case REG_CTRL_MEAS: {
        this.#ctrlMeas = request.data[0] ?? 0
        this.#writeRaw(REG_CTRL_MEAS, this.#ctrlMeas)
        const mode = this.#ctrlMeas & 0x03
        // 强制模式（01/10）：置 measuring 位并**记下完成时刻**
        if (mode === 0x01 || mode === 0x02) {
          this.#writeRaw(REG_STATUS, this.#readRaw(REG_STATUS) | 0x08)
          this.#measuringUntilMicros = this.#nowMicros + CONVERSION_MICROS
        } else if (mode === 0x00) {
          this.#writeRaw(REG_STATUS, this.#readRaw(REG_STATUS) & ~0x08)
          this.#measuringUntilMicros = 0
        }
        return
      }
      case REG_CONFIG:
        this.#config = request.data[0] ?? 0
        this.#writeRaw(REG_CONFIG, this.#config)
        return
      default:
        // 校准区只读；写入被忽略（真实器件亦然）
        return
    }
  }

  injectFault(fault: DeviceFault): void {
    switch (fault.type) {
      case 'disconnect':
        this.#status = 'disconnected'
        break
      case 'busy':
        this.#status = 'busy'
        break
      case 'nack':
        this.#status = 'faulted'
        break
      case 'clear':
        this.#status = 'ok'
        break
      case 'set_reading': {
        const readings = fault.readings ?? {}
        if (typeof readings.temperature === 'number') this.#temperature = readings.temperature
        if (typeof readings.humidity === 'number') this.#humidity = readings.humidity
        if (typeof readings.pressure === 'number') this.#pressure = readings.pressure
        break
      }
      default: {
        const exhaustive: never = fault.type
        throw new Error(`未知故障类型：${String(exhaustive)}`)
      }
    }
  }

  snapshot(): DeviceSnapshot {
    return {
      id: this.id,
      kind: this.kind,
      label: `BME280 @0x${this.address.toString(16)}`,
      status: this.#status,
      readings: {
        temperature: round(this.#temperature, 3),
        humidity: round(this.#humidity, 3),
        pressure: round(this.#pressure, 2),
      },
    }
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
