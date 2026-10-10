/**
 * 面板内的 HUD 覆盖层：硬件列表 / 提示条 / 操作说明。
 *
 * ★ 硬件列表**从契约 `HARDWARE_MODELS` 生成**，前端不再列第二份型号表 ——
 *   否则型号一改就两处真相（我们在 `size` 上刚踩过这个坑）。
 */
import { createElement, useRef, useState, type ReactNode } from 'react'
import { HARDWARE_MODELS } from '../contracts/library.ts'
import { MODEL_SOURCES, searchQueryFor, sourceUrl, type ModelSource } from '../contracts/model-sources.ts'
import { MODEL_ROUTES, looksLikeModelFile } from '../contracts/protocol.ts'
import type { ImportedModelRecord, ModelCandidate, ModelSearchResult } from '../contracts/protocol.ts'
import type { Notice } from '../scene/interaction.ts'

/**
 * HUD 浮层的统一外壳。
 *
 * ★ 背景**半透明**（用户要求"能看到背后东西"）+ **可折叠**（"尽量不占用大面积"）。
 *   透明背景会压低文字对比度，所以文字带一层描边阴影保证可读 ——
 *   透明是为了不挡场景，不是为了好看而牺牲可读性。
 */
const PANEL_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '5px',
  padding: '8px',
  borderRadius: '8px',
  background: 'rgba(10, 14, 20, 0.30)',
  border: '1px solid rgba(120, 140, 170, 0.22)',
  color: '#e6ecf7',
  font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
  textShadow: '0 1px 3px rgba(0, 0, 0, 0.95)',
  pointerEvents: 'auto',
} as const

const PANEL_HEADER_STYLE = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: '8px',
  padding: '0',
  border: 'none',
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  fontWeight: 'bold',
  cursor: 'pointer',
  textAlign: 'left',
} as const

export function Panel(props: {
  /** 标题。用 `ReactNode` 是为了能内联品牌图标（如 {@link WhaleIcon}），而不是塞 emoji。 */
  readonly title: ReactNode
  readonly subtitle?: string
  readonly defaultOpen?: boolean
  readonly children?: ReactNode
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)

  return createElement(
    'div',
    { style: PANEL_STYLE },
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setOpen(!open),
        style: PANEL_HEADER_STYLE,
        title: open ? '收起' : '展开',
      },
      createElement('span', null, props.title),
      createElement(
        'span',
        { style: { opacity: 0.45, fontWeight: 'normal', fontSize: '10px' } },
        open ? '收起 ▲' : '展开 ▼',
      ),
    ),
    open
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '5px' } },
          props.subtitle !== undefined
            ? createElement(
                'div',
                { style: { opacity: 0.55, fontSize: '11px' } },
                props.subtitle,
              )
            : null,
          props.children,
        )
      : null,
  )
}

export interface HardwarePaletteProps {
  readonly onPick: (modelKey: string) => void
  /** 宿主不可用时禁用（如 WS 未连上）。 */
  readonly disabled?: boolean
}

/** 毫米显示：契约里尺寸单位是米。 */
function mm(value: number): string {
  return (value * 1000).toFixed(0)
}

export function HardwarePalette(props: HardwarePaletteProps) {
  const models = Object.values(HARDWARE_MODELS)

  return createElement(
    Panel,
    { title: '① 添加器件', subtitle: '点一下放进场景（② 是给它们换真实模型）' },
    // ★★ 器件列表要**自己能滚**（2026-10-10 加）
    //
    //   原来这些按钮是**直接铺在 Panel 里**的 —— 型号只有 7 个时看不出来，
    //   一旦面板变高（或窗口变矮），列表就**顶穿面板、下面的内容被挤出屏幕**。
    //   用户原话：「**这是不是多了列表应该有滚轮条**」—— 是的，应该有。
    //
    //   ★ 为什么不靠外层滚动：外层是 `pointer-events: none` 的 HUD 覆盖层
    //     （见 SCENE 的交互设计），在它上面滚动等于**和场景拖拽抢事件**。
    //     ⇒ 滚动必须收在**这一块列表自己**身上，滚轮才不会漏给场景。
    createElement(
      'div',
      { style: PALETTE_LIST_STYLE },
      ...models.map((model) =>
        createElement(
          'button',
          {
            key: model.key,
            type: 'button',
            disabled: props.disabled,
            onClick: () => props.onPick(model.key),
            title:
              `${model.label}\n` +
              `尺寸 ${mm(model.size.x)} × ${mm(model.size.z)} × ${mm(model.size.y)} mm\n` +
              `${model.ports.length} 个端口`,
            style: {
              textAlign: 'left',
              padding: '6px 8px',
              borderRadius: '6px',
              border: '1px solid rgba(120, 140, 170, 0.3)',
              background: props.disabled ? 'rgba(60,70,85,0.5)' : 'rgba(40, 50, 66, 0.9)',
              color: 'inherit',
              font: 'inherit',
              cursor: props.disabled ? 'not-allowed' : 'pointer',
            },
          },
          model.label,
        ),
      ),
    ),
  )
}

