# project-shim —— Python 侧适配层

> 设计文档 §1.1 部署形态一 / §7.2 时间拦截 / §12.1 目录结构

## 一句话

**纯代理，零硬件语义。** 这里出现任何「温度是多少」之类的逻辑都是架构错误 ——
所有行为模型、虚拟时钟、状态都在宿主 JS 侧（§1.0 决策 B：权威侧唯一）。

## 注入机制

宿主把两个目录塞进项目进程的 `PYTHONPATH`，**顺序不能反**：

```
PYTHONPATH = <repo>/project-shim/shim ; <repo>/project-shim
             └─ 提供 smbus / RPi          └─ 提供 sitecustomize 与 bridge_client
```

- **`shim/` 在前** ⇒ 项目里 `import smbus`、`from RPi import GPIO` 命中我们的替身
- **`project-shim/` 在后** ⇒ Python 启动时自动 import `sitecustomize`，在**项目代码运行之前**
  完成 `time.sleep` 的替换（§1.1「注入时机确定」）

宿主还会注入四个环境变量：

| 变量 | 含义 |
|---|---|
| `DSH_HW_BRIDGE_HOST` | 回连主机（恒为 `127.0.0.1`） |
| `DSH_HW_BRIDGE_PORT` | 回连端口（OS 分配，避免固定端口冲突） |
| `DSH_HW_BRIDGE_TOKEN` | 一次性令牌。**每次仿真都不同** ⇒ 上次残留的进程连不上新一次仿真 |
| `DSH_HW_BRIDGE_VERSION` | 协议版本，两侧不一致时握手直接失败 |

> **惰性铁律**：没有这四个变量时，**整个 shim 完全无害** ——
> `sitecustomize` 什么都不做，`smbus` 只在真正访问硬件时才报「未找到回连参数」。
> 这样同一个目录被误挂到 `PYTHONPATH` 上也不会改变项目行为。

## 核心洞察：时间也是一个可拦截的接口

```python
while True:
    data = read_sensor()
    sleep(1)          # ← 被换成 clock_advance(1) → 宿主按时间片 tick 所有设备
```

没有这一步，项目会永远读到同一个值。`sitecustomize._install_sleep_interception`
就是干这个的；宿主的 `VirtualClock.advance()` 接住它。

## 实现范围（本期）

| 模块 | 状态 |
|---|---|
| `smbus.SMBus` 的字节/字/块读写 | ✅ |
| `RPi.GPIO` 引脚读写 | ❌ **本期范围外**（§9.2 协议只支持 I2C）。`setmode`/`setup`/`cleanup` 是 no-op；`output`/`input` 抛 `NotImplementedError` |
| SMBus 块协议（`read_block_data` / `process_call`） | ❌ 未建模，明确抛 `NotImplementedError` |
| `smbus2` | ⬜ 未做。现代项目更常用它，是下一步的高价值补充 |

**为什么未实现的都要明确抛错而不是静默返回假值**：静默会让 P4「拦截完整性」排查时
误判该路径已覆盖 —— 而 P4 的存在意义正是找出漏网路径。

## 异常语义（§3.2「异常一致」）

硬件访问失败一律抛 `BridgeError`，它是 **`OSError` 的子类且 `errno = 121`（EREMOTEIO）**。
这与真实 Linux 上 smbus 失败时项目看到的异常一致，所以：

```python
try:
    data = bus.read_i2c_block_data(0x76, 0x88, 26)
except OSError:          # ← 虚拟与真实环境下走同一条分支
    ...
```

宿主侧区分了两种失败（`no_device` / `disconnected`），但**都映射成 errno 121** ——
因为真实硬件上项目看到的都是 Remote I/O error。

## ★ 加速仿真的一个关键性质（写代码的人必须知道）

**虚拟 `time.sleep` 是瞬时的**：它只推进虚拟时钟，不花真实时间。

⇒ 一个含 `sleep(1) × 5` 的脚本，真实耗时约 **100ms**，不是 5 秒。

⇒ **宿主侧的一切干预都必须由事件触发，不能靠墙钟**。「等一会儿再注入故障」这种写法
在加速模式下必然失效（脚本早跑完了）。正确做法：项目发就绪信号（走 `log`），
宿主收到立即注入，项目再用**真实** sleep 留出窗口 ——
shim 刻意保留了 `time._dsh_real_sleep` 供这种场景使用。

见 `tests/test_fault.py` 与 `tests/python-shim.test.ts`。
