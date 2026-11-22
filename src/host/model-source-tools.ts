/**
 * **模型来源工具** —— 让"缺模型"这件事能被一个 agent 一轮做完，而不是丢给用户。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 它解决的是哪一个真实卡点
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 以前遇到库里没有几何的型号，结论只能停在：
 *   「3D 沙盒里暂时没有 XXX 模型，**需要后续导入自定义 GLB** 才能摆件」
 * —— 这句话把活推回给了人。而"造一个 GLB"恰恰是有工具的 agent 能干的：
 * 外部建模插件（如 DSH × Blender）负责出几何，本插件负责核对契约并登记。
 *
 * ⇒ 三个工具把这条路串成一个闭环：
 *   hw_list_missing_models  →  哪些型号缺几何（附声明尺寸）
 *   hw_model_workorder      →  给某个型号出一份**可直接交给建模工具**的工单
 *   hw_import_model_file    →  把建模工具产出的文件按路径登记进来
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 为什么是"工单"而不是"插件之间直调"
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 宿主 `tools` 服务只提供 `get()` / `executable()` 取到**别的插件**的
 * `ToolDefinition`，然后 `.execute()` 直调 —— 那条路**绕过审批与 guard**。
 * 拿它来做"自动帮你建模"等于给自己开一条不受审的写操作通道。
 * ⇒ 本层只负责把**契约说准**，跨插件的动作由 agent 按工单去调对方工具
 *   （审批、权限、可见性照常生效）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 归一化契约（工单里写死的那几条，来自本插件踩过的坑）
 * ══════════════════════════════════════════════════════════════════════════
 *
 * · **朝向**：x = 长 / y = 厚 / z = 宽。`orientToContract()` 只会产出**旋转**
 *   （det = +1），**不会纠镜像** —— 模型左右做反了它救不了，端口会落到错误一侧，
 *   而包围盒完全看不出来。
 * · **原点**：包围盒**中心**（不是角、不是底面）。
 * · **比例**：按 `size` 逐轴缩放 ⇒ 比例不符不会报错，只会把模型压变形，
 *   而所有"按真实尺寸写的代码"（2.54mm 针距、封装间距）会一起失准。
 * · **变换**：导出前 apply transform。带**旋转/缩放**的节点变换算不出包围盒；
 *   纯平移可以（那不改形状）。
 */

import type { ModelStore } from '../core/models/store.ts'
import { findModel, modelKeys } from '../contracts/library.ts'
import { asRecord, text, type HardwareToolDefinition } from './tools.ts'

export interface ModelSourceToolDeps {
  /** 已导入几何的存储（宿主侧真相）。 */
  readonly models: ModelStore
  /** 工单里建议的导出目录（建模工具产出往这放）。 */
  readonly workDir: string
}

/** 尺寸显示：3 位有效数字，**不猜单位**（米制下两位小数会把 15.1mm 写成 0.02）。 */
function mm(value: number): string {
  return String(Number((value * 1000).toFixed(2)))
}

/** 一份工单要交代的全部契约事实。 */
function workorderFor(modelKey: string, hasGeometry: boolean): Record<string, unknown> {
  const model = findModel(modelKey)
  if (model === undefined) return { found: false }
  const size = model.size
  return {
    found: true,
    modelKey,
    label: model.label,
    hasGeometry,
    sizeMm: { x: mm(size.x), y: mm(size.y), z: mm(size.z) },
    portCount: model.ports.length,
    blender: {
      // Blender 是 Z-up；导出 glTF 时勾 +Y Up，就会落成契约要的 x=长/y=厚/z=宽。
      axis: 'Blender 里：X = 长，Y = 宽，Z = 高（Z-up）',
      origin: '包围盒中心放在世界原点',
      export: '导出 GLB，勾选 +Y Up，导出前 apply transform（旋转/缩放）',
      scale: `建模尺寸就按 ${mm(size.x)} × ${mm(size.z)} × ${mm(size.y)} mm（长×宽×高）`,
    },
    next: `建模工具导出后：hw_import_model_file({ modelKey: "${modelKey}", filePath: "<绝对路径>" })`,
  }
}

