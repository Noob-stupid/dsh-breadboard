#!/usr/bin/env python3
"""一个**像真实树莓派项目那样**的 BME280 读取脚本。

它做的事情和网上任何一份 BME280 树莓派驱动一样：
  1. `import smbus`，开 I2C
  2. 读芯片 ID 确认器件在
  3. 读 26 字节校准（0x88）+ 7 字节湿度校准（0xE1）
  4. 触发一次强制模式测量，`time.sleep()` 等转换完成
  5. 读 8 字节数据（0xF7），做 **Bosch 定点补偿**
  6. 打印温度/湿度/气压

★ 关键在于：**补偿是我们自己算的，不是宿主算好给的。**
  宿主只提供「原始 ADC + 校准寄存器」，语义等价与否由这段代码检验（设计文档 §3.2）。

★ 顺带一个对照：**同样的 Bosch 算法在 Python 里不会遇到 JS 那个坑** ——
  Python 整数是任意精度的，而 JS 位运算只有 32 位（`1<<47` 在 JS 里得 32768）。
  所以这份实现可以直接照抄数据手册的 int64 语义。
"""

from __future__ import annotations

import json
import sys
import time

import smbus

ADDR = 0x76


def u16(data: bytes, i: int) -> int:
    return data[i] | (data[i + 1] << 8)


def i16(data: bytes, i: int) -> int:
    v = u16(data, i)
    return v - 0x10000 if v >= 0x8000 else v


def s12(v: int) -> int:
    return v - 0x1000 if v >= 0x800 else v


class BME280:
    def __init__(self, bus, addr: int = ADDR) -> None:
        self.bus = bus
        self.addr = addr
        self.t_fine = 0

        self.dig_T1 = u16(bus.read_i2c_block_data(addr, 0x88, 2), 0)
        self.dig_T2 = i16(bus.read_i2c_block_data(addr, 0x8A, 2), 0)
        self.dig_T3 = i16(bus.read_i2c_block_data(addr, 0x8C, 2), 0)

        self.dig_P1 = u16(bus.read_i2c_block_data(addr, 0x8E, 2), 0)
        self.dig_P2 = i16(bus.read_i2c_block_data(addr, 0x90, 2), 0)
        self.dig_P3 = i16(bus.read_i2c_block_data(addr, 0x92, 2), 0)
        self.dig_P4 = i16(bus.read_i2c_block_data(addr, 0x94, 2), 0)
        self.dig_P5 = i16(bus.read_i2c_block_data(addr, 0x96, 2), 0)
        self.dig_P6 = i16(bus.read_i2c_block_data(addr, 0x98, 2), 0)
        self.dig_P7 = i16(bus.read_i2c_block_data(addr, 0x9A, 2), 0)
        self.dig_P8 = i16(bus.read_i2c_block_data(addr, 0x9C, 2), 0)
        self.dig_P9 = i16(bus.read_i2c_block_data(addr, 0x9E, 2), 0)

        self.dig_H1 = bus.read_i2c_block_data(addr, 0xA1, 1)[0]
        h = bus.read_i2c_block_data(addr, 0xE1, 7)
        self.dig_H2 = h[0] | (h[1] << 8)
        self.dig_H3 = h[2]
        self.dig_H4 = s12((h[3] << 4) | (h[4] & 0x0F))
        self.dig_H5 = s12((h[5] << 4) | (h[4] >> 4))
        self.dig_H6 = h[6] - 0x100 if h[6] >= 0x80 else h[6]

    def chip_id(self) -> int:
        return self.bus.read_byte_data(self.addr, 0xD0)

    def read_raw(self) -> tuple[int, int, int]:
        # 强制模式 + 1x 过采样；写完必须等转换完成才能读数据
        self.bus.write_byte_data(self.addr, 0xF4, 0x25)
        time.sleep(0.01)
        d = self.bus.read_i2c_block_data(self.addr, 0xF7, 8)
        adc_p = (d[0] << 12) | (d[1] << 4) | (d[2] >> 4)
        adc_t = (d[3] << 12) | (d[4] << 4) | (d[5] >> 4)
        adc_h = (d[6] << 8) | d[7]
        return adc_t, adc_p, adc_h

    def compensate(self, adc_t: int, adc_p: int, adc_h: int) -> tuple[float, float, float]:
        var1 = ((((adc_t >> 3) - (self.dig_T1 << 1))) * self.dig_T2) >> 11
        var2 = (((((adc_t >> 4) - self.dig_T1) * ((adc_t >> 4) - self.dig_T1)) >> 12) * self.dig_T3) >> 14
        self.t_fine = var1 + var2
        temperature = ((self.t_fine * 5 + 128) >> 8) / 100.0

        var1 = self.t_fine - 128000
        var2 = var1 * var1 * self.dig_P6
        var2 = var2 + ((var1 * self.dig_P5) << 17)
        var2 = var2 + (self.dig_P4 << 35)
        var1 = ((var1 * var1 * self.dig_P3) >> 8) + ((var1 * self.dig_P2) << 12)
        var1 = (((1 << 47) + var1) * self.dig_P1) >> 33
        pressure = 0.0
        if var1 != 0:
            p = 1048576 - adc_p
            p = (((p << 31) - var2) * 3125) // var1
            v1 = (self.dig_P9 * (p >> 13) * (p >> 13)) >> 25
            v2 = (self.dig_P8 * p) >> 19
            p = ((p + v1 + v2) >> 8) + (self.dig_P7 << 4)
            pressure = p / 256.0

        v = self.t_fine - 76800
        v = ((((adc_h << 14) - (self.dig_H4 << 20) - (self.dig_H5 * v)) + 16384) >> 15) * (
            ((((((v * self.dig_H6) >> 10) * (((v * self.dig_H3) >> 11) + 32768)) >> 10) + 2097152)
             * self.dig_H2 + 8192) >> 14
        )
        v = v - ((((v >> 15) * (v >> 15)) >> 7) * self.dig_H1 >> 4)
        v = max(0, min(v, 419430400))
        humidity = (v >> 12) / 1024.0

        return temperature, humidity, pressure


def main() -> int:
    bus = smbus.SMBus(1)
    sensor = BME280(bus)

    chip = sensor.chip_id()
    if chip != 0x60:
        print(json.dumps({"error": f"芯片 ID 不是 0x60，得到 {hex(chip)}"}))
        return 1

    samples = []
    for _ in range(3):
        t, h, p = sensor.compensate(*sensor.read_raw())
        samples.append({"temperature": round(t, 3), "humidity": round(h, 3), "pressure": round(p, 2)})
        time.sleep(1)

    print(json.dumps({"chipId": chip, "samples": samples}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
