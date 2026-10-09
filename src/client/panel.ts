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
import { MODEL_ROUTES } from '../contracts/protocol.ts'
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
      createElement(HardwarePalette, { onPick: handlePick, disabled: !ready }),
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
