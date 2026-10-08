# 模型库 spike · 首轮结论（路径 A：嘉立创EDA / EasyEDA Pro）

> 执行：session-40f8f716 ┃ 日期：2026-10-07 ┃ 范围：**只验「能否产出可用的 `HardwareModel`」，不碰 STEP/IGES/glTF/CAD**

## 方法

不啃 SPA 文档、不依赖 GitHub（`raw.githubusercontent.com` SSL 握手失败），改为**直接抓官方类型定义包**并读其 API 面 —— 类型定义是编译期真相，且完全离线可查。

```bash
# 真名带 scope（无 scope 的 `pro-api-types` 已于 2024-07-23 unpublish，是陷阱）
https://registry.npmjs.org/@jlceda/pro-api-types/-/pro-api-types-0.4.26.tgz
# → package/index.d.ts  1,762,250 bytes（全量 API 面）
```

- `@jlceda/pro-api-types` v0.4.26 ┃ **Apache-2.0** ┃ 官方 SDK 在 **Gitee**：`gitee.com/jlceda/pro-api-sdk`
- 官方 CLI 仓库：`github.com/easyeda/easyeda-client-cli`（描述称可用 CLI 完成全自动化设计→导出制造文件）

---

## ✅ 成立：链路的两端都有官方 API

**① 入口 = LCSC 料号查询**（`index.d.ts:4068`）

```ts
public getByLcscIds<T extends boolean>(
  lcscIds: string, libraryUuid?: string, allowMultiMatch?: T
): Promise<T extends true ? ILIB_DeviceSearchItem | undefined : Array<ILIB_DeviceSearchItem>>;
```
> `@param lcscIds - 立创 C 编号` —— 与 spike 的「给定一个 LCSC 料号」**精确对应**。

**② 引脚读取**（`index.d.ts:33968`，官方 doc-comment 自带示例）

```ts
const pins = await eda.sch_PrimitiveComponent.getAllPinsByPrimitiveId(compId);
pins[0].pinNumber; pins[0].pinType;
```

引脚对象可读字段（自 `modify` 签名 `index.d.ts:34172` 交叉确认）：
`pinNumber` / `pinName` / `pinType` / `x` / `y` / `rotation` / `pinLength` / `pinShape` / `noConnected` / **`otherProperty`**

---

## ❌ 证否：三项准入判据里，一项拿不到、一项拿不全

### 1. `protocol` —— 拿不到，必须自行启发式推断 ★最大风险

`ESCH_PrimitivePinType`（`index.d.ts:30846`）是**电气类型**，不是总线协议：

```
IN / OUT / BI / PASSIVE / OPEN_COLLECTOR / OPEN_EMITTER
POWER / GROUND / HIZ / TERMINATOR / UNDEFINED
```

它**区分不出 I2C / SPI / UART** —— 这三者的引脚大多落在 `BI` / `IN` / `OUT`。
⇒ 「SDA/SCL → i2c」这类规则只能**我们自己按 `pinName` 写**。这条规则的准确率就是本方案的成败点。

### 2. `voltage` —— 引脚类型里根本不存在

枚举里没有任何电压信息。唯一希望是 `otherProperty: Record<string, string|number|boolean>` ——
但那是厂商自由填写的**可选**字段，**预期大面积缺失**。
⇒ 需要实测若干真实 LCSC 料号统计命中率，否则 `voltage_mismatch` 校验（我们的 L1 校验之一）无从谈起。

### 3. `size`（3D 包围盒）—— 无 API

全库唯一的 bbox 是 `sys_Math.getBBox(polygon)`（`index.d.ts:42029`），**只接受二维多边形**：

```ts
public getBBox(polygon: TSYS_MathPolygonInput): ISYS_MathBBox;
```

⇒ 拿不到三维包络。**印证了准入判据里补的那条**：`size` 只能人工补、或用 PCB 封装二维范围近似 ——
而后者对我们已有的 `rpi-4b` 是**错的**（PCB 1.6mm vs 含 USB 口 17mm，会让板子陷进地面）。
**即：此方案是「半自动」，不是全自动。**

---

## 对 spike 准入判据的裁决

