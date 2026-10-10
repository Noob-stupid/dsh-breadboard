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
import { SAMPLE_PROJECTS, type ProjectStatus } from '../contracts/projects.ts'
import { Panel } from './hud.ts'

export interface ProjectPanelProps {
  /** 切换到这个项目（走 `import_project` 动作，与工具同一条路）。 */
  readonly onSwitch: (projectId: string) => void
  readonly disabled: boolean
  /** 装配 revision —— 变了就重新拉一次状态（导入之后连通性会变）。 */
  readonly revision: number
}

/** 调 `POST /api/projects` 的两种操作。返回**人话错误**（失败要说清，不能静默）。 */
async function callProjects(
  op: 'import-sample' | 'delete',
  projectId: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(HTTP_ROUTES.projects, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, projectId }),
    })
    const body = (await response.json()) as { ok?: boolean; reason?: string }
    if (body.ok === true) return undefined
    return body.reason ?? `HTTP ${String(response.status)}`
  } catch (error) {
    return String(error)
  }
}

export function ProjectPanel(props: ProjectPanelProps) {
  const [projects, setProjects] = useState<readonly ProjectStatus[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** 增删之后要让 `useEffect` 重跑 —— 项目文件在磁盘上变了。 */
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const run = (op: 'import-sample' | 'delete', projectId: string): void => {
    setBusy(`${op}:${projectId}`)
    void callProjects(op, projectId).then((error) => {
      setBusy(undefined)
      if (error !== undefined) {
        // ★ 失败**必须说出来** —— 静默的话用户以为成功了，而磁盘上什么都没发生
        setFailure(`${op} 失败：${error}`)
        return
      }
      setFailure(undefined)
      setNonce((n) => n + 1)
    })
  }

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
  }, [props.revision, nonce])

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
        // ★ **删除** —— 项目是用户自己的文件，他当然要能删掉。
        //   ⚠️ 删除**只删项目定义**（那份 JSON），**不动场景**：
        //     正在跑的装配与"以后还能不能再切回来"是两件事。
        //     顺手清场会让"我只是想删掉这个项目"变成"我的硬件也没了"。
        h(
          'button',
          {
            type: 'button',
            disabled: props.disabled || busy !== undefined,
            onClick: () => run('delete', project.id),
            title: '把这个项目的定义从你的项目目录里删掉（不影响当前场景）',
            style: {
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(180, 110, 110, 0.4)',
              background: 'rgba(70, 40, 40, 0.75)',
              color: 'inherit',
              font: 'inherit',
              fontSize: '11px',
              cursor: props.disabled ? 'not-allowed' : 'pointer',
            },
          },
          busy === `delete:${project.id}` ? '删除中…' : '删除此项目',
        ),
      ),
    )
  }

  // ★★ **导入样例** —— 用户原话：「**咋没有导入选项按钮呢**」
  //
  //   项目默认是**空的**（别人的插件不该带着我们的智座）。空列表旁边必须有个
  //   "从哪开始"的入口，否则用户面对空白不知道下一步做什么。
  //   ⇒ 把随包样例列出来，**只有他点了才落盘**（启动时绝不自动写）。
  const importedIds = new Set(projects.map((project) => project.id))
  const samples = Object.values(SAMPLE_PROJECTS).filter((sample) => !importedIds.has(sample.id))
  if (samples.length > 0) {
    body.push(
      h(
        'div',
        {
          key: '__samples',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '5px',
            paddingTop: '4px',
            borderTop: '1px solid rgba(120, 140, 170, 0.18)',
          },
        },
        h(
          'div',
          { style: { fontSize: '11px', opacity: 0.7, lineHeight: 1.5 } },
          '可选样例（点了才加进你的项目）：',
        ),
        ...samples.map((sample) =>
          h(
            'button',
            {
              key: sample.id,
              type: 'button',
              disabled: props.disabled || busy !== undefined,
              onClick: () => run('import-sample', sample.id),
              title: `${sample.description}\n\n来源：${sample.projectPathHint ?? '随包样例'}`,
              style: {
                textAlign: 'left',
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(120, 140, 170, 0.3)',
                background: 'rgba(40, 50, 66, 0.9)',
                color: 'inherit',
                font: 'inherit',
                fontSize: '11px',
                cursor: props.disabled ? 'not-allowed' : 'pointer',
              },
            },
            busy === `import-sample:${sample.id}` ? '导入中…' : `＋ 导入样例：${sample.label}`,
          ),
        ),
      ),
    )
  }

  if (body.length === 0) {
    body.push(
      h(
        'div',
        { key: '__empty', style: { fontSize: '11px', opacity: 0.7, lineHeight: 1.5 } },
        '你还没有任何项目。用 agent 建一个（hw_save_project），或导入上面的样例。',
      ),
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