/**
 * 器件列表的容器样式。
 *
 * ★ `overscrollBehavior: 'contain'` 不是装饰：没有它，滚到列表尽头时
 *   **滚轮会"穿透"到场景**，把 3D 视角一起缩放了 —— 用户以为滚的是列表，
 *   实际动的是镜头，这种"两件事一起发生"最难排查。
 */
const PALETTE_LIST_STYLE = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: '5px',
  maxHeight: '260px',
  overflowY: 'auto' as const,
  overscrollBehavior: 'contain' as const,
  // 给滚动条留一点位置，免得它压住按钮的圆角
  paddingRight: '4px',
}

const BUTTON_STYLE = {
  padding: '4px 8px',
  borderRadius: '6px',
  border: '1px solid rgba(120, 140, 170, 0.3)',
  background: 'rgba(40, 50, 66, 0.9)',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
} as const

export interface ImportControlsProps {
  readonly records: readonly ImportedModelRecord[]
  readonly onImport: (modelKey: string, file: File) => void
  /** 一键导入候选：宿主按 `partId` 自己去取 GLB（客户端不给 URL）。 */
  readonly onImportCandidate: (modelKey: string, partId: string) => Promise<void>
  readonly onRemove: (modelKey: string) => void
  readonly disabled?: boolean
}

/**
 * 模型导入控件。
 *
 * ★ 为什么是"用户自己选文件"而不是我们去抓：
 *   厂商条款约束的是**我们的**批量/自动化采集，并明文保留 individual / ordinary course。
 *   用户导入自己合法取得的文件 ⇒ 我们既没采集也没分发，两个问题同时不存在。
 */