| 交付项 | 结果 |
|---|---|
| 端口名（`pinName`） | ✅ 可拿 |
| 端口编号（`pinNumber`） | ✅ 可拿 |
| `protocol` | ❌ 拿不到，需自写 `pinName → protocol` 启发式 |
| `voltage` | ⚠️ 仅 `otherProperty` 可选字段，预期大面积缺失 |
| 包围盒尺寸（`size`） | ❌ 无 API，需人工补 |

**结论：不是「跑不通」，而是「自动化程度远低于预期」。**
端口名/编号可自动获得（这本身有价值，人工标注引脚表是纯体力活）；
但 `protocol` / `voltage` / `size` 三项仍须人工或启发式补全 —— **该方案省的是录入成本，不是判断成本。**

---

## ★ 第二轮：路径 B（KiCad）对照 —— 瓶颈是**结构性的**，不是选哪家的问题

方法：GitLab API 列 `kicad/libraries/kicad-symbols` 真实文件名（KiCad 新版把符号库拆成 `*.kicad_symdir/` 目录、一符号一文件），取 `Sensor_Pressure.kicad_symdir/BMP280.kicad_sym` 读引脚定义原文。

**KiCad 的引脚只有电气类型，没有总线协议、没有电压：**

```lisp
(pin power_in line ...)        (pin input line ...)
(pin bidirectional line ...)   (pin power_in line ...)
```

与 EasyEDA 的 `ESCH_PrimitivePinType`（`IN / OUT / BI / PASSIVE / POWER / GROUND / HIZ / ...`）**是同一类东西**。

### 判决

| | EasyEDA Pro | KiCad |
|---|---|---|
| 引脚名 / 编号 | ✅ | ✅ |
| 电气类型（输入/输出/双向/电源/地） | ✅ | ✅ |
| **总线协议**（i2c / spi / uart） | ❌ | ❌ |
| **电压** | ❌ | ❌ |

> **两个互相独立的 EDA 生态，编码的是同一个东西：引脚电气类型。**
> ⇒ 上一轮那个假设成立：**瓶颈在「EDA 符号元数据标准本身就不含总线协议」，不在厂商选择。**

**这条结论的实际含义**：`protocol` 与 `voltage` **永远得我们自己推**——不存在"换一家就能白拿"的选项。
反过来说，设计文档把 `schema/` 称作「核心壁垒」是**准确的**：它确实买不到。
而这个判断现在是**跨两个生态验证过的**，不是单点观察。

### 覆盖率（准则 ④）的一手数据

KiCad 官方 `Sensor_Pressure` 目录共 27 个型号，有 **BMP280**，**没有 BME280**；
`Sensor_Humidity` 目录 15 个文件，同样无 BME280。
⇒ **连我们自己的参照传感器，在开放符号库里都不存在**（只有它的兄弟型号）。
（注：只查了这两个最相关的目录，不排除它在别处。）

这直接印证了准则 ④ 的分量：**管线再完美，库里没有这个型号就是零。**

---

## 待办（下一轮，若要继续）

1. ~~路径 B 对照~~ —— **已完成，见上**。结论：瓶颈是结构性的。
2. **量级验证**：取若干真实 LCSC 料号，统计 `otherProperty` 里 voltage/协议信息的**命中率**。命中率高则方案回血；接近 0 则 `protocol`/`voltage` 全靠启发式，方案价值需重估。
3. **headless 实证**：CLI 能否在无 GUI 下跑通 `getByLcscIds` + `getAllPinsByPrimitiveId`。仓库描述偏「设计→导出制造文件」，**读取元件库**是否被覆盖尚未证实。
4. **覆盖率实测（准则 ④）**：拿 `rpi-4b` / `bme280` / `led-5v` / `breadboard` 去查命中几个。
   ★ **先验预测（可证伪）**：预期命中率极低，理由不是"库不够大"，而是**类别错配**——
   `breadboard`（面包板）与 `led-5v`（通用模块）**不是元件、没有 LCSC 料号**；
   `rpi-4b` 是**成品板卡**，而 EDA 库索引的是**元件（芯片）**，不是成品板。
   即：**库覆盖"芯片"，而我们的场景以"板卡与模块"为主** —— 这个错配不是换厂商能修的。
5. **授权**：Apache-2.0 只覆盖类型定义包，不覆盖厂商元件数据。自动化访问 ToS 与数据再分发仍未核实。

