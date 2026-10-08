/**
 * BME280 寄存器级模型测试 —— 设计文档 §3.2「语义等价」的硬证据。
 *
 * ★ 证据链是两段，不能省第一段：
 *
 *   ① **先验证参考实现本身**：本文件里独立写了一份 Bosch 补偿算法，
 *      先用**数据手册公布的算例**校验它。参考实现若不可信，第二段就是循环论证。
 *   ② **再用它验证设备的反解**：设备内部存物理真值，读出原始 ADC；
 *      把读到的原始值 + 校准值喂给①的参考实现，必须还原出设备的物理真值。
 *
 *   这一链证明的是「**项目里那段真实的补偿代码会算出正确结果**」——
 *   而不是「我们替它算好了」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DATASHEET_CALIBRATION,
  VirtualBME280,
  type Bme280Calibration,
} from '../src/core/devices/bme280.ts'
import type { DeviceFault } from '../src/contracts/device.ts'

/* ───────────── ① 独立参考实现（Bosch 数据手册公式，BigInt 版） ───────────── */

interface Reference {
  tFine: number
  /** 0.01 °C */
  temperature: number
  /** Q24.8 定点 */
  pressure: number
  /** Q22.10 定点 */
  humidity: number
}

/**
 * 独立参考实现。
 *
 * 与设备内那份**分别书写**（结构、命名、变量拆分都不同），以避免「同一份代码自证」。
 * 两者都必须与 Bosch 的 int64 语义一致 —— JS 位运算是 32 位的，所以这里同样用 BigInt。
 */
function referenceCompensate(
  cal: Bme280Calibration,
  adcT: number,
  adcP: number,
  adcH: number,
): Reference {
  const T1 = BigInt(cal.digT1)
  const T2 = BigInt(cal.digT2)
  const T3 = BigInt(cal.digT3)

  const a = (BigInt(adcT) >> 3n) - (T1 << 1n)
  const b = (BigInt(adcT) >> 4n) - T1
  const tFine = ((a * T2) >> 11n) + ((((b * b) >> 12n) * T3) >> 14n)
  const temperature = (tFine * 5n + 128n) >> 8n

  // ── 气压 ──
  const P = [
    cal.digP1, cal.digP2, cal.digP3, cal.digP4, cal.digP5,
    cal.digP6, cal.digP7, cal.digP8, cal.digP9,
  ].map(BigInt)

  const d = tFine - 128000n
  let pressure = 0n
  {
    let v2 = d * d * P[5]!
    v2 += (d * P[4]!) << 17n
    v2 += P[3]! << 35n
    let v1 = ((d * d * P[2]!) >> 8n) + ((d * P[1]!) << 12n)
    v1 = (((1n << 47n) + v1) * P[0]!) >> 33n
    if (v1 !== 0n) {
      let p = 1048576n - BigInt(adcP)
      p = (((p << 31n) - v2) * 3125n) / v1
      const c1 = (P[8]! * (p >> 13n) * (p >> 13n)) >> 25n
      const c2 = (P[7]! * p) >> 19n
      pressure = ((p + c1 + c2) >> 8n) + (P[6]! << 4n)
    }
  }

  // ── 湿度 ──
  let humidity = 0n
  {
    const H1 = BigInt(cal.digH1)
    const H2 = BigInt(cal.digH2)
    const H3 = BigInt(cal.digH3)
    const H4 = BigInt(cal.digH4)
    const H5 = BigInt(cal.digH5)
    const H6 = BigInt(cal.digH6)

    const x = tFine - 76800n
    const left = ((BigInt(adcH) << 14n) - (H4 << 20n) - H5 * x + 16384n) >> 15n
    const inner = (((x * H6) >> 10n) * (((x * H3) >> 11n) + 32768n)) >> 10n
    const right = (((inner + 2097152n) * H2 + 8192n) >> 14n)
    humidity = left * right
    humidity -= (((humidity >> 15n) * (humidity >> 15n)) >> 7n) * H1 >> 4n
    if (humidity < 0n) humidity = 0n
    if (humidity > 419430400n) humidity = 419430400n
    humidity >>= 12n
  }

  return {
    tFine: Number(tFine),
    temperature: Number(temperature),
    pressure: Number(pressure),
    humidity: Number(humidity),
  }
}