export function ImportControls(props: ImportControlsProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pendingKey = useRef<string | null>(null)
  /** 外部站点直链列表是否展开（**降级/兜底**路径，主路径是下面的面板内搜索）。 */
  const [showSources, setShowSources] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [result, setResult] = useState<ModelSearchResult | null>(null)
  /** 候选「一键导入」的目标型号键（默认 = 发起搜索的那一行）。 */
  const [targetKey, setTargetKey] = useState<string>(Object.keys(HARDWARE_MODELS)[0] ?? '')
  /** 正在导入的候选 id（按钮显示进行中）。 */
  const [importingId, setImportingId] = useState<string | null>(null)

  /**
   * 走**宿主自带的搜索服务**（`ctx.web.search`），不是抓某个厂商站点。
   *
   * ★ 这个区别决定了它合不合规：通用搜索走的是被认可的检索通道，
   *   我们不解析/不镜像/不索引任何站点；而直接抓 EasyEDA/LCSC 的搜索页
   *   是**自动化访问特定平台**（403 + 条款明文禁止）。
   *   两者看着都像"搜索"，性质完全不同。
   */
  const runSearch = async (raw: string, forModelKey?: string): Promise<void> => {
    const q = raw.trim()
    if (q === '' || searching) return
    setQuery(q)
    if (forModelKey !== undefined) setTargetKey(forModelKey)
    setSearching(true)
    setResult(null)
    try {
      const response = await fetch(`${MODEL_ROUTES.search}?q=${encodeURIComponent(q)}`)
      if (!response.ok) {
        setResult({ query: q, candidates: [], sources: [], unavailable: `搜索服务返回 ${response.status}` })
      } else {
        setResult((await response.json()) as ModelSearchResult)
      }
    } catch (error) {
      setResult({ query: q, candidates: [], sources: [], unavailable: String(error) })
    } finally {
      setSearching(false)
    }
  }

  /**
   * 一键导入：**只把 `partId` 交给宿主**，`glbUrl` 由宿主自己去取。
   * ★ 这就是它 SSRF 面为零的原因 —— URL 从不由客户端提供。
   */
  const importCandidate = async (candidate: ModelCandidate): Promise<void> => {
    if (importingId !== null) return
    setImportingId(candidate.id)
    try {
      await props.onImportCandidate(targetKey, candidate.id)
    } finally {
      setImportingId(null)
    }
  }

  const beginPick = (modelKey: string): void => {
    pendingKey.current = modelKey
    inputRef.current?.click()
  }

  return createElement(
    Panel,
    { title: '② 换装模型', subtitle: '搜模型 / 导入文件 · 给上面某个型号换装（没换就用占位盒）' },
    // ── 面板内搜索：结果直接列出，**不跳浏览器** ──
    createElement(
      'div',
      { style: { display: 'flex', gap: '4px' } },
      createElement('input', {
        type: 'text',
        value: query,
        placeholder: '搜索 3D 模型…',
        onChange: (event: { target: HTMLInputElement }) => setQuery(event.target.value),
        onKeyDown: (event: { key: string }) => {
          if (event.key === 'Enter') void runSearch(query)
        },
        style: {
          flex: '1',
          minWidth: '0',
          padding: '5px 7px',
          borderRadius: '6px',
          border: '1px solid rgba(120, 140, 170, 0.3)',
          background: 'rgba(10, 14, 20, 0.9)',
          color: 'inherit',
          font: 'inherit',
        },
      }),
      createElement(
        'button',
        {
          type: 'button',
          disabled: props.disabled || searching || query.trim() === '',
          onClick: () => void runSearch(query),
          style: BUTTON_STYLE,
        },
        searching ? '搜索中' : '搜索',
      ),
    ),
    searching
      ? createElement(
          'div',
          { style: { color: '#ffc266', opacity: 0.75, fontSize: '10px' } },
          '搜索中…（实测约 6 秒，请稍候）',
        )
      : null,
    result
      ? createElement(SearchResults, {
          result,
          targetKey,
          onTargetKeyChange: setTargetKey,
          onImportCandidate: (candidate: ModelCandidate) => void importCandidate(candidate),
          importingId,
        })
      : null,
    // 外部站点直链：**兜底**路径（搜索不可用、或用户想自己去逛时用）
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => setShowSources(!showSources),
        style: { ...BUTTON_STYLE, opacity: 0.7, fontSize: '10px' },
      },
      showSources ? '收起外部站点' : '外部站点直链（兜底）',
    ),
    showSources ? createElement(ModelSourceList, { query }) : null,
    createElement('input', {
      ref: inputRef,
      type: 'file',
      accept: '.glb,.gltf,model/gltf-binary,model/gltf+json',
      style: { display: 'none' },
      onChange: (event: { target: HTMLInputElement }) => {
        const file = event.target.files?.[0]
        const modelKey = pendingKey.current
        if (file && modelKey) props.onImport(modelKey, file)
        pendingKey.current = null
        // 清空 value，否则选同一个文件不会再触发 change
        event.target.value = ''
      },
    }),
    ...Object.values(HARDWARE_MODELS).map((model) => {
      const imported = props.records.find((record) => record.modelKey === model.key)
      return createElement(
        'div',
        { key: model.key, style: { display: 'flex', alignItems: 'center', gap: '4px' } },
        createElement(
          'span',
          {
            style: { flex: '1', opacity: imported ? 1 : 0.6, overflow: 'hidden', textOverflow: 'ellipsis' },
            title: imported
              ? `已导入 ${imported.bytes} 字节（${imported.format}）` +
                (imported.nodes === undefined ? '' : ` · ${imported.nodes} 个节点`)
              : '当前使用占位盒',
          },
          `${model.key}${imported ? ' ●' : ''}`,
        ),
        // ★ 把**节点数**摆到明面上。
        //   为什么值得占一个位置：它是"每帧 / 每次输入遍历全树"这类写法的**放大倍数**，
        //   而占位盒阶段这些写法全部隐形（全场景 1 个节点）。
        //   实测 rpi-4b = 2067、mpl3115a2 = 13、mpr121 = 1 —— **中间差三个数量级**，
        //   不显示出来，用户没有任何办法预感到换模型会变卡。
        imported?.nodes !== undefined &&
          createElement(
            'span',
            {
              style: { flex: 'none', opacity: 0.5, fontSize: '11px' },
              title: `${imported.nodes} 个节点 —— 遍历/绘制成本按它放大`,
            },
            `${imported.nodes}`,
          ),
        createElement(
          'button',
          {
            type: 'button',
            // ★ 直接在本面板里搜——不再跳浏览器让用户自己点进去
            onClick: () => void runSearch(searchQueryFor(model.key), model.key),
            style: BUTTON_STYLE,
            title: '在本面板里搜这个型号的 3D 模型',
          },
          '找模型',
        ),
        createElement(
          'button',
          {
            type: 'button',
            disabled: props.disabled,
            onClick: () => beginPick(model.key),
            style: BUTTON_STYLE,
          },
          '导入',
        ),
        imported
          ? createElement(
              'button',
              {
                type: 'button',
                onClick: () => props.onRemove(model.key),
                style: BUTTON_STYLE,
              },
              '清除',
            )
          : null,
      )
    }),
  )
}

