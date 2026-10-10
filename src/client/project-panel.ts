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

/** 调 `POST /api/projects` 的两种操作。返回**人话错误**（失败要说清，不能静默）。 */
async function callProjects(
  op: 'import-sample' | 'delete' | 'save',
  projectId: string,
  profile?: unknown,
): Promise<string | undefined> {
  try {
    const response = await fetch(HTTP_ROUTES.projects, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ op, projectId, ...(profile !== undefined ? { profile } : {}) }),
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
        // ★★ **导出（另存为…）** —— 用户原话：「这个也能**选择路径保存**」
        //
        //   用浏览器的下载：**保存位置由用户在那个对话框里选** ——
        //   这正是"选择路径保存"的标准做法。
        // ⚠️ 不要自绘"路径输入框"：浏览器**拿不到真实路径**（安全限制），
        //   最后还是要用户手打，而手打路径正是"看着能用其实用不了"的典型。
        h(
          'button',
          {
            type: 'button',
            onClick: () => {
              const payload = { format: 1, profile: project.profile }
              const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], {
                type: 'application/json',
              })
              const url = URL.createObjectURL(blob)
              const anchor = document.createElement('a')
              anchor.href = url
              anchor.download = `${project.id}.json`
              anchor.click()
              // ★ 立刻回收：不回收的话这份 blob 会一直挂在内存里（每导出一次多一份）
              URL.revokeObjectURL(url)
            },
            title: '导出成 .json —— 保存位置在弹出的对话框里选',
            style: {
              padding: '4px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(120, 140, 170, 0.35)',
              background: 'rgba(40, 50, 66, 0.9)',
              color: 'inherit',
              font: 'inherit',
              fontSize: '11px',
              cursor: 'pointer',
            },
          },
          '导出（另存为…）',
        ),
      ),
    )
  }

  // ★★ **导入项目文件** —— 用户原话：
  //
  //   > 导入**不用样例**，而且……应该是能**选择切换文件项目，打开文件夹选**啊
  //
  //   对：项目是**别人的东西**，凭什么只能从我们的样例里挑。
  //   ⇒ 一个 `<input type="file">` —— 点开就是系统的文件选择框，
  //     用户挑自己那份 `.json`（手写的、同事给的、agent 生成的都行）。
  //
  // ★ 用原生 file input 而不是自绘一个"路径输入框"：
  //   自绘那个在浏览器里**拿不到真实路径**（安全限制），最后还是要用户手打路径 ——
  //   而手打路径正是"看着能用其实用不了"的典型。
  body.push(
    h(
      'div',
      {
        key: '__import-file',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '5px',
          paddingTop: '4px',
          borderTop: '1px solid rgba(120, 140, 170, 0.18)',
        },
      },
      h(
        'label',
        {
          style: {
            display: 'block',
            textAlign: 'center',
            padding: '6px 8px',
            borderRadius: '6px',
            border: '1px dashed rgba(120, 140, 170, 0.45)',
            background: 'rgba(30, 38, 50, 0.9)',
            fontSize: '11px',
            cursor: props.disabled || busy !== undefined ? 'not-allowed' : 'pointer',
          },
          title:
            '选一个项目定义文件（.json）。\n' +
            '格式：{ "id": "...", "label": "...", "parts": [...], "wires": [...], ' +
            '"networkComponentId": "...", "network": {...} }',
        },
        busy === 'save:file' ? '导入中…' : '＋ 导入项目文件（打开文件夹选 .json）',
        h('input', {
          type: 'file',
          accept: '.json,application/json',
          disabled: props.disabled || busy !== undefined,
          style: { display: 'none' },
          onChange: (event: { target?: { files?: FileList | null } }) => {
            const file = event.target?.files?.[0]
            if (file === undefined) return
            setBusy('save:file')
            void file
              .text()
              .then((text) => {
                let parsed: unknown
                try {
                  parsed = JSON.parse(text)
                } catch {
                  // ★ 解析失败要说清是"这个文件不是 JSON"，而不是笼统的失败
                  setBusy(undefined)
                  setFailure(`导入失败：${file.name} 不是合法 JSON`)
                  return
                }
                // 兼容带 format 包装的文件：{ format: 1, profile: {...} }
                const box = parsed as { profile?: unknown }
                return callProjects('save', '', box.profile ?? parsed)
              })
              .then((error) => {
                if (error === undefined) return
                setBusy(undefined)
                setFailure(`导入失败：${error}`)
              })
              .then(() => {
                setBusy(undefined)
                setNonce((n) => n + 1)
              })
          },
        }),
      ),
    ),
  )

  // ★★ 空态提示 —— **条件必须是 `projects.length`，不能是 `body.length`**
  //
  //   ⚠️ 原来写的是 `if (body.length === 0)`，而"导入文件"那个按钮是**无条件**
  //     推进 body 的 ⇒ **这个条件永远不成立** ⇒ 空态提示**永远不显示**。
  //     用户看到的就是一个**孤零零的导入按钮**，然后问"我怎么没看见切换项目的按钮"。
  //
  //   ⇒ 一个列表为空时，**必须有一句话说明"为什么空、下一步做什么"**。
  //     否则用户会以为功能坏了 —— 而这正是本次的经过。
  if (projects.length === 0) {
    body.unshift(
      h(
        'div',
        { key: '__empty', style: { fontSize: '11px', opacity: 0.75, lineHeight: 1.6 } },
        '你还没有任何项目 —— 所以这里没有可切换的东西。',
        h('br'),
        '用下面的「导入项目文件」加一个（.json），或让 agent 用 hw_save_project 建一个。',
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