/** 从设备读出「项目会读到的东西」：26 字节校准 + 8 字节数据。 */
function readLikeAProject(device: VirtualBME280): {
  calib: Uint8Array
  data: Uint8Array
} {
  const calib = device.onI2CRead({ address: device.address, register: 0x88, length: 26 })
  const data = device.onI2CRead({ address: device.address, register: 0xf7, length: 8 })
  assert.ok(calib && data, '设备必须应答')
  return { calib, data }
}

/** 按真实项目的做法，从 26 字节校准里解出系数（含 0xE1–0xE7 的非连续湿度布局）。 */
function parseCalibration(device: VirtualBME280): Bme280Calibration {
  const c = device.onI2CRead({ address: device.address, register: 0x88, length: 26 })
  const h = device.onI2CRead({ address: device.address, register: 0xe1, length: 7 })
  assert.ok(c && h)

  const u16 = (i: number): number => (c[i] ?? 0) | ((c[i + 1] ?? 0) << 8)
  const i16 = (i: number): number => {
    const v = u16(i)
    return v >= 0x8000 ? v - 0x10000 : v
  }
  const s12 = (v: number): number => (v >= 0x800 ? v - 0x1000 : v)

  const h4 = s12(((h[3] ?? 0) << 4) | ((h[4] ?? 0) & 0x0f))
  const h5 = s12(((h[5] ?? 0) << 4) | ((h[4] ?? 0) >> 4))
  const h6raw = h[6] ?? 0

  return {
    digT1: u16(0), digT2: i16(2), digT3: i16(4),
    digP1: u16(6), digP2: i16(8), digP3: i16(10), digP4: i16(12),
    digP5: i16(14), digP6: i16(16), digP7: i16(18), digP8: i16(20), digP9: i16(22),
    digH1: c[25] ?? 0,
    digH2: (h[0] ?? 0) | ((h[1] ?? 0) << 8),
    digH3: h[2] ?? 0,
    digH4: h4,
    digH5: h5,
    digH6: h6raw >= 0x80 ? h6raw - 0x100 : h6raw,
  }
}

/** 从 8 字节数据区还原三个 ADC 原始值（真实驱动的做法）。 */
function parseRaw(data: Uint8Array): { adcT: number; adcP: number; adcH: number } {
  const adcP = ((data[0] ?? 0) << 12) | ((data[1] ?? 0) << 4) | ((data[2] ?? 0) >> 4)
  const adcT = ((data[3] ?? 0) << 12) | ((data[4] ?? 0) << 4) | ((data[5] ?? 0) >> 4)
  const adcH = ((data[6] ?? 0) << 8) | (data[7] ?? 0)
  return { adcT, adcP, adcH }
}

/* ─────────────────── ① 参考实现先过数据手册算例 ─────────────────── */

test('① 参考实现通过数据手册算例（先证明尺子是准的）', () => {
  // Bosch BME280 数据手册 3.4 节的算例：adc_T = 519888 → 25.08 °C
  const result = referenceCompensate(DATASHEET_CALIBRATION, 519888, 415148, 26000)
  assert.equal(
    result.temperature,
    2508,
    `数据手册算例应为 2508（25.08°C），实际 ${String(result.temperature)} —— ` +
      `参考实现本身不对，后面的验证就没有意义`,
  )

  // 气压算例：Q24.8 定点，换算成 Pa 应落在 1006 hPa 附近
  const pressurePa = result.pressure / 256
  assert.ok(
    pressurePa > 99000 && pressurePa < 102000,
    `气压算例应在 990–1020 hPa，实际 ${pressurePa.toFixed(1)} Pa`,
  )
})

/* ─────────────────── ② 设备反解 → 参考补偿 → 还原 ─────────────────── */

test('★ ② 往返一致：设备物理真值 → 原始 ADC → 参考补偿 → 还原物理真值', () => {
  for (const temperature of [-40, -10, 0, 25, 40, 85]) {
    const device = new VirtualBME280({ temperature, humidity: 50, pressure: 101325, driftScale: 0 })

    const { data } = readLikeAProject(device)
    const cal = parseCalibration(device)
    const raw = parseRaw(data)
    const got = referenceCompensate(cal, raw.adcT, raw.adcP, raw.adcH)

    // 温度：0.01°C 分辨率，允许 1 个 LSB
    assert.ok(
      Math.abs(got.temperature / 100 - temperature) <= 0.02,
      `温度 ${String(temperature)}°C 未还原，得到 ${(got.temperature / 100).toFixed(3)}°C`,
    )
  }
})

