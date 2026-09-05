import { describe, expect, it, vi } from 'vitest'
import {
  ImageRawDataUpdateResult,
  StartUpPageCreateResult,
  validateEvenHubPageContainer,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { buildGlassesPage, GlassesDisplay, voiceOverlay, type GlassesFrame } from './glasses-display'
import { panelTiles } from './dashboard-panel'

vi.mock('./dashboard-panel', () => ({ renderDashboardPanel: vi.fn(async panel => panel),
  panelTiles: vi.fn(panel => [new Array(220 * 144).fill(0), new Array(220 * 144).fill(panel.unread)]) }))

function mockBridge() {
  return {
    createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
    rebuildPageContainer: vi.fn().mockResolvedValue(true),
    textContainerUpgrade: vi.fn().mockResolvedValue(true),
    updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success),
  }
}

describe('GlassesDisplay live activity spinner', () => {
  it.each([true, false])('withholds home text through the final image upload (success: %s)', async (success) => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboardSurface: {
      view: 'home', title: 'LISTENING', text: 'Speak now', footer: 'Tap: review',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 0 } } }
    let release!: (result: ImageRawDataUpdateResult) => void
    bridge.updateImageRawData.mockImplementation(async (item) => item.containerID === 12
      ? new Promise<ImageRawDataUpdateResult>(resolve => { release = resolve }) : ImageRawDataUpdateResult.success)
    const opening = display.render(frame)
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4))
    const page = bridge.rebuildPageContainer.mock.lastCall![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.textObject.every((item: any) => item.content === ' ')).toBe(true)
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    release(success ? ImageRawDataUpdateResult.success : ImageRawDataUpdateResult.imageException)
    if (success) await opening
    else {
      await expect(opening).rejects.toThrow('Dashboard card image update failed')
      expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
      bridge.updateImageRawData.mockResolvedValue(ImageRawDataUpdateResult.success)
      await display.render(frame)
      expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    }
    expect(bridge.textContainerUpgrade.mock.calls.map(([item]) => item.content)).toEqual(['0', '\n', 'Tap: review', ' ', ' ', ' '])
  })
  it('opens full-screen voice with zero image calls', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const home: GlassesFrame = { header: 'HOME', body: '', dashboardSurface: {
      view: 'home', title: 'HOME', text: '', footer: '',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 0 },
      actions: [{ key: 'assistant', label: 'Ask assistant', selected: true }, { key: 'sessions', label: 'Sessions', selected: false }] } }
    await display.render(home)
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    bridge.textContainerUpgrade.mockClear()
    await display.render({ ...home, dashboardSurface: { ...home.dashboardSurface!, view: 'voice', title: 'LISTENING', text: 'Speak now' } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    const page = bridge.rebuildPageContainer.mock.lastCall![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.imageObject).toEqual([])
    expect(page.textObject.find((item: any) => item.containerName === 'body')).toMatchObject({ xPosition: 16, width: 544, height: 216 })
    expect(page.textObject.find((item: any) => item.containerName === 'body').content).toBe('Speak now')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
  })
  it('uses native expanded surfaces and restores home images on return', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const panel = { hour: '12', minute: '30', period: 'PM' as const, hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 2 }
    const home: GlassesFrame = { header: 'HOME', body: '', askAssistant: true,
      dashboardSurface: { view: 'home', panel, title: 'HOME', text: '', footer: 'Tap: open',
        actions: [{ key: 'notifications', label: 'Notifications (2)', selected: true, previews: ['Signal\nMessage'] },
          { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: false }] } }
    await display.render(home)
    expect(validateEvenHubPageContainer(bridge.rebuildPageContainer.mock.lastCall![0])).toEqual({ valid: true })
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    const inbox: GlassesFrame = { header: 'HOME', body: '', menuItems: [],
      card: { title: 'NOTIFICATIONS 1/2', body: 'Message', placement: 'dashboard', presentation: 'notifications' },
      dashboardSurface: { view: 'notifications', panel, actions: home.dashboardSurface!.actions, title: 'NOTIFICATIONS 1/2', text: '> Signal · Friends\nMessage', footer: 'Tap: read' } }
    const reader: GlassesFrame = { header: 'Signal · Friends', body: 'Message', menuItems: [{ itemID: 4, itemName: 'Dismiss notification' }],
      dashboardSurface: { view: 'reader', panel, title: 'Signal · Friends 1/1', text: 'Message', footer: 'Tap: reply | Hold: dismiss' } }
    for (const frame of [inbox, reader, { ...reader, banner: 'New arrival\nHello' }, reader, inbox, home]) await display.render(frame)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(4)
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([9, 11, 9, 10, 11, 12, 9, 11])
    expect(bridge.rebuildPageContainer.mock.calls.some(([page]) => page.textObject.some((item: any) => item.containerName === 'header' && item.content === 'New arrival'))).toBe(true)
    expect(bridge.rebuildPageContainer.mock.lastCall![0].textObject.some((item: any) => item.containerName === 'overlay-body')).toBe(true)
    const page = buildGlassesPage(reader)
    expect(page.menuObject?.menuItems).toContainEqual(expect.objectContaining({ itemID: 4 }))
    expect(page.textObject?.filter(item => item.isEventCapture === 1).map(item => item.containerName)).toEqual(['surface-input'])
    expect(page.textObject?.find(item => item.containerName === 'surface-input')).toMatchObject({ width: 576, height: 288, content: ' ' })
    expect(page.textObject?.filter(item => item.content?.trim()).map(item => item.content)).toEqual([
      'Signal · Friends 1/1', 'Message', 'Tap: reply | Hold: dismiss',
    ])
    expect(voiceOverlay(home, 'LISTENING', 'Speak').dashboardSurface).toBeUndefined()
  })
  it('recovers a failed fixed-surface update and stays image-free after leaving a reader', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboardSurface: {
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 1 },
      view: 'reader', title: 'HOME', text: 'Notifications', footer: '' } }
    await display.render(frame)
    const next = { ...frame, dashboardSurface: { ...frame.dashboardSurface!, text: 'Reader' } }
    bridge.textContainerUpgrade.mockResolvedValueOnce(false)
    await expect(display.render(next)).rejects.toThrow('Dashboard text update failed')
    await display.render(next)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    await display.render({ header: 'T3', body: 'Full transcript' })
    bridge.updateImageRawData.mockClear()
    await display.render(frame)
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([])
  })
  it('fits pinned previews and uses native geometry steps without intermediate image animation', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const home: GlassesFrame = { header: 'HOME', body: '', askAssistant: true, dashboard: { left: 'Clock',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Fri 09/04', connection: 'Connected', batteryPercent: 50, weather: [], unread: 3 },
      actions: [{ key: 'notifications', label: 'Notifications (3)', selected: true, previews: ['Awaiting input\nB1 - Newest session', 'Awaiting input\nB2 - Older session'] },
        { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: false }] } }
    await display.render(home)
    const rows = bridge.rebuildPageContainer.mock.calls.at(-1)![0].textObject.filter((item: any) => item.containerName.startsWith('action-'))
    expect(rows[0].content).toContain('Awaiting input\nB1 - Newest session')
    expect(rows[0].yPosition + rows[0].height).toBeLessThan(rows[1].yPosition)
    const expanded: GlassesFrame = { ...home, card: { presentation: 'notifications', placement: 'dashboard', entrance: 'down', transition: 1,
      title: 'NOTIFICATIONS 1/3', body: '> Awaiting input\n  B1 - Newest session' }, menuItems: [] }
    await display.render(expanded)
    const cards = bridge.rebuildPageContainer.mock.calls.slice(1).map(([page]) => page.textObject.find((item: any) => item.containerName === 'voice-card'))
    expect(cards.map((card: any) => card.height)).toEqual([258])
    expect(cards.every((card: any) => card.isEventCapture === 0)).toBe(true)
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    await display.render({ header: 'THREAD', body: 'The selected session', askAssistant: true, motion: { direction: 'rise', id: 2, from: { x: 0, y: 286, width: 576, height: 2 }, to: { x: 0, y: 0, width: 576, height: 288 } } })
    expect(bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(3)
    expect(bridge.updateImageRawData.mock.calls.every(([update]) => update.imageData.length <= 400)).toBe(true)
    bridge.updateImageRawData.mockClear()
    await display.render({ ...home, motion: { direction: 'collapse', id: 3, from: { x: 0, y: 0, width: 576, height: 288 }, to: { x: 259, y: 178, width: 288, height: 42 } } })
    expect(bridge.rebuildPageContainer.mock.calls.length).toBeGreaterThan(6)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
    expect(bridge.rebuildPageContainer.mock.calls.some(([page]) => page.textObject.some((item: any) => item.containerName.startsWith('slide-')))).toBe(false)
    for (const [page] of bridge.rebuildPageContainer.mock.calls) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.textObject.filter((item: any) => item.isEventCapture === 1)).toHaveLength(1)
    }
    expect(bridge.rebuildPageContainer.mock.calls.at(-1)![0].menuObject).toBeDefined()
  })
  it('keeps transcript text behind an opaque voice card and reuses its backdrop during review', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame: GlassesFrame = { header: 'THREAD', body: 'Original transcript remains behind the card',
      card: { title: 'LISTENING', body: 'Speak your message', presentation: 'voice' } }
    await display.render(frame)
    const page = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.textObject.find((item: any) => item.containerName === 'body').content).toBe(frame.body)
    expect(page.imageObject).toHaveLength(4)
    expect(page.imageObject.every((item: any) => item.xPosition >= 28 && item.yPosition >= 29 && item.yPosition + item.height <= 259)).toBe(true)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4)
    bridge.updateImageRawData.mockClear()
    await display.render({ ...frame, card: { ...frame.card!, title: 'REVIEW', body: 'My answer' } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
  })
  it('refreshes the changed sidebar count before revealing expanded notification text', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 1 },
      actions: [{ key: 'notifications', label: 'Notifications (1)', selected: true, previews: ['AB - First'] }] },
      card: { title: 'NOTIFICATIONS 1/1', body: 'AB - First', presentation: 'notifications', placement: 'dashboard' } }
    await display.render(frame)
    bridge.rebuildPageContainer.mockClear()
    bridge.textContainerUpgrade.mockClear()
    bridge.updateImageRawData.mockClear()
    await display.render({ ...frame, dashboard: { ...frame.dashboard!, panel: { ...frame.dashboard!.panel!, unread: 2 } },
      card: { ...frame.card!, title: 'NOTIFICATIONS 1/2' } })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
    expect(bridge.updateImageRawData.mock.calls.map(([update]) => update.containerID)).toEqual([10])
    expect(bridge.textContainerUpgrade.mock.invocationCallOrder[0]).toBeGreaterThan(bridge.updateImageRawData.mock.invocationCallOrder[0]!)
  })
  it('waits for sidebar images before showing notification text without covered dashboard labels', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (result: ImageRawDataUpdateResult) => void
    bridge.updateImageRawData.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 2 },
      actions: [{ key: 'notifications', label: 'Notifications (2)', selected: true, previews: ['Hidden preview'] },
        { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: false }] },
      card: { title: 'NOTIFICATIONS 1/2', body: 'Signal · Friends', presentation: 'notifications', placement: 'dashboard' } }
    const opening = display.render(frame)
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledOnce())
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.imageObject.map((item: any) => item.containerID)).toEqual([9, 10])
    expect(page.textObject.find((item: any) => item.containerName === 'voice-card').content).toBe(' ')
    expect(page.textObject.filter((item: any) => item.containerName.startsWith('action-')).every((item: any) => item.content === ' ' && item.borderWidth === 0)).toBe(true)
    expect(page.textObject.filter((item: any) => item.isEventCapture === 1).map((item: any) => item.containerName)).toEqual(['body'])
    release(ImageRawDataUpdateResult.success)
    await opening
    bridge.updateImageRawData.mockClear()
    await display.render({ ...frame, card: { ...frame.card!, body: 'Another notification' } })
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    await display.render({ ...frame, card: undefined })
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([9, 10])
    expect(bridge.rebuildPageContainer.mock.lastCall![0].textObject.find((item: any) => item.containerName === 'action-0').content).toContain('Hidden preview')
  })
  it('compares sidebar pixels, retries failed tiles, and invalidates cached pixels after a rebuild', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 1 } } }
    await display.render(frame)
    bridge.updateImageRawData.mockClear()
    // A model change with identical rendered pixels should cost no transfer.
    await display.render({ ...frame, dashboard: { ...frame.dashboard!, panel: { ...frame.dashboard!.panel!, connection: 'Equivalent pixels' } } })
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    const changed = { ...frame, dashboard: { ...frame.dashboard!, panel: { ...frame.dashboard!.panel!, unread: 2 } } }
    bridge.updateImageRawData.mockRejectedValueOnce(new Error('Synthetic transport failure'))
    await expect(display.render(changed)).rejects.toThrow('Dashboard image update failed')
    await display.render(changed)
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([10, 10])
    bridge.updateImageRawData.mockClear()
    // Both tiles may change (the large minute glyph straddles their boundary).
    vi.mocked(panelTiles).mockReturnValueOnce([new Array(220 * 144).fill(3), new Array(220 * 144).fill(4)])
    await display.render(frame)
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([9, 10])
    bridge.updateImageRawData.mockClear()
    await display.runDiagnostic(async render => { await render({ header: 'Probe', body: 'Synthetic' }) })
    expect(bridge.updateImageRawData.mock.calls.filter(([item]) => item.imageData.length === 220 * 144).map(([item]) => item.containerID)).toEqual([9, 10])
  })
  it('keeps the dashboard panel and actions beneath a right-side voice card within native limits', async () => {
    const background: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: 'Clock',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Fri 09/04', connection: 'Connected', batteryPercent: 50, weather: [], unread: 2 },
      actions: ['Ask assistant', 'Sessions', 'Notifications (2)'].map(label => ({ key: label, label, selected: false })) } }
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render(voiceOverlay(background, 'LISTENING', 'Speak'))
    const page = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.imageObject).toHaveLength(2)
    expect(page.imageObject.slice(0, 2).every((item: any) => item.xPosition === 0 && item.width === 220)).toBe(true)
    expect(page.textObject.filter((item: any) => item.containerName.startsWith('action-'))).toHaveLength(3)
    expect(page.textObject.find((item: any) => item.containerName === 'voice-card').xPosition).toBe(272)
    expect(page.textObject.find((item: any) => item.containerName === 'voice-card').content).toBe(' ')
    expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ containerName: 'voice-card', content: 'LISTENING\n\nSpeak' }))
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([9, 10])
    for (const row of page.textObject.filter((item: any) => item.containerName.startsWith('action-'))) {
      expect(row.xPosition + row.width).toBeLessThanOrEqual(272)
      expect(row.content).toBe(' ')
    }
    bridge.updateImageRawData.mockClear()
    await display.render(voiceOverlay(background, 'REVIEW', 'My answer'))
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    await display.render(voiceOverlay({ ...background, header: 'CHANGED', body: 'New background' }, 'REVIEW', 'My answer'))
    expect(bridge.textContainerUpgrade.mock.calls.every(([item]) => item.containerName === 'voice-card')).toBe(true)
    await display.render(background)
    const restored = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(restored.textObject.find((item: any) => item.containerName === 'action-0').content).toContain('Ask assistant')
    expect(validateEvenHubPageContainer(restored)).toEqual({ valid: true })
  })
  it('withholds dashboard voice text during a stalled sidebar upload and clips pinned previews', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (result: ImageRawDataUpdateResult) => void
    bridge.updateImageRawData.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const background: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat 09/05', connection: 'Connected', batteryPercent: 50, weather: [], unread: 1 },
      actions: [{ key: 'notifications', label: 'Notifications (1)', selected: true, previews: ['AB - First'] },
        { key: 'assistant', label: 'Ask assistant', selected: false }, { key: 'sessions', label: 'Sessions', selected: false }] } }
    const opening = display.render(voiceOverlay(background, 'LISTENING', 'Speak'))
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledOnce())
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.textObject.find((item: any) => item.containerName === 'voice-card').content).toBe(' ')
    expect(page.textObject.filter((item: any) => item.containerName.startsWith('action-')).every((item: any) => item.content === ' ' && item.xPosition + item.width <= 272)).toBe(true)
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    release(ImageRawDataUpdateResult.success)
    await opening
    expect(bridge.updateImageRawData.mock.calls.map(([item]) => item.containerID)).toEqual([9, 10])
  })
  it('rebuilds dashboard rows when the pending notification card appears or disappears', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const actions = [{ key: 'assistant', label: 'Ask assistant', selected: true }, { key: 'sessions', label: 'Sessions', selected: false }]
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '', actions,
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Fri 09/04', connection: 'Connected', batteryPercent: 50, weather: [], unread: 0 } } }
    await display.render(frame)
    await display.render({ ...frame, dashboard: { ...frame.dashboard!, actions: [...actions, { key: 'notifications', label: 'Notifications (2)', selected: false }] } })
    await display.render(frame)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(3)
    for (const [page] of bridge.rebuildPageContainer.mock.calls) expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
  })
  it('keeps compact actions visible and highlights swipes without rebuilding or retransmitting the sidebar', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    const frame: GlassesFrame = { header: 'HOME', body: '', dashboard: { left: '12:30 PM',
      panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Fri 09/04', connection: 'Connected',
        batteryPercent: 50, weather: ['72°F'], unread: 0 },
      actions: ['Ask assistant', 'Projects', 'Sessions'].map((label, index) => ({ key: label, label, selected: index === 0 })),
    } }
    await display.create()
    await display.render(frame)
    const page = bridge.rebuildPageContainer.mock.lastCall![0]
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    const actions = page.textObject.filter((item: { containerName: string }) => item.containerName.startsWith('action-'))
    expect(actions.map((item: { content: string }) => item.content)).toEqual(['> Ask assistant', '  Projects', '  Sessions'])
    expect(actions.every((item: { yPosition: number; height: number }) => item.yPosition + item.height <= 288)).toBe(true)
    expect(actions.map((item: { height: number }) => item.height)).toEqual([52, 52, 52])
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    await display.render({ ...frame, dashboard: { ...frame.dashboard!, actions: frame.dashboard!.actions!.map((row, index) => ({ ...row, selected: index === 1 })) } })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ content: '> Projects', textColor: 4 }))
    expect(bridge.textContainerUpgrade).toHaveBeenCalledWith(expect.objectContaining({ content: '  Ask assistant', textColor: 2 }))
    const alert = buildGlassesPage({ ...frame, header: 'RESPONSE READY', body: 'An updated response\nTap to read' })
    expect(validateEvenHubPageContainer(alert)).toEqual({ valid: true })
    expect(alert.textObject?.filter(item => item.containerName?.startsWith('action-')).every(item => item.yPosition! + item.height! <= 288)).toBe(true)
  })
  it('fits plan entrance frames and preserves question menus through transitions, updates, and diagnostics', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    const frame: GlassesFrame = { header: 'THREAD', body: 'Transcript stays underneath',
      card: { title: 'QUESTION 1/2', body: 'Which option?', presentation: 'plan', entrance: 'bottom', transition: 1 },
      menuItems: [{ itemID: 20, itemName: 'Next question' }, { itemID: 21, itemName: 'Previous question' }, { itemID: 22, itemName: 'Review answers' }] }
    await display.create()
    await display.render(frame)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    await display.render({ ...frame, card: { ...frame.card!, title: 'ANSWER 1/2', entrance: 'right', transition: 2 } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(4)
    for (const [page] of bridge.rebuildPageContainer.mock.calls) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.menuObject.menuItems.map((item: { itemID: number }) => item.itemID)).toEqual([20, 21, 22])
      expect(page.textObject.filter((item: { isEventCapture: number }) => item.isEventCapture === 1)).toHaveLength(1)
      for (const item of [...page.textObject, ...page.imageObject]) {
        expect(item.xPosition + item.width).toBeLessThanOrEqual(576)
        expect(item.yPosition + item.height).toBeLessThanOrEqual(288)
      }
    }
    const current = { ...frame, card: { ...frame.card!, body: 'Next option', entrance: 'right' as const, transition: 2 } }
    await display.render(current)
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(4)
    await display.runDiagnostic(async render => { await render({ header: 'TEST', body: 'Probe' }) })
    expect(bridge.rebuildPageContainer.mock.lastCall![0].menuObject.menuItems).toHaveLength(3)
  })
  it('fits the visual dashboard in SDK bounds and preserves images when only its card changes', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    const frame = { header: 'T3 · 1 / 2', body: 'Ask assistant', askAssistant: true,
      dashboard: { left: '12:30 PM · 72°F · 0 unread', panel: { hour: '12', minute: '30', period: 'PM' as const, hour24: 12, date: 'Fri 09/04',
        connection: 'Connected', batteryPercent: 50, weather: ['72°F', 'Thunderstorm with heavy hail', 'Saved city · stale'], unread: 0 } } }
    const page = buildGlassesPage(frame)
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.imageObject).toHaveLength(2)
    expect(page.imageObject?.map(tile => [tile.xPosition, tile.yPosition, tile.width, tile.height])).toEqual([
      [0, 0, 220, 144], [0, 144, 220, 144],
    ])
    expect(page.textObject?.filter(container => container.isEventCapture === 1)).toHaveLength(1)
    await display.create()
    await display.render(frame)
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()
    await display.render({ ...frame, header: 'T3 · 2 / 2', body: 'Sessions' })
    expect(bridge.rebuildPageContainer).not.toHaveBeenCalled()
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
    expect(bridge.textContainerUpgrade).toHaveBeenCalled()
  })
  it('uses three text containers for dashboard, keeps menu, and updates columns without a rebuild', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame = { header: 'DASHBOARD', body: 'ASK ASSISTANT\nTap to dictate', dashboard: { left: '12:00 PM\n72°F\nClear\n0 unread' }, askAssistant: true }
    await display.render(frame)
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    expect(validateEvenHubPageContainer(page).valid).toBe(true)
    expect(page.textObject).toHaveLength(3)
    expect(page.imageObject).toHaveLength(0)
    expect(page.textObject.filter((item: { isEventCapture: number }) => item.isEventCapture === 1)).toHaveLength(1)
    expect(page.menuObject.menuItems[0].itemID).toBe(1)
    expect(page.textObject[1].xPosition + page.textObject[1].width).toBeLessThan(page.textObject[2].xPosition)
    await display.render({ ...frame, dashboard: { left: '12:01 PM\n72°F\nClear\n1 unread' } })
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(bridge.textContainerUpgrade).toHaveBeenLastCalledWith(expect.objectContaining({ containerID: 3, content: expect.stringContaining('1 unread') }))
    expect(bridge.updateImageRawData).not.toHaveBeenCalled()
  })

  it('preserves menu through transcript rebuilds, clears it for dictation, and restores after diagnostics', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const frame = { header: 'DASHBOARD', body: 'Ask assistant', dashboard: { left: '72°F' }, askAssistant: true }
    await display.render(frame)
    await display.runDiagnostic(async render => { await render({ header: 'TEST', body: 'Probe' }) })
    expect(bridge.rebuildPageContainer.mock.calls.at(-1)![0].menuObject.menuItems[0].itemName).toBe('Ask assistant')
    await display.render({ header: 'LISTENING', body: 'Speak', askAssistant: false })
    expect(bridge.rebuildPageContainer.mock.calls.at(-1)![0].menuObject).toBeUndefined()
    const page = buildGlassesPage({ header: 'LIVE', body: 'Thinking', askAssistant: true, activity: { kind: 'thinking', frame: 0, lineIndex: 0 } })
    expect(page.menuObject?.menuItems?.[0]?.itemID).toBe(1)
  })

  it('holds normal updates during diagnostics and restores before the newest queued frame', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({ header: 'SESSION', body: 'Before test' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const testing = display.runDiagnostic(async (render, current) => {
      await render({ ...current, card: { title: 'TEST', body: 'Card' } })
      await gate
    })
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4))
    const update1 = display.render({ header: 'SESSION', body: 'Intermediate' })
    const update2 = display.render({ header: 'SESSION', body: 'Latest' })
    expect(bridge.textContainerUpgrade.mock.calls.some(([update]) => update.content === 'Latest')).toBe(false)
    await expect(display.runDiagnostic(async () => {})).rejects.toThrow('already running')
    release()
    await Promise.all([testing, update1, update2])
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(bridge.rebuildPageContainer.mock.calls[1]![0].textObject.find((t: { containerID: number }) => t.containerID === 2).content).toBe('Before test')
    expect(bridge.textContainerUpgrade.mock.calls.at(-1)![0].content).toBe('Latest')
    expect(bridge.textContainerUpgrade.mock.calls.some(([update]) => update.content === 'Intermediate')).toBe(false)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(8)
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
  })

  it('restores native state even when a raw diagnostic throws', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await expect(display.runDiagnostic(async () => { throw new Error('probe failed') })).rejects.toThrow('probe failed')
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4)
    await display.render({ header: 'SESSION', body: 'Normal updates still work' })
    expect(bridge.textContainerUpgrade.mock.calls.at(-1)![0].content).toBe('Normal updates still work')
  })

  it('retries a full rebuild after restoration is rejected', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    bridge.rebuildPageContainer.mockResolvedValueOnce(false)
    await expect(display.runDiagnostic(async () => {})).rejects.toThrow('rebuildPageContainer')
    await display.render({ header: 'SESSION', body: 'Recovered' })
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4)
  })

  it('waits for an in-flight native render before starting a diagnostic', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (value: boolean) => void
    bridge.rebuildPageContainer.mockImplementationOnce(() => new Promise<boolean>(resolve => { release = resolve }))
    const rendering = display.render({ header: 'LIVE', body: 'Thinking', activity: { kind: 'thinking', frame: 0, lineIndex: 0 } })
    const run = vi.fn().mockResolvedValue(undefined)
    const testing = display.runDiagnostic(run)
    expect(run).not.toHaveBeenCalled()
    release(true)
    await Promise.all([rendering, testing])
    expect(run).toHaveBeenCalledOnce()
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledOnce()
  })

  it('waits for all native uploads after an upload throws before restoring the test display', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    let release!: (value: ImageRawDataUpdateResult) => void
    bridge.updateImageRawData.mockRejectedValueOnce(new Error('native upload failed'))
      .mockImplementationOnce(() => new Promise<ImageRawDataUpdateResult>(resolve => { release = resolve }))
    const testing = display.runDiagnostic(async (render, current) => {
      await render({ ...current, card: { title: 'TEST', body: 'Card' } })
    })
    const rejected = expect(testing).rejects.toThrow('background update failed')
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2))
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    release(ImageRawDataUpdateResult.success)
    await rejected
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(8)
  })

  it('creates a minimal startup page and keeps body input capture', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)

    await display.create()

    const page = bridge.createStartUpPageContainer.mock.calls[0]![0]
    expect(page.containerTotalNum).toBe(2)
    expect(page.textObject).toHaveLength(2)
    expect(page.imageObject).toBeUndefined()
    expect(page.textObject.find((item: { containerName?: string }) => item.containerName === 'body')?.isEventCapture).toBe(1)
    expect(page.textObject.find((item: { containerName?: string }) => item.containerName === 'activity-label')).toBeUndefined()
  })

  it('updates only spinner images between frames so the label position cannot move', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({
      header: 'LIVE',
      body: 'T3\nWorking\n\n',
      activity: { kind: 'thinking', frame: 0, lineIndex: 0 },
    })
    bridge.textContainerUpgrade.mockClear()
    bridge.updateImageRawData.mockClear()

    await display.render({
      header: 'LIVE',
      body: 'T3\nWorking\n\n',
      activity: { kind: 'thinking', frame: 1, lineIndex: 0 },
    })

    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
    for (const [update] of bridge.updateImageRawData.mock.calls) {
      expect(update.imageData).toHaveLength(400)
      expect(update.imageData.some((pixel: number) => pixel === 255)).toBe(true)
    }
    expect(bridge.updateImageRawData.mock.calls[0]![0].imageData)
      .toEqual(bridge.updateImageRawData.mock.calls[1]![0].imageData)
  })

  it('rebuilds once when the inline activity moves to another transcript line', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()

    await display.render({
      header: 'LIVE',
      body: 'T3\nWorking\n\n',
      activity: {
        kind: 'tool',
        label: "ran /bin/zsh -lc 'audit_dir=/tmp/even-glasses-audit curl -sS -X POST'",
        frame: 3,
        lineIndex: 99,
      },
    })

    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    const label = page.textObject.find((item: { containerName?: string }) => item.containerName === 'activity-label')
    expect(label.content).toMatch(/^ran \/bin\/zsh/)
    expect(label.content).toMatch(/\.\.\.$/)
    expect(label.xPosition).toBe(27)
    expect(label.yPosition).toBe(248)
    expect(label.width).toBeGreaterThan(100)
    const leftSpinner = page.imageObject.find((item: { containerName?: string }) => item.containerName === 'tile-0')
    const rightSpinner = page.imageObject.find((item: { containerName?: string }) => item.containerName === 'tile-1')
    expect(leftSpinner.xPosition).toBe(0)
    expect(rightSpinner.xPosition).toBe(label.xPosition + label.width + 3)
    expect(rightSpinner.xPosition + rightSpinner.width).toBeLessThanOrEqual(450)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
  })

  it('force-clears the label and spinner images when live activity stops', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({
      header: 'LIVE',
      body: 'Working\n',
      activity: { kind: 'thinking', frame: 2, lineIndex: 1 },
    })
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()

    await display.render({ header: 'T3 | TURN 1/1', body: 'Finished.' })

    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    expect(page.textObject.find((item: { containerName?: string }) => item.containerName === 'activity-label')?.content).toBe(' ')
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(2)
    for (const [update] of bridge.updateImageRawData.mock.calls) {
      expect(update.imageData.every((pixel: number) => pixel === 0)).toBe(true)
    }
  })

  it('keeps the transcript above every tile until all uploads finish, then reveals the card without a rebuild', async () => {
    const bridge = mockBridge()
    let release!: (result: ImageRawDataUpdateResult) => void
    bridge.updateImageRawData.mockResolvedValueOnce(ImageRawDataUpdateResult.success)
      .mockResolvedValueOnce(ImageRawDataUpdateResult.success)
      .mockResolvedValueOnce(ImageRawDataUpdateResult.success)
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const opening = display.render({ header: 'LIVE', body: 'Visible transcript', card: { title: 'LISTENING', body: 'Draft' } })
    await vi.waitFor(() => expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4))
    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    const veil = page.textObject.find((text: { containerName: string }) => text.containerName === 'card-veil')
    expect(veil.content).toBe('Visible transcript')
    for (const image of page.imageObject) expect(veil.zOrderIndex).toBeGreaterThan(image.zOrderIndex)
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    release(ImageRawDataUpdateResult.success)
    await opening
    expect(bridge.rebuildPageContainer).toHaveBeenCalledOnce()
    expect(bridge.textContainerUpgrade.mock.calls.map(([update]) => [update.containerName, update.content])).toEqual([
      ['card-veil', ' '], ['voice-card', 'LISTENING\n\nDraft'],
    ])
  })

  it('does not reveal an incomplete backdrop after an image failure', async () => {
    const bridge = mockBridge()
    bridge.updateImageRawData.mockResolvedValueOnce('failure')
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await expect(display.render({ header: 'LIVE', body: 'Visible transcript', card: { title: 'LISTENING', body: 'Draft' } })).rejects.toThrow('background update failed')
    expect(bridge.textContainerUpgrade).not.toHaveBeenCalled()
    await display.render({ header: 'LIVE', body: 'Restored' })
    expect(bridge.rebuildPageContainer.mock.calls.at(-1)![0].textObject.find((text: { containerName: string }) => text.containerName === 'body').content).toBe('Restored')
  })

  it('renders the voice UI as a foreground 80-percent-height input card', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()

    await display.render({
      header: 'LIVE',
      body: 'Transcript remains underneath.',
      card: { title: 'LISTENING | 3S', body: 'Steer toward the simulator.' },
    })

    const page = bridge.rebuildPageContainer.mock.calls[0]![0]
    expect(page.containerTotalNum).toBe(8)
    const body = page.textObject.find((item: { containerName?: string }) => item.containerName === 'body')
    const card = page.textObject.find((item: { containerName?: string }) => item.containerName === 'voice-card')
    expect(body.isEventCapture).toBe(0)
    expect(body.content).toBe('Transcript remains underneath.')
    expect(card.isEventCapture).toBe(1)
    expect(card.height).toBe(230)
    expect(card.content).toBe(' ')
    expect(bridge.textContainerUpgrade.mock.calls.at(-1)![0].content).toContain('Steer toward the simulator.')
    for (const backdrop of page.imageObject) {
      expect(backdrop.xPosition).toBeGreaterThanOrEqual(card.xPosition)
      expect(backdrop.yPosition).toBeGreaterThanOrEqual(card.yPosition)
      expect(backdrop.xPosition + backdrop.width).toBeLessThanOrEqual(card.xPosition + card.width)
      expect(backdrop.yPosition + backdrop.height).toBeLessThanOrEqual(card.yPosition + card.height)
    }
    const covered = new Set<string>()
    for (const tile of page.imageObject) {
      expect(tile.zOrderIndex).toBeGreaterThan(body.zOrderIndex)
      expect(tile.zOrderIndex).toBeLessThan(card.zOrderIndex)
      for (let y = tile.yPosition; y < tile.yPosition + tile.height; y += 1) {
        for (let x = tile.xPosition; x < tile.xPosition + tile.width; x += 1) covered.add(`${x},${y}`)
      }
    }
    expect(covered.size).toBe(card.width * card.height)
    for (const [update] of bridge.updateImageRawData.mock.calls) {
      expect(update.imageData.every((pixel: number) => pixel === 0)).toBe(true)
    }
    const zOrders = [...page.textObject, ...page.imageObject].map((item: { zOrderIndex?: number }) => item.zOrderIndex)
    expect(new Set(zOrders).size).toBe(8)
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4)
  })

  it('reuses and clears every image slot when a voice card is cancelled', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()

    await display.render({
      header: 'LIVE',
      body: 'Transcript remains underneath.',
      card: { title: 'LISTENING | 3S', body: 'Cancel this draft.' },
    })
    const cardPage = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    bridge.rebuildPageContainer.mockClear()
    bridge.updateImageRawData.mockClear()

    await display.render({ header: 'LIVE', body: 'Transcript remains underneath.' })

    const restoredPage = bridge.rebuildPageContainer.mock.calls[0]![0]
    const imageIDs = (page: { imageObject: Array<{ containerID?: number }> }) => (
      page.imageObject.map((image) => image.containerID).sort((left, right) => left! - right!)
    )
    expect(imageIDs(restoredPage)).toEqual(imageIDs(cardPage))
    expect(restoredPage.imageObject).toHaveLength(4)
    for (const image of restoredPage.imageObject) {
      expect(image).toMatchObject({ xPosition: 556, yPosition: 268, width: 20, height: 20 })
      const body = restoredPage.textObject.find((item: { containerName?: string }) => item.containerName === 'body')
      expect(image.zOrderIndex).toBeLessThan(body.zOrderIndex)
    }
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(4)
    expect(bridge.updateImageRawData.mock.calls.map((call) => call[0].imageData.length))
      .toEqual([400, 400, 400, 400])
    for (const [update] of bridge.updateImageRawData.mock.calls) {
      expect(update.imageData.every((pixel: number) => pixel === 0)).toBe(true)
    }
  })

  it('updates the transcript behind the card and restores the latest body on close', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const card = { title: 'LISTENING', body: 'Draft' }
    await display.render({ header: 'LIVE', body: 'Old transcript', card })
    bridge.textContainerUpgrade.mockClear()
    await display.render({ header: 'LIVE', body: 'Latest transcript', card: { ...card, body: 'Updated draft' } })
    expect(bridge.textContainerUpgrade.mock.calls.map(([update]) => update.content)).toEqual(['Latest transcript', 'LISTENING\n\nUpdated draft'])
    await display.render({ header: 'LIVE', body: 'Latest transcript' })
    const restored = bridge.rebuildPageContainer.mock.calls.at(-1)![0]
    expect(restored.textObject.find((text: { containerID: number }) => text.containerID === 2).content).toBe('Latest transcript')
  })

  it('uses the hardware-accepted image identities for activity, card, and restoration uploads', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({ header: 'LIVE', body: 'Working', activity: { kind: 'thinking', frame: 0, lineIndex: 0 } })
    await display.render({ header: 'LIVE', body: 'Working', card: { title: 'LISTENING', body: 'Draft' } })
    await display.render({ header: 'LIVE', body: 'Restored' })
    const identities = [9, 10, 11, 12].map((containerID, index) => ({ containerID, containerName: `tile-${index}` }))
    for (const [page] of bridge.rebuildPageContainer.mock.calls) {
      expect(page.imageObject.map(({ containerID, containerName }: { containerID: number; containerName: string }) => ({ containerID, containerName }))).toEqual(identities)
    }
    for (const [update] of bridge.updateImageRawData.mock.calls) {
      expect(identities).toContainEqual({ containerID: update.containerID, containerName: update.containerName })
    }
  })

  it('reports native card rejection without replacing the layered UI', async () => {
    const bridge = mockBridge()
    bridge.rebuildPageContainer.mockResolvedValue(false)
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await expect(display.render({ header: 'SESSION', body: '', card: { title: 'LISTENING', body: '' } }))
      .rejects.toThrow('opening dictation card')
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
  })

  it('keeps every native rebuild within SDK page and image constraints', async () => {
    const bridge = mockBridge()
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({ header: 'LIVE', body: 'Working', activity: { kind: 'thinking', frame: 1, lineIndex: 0 } })
    await display.render({ header: 'LIVE', body: 'x'.repeat(1500), card: { title: 'LISTENING', body: 'y'.repeat(1500) } })
    await display.render({ header: 'DONE', body: 'Restored transcript' })
    for (const [page] of bridge.rebuildPageContainer.mock.calls) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.containerTotalNum).toBe(page.textObject.length + page.imageObject.length)
      expect(page.textObject.filter((item: { isEventCapture?: number }) => item.isEventCapture === 1)).toHaveLength(1)
      for (const text of page.textObject) expect(text.content.length).toBeLessThanOrEqual(1000)
      for (const image of page.imageObject) {
        expect(image.width).toBeGreaterThanOrEqual(20)
        expect(image.width).toBeLessThanOrEqual(288)
        expect(image.height).toBeGreaterThanOrEqual(20)
        expect(image.height).toBeLessThanOrEqual(144)
        expect(image.xPosition + image.width).toBeLessThanOrEqual(576)
        expect(image.yPosition + image.height).toBeLessThanOrEqual(288)
      }
    }
  })

  it('drops stale waiting frames so a cancel transition is not trapped behind live updates', async () => {
    const bridge = mockBridge()
    let releaseFirstUpgrade: ((value: boolean) => void) | undefined
    bridge.textContainerUpgrade.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      releaseFirstUpgrade = resolve
    }))
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()

    const first = display.render({ header: 'FIRST', body: 'Connecting...' })
    await vi.waitFor(() => expect(releaseFirstUpgrade).toBeTypeOf('function'))
    const stale = display.render({ header: 'STALE', body: 'old live frame' })
    const latest = display.render({ header: 'LATEST', body: 'restored transcript' })
    releaseFirstUpgrade?.(true)
    await Promise.all([first, stale, latest])

    const writtenText = bridge.textContainerUpgrade.mock.calls.map((call) => call[0].content)
    expect(writtenText).toContain('FIRST')
    expect(writtenText).toContain('LATEST')
    expect(writtenText).toContain('restored transcript')
    expect(writtenText).not.toContain('STALE')
    expect(writtenText).not.toContain('old live frame')
  })
})
