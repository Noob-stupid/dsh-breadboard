/**
 * 硬件模型库 `schema/` —— 接口语义 + **几何尺寸**（共享契约）
 * @module dsh-hardware-sandbox/contracts/library
 *
 * ★ 设计文档 §6.6：`ModelLib` 分 `geometry/`（几何模型）与 `schema/`（接口语义，核心壁垒）。
 *   本文件是 `schema/` 的**唯一真相**，且刻意放在 `contracts/` 而非 `core/`：
 *   宿主半、前端场景半**都要读它**，所以它是共享契约而不是某一侧的私有实现。
 *
 * ── ★★ 原点约定（必须写死，否则每个型号都要人工对齐）★★ ──
 *
 *   **组件局部坐标原点 = 其几何包围盒的中心（bbox center）**，x / y / z 三轴统一。
 *   `Port.position` 与 `ComponentSpec.position` 都遵循此约定。
 *
 *   为什么选「居中」而不是「角原点」（CAD/PCB 常见的 min 角）：
 *
 *   ① **旋转枢轴**（决定性理由）：Three.js 的 `mesh.rotation` 绕**局部原点**旋转。
 *      原点在角上 ⇒ 旋转时组件绕角甩出去，端口跟着飞出，交互上手感是错的。
 *   ② Three.js 的 `BoxGeometry` 等图元**默认就是居中**的，无需 `geometry.translate()`。
 *   ③ 「外部 STEP/glTF 模型多按角原点导出」不成立：各家导出原点本来就五花八门，
 *      导入任何外部模型都**必须**按包围盒做一次原点归一化。
 *
 *   ⚠️ **y 轴的后果**：`position.y` 是组件**中心**高度，让组件「平放在地面」要写
 *      `position.y = size.y / 2`。用 {@link restingY} 取，别手算。
 *
 * ── ★ 端口位置：声明式布局规则（`portLayout`）──
 *
 *   端口位置**不再逐个手打坐标**，而是用一条规则声明：
 *
 *   ```ts
 *   portLayout: { edge: '+z', pitch: 0.012, count: 6, inset: 0.005 }
 *   ```
 *
 *   理由：手打坐标**已经出过一次错**（三个型号混用两套原点约定，树莓派 6 个端口
 *   4 个落在几何体外）。声明式规则让**等距由规则推出**而非人肉保证，并且让自检
 *   从「逐点在盒内」升级为**结构性校验**（见 {@link validateLayout}）。
 *
 *   ⚠️ **声明顺序 ≠ 几何顺序**。实测踩过：bme280 的端口按 `I2C / VCC / GND` 声明，
 *      但几何上依次是 `z = 0 / +pitch / −pitch`（中间、右、左）。所以规则提供
 *      `order`（**按 portId 列出几何顺序**）来显式表达，而不是靠索引数字去数。
 */
import type { Port, Vec3 } from './assembly.ts'
import type { Protocol } from './device.ts'

/* ─────────────────────────── 端口布局规则 ─────────────────────────── */

/** 端口排布所依附的边。'+z' 表示「贴着 +z 那条边、沿 x 方向排」。 */
export type LayoutEdge = '+x' | '-x' | '+z' | '-z'

/**
 * 声明式端口布局规则。
 *
 * 语义：端口沿 `edge` 平行的方向**等距**排布，整体**在该轴上居中**，
 * 垂直方向距该边 `inset` 米，高度默认贴顶面。
 *
 * ★★ **双排**（`rows: 2`）：排针（如树莓派 40pin）是 **2×N** 的，
 *   单排模型表达不了它。开启后按 **`order` 的下标**分排：
 *
 * ```text
 * 下标 0 → 第 0 排，第 0 列      下标 1 → 第 1 排，第 0 列
 * 下标 2 → 第 0 排，第 1 列      下标 3 → 第 1 排，第 1 列
 * …即 row = index % rows，column = floor(index / rows)
 * ```
 *
 * ⇒ **`order` 按引脚编号 1,2,3,4… 列出时，正好得到真实的物理排布**
 *   （奇数脚一排、偶数脚另一排，如树莓派的 1/3/5… 与 2/4/6…）。
 *
 * ⚠️ 两排**对称跨在 `inset` 线上**（`inset ± rowPitch/2`），
 *   所以 `inset` 给的是**两排的中线**到边的距离，不是某一排的。
 */
export interface PortLayoutRule {
  /** 依附的边。'+z' ⇒ 行沿 x 轴；'+x' ⇒ 行沿 z 轴。 */
  readonly edge: LayoutEdge
  /** 相邻端口间距（米）。**同排内**的列间距。 */
  readonly pitch: number
  /** 端口数量。必须与 `ports.length` 一致。 */
  readonly count: number
  /** 距所依附那条边的内缩（米）。双排时是**两排中线**的距离。 */
  readonly inset: number
  /** 端口高度（米，组件局部坐标）。省略则取顶面下 {@link TOP_FACE_INSET}。 */
  readonly height?: number
  /**
   * **排数**。省略 = 1（单排）。排针填 **2**。
   * ★ 取 2 是实测需要：树莓派 40pin / ESP32 排针都是 2×N。
   */
  readonly rows?: number
  /**
   * **排间距**（米）。省略则取 {@link PITCH_254}（2.54mm，标准排针）。
   * ⚠️ 只在 `rows ≥ 2` 时有意义。
   */
  readonly rowPitch?: number
  /**
   * **沿边方向的整体偏移**（米）。省略 = 0（在该轴上居中）。
   *
   * ★ 为什么需要它：**排针在板上本来就不居中**。
   *   实测树莓派 40pin 的中心在 **x ≈ −4mm**，而 `edge:'-z'` 的默认居中会把
   *   20 列铺在 ±24.13mm ⇒ 一端探出排针之外。
   *   （**"居中"是个方便，不是事实** —— 真实器件上很少有东西正好在几何中心。）
   */
  readonly offset?: number
  /**
   * **几何顺序**：按 portId 列出端口的排列次序（从负方向到正方向）。
   * 省略则使用 `ports` 的声明顺序。
   * ★ 双排时它是**按「第0排第0列、第1排第0列、第0排第1列…」**交错消费的 —— 见接口说明。
   */
  readonly order?: readonly string[]
}