export function createModelSourceTools(deps: ModelSourceToolDeps): HardwareToolDefinition[] {
  const { models } = deps
  return [
    /* ── ① 哪些型号缺几何 ── */
    {
      name: 'hw_list_missing_models',
      description:
        '列出**库里声明了、但还没有几何**的型号（它们现在只能显示成占位盒）。' +
        '★ 用途：接手一个项目、要补建模时先看这张单子，别靠一个个试。' +
        '每项带声明尺寸（mm）—— 那是建模和归一化的唯一目标。' +
        '★ 有几何的型号不在这里；要看全部用 hw_get_assembly 或界面。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            declaredTotal: { type: 'number' },
            withGeometry: { type: 'number' },
            missing: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  modelKey: { type: 'string' },
                  label: { type: 'string' },
                  sizeMm: { type: 'string' },
                  portCount: { type: 'number' },
                },
                required: ['modelKey', 'label', 'sizeMm', 'portCount'],
              },
            },
          },
          required: ['declaredTotal', 'withGeometry', 'missing'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          const missing = (result.missing as Array<Record<string, unknown>>) ?? []
          if (missing.length === 0) {
            return text(`库里 ${String(result.declaredTotal)} 个型号都有几何了。`)
          }
          const lines = missing.map(
            (item) =>
              `· ${String(item.modelKey)}（${String(item.label)}）${String(item.sizeMm)} mm，${String(item.portCount)} 个端口`,
          )
          return text(
            `缺几何 ${missing.length} / 共 ${String(result.declaredTotal)} 个型号（这些现在只显示占位盒）：\n` +
              lines.join('\n') +
              `\n\n→ 逐个补：hw_model_workorder 拿工单，建模导出后 hw_import_model_file 登记。`,
          )
        },
      },
      execute: async () => {
        const stored = new Set((await models.list()).map((record) => record.modelKey))
        const keys = modelKeys()
        const missing: Array<Record<string, unknown>> = []
        let withGeometry = 0
        for (const key of keys) {
          const model = findModel(key)
          if (model === undefined) continue
          if (stored.has(key)) {
            withGeometry += 1
            continue
          }
          missing.push({
            modelKey: key,
            label: model.label,
            sizeMm: `${mm(model.size.x)} × ${mm(model.size.y)} × ${mm(model.size.z)}`,
            portCount: model.ports.length,
          })
        }
        return { declaredTotal: keys.length, withGeometry, missing }
      },
    },

    /* ── ② 给一个型号出工单 ── */
    {
      name: 'hw_model_workorder',
      description:
        '给某个型号出一份**可直接交给建模工具（如 Blender 插件）**的工单：' +
        '声明尺寸、朝向约定、原点规则、导出要求，以及产出后该怎么登记。' +
        '★ 这三条不是风格建议，写错会**静默出错**：比例不符只会把模型压变形（不报错），' +
        '左右做反只会让端口落到另一侧（包围盒看不出来）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modelKey: { type: 'string', description: '型号键（用 hw_list_missing_models 看有哪些）。' },
        },
        required: ['modelKey'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean' },
            modelKey: { type: 'string' },
            label: { type: 'string' },
            hasGeometry: { type: 'boolean' },
            sizeMm: {
              type: 'object',
              additionalProperties: false,
              properties: { x: { type: 'string' }, y: { type: 'string' }, z: { type: 'string' } },
              required: ['x', 'y', 'z'],
            },
            portCount: { type: 'number' },
            blender: {
              type: 'object',
              additionalProperties: false,
              properties: {
                axis: { type: 'string' },
                origin: { type: 'string' },
                export: { type: 'string' },
                scale: { type: 'string' },
              },
              required: ['axis', 'origin', 'export', 'scale'],
            },
            next: { type: 'string' },
            workDir: { type: 'string' },
          },
          required: ['found', 'modelKey', 'label', 'hasGeometry', 'sizeMm', 'portCount', 'blender', 'next', 'workDir'],
        },
        render: (args, value) => {
          const result = asRecord(value)
          if (result.found !== true) {
            return text(`没有型号 ${String(asRecord(args).modelKey)} —— 先用 hw_list_missing_models 看有哪些键。`)
          }
          const size = asRecord(result.sizeMm)
          const blender = asRecord(result.blender)
          return text(
            `工单：${String(result.modelKey)}（${String(result.label)}）` +
              `${result.hasGeometry === true ? '  ← 注意：已有几何，登记会覆盖' : ''}\n` +
              `声明尺寸 长 ${String(size.x)} × 厚 ${String(size.y)} × 宽 ${String(size.z)} mm（x / y / z）\n` +
              `端口 ${String(result.portCount)} 个（端口坐标在归一化坐标系里，所以朝向必须先对）\n\n` +
              `${String(blender.axis)}\n${String(blender.origin)}\n${String(blender.scale)}\n${String(blender.export)}\n\n` +
              `产出放：${String(result.workDir)}\n→ ${String(result.next)}`,
          )
        },
      },
      execute: async (args) => {
        const modelKey = typeof asRecord(args).modelKey === 'string' ? String(asRecord(args).modelKey).trim() : ''
        const stored = new Set((await models.list()).map((record) => record.modelKey))
        const order = workorderFor(modelKey, stored.has(modelKey))
        if (order.found !== true) {
          return {
            found: false,
            modelKey,
            label: '',
            hasGeometry: false,
            sizeMm: { x: '', y: '', z: '' },
            portCount: 0,
            blender: { axis: '', origin: '', export: '', scale: '' },
            next: '',
            workDir: deps.workDir,
          }
        }
        return { ...order, workDir: deps.workDir }
      },
    },

    /* ── ③ 按路径登记几何 ── */
    {
      name: 'hw_import_model_file',
      description:
        '把一个**本机模型文件**登记成某型号的几何（glb / gltf / obj / stl / fbx / dae / 3mf）。' +
        '用于接外部建模工具产出的模型：对方导出文件，这里按路径登记，不用人到界面里拖拽。\n' +
        '⚠️ 只换几何，**不动**契约里的 size 和端口 —— 那两件走 hw_save_model_definition。\n' +
        'GLB 会顺便量三边比例并与声明 size 对比：比例差得远通常意味着模型或 size 有一个错了。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          modelKey: { type: 'string', description: '型号键。重复登记会覆盖旧几何。' },
          filePath: { type: 'string', description: '本机模型文件的绝对路径。' },
        },
        required: ['modelKey', 'filePath'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            modelKey: { type: 'string' },
            bytes: { type: 'number' },
            format: { type: 'string' },
            nodes: { type: 'number' },
            measured: { type: 'boolean' },
            modelDims: { type: 'array', items: { type: 'number' } },
            aspectDrift: { type: 'number' },
            message: { type: 'string' },
          },
          required: ['ok', 'modelKey', 'bytes', 'format', 'nodes', 'measured', 'modelDims', 'aspectDrift', 'message'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          if (result.ok !== true) return text(`登记失败：${String(result.message)}`)
          const dims = Array.isArray(result.modelDims) ? (result.modelDims as number[]) : []
          const shape = dims.length === 3 ? dims.map(formatLength).join(' × ') : '（未量）'
          const drift = Number(result.aspectDrift)
          const driftNote = drift > 1.15 ? `  ⚠️ 三边比例与声明 size 差 ${drift.toFixed(2)}×` : ''
          return text(
            `${String(result.modelKey)} 已登记：${String(result.format).toUpperCase()} ${String(result.bytes)} 字节` +
              `${Number(result.nodes) >= 0 ? `，${String(result.nodes)} 个节点` : ''}。\n` +
              `模型尺寸 ${shape}（模型自身单位）${driftNote}${result.message ? `\n${String(result.message)}` : ''}`,
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const modelKey = typeof input.modelKey === 'string' ? input.modelKey.trim() : ''
        const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : ''
        const fail = (message: string) => ({
          ok: false,
          modelKey,
          bytes: 0,
          format: '',
          nodes: -1,
          measured: false,
          modelDims: [] as number[],
          aspectDrift: 0,
          message,
        })
        if (!modelKey || !filePath) return fail('modelKey 与 filePath 都必填')

        let bytes: Uint8Array
        try {
          bytes = new Uint8Array(await readFile(filePath))
        } catch (error) {
          return fail(`读不到文件：${error instanceof Error ? error.message : String(error)}`)
        }

        let record: Record<string, unknown>
        try {
          record = asRecord(await models.put(modelKey, bytes))
        } catch (error) {
          return fail(error instanceof Error ? error.message : String(error))
        }

        const measure = measureGlbBbox(bytes)
        const dims = measure.dims
        const declared = findModel(modelKey)?.size
        let aspectDrift = 0
        let message = ''
        if (dims === undefined) {
          message = `未核对三边比例：${measure.reason ?? '无法测量'}`
        } else if (declared === undefined) {
          message = '未核对三边比例：该型号还没声明 size'
        } else {
          // 按长度排序后逐位相除 —— **顺序无关**，所以不受朝向影响（朝向由客户端归一化处理）
          const modelSorted = [...dims].sort((a, b) => a - b)
          const targetSorted = [declared.x, declared.y, declared.z].sort((a, b) => a - b)
          const ratios = targetSorted
            .map((v, i) => (modelSorted[i] > 0 ? v / modelSorted[i] : Number.NaN))
            .filter((v) => Number.isFinite(v) && v > 0)
          if (ratios.length === 3) {
            aspectDrift = Math.max(...ratios) / Math.min(...ratios)
            message =
              aspectDrift > 1.15
                ? `三边比例与声明的 size 差 ${aspectDrift.toFixed(2)}× —— 模型或 size 有一个错了，别靠拉伸糊过去`
                : ''
          }
        }

        return {
          ok: true,
          modelKey,
          bytes: Number(record.bytes ?? bytes.length),
          format: String(record.format ?? ''),
          nodes: typeof record.nodes === 'number' ? record.nodes : -1,
          measured: dims !== undefined,
          modelDims: dims === undefined ? [] : [dims[0], dims[1], dims[2]],
          aspectDrift,
          message,
        }
      },
    },
  ]
}