test('★ ② 湿度往返一致（含 0xE1–0xE7 非连续 12 位布局）', () => {
  for (const humidity of [0, 20, 46.333, 60, 90, 100]) {
    const device = new VirtualBME280({ temperature: 25, humidity, pressure: 101325, driftScale: 0 })

    const { data } = readLikeAProject(device)
    const cal = parseCalibration(device)
    const raw = parseRaw(data)
    const got = referenceCompensate(cal, raw.adcT, raw.adcP, raw.adcH)

    // 湿度 Q22.10，允许 0.2 %RH
    assert.ok(
      Math.abs(got.humidity / 1024 - humidity) <= 0.2,
      `湿度 ${String(humidity)}%RH 未还原，得到 ${(got.humidity / 1024).toFixed(3)} %RH`,
    )
  }
})

test('★ ② 气压往返一致', () => {
  for (const pressure of [87000, 95000, 101325, 105000, 108000]) {
    const device = new VirtualBME280({ temperature: 25, humidity: 50, pressure, driftScale: 0 })

    const { data } = readLikeAProject(device)
    const cal = parseCalibration(device)
    const raw = parseRaw(data)
    const got = referenceCompensate(cal, raw.adcT, raw.adcP, raw.adcH)

    // Q24.8 ⇒ 1/256 Pa，允许 2 Pa
    assert.ok(
      Math.abs(got.pressure / 256 - pressure) <= 2,
      `气压 ${String(pressure)} Pa 未还原，得到 ${(got.pressure / 256).toFixed(1)} Pa`,
    )
  }
})

test('★ 校准寄存器逐字节等于设备装载的系数（项目读到的必须是真的）', () => {
  const device = new VirtualBME280()
  const parsed = parseCalibration(device)
  assert.deepEqual(parsed, DATASHEET_CALIBRATION, '26 字节 + 7 字节校准必须能完整还原系数')
})

/* ─────────────────── 寄存器与状态路径覆盖 ─────────────────── */

test('芯片 ID 与复位值', () => {
  const device = new VirtualBME280()
  const id = device.onI2CRead({ address: device.address, register: 0xd0, length: 1 })
  assert.deepEqual(Array.from(id ?? []), [0x60], 'BME280 的芯片 ID 必须是 0x60')
})

test('地址不匹配返回 null（交给总线下一个设备）', () => {
  const device = new VirtualBME280({ address: 0x76 })
  assert.equal(device.onI2CRead({ address: 0x77, register: 0xd0, length: 1 }), null)
})

test('强制模式写入 ctrl_meas 后 status 的 measuring 位置起，超时后自动落下', async () => {
  const { VirtualClock } = await import('../src/core/vclock/virtual-clock.ts')
  const clock = new VirtualClock({ step: 0.001 })
  const device = new VirtualBME280({ driftScale: 0 })
  clock.register(device)

  device.onI2CWrite({ address: device.address, register: 0xf4, data: Uint8Array.from([0x25]), payload: Uint8Array.from([0x25]) })
  const measuring = device.onI2CRead({ address: device.address, register: 0xf3, length: 1 })
  assert.equal(((measuring?.[0] ?? 0) & 0x08) !== 0, true, '强制模式应置 measuring 位')

  await clock.advance(0.02)
  const after = device.onI2CRead({ address: device.address, register: 0xf3, length: 1 })
  assert.equal(((after?.[0] ?? 0) & 0x08) === 0, true, '转换完成后 measuring 位应落下')
})

test('软复位清控制寄存器但保留校准与物理量', () => {
  const device = new VirtualBME280({ temperature: 30, driftScale: 0 })
  device.onI2CWrite({ address: device.address, register: 0xf4, data: Uint8Array.from([0x27]), payload: Uint8Array.from([0x27]) })

  device.onI2CWrite({ address: device.address, register: 0xe0, data: Uint8Array.from([0xb6]), payload: Uint8Array.from([0xb6]) })

  const ctrl = device.onI2CRead({ address: device.address, register: 0xf4, length: 1 })
  assert.equal(ctrl?.[0], 0x00, '复位后 ctrl_meas 应归零')
  assert.equal(device.temperature, 30, '复位不应改变物理量（真实器件亦然）')
  assert.deepEqual(parseCalibration(device), DATASHEET_CALIBRATION, '复位不应清掉校准')
})

