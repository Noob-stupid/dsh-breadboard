/**
 * **项目切换面板** —— owner: session-24ca6e69
 * @module dsh-breadboard/client/project-panel
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

/**
 * 一个**建模组**里挑出来的、要送进模型库的文件。
 *
 * ★ 布局与插件自己的 `models/` 目录**同一套**：
 *   `<建模组>/<型号键>/model.glb` —— 子文件夹名就是型号键。
 *   ⇒ "导出建模组"与"导入建模组"是同一套布局的往返，**不需要另定格式**。
 */
export interface ModelSetFile {
  /** 型号键（子文件夹名）。 */
  readonly modelKey: string
  readonly file: File
}

/**
 * **项目本体扫描报告** —— 导入项目文件夹后，宿主扫出来的"它需要哪些硬件"。
 *
 * ★★ 用户工作流第②步的产物：
 *   > 导入项目后可以**扫描看看项目需求硬件建模**，根据这个干建模，
 *   > 如果网上有建模自己导入不了就**写个清单发给用户**，没有就**自己建模没有的部分**
 *
 * ★ `evidence` 是**在哪几个文件里看到的** —— 有了它用户才能自己判断对不对。
 *   没有证据的结论在这里等于没有结论。
 */
export interface ProjectScanReport {
  readonly fileCount: number
  readonly matched: readonly {
    readonly modelKey: string
    readonly label: string
    readonly hasGeometry: boolean
    readonly evidence: readonly string[]
  }[]
  readonly missingGeometry: readonly string[]
  /**
   * 因为**总预算**被跳过的文件数。
   *
   * ★ 如实报出来：请求体有上限（服务端 256KB），超出就得截断 ——
   *   而**静默截断等于骗人**（用户会以为"整个项目都扫过了"）。
   */
  readonly skipped: number
}

/**
 * **项目本体**在界面上的样子（服务端 `ProjectBody` 的视图）。
 *
 * ★ 用户原话：「上传项目本体，你**上传后那得显示项目啊**，
 *   那个扫描可以**后续扫描按钮**，**先上传项目到那里**」
 */
export interface ProjectBodyView {
  readonly id: string
  readonly label: string
  /** 用户选的那个文件夹名（如 `MAX_xiangmu`）。 */
  readonly source: string
  readonly importedAt: string
  readonly fileCount: number
  readonly skipped: number
  readonly report?: {
    readonly matched: readonly {
      readonly modelKey: string
      readonly label: string
      readonly hasGeometry: boolean
      readonly evidence: readonly string[]
    }[]
    readonly missingGeometry: readonly string[]
  }
}