/** 尺寸显示：**3 位有效数字**，不猜单位。 */
function formatLength(value: number): string {
  if (!Number.isFinite(value)) return String(value)
  if (value === 0) return '0'
  return String(Number(Math.abs(value) >= 1 ? value.toFixed(2) : value.toPrecision(3)))
}

/**
 * GLB 的模型包围盒（模型自身单位）。
 *
 * ★ 能不能量，取决于节点变换的种类：
 *   · **纯平移** —— 量得准（平移不改变尺寸，把偏移加到角点即可）
 *   · **旋转 / 缩放 / 非单位 matrix** —— 量不准 ⇒ **如实拒绝**，不猜
 *   这条边界是踩出来的：Blender 导出的 GLB 给每个物体一个 `translation`，
 *   一上来就"拒绝量"会把所有人都挡在门外；而放宽到"有变换也照量"会给错数。
 *   二者的分界就是**变换是否改变形状**。
 */
export function measureGlbBbox(bytes: Uint8Array): { dims?: [number, number, number]; reason?: string } {
  if (bytes.length < 20) return { reason: '文件太小，不像 GLB' }
  if (!(bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46)) {
    return { reason: '不是 GLB（二进制 glTF），这里只量 GLB' }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunkLength = view.getUint32(12, true)
  if (view.getUint32(16, true) !== 0x4e4f534a) return { reason: 'GLB 的第一个 chunk 不是 JSON' }
  const end = Math.min(20 + chunkLength, bytes.length)
  let doc: Record<string, unknown>
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes.subarray(20, end))) as Record<string, unknown>
  } catch {
    return { reason: 'GLB 的 JSON chunk 解析失败' }
  }

  const nodes = Array.isArray(doc.nodes) ? (doc.nodes as Record<string, unknown>[]) : []
  const meshes = Array.isArray(doc.meshes) ? (doc.meshes as Record<string, unknown>[]) : []
  const accessors = Array.isArray(doc.accessors) ? (doc.accessors as Record<string, unknown>[]) : []
  const scenes = Array.isArray(doc.scenes) ? (doc.scenes as Record<string, unknown>[]) : []

  const localOffset = (node: Record<string, unknown>): { offset?: [number, number, number]; reason?: string } => {
    const matrix = node.matrix as number[] | undefined
    if (Array.isArray(matrix) && matrix.length >= 16) {
      // 列主序：matrix[col*4 + row]
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const want = row === col ? 1 : 0
          if (Math.abs((matrix[col * 4 + row] ?? 0) - want) > 1e-9) return { reason: '模型带节点旋转或缩放（matrix）' }
        }
      }
      return { offset: [matrix[12] ?? 0, matrix[13] ?? 0, matrix[14] ?? 0] }
    }
    const rotate = node.rotation as number[] | undefined
    if (
      Array.isArray(rotate) &&
      !(
        Math.abs(rotate[0] ?? 0) < 1e-9 &&
        Math.abs(rotate[1] ?? 0) < 1e-9 &&
        Math.abs(rotate[2] ?? 0) < 1e-9 &&
        Math.abs(Math.abs(rotate[3] ?? 1) - 1) < 1e-9
      )
    ) {
      return { reason: '模型带节点旋转' }
    }
    const scale = node.scale as number[] | undefined
    if (Array.isArray(scale) && scale.some((v) => Math.abs((v ?? 1) - 1) > 1e-9)) {
      return { reason: '模型带节点缩放' }
    }
    const t = (node.translation as number[] | undefined) ?? []
    return { offset: [t[0] ?? 0, t[1] ?? 0, t[2] ?? 0] }
  }

  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let measured = false

  const rootIndexes =
    scenes.length > 0 ? ((scenes[doc.scene as number] ?? scenes[0])?.nodes as number[] | undefined) ?? [] : []
  const stack: Array<{ index: number; offset: [number, number, number] }> = rootIndexes.map((index) => ({
    index,
    offset: [0, 0, 0] as [number, number, number],
  }))
  while (stack.length > 0) {
    const { index, offset } = stack.pop()!
    const node = nodes[index]
    if (node === undefined) continue
    const local = localOffset(node)
    if (local.reason !== undefined) return { reason: local.reason }
    const base = local.offset ?? [0, 0, 0]
    const world: [number, number, number] = [offset[0] + base[0], offset[1] + base[1], offset[2] + base[2]]

    const meshIndex = node.mesh
    if (typeof meshIndex === 'number') {
      const mesh = meshes[meshIndex]
      const primitives = Array.isArray(mesh?.primitives) ? (mesh.primitives as Record<string, unknown>[]) : []
      for (const prim of primitives) {
        const attributes = prim.attributes as Record<string, unknown> | undefined
        const position = attributes?.POSITION
        if (typeof position !== 'number') continue
        const accessor = accessors[position]
        const lo = accessor?.min as number[] | undefined
        const hi = accessor?.max as number[] | undefined
        if (!Array.isArray(lo) || !Array.isArray(hi)) continue
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], (lo[axis] ?? 0) + world[axis])
          max[axis] = Math.max(max[axis], (hi[axis] ?? 0) + world[axis])
        }
        measured = true
      }
    }
    const children = node.children
    if (Array.isArray(children)) {
      for (const child of children) if (typeof child === 'number') stack.push({ index: child, offset: world })
    }
  }

  if (!measured || !Number.isFinite(min[0]) || !Number.isFinite(max[0])) {
    return { reason: 'GLB 里找不到 POSITION 的 min/max' }
  }
  return { dims: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] }
}

/** 本机读文件（单独抽出，便于测试注入）。 */
function readFile(filePath: string): Promise<Buffer> {
  // 动态 import：保持本文件在没有 fs 的测试环境里也能 import
  return import('node:fs/promises').then((fs) => fs.readFile(filePath))
}