/** 端口默认落位：顶面下 0.1mm（避免与顶面共面导致 z-fighting）。 */
export const TOP_FACE_INSET = 0.0001

/* ─────────────────────────── 模型 ─────────────────────────── */

/** 源模型的一条轴（带符号）。用于 {@link ModelOrientation}。 */
export type SourceAxis = '+x' | '-x' | '+y' | '-y' | '+z' | '-z'

/**
 * **朝向覆盖** —— 人工指定"源模型里哪条轴是厚度、哪条是长度"。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 符号的读法（**读错会静默翻转模型，而包围盒看不出来**）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `up: '-z'` 读作「**源模型的 −z 方向朝上**」，即 `M·(0,0,−1) = (0,1,0)`；
 * `length: '-x'` 读作「源模型的 −x 方向指向 +x」，即 `M·(−1,0,0) = (+1,0,0)`。
 *
 * ⇒ **符号属于"源模型的哪一端"，不属于别的任何东西。**
 *   若实现成"取绝对值再另作处理"，就会差一个翻转 —— 而**镜像的包围盒与原模型完全相同**。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ⚠️⚠️ `up` 与 `length` **必须落在不同的轴上** —— 否则 det = 0，模型被压平
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 一条轴**不可能同时**映到 `+y` 和 `+x`。若 `up` 与 `length` 指向同一条轴
 * （如 `up: '+z', length: '+z'`，或 `'+z'` / `'-z'` 这种同轴异号）：
 *
 * ```text
 * ⇒ 变换矩阵某一行全零 ⇒ det = 0
 * ⇒ 结果不是"转错"，而是**几何被压平成一张纸**，而且**不会有任何报错**
 * ```
 *
 * **消费方应当**：检测到同轴就**退回自动规则**并上报（UI 出 **error**），
 * **不要抛异常**（不能让一个数据错误把整个模型变成空白），**也不要渲染压平的垃圾**。
 *
 * ★ 这与上面那条"det 必须为 +1"是**两个不同的约束**，都要查：
 *   · `det = −1` ⇒ **镜像**（模型翻转，端口落到错误一侧，包围盒不变）
 *   · `det = 0`  ⇒ **压平**（退化，模型塌成一张纸）
 */
export interface ModelOrientation {
  /** 源模型里哪条轴是**厚度/上**（会被映到 **+y**）。 */
  readonly up: SourceAxis
  /** 源模型里哪条轴是**长度**（会被映到 **+x**）。**必须与 `up` 不同轴。** */
  readonly length: SourceAxis
}

/** 一个预置硬件型号的接口语义 + 几何尺寸。 */
export interface HardwareModel {
  /** 模型库键。前端按它加载几何；`ComponentSpec.hardwareModel` 存的就是它。 */
  readonly key: string
  readonly label: string
  /**
   * **朝向覆盖** —— 人工指定"源模型里哪条轴是厚度、哪条是长度"。
   *
   * ★ 触发条件已经响了（公约原文「per-model override 字段**等首个真实模型落地时再加**」）：
   *   实测 `mpl3115a2` 的长/宽是 **19.05 vs 17.78，只差 7%**，而两条都是**水平轴**
   *   ⇒ "哪条是长"**不是测量结果，而是约定**。判错了模型会在平面内转 90°，
   *     而**包围盒完全看不出来**。这种情况必须由人指定，不能靠阈值硬猜。
   *
   * ⚠️⚠️ **实现者注意：只能产出旋转（det = +1），绝不能产出反射（det = −1）。**
   *   6 种尺寸序里**有 3 种是反射**（`x>y>z` / `y>z>x` / `z>x>y`），
   *   而 `x>y>z` **恰好就是两个 Adafruit 传感器模型的尺寸序**。
   *
   *   反射会把模型**镜像**，而 `Port.position` 是**手写在归一化坐标系里、不会被一起镜像**的
   *   ⇒ 板子左右翻转、**端口落到错误的一侧**，而**包围盒一模一样** ⇒
   *   **长宽比告警不会触发，一切看起来都对**。
   *
   *   ⇒ **镜像比"转错 90°"更隐蔽，因为它连尺寸都对。**
   *     务必按「定 up → 定 length → 第三轴由 det=+1 反解」实现，**不要做轴置换**。
   *
   * ★ 同一个包围盒对应 **4 个真旋转**（上下翻转 × 长度方向翻转）——
   *   包围盒**量不出**这两个自由度，所以它们是**约定**，实现里应明写而不是藏起来。
   *
   * 省略 = 走自动规则（最薄→+y、其余较长的→+x）。
   */
  readonly orientation?: ModelOrientation
  /**
   * **3D 包围盒**尺寸（米）：x = 长，y = 厚/高，z = 宽。
   * ★ 这是几何尺寸的**唯一出处** —— 前端只保留颜色/材质，尺寸从这里取。
   *
   * ⚠️⚠️ **它不是 PCB 封装（land pattern）尺寸，二者不可互换。**
   *   厂商的结构化元数据（引脚/焊盘）给的是**二维封装范围**，而这里是**三维包络**：
   *
   *   | 型号类型 | 封装尺寸 ≈ 3D 尺寸？ | 例子 |
   *   |---|---|---|
   *   | 裸 IC | ✅ 基本等价 | BME280 芯片：2.5×2.5mm |
   *   | **模块 / 板卡** | ❌ **差一个数量级** | BME280 **模块** 20×18mm；树莓派 PCB 1.6mm vs 含接口 17mm |
   *
   *   拿封装尺寸当 `size` 的后果是**具体的**：`restingY()` 返回 `size.y/2`，
   *   树莓派会得到 0.0008 而不是 0.0085 —— **板子直接陷进地面**，端口锚点全部错位。
   *
   *   ⇒ 从厂商元数据导入型号时，**`size` 必须另有来源**（厂商另给的 3D 包络、
   *     或人工量取）。凡是从封装尺寸推出来的，都是半自动流程，成本要如实计入。
   */
  readonly size: Vec3
  /**
   * 端口定义（组件局部坐标，原点 = 包围盒中心）。
   * `occupiedBy` 由 AssemblyState 在生成快照时填，这里只给静态语义。
   */
  readonly ports: readonly Port[]
  /** I2C 从机地址（若该型号是 I2C 设备）。用于地址冲突检测。 */
  readonly i2cAddress?: number
  /** 自身功耗（瓦）。用于供电预算。 */
  readonly powerDrawW: number
  /** 可作为电源，提供多少瓦预算。非电源为 0。 */
  readonly powerSupplyW: number
}

