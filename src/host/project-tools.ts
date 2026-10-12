/**
 * **项目导入工具** —— owner: session-24ca6e69
 * @module dsh-breadboard/host/project-tools
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 它把"手工摆四步"压成一次调用，而且**顺带回答了"通了没有"**
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：
 *
 *   > 右上角对话框下面应该可以选择**导入软硬件项目**，比如举例子，
 *   > 你得知道**导入的是智座项目**，并且**软硬件连接通了得有显示**
 *
 * 在此之前要跑通智座得做四件事：放 ESP32 → 放两个 PIR → 连六根线 → 配联网绑定。
 * **少一步就不通，而每一步都不报错**（这正是本项目失败族里那条最贵的形状）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ "通了"的判据**由项目自己定义**，内核只提供原始事实
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 智座的"通"= 注册过 + 拉到过配置 + 成功上报过 + **最近一次也是成功的**。
 * 别的系统判据完全不同 ⇒ 判据写在 `ProjectProfile.link` 里，
 * 这里只负责把设备状态**翻译**成那几项事实。
 *
 * ⚠️ **`registered` 是推导出来的，不是直接读的** —— 见 {@link factsOf} 的说明。
 *   这一点必须写在代码里，否则下一个人会以为它是个真实字段。
 */

import {
  SAMPLE_PROJECTS,
  type ModelNeed,
  type ProjectProfile,
  type ProjectStatus,
} from '../contracts/projects.ts'
import { HARDWARE_MODELS } from '../contracts/library.ts'
import type { NetworkDeviceSnapshot } from '../contracts/network.ts'
import { asRecord, text, type HardwareToolDefinition } from './tools.ts'
import type { NetworkRegistry } from '../core/sim/network-registry.ts'
import type { AssemblyState } from '../core/state/assembly-state.ts'
import { validateProjectProfile, type ProjectStore } from '../core/projects/store.ts'
import type { ModelStore } from '../core/models/store.ts'

export interface ProjectToolDeps {
  readonly state: AssemblyState
  readonly registry: NetworkRegistry
  /**
   * 用户的**项目存储**。
   *
   * ★ 项目是**用户自己的**（默认空），不是内置常量 —— 见 core/projects/store.ts。
   *   这里注入而不是 import 一个全局单例：测试能塞一个临时目录进去，
   *   不会碰用户真实的项目。
   */
  readonly projects: ProjectStore
  /**
   * **模型库** —— 用来回答"这个型号有没有几何"（建模台账）。
   *
   * ★ 必传而不是可选：缺了它就没法说清 ✅/❌，只能**猜** ——
   *   猜成"有几何"会让用户以为模型在（场景里其实是占位盒）；
   *   猜成"没有"会让他白建一遍。**两种猜法都在骗人**，所以不给默认值。
   */
  readonly models: ModelStore
}

/** 模型库里**已经有几何**的型号键集合（台账的 ✅/❌ 依据）。 */
export async function geometryKeys(models: ModelStore): Promise<ReadonlySet<string>> {
  const records = await models.list()
  return new Set(records.map((record) => record.modelKey))
}

/** 链接判据的**原始事实**（`ProjectProfile.link.requires` 从这里面挑）。 */
interface LinkFacts {
  readonly registered: boolean
  readonly config: boolean
  readonly reported: boolean
  readonly reporting: boolean
}

/**
 * 把设备状态翻译成判据事实。
 *
 * ★★ **`registered` 是推导的**：设备快照里**没有**"注册过"这个字段，
 *   因为注册是协议内部的一步（智座是 `POST /register`），
 *   注册成功与否不单独暴露 —— 但**它一定体现为"后来能拉到配置/能上报"**：
 *   智座服务端对不认识的设备会回 `registered:false`，那时拉配置与上报都会失败。
 *
 *   ⇒ `registered ⟺ 拉到过配置 || 成功上报过`。
 *   ⚠️ 这是一个**推导**，不是观察。它的失效条件是：某个协议允许"未注册也能上报"。
 *     那时这条判据要改成读真实字段，而不是继续猜。
 */
