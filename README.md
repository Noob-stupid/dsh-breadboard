# dsh-breadboard（`@dsh-breadboard/dsh-hardware-sandbox`）

<!-- 收录徽章位：awesome-dsh-plugin / DSH 社区列表 / dsh.so / dsh-plugin.org / …（收录通过后逐个补上官方徽章） -->

DSH 嵌入式硬件沙盒——**把你的软硬件项目在 3D 里摆出来、接上线、跑真实的硬件在环仿真**。

在 DSH 面板里，它给你一个 3D 装配场景：从内置器件库放器件（ESP32、BME280、PIR、5V LED……）、按端口连线、进入 SSOT 装配状态；仿真时由一个真实 Python 进程跑你的项目代码，通过 Python shim 拦截 I2C/GPIO 访问，从而读到虚拟设备的寄存器级读数（如 BME280 补偿计算）。它还支持**第二类虚拟硬件**——联网设备（主动向外部 HTTP 后端周期上报的设备模拟器），并已在真实的"智能选座"系统上完成全链路验证（传感器 → HTTP → 服务端状态机 → 数据库）。`skill/SKILL.md` 随插件注册，agent 一装上就知道怎么用它。

## 快速上手（三步）

1. **导入项目本体**：在面板里选择你的项目文件夹。插件会读它的图纸/接口，弄清它需要哪些硬件。
2. **扫描需要哪些硬件** —— 注意：这一步是**界面上的按钮**，它属于 UI 操作流，agent 的工具侧没有它，agent 无法替你调（agent 能做的是后面的摆器件、连线、仿真）。
3. **导入建模组**（`<型号键>/model.glb`，只有 GLB/GLTF 会加载；也可以先不补，用内置器件的默认外形）——或者直接让 agent 用 `hw_save_project` 按你的描述建一个项目图纸，再 `hw_import_project` 一键摆好全部器件和连线。

之后的流程就是标准交付：`hw_run_simulation` 跑仿真、`hw_network_control socket` 启动联网设备（设备放进场景默认是停止的，不会自己发请求）、`hw_inject_fault` 注入断线/错误读数来验证异常处理。

## Agent 工具：13 个 hw_*

以仓库实际注册清单为准（未增删）：

| 类别 | 工具 | 一句话 |
|---|---|---|
| 装配 | `hw_get_assembly` | 读当前装配状态（组件、连线、告警、供电、虚拟设备） |
| 装配 | `hw_edit_assembly` | 放器件 / 移动 / 旋转 / 连线 / 拔线 / 删除 / 钉住 |
| 仿真 | `hw_run_simulation` | 在虚拟硬件上运行真实 Python 项目代码（可加速） |
| 仿真 | `hw_inject_fault` | 断线 / NACK / busy / 强制读数 / 清故障 |
| 仿真 | `hw_get_sim_log` | 读最近一次仿真的项目输出日志 |
| 项目 | `hw_list_projects` | 列内置软硬件项目及连接通状态 |
| 项目 | `hw_import_project` | 按图纸导入：清空 → 器件/连线/绑定一次到位 |
| 项目 | `hw_save_project` | agent 按描述新建/覆盖项目图纸 |
| 联网设备 | `hw_network_add` | 添加联网设备（协议适配器 + endpoint） |
| 联网设备 | `hw_network_devices` | 列设备：在线状态 / 上报数 / 读数 / 下发配置 |
| 联网设备 | `hw_network_control` | start / stop / disconnect（只有 start 才真的出网） |
| 联网设备 | `hw_network_set_reading` | 直接设联网设备的物理读数 |
| 联网设备 | `hw_set_occlusion` | 从物理状态出发遮挡器件，影响沿实际接线传导 |

## 失败原因码与对策

装配操作的失败都带原因码（见 `src/contracts/assembly.ts` 的码表），按码给出对策：

| 原因码 | 含义 | 对策 |
|---|---|---|
| `unconnected_port` | 相关端口没接线 | 补 `connect`（先 `hw_get_assembly` 看端口 id） |
| `unknown_hardware_model` | 找不到目标硬件型号 | 用库里的真实 `hardwareModel`，先看装配清单 |
| `bad_params` | 参数不合法（如旋转角带 NaN/Infinity） | 检查数值，不要去查组件 id——问题在数值上 |
| `direction_conflict` | 两端电流方向冲突（输出对输出） | 按电流方向重排连线 |
| `protocol_mismatch` | 两端口协议不匹配 | 换协议一致的端口对 |
| `voltage_mismatch` | 端口电压不匹配 | 按电压兼容接，或换端口 |
| `port_occupied` | 端口被**别的**线占了 | 拔掉占线（`disconnect` 对应 cableId）再接 |
| `already_connected` | **就是这一对端口**之间已有线（重复连接；多端口汇同一端口是合法的 I2C 总线，不报这个） | 别去找一根不存在的线；想换线先拔这根 |
| `power_exceeded` | 供电需求超出供给预算 | 增加供电或减小功耗 |
| `i2c_address_conflict` | I2C 地址冲突 | 改其中一个设备的地址 |
| `i2c_pullup_missing` | I2C 缺上拉 | 接上拉电阻 |
| `component_pinned` | 组件已钉住，移动被**明确拒绝** | 先在右键菜单解开钉住（`set_pinned false`） |

> `port_occupied` 与 `already_connected` 是刻意分开的两个码：合在一起，用户会去找一根不存在的线。

## 建模组格式

```
<型号键>/
  model.glb      模型本体
  meta.json      元信息
```

只有 GLB / GLTF 会加载；其它格式请自行转换后再导入。内置建模组随包分发四个：`bme280` / `led-5v` / `hc-sr501` / `esp32-seat-sensor`。

## 墙钟陷阱（联网设备为什么不用虚拟时间）

虚拟时钟是**加速**的：`advance(60)` 会把 60 个虚拟秒在几十毫秒内跑完。总线上那种被动等被读的设备挂上去没问题（确定性、纯同步）；但**联网设备是主动周期上报的**——若挂在加速时钟上，一次快进会瞬间向外部后端打出几十次真实 HTTP，把对方服务器打爆。所以联网设备**一律按墙钟（真实节拍）走，与虚拟时钟解耦**，快照里带 `wallClockDriven: true`；加速模式对它们没有意义，前端也不会把它们画在虚拟时间轴上。顺带的推论：联网设备被添加后停在 `idle`，必须显式 `start` 才出网——默认不产生外部副作用。

## 安装与构建

```bash
npm install          # scripts/prepare.mjs 让 git clone 装法可用
npm test             # node --test，308 项基线
npm run build        # bash scripts/build.sh（需 DSH_CHECKOUT 指向 DSH checkout，产出 lib/）
```

发布形态为 npm pack 产物 tgz；`files` 覆盖 `lib` / `cordis.patch.yml` / `skill` / `docs` / `models` / `scripts`。`dsh.bundle.patch: ./cordis.patch.yml`。

## 前缀

所有界面与 API 挂在插件路由 `/@dsh-breadboard/dsh-hardware-sandbox/` 下；`GET …/api/capabilities` 是活体自检（build 时间戳 + 实际注册成功的 simTools 清单——工具注册失败是完全静默的，靠它判别）。

---

dsh-breadboard
