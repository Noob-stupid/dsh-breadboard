"""解析 GLB 的包围盒，检查朝向与契约 size 是否一致。

★★ 为什么必须**应用节点变换**（这是本工具第一版的盲区，由并行会话指出）：
   第一版只读 `accessors[POSITION].min/max` —— 那是**网格局部**坐标，
   **不含节点变换**。而 glTF 导出器常把 "Y-up → Z-up" 之类的修正是**烘焙在节点里**的
   （尤其 CAD 系工具）。⇒ 只看 accessor 会对那些模型给出**自信的错误答案**，
   而"验证工具给出自信的错误答案"比没有工具更糟。

   实测：本项目的三个模型恰好都**没有**节点变换，所以第一版的数字是对的 ——
   但盲区是真的，下一个来自别的导出器的模型就会咬。

★ 另外：本工具**不做朝向归一化**，只如实报告"源模型长什么样"。
  归一化规则见 `src/contracts/library.ts` 的 `ModelOrientation`
  （⚠️ 只能产出 det=+1 的旋转，**不能做轴置换** —— 那会产生镜像而包围盒看不出来）。
"""
import json
import math
import struct
import sys

import numpy as np

PATH = sys.argv[1] if len(sys.argv) > 1 else r"C:\Users\花火\.dsh\dsh-hardware-sandbox\models\rpi-4b\model.bin"


def load_gltf(path: str) -> dict:
    with open(path, "rb") as handle:
        data = handle.read()
    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", f"不是 GLB：{magic!r}"
    chunk_len, chunk_type = struct.unpack_from("<II", data, 12)
    assert chunk_type == 0x4E4F534A, "第一个 chunk 不是 JSON"
    return json.loads(data[20 : 20 + chunk_len].decode("utf-8"))


def trs_to_matrix(node: dict) -> np.ndarray:
    """节点局部矩阵：优先 `matrix`，否则由 TRS 合成。"""
    if "matrix" in node:
        # glTF 的 matrix 是**列主序**的 16 个数
        return np.array(node["matrix"], dtype=float).reshape(4, 4).T

    matrix = np.eye(4)
    if "scale" in node:
        matrix = np.diag([*node["scale"], 1.0]) @ matrix
    if "rotation" in node:
        x, y, z, w = node["rotation"]
        rotation = np.array(
            [
                [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0],
                [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0],
                [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0],
                [0, 0, 0, 1],
            ],
            dtype=float,
        )
        matrix = rotation @ matrix
    if "translation" in node:
        translation = np.eye(4)
        translation[:3, 3] = node["translation"]
        matrix = translation @ matrix
    return matrix


def world_bounds(gltf: dict) -> tuple[np.ndarray, np.ndarray, int, int]:
    """遍历节点树，把每个 mesh 的局部包围盒变换到世界坐标后求并。"""
    nodes = gltf.get("nodes", [])
    parents: dict[int, int] = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            parents[child] = index

    def world_matrix(index: int) -> np.ndarray:
        chain = []
        cursor: int | None = index
        while cursor is not None:
            chain.append(cursor)
            cursor = parents.get(cursor)
        matrix = np.eye(4)
        for node_index in reversed(chain):
            matrix = matrix @ trs_to_matrix(nodes[node_index])
        return matrix

    low = np.full(3, np.inf)
    high = np.full(3, -np.inf)
    transformed = 0
    meshes_seen = 0

    for index, node in enumerate(nodes):
        mesh_index = node.get("mesh")
        if mesh_index is None:
            continue
        meshes_seen += 1
        matrix = world_matrix(index)
        if not np.allclose(matrix, np.eye(4), atol=1e-9):
            transformed += 1
        for prim in gltf["meshes"][mesh_index].get("primitives", []):
            accessor_index = prim.get("attributes", {}).get("POSITION")
            if accessor_index is None:
                continue
            accessor = gltf["accessors"][accessor_index]
            if "min" not in accessor or "max" not in accessor:
                continue
            lo = np.array(accessor["min"], dtype=float)
            hi = np.array(accessor["max"], dtype=float)
            # 变换 8 个角点后重新求包围盒（旋转后不能只变换 min/max 两个点）
            for mask in range(8):
                # ★ 每个分量都要取**标量**：`hi if … else lo` 拿到的是整条向量，
                #   拼起来会变成 (3,3) 而不是长度 3 的角点。
                corner = np.array(
                    [hi[axis] if (mask >> axis) & 1 else lo[axis] for axis in range(3)],
                    dtype=float,
                )
                world = (matrix @ np.append(corner, 1.0))[:3]
                low = np.minimum(low, world)
                high = np.maximum(high, world)

    return low, high, meshes_seen, transformed


gltf = load_gltf(PATH)
low, high, meshes_seen, transformed = world_bounds(gltf)
size = high - low

print(f"文件：{PATH}")
print(f"mesh 数 = {meshes_seen}，其中带非单位节点变换的 = {transformed}")
if transformed == 0:
    print("  （本模型没有节点变换 —— 此时只读 accessor 也会得到同样的数字）")
else:
    print("  ★ 有节点变换！只读 accessor 的版本会给出**错误的**包围盒。")

print("\n世界坐标包围盒（模型单位）：")
for axis, name in enumerate("xyz"):
    print(f"  {name} = {size[axis]:8.3f}   min={low[axis]:8.3f} max={high[axis]:8.3f}")

contract = [0.085, 0.017, 0.056]
print(f"\n契约 size（米）：x=0.085(长)  y=0.017(厚)  z=0.056(宽)")

order = sorted(range(3), key=lambda i: size[i], reverse=True)
names = "xyz"
print(f"\n模型轴向排序（长→短）：{names[order[0]]} > {names[order[1]]} > {names[order[2]]}")
print("契约要求：           x > z > y   （长 > 宽 > 厚）")
fits = order[0] == 0 and order[2] == 1
print(f"判定：{'✅ 一致（identity）' if fits else '⚠️ 不一致 —— 需要一次朝向归一化'}")

# ★★ det 要算的是「**映到契约**」那个置换的行列式，不是"尺寸排序"本身。
#   契约：x ← 最长轴、y ← 最薄轴、z ← 剩下那条。
#   若按这个映射**做轴置换**，det = −1 就意味着**镜像**（模型翻转、包围盒不变）。
longest, middle, thinnest = order[0], order[1], order[2]
mapping = [longest, thinnest, middle]  # 契约的 x / y / z 分别取自源模型的哪条轴
det = 1
for i in range(3):
    for j in range(i + 1, 3):
        if mapping[i] > mapping[j]:
            det = -det
naive = "identity（无需归一化）" if mapping == [0, 1, 2] else f"轴置换 {mapping}"
print(f"\n映到契约的映射：{naive}")
print(f"  若按**轴置换**实现，det = {det:+d}  " + ("（旋转 ✓）" if det > 0 else "（★ 反射 ✗ —— 会镜像模型，而包围盒一模一样）"))
if det < 0:
    print("  ⇒ 必须改用「定 up → 定 length → 第三轴由 det=+1 反解」的**旋转**实现，不要做置换。")

print("\n逐轴比例（模型 → 契约，仅在 identity 时有意义）：")
ratios = []
for axis in range(3):
    if size[axis]:
        scale = contract[axis] / size[axis]
        ratios.append(scale)
        print(f"  {names[axis]}: {size[axis]:8.3f} → {contract[axis]:.3f}   ×{scale:.5f}")
if ratios:
    print(f"\n最大/最小缩放比 = {max(ratios) / min(ratios):.3f}  （>1.15 应触发可见告警）")
