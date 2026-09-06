import { TextContainerProperty } from '@evenrealities/even_hub_sdk'
import { fitLines } from './dashboard'
import type { DashboardSurface } from './dashboard-surface'
import { homeFocusRect, OS_NOTIFICATION, type OsRect } from './os-layout'

function text(id: number, name: string, x: number, y: number, width: number, height: number, content: string) {
  return new TextContainerProperty({ containerID: id, containerName: name,
    xPosition: x, yPosition: y, width, height, content: content || ' ',
    paddingLength: 0, borderWidth: 0, textColor: 4, isEventCapture: 0 })
}

/** Home labels travel in the native page/text path; the clock is one image.
 * Keep outlines fixed: focus is a cursor and text brightness, so swipes never
 * rebuild the page or upload an image. The public SDK cannot resize fonts.
 */
export function nativeDashboard(surface: DashboardSurface, banner?: string, popupRect: OsRect = OS_NOTIFICATION,
  options: { showPeriod?: boolean } = {}): TextContainerProperty[] {
  const panel = surface.panel
  const overlay = surface.view === 'notifications' || Boolean(banner)
  const capture = text(8, 'surface-input', 0, 0, 576, 288, ' ')
  capture.isEventCapture = 1
  const weather = [panel.weather.slice(0, 2).join(' · '), panel.weather.slice(2).join(' · ')].filter(Boolean)
  const items = [capture, text(2, 'home-details', 22, 228, 222, 54,
    weather.map(line => fitLines(line, 222, 1)).join('\n'))]
  if (options.showPeriod !== false) items.push(text(10, 'home-period', 178, 188, 45, 27, panel.period))
  const rows = surface.actions?.filter(row => row.key !== 'notifications') ?? []
  for (const [index, row] of rows.entries()) {
    const rect = homeFocusRect(rows.map(candidate => ({ ...candidate, selected: candidate === row })))
    const content = [fitLines(`${row.selected ? '> ' : ''}${row.label}`, 268, 1),
      ...(row.previews?.length ? fitLines(row.previews.join('\n'), 268, 4).split('\n') : [])]
    const item = text(4 + index, `home-action-${index}`, rect.x, rect.y, rect.width, rect.height, content.join('\n'))
    item.paddingLength = 6
    item.borderWidth = 1
    item.borderColor = 4
    item.borderRadius = 6
    item.textColor = row.selected ? 4 : 2
    if (overlay && rect.y < popupRect.y + popupRect.height) {
      // There is no opaque native fill. Omit covered rows and the intersecting
      // outline, retaining uncovered preview lines at their original baseline.
      const hidden = Math.max(0, Math.ceil((popupRect.y + popupRect.height - rect.y - 6) / 27))
      item.xPosition = rect.x + 6
      item.yPosition = rect.y + 6 + hidden * 27
      item.width = rect.width - 12
      item.height = Math.max(1, rect.height - 6 - hidden * 27)
      item.paddingLength = 0
      item.borderWidth = 0
      item.content = content.slice(hidden).join('\n') || ' '
      if (!item.content.trim()) continue
    }
    items.push(item)
  }
  if (overlay) {
    const [title = '', ...body] = banner?.split('\n') ?? []
    const popup = text(3, 'overlay-border', popupRect.x, popupRect.y, popupRect.width, popupRect.height, ' ')
    popup.borderWidth = 1
    popup.borderColor = 15
    popup.borderRadius = 8
    popup.content = ''
    items.push(popup,
      text(1, 'overlay-title', 32, 22, banner ? 512 : 280, 28, popupRect.height >= 38 ? banner ? title : surface.title : ''),
      text(6, 'overlay-body', 32, 54, 512, 54,
        (banner ? body.join('\n') : surface.text).split('\n').slice(0, Math.max(0, Math.floor((popupRect.y + popupRect.height - 54) / 27))).join('\n')),
      banner ? text(7, 'surface-footer', 269, 243, 268, 27, fitLines(surface.footer, 268, 1))
        : text(7, 'overlay-meta', 324, 22, 220, 28, popupRect.height >= 38 ? surface.trailing ?? '' : ''),
    )
  } else {
    const inbox = text(6, 'home-inbox', 367, 14, 180, 40,
      `${surface.actions?.some(row => row.key === 'notifications' && row.selected) ? '> ' : ''}Notifications ${panel.unread}`)
    inbox.paddingLength = 4
    inbox.borderWidth = 1
    inbox.borderColor = 4
    inbox.borderRadius = 6
    inbox.textColor = surface.actions?.some(row => row.key === 'notifications' && row.selected) ? 4 : 2
    items.push(text(1, 'home-status', 22, 12, 322, 27,
      fitLines(`${panel.date}  ${panel.batteryPercent === null ? '--' : panel.batteryPercent}% · ${panel.connection}`, 322, 1)),
    inbox, text(7, 'surface-footer', 269, 243, 268, 27, fitLines(surface.footer, 268, 1)))
  }
  items.forEach((item, index) => { item.zOrderIndex = index + 1 })
  return items
}
