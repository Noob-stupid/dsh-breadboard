"""量出**真树莓派模型里那条排针的实际范围** —— 独立于 tools/_port_on_model.py 的第二把尺子。

★ 要回答的问题（射线探针答不了的那个）：
  「6 个端口的 x 跨度是 60mm，而真 40pin 排针只有 48.26mm」——
  **排针到底铺在哪个 x 区间？** 只有知道它，才能判断 3V3(x=+18) 是不是落在它外面。

★ 为什么"正下方命中了 PCB"推不出"端口不在排针上"：
  射线穿过**排针的引脚间隙**、或穿过**没被实体建模的排针本体**，一样会打到 PCB。
  ⇒ 要定位排针，**不能靠"射线打到什么"，要靠"高处有没有东西"**。

★ 做法（不用射线、不用特征识别）：
  1. 读全部 POSITION，平移到包围盒中心 → 归一化到 [-1, 1]（±1 = 板的两端）
  2. **只取"高处的顶点"**（y_norm > 阈值）—— 排针、USB、网口都在这一层，PCB 不在
  3. 再**只取端口所在的那条 z 边带** → 剩下的高处顶点就是那条边上的立起来的东西
  4. 按 x 分箱输出占用直方图 ⇒ **排针会显示为一段连续的长条**

归一化坐标 → 契约毫米：x_mm = x_norm × (size.x/2 × 1000) = x_norm × 42.5

用法：python spike/header-probe.py <model.bin>
"""
import json
import struct
import sys

PATH = sys.argv[1]
# 端口所在边带（z_norm）；端口实测 z = 23mm，板半宽 = 28mm ⇒ 0.821
Z_BAND = (0.65, 1.02)
# "高处"阈值（y_norm）：PCB 顶面约在 -0.647，排针顶约 +0.353
Y_HIGH = 0.10

with open(PATH, "rb") as handle:
    data = handle.read()
magic, _ver, _len = struct.unpack_from("<4sII", data, 0)
assert magic == b"glTF", f"{PATH}: 不是 GLB"

offset = 12
gltf = None
binary = b""
while offset < len(data):
    clen, ctype = struct.unpack_from("<II", data, offset)
    body = data[offset + 8 : offset + 8 + clen]
    if ctype == 0x4E4F534A:
        gltf = json.loads(body.decode("utf-8"))
    elif ctype == 0x004E4942:
        binary = body
    offset += 8 + clen + (-clen % 4)


def mat_identity():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mat_mul(a, b):
    out = [0.0] * 16
    for col in range(4):
        for row in range(4):
            out[col * 4 + row] = sum(a[k * 4 + row] * b[col * 4 + k] for k in range(4))
    return out


def mat_from_trs(node):
    if "matrix" in node:
        return list(node["matrix"])
    t = node.get("translation", [0, 0, 0])
    q = node.get("rotation", [0, 0, 0, 1])
    s = node.get("scale", [1, 1, 1])
    x, y, z, w = q
    rot = [
        1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w), 0,
        2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w), 0,
        2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y), 0,
        0, 0, 0, 1,
    ]
    for col in range(3):
        for row in range(3):
            rot[col * 4 + row] *= s[col]
    rot[12], rot[13], rot[14] = t
    return rot


def apply(m, x, y, z):
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def read_positions(accessor_index):
    """读一个 POSITION accessor 的浮点三元组（支持 byteStride）。"""
    acc = gltf["accessors"][accessor_index]
    assert acc["componentType"] == 5126 and acc["type"] == "VEC3", "只处理 float32 VEC3"
    view = gltf["bufferViews"][acc["bufferView"]]
    base = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    stride = view.get("byteStride") or 12
    out = []
    for i in range(acc["count"]):
        out.append(struct.unpack_from("<3f", binary, base + i * stride))
    return out


# ── 收集顶点（应用节点变换）──
raw = []
stack = [(n, mat_identity()) for n in gltf.get("scenes", [{}])[gltf.get("scene", 0)].get("nodes", [])]
nodes = gltf.get("nodes", [])
while stack:
    idx, parent = stack.pop()
    node = nodes[idx]
    world = mat_mul(parent, mat_from_trs(node))
    if "mesh" in node:
        for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
            attrs = prim.get("attributes", {})
            if "POSITION" not in attrs:
                continue
            for p in read_positions(attrs["POSITION"]):
                raw.append(apply(world, *p))
    for child in node.get("children", []):
        stack.append((child, world))

print(f"顶点总数 {len(raw)}")

