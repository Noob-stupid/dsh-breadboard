"""★ 远端检查：端口锚点是不是**真的落在模型上**（#1 坐标系混用的收口检查）

═══════════════════════════════════════════════════════════════════════════
为什么需要它 —— "在盒内"是个**代理检查**，不是远端检查
═══════════════════════════════════════════════════════════════════════════

`tests/model-library.test.ts` 断言的是 `|position| ≤ size/2`（**端口在包围盒内**）。
而声明是「**端口位置正确**」。这两者之间的距离很具体：

  · 一个放在**错误角落**的端口，**一样在盒内** ⇒ 照样通过
  · corner-origin 的数落在 `[0, size]`，而盒子是 `±size/2`
    ⇒ **靠边的越出去、靠中间的照样通过**

⇒ 它抓的是「**这个错够不够大**」，不是「位置对不对」。
  同一类错误只要偏移小一点，测试全绿而端口仍然是错的。

**远端检查**：端口锚点**到模型三角面的距离**。
落在板上 ≈ 0；飘在空中则显著 > 0。**它不需要知道"正确位置在哪"，所以不循环依赖。**

⚠️ 用**到三角面**的距离，不是到顶点 —— CAD 的面很大，顶点距离是弱代理。
"""
import json
import struct
import sys
import urllib.request

import numpy as np

GLB = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\花火\.dsh\dsh-hardware-sandbox\models\rpi-4b\model.bin"
SNAPSHOT = "http://127.0.0.1:19387/@dsh-breadboard/dsh-hardware-sandbox/api/assembly"
COMPONENT_ID = sys.argv[2] if len(sys.argv) > 2 else "c1"


# ── GLB ────────────────────────────────────────────────────────────────────

def load_gltf(path):
    with open(path, "rb") as handle:
        data = handle.read()
    magic, _v, _l = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", magic
    json_len, json_type = struct.unpack_from("<II", data, 12)
    assert json_type == 0x4E4F534A
    gltf = json.loads(data[20 : 20 + json_len].decode("utf-8"))

    # 二进制块：accessor 的 bufferView 指向它
    offset = 20 + json_len
    bin_chunk = b""
    if offset < len(data):
        bin_len, bin_type = struct.unpack_from("<II", data, offset)
        if bin_type == 0x004E4942:
            bin_chunk = data[offset + 8 : offset + 8 + bin_len]
    return gltf, bin_chunk


def read_accessor(gltf, blob, index):
    accessor = gltf["accessors"][index]
    view = gltf["bufferViews"][accessor["bufferView"]]
    component_type = accessor["componentType"]
    dtype = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}[component_type]
    count = accessor["count"]
    kind = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[accessor["type"]]
    itemsize = np.dtype(dtype).itemsize * kind
    start = view.get("byteOffset", 0) + accessor.get("byteOffset", 0)
    stride = view.get("byteStride") or itemsize
    if stride == itemsize:
        flat = np.frombuffer(blob, dtype=dtype, count=count * kind, offset=start)
        return flat.reshape(count, kind)
    # 交错存储：逐条取
    out = np.empty((count, kind), dtype=dtype)
    for i in range(count):
        out[i] = np.frombuffer(blob, dtype=dtype, count=kind, offset=start + i * stride)
    return out


def trs_matrix(node):
    if "matrix" in node:
        return np.array(node["matrix"], dtype=float).reshape(4, 4).T
    matrix = np.eye(4)
    if "scale" in node:
        matrix = np.diag([*node["scale"], 1.0]) @ matrix
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        matrix = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                [0, 0, 0, 1],
            ]
        ) @ matrix
    if "translation" in node:
        move = np.eye(4)
        move[:3, 3] = node["translation"]
        matrix = move @ matrix
    return matrix


