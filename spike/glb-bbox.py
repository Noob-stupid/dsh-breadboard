"""GLB 包围盒（**应用节点变换**版）—— 用来独立复核 tools/_glb_bbox.py 的结论。

★ 为什么需要它：`_glb_bbox.py` 直接读 `accessors[POSITION].min/max`，那是**网格局部**坐标。
  glTF 允许节点带 `matrix` / TRS。**"Y-up → Z-up" 的坐标修正通常就烘焙在节点里** ——
  一旦如此，局部包围盒和模型真实包围盒是**两回事**，而两者都不会报错。
  （这正是本项目的失败族：量到的是近端，报出来的是远端结论。）

★ 本脚本同时打印两套数字，好让差异自己现形。
用法：python spike/glb-bbox.py <model.bin> [更多...]
"""
import json
import struct
import sys


def load_glb(path):
    with open(path, "rb") as handle:
        data = handle.read()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", f"{path}: 不是 GLB"
    offset = 12
    gltf = None
    binary = b""
    while offset < len(data):
        chunk_len, chunk_type = struct.unpack_from("<II", data, offset)
        body = data[offset + 8 : offset + 8 + chunk_len]
        if chunk_type == 0x4E4F534A:
            gltf = json.loads(body.decode("utf-8"))
        elif chunk_type == 0x004E4942:
            binary = body
        offset += 8 + chunk_len + (-chunk_len % 4)
    return gltf, binary


def mat_identity():
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def mat_mul(a, b):
    """列主序 4x4：返回 a·b（先应用 b 再应用 a）。"""
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


def apply(m, p):
    x, y, z = p
    return (
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
    )


def report(path):
    gltf, _binary = load_glb(path)
    print(f"\n{'=' * 72}\n{path}")

    # ── 节点树：看有没有非单位变换（这是 _glb_bbox.py 看不见的东西）──
    nodes = gltf.get("nodes", [])
    interesting = []
    for i, node in enumerate(nodes):
        m = mat_from_trs(node)
        if any(abs(m[k] - mat_identity()[k]) > 1e-9 for k in range(16)):
            interesting.append((i, node.get("name", "?"), m))
    print(f"节点总数 {len(nodes)}；带**非单位变换**的 {len(interesting)} 个")
    for i, name, m in interesting[:8]:
        rot = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]]
        is_axis_perm = all(abs(abs(v) - 1) < 1e-6 or abs(v) < 1e-6 for v in rot)
        print(f"  node[{i}] {name!r}  旋转部分 {'（轴对齐置换！）' if is_axis_perm else ''}")
        print(f"      [{rot[0]:7.3f} {rot[1]:7.3f} {rot[2]:7.3f}]")
        print(f"      [{rot[3]:7.3f} {rot[4]:7.3f} {rot[5]:7.3f}]")
        print(f"      [{rot[6]:7.3f} {rot[7]:7.3f} {rot[8]:7.3f}]")

    # ── ① 朴素：只看 accessor min/max（= _glb_bbox.py 的做法）──
    naive_min = [float("inf")] * 3
    naive_max = [float("-inf")] * 3
    for mesh in gltf.get("meshes", []):
        for prim in mesh.get("primitives", []):
            acc = gltf["accessors"][prim.get("attributes", {}).get("POSITION", -1)] if "POSITION" in prim.get("attributes", {}) else None
            if acc is None or "min" not in acc:
                continue
            for axis in range(3):
                naive_min[axis] = min(naive_min[axis], acc["min"][axis])
                naive_max[axis] = max(naive_max[axis], acc["max"][axis])

    # ── ② 正确：走节点树，把 8 个角点变换到模型空间 ──
    lo = [float("inf")] * 3
    hi = [float("-inf")] * 3
    stack = []
    scene = gltf.get("scenes", [{}])[gltf.get("scene", 0)]
    for root in scene.get("nodes", []):
        stack.append((root, mat_identity()))
    while stack:
        idx, parent = stack.pop()
        node = nodes[idx]
        world = mat_mul(parent, mat_from_trs(node))
        if "mesh" in node:
            for prim in gltf["meshes"][node["mesh"]].get("primitives", []):
                attrs = prim.get("attributes", {})
                if "POSITION" not in attrs:
                    continue
                acc = gltf["accessors"][attrs["POSITION"]]
                if "min" not in acc:
                    continue
                for corner in range(8):
                    p = [acc["min"][a] if corner >> a & 1 else acc["max"][a] for a in range(3)]
                    w = apply(world, p)
                    for a in range(3):
                        lo[a] = min(lo[a], w[a])
                        hi[a] = max(hi[a], w[a])
        for child in node.get("children", []):
            stack.append((child, world))

    def show(title, mins, maxs):
        if mins[0] == float("inf"):
            print(f"\n  {title}: （无 POSITION accessor）")
            return None
        size = [maxs[a] - mins[a] for a in range(3)]
        order = sorted(range(3), key=lambda i: size[i], reverse=True)
        names = "xyz"
        flag = "OK x>z>y" if (order[0] == 0 and order[2] == 1) else "!! 非 x>z>y"
        print(f"\n  {title}")
        print(f"    x={size[0]:9.3f}  y={size[1]:9.3f}  z={size[2]:9.3f}   (模型单位)")
        print(f"    轴向（长->短）：{names[order[0]]} > {names[order[1]]} > {names[order[2]]}   {flag}")
        return size

    a = show("(1) 朴素：网格局部（_glb_bbox.py 的做法）", naive_min, naive_max)
    b = show("(2) 正确：应用节点变换（模型空间）", lo, hi)

    if a and b:
        sa, sb = sorted(a), sorted(b)
        same = all(abs(sa[i] - sb[i]) < 0.01 for i in range(3))
        print(
            f"\n  => 两者{'一致 —— 本模型没有节点变换，朴素法碰巧对' if same else '**不一致** —— 朴素法量错了，基于它的结论不可用'}"
        )


for arg in sys.argv[1:]:
    report(arg)