const PROVIDES_LABEL: Record<ModelSource['provides'], string> = {
  geometry: '几何',
  symbol: '符号',
  datasheet: '手册',
  search: '搜索',
}

const RESULT_BOX_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '7px',
  padding: '8px',
  borderRadius: '6px',
  background: 'rgba(8, 11, 16, 0.92)',
  border: '1px solid rgba(120, 140, 170, 0.22)',
  maxHeight: '240px',
  overflowY: 'auto',
  // ★ 同 ① 的列表：不让滚轮到尽头后**漏给场景**去缩放镜头
  overscrollBehavior: 'contain',
} as const

/**
 * 面板内的**搜索结果列表** —— 用户不用再跳浏览器点回来。
 *
 * ★ 合规边界（别混淆）：结果来自**宿主自带的搜索服务**（`ctx.web.search`），
 *   那是被认可的检索通道，我们**不解析/不镜像/不索引**任何站点；
 *   而直接抓 EasyEDA/LCSC 的搜索页是**自动化访问特定平台**（403 + 条款明文禁止）。
 *   两者看着都像"搜索"，性质完全不同。
 */
export interface SearchResultsProps {
  readonly result: ModelSearchResult
  /** 候选「一键导入」的目标型号键。 */
  readonly targetKey: string
  readonly onTargetKeyChange: (modelKey: string) => void
  readonly onImportCandidate: (candidate: ModelCandidate) => void
  readonly importingId: string | null
}

export function SearchResults(props: SearchResultsProps) {
  const { result } = props

  // 降级：搜索不可用 ⇒ 说清原因，并指向外部站点直链那条兜底路径
  if (result.unavailable !== undefined) {
    return createElement(
      'div',
      { style: RESULT_BOX_STYLE },
      createElement('div', { style: { color: '#ffc266' } }, '搜索不可用'),
      createElement(
        'div',
        { style: { opacity: 0.7, fontSize: '10px', lineHeight: 1.35 } },
        result.unavailable,
      ),
      createElement(
        'div',
        { style: { opacity: 0.7, fontSize: '10px', lineHeight: 1.35 } },
        '可展开下面的「外部站点直链」，自行前往查找。',
      ),
    )
  }

  if (result.candidates.length === 0 && result.sources.length === 0) {
    return createElement(
      'div',
      { style: { opacity: 0.55, fontSize: '10px' } },
      `没有搜到结果（${result.query}）—— 换个说法或加 "STEP" 再试`,
    )
  }

  return createElement(
    'div',
    { style: RESULT_BOX_STYLE },
    // ① **可一键导入的候选**（优先展示）——全程不跳浏览器
    result.candidates.length > 0
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          createElement(
            'div',
            { style: { color: '#8fe3a1', fontSize: '10px' } },
            `★ ${result.candidates.length} 个可一键导入（宿主代取，不用你去下载）`,
          ),
          createElement(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: '4px' } },
            createElement('span', { style: { opacity: 0.6, fontSize: '10px' } }, '导入到'),
            createElement(
              'select',
              {
                value: props.targetKey,
                onChange: (event: { target: HTMLSelectElement }) =>
                  props.onTargetKeyChange(event.target.value),
                style: {
                  flex: '1',
                  minWidth: '0',
                  padding: '2px 4px',
                  borderRadius: '4px',
                  border: '1px solid rgba(120, 140, 170, 0.3)',
                  background: 'rgba(10, 14, 20, 0.9)',
                  color: 'inherit',
                  font: 'inherit',
                },
              },
              ...Object.values(HARDWARE_MODELS).map((model) =>
                createElement('option', { key: model.key, value: model.key }, model.label),
              ),
            ),
          ),
          ...result.candidates.map((candidate) =>
            createElement(CandidateRow, {
              key: candidate.id,
              candidate,
              importing: props.importingId === candidate.id,
              onImport: props.onImportCandidate,
            }),
          ),
        )
      : null,
    // ② **外链兜底** —— 用户自己点进去下
    result.sources.length > 0
      ? createElement(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
          // ★ 没有候选时要说清**为什么**，否则用户看到空列表会以为坏了。
          //   step.parts 收的是**板卡 / 模块 / 机械件**，裸芯片不在其中
          //   （实测：BME280/DHT22/SHT31/MPU6050 全 0；Bosch 只有 LGA **焊盘封装**，不是实体元件）。
          result.candidates.length === 0
            ? createElement(
                'div',
                { style: { color: '#ffc266', opacity: 0.8, fontSize: '10px', lineHeight: 1.35 } },
                '没有可一键导入的候选：step.parts 收的是**板卡 / 模块 / 机械件**，' +
                  '裸芯片（如 BME280）不在其中。请用下面的外链自行下载后点「导入」。',
              )
            : null,
          createElement(
            'div',
            { style: { opacity: 0.45, fontSize: '10px' } },
            `${result.sources.length} 条外链 · 点击在新标签页打开，下载后回来点「导入」`,
          ),
          ...result.sources.map((source, index) => {
            let host = source.url
            try {
              host = new URL(source.url).hostname
            } catch {
              /* 非法 URL 就显示原串 */
            }
            const direct = looksLikeModelFile(source.url)
            return createElement(
              'div',
              {
                key: `${source.url}#${index}`,
                style: { display: 'flex', flexDirection: 'column', gap: '1px' },
              },
              createElement(
                'a',
                {
                  href: source.url,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                  style: { color: '#8fb7ff', textDecoration: 'none' },
                  title: source.url,
                },
                source.title ?? host,
              ),
              createElement(
                'div',
                { style: { opacity: 0.4, fontSize: '10px' } },
                direct ? `${host} · ★ 可能是直链（.glb/.gltf）` : host,
              ),
              source.snippet
                ? createElement(
                    'div',
                    { style: { opacity: 0.32, fontSize: '10px', lineHeight: 1.3 } },
                    source.snippet.slice(0, 120),
                  )
                : null,
            )
          }),
        )
      : null,
    createElement(
      'div',
      { style: { opacity: 0.4, fontSize: '10px', lineHeight: 1.3 } },
      '外链的「可能是直链」只是按扩展名猜的 —— 真格式以服务端按内容检测为准。',
    ),
  )
}