## ★ 第三轮：headless 追问 —— 扩展 API 跑在**客户端里面**

SDK README（Gitee `jlceda/pro-api-sdk`，即 `easyeda/easyeda-api-sdk`）的"进入开发"流程，**第 5 步是决定性的**：

> 5. 在 **嘉立创EDA专业版** 中安装生成在 `./build/dist/` 下的扩展包

⇒ 扩展 API **不是可独立调用的库，是 GUI 宿主的插件 API**。要调 `getByLcscIds` / `getAllPinsByPrimitiveId`，必须有 EasyEDA Pro 客户端在跑、且装了你的扩展。

**但存在官方桥接路径**：`easyeda/easyeda-api-skill`（官方 AI SKILL），描述为——

> 为 AI 编程工具提供完整的 EasyEDA Pro API 接口和 **WebSocket 桥接能力**

⇒ 外部进程（**我们的插件**）可以通过 WebSocket 驱动客户端里的扩展。
架构上等价于：`EasyEDA Pro 客户端（装桥接扩展） ←WS→ 我们的插件 host 半`。

### 这一轮的架构含义（决策相关）

| 维度 | 结论 |
|---|---|
| 技术可行性 | ✅ API 存在，且有官方 WS 桥接 |
| **外部依赖** | ⚠️ **需要用户机器上装有并运行 EasyEDA Pro 客户端（一个 GUI 应用）** |
| ToS | ❌ 仍未核实 |
| 语义（protocol/voltage） | ❌ 跨生态已证：拿不到，必须自推 |
| 覆盖率 | ⚠️ 类别错配（见第二轮），预期极低 |

> **一句话**：技术上走得通，但代价是**把一个第三方 EDA 桌面应用变成我们插件的运行时依赖**。
> 对一个"DSH 插件"而言，这是很重的一笔——它意味着用户为了看 3D 场景里多几个真模型，得先装并打开一个 EDA 软件。

### ★ 附带发现：官方有面向 AI 的 skill

`easyeda/easyeda-api-skill` —— 官方为 AI 编程工具提供的 SKILL（含 WebSocket 桥接）。
`prodocs.easyeda.com/cn/api/guide/how-to-start-for-ai.html` 还有专门的「**For AI：扩展工程初始化指南**」。
⇒ 厂商在主动铺 AI agent 接入这条路。若将来真要做，这是最短路径，且**不是我们逆着厂商意图硬啃**。

## ★ 第四轮：覆盖率实测（准则 ④）—— 部分证实，且**测不全本身就是证据**

### 一手信号：立创商城搜索接口对自动化返回 403

```
https://so.szlcsc.com/global.html?k=BME280            → HTTP 403 Forbidden
https://so.szlcsc.com/global.html?k=面包板             → HTTP 403 Forbidden
（带 User-Agent 亦然）
```

⇒ **厂商对自动化访问有主动拦截。** 这是准则 ③（ToS / 自动化访问）的第一手证据，
比任何文档措辞都直接：**批量抓取这条路，厂商是明确设防的。**

### 目录侧证据：BME280 确实在

