"""按**真实尺寸**生成智座硬件的 GLB 模型（ESP32 DevKit V1 + HC-SR501 PIR）。

═══════════════════════════════════════════════════════════════════════════
为什么是"生成"而不是"下载"
═══════════════════════════════════════════════════════════════════════════

`step.parts` 上搜遍了：**PIR / HC-SR501 / motion sensor 全部 0 结果**，
ESP32 只有 `ESP32-WROOM-32` 这类**裸模块**，**没有 30 针开发板**。
而同项目的 `docs/05` 早已查明：那个库只有"开发板 + 机械件 + PCB 封装"，
**分立元件与通用模块不在覆盖范围内**。

⇒ 智座真正用的就是这两样，**得按真实尺寸自己建**。

⚠️ 这不是"真模型"，是**按真机尺寸与外形特征建的几何**。区别要说清楚：
   · **可信的**：外形轮廓、关键尺寸、引脚位置、可辨认的特征（屏蔽罩、菲涅尔罩、USB 口）
   · **不可信的**：丝印、颜色细节、内部结构
   ⇒ 用它做**接线教学与占位**是够的；**不能用它做机械干涉检查**。

★ 生成 GLB 而不是 OBJ：`importer.ts` 的 `parseAndNormalize` 用的是 **`GLTFLoader`** ——
  **只认 glTF/GLB**。喂 OBJ 进去会走 `catch { return null }` ⇒ **静默退回占位盒**。
"""

from __future__ import annotations

import json
import struct
from typing import Iterable

import numpy as np

OUT_DIR = r"C:\Users\花火\.dsh\dsh-hardware-sandbox\models"


# ── 几何基元（返回 顶点/法线/索引）─────────────────────────────────────────

class Mesh:
    """累积三角面。位置单位**米**，坐标系与契约一致（x=长, y=厚/高, z=宽）。"""

    def __init__(self) -> None:
        self.positions: list[list[float]] = []
        self.normals: list[list[float]] = []
        self.indices: list[int] = []

    def add_box(self, center, size) -> None:
        cx, cy, cz = center
        sx, sy, sz = (s / 2 for s in size)
        # 6 个面，每个面 4 顶点 + 2 三角
        faces = [
            ((0, 0, 1), [(-sx, -sy, sz), (sx, -sy, sz), (sx, sy, sz), (-sx, sy, sz)]),
            ((0, 0, -1), [(sx, -sy, -sz), (-sx, -sy, -sz), (-sx, sy, -sz), (sx, sy, -sz)]),
            ((1, 0, 0), [(sx, -sy, sz), (sx, -sy, -sz), (sx, sy, -sz), (sx, sy, sz)]),
            ((-1, 0, 0), [(-sx, -sy, -sz), (-sx, -sy, sz), (-sx, sy, sz), (-sx, sy, -sz)]),
            ((0, 1, 0), [(-sx, sy, sz), (sx, sy, sz), (sx, sy, -sz), (-sx, sy, -sz)]),
            ((0, -1, 0), [(-sx, -sy, -sz), (sx, -sy, -sz), (sx, -sy, sz), (-sx, -sy, sz)]),
        ]
        for normal, corners in faces:
            base = len(self.positions)
            for corner in corners:
                self.positions.append([cx + corner[0], cy + corner[1], cz + corner[2]])
                self.normals.append(list(normal))
            self.indices += [base, base + 1, base + 2, base, base + 2, base + 3]

    def add_cylinder(self, center, radius, height, segments=24, axis="y") -> None:
        """沿 `axis` 的圆柱（用于**排针**与**引脚**）。"""
        cx, cy, cz = center
        half = height / 2
        rings = []
        for sign in (-half, half):
            ring = []
            for i in range(segments):
                a = 2 * np.pi * i / segments
                u, v = radius * np.cos(a), radius * np.sin(a)
                if axis == "y":
                    ring.append((cx + u, cy + sign, cz + v))
                elif axis == "x":
                    ring.append((cx + sign, cy + u, cz + v))
                else:
                    ring.append((cx + u, cy + v, cz + sign))
            rings.append(ring)
        low, high = rings
        # 侧面
        for i in range(segments):
            j = (i + 1) % segments
            base = len(self.positions)
            for point in (low[i], low[j], high[j], high[i]):
                self.positions.append(list(point))
                n = np.array(point) - np.array(center)
                n[0 if axis == "x" else 1 if axis == "y" else 2] = 0
                norm = np.linalg.norm(n)
                self.normals.append(list(n / norm) if norm > 1e-9 else [0, 1, 0])
            self.indices += [base, base + 1, base + 2, base, base + 2, base + 3]
        # 两端盖（用中心点扇形，够用）
        for sign, ring in ((-half, low), (half, high)):
            center_point = list(center)
            if axis == "y":
                center_point[1] = cy + sign
            elif axis == "x":
                center_point[0] = cx + sign
            else:
                center_point[2] = cz + sign
            c_index = len(self.positions)
            self.positions.append(center_point)
            self.normals.append([0, 1, 0] if axis == "y" else ([1, 0, 0] if axis == "x" else [0, 0, 1]))
            first = len(self.positions)
            for point in ring:
                self.positions.append(list(point))
                self.normals.append([0, 1, 0] if axis == "y" else ([1, 0, 0] if axis == "x" else [0, 0, 1]))
            for i in range(segments):
                j = (i + 1) % segments
                if sign > 0:
                    self.indices += [c_index, first + i, first + j]
                else:
                    self.indices += [c_index, first + j, first + i]

    def add_hemisphere(self, center, radius, segments=32, rings=12) -> None:
        """上半球（HC-SR501 的**菲涅尔透镜罩**就是这个形状）。"""
        cx, cy, cz = center
        grid = []
        for r in range(rings + 1):
            phi = (np.pi / 2) * r / rings  # 0=顶, pi/2=赤道
            row = []
            for s in range(segments):
                theta = 2 * np.pi * s / segments
                x = radius * np.sin(phi) * np.cos(theta)
                y = radius * np.cos(phi)
                z = radius * np.sin(phi) * np.sin(theta)
                row.append((cx + x, cy + y, cz + z))
            grid.append(row)
        for r in range(rings):
            for s in range(segments):
                s2 = (s + 1) % segments
                quad = (grid[r][s], grid[r][s2], grid[r + 1][s2], grid[r + 1][s])
                base = len(self.positions)
                for point in quad:
                    self.positions.append(list(point))
                    n = np.array(point) - np.array(center)
                    norm = np.linalg.norm(n)
                    self.normals.append(list(n / norm) if norm > 1e-9 else [0, 1, 0])
                self.indices += [base, base + 1, base + 2, base, base + 2, base + 3]