/** 一个可一键导入的候选：预览图 + 规格 + 导入按钮。 */
export function CandidateRow(props: {
  readonly candidate: ModelCandidate
  readonly importing: boolean
  readonly onImport: (candidate: ModelCandidate) => void
}) {
  const { candidate } = props
  const size = candidate.sizeMm
  // ⚠️ 厚度通常缺失（多数型号连长宽都没有）—— 不假装知道，照实标
  const sizeText =
    size?.length !== undefined || size?.width !== undefined
      ? `${size?.length ?? '?'} × ${size?.width ?? '?'} mm（厚未知，需人工确认）`
      : '尺寸未知（需人工确认）'
  // ⚠️ `byteSize` 量的是**源文件（STEP）**，不是实际下载的 GLB —— 两者可差近 10 倍
  //    （实测：树莓派 4B 的 STEP 52MB / GLB 5.7MB）。所以必须标清楚，否则误导用户以为要下 52MB。
  const sourceBytes =
    candidate.byteSize !== undefined
      ? `源文件(STEP) ${(candidate.byteSize / 1024 / 1024).toFixed(1)} MB`
      : undefined

  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        gap: '6px',
        alignItems: 'flex-start',
        padding: '6px',
        borderRadius: '5px',
        background: 'rgba(16, 22, 30, 0.9)',
        border: '1px solid rgba(120, 140, 170, 0.18)',
      },
    },
    candidate.previewUrl
      ? createElement('img', {
          src: candidate.previewUrl,
          alt: '',
          loading: 'lazy',
          style: { width: '42px', height: '42px', objectFit: 'contain', flex: 'none' },
        })
      : null,
    createElement(
      'div',
      { style: { flex: '1', minWidth: '0', display: 'flex', flexDirection: 'column', gap: '2px' } },
      createElement(
        'div',
        { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: candidate.name },
        candidate.name,
      ),
      candidate.manufacturer
        ? createElement('div', { style: { opacity: 0.45, fontSize: '10px' } }, candidate.manufacturer)
        : null,
      createElement('div', { style: { opacity: 0.45, fontSize: '10px' } }, sizeText),
      sourceBytes
        ? createElement('div', { style: { opacity: 0.35, fontSize: '10px' } }, sourceBytes)
        : null,
      candidate.pageUrl
        ? createElement(
            'a',
            {
              href: candidate.pageUrl,
              target: '_blank',
              rel: 'noopener noreferrer',
              style: { color: '#8fb7ff', opacity: 0.75, fontSize: '10px', textDecoration: 'none' },
            },
            '查看来源页',
          )
        : null,
    ),
    createElement(
      'button',
      {
        type: 'button',
        disabled: props.importing || !candidate.importable,
        onClick: () => props.onImport(candidate),
        style: { ...BUTTON_STYLE, flex: 'none', opacity: candidate.importable ? 1 : 0.4 },
        title: candidate.importable ? '宿主代取并导入' : '该候选没有可代取的直链',
      },
      props.importing ? '导入中…' : '一键导入',
    ),
  )
}