def all_triangles(gltf, blob):
    nodes = gltf.get("nodes", [])
    parents = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = index

    def world_matrix(index):
        chain = []
        cursor = index
        while cursor is not None:
            chain.append(cursor)
            cursor = parents.get(cursor)
        matrix = np.eye(4)
        for node_index in reversed(chain):
            matrix = matrix @ trs_matrix(nodes[node_index])
        return matrix

    chunks = []
    owners = []  # 每个三角形属于哪个 mesh（名字），用于回答"命中的是什么"
    for index, node in enumerate(nodes):
        if node.get("mesh") is None:
            continue
        matrix = world_matrix(index)
        mesh_index = node["mesh"]
        mesh_name = gltf["meshes"][mesh_index].get("name") or f"mesh#{mesh_index}"
        for prim in gltf["meshes"][mesh_index].get("primitives", []):
            attrs = prim.get("attributes", {})
            if "POSITION" not in attrs:
                continue
            points = read_accessor(gltf, blob, attrs["POSITION"]).astype(float)
            if "indices" in prim:
                idx = read_accessor(gltf, blob, prim["indices"]).reshape(-1).astype(int)
                faces = points[idx].reshape(-1, 3, 3)
            else:
                faces = points.reshape(-1, 3, 3)
            if faces.size == 0:
                continue
            flat = faces.reshape(-1, 3)
            world = (matrix @ np.hstack([flat, np.ones((len(flat), 1))]).T).T[:, :3]
            chunks.append(world.reshape(-1, 3, 3))
            owners.extend([mesh_name] * len(faces))
    if not chunks:
        return np.zeros((0, 3, 3)), []
    return np.concatenate(chunks, axis=0), owners


# ── 点到三角面的距离（Ericson, Real-Time Collision Detection） ──────────────

def closest_on_triangles(point, tris):
    """返回每个三角形上离 `point` 最近的点（Ericson 的分区算法，向量化）。

    ★ 必须**完整实现分区**：只算面内投影的话，点落在边/顶点区域时会得到
      一个"看着很近"的错点（实测：距离 11.4mm 却报出 0.9mm 的偏移 —— 自相矛盾）。
      距离与最近点必须来自**同一套分区判断**，否则诊断会把人带偏。
    """
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    ab, ac = b - a, c - a
    ap = point - a
    d1, d2 = (ab * ap).sum(1), (ac * ap).sum(1)
    bp = point - b
    d3, d4 = (ab * bp).sum(1), (ac * bp).sum(1)
    cp = point - c
    d5, d6 = (ab * cp).sum(1), (ac * cp).sum(1)
    vc, vb, va = d1 * d4 - d3 * d2, d5 * d2 - d1 * d6, d3 * d6 - d5 * d4

    closest = np.empty_like(a)
    denom = va + vb + vc
    safe = np.abs(denom) > 1e-20
    v = np.where(safe, vb / np.where(safe, denom, 1.0), 0.0)
    w = np.where(safe, vc / np.where(safe, denom, 1.0), 0.0)
    closest[:] = a + ab * v[:, None] + ac * w[:, None]          # 面内

    m = (d1 <= 0) & (d2 <= 0)
    closest[m] = a[m]                                            # 顶点 A
    m = (d3 >= 0) & (d4 <= d3)
    closest[m] = b[m]                                            # 顶点 B
    m = (vc <= 0) & (d1 >= 0) & (d3 <= 0)
    den = d1 - d3
    t = np.where(np.abs(den) > 1e-20, d1 / np.where(np.abs(den) > 1e-20, den, 1.0), 0.0)
    closest[m] = a[m] + ab[m] * t[m][:, None]                    # 边 AB
    m = (d6 >= 0) & (d5 <= d6)
    closest[m] = c[m]                                            # 顶点 C
    m = (vb <= 0) & (d2 >= 0) & (d6 <= 0)
    den = d2 - d6
    t = np.where(np.abs(den) > 1e-20, d2 / np.where(np.abs(den) > 1e-20, den, 1.0), 0.0)
    closest[m] = a[m] + ac[m] * t[m][:, None]                    # 边 AC
    m = (va <= 0) & ((d4 - d3) >= 0) & ((d5 - d6) >= 0)
    den = (d4 - d3) + (d5 - d6)
    t = np.where(np.abs(den) > 1e-20, (d4 - d3) / np.where(np.abs(den) > 1e-20, den, 1.0), 0.0)
    closest[m] = b[m] + (c[m] - b[m]) * t[m][:, None]            # 边 BC

    return closest


