import { describe, expect, it } from 'vitest'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'
import { CLOCK_IMAGE, renderClockPixels } from './dashboard-clock-image'
import { buildGlassesPage, type GlassesFrame } from './glasses-display'

const home: GlassesFrame = { header: 'HOME', body: '', dashboardSurface: {
  view: 'home', title: 'HOME', text: '', footer: '',
  panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', batteryPercent: 50,
    connection: 'Connected', weather: ['72°F', 'Clear', 'Saved city'], unread: 2 },
  actions: [{ key: 'notifications', label: 'Notifications 2', selected: false },
    { key: 'assistant', label: 'Ask assistant', selected: true }, { key: 'sessions', label: 'Sessions', selected: false }] } }

describe('native graphical dashboard', () => {
  it('uses square dots with clear gutters and preserves the reference zero corners', () => {
    const pixels = renderClockPixels('09', '53')
    const pixel = (x: number, y: number) => pixels[y * 128 + x]
    expect(pixels).toHaveLength(128 * 144)
    // The first zero starts at x=4: its corner is blank and top stroke inset.
    expect(pixel(4, 0)).toBe(0)
    expect(pixel(13, 0)).toBe(255)
    expect(pixel(14, 1)).toBe(255)
    expect(pixel(15, 1)).toBe(0)
    expect(pixel(13, 2)).toBe(0)
    expect(pixel(4, 9)).toBe(255)
    expect(pixel(13, 30)).toBe(0)
    expect(pixels.slice(62 * 128, 81 * 128).every(value => value === 0)).toBe(true)
  })
  it('removes the covered hour without moving or altering the minute row', () => {
    const full = renderClockPixels('05', '48')
    const clipped = renderClockPixels('05', '48', 81)
    expect(clipped.slice(0, 81 * 128).every(pixel => pixel === 0)).toBe(true)
    expect(clipped.slice(81 * 128)).toEqual(full.slice(81 * 128))
    expect(clipped.some(pixel => pixel === 255)).toBe(true)
  })
  it.each(['home', 'notifications', 'banner', 'extension'] as const)('fits %s inside the native container and text limits with exactly one clock image', scenario => {
    const page = buildGlassesPage({ ...home, banner: scenario === 'banner' ? 'Signal\nFriends: Lunch?' : undefined,
      dashboardSurface: { ...home.dashboardSurface!,
        view: scenario === 'notifications' ? 'notifications' : 'home', title: 'Signal', text: 'Friends: Lunch?',
        trailing: '12:30 PM  1/2', footer: 'Assistant setup pending',
        ...(scenario === 'extension' ? { actions: [{ key: 'news', label: 'News', selected: true,
          previews: ['A long preview for checking the native card and its available space. '.repeat(4)] }] } : {}),
      } })
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.imageObject).toEqual([expect.objectContaining(CLOCK_IMAGE)])
    expect(page.textObject!.length).toBeLessThanOrEqual(8)
    expect(page.textObject!.filter(item => item.isEventCapture === 1).map(item => item.content)).toEqual([' '])
    for (const item of page.textObject!) {
      expect(item.xPosition! + item.width!).toBeLessThanOrEqual(576)
      expect(item.yPosition! + item.height!).toBeLessThanOrEqual(288)
      expect((item.content ?? '').length).toBeLessThanOrEqual(1000)
      if (item.content?.trim()) {
        // Prevent unintended native scrollbars from undersized text boxes.
        expect(item.content.split('\n').length * 27).toBeLessThanOrEqual(
          item.height! - 2 * (item.paddingLength ?? 0) - 2 * (item.borderWidth ?? 0))
      }
    }
    if (scenario === 'banner') expect(page.textObject).toContainEqual(expect.objectContaining({ content: 'Assistant setup pending' }))
  })
})