/**
 * 外部来源链接列表。
 *
 * ★ 两条实现细节都是"踩过坑的类型"，别改：
 *   · **用真 `<a>` 而不是 `window.open()`** —— 后者会被弹窗拦截器挡掉，
 *     而且用户看不到自己要去哪；真链接还能中键在新标签页打开。
 *   · **`rel="noopener noreferrer"` 不能省** —— 否则目标页能通过 `window.opener` 反控本面板。
 *
 * ★ 我们**不访问**这些站点：链接只是把用户送到他自己的浏览器里，浏览与下载都在那边完成。
 *   这正是厂商条款明文保留的 "browse, download and use individual projects in the ordinary course"。
 */
export function ModelSourceList(props: { readonly query: string }) {
  // 查询词为空时给一个通用词，避免把空串代进模板
  const query = props.query.trim() === '' ? '3D model STEP glb' : props.query

  return createElement(
    'div',
    {
      style: {
        display: 'flex',
        flexDirection: 'column',
        gap: '7px',
        padding: '8px',
        borderRadius: '6px',
        background: 'rgba(8, 11, 16, 0.92)',
        border: '1px solid rgba(120, 140, 170, 0.22)',
      },
    },
    createElement(
      'div',
      { style: { opacity: 0.45, fontSize: '10px' } },
      '在你自己的浏览器里打开并下载 · 我们不访问这些站点',
    ),
    ...MODEL_SOURCES.map((source) =>
      createElement(
        'div',
        { key: source.id, style: { display: 'flex', flexDirection: 'column', gap: '1px' } },
        createElement(
          'a',
          {
            href: sourceUrl(source, query),
            target: '_blank',
            rel: 'noopener noreferrer',
            style: { color: '#8fb7ff', textDecoration: 'none' },
            title: source.note ?? '',
          },
          `${source.label} [${PROVIDES_LABEL[source.provides]}]`,
        ),
        source.note
          ? createElement(
              'div',
              { style: { opacity: 0.42, fontSize: '10px', lineHeight: 1.35 } },
              source.note,
            )
          : null,
        source.urlTemplate.includes('{q}')
          ? null
          : createElement(
              'div',
              { style: { color: '#ffc266', opacity: 0.7, fontSize: '10px' } },
              '该来源不接搜索词，打开后需自行搜索',
            ),
      ),
    ),
    createElement(
      'div',
      { style: { color: '#ffc266', opacity: 0.62, fontSize: '10px', lineHeight: 1.35 } },
      '⚠️ 站点深链可能因改版失效（我们无法自动验证）。失效就用第一项「网络搜索」。',
    ),
  )
}

/**
 * DSH 的品牌图腾：**虎鲸**（`D:\dsh-desktop\resources\icon.png` 是那只）。
 *
 * ★ 为什么内联 SVG 而不是用那张 PNG：
 *   · PNG **125 KB**，为一个标题小图标引入不划算；
 *   · 它带**圆角方底**（不透明），放进面板会多出一块色块；
 *   · 不可主题化 —— `currentColor` 能跟着深浅色皮肤走。
 *
 * ★ 形状要点：虎鲸的可辨识性**不在轮廓，在负空间** ——
 *   大片**白腹部** + **白眼斑**（斑里还有个小黑眼点）。
 *   做成实心块在 16px 下会糊成一坨，所以用 `fill-rule="evenodd"` 把这两块**挖成真空**
 *   （不是填成背景色 —— 那样换主题就露馅）。
 */
