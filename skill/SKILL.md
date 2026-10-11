---
name: dsh-hardware-sandbox
description: 用 3D 硬件沙盒接上一个真实软硬件项目：导入项目本体、扫描它需要哪些硬件、补建模、摆器件连线、跑仿真、和真实后端联调。用户提到硬件沙盒、3D 装配、接线、ESP32、树莓派、PIR/传感器、硬件在环，或要接上某个项目看它的硬件需求时用它。
---

# DSH 嵌入式硬件沙盒

把**一个真实项目**（前后端 + 硬件代码）接进来，在 3D 里摆器件、连线、跑仿真，
并让**真机链路的每一段都可验证**：接线 → 引脚 → 协议 → 真实服务端。

它不是一个"画板"：**装配是真相（SSOT），场景是它的投影**。
所有改动都走宿主，界面与 agent 看到的是同一份状态。

---

## ★★ 最重要的一条：先读，再改，看原因码

```
hw_get_assembly  →  看清有哪些组件、端口 id、当前告警
        ↓
hw_edit_assembly / hw_import_project  →  改
        ↓
失败会给出**原因码**，照着它改，不要盲试
```

**原因码与对策**（与契约 `WarningCode` **逐项对照，共 12 项**）：

| 原因码 | 意思 | 该做什么 |
|---|---|---|
| `bad_params` | 参数不合法（如 NaN 角度） | 检查数值 |
| `direction_conflict` | 两个输出对接 / 两个供电对接 | 至少一端要改成输入 |
| `protocol_mismatch` | 两端信号种类不同（i2c ↔ spi） | 换端口；或确认该脚支持哪种信号 |
| `port_occupied` | 这个脚被别的线占了 | 换脚，或先拔掉那根 |
| `voltage_mismatch` | 电压不同（3.3 ↔ 5） | 换脚或加电平转换 |
| `power_exceeded` | 供电不够 | 减少器件或加电源 |
| `i2c_address_conflict` | 总线上两个器件地址撞了 | 改地址脚（SDO/AD0） |
| `i2c_pullup_missing` | 总线没接上拉电阻 | 给 SCL/SDA 加上拉 |
| `unconnected_port` | 有端口一根线都没接 | 按需连接；确认不是忘了另一根 |
| `unknown_hardware_model` | 找不到这个型号 | 核对型号键（用 hw_get_assembly 看现有键） |
| `component_pinned` | 组件被钉住了 | 先 `set_pinned:false` |
| `already_connected` | **就是这一根**已经连了 | 不用再连 |

**★ 返回值 `ok:true` ≠ 效果发生了。** 改完要**再看一次装配**确认。

---

## 端口的两套名字（最容易搞错的一处）

| | 例子 | 用途 |
|---|---|---|
| **`portId`** | `E4` / `P23` | **身份**，连线时用它 —— **每个脚唯一** |
| **`name`** | `GPIO23 · VSPI_MOSI` | **丝印**，人看的那行字 —— **可以重复** |

**⇒ 为什么 id 不能是功能名**：一块 ESP32 有 **8 个脚都叫 GND**。
用功能名当身份，接线表就没法表达"连的是哪一个 GND"。

---

## 标准工作流

### ① 接上一个真实项目（不是我们编的配置）

```
hw_edit_assembly({ kind: 'import_project', projectId })    ← 有装配图纸时
```
或者走**项目本体**（真实项目文件夹，两步分开）：

1. 用户在界面上点「**导入项目本体（选文件夹）**」→ 项目**进列表**
2. 再点那条目上的「**扫描需求**」→ 得出"这个项目需要哪些硬件"

**⇒ 扫描只出报告，不生成装配。** 装配该怎么接是**看代码后决定的** ——
猜出来的装配会有"看起来对但接错了"的风险，**而它不会报错**。

**扫描报告里每一项都带 `evidence`（在哪几个文件里看到的）** ——
**没有证据的结论在这里等于没有结论**。

### ② 缺的模型怎么办（用户定的规矩）

```
扫描 → 缺哪些型号
  ├─ 网上有 → 让用户下载后「导入建模组」（选文件夹，<型号键>/model.glb）
  ├─ 网上有但导不进来 → **写个清单发给用户**，别自己瞎猜
  └─ 网上没有 → **自己建模没有的部分**
```

