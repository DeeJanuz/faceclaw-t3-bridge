import { homeFocusRect } from './os-layout'
import { fitLines } from './dashboard'
import type { DashboardPanel } from './dashboard-panel'

export const DASHBOARD_READER_BOX = { width: 544, height: 189 }
export interface DashboardSurface {
  panel: DashboardPanel
  view: 'home' | 'notifications' | 'reader' | 'voice' | 'content' | 'plan'
  title: string
  trailing?: string
  focusLine?: number
  text: string
  footer: string
  actions?: Array<{ key: string; label: string; selected: boolean; previews?: string[] }>
}

/** Home keeps the bell in the top header and the two actions on a fixed line grid. */
export function dashboardSurfaceText(surface: DashboardSurface, _banner?: string): { title: string; text: string; footer: string } {
  if (surface.view !== 'home') return { title: surface.title, text: surface.text, footer: surface.footer }
  const rows = surface.actions?.filter(row => row.key !== 'notifications') ?? []
  const lines = ['', '']
  for (const row of rows) {
    lines.push(fitLines(`${row.selected ? '> ' : ''}${row.label}`, 268, 1))
    if (row.previews?.length) lines.push(...fitLines(row.previews.join('\n'), 268, 4).split('\n'))
    else lines.push('')
  }
  return { title: String(surface.panel.unread), text: lines.join('\n'), footer: surface.footer }
}

export function dashboardSurfaceShape(surface: DashboardSurface, banner?: string): string {
  return surface.view === 'home' ? 'home' : surface.view === 'notifications' ? 'notifications' : `full:${surface.focusLine ?? -1}:${Boolean(banner)}`
}

const WIDTH = 288

/** Sparse border pixels compress well and never include the dashboard sidebar. */
export function dashboardSurfaceTiles(surface: DashboardSurface, _banner?: string): number[][] {
  const pixels = new Array<number>(WIDTH * 288).fill(0)
  const inside = (px: number, py: number, x: number, y: number, width: number, height: number, radius: number) => {
    if (px < x || py < y || px >= x + width || py >= y + height) return false
    const dx = Math.max(x + radius - px, 0, px - (x + width - radius))
    const dy = Math.max(y + radius - py, 0, py - (y + height - radius))
    return dx * dx + dy * dy <= radius * radius
  }
  const rectangle = (x: number, y: number, width: number, height: number, radius: number, brightness: number) => {
    for (let row = y; row < y + height; row++) {
      for (let column = x; column < x + width; column++) {
        if (!inside(column + .5, row + .5, x, y, width, height, radius)) continue
        const inset = brightness === 255 ? 2 : 1
        const inner = inside(column + .5, row + .5, x + inset, y + inset, width - inset * 2, height - inset * 2, radius - inset)
        pixels[row * WIDTH + column] = inner ? 0 : brightness
      }
    }
  }
  if (surface.view === 'home') {
    for (const row of surface.actions ?? []) {
      const rect = homeFocusRect(surface.actions?.map(item => ({ ...item, selected: item === row })))
      rectangle(rect.x - 259, rect.y, rect.width, rect.height, 6, row.selected ? 255 : 70)
    }
    // A small pixel-aligned bell stays in the header regardless of focus.
    const point = (x: number, y: number) => { pixels[(y + 22) * WIDTH + x + 204] = 255 }
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      const arch = Math.abs(Math.hypot(x - 12, y - 11) - 7) < 1 && y <= 11 && y >= 4
      const sides = (x === 5 || x === 6 || x === 18 || x === 19) && y >= 11 && y <= 15
      const rim = y >= 16 && y <= 17 && x >= 3 && x <= 21
      const clapper = y >= 19 && y <= 21 && x >= 10 && x <= 14
      if (arch || sides || rim || clapper) point(x, y)
    }
  }
  return [pixels.slice(0, WIDTH * 144), pixels.slice(WIDTH * 144)]
}