test('校准区写入被忽略（真实器件只读）', () => {
  const device = new VirtualBME280()
  device.onI2CWrite({ address: device.address, register: 0x88, data: Uint8Array.from([0xff]), payload: Uint8Array.from([0xff]) })
  assert.deepEqual(parseCalibration(device), DATASHEET_CALIBRATION)
})

/* ─────────────────── 确定性与漂移 ─────────────────── */

test('固定种子 ⇒ 漂移可复现（§0.4 P3 的要求）', async () => {
  const { VirtualClock } = await import('../src/core/vclock/virtual-clock.ts')

  const run = async (): Promise<number[]> => {
    const clock = new VirtualClock({ step: 0.01 })
    const device = new VirtualBME280({ seed: 42, temperature: 25 })
    clock.register(device)
    const out: number[] = []
    for (let i = 0; i < 5; i += 1) {
      out.push(device.temperature)
      await clock.advance(1)
    }
    return out
  }

  assert.deepEqual(await run(), await run(), '同种子两次运行必须完全一致')
})

test('不同种子 ⇒ 漂移不同（确认随机确实在起作用）', async () => {
  const { VirtualClock } = await import('../src/core/vclock/virtual-clock.ts')

  const run = async (seed: number): Promise<number> => {
    const clock = new VirtualClock({ step: 0.01 })
    const device = new VirtualBME280({ seed, temperature: 25 })
    clock.register(device)
    await clock.advance(5)
    return device.temperature
  }

  assert.notEqual(await run(1), await run(2))
})

test('driftScale=0 ⇒ 完全静止（读数只由初始值决定）', async () => {
  const { VirtualClock } = await import('../src/core/vclock/virtual-clock.ts')
  const clock = new VirtualClock({ step: 0.01 })
  const device = new VirtualBME280({ temperature: 25, humidity: 60, pressure: 101325, driftScale: 0 })
  clock.register(device)

  await clock.advance(10)
  assert.equal(device.temperature, 25)
  assert.equal(device.humidity, 60)
  assert.equal(device.pressure, 101325)
})

test('积分型模型必须要求每个时间片（否则漂移结果会变）', () => {
  const device = new VirtualBME280()
  assert.equal(device.nextEventIn(), null, 'BME280 是积分型，跳空会改变结果')
})

/* ─────────────────── 故障注入 ─────────────────── */

test('set_reading 直接改物理量（流程 C 的「拖动温度滑块」）', () => {
  const device = new VirtualBME280({ temperature: 25, driftScale: 0 })
  device.injectFault({ type: 'set_reading', readings: { temperature: -40 } })
  assert.equal(device.temperature, -40)

  const { data } = readLikeAProject(device)
  const raw = parseRaw(data)
  const got = referenceCompensate(parseCalibration(device), raw.adcT, raw.adcP, raw.adcH)
  assert.ok(
    Math.abs(got.temperature / 100 - -40) <= 0.02,
    '注入后的新温度必须能被参考补偿还原',
  )
})

test('disconnect 后不再应答；clear 后恢复', () => {
  const device = new VirtualBME280()
  assert.ok(device.onI2CRead({ address: device.address, register: 0xd0, length: 1 }))

  device.injectFault({ type: 'disconnect' })
  assert.equal(device.onI2CRead({ address: device.address, register: 0xd0, length: 1 }), null)
  assert.equal(device.snapshot().status, 'disconnected')

  device.injectFault({ type: 'clear' })
  assert.ok(device.onI2CRead({ address: device.address, register: 0xd0, length: 1 }))
})

test('快照带出物理读数，供场景气泡与 DS 观察', () => {
  const device = new VirtualBME280({ temperature: 25.1234, humidity: 60.5, pressure: 101325.6, driftScale: 0 })
  const snapshot = device.snapshot()
  assert.equal(snapshot.kind, 'sensor')
  assert.equal(snapshot.readings.temperature, 25.123)
  assert.equal(snapshot.readings.humidity, 60.5)
  assert.equal(snapshot.readings.pressure, 101325.6)
})

test('未知故障类型抛错（不静默吞掉）', () => {
  const device = new VirtualBME280()
  assert.throws(() => {
    device.injectFault({ type: 'nonsense' as DeviceFault['type'] })
  })
})