function factsOf(snapshot: NetworkDeviceSnapshot | undefined): LinkFacts {
  if (snapshot === undefined) {
    return { registered: false, config: false, reported: false, reporting: false }
  }
  const hasConfig = snapshot.config !== undefined
  const hasReported = snapshot.reports > 0
  return {
    registered: hasConfig || hasReported,
    config: hasConfig,
    reported: hasReported,
    // ★ "最近一次是成功的" —— 不是"曾经成功过"。
    //   智座那边把服务停了再开，`reports>0` 仍然成立，但链路其实是断的。
    reporting: snapshot.status === 'online' && (snapshot.lastError ?? '') === '',
  }
}

/** 判断一条项目当前是否"软硬件连通"。 */
function linkStateOf(
  project: ProjectProfile,
  snapshot: NetworkDeviceSnapshot | undefined,
): { readonly up: boolean; readonly facts: LinkFacts; readonly missing: readonly string[] } {
  const facts = factsOf(snapshot)
  const missing = project.link.requires.filter((key) => !facts[key])
  return { up: missing.length === 0, facts, missing }
}

const LINK_LABEL: Readonly<Record<keyof LinkFacts, string>> = {
  registered: '外部系统认得这台设备（注册过）',
  config: '拉到过配置（知道多久报一次）',
  reported: '成功上报过至少一次',
  reporting: '最近一次上报是成功的',
}

/**
 * **算一遍所有项目的当前状态** —— 工具与 HTTP 路由**共用这一份**。
 *
 * ★ 抽出来是为了**不出现第二本账**：界面看到的"连通"和 agent 看到的"连通"
 *   必须来自同一个函数。各算各的，迟早会一个说通、一个说没通，而没人知道信谁。
 *
 * ★ 项目清单**由调用方传进来**（来自 `ProjectStore`），不再读 `SAMPLE_PROJECTS` ——
 *   项目是**用户的**，不是内置的。见 `core/projects/store.ts` 的说明。
 */
export function projectStatuses(
  state: AssemblyState,
  registry: NetworkRegistry,
  profiles: readonly ProjectProfile[],
  /** 全局模型库里**已经有几何**的型号键。★ 必传：不传就没法说"待建"，那是撒谎。 */
  modelsWithGeometry: ReadonlySet<string>,
): readonly ProjectStatus[] {
  const components = state.snapshot().components
  return profiles.map((project) => {
    // ★ "已导入" = **图纸上那几个器件 id 都在**，而不是"场景里有任意器件"
    const imported = project.parts.every((part) => components.some((c) => c.id === part.id))
    const snapshot = registry.deviceFor(project.networkComponentId)?.snapshot()
    const link = linkStateOf(project, snapshot)
    // ★ 台账型号集 = `requiredModels`（扫描补充过）∪ `parts`（装配里已经摆着的）
    const keys = new Set<string>(project.requiredModels ?? [])
    for (const part of project.parts) keys.add(part.hardwareModel)
    const modelNeeds: ModelNeed[] = [...keys].map((modelKey) => ({
      modelKey,
      label: HARDWARE_MODELS[modelKey]?.label ?? modelKey,
      hasGeometry: modelsWithGeometry.has(modelKey),
    }))
    return {
      id: project.id,
      label: project.label,
      description: project.description,
      imported,
      linkUp: imported && link.up,
      missing: link.missing,
      requirements: LINK_LABEL,
      modelNeeds,
      missingModels: modelNeeds.filter((need) => !need.hasGeometry).map((need) => need.modelKey),
      // ★ 带上完整图纸：界面要能**导出**（用户："这个也能选择路径保存"）
      profile: project,
    }
  })
}