# ── GLB 写出 ───────────────────────────────────────────────────────────────

def write_glb(path: str, mesh: Mesh) -> None:
    positions = np.array(mesh.positions, dtype=np.float32)
    normals = np.array(mesh.normals, dtype=np.float32)
    indices = np.array(mesh.indices, dtype=np.uint32)

    pos_bytes = positions.tobytes()
    nrm_bytes = normals.tobytes()
    pad_pos = (-len(pos_bytes)) % 4
    pad_nrm = (-len(nrm_bytes)) % 4
    idx_bytes = indices.tobytes()
    pad_idx = (-len(idx_bytes)) % 4

    blob = pos_bytes + b"\x00" * pad_pos + nrm_bytes + b"\x00" * pad_nrm + idx_bytes + b"\x00" * pad_idx
    pos_off = 0
    nrm_off = len(pos_bytes) + pad_pos
    idx_off = nrm_off + len(nrm_bytes) + pad_nrm

    low = positions.min(axis=0).tolist()
    high = positions.max(axis=0).tolist()

    gltf = {
        "asset": {"version": "2.0", "generator": "dsh-hardware-sandbox/procedural"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": path.rsplit("\\", 1)[-1].replace(".bin", "")}],
        "meshes": [{"name": "body", "primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1}, "indices": 2, "material": 0}]}],
        "materials": [
            {
                "name": "body",
                "pbrMetallicRoughness": {
                    "baseColorFactor": [0.82, 0.82, 0.84, 1.0],
                    "metallicFactor": 0.05,
                    "roughnessFactor": 0.65,
                },
            }
        ],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(positions), "type": "VEC3", "min": low, "max": high},
            {"bufferView": 1, "componentType": 5126, "count": len(normals), "type": "VEC3"},
            {"bufferView": 2, "componentType": 5125, "count": len(indices), "type": "SCALAR"},
        ],
        "bufferViews": [
            {"buffer": 0, "byteOffset": pos_off, "byteLength": len(pos_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": nrm_off, "byteLength": len(nrm_bytes), "target": 34962},
            {"buffer": 0, "byteOffset": idx_off, "byteLength": len(idx_bytes), "target": 34963},
        ],
        "buffers": [{"byteLength": len(blob)}],
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    json_bytes += b" " * json_pad
    blob_pad = (-len(blob)) % 4
    blob += b"\x00" * blob_pad

    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    out += struct.pack("<II", len(blob), 0x004E4942) + blob
    with open(path, "wb") as handle:
        handle.write(bytes(out))
    print(f"  写出 {path}  {total} 字节  三角面 {len(indices) // 3}")


# ── ESP32 DevKit V1（真实尺寸 55 × 28mm，含排针约 13mm 高）──────────────────

def build_esp32_devkit() -> Mesh:
    m = Mesh()
    SX, SZ = 0.055, 0.028          # 真机 PCB 55 × 28mm
    PCB_T = 0.0016                 # 1.6mm 玻纤板
    HEADER_H = 0.0085              # 2.54mm 排针高 8.5mm
    PIN = 0.00032                  # 针截面约 0.64mm
    PITCH = 0.00254
    N = 15                         # 2 × 15

    # PCB（原点居中 ⇒ 符合契约"原点 = 包围盒中心"；这里先按几何中心建，导入时归一化）
    m.add_box((0, 0, 0), (SX, PCB_T, SZ))
    top = PCB_T / 2

    # 两排排针（沿 x 各 15 根，两排分别在 ±z 边内侧）
    rows = [SZ / 2 - 0.00254, -SZ / 2 + 0.00254]
    for row_z in rows:
        for i in range(N):
            x = (i - (N - 1) / 2) * PITCH
            # 塑料底座
            m.add_box((x, top + 0.00125, row_z), (PITCH * 0.8, 0.0025, 0.00254))
            # 金属针（露出部分）
            m.add_box((x, top + 0.0025 + HEADER_H / 2, row_z), (PIN, HEADER_H, PIN))

    # USB Micro 口（在一端，金属壳）
    m.add_box((-SX / 2 + 0.0035, top + 0.0016, 0), (0.0075, 0.0032, 0.0055))

    # ESP32-WROOM-32 金属屏蔽罩（真实 18 × 25.5 × 3.1mm）
    m.add_box((0.006, top + 0.00155 + 0.0008, 0), (0.018, 0.0031, 0.0255))

    # 两个按键（EN / BOOT）
    for x in (-SX / 2 + 0.011, -SX / 2 + 0.006):
        m.add_box((x, top + 0.0009, -SZ / 2 + 0.005), (0.0035, 0.0018, 0.0035))
    return m


# ── HC-SR501 PIR（真实尺寸 32 × 24mm，半球罩直径约 23mm）────────────────────

def build_hc_sr501() -> Mesh:
    m = Mesh()
    SX, SZ = 0.032, 0.024
    PCB_T = 0.0016
    DOME_R = 0.0115                # 菲涅尔罩直径 23mm
    PIN_H = 0.0085

    m.add_box((0, 0, 0), (SX, PCB_T, SZ))
    top = PCB_T / 2

    # 菲涅尔半球罩（真机的辨识特征）
    m.add_hemisphere((0, top, 0), DOME_R, segments=36, rings=14)

    # 三个引脚（VCC / OUT / GND），2.54mm 间距，在一条短边上
    for i, dz in enumerate((-PITCH_254, 0.0, PITCH_254)):
        m.add_box((-SX / 2 + 0.0015, -PCB_T / 2 - PIN_H / 2, dz), (0.00032, PIN_H, 0.00032))

    # 两个电位器（延时 / 灵敏度）—— 真机上很显眼
    for dz in (-0.006, 0.006):
        m.add_cylinder((SX / 2 - 0.006, top + 0.0015, dz), 0.0035, 0.003, segments=20)
    return m


PITCH_254 = 0.00254


if __name__ == "__main__":
    import os

    print("生成智座硬件的 GLB（按真实尺寸）：")
    for key, builder in (("esp32-devkit-v1", build_esp32_devkit), ("hc-sr501", build_hc_sr501)):
        mesh = builder()
        target = os.path.join(OUT_DIR, key, "model.bin")
        os.makedirs(os.path.dirname(target), exist_ok=True)
        write_glb(target, mesh)
        pos = np.array(mesh.positions)
        size = (pos.max(axis=0) - pos.min(axis=0)) * 1000
        print(f"     包围盒 = {size[0]:.2f} × {size[1]:.2f} × {size[2]:.2f} mm")
