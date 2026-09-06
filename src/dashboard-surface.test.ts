import { describe, expect, it } from 'vitest'
import { dashboardSurfaceText, dashboardSurfaceTiles, type DashboardSurface } from './dashboard-surface'
import { homeFocusRect } from './os-layout'

const home: DashboardSurface = { view: 'home', title: 'HOME', text: '', footer: 'Tap: open',
  panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', batteryPercent: 50, connection: 'Connected', weather: [], unread: 2 },
  actions: [{ key: 'notifications', label: 'Notifications 2', selected: false },
    { key: 'assistant', label: 'Ask assistant', selected: true }, { key: 'sessions', label: 'Sessions', selected: false }] }

describe('dashboard bell and boxed actions', () => {
  it('places the persistent bell count above the two home actions, without a duplicate notification row', () => {
    const text = dashboardSurfaceText(home)
    expect(text.title).toBe('2')
    expect(text.text.split('\n')[2]).toBe('> Ask assistant')
    expect(text.text.split('\n')[4]).toBe('Sessions')
    expect(text.text).not.toContain('Notifications')
    expect(homeFocusRect(home.actions!.map(row => ({ ...row, selected: row.key === 'notifications' })))).toEqual({ x: 367, y: 14, width: 180, height: 40 })
  })
  it('keeps all outlines visible and reserves the bright outline for the selected option', () => {
    const pixels = dashboardSurfaceTiles(home).flat()
    expect(pixels[110 * 288]).toBe(255)
    expect(pixels[165 * 288]).toBe(70)
    expect(pixels[30 * 288 + 108]).toBe(70)
    const focused = dashboardSurfaceTiles({ ...home, actions: home.actions!.map(row => ({ ...row, selected: row.key === 'notifications' })) }).flat()
    expect(focused[30 * 288 + 108]).toBe(255)
    expect(focused[110 * 288]).toBe(70)
  })
  it('leaves background text unchanged when an arrival is overlaid', () => {
    expect(dashboardSurfaceText(home, 'Signal\nFriends: Hello')).toEqual(dashboardSurfaceText(home))
    const reader = { ...home, view: 'reader' as const, title: 'Reader', text: 'Original message' }
    expect(dashboardSurfaceText(reader, 'Signal\nFriends: Hello').text).toBe('Original message')
  })
})