export function createProjectTools(deps: ProjectToolDeps): HardwareToolDefinition[] {
  const { state, registry, projects, models } = deps

  /** 导入一个项目：按图纸放器件、连线、挂联网绑定。 */
  const importProject = (project: ProjectProfile): { ok: boolean; reason?: string; placed: string[] } => {
    const placed: string[] = []
    // ★ 先清空：项目导入是"把现场布置成图纸"，而不是"往现有东西上加"。
    //   否则同一个项目导两次会得到两套器件（而 id 相同 ⇒ 第二次直接失败），
    //   症状是"第一次好好的，再点一次就报错"，很难懂。
    for (const component of state.snapshot().components) state.remove(component.id)

    for (const part of project.parts) {
      const result = state.place(part.hardwareModel, part.position, part.id)
      if (!result.ok) return { ok: false, reason: `放置 ${part.id}（${part.hardwareModel}）失败：${result.reason}`, placed }
      if (part.rotation !== undefined) state.setRotation(part.id, part.rotation)
      placed.push(part.id)
    }

    for (const wire of project.wires) {
      const result = state.connect(wire.from, wire.to)
      if (!result.ok) {
        return {
          ok: false,
          reason:
            `接线 ${wire.from.componentId}.${wire.from.portId} → ${wire.to.componentId}.${wire.to.portId} 失败：` +
            `${result.reason}（**器件已放下，但线没连全 ⇒ 这个项目现在是断的**）`,
          placed,
        }
      }
    }

    // ★ 联网绑定挂在**主控自己**身上（真机里主控就是传感器节点）
    const bound = state.setNetwork(project.networkComponentId, project.network)
    if (!bound.ok) {
      return { ok: false, reason: `给 ${project.networkComponentId} 挂联网绑定失败：${bound.reason}`, placed }
    }
    return { ok: true, placed }
  }

  return [
    {
      name: 'hw_list_projects',
      description:
        '列出**内置的软硬件项目**（如智座座位传感器节点）：每个项目包含器件清单、接线、' +
        '联网配置，以及**当前是否软硬件连通**。' +
        '★ 想跑一个真实系统时**先用这个**，而不是手工一个个摆器件 —— ' +
        '手工摆要放器件、连线、配绑定四步，**少一步就不通且不报错**。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            projects: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  description: { type: 'string' },
                  imported: { type: 'boolean' },
                  linkUp: { type: 'boolean' },
                  missing: { type: 'array', items: { type: 'string' } },
                },
                required: ['id', 'label', 'imported', 'linkUp', 'missing'],
              },
            },
          },
          required: ['projects'],
        },
        render: (_args, value) => {
          const box = value as { projects?: unknown }
          const list = Array.isArray(box.projects) ? box.projects : []
          const lines = list.map((raw: unknown) => {
            const item = raw as Record<string, unknown>
            const missing = Array.isArray(item.missing) ? item.missing.map(String) : []
            const state_ = item.linkUp === true ? '✅ 已连通' : item.imported === true ? '⚠️ 已导入但未连通' : '— 未导入'
            const why = missing.length > 0 ? `\n      还差：${missing.map((key) => LINK_LABEL[key as keyof LinkFacts] ?? key).join('、')}` : ''
            return `  ${String(item.label)}（${String(item.id)}）${state_}${why}\n      ${String(item.description)}`
          })
          return text(lines.join('\n') || '（没有内置项目）')
        },
      },
      // ★ 与 HTTP 路由**共用同一个函数** —— 界面看到的"连通"和 agent 看到的
      //   必须来自同一份计算，各算各的迟早会一个说通一个说没通，而没人知道信谁。
      execute: async () => {
        const { projects: profiles, broken } = await projects.list()
        return {
          projects: projectStatuses(state, registry, profiles, await geometryKeys(models)),
          broken,
        }
      },
    },

    {
      name: 'hw_import_project',
      description:
        '**导入一个软硬件项目**：按它的图纸一次放好所有器件、连好所有线、挂好联网绑定。' +
        '★ 会**先清空当前装配**（导入 = 把现场布置成图纸，不是往上加）。' +
        '★ 导入后**设备是停着的** —— 还要用 hw_network_control 启动它才会真的出网' +
        '（默认不产生外部副作用是刻意的）。' +
        '★ 用 hw_list_projects 看有哪些项目、以及连通状态。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          projectId: { type: 'string', description: '项目 id，如 zhizuo-seat-node。' },
        },
        required: ['projectId'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            projectId: { type: 'string' },
            placed: { type: 'array', items: { type: 'string' } },
            wires: { type: 'number' },
            linkUp: { type: 'boolean' },
            missing: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
          },
          required: ['ok', 'projectId', 'placed', 'wires', 'linkUp', 'missing'],
        },
        render: (_args, value) => {
          const box = value as Record<string, unknown>
          if (box.ok !== true) return text(`导入失败：${String(box.reason ?? '未知原因')}`)
          const missing = Array.isArray(box.missing) ? box.missing.map(String) : []
          const placed = Array.isArray(box.placed) ? box.placed : []
          const tail =
            box.linkUp === true
              ? '软硬件已连通 ✅'
              : `尚未连通（用 hw_network_control 启动设备；还差：${
                  missing.map((key) => LINK_LABEL[key as keyof LinkFacts] ?? key).join('、') || '—'
                }）`
          return text(
            `已导入 ${String(box.projectId)}：${String(placed.length)} 个器件、` +
              `${String(box.wires)} 根线。${tail}`,
          )
        },
      },
      execute: async (args) => {
        const input = args as Record<string, unknown>
        const projectId = typeof input.projectId === 'string' ? input.projectId : ''
        const project = await projects.get(projectId)
        if (project === undefined) {
          return {
            ok: false,
            projectId,
            placed: [],
            wires: 0,
            linkUp: false,
            missing: [],
            reason: `没有这个项目："${projectId}"。可用：${Object.keys(SAMPLE_PROJECTS).join(', ')}`,
          }
        }
        const result = importProject(project)
        if (!result.ok) {
          return {
            ok: false,
            projectId,
            placed: result.placed,
            wires: project.wires.length,
            linkUp: false,
            missing: [],
            reason: result.reason ?? '未知原因',
          }
        }
        const snapshot = registry.deviceFor(project.networkComponentId)?.snapshot()
        const link = linkStateOf(project, snapshot)
        return {
          ok: true,
          projectId,
          placed: result.placed,
          wires: project.wires.length,
          linkUp: link.up,
          missing: link.missing,
        }
      },
    },

    /* ── ③ ★ agent 建项目：按描述把一份图纸**存进用户的项目目录** ── */
    {
      name: 'hw_save_project',
      description:
        '**新建或覆盖一个软硬件项目**（存进用户的 `~/.dsh/dsh-hardware-sandbox/projects/`）。' +
        '★ 这是"agent 按项目需求建项目"的入口：用户可以口述一个系统，你把它写成图纸存下来，' +
        '之后用 hw_import_project 一键切换过去。' +
        '★ 形状（与项目文件完全一致，导出再导入能原样回来）：\n' +
        '{\n' +
        '  id: "my-seat-node"            （小写字母/数字/连字符，最长 64 —— 它会变成文件名）\n' +
        '  label: "我的座位节点"\n' +
        '  description: "一句话说明"\n' +
        '  parts: [{ id:"c1", hardwareModel:"esp32-seat-sensor", position:{x:0,y:0.006,z:0} }]\n' +
        '  wires: [{ from:{componentId:"c2",portId:"OUT"}, to:{componentId:"c1",portId:"E4"} }]\n' +
        '  networkComponentId: "c1"      （出网的那台，必须是 parts 里的）\n' +
        '  network: { protocol:"zhizuo-sensor", endpoint:"http://127.0.0.1:5800", deviceId:"AA:BB:..." }\n' +
        '  link: { requires:["registered","config","reported","reporting"] }   ← **必填**\n' +
        '}\n' +
        '★ `position` 单位是**米**，是器件**包围盒中心**；`portId` 是 `E4` 这种**身份**，' +
        '不是 `GPIO23` 那种丝印（用 hw_get_assembly 看现有装配里的 id）。' +
        '★ `link.requires` **必须写**：它说明"怎么算这个项目连上了"（智座是四项全满足）。' +
        '不写就没法判断通没通 —— 校验会直接拒绝，而不是给个默认值假装它是通的。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          project: {
            type: 'object',
            additionalProperties: true,
            description: '完整的项目图纸，见工具描述里的形状。',
          },
        },
        required: ['project'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            projectId: { type: 'string' },
            reason: { type: 'string' },
          },
          required: ['ok', 'projectId'],
        },
        render: (_args, value) => {
          const result = asRecord(value)
          if (result.ok !== true) {
            return text(`项目没存下来：${String(result.reason ?? '未知原因')}`)
          }
          return text(
            `已保存项目 ${String(result.projectId)}。` +
              '用 hw_list_projects 看它、hw_import_project 切换过去。',
          )
        },
      },
      execute: async (args) => {
        const input = asRecord(args)
        const raw = input.project
        // ★★ **与界面导入走同一条校验** —— 不另立一份。
        //   两条路各校各的，迟早一条收得下、另一条收不下，而用户看到的是
        //   "同一个文件，界面能导、agent 不能"（或反过来），没人知道差在哪。
        const checked = validateProjectProfile(raw)
        if (!checked.ok) {
          return { ok: false, projectId: '', reason: checked.reason }
        }
        try {
          await projects.save(checked.profile)
          return { ok: true, projectId: checked.profile.id }
        } catch (error) {
          return { ok: false, projectId: checked.profile.id, reason: String(error) }
        }
      },
    },
  ]
}