/** 作者时端口声明：**语义**（位置可由 `portLayout` 派生）。 */
export type PortSpec = Omit<Port, 'position' | 'occupiedBy'> & {
  /** 显式位置。省略时由 `portLayout` 派生；两者都缺则解析时报错。 */
  readonly position?: Vec3
}

/** 作者时型号声明（`ports` 允许省略位置）。 */
export interface HardwareModelSource extends Omit<HardwareModel, 'ports'> {
  readonly ports: readonly PortSpec[]
  readonly portLayout?: PortLayoutRule
}

/* ─────────────────────────── 解析（作者时 → 运行时） ─────────────────────────── */

/** 布局规则不合法时抛出。**在模型表构造时**就抛，不等到运行时。 */
export class PortLayoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortLayoutError'
  }
}

/**
 * 结构性校验 —— 这是声明式布局相对手打坐标的**主要收益**。
 *
 * 逐点校验只能告诉你「某个点越界了」；这里能拦住**规则本身就不合理**的情况，
 * 最典型的是 `pitch×(count−1) + 2×inset > 沿边轴长度` ——
 * **一行端口比板子还长**，在"写规则"那一刻就被拦下，而不是跑完才发现。
 */
export function validateLayout(model: HardwareModelSource, rule: PortLayoutRule): void {
  const where = `${model.key}.portLayout`

  if (!Number.isFinite(rule.pitch) || rule.pitch <= 0) {
    throw new PortLayoutError(`${where}.pitch 必须是正的有限数，收到 ${String(rule.pitch)}`)
  }
  if (!Number.isInteger(rule.count) || rule.count < 1) {
    throw new PortLayoutError(`${where}.count 必须是 ≥1 的整数，收到 ${String(rule.count)}`)
  }
  if (!Number.isFinite(rule.inset) || rule.inset < 0) {
    throw new PortLayoutError(`${where}.inset 必须是非负数，收到 ${String(rule.inset)}`)
  }
  if (rule.count !== model.ports.length) {
    throw new PortLayoutError(
      `${where}.count=${String(rule.count)} 与 ports.length=${String(model.ports.length)} 不一致`,
    )
  }

  // ★ 沿边方向：整行是**居中**的 ⇒ 约束只有「装得下」。
  //
  //   ⚠️ 这里踩过一次：最初写成 `pitch×(count−1) + 2×inset ≤ 沿边轴长度`，
  //      结果把 led-5v 判成非法（0.02508 > 0.02），而它的实际坐标明明在盒内。
  //      错因是**把 `inset` 当成了沿边方向的边距** —— 它的语义是**垂直方向**
  //      距所依附那条边的内缩。两个方向混在一起，公式就废了。
  //      （这次是校验器把校验公式自己的 bug 抓了出来，也算它第一天就挣回了成本。）
  const alongIsX = rule.edge === '+z' || rule.edge === '-z'
  const along = alongIsX ? model.size.x : model.size.z

  // ★ 双排：排数与排间距必须合法，且沿边方向按**列数**算，不是端口数。
  const rows = Math.max(1, Math.trunc(rule.rows ?? 1))
  if (rule.rows !== undefined && (!Number.isInteger(rule.rows) || rule.rows < 1)) {
    throw new PortLayoutError(`${where}.rows 必须是 ≥1 的整数，收到 ${String(rule.rows)}`)
  }
  const rowPitch = rule.rowPitch ?? PITCH_254
  if (rows > 1 && (!Number.isFinite(rowPitch) || rowPitch <= 0)) {
    throw new PortLayoutError(`${where}.rowPitch 必须是正的有限数，收到 ${String(rowPitch)}`)
  }
  const columns = Math.ceil(rule.count / rows)
  const spread = rule.pitch * (columns - 1)
  if (spread > along) {
    throw new PortLayoutError(
      `${where}: 端口装不下 —— pitch×(${String(columns)}列−1) = ${spread.toFixed(6)}m ` +
        `> 沿边轴长度 ${along.toFixed(6)}m（${rule.edge} ⇒ 沿 ${alongIsX ? 'x' : 'z'} 轴` +
        `${rows > 1 ? `，${String(rows)} 排 × ${String(columns)} 列` : ''}）`,
    )
  }

  // ★ 垂直方向：inset 是从所依附那条边往里缩的距离，不能缩过头。
  //   inset = 半个垂直轴长 ⇒ 整行正好落在中线上（led-5v 就是这么用的）。
  //   ⚠️ 双排时两排**对称跨在 inset 线上**，所以最外那排到边的距离是 `inset + rowPitch/2`，
  //      要拿它去比 —— 拿 `inset` 比会漏掉外侧那排探出板外的情况。
  const perpendicular = alongIsX ? model.size.z : model.size.x
  const outermost = rule.inset + ((rows - 1) / 2) * rowPitch
  if (outermost > perpendicular) {
    throw new PortLayoutError(
      `${where}: inset${rows > 1 ? ' + rowPitch/2' : ''}=${outermost.toFixed(6)}m 越出垂直轴 —— ` +
        `${rule.edge} ⇒ 垂直方向轴长 ${perpendicular.toFixed(6)}m` +
        `（inset 取一半即落在中线${rows > 1 ? '；双排时外侧那排还要再加 rowPitch/2' : ''}）`,
    )
  }

  if (rule.order !== undefined) {
    const declared = model.ports.map((port) => port.portId)
    const seen = new Set(rule.order)
    if (seen.size !== rule.order.length) {
      throw new PortLayoutError(`${where}.order 里有重复 portId`)
    }
    for (const id of rule.order) {
      if (!declared.includes(id)) {
        throw new PortLayoutError(`${where}.order 里的 "${id}" 不在 ports 中（已知：${declared.join(', ')}）`)
      }
    }
    if (rule.order.length !== declared.length) {
      throw new PortLayoutError(
        `${where}.order 只列了 ${String(rule.order.length)} 个，ports 有 ${String(declared.length)} 个`,
      )
    }
  }

  if (rule.height !== undefined) {
    const halfY = model.size.y / 2
    if (Math.abs(rule.height) > halfY + 1e-9) {
      throw new PortLayoutError(
        `${where}.height=${String(rule.height)} 越出包围盒 y 轴（±${String(halfY)}）`,
      )
    }
  }
}