经搜索旁证：立创商城有条目 [`item.szlcsc.com/93682.html`](https://item.szlcsc.com/93682.html)
——「BME280 中文资料…**Bosch(博世)**-温湿度传感器」。**它是真正的元件，因而在库。**
（另有微雪电子的 BME280 **模块**条目，那是模块不是元件。）

### 逐项裁决（对先验预测的检验）

| 我们的型号 | 性质 | 预测 | 实测 |
|---|---|---|---|
| `bme280` | **元件**（芯片） | ✅ 在库 | ✅ **证实**（LCSC 条目 93682） |
| `rpi-4b` | **成品板卡** | ❌ 不在 | ⚠️ 未定论（只见于用户工程，未见元件库条目） |
| `led-5v` | **通用模块** | ❌ 不在 | ⚠️ 未定论 |
| `breadboard` | **非元件** | ❌ 结构上不可能 | ⚠️ 未定论 |

**先验预测的"方向"成立、"强度"被修正**：
不是"几乎全不在"，而是——**真元件在，板卡/模块不在**。
⇒ 结论应表述为 **「覆盖率 = 元件覆盖率，而我们的场景不是元件」**，
而非「覆盖率低」。前者更准确，也更难反驳。

### ★ 但这一轮最重要的产出是：**这个测试在无客户端环境下做不完**

要给出一份可信的覆盖率数字，只有两条路：
1. 装并运行 **EasyEDA Pro 客户端**（+ 桥接扩展）→ 直接撞上第三轮那个"GUI 运行时依赖"结论；
2. 批量抓取立创商城 → **已被 403 拦下**，且正是准则 ③ 要否证的那件事。

> **即：连"数一数有多少型号可用"这件最基础的事，都要先接受那笔运行时依赖、或跨过 ToS 红线。**
> 这本身比覆盖率数字更能说明这条路的姿态。

---

## ★ 第五轮：用户偏好「自动锁接口位置」的可行性 —— **类别错配同样击穿 position**

用户偏好：覆盖率优先，且**接口位置最好能自动确定**。
对端的判断是「`position` 是三个字段里唯一有物理真值的（封装焊盘坐标），不是猜的」——
**这个判断在原理上成立**，但有一个前提没被检验：**拿到的封装，是谁的封装？**

### 实验（不需要任何客户端，用 KiCad 开放封装库即可证否）

```bash
# GitLab: kicad/libraries/kicad-footprints → Package_LGA.pretty
Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering.kicad_mod
```

实测焊盘定义原文：

```lisp
(pad "1" smd rect   (pad "2" smd rect   (pad "3" smd rect   (pad "4" smd rect
(pad "5" smd rect   (pad "6" smd rect   (pad "7" smd rect   (pad "8" smd rect
```

| | 封装（KiCad / LCSC 侧） | 我们的基准 `HARDWARE_MODELS.bme280` |
|---|---|---|
| 对象 | **裸芯片** BME280 | **模块**（微雪式 breakout） |
| 尺寸 | **2.5 × 2.5 mm** | **20 × 18 mm** |
| 引脚数 | **8**（LGA-8） | **3**（排针 I2C/VCC/GND） |
| 间距 | **0.65 mm** | **2.54 mm** |

**两者相差近一个数量级，且引脚数都不同 —— 它们描述的是两个不同的物理对象。**

⇒ **即使型号"命中"，封装也给不出我们要的位置。** 芯片的 8 个焊盘是裸片 land pattern；
我们的 3 个端口是 breakout 板的排针。**要自动推出位置，需要的是"模块"的封装/CAD，而那恰恰不在元件库里。**

### 判决：类别错配**同时击穿三样**

| 想要的 | 被什么挡住 |
|---|---|
| `protocol` | 标准层面无处可放（是设计的属性，非引脚的属性） |
| `voltage` | 同上，且厂商可选字段预期缺失 |
| `position` | **封装是芯片的，场景摆的是模块** —— 与覆盖率同源的类别错配 |

> **三者不是三个独立问题，是同一个问题的三个面：元件库服务于"设计芯片的人"，而我们的场景服务于"接线的人"。**

### ⇒ 于是「声明式端口布局」从退路升为**正解**

用户想要的"自动锁接口位置"，在厂商数据路线上不成立；但**在布局规则路线上成立**：

```ts
portLayout: { edge: '+z', pitch: 0.00254, count: 6, inset: 0.005 }
```

对比现状（逐个手打 12 个坐标三元组——**我们已经因此栽过一次**，两套原点约定混用）：

| | 手打坐标 | 声明式布局 |
|---|---|---|
| 出错方式 | 打错数字、混用约定（已发生） | 规则本身错，一眼可见 |
| 自洽性 | 靠人肉保证等距 | **等距是规则推出来的** |
| 自检能力 | 只能逐点验"在盒内" | 可**结构性**校验（边/间距/内缩是否合理） |

**它不是"自动"，但它是"消灭了出错的那一类操作"** —— 对这一个字段而言，收益高于任何抓取管线。

---

## 环境备注

- `raw.githubusercontent.com` SSL 握手失败；`registry.npmjs.org` 偶发超时；**jsDelivr 的 npm 通道稳定**（`gh` 通道时好时坏）。
- GitLab API（`gitlab.com/api/v4/projects/...`）**稳定可用**，适合列文件/取原文。
- 官方 SDK 主战场是 **Gitee** 不是 GitHub。
