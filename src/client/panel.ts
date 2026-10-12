/**
 * `main` 槽（中央面板）：3D 场景 + 交互层 + HUD + 模型导入。
 *
 * 组成（各司其职）：
 *   · `SceneHost`             —— 渲染管线（相机 / rAF / 视口）
 *   · `SnapshotChannel`       —— 与宿主 SSOT 的通道（HTTP + WS）
 *   · `SceneSyncLayer`        —— 把快照**投影**成场景图
 *   · `InteractionLayer`      —— 交互控制（§4.2.2）：添加 / 拖动 / 磁吸连线 / 拔线
 *   · `ModelRegistry` + `ImportedModelProvider` —— 用户导入的几何（换装占位盒）
 *
 * 组件是**纯 React 函数组件**（`(props) => ReactNode`），不用 JSX —— 前端产物无 JSX 变换，
 * 一律 `React.createElement`。生命周期严格绑到 React：mount 建、unmount 拆。
 *
 * ★ 铁律①（公约盒 `cv-muxwsfeb-s7frhb`）：面板只是观察窗与操作入口，**不持有业务状态** ——
 *   交互层的本地跟手在松手时一律发 action；动作结束（无论成败）按 SSOT 重调和（见 `onActionSettled`）。
 * ★ 铁律②：面板被切走 → rAF 停、场景不再重建，但**宿主侧仿真照跑**（SSOT 在宿主）。
 */
import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { HTTP_ROUTES, MODEL_ROUTES, modelItemUrl } from '../contracts/protocol.ts'
import type { ImportModelResult, ImportedModelRecord } from '../contracts/protocol.ts'
import { SceneHost } from '../scene/host.ts'
import { PortTooltip } from './port-tooltip.ts'
import { PerfMeter } from './perf-meter.ts'
import { ImportedModelProvider, ModelRegistry, type NormalizationReport } from '../scene/importer.ts'
import { InteractionLayer, type Notice } from '../scene/interaction.ts'
import { SnapshotChannel } from '../scene/net.ts'
import { SceneSyncLayer } from '../scene/sync.ts'
import {
  ChatBox,
  ContextMenu,
  ControlHint,
  HardwarePalette,
  ImportControls,
  NoticeBar,
  type ContextMenuItem,
} from './hud.ts'
import { ProjectPanel, type ProjectScanReport } from './project-panel.ts'
import { sendToCurrentSession } from './session-chat.ts'
import type { SessionsFace } from './slots.ts'

/** 逐轴缩放比超过该倍数 ⇒ 长宽比不符，必须让用户看见。 */
const ASPECT_DRIFT_THRESHOLD = 1.15

/**
 * `main` 槽是 **root 作用域**，拿不到 session 类标准 props；
 * `sessions` 由注册时的 `inject` 面带进来（见 `index.ts`）。
 */
export interface HardwareSandboxPanelProps {
  readonly sessions?: SessionsFace
}

