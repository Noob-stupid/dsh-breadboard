/**
 * `sidebar.panellist`（全局面板图标）图标组件。
 *
 * ownerProps 由实时 slot 树核实为 `SidebarPanelIconOwnerProps { size: number; active: boolean }`
 * —— 尺寸由侧栏给，选中态由 `active` 给。
 */
import { createElement } from 'react'

export interface PanelIconProps {
  /** 请求的方形边长（像素），由侧栏提供。 */
  readonly size: number
  /** 该面板是否在中央列被选中。 */
  readonly active: boolean
}

/** 引脚位置（在 24×24 viewBox 内的坐标）。 */
const PIN_POSITIONS = [9.5, 12, 14.5] as const

export function HardwareSandboxIcon(props: PanelIconProps) {
  const { size, active } = props

  const pins = PIN_POSITIONS.flatMap((pos) => [
    createElement('line', { key: `l${pos}`, x1: 3, y1: pos, x2: 7, y2: pos }),
    createElement('line', { key: `r${pos}`, x1: 17, y1: pos, x2: 21, y2: pos }),
    createElement('line', { key: `t${pos}`, x1: pos, y1: 3, x2: pos, y2: 7 }),
    createElement('line', { key: `b${pos}`, x1: pos, y1: 17, x2: pos, y2: 21 }),
  ])

  return createElement(
    'svg',
    {
      width: size,
      height: size,
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: active ? 1.9 : 1.5,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
      style: { display: 'block', opacity: active ? 1 : 0.72 },
    },
    createElement('rect', { key: 'body', x: 7, y: 7, width: 10, height: 10, rx: 1.6 }),
    createElement('rect', { key: 'die', x: 10.2, y: 10.2, width: 3.6, height: 3.6, rx: 0.6 }),
    ...pins,
  )
}