/** 由规则算出某个几何槽位的局部坐标。 */
function slotPosition(model: HardwareModelSource, rule: PortLayoutRule, slot: number): Vec3 {
  const half = { x: model.size.x / 2, y: model.size.y / 2, z: model.size.z / 2 }
  const y = rule.height ?? half.y - TOP_FACE_INSET

  // ★ 双排：slot 按「第0排第0列、第1排第0列、第0排第1列…」交错消费。
  //   这正是排针的物理排布（奇数脚一排、偶数脚另一排）。
  const rows = Math.max(1, Math.trunc(rule.rows ?? 1))
  const rowPitch = rule.rowPitch ?? PITCH_254
  const row = slot % rows
  const column = Math.floor(slot / rows)
  const columns = Math.ceil(rule.count / rows)

  // 沿边方向：默认居中（第 0 列在负方向端），`offset` 是**整体平移**
  const offset = (column - (columns - 1) / 2) * rule.pitch + (rule.offset ?? 0)
  // 两排**对称跨在 inset 线上**：inset ± rowPitch/2
  const inset = rule.inset + (row - (rows - 1) / 2) * rowPitch

  switch (rule.edge) {
    case '+z':
      return { x: offset, y, z: half.z - inset }
    case '-z':
      return { x: offset, y, z: -half.z + inset }
    case '+x':
      return { x: half.x - inset, y, z: offset }
    case '-x':
      return { x: -half.x + inset, y, z: offset }
    default: {
      const exhaustive: never = rule.edge
      throw new PortLayoutError(`未知的 edge：${String(exhaustive)}`)
    }
  }
}

/** 把作者时声明解析成运行时模型（端口位置全部落实）。 */
export function resolveModel(source: HardwareModelSource): HardwareModel {
  const rule = source.portLayout

  if (rule !== undefined) {
    validateLayout(source, rule)

    // ★ 「既有规则又写了显式坐标」必须**抛错**，不能"规则胜出 + 告警"。
    //
    //   理由与本文件其他几处一致：这个项目反复被"两处真相"咬过
    //   （三个型号混用两套原点约定、声明顺序 ≠ 几何顺序）。
    //   而"告警"在这条链路上等于没有 —— 规则在**模块加载时**求值，
    //   一条没人看的 warning 拦不住任何人。抛错才拦得住。
    //
    //   对称性：既无 position 也无 portLayout 也抛错。两种歧义都不放过。
    const conflicting = source.ports.filter((port) => port.position !== undefined)
    if (conflicting.length > 0) {
      throw new PortLayoutError(
        `${source.key}: 同时给了 portLayout 与显式 position（${conflicting
          .map((port) => port.portId)
          .join(', ')}）—— 二者只能取其一，否则就是两处真相`,
      )
    }

    const sequence = rule.order ?? source.ports.map((port) => port.portId)
    const slotOf = new Map(sequence.map((portId, slot) => [portId, slot]))

    return {
      ...source,
      ports: source.ports.map((port) => {
        const slot = slotOf.get(port.portId)
        if (slot === undefined) {
          throw new PortLayoutError(`${source.key}: 端口 "${port.portId}" 不在 portLayout.order 中`)
        }
        return { ...port, position: slotPosition(source, rule, slot) }
      }),
    }
  }

  // 无规则：必须逐个给显式位置
  return {
    ...source,
    ports: source.ports.map((port) => {
      if (port.position === undefined) {
        throw new PortLayoutError(
          `${source.key}.${port.portId} 既没有显式 position，也没有 portLayout 可派生`,
        )
      }
      return { ...port, position: { ...port.position } }
    }),
  }
}

/* ─────────────────────────── 型号数据 ─────────────────────────── */

/** 2.54mm 排针间距。 */
const PITCH_254 = 0.00254

const RPI_SIZE: Vec3 = { x: 0.085, y: 0.017, z: 0.056 }
const BME280_SIZE: Vec3 = { x: 0.02, y: 0.003, z: 0.018 }
const LED_SIZE: Vec3 = { x: 0.02, y: 0.01, z: 0.02 }
const BREADBOARD_SIZE: Vec3 = { x: 0.165, y: 0.009, z: 0.055 }
/**
 * ESP32 座位传感器（联网设备）。
 *
 * ★ 尺寸取的是**含双红外探头与排针的 3D 包络**，不是 PCB 封装 —— 见 `HardwareModel.size`
 *   的警告（树莓派 PCB 1.6mm vs 含接口 17mm，用错会让板子陷进地面）。
 *   实测参考：常见 ESP32 DevKit 约 55×28mm，加探头与针脚取 15mm 厚。
 */
