/**
 * 模型来源清单 —— 共享契约
 * @module dsh-hardware-sandbox/contracts/model-sources
 *
 * ★ **这不是爬虫配置，是"帮你打开一个网页"的链接表。**
 *
 *   用户方案（2026-10-07）：不做自动批量导入，改为**用户自己去找、自己去下**。
 *   我们只提供**搜索入口**——用户在自己的浏览器里完成浏览与下载，
 *   这正落在厂商条款明文允许的 "you may continue to browse, download and use
 *   individual projects in the ordinary course" 里。
 *
 *   ⇒ 我们**不访问**这些站点、**不采集**、**不分发**。三条合规问题同时不存在。
 *
 * ⚠️ **关于 URL 模板的可信度（必须如实说明）**：
 *   这些站点对**自动访问**普遍返回 403（CloudFront / "Just a moment..." 之类），
 *   那正是它们防机器人的方式 —— 也意味着**我们无法用抓取来验证模板是否正确**。
 *   所以：
 *   · 每个模板都只是**尽力而为的深链**，站点改版后可能失效；
 *   · **通用网络搜索是兜底**（{@link WEB_SEARCH_SOURCE}），它不依赖任何站点的 URL 规则；
 *   · 界面上应当让用户**看得出链接可能失效**，而不是静默跳到一个错误页面。
 */
import { findModel } from './library.ts'

/** 这个来源主要能提供什么。 */
export type ModelSourceProvides =
  | 'geometry' // 3D 几何（STEP / glTF / VRML…）
  | 'symbol' // 符号 / 封装（引脚元数据，但**无总线协议/电压**）
  | 'datasheet' // 数据手册（语义的**正确**来源）
  | 'search' // 通用搜索（兜底）

export interface ModelSource {
  readonly id: string
  readonly label: string
  /**
   * 打开的 URL 模板。`{q}` 会被替换为 **URL 编码后**的查询词。
   * 见 {@link sourceUrl}。
   */
  readonly urlTemplate: string
  readonly provides: ModelSourceProvides
  /** 给用户的一句提示（许可、格式、注意事项）。 */
  readonly note?: string
}

/**
 * 通用网络搜索 —— **兜底，且永远可用**。
 *
 * ★ 为什么必须有它：站点深链的 URL 规则我们**无法验证**（见文件头），
 *   而通用搜索不依赖任何站点的规则。**用户不会因为某个模板失效而卡住。**
 */
export const WEB_SEARCH_SOURCE: ModelSource = {
  id: 'web',
  label: '网络搜索（推荐先用这个）',
  urlTemplate: 'https://www.bing.com/search?q={q}',
  provides: 'search',
  note: '不依赖任何站点的 URL 规则，永远可用。建议在查询词里带上 3D model / STEP / glb。',
}

/** 预置来源清单。 */
export const MODEL_SOURCES: readonly ModelSource[] = [
  WEB_SEARCH_SOURCE,
  {
    id: 'grabcad',
    label: 'GrabCAD（社区 3D 模型）',
    urlTemplate: 'https://grabcad.com/library?query={q}',
    provides: 'geometry',
    note: '社区上传，**每个模型的许可不同**，下载前请看清。常见板卡/模块在这里比在元件库里更容易找到。',
  },
  {
    id: 'snapeda',
    label: 'SnapEDA（符号 + 3D）',
    urlTemplate: 'https://www.snapeda.com/search/?q={q}',
    provides: 'geometry',
    note: '以**元件**为主（芯片），模块/板卡覆盖有限。附带引脚元数据，但**不含总线协议与电压**。',
  },
  {
    id: 'lcsc',
    label: '立创商城（料号 + 数据手册）',
    urlTemplate: 'https://so.szlcsc.com/global.html?k={q}',
    provides: 'datasheet',
    note: '**语义（protocol/voltage）的正确来源是数据手册**，不是符号库。这里能找到料号与手册。',
  },
  {
    id: 'raspberrypi',
    label: 'Raspberry Pi 官方文档（机械图）',
    urlTemplate: 'https://www.raspberrypi.com/documentation/computers/raspberry-pi.html',
    provides: 'geometry',
    note: '官方发布的板卡机械尺寸与图纸，许可最干净。**不接搜索词**（站点无搜索深链）。',
  },
]

/**
 * 把查询词代入模板。
 *
 * @param source - 来源
 * @param query - 原始查询词（**不要**预先编码，本函数会编码）
 */
export function sourceUrl(source: ModelSource, query: string): string {
  return source.urlTemplate.replace('{q}', encodeURIComponent(query))
}

/**
 * 为某个型号生成建议的搜索词。
 *
 * ★ 用 `HARDWARE_MODELS[key].label`（如「BME280 温湿度气压传感器」）而不是裸 key ——
 *   站点上认的是人话，不是我们的内部键。
 */
export function searchQueryFor(modelKey: string, extra = '3D model STEP glb'): string {
  const label = findModel(modelKey)?.label ?? modelKey
  return extra === '' ? label : `${label} ${extra}`
}
