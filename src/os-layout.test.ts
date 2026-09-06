import { describe, expect, it, vi } from 'vitest'
import { validateEvenHubPageContainer, ImageRawDataUpdateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { buildGlassesPage, GlassesDisplay, type GlassesFrame } from './glasses-display'
import { OS_FULL, OS_NOTIFICATION, OS_NOTIFICATION_CLOSED, OS_READER_CLOSED, homeFocusRect, type OsMotionDirection } from './os-layout'

const panel = { hour: '12', minute: '30', period: 'PM' as const, hour24: 12, date: 'Sat 09/05', batteryPercent: 50, connection: 'Connected', weather: [], unread: 0 }
const reader: GlassesFrame = { header: 'Reader', body: 'A message', dashboardSurface: { view: 'reader', panel, title: 'Reader', text: 'A message', footer: 'Double tap: back' } }
const focus = homeFocusRect([{ selected: false }, { selected: true }])
const motions = [
  ['expand', focus, OS_FULL], ['collapse', OS_FULL, focus],
  ['drop', OS_NOTIFICATION_CLOSED, OS_NOTIFICATION], ['retract', OS_NOTIFICATION, OS_NOTIFICATION_CLOSED],
  ['rise', OS_READER_CLOSED, OS_FULL], ['lower', OS_FULL, OS_READER_CLOSED],
] as const
const bridgeMock = () => ({ createStartUpPageContainer: vi.fn().mockResolvedValue(0),
  rebuildPageContainer: vi.fn().mockResolvedValue(true), textContainerUpgrade: vi.fn().mockResolvedValue(true), updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success) })

describe('Even OS native transitions', () => {
  it.each(['notifications', 'content', 'plan', 'voice'] as const)('validates every %s container and z-order', view => {
    const page = buildGlassesPage({ ...reader, dashboardSurface: { ...reader.dashboardSurface!, view, focusLine: view === 'content' ? 0 : undefined, text: '> Selected row\nOther row' } })
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    const orders = page.textObject!.map(item => item.zOrderIndex)
    expect(new Set(orders).size).toBe(orders.length)
    expect(page.textObject!.filter(item => item.isEventCapture === 1)).toHaveLength(1)
  })
  it('keeps quoted transcript text outside the interactive focus treatment', () => {
    const page = buildGlassesPage({ ...reader, dashboardSurface: { ...reader.dashboardSurface!, view: 'content', text: '> A quoted message' } })
    expect(page.textObject?.some(item => item.containerName === 'os-focus')).toBe(false)
  })
  it.each(motions)('%s stays within the display and never sends intermediate images', async (direction, from, to) => {
    const bridge = bridgeMock()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({ ...reader, motion: { direction, from, to, id: 1 } })
    expect(bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(1)
    expect(bridge.rebuildPageContainer.mock.calls.length).toBeLessThanOrEqual(12)
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    const pages = bridge.rebuildPageContainer.mock.calls.map(([page]) => page)
    for (const page of pages) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.textObject.filter((item: any) => item.isEventCapture === 1)).toHaveLength(1)
      expect(page.imageObject).toEqual([])
    }
    const outlines = pages.slice(0, 2).map(page => page.textObject.find((item: any) => item.containerName === 'os-transition'))
    if (outlines.length > 1) expect(outlines[0].height < outlines[1].height).toBe(['expand', 'rise', 'drop'].includes(direction))
    expect(pages.at(-1).textObject.find((item: any) => item.containerName === 'body')).toMatchObject({ xPosition: 16, width: 544 })
  })
  it('skips remaining samples and commits the final layout when an acknowledgement is slow', async () => {
    const bridge = bridgeMock()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let elapsed = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
    bridge.rebuildPageContainer.mockImplementation(async () => { elapsed += 250; return true })
    try {
      await display.render({ ...reader, motion: { direction: 'rise', from: OS_READER_CLOSED, to: OS_FULL, id: 1 } })
      expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
      expect(bridge.rebuildPageContainer.mock.lastCall![0].textObject).toContainEqual(expect.objectContaining({ content: 'A message' }))
    } finally { clock.mockRestore() }
  })
  it('serializes final layouts and recovers after a rejected update', async () => {
    const bridge = bridgeMock()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (accepted: boolean) => void
    bridge.rebuildPageContainer.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const opening = display.render({ ...reader, motion: { direction: 'rise' as OsMotionDirection, from: OS_READER_CLOSED, to: OS_FULL, id: 1 } })
    await vi.waitFor(() => expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce())
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    release(false)
    await expect(opening).rejects.toThrow('OS transition update failed')
    await display.render(reader)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(bridge.rebuildPageContainer.mock.lastCall![0].textObject).toContainEqual(expect.objectContaining({ content: 'A message' }))
  })
  it('skips remaining animation frames when another gesture arrives', async () => {
    const bridge = bridgeMock()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (accepted: boolean) => void
    bridge.rebuildPageContainer.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const opening = display.render({ ...reader, motion: { direction: 'rise', from: OS_READER_CLOSED, to: OS_FULL, id: 1 } })
    await vi.waitFor(() => expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce())
    display.prioritizeInput()
    release(true)
    await opening
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(bridge.rebuildPageContainer.mock.lastCall![0].textObject).toContainEqual(expect.objectContaining({ content: 'A message' }))
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
  })
  it.each(['drop', 'retract'] as const)('animates the actual inbox %s with native samples and one final clock upload', async direction => {
    const bridge = bridgeMock()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const home: GlassesFrame = { ...reader, dashboardSurface: { ...reader.dashboardSurface!, view: 'home', actions: [
      { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: true },
    ] } }
    const inbox: GlassesFrame = { ...home, dashboardSurface: { ...home.dashboardSurface!, view: 'notifications', title: 'Signal', text: 'Friends: Lunch?', trailing: '1/2' } }
    await display.render(direction === 'drop' ? home : inbox)
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    await display.render({ ...(direction === 'drop' ? inbox : home), motion: { direction, id: 1,
      from: direction === 'drop' ? OS_NOTIFICATION_CLOSED : OS_NOTIFICATION,
      to: direction === 'drop' ? OS_NOTIFICATION : OS_NOTIFICATION_CLOSED } })
    const pages = bridge.rebuildPageContainer.mock.calls.map(([page]) => page)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.imageObject).toHaveLength(page === pages.at(-1) ? 1 : 0)
      expect(page.textObject.length).toBeLessThanOrEqual(8)
      expect(page.textObject.some((item: any) => item.containerName === 'home-period')).toBe(page === pages.at(-1))
      expect(page.textObject.find((item: any) => item.containerName === 'home-action-1')).toMatchObject({ xPosition: 259, yPosition: 149 })
      expect(page.textObject.find((item: any) => item.containerName === 'home-details')).toMatchObject({ xPosition: 22, yPosition: 228 })
    }
    expect(bridge.updateImageRawData).toHaveBeenCalledOnce()
  })
})