lo = [min(v[a] for v in raw) for a in range(3)]
hi = [max(v[a] for v in raw) for a in range(3)]
size = [hi[a] - lo[a] for a in range(3)]
cen = [(hi[a] + lo[a]) / 2 for a in range(3)]
print(f"包围盒（模型单位）：x={size[0]:.2f} y={size[1]:.2f} z={size[2]:.2f}")
print(f"归一化到 [-1,1]；契约 mm = 归一化 × 42.5（x）\n")


def norm(v, a):
    return (v[a] - cen[a]) / (size[a] / 2)


high = [v for v in raw if norm(v, 1) > Y_HIGH]
print(f"高处顶点（y_norm > {Y_HIGH}，即 y > {Y_HIGH * 8.5:.2f}mm）：{len(high)}")
print("（排针若被实体建模，应当在这一层里；PCB 不在）\n")

# ── 2 维占用图：高处顶点都长在 (x, z) 的哪里 ──
NX, NZ = 34, 15
grid = [[0] * NX for _ in range(NZ)]
for v in high:
    ix = min(NX - 1, max(0, int((norm(v, 0) + 1) / 2 * NX)))
    iz = min(NZ - 1, max(0, int((norm(v, 2) + 1) / 2 * NZ)))
    grid[iz][ix] += 1

mx = max(max(row) for row in grid) or 1
CH = " .:-=+*#%@"
print("高处顶点在板面上的分布（行 = z，列 = x；越密越亮）")
print(f"{'z(mm)':>7} " + "".join(f"{int(-42.5 + (i + 0.5) * 85 / NX):>3}" for i in range(0, NX, 3)))
for iz in range(NZ):
    zmm = -28 + (iz + 0.5) * 56 / NZ
    row = "".join(CH[min(9, int(grid[iz][ix] / mx * 9.99))] for ix in range(NX))
    print(f"{zmm:7.1f} {row}")

# ── 端口所在的那条边带（z ≈ +23）到底有没有东西 ──
BINS = 43  # 每箱 2mm 契约宽度
print("各 z 边带上高处顶点的 x 分布（数字 = 顶点数；排针会显示为一段**连续密集**的长条）\n")
for label, band in (
    ("端口所在边带 z≈+23mm", (0.62, 1.0)),
    ("板中线 z≈0", (-0.10, 0.10)),
    ("对侧边带 z≈-23mm", (-1.0, -0.62)),
):
    sel = [v for v in high if band[0] <= norm(v, 2) <= band[1]]
    if not sel:
        print(f"{label}：高处顶点 0 个\n")
        continue
    counts = [0] * BINS
    for v in sel:
        counts[min(BINS - 1, max(0, int((norm(v, 0) + 1) / 2 * BINS)))] += 1
    xs = sorted(norm(v, 0) * 42.5 for v in sel)
    print(f"{label}：{len(sel)} 个顶点，x ∈ [{xs[0]:.1f}, {xs[-1]:.1f}] mm")
    print("   x(mm) " + "".join(f"{(int(-42.5 + (b + 0.5) * 85 / BINS)):>5}" for b in range(0, BINS, 2)))
    print("   顶点数" + "".join(f"{counts[b]:>5}" for b in range(0, BINS, 2)))
    print()

# 连续密集段：真正像"一条排针"的东西必须是**一串相邻非零**且总跨度 ~51mm
print("找「连续密集段」（≥15 个相邻箱都非零，即 ≥30mm 不间断）：")
for label, band in (("z≈+23", (0.62, 1.0)), ("z≈-23", (-1.0, -0.62)), ("z≈0", (-0.10, 0.10))):
    sel = [v for v in high if band[0] <= norm(v, 2) <= band[1]]
    counts = [0] * BINS
    for v in sel:
        counts[min(BINS - 1, max(0, int((norm(v, 0) + 1) / 2 * BINS)))] += 1
    runs = []
    start = None
    for b in range(BINS + 1):
        filled = b < BINS and counts[b] > 0
        if filled and start is None:
            start = b
        elif not filled and start is not None:
            runs.append((start, b - 1))
            start = None
    best = max(runs, key=lambda r: r[1] - r[0], default=None)
    if best and best[1] - best[0] >= 15:
        x0 = -42.5 + best[0] * 85 / BINS
        x1 = -42.5 + (best[1] + 1) * 85 / BINS
        print(f"  {label}: x ∈ [{x0:.1f}, {x1:.1f}] mm  跨度 {x1 - x0:.1f} mm   ← 候选排针位置")
    else:
        span = f"{best[1] - best[0] + 1} 箱" if best else "无"
        print(f"  {label}: 最长连续段 {span}（< 15 箱）⇒ **没有一条连续的细长结构**")

print("\n六个端口铺在：x ∈ [-30.0, +30.0] mm，跨度 60.0 mm；z = +23mm")
print("真 40pin 排针长度 = 19 × 2.54 = 48.26mm")