const ESP32_SEAT_SENSOR_SIZE: Vec3 = { x: 0.055, y: 0.015, z: 0.028 }
/**
 * Adafruit 1893 MPL3115A2 气压/高度传感器 breakout。
 *
 * ★ 尺寸来源：**导入的 GLB 实测包围盒**（19.05 × 17.78 × 2.60 mm），按契约的
 *   x=长 / y=厚 / z=宽 重排 ⇒ (19.05, 2.60, 17.78) mm。
 *   ⚠️ 这是 `docs/03` §6.3「bbox 作初值」那条路的实例 —— **厚度取自几何量，不是猜的**。
 *   ⚠️ 但要注意：**该 GLB 的轴向是 x>y>z**（厚度在 z），与契约的 x>z>y **不一致**，
 *      渲染前需要一次朝向归一化（见 `scene/model-provider.ts` 的朝向契约）。
 */
const MPL3115A2_SIZE: Vec3 = { x: 0.01905, y: 0.0026, z: 0.01778 }

/**
 * 作者时型号表。位置由 `portLayout` 派生，**不手打坐标**。
 *
 * ★ `order` 表达的是**几何顺序**（从负方向到正方向），不是声明顺序 ——
 *   这两者在本表里**确实不同**，见文件头的警告。
 */
const SOURCES: Readonly<Record<string, HardwareModelSource>> = {
  'rpi-4b': {
    key: 'rpi-4b',
    label: 'Raspberry Pi 4B',
    size: RPI_SIZE,
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 40pin 排针 —— **逐针建模**（2026-10-08 改）
    // ══════════════════════════════════════════════════════════════════════
    //
    // ⚠️⚠️ **原来只有 6 个"逻辑总线"端口，那是错的，而且错得有后果。**
    //   原来 `I2C1` 是**一个**端口、名字写着 `SDA1/SCL1 · pin3/5` —— 把两根线并成了一根。
    //   ⇒ **一根线代表 SDA+SCL** ⇒ **"SDA 接了、SCL 忘了"在模型里根本表达不出来**，
    //     `unconnected_port` 也不可能为 SCL 触发
    //   ⇒ **初学者最经典的那个接线错误，这个沙盒检测不到。**
    //
    //   契约本来就不是这么设计的 —— `Port.name` 的文档例子是 `'SDA' / 'SCL' / 'GPIO4'`，
    //   即**每个引脚一个端口**。是 `SOURCES` 里的实现把它合并了。
    //
    // ★ `portId` 用 **`P1`…`P40`（按引脚编号）**，不用功能名 —— 因为功能会重复：
    //   `3V3` 在 pin1 和 pin17、`5V` 在 pin2 和 pin4、**`GND` 在 8 个引脚上**。
    //   用功能当 id 会撞号，而**撞号的后果是静默的**（连接关系分不清是哪一根）。
    //   功能写在 `name` 里（契约规定的"丝印名"）。
    //
    // ★ 真实引脚功能表（Raspberry Pi 40-pin header）：
    //   ```
    //    1  3V3         |  2  5V            21 GPIO9  MISO | 22 GPIO25
    //    3  GPIO2 SDA1  |  4  5V            23 GPIO11 SCLK | 24 GPIO8  CE0
    //    5  GPIO3 SCL1  |  6  GND           25 GND          | 26 GPIO7  CE1
    //    7  GPIO4       |  8  GPIO14 TXD0   27 GPIO0  ID_SD | 28 GPIO1  ID_SC
    //    9  GND         | 10  GPIO15 RXD0   29 GPIO5        | 30 GND
    //   11  GPIO17      | 12  GPIO18        31 GPIO6        | 32 GPIO12
    //   13  GPIO27      | 14  GND           33 GPIO13       | 34 GND
    //   15  GPIO22      | 16  GPIO23        35 GPIO19 MISO1 | 36 GPIO16
    //   17  3V3         | 18  GPIO24        37 GPIO26       | 38 GPIO20 MOSI1
    //   19  GPIO10 MOSI | 20  GND           39 GND          | 40 GPIO21 SCLK1
    //   ```
    //   ⇒ **奇数脚一排、偶数脚另一排** —— 正好对应 `rows: 2` 的交错消费规则。
    //
    // ★ `direction`：真实 GPIO **默认可输入可输出** ⇒ `'io'`；电源只出 ⇒ `'power'`；地 ⇒ `'ground'`。
    //   （原来**根本没有方向字段**，方向只能从 `protocol` 猜 —— 那是错的。）
    //
    // ★ 布局：`rows: 2` + `pitch: 2.54mm` + `rowPitch: 2.54mm`（标准排针）
    //   ⇒ 20 列 × 2.54 = **48.26mm**，正是真 40pin 的首尾针中心距。
    //   `offset: −4mm` —— **实测排针中心在 x ≈ −4mm**（射线扫到引脚的 x ∈ [−22, +14]），
    //   而默认"居中"会把它铺在 ±24.13mm ⇒ 一端探出排针之外。
    portLayout: {
      edge: '-z',
      // ⚠️ 用 **2.3mm** 而不是标准的 2.54mm —— 这是**归一化之后**模型的实际引脚间距。
      //   根因：声明的 `size.x = 85mm`（真树莓派 PCB 长）而**模型包围盒 x = 92.86mm**
      //   ⇒ 逐轴缩放系数 85/92.86 = **0.9153** ⇒ 模型里 2.54mm 的标准间距被压成 **2.32mm**。
      //   （实测：排针区 20 个引脚列 mesh，每列宽 2.3mm、中心从 −17.9 到 +14.6mm。）
      //   ⇒ 用 2.54 会让 19 列累积漂移 **4.6mm**，两端引脚落到排针外（实测 P37–P40 落空）。
      //   ⚠️ 这是**已知的模型/契约尺寸不一致**：模型的 x:y:z 比例与真机差 4%–17%，
      //     逐轴缩放必然使它变形。要根治得让 `size` 等于模型包围盒（但那样声明的就不是真机尺寸了）
      //     —— 两条路各有代价，**已记在 `docs/06` 待办里，等用户定**。
      pitch: 0.002325,
      count: 40,
      inset: 0.00325,
      // ★★ `height: 0` —— **锚在针杆中部，不是针尖**（2026-10-08 改）
      //
      //   ⚠️ 原来填的是**实测的针尖** +3.1mm。数据上没错，**但它让线看起来"没插进去"**：
      //     线缆末段是**垂直落下到端口**的，落在针尖 ⇒ 端点停在针尖上，
      //     视觉上就是"插头悬在引脚上"。用户的原话：「**连接接口应该直接套进去**」。
      //
      //   ★ 真机是什么样：杜邦插头是**套在针杆上**的，不是坐在针尖。
      //     ⇒ 端口该锚在**针杆**上，不是针尖。
      //
      //   实测（`tools/_port_on_model.py` 的引脚列 mesh）：针杆 y ∈ [−8.03, +3.08]mm，
      //   其中露出排针塑料座的部分约 **[−3.8, +3.08]**（−3.8 = 射线打到塑料座顶面的高度）。
      //   取 **0**：线管（直径 1.6mm）会**从针尖穿下去、裹住针杆上段** ⇒ 正是"套进去"的样子。
      //
      //   ⚠️ 副作用（**是好的**）：端口锚点也从针尖移到了针杆 ——
      //     而"点这里接一根线"本来就该点针杆，不是点针尖。
      height: 0,
      rows: 2,
      rowPitch: 0.002325,
      offset: -0.00863,
    },
    ports: [
      { portId: 'P1', name: '3V3', protocol: 'power', voltage: 3.3, direction: 'power' },
      { portId: 'P2', name: '5V', protocol: 'power', voltage: 5, direction: 'power' },
      { portId: 'P3', name: 'GPIO2 · SDA1', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P4', name: '5V', protocol: 'power', voltage: 5, direction: 'power' },
      { portId: 'P5', name: 'GPIO3 · SCL1', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P6', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P7', name: 'GPIO4', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P8', name: 'GPIO14 · TXD0', protocol: 'uart', voltage: 3.3, direction: 'io' },
      { portId: 'P9', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P10', name: 'GPIO15 · RXD0', protocol: 'uart', voltage: 3.3, direction: 'io' },
      { portId: 'P11', name: 'GPIO17', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P12', name: 'GPIO18', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P13', name: 'GPIO27', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P14', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P15', name: 'GPIO22', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P16', name: 'GPIO23', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P17', name: '3V3', protocol: 'power', voltage: 3.3, direction: 'power' },
      { portId: 'P18', name: 'GPIO24', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P19', name: 'GPIO10 · MOSI', protocol: 'spi', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P20', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P21', name: 'GPIO9 · MISO', protocol: 'spi', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P22', name: 'GPIO25', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P23', name: 'GPIO11 · SCLK', protocol: 'spi', voltage: 3.3, direction: 'out', shared: true },
      { portId: 'P24', name: 'GPIO8 · CE0', protocol: 'spi', voltage: 3.3, direction: 'out', shared: true },
      { portId: 'P25', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P26', name: 'GPIO7 · CE1', protocol: 'spi', voltage: 3.3, direction: 'out', shared: true },
      { portId: 'P27', name: 'GPIO0 · ID_SD', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P28', name: 'GPIO1 · ID_SC', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P29', name: 'GPIO5', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P30', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P31', name: 'GPIO6', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P32', name: 'GPIO12', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P33', name: 'GPIO13', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P34', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P35', name: 'GPIO19 · MISO1', protocol: 'spi', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P36', name: 'GPIO16', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P37', name: 'GPIO26', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'P38', name: 'GPIO20 · MOSI1', protocol: 'spi', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'P39', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'P40', name: 'GPIO21 · SCLK1', protocol: 'spi', voltage: 3.3, direction: 'out', shared: true },
    ],
    powerDrawW: 3.0,
    powerSupplyW: 15.0,
  },

  bme280: {
    key: 'bme280',
    label: 'BME280 温湿度气压传感器',
    size: BME280_SIZE,
    // 排针沿 -x 边、沿 z 排布；★ 几何顺序与声明顺序不同，故显式给 order
    // ★ 逐针：真实 BME280 模块是 **4 针**（VCC/GND/SCL/SDA），原来把 SDA+SCL 并成了一个 `I2C` 端口
    //   ⇒ 一根线代表两根 ⇒ **"接了一根忘了另一根"检测不出来**。拆开。
    portLayout: { edge: '-x', pitch: PITCH_254, count: 4, inset: 0.004, order: ['VCC', 'GND', 'SCL', 'SDA'] },
    ports: [
      { portId: 'VCC', name: 'VCC', protocol: 'power', voltage: 3.3, direction: 'in' },
      { portId: 'GND', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'SCL', name: 'SCL', protocol: 'i2c', voltage: 3.3, direction: 'in', shared: true },
      { portId: 'SDA', name: 'SDA', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
    ],
    // 文档 §5.2 / §8 流程 B 均以 0x76 为准（SDO 接 GND）
    i2cAddress: 0x76,
    powerDrawW: 0.004,
    powerSupplyW: 0,
  },

  'led-5v': {
    key: 'led-5v',
    label: 'LED 模块（5V）',
    size: LED_SIZE,
    // 沿 +z 边、沿 x 排布；inset 取半深 ⇒ 落在 z=0 中线
    portLayout: { edge: '+z', pitch: PITCH_254, count: 3, inset: 0.01, order: ['GND', 'SIG', 'VCC'] },
    ports: [
      { portId: 'SIG', name: 'SIG', protocol: 'gpio', voltage: 5, direction: 'in' },
      { portId: 'VCC', name: 'VCC', protocol: 'power', voltage: 5, direction: 'in' },
      { portId: 'GND', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
    ],
    powerDrawW: 0.1,
    powerSupplyW: 0,
  },

  /**
   * ESP32 座位传感器 —— **第二类虚拟硬件**（联网设备）的载体型号。
   *
   * ★ **`ports` 为空是语义正确的，不是遗漏。**
   *   这台设备的"连接"是**网络**（WiFi/HTTP），不是导线 ——
   *   它不挂 I2C/GPIO 总线，所以没有任何总线端口。
   *   给它硬造几个端口反而会：① 触发无意义的 `unconnected_port` 告警
   *   ② 让用户以为要接线才能用。
   *
   * ★ 它**不产生** `VirtualDevice`（`DEFAULT_DEVICE_FACTORIES` 里没有它），
   *   产生的是 `NetworkedDevice`（见 `core/sim/network-registry.ts`）。
   *   两者的差别不是实现细节，是**驱动源不同**（虚拟时钟 vs 墙钟）。
   */
  'esp32-seat-sensor': {
    key: 'esp32-seat-sensor',
    label: 'ESP32 座位传感器（联网）',
    size: ESP32_SEAT_SENSOR_SIZE,
    // ══════════════════════════════════════════════════════════════════════
    // ★★ 逐针建模（2026-10-08 改）—— 原来是 **`ports: []`（零端口）**
    // ══════════════════════════════════════════════════════════════════════
    //
    // ⚠️ 用户问「**esp32 就这么点接口吗**」—— 原来不是"少"，是**一个都没有**。
    //   而 **ESP32 DevKit 真机是 30 针（2×15）**，引脚全部引出可接线。
    //   建模成 0 端口等于说"这台板子接不了任何线"，与真机不符。
    //
    // ★ 排布：ESP32 DevKit V1（30pin）的真实引脚表，`rows: 2` 双排：
    //   ```
    //     左（天线端起）              右（天线端起）
    //     EN                           GPIO23 · VSPI_MOSI
    //     VP  · GPIO36                 3V3
    //     VN  · GPIO39                 GPIO22 · SCL
    //     GPIO34                       TX0 · GPIO1
    //     GPIO35                       RX0 · GPIO3
    //     GPIO32                       GPIO21 · SDA
    //     GPIO33                       GND
    //     GPIO25                       GPIO19 · VSPI_MISO
    //     GPIO26                       GPIO18 · VSPI_CLK
    //     GPIO27                       GPIO5  · VSPI_CS
    //     GPIO14 · HSPI_CLK            GPIO17
    //     GPIO12 · HSPI_MISO           GPIO16
    //     GPIO13 · HSPI_MOSI           GPIO4
    //     GND                          GPIO0  · BOOT
    //     VIN                          GPIO2
    //   ```
    //   ⇒ 奇数位一排、偶数位另一排 —— 与 `rows: 2` 的交错规则一致。
    //
    // ⚠️ `powerDrawW` **仍然是 0，但理由换了**：不是"没有端口所以与电气无关"，
    //   而是「**它的供电来自自己的 USB / 电池，不从装配取电**」（座位上的真机就是这样）。
    //   `powerDrawW` 量的是**从装配取的电**，不是器件总功耗 —— 这两者不是一回事。
    //   ★ 保留 0 还有一条实测理由：早先填 0.5W 时，**场景里单独放一台 ESP32 会失败**
    //     （`power_exceeded`：需求 0.5W > 预算 0W）。而正确的修法**不是**"再放个电源" ——
    //     你不会用面包板给一台墙上供电的 ESP32 供电。
    //   ⚠️ 已知简化：若用户真把 VIN 接到装配的 5V，本模型**不会**把它算进预算。
    //     要修就得区分"自供电 / 装配供电"两种模式 —— 那是另一件事，先记在这里。
    portLayout: {
      edge: '+z',
      pitch: PITCH_254,
      count: 30,
      inset: 0.0025,
      height: 0.0031,
      rows: 2,
      rowPitch: PITCH_254,
    },
    ports: [
      // ── 左侧（靠天线端）──
      { portId: 'E1', name: 'EN', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E3', name: 'VP · GPIO36', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E5', name: 'VN · GPIO39', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E7', name: 'GPIO34', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E9', name: 'GPIO35', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E11', name: 'GPIO32', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E13', name: 'GPIO33', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E15', name: 'GPIO25', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E17', name: 'GPIO26', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E19', name: 'GPIO27', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E21', name: 'GPIO14 · HSPI_CLK', protocol: 'spi', voltage: 3.3, direction: 'io' },
      { portId: 'E23', name: 'GPIO12 · HSPI_MISO', protocol: 'spi', voltage: 3.3, direction: 'io' },
      { portId: 'E25', name: 'GPIO13 · HSPI_MOSI', protocol: 'spi', voltage: 3.3, direction: 'io' },
      { portId: 'E27', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'E29', name: 'VIN', protocol: 'power', voltage: 5, direction: 'in' },
      // ── 右侧 ──
      { portId: 'E2', name: '3V3', protocol: 'power', voltage: 3.3, direction: 'power' },
      { portId: 'E4', name: 'GPIO23 · VSPI_MOSI', protocol: 'spi', voltage: 3.3, direction: 'io' },
      { portId: 'E6', name: 'GPIO22 · SCL', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'E8', name: 'TX0 · GPIO1', protocol: 'uart', voltage: 3.3, direction: 'out' },
      { portId: 'E10', name: 'RX0 · GPIO3', protocol: 'uart', voltage: 3.3, direction: 'in' },
      { portId: 'E12', name: 'GPIO21 · SDA', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'E14', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'E16', name: 'GPIO19 · VSPI_MISO', protocol: 'spi', voltage: 3.3, direction: 'io' },
      { portId: 'E18', name: 'GPIO18 · VSPI_CLK', protocol: 'spi', voltage: 3.3, direction: 'out' },
      { portId: 'E20', name: 'GPIO5 · VSPI_CS', protocol: 'spi', voltage: 3.3, direction: 'out' },
      { portId: 'E22', name: 'GPIO17', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E24', name: 'GPIO16', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E26', name: 'GPIO4', protocol: 'gpio', voltage: 3.3, direction: 'io' },
      { portId: 'E28', name: 'GPIO0 · BOOT', protocol: 'gpio', voltage: 3.3, direction: 'in' },
      { portId: 'E30', name: 'GPIO2', protocol: 'gpio', voltage: 3.3, direction: 'io' },
    ],
    /**
     * ★ **0 是刻意的，不是漏填。**
     *
     * 供电预算量的是「**从装配里取电**」。这台设备**没有任何总线端口** ⇒
     * 它在电气上就与装配无关，是自己插 USB / 电池供电的（座位上的真机就是这样）。
     *
     * ⚠️ 早先填了 0.5W，后果是**场景里单独放一台 ESP32 会失败**（`power_exceeded`：
     *   需求 0.5W > 预算 0W）。而正确的修法**不是**"再放个电源" ——
     *   你不会用面包板给一台墙上供电的 ESP32 供电。填 0 才是与"无端口"自洽的模型。
     */
    powerDrawW: 0,
    powerSupplyW: 0,
  },

  /**
   * Adafruit MPL3115A2 气压/高度传感器 —— **有真模型的 I2C 器件**。
   *
   * ★ 为什么加它：示例原来只有「树莓派（有真模型）+ BME280（无真模型 ⇒ 方块）」，
   *   看起来一半是方块。而 `docs/05` 已确认 **step.parts 没有裸芯片/常见传感器模块**，
   *   于是我去问了一个更该问的问题：**库里有哪些器件本身就是 I2C 的？**
   *   ⇒ Adafruit 家族里找到两件：**MPL3115A2（本条目，0x60）** 与 MPR121（触摸，0x5A）。
   *
   * ★ I2C 地址 0x60：MPL3115A2 数据手册的固定地址（不是猜的）。
   *
   * ⚠️ **端口位置是按 breakout 的常见形态给的近似值**（排针沿 -x 边、2.54mm 间距），
   *   **没有逐条核对 Adafruit 的装配图**。要用于真实接线前应核对原厂资料 ——
   *   这正是 `docs/05` 那条「几何可以导入，**端口语义必须自产**」的边界。
   */
  mpl3115a2: {
    key: 'mpl3115a2',
    label: 'MPL3115A2 气压/高度传感器（I2C 0x60）',
    size: MPL3115A2_SIZE,
    // ★ 逐针：真实 MPL3115A2 模块是 **5 针**（VIN/GND/SCL/SDA/INT）。同上，拆开 SDA/SCL。
    portLayout: { edge: '-x', pitch: PITCH_254, count: 5, inset: 0.0013, order: ['VCC', 'GND', 'SCL', 'SDA', 'INT'] },
    ports: [
      { portId: 'VCC', name: 'VIN', protocol: 'power', voltage: 3.3, direction: 'in' },
      { portId: 'GND', name: 'GND', protocol: 'power', voltage: 0, direction: 'ground' },
      { portId: 'SCL', name: 'SCL', protocol: 'i2c', voltage: 3.3, direction: 'in', shared: true },
      { portId: 'SDA', name: 'SDA', protocol: 'i2c', voltage: 3.3, direction: 'io', shared: true },
      { portId: 'INT', name: 'INT', protocol: 'gpio', voltage: 3.3, direction: 'out' },
    ],
    i2cAddress: 0x60,
    powerDrawW: 0.002,
    powerSupplyW: 0,
  },

  breadboard: {
    key: 'breadboard',
    label: '面包板（无源）',
    size: BREADBOARD_SIZE,
    ports: [],
    powerDrawW: 0,
    powerSupplyW: 0,
  },
}

/**
 * 预置型号表（**已解析**，端口位置全部落实）。
 *
 * ★ 解析在模块加载时**一次完成** ⇒ 运行时零开销，且规则错误会在加载时立刻暴露。
 */
export const HARDWARE_MODELS: Readonly<Record<string, HardwareModel>> = Object.freeze(
  Object.fromEntries(Object.entries(SOURCES).map(([key, source]) => [key, resolveModel(source)])),
)

/** 查型号。未知型号返回 undefined（调用方据此发 `unknown_hardware_model` 警告）。 */
export function findModel(key: string): HardwareModel | undefined {
  return HARDWARE_MODELS[key]
}

/** 全部预置型号键。 */
export function modelKeys(): string[] {
  return Object.keys(HARDWARE_MODELS)
}

/** 让组件「平放在地面」时应当使用的高度（y = 半厚）。见文件头的原点约定。 */
export function restingY(modelKey: string): number {
  const model = findModel(modelKey)
  return model ? model.size.y / 2 : 0
}

/**
 * 由型号实例化出一个组件。
 *
 * @param id - 组件唯一 id（调用方提供，保证可复现）
 * @param modelKey - 型号键
 * @param position - **包围盒中心**的世界坐标（米）
 */
export function instantiate(
  id: string,
  modelKey: string,
  position: Vec3,
  rotation: Vec3 = { x: 0, y: 0, z: 0 },
): import('./assembly.ts').ComponentSpec | undefined {
  const model = findModel(modelKey)
  if (!model) return undefined
  return {
    id,
    hardwareModel: model.key,
    label: model.label,
    position,
    rotation,
    // 深拷贝端口，避免实例之间共享可变对象（occupiedBy 是运行时状态）
    ports: model.ports.map((port) => ({ ...port, position: { ...port.position } })),
  }
}

/** 判断某型号是否提供该协议端口。 */
export function modelSupportsProtocol(model: HardwareModel, protocol: Protocol): boolean {
  return model.ports.some((port) => port.protocol === protocol)
}