export interface ProjectPanelProps {
  /** 切换到这个项目（走 `import_project` 动作，与工具同一条路）。 */
  readonly onSwitch: (projectId: string) => void
  readonly disabled: boolean
  /** 装配 revision —— 变了就重新拉一次状态（导入之后连通性会变）。 */
  readonly revision: number
  /**
   * **导入项目本体**：一个**完整的前后端项目文件夹**（如 `D:\MAX_xiangmu`）。
   *
   * ★★ 用户原话：
   *   > 导入项目肯定是**完整前后端那个完整项目文件夹**啊
   *   > 就是类似**先导入不带建模的 MAX_xiangmu 本体**
   *
   *   ⇒ 收的是**整个文件夹的文件清单**，由宿主**扫描出它需要哪些硬件**。
   *     ⚠️ 第一版把它做成了"选一个 .json" —— **根本性的理解错误**：
   *       项目本体是**一个真实项目**，不是我们编的一份配置文件。
   * 返回**人话原因**（`undefined` = 成功）。
   */
  readonly onImportProjectFolder: (files: readonly File[]) => Promise<string | undefined>
  /**
   * **导入建模组**：一个文件夹，里面按型号分（`<型号键>/model.glb`）。
   *
   * ★ 用户原话：「导入建模肯定是**已经保存好的完整建模组**啊」
   *   —— 不是单个 `.glb`，是**一组**。
   */
  readonly onImportModelSet: (files: readonly File[]) => Promise<string | undefined>
  /** 项目本体扫描报告（导入项目文件夹后才有）。 */
  readonly scanReport?: ProjectScanReport
  /** **导入建模组时"只补缺"**（默认关 = 换装/覆盖）。 */
  readonly onlyMissingImport: boolean
  readonly onToggleOnlyMissingImport: (value: boolean) => void
  /**
   * **导出建模组** —— 把整套建模存成**一个 JSON 文件**。
   *
   * ★ 用户原话："导出**完整**建模…建模里有 abc 组合，下次导入进来**还是一样的**"。
   *   所以这个动作打包的是**当前模型库里的全部几何**，不是某一个型号。
   */
  readonly onExportModelSet: () => Promise<string | undefined>
  /**
   * **加一个型号定义**（选一个 `.json`）—— 把"加板子"变成界面动作。
   *
   * ★ 为什么要有它：数据驱动型号虽然只加一条数据，但**要用户自己找到
   *   `model-defs/` 目录再把文件放进去** —— 对多数人来说这条路根本不存在。
   *   有了这个入口，第三方加板子才真的只是"选个文件"。
   *
   * ★ 返回人话错误（校验失败要说清是哪个字段 —— 那是写定义的人唯一能拿到的线索）。
   */
  readonly onAddModelDef: (file: File) => Promise<string | undefined>
  /**
   * **让 agent 一键写型号定义**：把一句提示词发进当前会话。
   *
   * ★ 为什么按钮走"发消息"而不是直接调工具：**写定义是 agent 的活**
   *   （查手册、对齐字段、按丝印排布），界面只负责把它叫起来、并把纪律说清。
   */
  readonly onAskAgent: (text: string) => Promise<string | undefined>
}