# ── 主流程 ─────────────────────────────────────────────────────────────────

gltf, blob = load_gltf(GLB)
tris, owners = all_triangles(gltf, blob)
print(f"模型三角面数 = {len(tris):,}")

low = tris.reshape(-1, 3).min(0)
high = tris.reshape(-1, 3).max(0)
model_size = high - low
print(f"模型包围盒 = {np.round(model_size, 3)}  (模型单位)")

# 归一化到契约坐标系：原点移到包围盒中心，再逐轴缩放到契约 size
CONTRACT = np.array([0.085, 0.017, 0.056])  # 米（rpi-4b：x=长 y=厚 z=宽）
center = (low + high) / 2
scale = CONTRACT / model_size
normalized = (tris - center) * scale
print(f"归一化后包围盒 = {np.round(normalized.reshape(-1,3).max(0) - normalized.reshape(-1,3).min(0), 5)}  (米)")

# 取真实端口位置（场景正在用的那一份，不是我手抄的）
with urllib.request.urlopen(SNAPSHOT, timeout=10) as response:
    snapshot = json.loads(response.read().decode("utf-8"))
component = next((c for c in snapshot["components"] if c["id"] == COMPONENT_ID), None)
assert component is not None, f"快照里没有 {COMPONENT_ID}"
print(f"\n组件 {COMPONENT_ID} [{component['hardwareModel']}] 的端口锚点 → 到模型表面的距离：\n")

def downward_hit(point, tris):
    """从端口**竖直向下**打一条射线，返回命中的最高点高度（没命中则 None）。

    ★★ 为什么这一列才是**决定性**的（由并行会话的方法论批评逼出来）：
       "到最近面的距离大" **只能推出**"附近没有面"，**推不出**"平面位置错了" ——
       因为一个**正确地贴在 8.5mm 高排针顶端**的端口，到最近面的距离也可能是 8.5mm 量级
       （如果那个排针恰好没被建模，或最近的面是别处）。

       ⇒ **"浮在板面上方 9mm" 与 "正确地贴在排针顶端" 是两个不同的命题，
         而"距离"这一个标量分不开它们。** 这正是本项目那个族：
         **近端量（到最近面的距离）被当成了远端结论（位置对不对）。**

       **竖直射线**分得开：
         · **命中** ⇒ 端口 x/z 的**正下方有东西** ⇒ 平面位置是对的，只有高度是取舍
         · **不命中** ⇒ 端口**悬在空隙上方** ⇒ **平面位置真的错了**

       这与"偏移向量的方向"是同一个判据的更严格版本：方向只是**提示最近的面在哪**，
       射线才是**回答"正下方有没有东西"**。
    """
    origin = point
    direction = np.array([0.0, -1.0, 0.0])
    a, b, c = tris[:, 0], tris[:, 1], tris[:, 2]
    edge1, edge2 = b - a, c - a
    h = np.cross(direction, edge2)
    det = (edge1 * h).sum(1)
    ok = np.abs(det) > 1e-12
    inv = np.where(ok, 1.0 / np.where(ok, det, 1.0), 0.0)
    s = origin - a
    u = (s * h).sum(1) * inv
    q = np.cross(s, edge1)
    v = (direction * q).sum(1) * inv
    t = (edge2 * q).sum(1) * inv
    hit = ok & (u >= 0) & (u <= 1) & (v >= 0) & (u + v <= 1) & (t > 1e-9)
    if not hit.any():
        return None
    # 返回命中的**最高**那片，连同它的三角形下标（好查出是哪个 mesh）
    heights = origin[1] - t
    masked = np.where(hit, heights, -np.inf)
    best = int(np.argmax(masked))
    return float(heights[best]), best