export function WhaleIcon(props: { readonly size: number }) {
  return createElement(
    'svg',
    {
      width: props.size,
      height: props.size,
      viewBox: '0 0 24 24',
      fill: 'currentColor',
      'aria-hidden': true,
      focusable: false,
      style: { display: 'block', flex: 'none' },
    },
    createElement('path', {
      fillRule: 'evenodd',
      d:
        // ── 身体：头在右、尾在左，背鳍在顶、双尾鳍在左 ──
        'M20.6 11.4C20.6 9.4 19 7.6 16.6 6.9C15.2 6.5 14.4 6.4 13.6 6.5' +
        'C12.9 4.4 11.9 3.2 10.9 3.2C10.2 3.2 9.8 4.2 10.1 6.8' +
        'C8.2 7 6.8 7.8 5.9 9C5.2 7.2 4.2 5.6 2.6 4.8' +
        'C2 6.6 2.4 8.6 4.9 10.6C2.6 11.8 2.1 13.6 2.9 15.2' +
        'C4.4 14.2 5.4 13.4 6.1 12.6C6.9 15 8.9 16.6 11.6 16.9' +
        'C15 17.3 18.4 16 19.9 13.8C20.4 13.1 20.6 12.3 20.6 11.4Z' +
        // ── 负空间①：白腹部 ──
        // ★ 每个负空间子路径都必须**完整落在身体轮廓内**，否则 evenodd 会把它
        //   露在外面的那一段翻成**实心**（交叉数 1 ⇒ 奇）。这不是风格问题，是错。
        //   校验：`node spike/svg-ascii.mjs` —— 会按"被几层包住"分类渲染，
        //   越界像素标成 XX。改这两个椭圆后**务必重跑**。
        'M9.2 14.5a3.4 1.8 0 1 0 6.8 0a3.4 1.8 0 1 0 -6.8 0Z' +
        // ── 负空间②：白眼斑 ──
        'M15.9 10.5a1.4 1 0 1 0 2.8 0a1.4 1 0 1 0 -2.8 0Z' +
        // ── 眼斑里的黑眼点（嵌在洞里 ⇒ 又被填回来；同样必须整体在眼斑内）──
        'M16.45 10.85a0.45 0.45 0 1 0 0.9 0a0.45 0.45 0 1 0 -0.9 0Z',
    }),
  )
}

export interface ContextMenuItem {
  readonly label: string
  readonly onSelect: () => void
  /** 破坏性操作（删除等）—— 用警示色。 */
  readonly danger?: boolean
}

/**
 * 右键菜单。
 *
 * ★ 场景层只负责**请求**菜单（`InteractionLayer.onContextMenu`），DOM 归 UI 层 ——
 *   这是「场景是投影、不长 DOM」那条边界的延续。
 */
export function ContextMenu(props: {
  readonly x: number
  readonly y: number
  readonly items: readonly ContextMenuItem[]
  readonly onDismiss: () => void
}) {
  return createElement(
    'div',
    {
      // 覆盖全屏的透明层：点任何地方都关闭
      style: { position: 'fixed', inset: '0', zIndex: 20 },
      onClick: props.onDismiss,
      onContextMenu: (event: { preventDefault: () => void }) => {
        event.preventDefault()
        props.onDismiss()
      },
    },
    createElement(
      'div',
      {
        style: {
          ...PANEL_STYLE,
          position: 'fixed',
          left: `${props.x}px`,
          top: `${props.y}px`,
          minWidth: '132px',
          background: 'rgba(10, 14, 20, 0.88)',
          gap: '2px',
        },
        onClick: (event: { stopPropagation: () => void }) => event.stopPropagation(),
      },
      ...props.items.map((item, index) =>
        createElement(
          'button',
          {
            key: `${item.label}#${index}`,
            type: 'button',
            onClick: () => {
              item.onSelect()
              props.onDismiss()
            },
            style: {
              padding: '5px 8px',
              border: 'none',
              borderRadius: '5px',
              background: 'none',
              color: item.danger === true ? '#ff9a9a' : 'inherit',
              font: 'inherit',
              textAlign: 'left',
              cursor: 'pointer',
            },
          },
          item.label,
        ),
      ),
    ),
  )
}

export interface ChatBoxProps {
  /**
   * 发送一条消息给当前会话。
   *
   * `via` 标明**实际走通了哪条通道** —— 界面要显示出来，
   * 否则"客户端主路到底通不通"只能靠猜（这是它的唯一用途）。
   */
  readonly onSend: (text: string) => Promise<{
    ok: boolean
    reason?: string
    via?: 'client' | 'route'
  }>
}

/**
 * 面板内**跟 DS 对话**的浮层输入框。
 *
 * ★ 默认**收起**（只占一行标题），需要时才展开 —— 用户要求"尽量不占用大面积"。
 * ★ 发送走**客户端**的 `session.prompt()`，不经宿主路由（见 `session-chat.ts`）。
 */