/** 调 `POST /api/projects` 的两种操作。返回**人话错误**（失败要说清，不能静默）。 */
async function callProjects(
  op: 'import-sample' | 'delete' | 'save' | 'save-scene' | 'scan-body' | 'delete-body',
  projectId: string,
  profile?: unknown,
): Promise<string | undefined> {
  try {
    const response = await fetch(HTTP_ROUTES.projects, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ★ scan-body / delete-body 认的是 odyId，不是 projectId ——
      //   两者是不同的东西（本体 vs 装配图纸），传错会**静默找不到**。
      body: JSON.stringify({
        op,
        ...(op === 'scan-body' || op === 'delete-body' ? { bodyId: projectId } : { projectId }),
        ...(profile !== undefined ? { profile } : {}),
      }),
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
  /**
   * **项目本体**（用户上传的真实项目文件夹）。
   *
   * ★ 用户原话：「上传项目本体，你**上传后那得显示项目啊**」——
   *   所以它必须**进列表**，而不是"扫完就没影了"。
   */
  const [bodies, setBodies] = useState<readonly ProjectBodyView[]>([])
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /** 「让 agent 帮我写」里填的型号名。 */
  const [defHint, setDefHint] = useState('')
  /** 增删之后要让 `useEffect` 重跑 —— 项目文件在磁盘上变了。 */
  const [nonce, setNonce] = useState(0)
  const [busy, setBusy] = useState<string | undefined>(undefined)

  const run = (
    op: 'import-sample' | 'delete' | 'save-scene' | 'scan-body' | 'delete-body',
    projectId: string,
  ): void => {
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
        const payload = (await response.json()) as {
          projects?: ProjectStatus[]
          bodies?: ProjectBodyView[]
        }
        if (alive) {
          setProjects(payload.projects ?? [])
          setBodies(payload.bodies ?? [])
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
        // ★★ **建模台账** —— 用户要的："切成 B 项目，如果还没建模，那就是 B 对空建模待建"
        //
        //   切换项目看的**不是**全局模型库，而是**这个项目**要哪些型号、现在有没有：
        //   ✅ = 库里有几何；❌ = **待建**（场景里那个器件现在是占位盒）。
        //   ⇒ 缺的必须**点名**，否则用户只知道"好像不对"，不知道怎么修。
        project.modelNeeds.length > 0
          ? h(
              'div',
              {
                key: '__ledger',
                style: { fontSize: '10px', lineHeight: 1.5, whiteSpace: 'pre-line' },
                title:
                  '这个项目的建模台账：✅ 已有几何 / ❌ 待建（场景里显示为占位盒）\n' +
                  (project.missingModels.length > 0
                    ? `缺：${project.missingModels.join('、')}`
                    : '需要的型号都已有几何'),
              },
              project.modelNeeds
                .map((need) => `${need.hasGeometry ? '✅' : '❌'} ${need.label}`)
                .join('\n'),
            )
          : null,
        project.missingModels.length > 0
          ? h(
              'div',
              { style: { fontSize: '10px', color: '#ffc46b', lineHeight: 1.4 } },
              `建模待建：${project.missingModels.join('、')} —— 先查网上有没有现成的，导不进来就列清单，没有就让 agent 建`,
            )
          : null,
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
        // ★★ **保存当前装配** —— 用户原话：「关键是在**哪把现有建模导出保存**」
        //
        //   在此之前只能**导入**图纸、**导不出去**：在场景里摆好连好之后，
        //   没有任何办法把它存下来 —— **能看不能存**。
        //   这个按钮把**眼前这套装配**（器件位置/朝向/接线/绑定）写回项目文件。
        //
        // ★ 存的是**当前场景**，不是文件里那份：用户可能刚挪了器件、加了线，
        //   从文件读等于把他刚做的事全丢掉。
        h(
          'button',
          {
            type: 'button',
            disabled: props.disabled || busy !== undefined,
            onClick: () => run('save-scene', project.id),
            title:
              '把当前场景里这套装配（器件位置、朝向、接线、联网绑定）存回这个项目。\n' +
              '存完可以点「导出（另存为…）」拿走文件。',
            style: {
              padding: '5px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(120, 170, 130, 0.45)',
              background: 'rgba(38, 70, 50, 0.85)',
              color: 'inherit',
              font: 'inherit',
              cursor: props.disabled ? 'not-allowed' : 'pointer',
            },
          },
          busy === `save-scene:${project.id}` ? '保存中…' : '保存当前装配到此项目',
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
  // ★★ **扫描报告** —— 用户工作流第②步的产物，必须显示出来（扫了不显示等于没扫）
  if (props.scanReport !== undefined) {
    const report = props.scanReport
    body.push(
      h(
        'div',
        {
          key: '__scan',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
            padding: '7px',
            borderRadius: '6px',
            background: 'rgba(24, 40, 32, 0.9)',
            border: '1px solid rgba(120, 200, 150, 0.3)',
            fontSize: '11px',
            lineHeight: 1.5,
          },
        },
        h(
          'div',
          { style: { fontWeight: 600 } },
          `扫描了 ${String(report.fileCount)} 个文件` +
            (report.skipped > 0 ? `（另有 ${String(report.skipped)} 个因体积上限跳过）` : '') +
            '，这个项目看起来需要：',
        ),
        ...report.matched.map((item) =>
          h(
            'div',
            { key: item.modelKey, title: `证据（在哪几个文件里看到的）：${item.evidence.join('、')}` },
            `${item.hasGeometry ? '✅' : '❌'} ${item.label}（${item.modelKey}）` +
              (item.hasGeometry ? '' : ' —— 还没有几何'),
          ),
        ),
        report.missingGeometry.length > 0
          ? h(
              'div',
              { style: { marginTop: '3px', color: '#ffc46b' } },
              `缺几何的：${report.missingGeometry.join('、')}` +
                ' —— 网上有就导入建模组；没有就让 agent 按这个清单建模。',
            )
          : h('div', { style: { marginTop: '3px', color: '#7ee0a0' } }, '需要的型号都已有几何 ✓'),
      ),
    )
  }

  // ★★ **项目本体列表** —— 用户原话：
  //
  //   > 这个上传项目本体，你**上传后那得显示项目啊**，
  //   > 那个扫描可以**后续扫描按钮**，**先上传项目到那里**
  //
  //   ⇒ 上传后**进列表**（看得见、有名字、有文件数），
  //     扫描是它自己的一个按钮 —— 而不是"一上传就扫、扫完就没影了"。
  if (bodies.length > 0) {
    body.push(
      h(
        'div',
        {
          key: '__bodies',
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            paddingTop: '4px',
            borderTop: '1px solid rgba(120, 140, 170, 0.18)',
          },
        },
        h('div', { style: { fontSize: '11px', opacity: 0.7 } }, '已上传的项目本体：'),
        ...bodies.map((item) =>
          h(
            'div',
            {
              key: item.id,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: '4px',
                padding: '7px',
                borderRadius: '6px',
                background: 'rgba(20, 26, 36, 0.92)',
                border: '1px solid rgba(120, 140, 170, 0.22)',
              },
            },
            h('div', { style: { fontSize: '12px', fontWeight: 600 } }, item.source),
            h(
              'div',
              { style: { fontSize: '10px', opacity: 0.6 } },
              `${String(item.fileCount)} 个文件` +
                (item.skipped > 0 ? `（采样时跳过 ${String(item.skipped)} 个）` : '') +
                ` · ${item.importedAt.slice(0, 19).replace('T', ' ')}`,
            ),
            // 扫描结果（扫过才有）
            item.report === undefined
              ? h('div', { style: { fontSize: '10px', opacity: 0.55 } }, '还没扫描过')
              : h(
                  'div',
                  { style: { fontSize: '10px', lineHeight: 1.5 } },
                  ...item.report.matched.map((hit) =>
                    h(
                      'div',
                      { key: hit.modelKey, title: `证据：${hit.evidence.join('、')}` },
                      `${hit.hasGeometry ? '✅' : '❌'} ${hit.label}`,
                    ),
                  ),
                  item.report.missingGeometry.length > 0
                    ? h(
                        'div',
                        { style: { color: '#ffc46b' } },
                        `缺几何：${item.report.missingGeometry.join('、')}`,
                      )
                    : h('div', { style: { color: '#7ee0a0' } }, '需要的型号都已有几何 ✓'),
                ),
            h(
              'div',
              { style: { display: 'flex', gap: '5px' } },
              h(
                'button',
                {
                  type: 'button',
                  disabled: props.disabled || busy !== undefined,
                  onClick: () => run('scan-body', item.id),
                  title: '扫描这个项目的文件，得出它需要哪些硬件、以及哪些还缺几何',
                  style: {
                    flex: '1',
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(120, 170, 200, 0.4)',
                    background: 'rgba(36, 56, 76, 0.9)',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: '11px',
                    cursor: props.disabled ? 'not-allowed' : 'pointer',
                  },
                },
                busy === `scan-body:${item.id}` ? '扫描中…' : '扫描需求',
              ),
              h(
                'button',
                {
                  type: 'button',
                  disabled: props.disabled || busy !== undefined,
                  onClick: () => run('delete-body', item.id),
                  title: '把这个本体从列表里删掉（不影响别的东西）',
                  style: {
                    padding: '5px 8px',
                    borderRadius: '6px',
                    border: '1px solid rgba(180, 110, 110, 0.4)',
                    background: 'rgba(70, 40, 40, 0.75)',
                    color: 'inherit',
                    font: 'inherit',
                    fontSize: '11px',
                    cursor: props.disabled ? 'not-allowed' : 'pointer',
                  },
                },
                '删除',
              ),
            ),
          ),
        ),
      ),
    )
  }

  body.push(
    h(
      'div',
      {
        key: '__import-row',
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          paddingTop: '4px',
          borderTop: '1px solid rgba(120, 140, 170, 0.18)',
        },
      },
      // ── ① 导入**项目本体**（一个文件夹，如 `D:\MAX_xiangmu`）──
      //
      // ★★ 用户原话：
      //
      //   > **导入项目肯定是完整前后端那个完整项目文件夹啊**
      //   > 你懂吗，就是类似**先导入不带建模的 MAX_xiangmu 本体**
      //
      //   ⇒ 选的**不是** `.json`，是**真实项目文件夹**（前后端 + 硬件代码都在里面）。
      //     它**不带建模** —— 建模是另一件事，由「导入建模组」负责。
      //
      // ★ 扫描的原料：`webkitdirectory` 会给出**相对路径 + 文件内容**。
      //   我们只挑**小而关键**的文本文件（配置 / 源码 / 文档）送过去扫，
      //   而不是把整个文件夹（可能带 node_modules）灌进去 ——
      //   那既慢，又会把"这个项目需要什么硬件"淹在噪声里。
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
            '选一个完整的项目文件夹（前后端 + 硬件代码，如 D:\\MAX_xiangmu）。\n' +
            '它不带建模 —— 导入后会扫描出"这个项目需要哪些硬件"，再配建模。',
        },
        busy === 'project:dir' ? '扫描中…' : '＋ 导入项目本体（选文件夹）',
        h('input', {
          type: 'file',
          webkitdirectory: 'true',
          directory: 'true',
          multiple: true,
          disabled: props.disabled || busy !== undefined,
          style: { display: 'none' },
          onChange: (event: { target?: { files?: FileList | null } }) => {
            const files = Array.from(event.target?.files ?? [])
            if (files.length === 0) return
            setBusy('project:dir')
            void props.onImportProjectFolder(files).then((error) => {
              setBusy(undefined)
              if (error !== undefined) setFailure(`项目导入失败：${error}`)
              else setNonce((n) => n + 1)
            })
          },
        }),
      ),
      // ── ② 导入**建模组**（一个文件夹，里面按型号分）──
      //
      // ★★ 用户原话：「**导入建模肯定是已经保存好的完整建模组啊**」
      //   —— 不是单个 `.glb`，是**一组**。
      //
      // ★ 所以选的是**文件夹**（`webkitdirectory`），布局与插件自己的
      //   `models/` 目录**同一套**：
      //
      // ```
      //   我的建模组/
      //     hc-sr501/         ← 子文件夹名 = 型号键
      //       model.glb
      //     esp32-seat-sensor/
      //       model.glb
      // ```
      //
      //   ⇒ "导出建模组"与"导入建模组"就是同一套布局的往返，**不需要另定格式**。
      //
      // ★★ **"只补缺"开关**（用户批准）：默认关 = 换装（覆盖同键）。
      //   打开 = 库里有几何的型号**跳过不动** —— 给 B 项目补缺口时
      //   **不误伤 A 已建好的同键模型**（两个项目共用通用主控时很要命）。
      h(
        'label',
        {
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '5px',
            fontSize: '10px',
            opacity: 0.85,
            cursor: props.disabled ? 'not-allowed' : 'pointer',
          },
          title:
            '勾上：只补缺 —— 已有几何的型号跳过不动（给 B 补缺口不会误伤 A）。\n' +
            '不勾（默认）：换装 —— 同键已有几何会被替换（你明确要换掉某个型号时才用）。',
        },
        h('input', {
          type: 'checkbox',
          checked: props.onlyMissingImport,
          disabled: props.disabled,
          onChange: (event: { target?: { checked?: boolean } }) =>
            props.onToggleOnlyMissingImport(event.target?.checked === true),
        }),
        '只补缺（不覆盖已有几何的型号）',
      ),
      // ── ★ **导出建模组（另存为一个 .json）** ──
      //
      //   用户原话：「这个是直接导出**完整**建模吧，比如建模里有 abc 组合，
      //   下次导入进来**还是一样的**，是保存那个**建模整体**」
      //   ⇒ 打包的是**当前模型库里的全部几何**，一个文件装走、一个文件导回。
      //
      //   ⚠️ 这里**故意没有**"选文件夹导入" ——
      //     用户指出它与 ②「换装模型」里**单型号的「导入」是同一件事**
      //     （还得自己按型号分文件夹），**是多余的**。
      //     建模的整套搬运只走 .json 这一条路：一个文件装走、一个文件送回。
        //     ⇒ 导入/导出各一个控件，各自 accept 各自的形态。
        h(
          'button',
          {
            type: 'button',
            disabled: props.disabled || busy !== undefined,
            onClick: () => {
              setBusy('model:export')
              void props.onExportModelSet().then((error) => {
                setBusy(undefined)
                if (error !== undefined) setFailure(`导出建模组失败：${error}`)
              })
            },
            style: {
              padding: '6px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(120, 170, 200, 0.4)',
              background: 'rgba(36, 56, 76, 0.9)',
              color: 'inherit',
              font: 'inherit',
              fontSize: '11px',
              cursor: props.disabled || busy !== undefined ? 'not-allowed' : 'pointer',
            },
            title:
              '把当前模型库里的全部建模打包成一个 .json 文件（几何以 base64 装在里面）。\n' +
              '保存位置在弹出的对话框里选；下次用「导入建模组（.json）」即可原样导回。',
          },
          busy === 'model:export' ? '导出中…' : '⤓ 导出建模组（存成一个 .json）',
        ),
        // ── ★ **导入建模组（.json）** —— 与上面"选文件夹"是两条路 ──
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
            title: '导入「导出建模组」产出的那个 .json（一整套几何原样回来）',
          },
          busy === 'model:json' ? '导入中…' : '＋ 导入建模组（选 .json）',
          h('input', {
            type: 'file',
            accept: '.json,application/json',
            disabled: props.disabled || busy !== undefined,
            style: { display: 'none' },
            onChange: (event: { target?: { files?: FileList | null } }) => {
              const files = Array.from(event.target?.files ?? [])
              if (files.length === 0) return
              setBusy('model:json')
              void props.onImportModelSet(files).then((error) => {
                setBusy(undefined)
                if (error !== undefined) setFailure(`建模组导入失败：${error}`)
                else setNonce((n) => n + 1)
              })
            },
          }),
        ),
        // ── ★ **加一个型号定义**（选一个 .json）──────────────────────────────
        //
        //   ★ 这是"加一块板子 = 只加数据"真正落到**用户手上**的一步：
        //     没有它，用户得自己找到 `model-defs/` 目录再把文件拷进去 ——
        //     对多数人来说这条路根本不存在，机制再漂亮也用不上。
        //   ★ 宿主侧顺序是**先校验再落盘**：坏定义不会被写进目录，
        //     所以这里失败时只需把原因显示出来（带字段路径），文件没落地。
        h(
          'label',
          {
            style: {
              display: 'block',
              textAlign: 'center',
              padding: '6px 8px',
              borderRadius: '6px',
              border: '1px dashed rgba(150, 200, 150, 0.45)',
              background: 'rgba(28, 40, 32, 0.9)',
              fontSize: '11px',
              cursor: props.disabled || busy !== undefined ? 'not-allowed' : 'pointer',
            },
            title:
              '加一个型号定义（.json）：告诉插件「这块板子有几个脚、每个脚是什么」。\n' +
              '校验通过才落盘，立即生效；内置型号不可覆盖。\n' +
              '★ 引脚表要有权威来源（数据手册 / PlatformIO 的 variant 文件）—— 格式见 model-defs/example-8pin-module.json。',
          },
          busy === 'model:def' ? '添加中…' : '＋ 添加型号定义（选 .json）',
          h('input', {
            type: 'file',
            accept: '.json,application/json',
            disabled: props.disabled || busy !== undefined,
            style: { display: 'none' },
            onChange: (event: { target?: { files?: FileList | null } }) => {
              const file = event.target?.files?.[0]
              if (file === undefined) return
              setBusy('model:def')
              void props.onAddModelDef(file).then((error) => {
                setBusy(undefined)
                if (error !== undefined) setFailure(`型号定义未添加：${error}`)
                else setNonce((n) => n + 1)
              })
            },
          }),
        ),
        // ── ★★ **让 agent 一键写**（P0.3 的第二条路）──────────────────────
        //
        //   ★ 为什么需要它：界面那个入口要用户**自己准备好 JSON**，
        //     而查手册、对齐字段、按丝印排布这件事 **AI 比人快**。
        //   ★ 但 agent 必须有**工具**才写得了（`hw_save_model_definition`），
        //     否则这个按钮只是一句话术：**用户点了，agent 没有手**。
        //   ★ 提示词里写死了纪律：**要有权威来源，找不到就来问** ——
        //     不许它凭记忆编一个"看起来合理"的引脚顺序。
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
          h('input', {
            value: defHint,
            placeholder: '要加的板子（如 STM32F103C8T6 / ESP32-S3-DevKitC）',
            onChange: (event: { target?: { value?: string } }) => setDefHint(event.target?.value ?? ''),
            style: {
              padding: '3px 5px',
              borderRadius: '4px',
              border: '1px solid rgba(120, 140, 170, 0.35)',
              background: 'rgba(10, 14, 20, 0.9)',
              color: 'inherit',
              font: 'inherit',
              fontSize: '11px',
              width: '100%',
            },
            title: '写上型号名，agent 会去查权威来源再写；不写就让它先问你',
          }),
          h(
            'button',
            {
              type: 'button',
              disabled: props.disabled === true,
              onClick: () => {
                const target = defHint.trim() === '' ? '（我问你型号）' : defHint.trim()
                void props.onAskAgent(
                  `帮我给「${target}」写一个型号定义（数据驱动）并用 hw_save_model_definition 装上。\n` +
                    '要求：\n' +
                    '1. 引脚表**必须有权威来源** —— 优先查本机 PlatformIO 的 variant 文件（pins_arduino.h）、' +
                    '厂商数据手册，或项目自己的工程文件（platformio.ini / .ioc / sdkconfig）。\n' +
                    '2. **找不到权威来源就停下来问我**，不要凭记忆编一个看起来合理的引脚顺序 —— ' +
                    '错的引脚表比没有更坏（会产出"看起来对但接错脚"的校验）。\n' +
                    '3. 写的时候说明来源是什么；写完告诉我怎么摆进场景。\n' +
                    '格式参考 model-defs/example-8pin-module.json。',
                )
              },
              style: {
                padding: '5px 8px',
                borderRadius: '6px',
                border: '1px solid rgba(150, 200, 150, 0.45)',
                background: 'rgba(28, 40, 32, 0.9)',
                color: 'inherit',
                font: 'inherit',
                fontSize: '11px',
                cursor: props.disabled === true ? 'not-allowed' : 'pointer',
              },
              title:
                '让 agent 查权威来源后写一条定义并装上。\n' +
                '它找不到来源时会来问你（不会凭记忆编）。\n' +
                '★ 内置型号不可覆盖；写入的是用户目录 model-defs/。',
            },
            '✎ 让 agent 帮我写',
          ),
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
        // ★ 写**用户看得懂的话**。
        //   ⚠️ 第一版这里写的是"或让 agent 用 hw_save_project 建一个" ——
        //     那是**工具名**，对用户毫无意义（用户原话："这句话是什么意思"）。
        //     ⇒ 面向用户的文案里**不出现内部工具名**；那些话属于 Skill，不属于界面。
        '还没有项目。点下面的按钮，选一个 .json 文件就能加进来。',
      ),
    )
  }

  return h(
    Panel,
    {
      title: '③ 项目（一键换整套硬件）',
      subtitle: '点一下：清空场景，换成该项目真实的器件与接线',
      // ★ **默认收起**（用户 2026-10-16 明确：「所有面板默认都是收起的」）——
      //   之前只有 ③ 是展开的，四个面板一起展开会占掉半个屏幕。
      //   主操作仍是 ③，所以它排在面板列的最前面（收起不等于靠后）。
      defaultOpen: false,
    },
    ...body,
  )
}
