/**
 * **项目导入工具** —— owner: session-24ca6e69
 * @module dsh-hardware-sandbox/host/project-tools
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
  KNOWN_PROJECTS,
  type ProjectProfile,
} from '../contracts/projects.ts'
import type { NetworkDeviceSnapshot } from '../contracts/network.ts'
import { text, type HardwareToolDefinition } from './tools.ts'
import type { NetworkRegistry } from '../core/sim/network-registry.ts'
import type { AssemblyState } from '../core/state/assembly-state.ts'

export interface ProjectToolDeps {
  readonly state: AssemblyState
  readonly registry: NetworkRegistry
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

export function createProjectTools(deps: ProjectToolDeps): HardwareToolDefinition[] {
  const { state, registry } = deps

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
      execute: async () => {
        const components = state.snapshot().components
        const projects = Object.values(KNOWN_PROJECTS).map((project) => {
          // ★ "已导入" = **图纸上那几个器件 id 都在**，而不是"有任意器件"
          const imported = project.parts.every((part) => components.some((c) => c.id === part.id))
          const snapshot = registry.deviceFor(project.networkComponentId)?.snapshot()
          const link = linkStateOf(project, snapshot)
          return {
            id: project.id,
            label: project.label,
            description: project.description,
            imported,
            linkUp: imported && link.up,
            missing: link.missing,
          }
        })
        return { projects }
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
        const project = KNOWN_PROJECTS[projectId]
        if (project === undefined) {
          return {
            ok: false,
            projectId,
            placed: [],
            wires: 0,
            linkUp: false,
            missing: [],
            reason: `没有这个项目："${projectId}"。可用：${Object.keys(KNOWN_PROJECTS).join(', ')}`,
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
  ]
}