export function ChatBox(props: ChatBoxProps) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  /**
   * 提示的语气：**已确认送达** / 弱保证（未确认送达，或走了降级通道）/ 失败。
   *
   * ⚠️ `'ok'`（绿）**当前不可达** —— 因为两条通道现在都无法观测送达
   *   （见 `session-chat.ts` 的「已知盲区」）。
   *   保留它在类型里，是为了三态观测落地后**直接升绿**，而不是那时再改类型。
   *   **绿色只应表示"确认送达"，不应表示"调用成功"。**
   */
  const [tone, setTone] = useState<'ok' | 'weak' | 'error'>('weak')

  const send = async (): Promise<void> => {
    const body = text.trim()
    if (body === '' || sending) return
    setSending(true)
    setHint(null)
    const result = await props.onSend(body)
    setSending(false)
    if (result.ok) {
      setText('')
      if (result.via === 'client') {
        // ★ **不给绿**。绿色的语义是"成了"，而我们现在**无法确认送达** ——
        //   "被接受" ≠ "送到了"：主路恰恰存在"接受但没投递"的盲区。
        //   给绿就是让牌子说谎。
        //   ⇒ "不知道就别默认它是好的" 这条原则，**对自己这条路同样成立**。
        //   （等三态观测落地后，观测到送达才升绿。见 `session-chat.ts` 的「已知盲区」。）
        setTone('weak')
        setHint('已提交（走准入）· 送达未确认 —— 若会话里没出现，请再发一次')
      } else if (result.via === 'route') {
        // ★ **不能静默降级**：消息发出去了，但**保证变弱了** ——
        //   这条通道绕过了准入，附件与队列语义都不可用。
        //   把降级伪装成正常，正是我们那份失败族的形态。
        setTone('weak')
        setHint('已发送 —— 走的是降级通道：未过准入，附件/排队不可用')
      } else {
        setTone('weak')
        setHint('已发送（通道未知 —— 无法确认是否走了准入）')
      }
    } else {
      setTone('error')
      // ★ 失败原因**分类返回**：第一次试就能看出卡在哪一环
      setHint(result.reason ?? '发送失败')
    }
  }

  return createElement(
    Panel,
    {
      // ★ 用**品牌图腾**（虎鲸）而不是 💬 —— 后者是"AI 助手"的通用陈词滥调，
      //   而 DSH 自己的身份就是这只鲸鱼。
      title: createElement(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '5px' } },
        createElement(WhaleIcon, { size: 13 }),
        '对话',
      ),
      subtitle: '发消息给当前会话（不离开面板）',
      defaultOpen: false,
    },
    createElement('input', {
      type: 'text',
      value: text,
      placeholder: '说点什么…（回车发送）',
      disabled: sending,
      onChange: (event: { target: HTMLInputElement }) => setText(event.target.value),
      onKeyDown: (event: { key: string }) => {
        if (event.key === 'Enter') void send()
      },
      style: {
        padding: '5px 7px',
        borderRadius: '6px',
        border: '1px solid rgba(120, 140, 170, 0.3)',
        background: 'rgba(10, 14, 20, 0.55)',
        color: 'inherit',
        font: 'inherit',
      },
    }),
    createElement(
      'button',
      {
        type: 'button',
        disabled: sending || text.trim() === '',
        onClick: () => void send(),
        style: BUTTON_STYLE,
      },
      sending ? '发送中…' : '发送',
    ),
    hint !== null
      ? createElement(
          'div',
          {
            style: {
              fontSize: '10px',
              lineHeight: 1.35,
              // 三档语气：正常成功（绿）/ **弱保证**（琥珀，提醒"这次没走准入"）/ 失败（红）
              color: tone === 'ok' ? '#8fe3a1' : tone === 'weak' ? '#ffc266' : '#ff8080',
            },
          },
          hint,
        )
      : null,
  )
}

export interface NoticeBarProps {
  readonly notice: Notice
  readonly onDismiss: () => void
}

const NOTICE_COLOR: Record<Notice['severity'], string> = {
  info: '#8fb7ff',
  warn: '#ffc266',
  error: '#ff8080',
}

export function NoticeBar(props: NoticeBarProps) {
  const { notice } = props
  return createElement(
    'div',
    {
      onClick: props.onDismiss,
      style: {
        position: 'absolute',
        bottom: '12px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '8px 14px',
        borderRadius: '8px',
        background: 'rgba(10, 14, 20, 0.45)',
        border: `1px solid ${NOTICE_COLOR[notice.severity]}`,
        textShadow: '0 1px 3px rgba(0, 0, 0, 0.95)',
        color: NOTICE_COLOR[notice.severity],
        font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
        cursor: 'pointer',
        maxWidth: '80%',
      },
    },
    notice.text,
  )
}

export function ControlHint() {
  return createElement(
    'div',
    {
      style: {
        position: 'absolute',
        right: '12px',
        bottom: '12px',
        color: 'rgba(200, 212, 232, 0.55)',
        font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
        textAlign: 'right',
        pointerEvents: 'none',
      },
    },
    '拖动组件＝移动 · 拖动端口＝连线 · 点击线缆＝拔线',
    createElement('br'),
    '空白处拖动＝旋转视角 · 滚轮＝缩放',
  )
}