print(f"  {'端口':<8} {'坐标（米）':<34} {'距离':>10}   偏移向量                    正下方              命中的 mesh")
print("  " + "─" * 104)
for port in component["ports"]:
    point = np.array([port["position"]["x"], port["position"]["y"], port["position"]["z"]])
    closest_all = closest_on_triangles(point, normalized)
    offsets = np.linalg.norm(closest_all - point, axis=1)
    nearest = int(np.argmin(offsets))
    distance = offsets[nearest]
    mm = distance * 1000
    delta = (closest_all[nearest] - point) * 1000

    hit = downward_hit(point, normalized)
    if hit is None:
        column = "❌ 悬空（正下方没有东西）"
        who = "—"
    else:
        height, tri_index = hit
        column = f"✅ @ {height * 1000:+.1f}mm（低 {mm:.1f}mm）"
        # ★ "命中"不等于"命中排针" —— 必须报出**命中的是哪个 mesh**，
        #   否则又会把"正下方有东西"当成"正下方是那个连接器"。
        who = owners[tri_index] if tri_index < len(owners) else "?"

    coords = f"({point[0]:+.4f}, {point[1]:+.4f}, {point[2]:+.4f})"
    offset = f"Δ=({delta[0]:+6.1f}, {delta[1]:+6.1f}, {delta[2]:+6.1f}) mm"
    print(f"  {port['portId']:<8} {coords:<34} {mm:>7.3f} mm   {offset}  {column}  {who}")

print("\n（判据：到**三角面**的距离。落在板上 ≈ 0；飘在空中显著 > 0。）")

# ── ★ 独立复核：把端口沿 z **镜像**一遍再打射线 ─────────────────────────────
#
# ★ 为什么要做这一步（由并行会话提出，方法是**独立的**：顶点分箱而非射线）：
#   他们发现 40pin 排针在 **z ≈ −23mm**，而我们的端口铺在 **z = +23mm** —— **整条边反了**。
#   而"正下方命中什么"**答不了**"排针在哪"：射线可能穿过引脚间隙、或穿过**没有实体建模**的
#   本体，一样打到 PCB。⇒ **两个方法必须都同意，才动手改。**
#
#   这一步是**同一把尺子、不同的位置**：如果 z=−23 处命中的高度**普遍比 +23 处高**，
#   那就与"排针在对侧"一致；如果两边一样，那他们的结论在这把尺子上得不到支持。
print("\n" + "═" * 104)
print("★ 决定性测量：**高处的几何到底在哪**（不猜、不问射线，直接看顶点分布）")
print("═" * 104)
# ★ 为什么必须做这一步：射线只回答"我给的那条线上有没有东西"，
#   它**答不了**"那条细长的排针在哪" —— 射线可以穿过引脚间隙、也可以穿过没建模的本体。
#   而"排针在哪"是个**分布**问题 ⇒ 就该用分布来答。
#
#   做法：取所有 y 高于阈值的顶点（排针/USB/网口在这一层，PCB 不在），按 (x, z) 分箱，
#   看**哪条 z 上有连续且均匀的一长条**。
TALL_Y = 0.002  # 2mm：高于 PCB 顶，低于排针顶
flat = normalized.reshape(-1, 3)
tall = flat[flat[:, 1] > TALL_Y]
print(f"高于 +{TALL_Y * 1000:.0f}mm 的顶点数 = {len(tall):,} / {len(flat):,}")

# 按 z 分箱，看高处几何集中在哪几条 z 上
z_bins = np.round(tall[:, 2] * 1000).astype(int)  # 毫米
unique, counts = np.unique(z_bins, return_counts=True)
top = np.argsort(counts)[::-1][:8]
print("\n高处顶点最多的 8 条 z：")
for i in sorted(top, key=lambda k: -counts[k]):
    print(f"   z = {unique[i]:+4d}mm   顶点 {counts[i]:,}")

