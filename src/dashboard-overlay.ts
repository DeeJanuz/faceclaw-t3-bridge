import { dashboardSurfaceText, dashboardSurfaceTiles, type DashboardSurface } from './dashboard-surface'
import { OS_NOTIFICATION } from './os-layout'

export const isDashboardLayer = (surface?: DashboardSurface) => surface?.view === 'home' || surface?.view === 'notifications'

/** Keep the home text on its original line grid. Only covered lines disappear. */
export function dashboardLayerText(surface: DashboardSurface, banner?: string) {
  const overlay = surface.view === 'notifications' || Boolean(banner)
  const home = dashboardSurfaceText({ ...surface, view: 'home' })
  const [arrivalTitle, ...arrivalBody] = banner?.split('\n') ?? []
  const foreground = banner ? { title: arrivalTitle!, text: arrivalBody.join('\n') } : overlay ? dashboardSurfaceText(surface) : undefined
  return {
    header: overlay ? ' ' : home.title,
    body: overlay ? home.text.split('\n').map((line, index) => index < 3 ? '' : line).join('\n') : home.text,
    footer: surface.view === 'notifications' ? '' : home.footer,
    overlayTitle: foreground?.title ?? '', overlayBody: foreground?.text ?? '',
    overlayMeta: overlay && !banner ? surface.trailing ?? '' : '',
  }
}

/** Four fixed 288×144 tiles. Opening the overlay changes only its covered pixels. */
export function composeDashboardTiles(panel: number[][], surface: DashboardSurface, banner?: string): number[][] {
  const tiles = Array.from({ length: 4 }, () => new Array<number>(288 * 144).fill(0))
  const put = (x: number, y: number, value: number) => { tiles[(x < 288 ? 0 : 2) + Math.floor(y / 144)]![(y % 144) * 288 + x % 288] = value }
  for (let y = 0; y < 288; y++) for (let x = 0; x < 220; x++) put(x, y, panel[Math.floor(y / 144)]?.[(y % 144) * 220 + x] ?? 0)
  const borders = dashboardSurfaceTiles({ ...surface, view: 'home' }, surface.view === 'home' ? banner : undefined)
  for (let y = 0; y < 288; y++) for (let x = 0; x < 288; x++) {
    const pixel = borders[Math.floor(y / 144)]![(y % 144) * 288 + x]!
    if (pixel) put(x + 259, y, pixel)
  }
  if (surface.view === 'notifications' || banner) {
    const rect = OS_NOTIFICATION
    const inside = (x: number, y: number, inset: number) => {
      const left = rect.x + inset, top = rect.y + inset, right = rect.x + rect.width - inset, bottom = rect.y + rect.height - inset
      if (x < left || x >= right || y < top || y >= bottom) return false
      const radius = 8 - inset
      const dx = Math.max(left + radius - x, 0, x - (right - radius))
      const dy = Math.max(top + radius - y, 0, y - (bottom - radius))
      return dx * dx + dy * dy <= radius * radius
    }
    for (let y = rect.y; y < rect.y + rect.height; y++) for (let x = rect.x; x < rect.x + rect.width; x++) {
      if (inside(x + .5, y + .5, 0)) put(x, y, inside(x + .5, y + .5, 1) ? 0 : 255)
    }
  }
  return tiles
}