**★ 建模 = 一个文件夹**，布局与插件自己的 `models/` **同一套**：

```
我的建模组/
  hc-sr501/            ← 子文件夹名 = 型号键（必须是库里已有的键）
    model.glb
  esp32-seat-sensor/
    model.glb
```

**★ 只有 GLB/GLTF 会被加载** —— 导 OBJ/STL 会**静默退回占位方块**（不报错）。
型号键必须是 `HARDWARE_MODELS` 里已有的键；**挂错键会让别的型号悄悄变样**。

### ③ 摆与连

```js
hw_edit_assembly({ kind: 'place_component', hardwareModel: 'hc-sr501', position: {x:0, y:0.011, z:0} })
hw_edit_assembly({ kind: 'connect', from:{componentId:'c2',portId:'OUT'}, to:{componentId:'c1',portId:'E4'} })
hw_edit_assembly({ kind: 'set_rotation', componentId:'c2', rotation:{x:0,y:1.5708,z:0} })
```

**★ 旋转绕的是组件自身包围盒中心** —— 所以转完**不需要**改 `position`。
**★ 位置单位是米**，`position` 是**包围盒中心**（不是角点）。

### ④ 跑仿真

```
hw_run_simulation({ projectPath, entry, duration })   ← duration 是**虚拟时间秒**
hw_get_sim_log({ tail })                              ← 看项目输出
hw_inject_fault({ target, type })                     ← 拔线/nack/busy/强制读数
```

**★ 虚拟时钟可以加速**（`duration: 60` 可能 1 秒跑完）——
但**联网设备不跟它走**（见下）。

### ⑤ 联网设备（第二类虚拟硬件）

```
hw_network_add({ componentId, protocol, endpoint, deviceId })
hw_network_control({ action: 'start' })          ← **不加这一句它不会发请求**
hw_network_devices({})                            ← 看注册/上报/失败次数
```

**★★ 墙钟陷阱（最容易造成真实损害的一处）**：
联网设备按**墙钟**走、与虚拟时钟**解耦**。若以为它跟着加速而调大 `duration`，
会**按真实节奏把对方服务器打爆**。加设备**默认不启动**，这是刻意的。

### ⑥ 遮挡 / 触发（物理状态 → 真实读数）

```
hw_set_occlusion({ componentId, occluded: true })
```

**★ 它沿实际接线传导**：`PIR.OUT → ESP32.E4(GPIO23) → ir_front`。
⇒ **器件没接上、或接错了脚，就什么都不会发生** —— 真机就是这样。

**★ 与 `hw_network_set_reading` 的区别**：

| 工具 | 测什么 |
|---|---|
| `hw_network_set_reading` | **直接设数字** ⇒ 只测**协议**对不对 |
| `hw_set_occlusion` | **从物理状态出发** ⇒ 测**接线**对不对 |

### ⑦ 保存与导出

```
hw_edit_assembly({kind:'import_project'})    切换项目 = 换整套硬件（会**先清空场景**）
界面：「保存当前装配到此项目」= 把眼前这套存回项目
       「导出（另存为…）」    = 存成文件带走
```

---

## 三条会咬人的纪律

1. **改之前先 `hw_get_assembly`**。它是 SSOT；凭印象改会连错脚。
2. **`ok:true` ≠ 效果发生**。这条在本项目里反复出现：
   曾经 `if (models.get(k) !== undefined) continue` —— `get` 是 **async**，
   **Promise 永远不是 undefined** ⇒ 每个键都被当成"已经有了" ⇒ **一个都没补，而且不报错**。
3. **可见的失败 > 静默的成功**。本项目专门有一份
   `docs/04-失败族-看起来正常实际全错.md`，收着 20 个"看着正常其实全错"的实例。
   **遇到不确定，就让错误可见，而不是让它过去。**

---

## 相关文件

- `docs/03-契约.md` —— 契约冻结说明
- `docs/04-失败族-看起来正常实际全错.md` —— 20 个实例 + 纪律
- `docs/06-状态与交接.md` —— 当前状态、待办、断点
- `src/contracts/library.ts` —— 型号表（有哪些型号键、每个几个脚）