# ★ 专看**我们端口所在的那两条 z**（±23mm）—— 这才是要回答的问题，
#   而不是"全局哪条 z 最高处顶点最多"（那可能只是 USB/网口那一坨）。
for z_mm in (+23, -23):
    band = tall[np.abs(tall[:, 2] * 1000 - z_mm) < 1.5]
    if len(band) == 0:
        print(f"\n   z ≈ {z_mm:+d}mm：**没有任何高于 +{TALL_Y * 1000:.0f}mm 的几何**")
        continue
    xs = band[:, 0] * 1000
    x_bins = np.round(xs).astype(int)
    xu, xc = np.unique(x_bins, return_counts=True)
    span = int(xu.max() - xu.min())
    gaps = span - len(xu) + 1
    density = float(xc.std() / max(xc.mean(), 1e-9))
    print(
        f"\n   z ≈ {z_mm:+d}mm：高处顶点 {len(band):,}   x ∈ [{xu.min():+d}, {xu.max():+d}]mm  "
        f"跨度 {span}mm  非空箱 {len(xu)}/{span + 1}  空缺 {gaps}  密度变异 {density:.2f}"
    )
    # 端口 x 附近到底有没有高处的东西？
    for x_mm in (-22.5, -13.5, -4.5, 4.5, 13.5, 22.5):
        near = band[np.abs(band[:, 0] * 1000 - x_mm) < 2.0]
        mark = "有" if len(near) > 0 else "**无**"
        print(f"        x ≈ {x_mm:+6.1f}mm ±2mm：高处顶点 {len(near):>5}  {mark}")

# ★★ 射线必须从**固定的高处**出发，不能从端口自己的 y 出发 —— 这是本工具踩过的一个坑：
#   端口 y 修到 +1.6mm（排针顶）之后，从端口出发的射线**只能看见 +1.6mm 以下的东西**，
#   而排针顶在它**上面** ⇒ 一律只打到 PCB ⇒ 两侧看起来"同高"。
#   **那不是"对侧没有排针"的证据，是这把尺子够不着。**
#   问"高处有没有东西"就必须**从高处问**。
PROBE_Y = 0.0085  # 8.5mm，包络顶面附近；高于排针顶（约 +3mm）与 PCB
print(f"  （射线起点固定在 y = +{PROBE_Y * 1000:.1f}mm —— 必须高于被测物，否则扫不到它）")
print(f"  {'端口':<8} {'z=+23（当前）':<26} {'z=-23（对侧）':<26} 判读")
print("  " + "─" * 96)
higher_on_minus = 0
for port in component["ports"]:
    x, z = port["position"]["x"], port["position"]["z"]
    here = downward_hit(np.array([x, PROBE_Y, z]), normalized)
    there = downward_hit(np.array([x, PROBE_Y, -z]), normalized)

    def show(hit):
        if hit is None:
            return "❌ 没有东西"
        return f"{hit[0] * 1000:+.1f}mm"

    verdict = ""
    if here is None and there is not None:
        higher_on_minus += 1
        verdict = "★ 对侧才有东西"
    elif here is not None and there is None:
        verdict = "当前侧才有东西"
    elif here is not None and there is not None:
        if there[0] - here[0] > 0.002:
            higher_on_minus += 1
            verdict = "★ 对侧更高"
        elif here[0] - there[0] > 0.002:
            verdict = "当前侧更高"
        else:
            verdict = "两侧同高"
    print(f"  {port['portId']:<8} {show(here):<26} {show(there):<26} {verdict}")

print(f"\n⇒ {higher_on_minus}/{len(component['ports'])} 个端口在**对侧（z<0）**更高或有东西。")
if higher_on_minus >= len(component["ports"]) - 1:
    print("   ★ 与并行会话的顶点分箱结论**一致**：排针在对侧 ⇒ 端口应铺在 z < 0 那条边。")
else:
    print("   ⚠️ 与顶点分箱结论**不一致** ⇒ 先别改，两个方法要先对齐。")
print("★ Δ 是「最近的模型表面 减去 端口位置」：它告诉我们端口**往哪个方向偏了**。")
print("  · 若 |Δy| 独大 ⇒ 高度不对（端口悬在板子上方）")
print("  · 若 |Δx| / |Δz| 大 ⇒ 平面位置不对（端口不在那个连接器上方）")