export function HardwareSandboxPanel(props: HardwareSandboxPanelProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const perfMeterRef = useRef<PerfMeter | null>(null)
  const [perfOn, setPerfOn] = useState(false)
  const interactionRef = useRef<InteractionLayer | null>(null)
  const registryRef = useRef<ModelRegistry | null>(null)
  const providerRef = useRef<ImportedModelProvider | null>(null)
  const syncRef = useRef<SceneSyncLayer | null>(null)
  const channelRef = useRef<SnapshotChannel | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  /** 右键菜单状态（null = 未打开）。 */
  const [menu, setMenu] = useState<
    { x: number; y: number; componentId?: string; cableId?: string } | null
  >(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  /** 宿主快照到手前禁用「添加」，否则动作会打空。 */
  const [ready, setReady] = useState(false)
  const [records, setRecords] = useState<readonly ImportedModelRecord[]>([])
  /**
   * **项目本体扫描报告** —— 用户工作流第②步的产物。
   *
   * ★ 扫了不显示等于没扫；而且"缺哪些型号"必须**点名** ——
   *   那正是"写个清单发给用户 / 自己建模"的输入。
   */
  const [scanReport, setScanReport] = useState<ProjectScanReport | undefined>(undefined)
  /**
   * **导入建模组时"只补缺"**（用户批准的新选项，默认关）。
   *
   * ★ 默认关 = **换装（覆盖）**：那是用户明确要换掉某个型号时才会去点的动作。
   * ★ 打开 = **只补缺**：台账里已有几何的型号跳过不动 ——
   *   给 B 项目补缺口时**不误伤 A 已建好的同键模型**
   *   （两个项目共用 `esp32-seat-sensor` 这种通用主控时很要命）。
   */
  const [onlyMissingImport, setOnlyMissingImport] = useState(false)
  /**
   * 宿主是否具备聊天能力（`capabilities.chat`）。
   *
   * ★ 缺省时**隐藏输入框**，不显示一个发不出去的框 ——
   *   `/api/chat` 在拿不到 `agents` 服务时**根本不注册**，`chat` 也随之缺省。
   */
  const [chatEnabled, setChatEnabled] = useState(false)

  const pushNotice = useCallback((next: Notice) => {
    setNotice(next)
    if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
    noticeTimer.current = window.setTimeout(
      () => setNotice(null),
      next.severity === 'info' ? 2500 : 7000,
    )
  }, [])

  useEffect(() => {
    const container = hostRef.current
    if (!container) return

    const registry = new ModelRegistry()
    registryRef.current = registry

    const models = new ImportedModelProvider({
      registry,
      onNormalized: (modelKey: string, report: NormalizationReport) => {
        // ★ 归一化的异常必须**用户可见**
        //   注意：朝向现在**已经自动归一化**（见 `orientToContract`）。所以这里
        //   `aspectDrift` 仍然大 ⇒ 不再是"朝向没转"，而是**声明尺寸本身**和模型形状
        //   对不上 —— 那是真该查的数据完整性信号。
        // ★ 人工覆盖写错排在**最前**：它说明契约数据本身有错，且已经悄悄退回了自动规则，
        //   不报出来用户会以为"我明明指定了"。
        if (report.invalidOrientationOverride) {
          pushNotice({
            text: `${modelKey}：朝向覆盖无效 —— ${report.invalidOrientationOverride}`,
            severity: 'error',
          })
        } else if (report.aspectDrift > ASPECT_DRIFT_THRESHOLD) {
          pushNotice({
            text: `${modelKey}：模型与声明尺寸的长宽比不符（被拉伸 ${report.aspectDrift.toFixed(2)}×；朝向已按 ${report.orientation} 自动对齐）`,
            severity: 'warn',
          })
        } else if (report.suspectOrientation) {
          pushNotice({
            text: `${modelKey}：模型朝向仍不对（最长轴与预期不一致），检查导出轴向`,
            severity: 'warn',
          })
        } else if (report.orientationAmbiguous && report.orientation !== 'identity') {
          // 尺寸序分不开 ⇒ 长/宽指派是**按约定挑的**，不是量出来的。
          // 只提示不告警：真错了会以"平面内转了 90°"的形式被眼睛发现。
          pushNotice({
            text: `${modelKey}：长/宽接近（${(report.modelSize.x * 1000).toFixed(2)} vs ${(report.modelSize.z * 1000).toFixed(2)} mm），长宽方向按"最长→x"约定自动定；若模型在平面内转了 90°，说明声明的 x/z 与实际相反`,
            severity: 'info',
          })
        }
      },
    })
    providerRef.current = models

    const scene = new SceneHost(container)
    // 端口名浮标：场景层只报"该给哪个端口飘标签"，投影与 DOM 留在这一层
    const portTooltip = new PortTooltip(container, scene)
    // 性能尺子：默认关（用户要求"尽量不占用大面积"），需要时手动打开
    const perfMeter = new PerfMeter(container, scene)
    perfMeterRef.current = perfMeter
    const channel = new SnapshotChannel()
    channelRef.current = channel
    const sync = new SceneSyncLayer({ source: channel, models })
    syncRef.current = sync
    const interaction = new InteractionLayer({
      source: channel,
      // ★ 端口锚点问 sync 要 —— 它是锚点的持有者。
      //   自己 `scene.traverse()` 找 + 按 revision 缓存是错的：
      //   `rebuildModel()` 销毁重建锚点却不改 revision（导入/清除模型走这条路），
      //   缓存会一直"有效"地指向一批死对象，端口拾取静默失效。
      portMarkers: () => sync.portMarkers(),
      dispatch: (action) => channel.dispatch(action),
      onNotice: pushNotice,
      // 拖拽期间冻结该组件位置，避免宿主快照把跟手的 mesh 拽回去
      onPositionLock: (componentId) => sync.setPositionLock(componentId),
      // 动作结束（**无论成败**）都按 SSOT 重调和一次，抹掉本地跟手的位置
      onActionSettled: () => sync.forceResync(),
      // 右键 → 请求菜单（场景层只请求，DOM 由本层渲染）
      onContextMenu: (target, position) =>
        setMenu({ ...target, x: position.x, y: position.y }),
      // 悬停/拖线 → 端口名浮标
      onPortFocus: (focus) => portTooltip.setFocus(focus),
    })
    interactionRef.current = interaction

    // 顺序要紧：sync 先挂（组件先建出来），interaction 后挂（拾取才有对象可命中）
    const detachSync = scene.addLayer(sync)
    const detachInteraction = scene.addLayer(interaction)

    const unsubscribe = channel.onChange(() => setReady(true))
    void channel.start().then(() => setReady(channel.latest() !== undefined))
    // ★★ 已导入模型清单 —— **必须比"建组件"先到位**（2026-10-09 修）
    //
    //   ⚠️⚠️ 原来这里是一句 `void registry.refresh().then(...)`，**不 await**。
    //     而 `scene.start()` 紧接着就开了 rAF 循环、快照一到就建组件、建的时候去查 registry。
    //     ⇒ **两个 promise 赛跑**：`refresh()` 先回来 ⇒ 有真模型；快照先到 ⇒ **全是占位盒**。
    //
    //   ★ 症状（用户原话）：「**为啥我重启后变成了 3 个普通方块了**」——
    //     模型文件在磁盘上、`/api/model` 也正常返回 7 个，**宿主一点问题没有**，
    //     纯粹是客户端这边**谁先谁后**的问题。**而它不会报错。**
    //     更迷惑的是：在会话里导入一次模型会再次 refresh（`importer.ts`），
    //     于是"有时候又有"——**看起来像缓存，其实是竞态。**
    //
    //   ⇒ 两道保险：
    //     ① **先 await 清单**，再让通道把快照放进来（消除竞态本身）
    //     ② 清单到了之后，把**已经建出来的占位盒**换成真模型（覆盖①②仍然交错的极端情况）
    void (async () => {
      await registry.refresh()
      setRecords([...registry.list()])
      // ② 只要这个型号已经有真模型，就让场景里对应的组件重建一次。
      //    ★ 先作废 provider 缓存，否则重建时会命中"上次因为没模型而缓存下来的 null"。
      for (const record of registry.list()) {
        providerRef.current?.invalidate(record.modelKey)
        syncRef.current?.rebuildModel(record.modelKey)
      }
    })()
    // 聊天能力：缺省 ⇒ 不渲染输入框
    void channel.fetchCapabilities().then((capabilities) => {
      setChatEnabled(capabilities?.chat === true)
    })
    scene.start()

    return () => {
      unsubscribe()
      channel.stop()
      detachInteraction()
      detachSync()
      portTooltip.dispose()
      perfMeter.dispose()
      perfMeterRef.current = null
      scene.dispose()
      models.dispose()
      interactionRef.current = null
      registryRef.current = null
      providerRef.current = null
      syncRef.current = null
      channelRef.current = null
      if (noticeTimer.current !== undefined) window.clearTimeout(noticeTimer.current)
    }
  }, [pushNotice])

  const handlePick = useCallback((modelKey: string) => {
    void interactionRef.current?.placeModel(modelKey)
  }, [])

  const handleImport = useCallback(
    async (modelKey: string, file: File) => {
      const registry = registryRef.current
      if (!registry) return
      const result = await registry.upload(modelKey, file)
      setRecords([...registry.list()])
      if (!result.ok) {
        pushNotice({ text: `${modelKey} 导入失败：${result.reason ?? '未知原因'}`, severity: 'error' })
        return
      }
      // 缓存要作废，否则重新导入同一型号会继续用旧模型
      providerRef.current?.invalidate(modelKey)
      // 导入**不改变装配状态**（revision 不变）⇒ 必须显式让场景重建才看得见
      syncRef.current?.rebuildModel(modelKey)
      pushNotice({ text: `${modelKey} 已导入（${result.record?.bytes ?? file.size} 字节）`, severity: 'info' })
    },
    [pushNotice],
  )

  /**
   * 一键导入候选。
   *
   * ★ **只把 `partId` 交给宿主**，`glbUrl` 由宿主自己去 step.parts 取 ——
   *   URL 从不由客户端提供，所以不存在"让宿主去抓任意地址"这条路（SSRF 面为零）。
   */
  const handleImportCandidate = useCallback(
    async (modelKey: string, partId: string) => {
      const registry = registryRef.current
      if (!registry) return
      try {
        const response = await fetch(MODEL_ROUTES.import, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modelKey, partId }),
        })
        const result = (await response.json()) as ImportModelResult
        if (!result.ok) {
          pushNotice({ text: `导入失败：${result.reason ?? '未知原因'}`, severity: 'error' })
          return
        }
        await registry.refresh()
        setRecords([...registry.list()])
        // 缓存作废 + 让场景重建，否则导入完看不见变化
        providerRef.current?.invalidate(modelKey)
        syncRef.current?.rebuildModel(modelKey)
        pushNotice(
          { text: `${modelKey} 已导入（${result.record?.bytes ?? '?'} 字节）`, severity: 'info' },
        )
      } catch (error) {
        pushNotice({ text: `导入失败：${String(error)}`, severity: 'error' })
      }
    },
    [pushNotice],
  )

  const handleRemove = useCallback(
    async (modelKey: string) => {
      const registry = registryRef.current
      if (!registry) return
      const ok = await registry.remove(modelKey)
      setRecords([...registry.list()])
      if (!ok) {
        pushNotice({ text: `${modelKey} 清除失败`, severity: 'error' })
        return
      }
      providerRef.current?.invalidate(modelKey)
      syncRef.current?.rebuildModel(modelKey)
      pushNotice({ text: `${modelKey} 已恢复为占位盒`, severity: 'info' })
    },
    [pushNotice],
  )

  // 右键菜单项：按命中的目标（组件 / 线缆）生成
  const menuItems: ContextMenuItem[] = []
  if (menu?.componentId !== undefined) {
    const componentId = menu.componentId
    // ★ 钉住状态**从快照读**，不在前端存 —— 否则一次 resync 就静默丢掉它
    //   （用户会看到"我钉住的又松了"，且没有任何报错）。
    const pinned =
      channelRef.current?.latest()?.components.find((item) => item.id === componentId)?.pinned ===
      true
    menuItems.push({
      // ★ 发**显式的目标值**而不是 toggle：
      //   toggle 在"界面以为的状态"与 SSOT 实际状态不一致时（如刚 resync 完）
      //   会朝反方向执行，而且没人能发现。
      label: pinned ? '解开钉住' : '钉住（不许移动）',
      onSelect: () =>
        void channelRef.current?.dispatch({ kind: 'set_pinned', componentId, pinned: !pinned }),
    })

    // ★★ 旋转（2026-10-09 加）
    //
    //   宿主侧一直支持（`ComponentSpec.rotation` + `sync.ts` 会应用它），
    //   但**界面上没有任何入口** ⇒ 用户看到的"硬件不能转"其实只是**没有旋钮**。
    //
    // ★ 与钉住同一条理由：**发绝对值，不发增量**。
    //   `rotation.y + π/2` 这种增量在"界面以为的角度"与"SSOT 实际角度"不一致时
    //   （刚 resync 完、上一次旋转被拒）会**朝错误的方向累加**，而且没人能发现。
    //   这里从**快照**读当前角度、算好绝对值再发 —— 重放与重试都是幂等的。
    const rotation = channelRef.current
      ?.latest()
      ?.components.find((item) => item.id === componentId)?.rotation ?? { x: 0, y: 0, z: 0 }
    menuItems.push({
      label: '旋转 90°（平面内）',
      onSelect: () =>
        void channelRef.current?.dispatch({
          kind: 'set_rotation',
          componentId,
          rotation: { x: rotation.x, y: rotation.y + Math.PI / 2, z: rotation.z },
        }),
    })
    menuItems.push({
      label: '翻面 180°（绕长轴）',
      onSelect: () =>
        void channelRef.current?.dispatch({
          kind: 'set_rotation',
          componentId,
          rotation: { x: rotation.x + Math.PI, y: rotation.y, z: rotation.z },
        }),
    })
    menuItems.push({
      label: '删除组件',
      danger: true,
      onSelect: () => void channelRef.current?.dispatch({ kind: 'remove_component', componentId }),
    })
  }
  if (menu?.cableId !== undefined) {
    const cableId = menu.cableId
    menuItems.push({
      label: '拔掉线缆',
      danger: true,
      onSelect: () => void channelRef.current?.dispatch({ kind: 'disconnect', cableId }),
    })
  }

  return createElement(
    'div',
    {
      className: 'dsh-hardware-sandbox-root',
      style: {
        position: 'relative',
        width: '100%',
        height: '100%',
        minHeight: '320px',
        overflow: 'hidden',
        background: '#0f1218',
      },
    },
    createElement('div', {
      ref: hostRef,
      style: { position: 'absolute', inset: '0' },
    }),
    createElement(
      'div',
      {
        style: {
          position: 'absolute',
          top: '12px',
          left: '12px',
          display: 'flex',
          flexDirection: 'column',
          gap: '10px',
          width: '220px',
        },
      },
      createElement(ProjectPanel, {
        onSwitch: (projectId) =>
          void channelRef.current?.dispatch({ kind: 'import_project', projectId }),
        disabled: !ready,
        revision: channelRef.current?.latest()?.revision ?? 0,
        // ★ "只补缺"开关：默认关（换装/覆盖）；打开则不碰已有几何的型号
        onlyMissingImport,
        onToggleOnlyMissingImport: setOnlyMissingImport,
        // ★ **导入项目本体** —— 一个完整的前后端项目文件夹（如 D:\MAX_xiangmu）
        //   收整个文件夹的清单，交给宿主**扫描出它需要哪些硬件**。
        onImportProjectFolder: async (files) => {
          // ⚠️ 只挑**小而关键**的文本文件送去扫：把整个文件夹（可能带 node_modules）
          //   灌过去既慢，又会把"这个项目需要什么硬件"淹在噪声里。
          const interesting = files.filter(
            (file) =>
              file.size <= 128 * 1024 &&
              !file.webkitRelativePath.includes('node_modules/') &&
              !file.webkitRelativePath.includes('.git/') &&
              /\.(ini|md|txt|json|ya?ml|py|c|cpp|h|hpp|toml|cfg|conf|env)$/i.test(file.name),
          )
          // ★★ **总预算**，不是"每个文件限多少" —— 这条是**实测抓出来的**：
          //   服务端 `MAX_BODY_BYTES = 256KB`，而按"每文件 20KB × 最多 400 个"算，
          //   最坏能送出 **8MB（中文 UTF-8 可达 24MB）** ⇒ **超出 30~90 倍**。
          //   症状是：文件夹一大，扫描直接 `request body too large` 失败。
          //   ⇒ 按**累计字节**截断，并且**如实报告跳过了多少**（静默截断等于骗人）。
          const BUDGET = 180 * 1024
          const sample: { path: string; text: string }[] = []
          let used = 0
          let skipped = 0
          for (const file of interesting) {
            if (used >= BUDGET) {
              skipped += 1
              continue
            }
            const text = (await file.text()).slice(0, 16_000)
            const cost = text.length
            if (used + cost > BUDGET) {
              skipped += 1
              continue
            }
            used += cost
            sample.push({ path: file.webkitRelativePath || file.name, text })
          }
          // ★★ **只上传，不扫描** —— 用户原话：
          //   > 那个扫描可以**后续扫描按钮**，**先上传项目到那里**
          //   ⇒ 上传后项目进列表（看得见），扫描是它旁边的一个按钮。
          const bodyId = `body-${String(Date.now())}`
          const source =
            sample[0]?.path.split('/')[0] ?? '未知项目'
          const response = await fetch(HTTP_ROUTES.projects, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              op: 'import-body',
              body: {
                id: bodyId,
                label: source,
                source,
                importedAt: new Date().toISOString(),
                fileCount: files.length,
                files: sample,
                skipped,
              },
            }),
          })
          const body = (await response.json()) as { ok?: boolean; reason?: string }
          if (body.ok !== true) return body.reason ?? `HTTP ${String(response.status)}`
          return undefined
        },
        // ★ **导入建模组** —— 两种形态都收：
        //   ① 一个文件夹（`<型号键>/model.glb`）
        //   ② **一个 .json 打包文件**（导出建模组产出的那个，装着一整套）
        onImportModelSet: async (files) => {
          const registry = registryRef.current
          if (!registry) return '模型库还没就绪'
          // ── ② JSON 打包（"把整套建模存成一个文件"）──
          const bundleFile = files.find((file) => /\.json$/i.test(file.name))
          if (bundleFile !== undefined) {
            let parsed: unknown
            try {
              parsed = JSON.parse(await bundleFile.text())
            } catch {
              return `${bundleFile.name} 不是合法 JSON`
            }
            const bundle = parsed as {
              kind?: string
              models?: { modelKey?: unknown; glbBase64?: unknown }[]
            }
            if (bundle.kind !== 'model-set' || !Array.isArray(bundle.models)) {
              return '这个 JSON 不是建模组文件（缺 kind:"model-set"）'
            }
            let done = 0
            let skippedExisting = 0
            for (const entry of bundle.models) {
              const modelKey = typeof entry.modelKey === 'string' ? entry.modelKey : ''
              const base64 = typeof entry.glbBase64 === 'string' ? entry.glbBase64 : ''
              if (modelKey === '' || base64 === '') continue
              if (onlyMissingImport && registry.has(modelKey)) {
                skippedExisting += 1
                continue
              }
              // base64 → 字节 → File（upload 收 File）
              const binary = atob(base64)
              const bytes = new Uint8Array(binary.length)
              for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
              const file = new File([bytes], 'model.glb', { type: 'model/gltf-binary' })
              const result = await registry.upload(modelKey, file)
              if (!result.ok) return `${modelKey}：${result.reason ?? '未知原因'}`
              providerRef.current?.invalidate(modelKey)
              syncRef.current?.rebuildModel(modelKey)
              done += 1
            }
            setRecords([...registry.list()])
            pushNotice({
              text:
                `建模组（JSON）已导入 ${String(done)} 个型号` +
                (skippedExisting > 0 ? `，跳过 ${String(skippedExisting)} 个已有几何的（只补缺）` : ''),
              severity: 'info',
            })
            return undefined
          }
          // ── ① 文件夹形态 ──
          const picked = files.filter((file) => /\.(glb|gltf)$/i.test(file.name))
          if (picked.length === 0) return '这个文件夹里没有 .glb / .gltf'
          let done = 0
          let skippedExisting = 0
          for (const file of picked) {
            const segments = (file.webkitRelativePath || file.name).split('/')
            const modelKey = segments.length >= 2 ? (segments[segments.length - 2] ?? '') : ''
            if (modelKey === '') continue
            // ★★ **只补缺**（用户批准的新选项）：台账里已有几何的型号**跳过不动**。
            //   ⇒ 给 B 项目补缺口时，**不会误伤 A 项目已建好的同键模型**
            //     （两个项目共用 `esp32-seat-sensor` 这种通用主控时，这很要命）。
            //   默认**不勾** = 换装（覆盖），那是用户明确要换掉时才会去点的动作。
            if (onlyMissingImport && registry.has(modelKey)) {
              skippedExisting += 1
              continue
            }
            const result = await registry.upload(modelKey, file)
            if (!result.ok) return `${modelKey}：${result.reason ?? '未知原因'}`
            providerRef.current?.invalidate(modelKey)
            syncRef.current?.rebuildModel(modelKey)
            done += 1
          }
          setRecords([...registry.list()])
          pushNotice({
            text:
              `建模组已导入 ${String(done)} 个型号` +
              (skippedExisting > 0 ? `，跳过 ${String(skippedExisting)} 个已有几何的（只补缺）` : ''),
            severity: 'info',
          })
          return undefined
        },
        /**
         * ★★ **导出建模组** —— 把**整套建模**存成**一个 JSON 文件**。
         *
         * 用户原话：「这个是直接导出**完整**建模吧，比如建模里有 abc 组合，
         * 下次导入进来**还是一样的**，是保存那个**建模整体**」。
         *
         * ★ 为什么是**一个 JSON** 而不是一个文件夹：
         *   · 浏览器的文件对话框**本来就能选保存路径**（用户："选择路径保存"）——
         *     而"选文件夹让宿主写进去"要额外的目录选择服务，还容易失败；
         *   · 一个文件**不会在搬运中散掉**（复制、发微信、丢进网盘都还是同一个东西）；
         *   · 与"导出项目定义"的体验一致 —— 都是"另存为一个文件"。
         * ★ 几何是二进制 ⇒ 用 base64 装进 JSON。整套自产模型约 150KB，base64 后仍很小。
         */
        onExportModelSet: async () => {
          const registry = registryRef.current
          if (!registry) return '模型库还没就绪'
          const keys = registry
            .list()
            .map((record) => record.modelKey)
            .filter((key): key is string => typeof key === 'string' && key !== '')
          if (keys.length === 0) return '还没有任何模型可导出'
          const models: { modelKey: string; glbBase64: string }[] = []
          for (const modelKey of keys) {
            const response = await fetch(modelItemUrl(modelKey))
            if (!response.ok) return `读 ${modelKey} 失败：HTTP ${String(response.status)}`
            const buffer = await response.arrayBuffer()
            const bytes = new Uint8Array(buffer)
            let binary = ''
            for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i] ?? 0)
            models.push({ modelKey, glbBase64: btoa(binary) })
          }
          const payload = {
            format: 1,
            kind: 'model-set',
            exportedAt: new Date().toISOString(),
            models,
          }
          const blob = new Blob([`${JSON.stringify(payload)}\n`], { type: 'application/json' })
          const url = URL.createObjectURL(blob)
          const anchor = document.createElement('a')
          anchor.href = url
          anchor.download = `model-set-${String(models.length)}.json`
          anchor.click()
          // ★ 立刻回收：不回收的话这份 blob 会一直挂在内存里
          URL.revokeObjectURL(url)
          pushNotice({ text: `已导出建模组（${String(models.length)} 个型号）`, severity: 'info' })
          return undefined
        },
      }),
      createElement(HardwarePalette, {
        onPick: handlePick,
        disabled: !ready,
        // ★ 只列**有真几何**的型号（用户选的 A）—— 见 HardwarePaletteProps.available 的说明
        available: records.filter((record) => record.modelKey !== undefined).map((record) => record.modelKey),
      }),
      createElement(ImportControls, {
        records,
        onImport: (modelKey, file) => void handleImport(modelKey, file),
        onImportCandidate: handleImportCandidate,
        onRemove: (modelKey) => void handleRemove(modelKey),
        disabled: !ready,
      }),
      // ★ 性能尺子的开关。
      //   为什么放在这里而不是藏起来：**用户找不到的尺子等于没有尺子。**
      //   为什么默认关：用户明确要求「尽量不占用大面积」——架在架子上，不是贴在墙上。
      createElement(
        'button',
        {
          type: 'button',
          onClick: () => {
            const next = !perfOn
            setPerfOn(next)
            perfMeterRef.current?.setVisible(next)
          },
          title: '显示每帧的绘制次数 / 三角形数 / 帧率（纯读取，默认关）',
          style: {
            alignSelf: 'flex-start',
            padding: '3px 8px',
            borderRadius: '4px',
            border: '1px solid rgba(120, 200, 255, 0.25)',
            background: perfOn ? 'rgba(90, 160, 255, 0.22)' : 'rgba(20, 26, 34, 0.72)',
            color: '#cfe6ff',
            font: '11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            cursor: 'pointer',
          },
        },
        perfOn ? '统计 ✓' : '统计',
      ),
    ),
    // ★ 右上角：跟 DS 对话的浮层（默认收起，不占地方）
    //   仅在宿主具备 chat 能力时渲染 —— 否则会显示一个永远发不出去的框
    chatEnabled
      ? createElement(
          'div',
          { style: { position: 'absolute', top: '12px', right: '12px', width: '240px' } },
          createElement(ChatBox, {
            onSend: (text) => sendToCurrentSession(props.sessions, text),
          }),
        )
      : null,
    createElement(ControlHint),
    notice ? createElement(NoticeBar, { notice, onDismiss: () => setNotice(null) }) : null,
    menu !== null && menuItems.length > 0
      ? createElement(ContextMenu, {
          x: menu.x,
          y: menu.y,
          items: menuItems,
          onDismiss: () => setMenu(null),
        })
      : null,
  )
}
