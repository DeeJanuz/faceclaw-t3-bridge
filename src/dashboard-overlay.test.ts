import { describe, expect, it } from 'vitest'
import { composeDashboardTiles, dashboardLayerText, dashboardLayerImageBounds, dashboardLayerImageTiles } from './dashboard-overlay'
import type { DashboardSurface } from './dashboard-surface'
import { OS_NOTIFICATION } from './os-layout'

const home: DashboardSurface = { view: 'home', title: 'HOME', text: '', footer: '',
  panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', batteryPercent: 50, connection: 'Connected', weather: [], unread: 2 },
  actions: [{ key: 'notifications', label: 'Notifications (2)', selected: true, previews: ['Signal\nLunch?', 'Mail\nProject notes'] },
    { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: false }] }

describe('stationary notification overlay', () => {
  it.each([false, true])('preserves every background pixel outside the card (live arrival: %s)', live => {
    const panel = Array.from({ length: 2 }, (_, tile) => Array.from({ length: 220 * 144 }, (_, i) => (tile * 13 + i) % 256))
    const before = composeDashboardTiles(panel, home)
    const after = composeDashboardTiles(panel, live ? home : { ...home, view: 'notifications' }, live ? 'Signal\nFriends: Lunch?' : undefined)
    const pixel = (tiles: number[][], x: number, y: number) => tiles[(x < 288 ? 0 : 2) + Math.floor(y / 144)]![(y % 144) * 288 + x % 288]
    let moved = 0
    for (let y = 0; y < 288; y++) for (let x = 0; x < 576; x++) {
      const r = OS_NOTIFICATION
      if (x < r.x || x >= r.x + r.width || y < r.y || y >= r.y + r.height) {
        if (pixel(before, x, y) !== pixel(after, x, y)) moved++
      }
    }
    expect(moved).toBe(0)
    expect(after[1]).toEqual(before[1])
    expect(after[3]).toEqual(before[3])
    expect(pixel(after, 40, 40)).toBe(0)
  })
  it('keeps the home footer during transient arrivals', () => {
    expect(dashboardLayerText({ ...home, footer: 'Swipe: select | Tap: open' }, 'Signal\nFriends: Hello').footer).toBe('Swipe: select | Tap: open')
  })
  it('keeps uncovered home labels on their original rows and places count with the time', () => {
    const before = dashboardLayerText(home)
    const after = dashboardLayerText({ ...home, view: 'notifications', title: 'Signal', text: 'Friends', trailing: '12:30 PM  1/2' })
    expect(after.body.split('\n').slice(3)).toEqual(before.body.split('\n').slice(3))
    expect(after.body.split('\n').slice(0, 3)).toEqual(['', '', ''])
    expect(after.overlayMeta).toBe('12:30 PM  1/2')
    expect(after.footer).toBe('')
    expect(after.overlayBody).toBe('Friends')
  })
})


describe('cropped dashboard image transfers', () => {
  it.each(['home', 'notifications', 'banner', 'previews'] as const)('preserves every visible pixel for %s', scenario => {
    const surface: DashboardSurface = { ...home, view: scenario === 'notifications' ? 'notifications' : 'home',
      actions: home.actions!.map(row => ({ ...row, previews: scenario === 'previews' && row.key === 'assistant' ? ['Long preview'] : row.previews })) }
    const panel = Array.from({ length: 2 }, () => new Array(220 * 144).fill(130))
    const full = composeDashboardTiles(panel, surface, scenario === 'banner' ? 'Signal\nHello' : undefined)
    const bounds = dashboardLayerImageBounds(surface)
    const cropped = dashboardLayerImageTiles(full, surface)
    for (let tile = 0; tile < 4; tile++) {
      const rect = bounds[tile]!
      expect(cropped[tile]).toHaveLength(rect.width * rect.height)
      for (let y = 0; y < 144; y++) for (let x = 0; x < 288; x++) {
        const actual = x < rect.width && y < rect.height ? cropped[tile]![y * rect.width + x] : 0
        if (actual !== full[tile]![y * 288 + x]) throw new Error(`Lost pixel ${tile}:${x},${y}`)
      }
    }
    if (scenario !== 'previews') expect(cropped.flat().length).toBe(134803)
  })
})
