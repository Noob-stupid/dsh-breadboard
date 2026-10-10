/**
 * **项目切换面板** —— owner: session-24ca6e69
 * @module dsh-hardware-sandbox/client/project-panel
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★★ 为什么它是这个插件界面上最重要的一块
 * ══════════════════════════════════════════════════════════════════════════
 *
 * 用户原话：
 *
 *   > 最主要的是那个**项目切换**，应该**直接跟着切换到那个项目带的硬件设施**，懂吗
 *
 * 在此之前要跑通智座得手工做四步：放 ESP32 → 放两个 PIR → 连六根线 → 配联网绑定。
 * **少一步就不通，而每一步都不报错。** 这个面板把那四步压成**一次点击**，
 * 并且把"**通了没有、还差什么**"直接摆在按钮旁边。
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ★ 状态从**宿主**拿，不在前端算
 * ══════════════════════════════════════════════════════════════════════════
 *
 * "通"的判据是：注册过 + 拉到过配置 + 上报过 + 最近一次也成功。
 * 装配快照里**有**设备状态（reports / status），但**没有 `config`** ⇒ 前端算不全。
 * ⇒ 与其在前端近似（那会出现"界面说通了、agent 说没通"），不如走 `GET /api/projects`，
 *   而且那个路由与 `hw_list_projects` 工具**共用同一个函数**。
 */

import { useEffect, useState, type ReactNode } from 'react'
import { createElement as h } from 'react'

import { HTTP_ROUTES } from '../contracts/protocol.ts'
import type { ProjectStatus } from '../contracts/projects.ts'
import { Panel } from './hud.ts'

export interface ProjectPanelProps {
  /** 切换到这个项目（走 `import_project` 动作，与工具同一条路）。 */
  readonly onSwitch: (projectId: string) => void
  readonly disabled: boolean
  /** 装配 revision —— 变了就重新拉一次状态（导入之后连通性会变）。 */
  readonly revision: number
}

export function ProjectPanel(props: ProjectPanelProps) {
  const [projects, setProjects] = useState<readonly ProjectStatus[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const response = await fetch(HTTP_ROUTES.projects)
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const list = (await response.json()) as ProjectStatus[]
        if (alive) {
          setProjects(list)
          setFailure(undefined)
        }
      } catch (error) {
        // ★ 失败要说出来 —— 否则面板永远是空的，看起来像"没有项目"
        if (alive) setFailure(String(error))
      }
    })()
    return () => {
      alive = false
    }
  }, [props.revision])

  const body: ReactNode[] = []
  if (failure !== undefined) {
    body.push(
      h(
        'div',
        { key: '__fail', style: { fontSize: '11px', color: '#ff9b9b', lineHeight: 1.5 } },
        `项目列表读不到：${failure}`,
      ),
    )
  }
  for (const project of projects) {
    const status = project.linkUp
      ? { text: '✅ 软硬件已连通', color: '#7ee0a0' }
      : project.imported
        ? { text: `⚠️ 已导入但未连通（还差 ${String(project.missing.length)} 项）`, color: '#ffc46b' }
        : { text: '— 未导入', color: 'rgba(200,210,225,0.55)' }
    const missing = project.missing
      .map((key) => project.requirements[key] ?? key)
      .map((line) => `· ${line}`)
      .join('\n')
    body.push(
      h(
        'div',
        {
          key: project.id,
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '5px',
            padding: '8px',
            borderRadius: '6px',
            background: 'rgba(8, 11, 16, 0.92)',
            border: '1px solid rgba(120, 140, 170, 0.22)',
          },
        },
        h('div', { style: { fontSize: '12px', fontWeight: 600 } }, project.label),
        h('div', { style: { fontSize: '11px', color: status.color } }, status.text),
        // ★ 差什么**列出来** —— "没通"必须可执行，否则用户只能猜
        project.missing.length > 0 && project.imported
          ? h(
              'div',
              {
                style: { fontSize: '10px', color: 'rgba(200,210,225,0.6)', whiteSpace: 'pre-line', lineHeight: 1.5 },
                title: missing,
              },
              missing,
            )
          : null,
        h(
          'button',
          {
            type: 'button',
            disabled: props.disabled,
            onClick: () => props.onSwitch(project.id),
            title: `${project.description}\n\n点击：清空当前场景，换成这个项目的器件与接线`,
            style: {
              padding: '5px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(120, 140, 170, 0.35)',
              background: props.disabled ? 'rgba(60,70,85,0.5)' : 'rgba(52, 92, 140, 0.9)',
              color: 'inherit',
              font: 'inherit',
              cursor: props.disabled ? 'not-allowed' : 'pointer',
            },
          },
          project.imported ? '重新切换到此项目' : '切换到该项目（换掉当前硬件）',
        ),
      ),
    )
  }
  if (body.length === 0) {
    body.push(
      h('div', { key: '__empty', style: { fontSize: '11px', opacity: 0.6 } }, '（没有内置项目）'),
    )
  }

  return h(
    Panel,
    {
      title: '③ 项目（一键换整套硬件）',
      subtitle: '点一下：清空场景，换成该项目真实的器件与接线',
    },
    ...body,
  )
}
