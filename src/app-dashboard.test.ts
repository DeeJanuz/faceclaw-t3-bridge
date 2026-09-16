import { afterEach, describe, expect, it, vi } from 'vitest'
import { type EvenAppBridge, type EvenHubEvent, OsEventTypeList, ImageRawDataUpdateResult } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import type { CompanionUi } from './companion-ui'
import { defaultDashboardSettings } from './dashboard-settings'
import type { SessionSummary, SessionsListResult, TranscriptResult } from './protocol'
import { BridgeRequestError } from './protocol'
import type { DashboardModule } from './dashboard-modules'

// Native image content is verified in the browser fixture; these tests exercise navigation and RPCs.
vi.mock('./dashboard-panel', () => ({ renderDashboardPanel: vi.fn().mockResolvedValue({}),
  panelTiles: vi.fn(() => [new Array(220 * 144).fill(0), new Array(220 * 144).fill(0)]) }))

const date = (n: number) => `2026-09-04T12:${String(n).padStart(2, '0')}:00.000Z`
const project = { id: 'p', title: 'Assistant', canStartSession: true, updatedAt: date(0) }
const model = { instanceId: 'provider', model: 'model', name: 'Model', providerName: 'Provider', isDefault: true, reasoningChoices: [] }
const session: SessionSummary = { id: 'old-thread', projectId: 'p', projectTitle: 'Assistant', title: 'Original session', settled: false, status: 'idle', lastActivityAt: date(0), completedTurn: null }
const snapshot = (minute: number, completed = false): SessionsListResult => ({ snapshotId: String(minute), frozenAt: date(minute),
  unsettled: [{ ...session, completedTurn: completed ? { id: `turn-${minute}`, completedAt: date(minute) } : null }], settled: [] })
const transcript = (id: string): TranscriptResult => ({ snapshotId: '1', session: { ...session, id }, turns: [], liveActivity: null, liveActivities: [] })

function setup(modules: readonly DashboardModule[] = []) {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout, clearTimeout })
  const native = {
    createStartUpPageContainer: vi.fn().mockResolvedValue(0), rebuildPageContainer: vi.fn().mockResolvedValue(true),
    textContainerUpgrade: vi.fn().mockResolvedValue(true), updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success),
    audioControl: vi.fn().mockResolvedValue(true), setLocalStorage: vi.fn().mockResolvedValue(true),
    getLocalStorage: vi.fn().mockResolvedValue(null), getAppLocation: vi.fn().mockResolvedValue(null),
    shutDownPageContainer: vi.fn().mockResolvedValue(true),
  }
  const companion = { setMirror: vi.fn(), setConnectionStatus: vi.fn(), setProfile: vi.fn(), recordInput: vi.fn(),
    setDiagnosticsReady: vi.fn(), setOsMirror: vi.fn(), setDashboardMirror: vi.fn(), setSettingsStatus: vi.fn(), setSettings: vi.fn() }
  const request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    switch (method) {
      case 'projects.list': return { projects: [project] }
      case 'models.list': return { models: [model] }
      case 'sessions.list': return snapshot(0)
      case 'voice.start': return { maxBytes: 9600000 }
      case 'voice.finish': return { text: 'What should I focus on today?' }
      case 'voice.cancel': return { cancelled: true }
      case 'thread.settle': return { threadId: params?.threadId, settled: true, sequence: 2 }
      case 'thread.start':
      case 'assistant.start': return { threadId: 'assistant-thread', text: params?.text, sequence: 1 }
      case 'turn.send':
      case 'turn.reply': return { threadId: 'assistant-thread', text: params?.text, sequence: 2 }
      case 'transcript.get': return transcript(String(params?.threadId))
      default: throw new Error(`Unexpected method ${method}`)
    }
  })
  const app = new EvenT3App(native as unknown as EvenAppBridge, companion as CompanionUi, modules)
  // Existing app tests use this seam to exercise native events without a real T3 process.
  const state = app as unknown as Record<string, any>
  state.client = { connected: true, request, close: vi.fn() }
  state.endpoint = 'ws://127.0.0.1:8787/v1/events'
  state.settings = { ...defaultDashboardSettings(), assistant: { projectId: 'p', modelSelection: { instanceId: 'provider', model: 'model' } },
    weather: { enabled: false, unit: 'fahrenheit', fallbackCity: null } }
  const event = async (input: EvenHubEvent) => { state.onEvenEvent(input); await state.eventQueue }
  return { app, state, native, companion, request, event }
}
afterEach(() => vi.unstubAllGlobals())

describe('dashboard and assistant app flow', () => {
  it('retains the resident reader background when a phone message changes during dictation', async () => {
    const { state, native } = setup()
    const item = { key: 'chat', revision: '1', packageName: 'org.signal', appName: 'Signal', title: 'Friends', arrivedAt: Date.now(), replyable: true, text: 'Message' }
    state.phone = { connected: true, permissionGranted: true, apps: [], notifications: [item] }
    await state.openDashboard()
    state.dashboardSelection = 'notifications'
    await state.handleTap()
    await state.handleTap()
    await state.handleTap()
    expect(state.screen).toBe('dictating')
    expect(state.lastGlassesFrame.dashboardSurface.view).toBe('voice')
    native.rebuildPageContainer.mockClear()
    native.updateImageRawData.mockClear()
    await state.acceptPhone({ ...state.phone, notifications: [{ ...item, revision: '2', text: 'Updated message' }] }, false)
    expect(state.screen).toBe('dictating')
    expect(state.lastGlassesFrame.dashboardSurface.view).toBe('voice')
    expect(native.rebuildPageContainer).not.toHaveBeenCalled()
    expect(native.updateImageRawData).not.toHaveBeenCalled()
  })
  it.each([[0, '12:05 AM'], [12, '12:05 PM'], [15, '3:05 PM']])('shows hour %s in 12-hour notification metadata inside the card', async (hour, label) => {
    const { state } = setup()
    state.phone = { connected: true, permissionGranted: true, apps: [], notifications: [
      { key: 'chat', revision: '1', packageName: 'org.signal', appName: 'Signal', title: 'Friends', arrivedAt: new Date(2026, 8, 5, Number(hour), 5).getTime(), replyable: true, text: 'Hello' },
    ] }
    await state.openNotifications()
    expect(state.lastGlassesFrame.dashboardSurface.trailing).toBe(`${label}  1/1`)
    expect(state.lastGlassesFrame.dashboardSurface.footer).toBe('')
    expect(state.lastGlassesFrame.dashboardSurface.actions).toBeDefined()
  })
  it('reads and pages phone notifications, reverses through the inbox, and updates reader pages without images', async () => {
    const { state, native } = setup()
    state.phone = { connected: true, permissionGranted: true, apps: [], notifications: [
      { key: 'chat', revision: '1', packageName: 'org.signal', appName: 'Signal', title: 'Friends', arrivedAt: Date.now(), replyable: true,
        text: 'A synthetic long message for checking narrow reader pagination. '.repeat(30) },
    ] }
    await state.openDashboard()
    native.rebuildPageContainer.mockClear()
    native.updateImageRawData.mockClear()
    state.dashboardSelection = 'notifications'
    await state.renderDashboard()
    await state.handleTap()
    expect(state.screen).toBe('notifications')
    await state.handleTap()
    expect(state.screen).toBe('phone-reader')
    expect(state.lastGlassesFrame.dashboardSurface.text).not.toContain('Ask assistant')
    const first = state.lastGlassesFrame.dashboardSurface.text
    await state.handleScroll(1)
    expect(state.phonePage).toBe(1)
    expect(state.lastGlassesFrame.dashboardSurface.text).not.toBe(first)
    state.arrivalBanner = 'Signal · Friends\nA synthetic arrival'
    await state.show(state.lastGlassesFrame)
    state.arrivalBanner = undefined
    await state.show(state.lastGlassesFrame)
    await state.handleDoubleTap()
    expect(state.screen).toBe('notifications')
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(native.rebuildPageContainer.mock.calls.every(([page]) => page.imageObject.length <= 1)).toBe(true)
    expect(native.updateImageRawData).toHaveBeenCalledTimes(3)
    expect(native.rebuildPageContainer.mock.calls.some(([page]) => page.textObject.some((item: any) => item.containerName === 'header' && item.content === 'Signal · Friends'))).toBe(true)
  })
  it('adds three local notifications without RPCs, persistence, or focus movement and reads them through the inbox', async () => {
    const { app, state, request, native } = setup()
    state.acceptSessions(snapshot(0))
    await state.openDashboard()
    request.mockClear()
    native.setLocalStorage.mockClear()
    const real = JSON.stringify(state.notifications)
    await app.createTestNotifications()
    expect(state.dashboardSelection).toBe('assistant')
    expect(state.cards.find((card: any) => card.key === 'notifications').title).toBe('Notifications 3')
    expect(request).not.toHaveBeenCalled()
    expect(native.setLocalStorage).not.toHaveBeenCalled()
    expect(JSON.stringify(state.notifications)).toBe(real)
    state.acceptSessions(snapshot(1))
    expect(state.testNotifications).toHaveLength(3)
    state.dashboardSelection = 'notifications'
    await state.handleTap()
    await state.handleScroll(-1)
    expect(state.notificationSelection).toContain(':2')
    await state.handleTap()
    expect(state.screen).toBe('dashboard-reader')
    expect(state.dashboardReader.pages.length).toBeGreaterThan(1)
    expect(state.testNotifications).toHaveLength(2)
    await state.handleScroll(1)
    expect(state.dashboardReader.page).toBe(1)
    await state.handleDoubleTap()
    expect(state.screen).toBe('notifications')
    expect(state.cards.find((card: any) => card.key === 'notifications').title).toBe('Notifications 2')
    expect(request).not.toHaveBeenCalled()
  })
  it('focuses the top bell by swiping up from Ask assistant and reverses reader and inbox motion', async () => {
    const { app, state, companion } = setup()
    await state.openDashboard()
    await app.createTestNotifications()
    const rows = companion.setDashboardMirror.mock.lastCall![2]
    expect(rows.map((row: any) => row.key)).toEqual(['notifications', 'assistant', 'sessions'])
    expect(rows[0].previews).toBeUndefined()
    expect(state.dashboardSelection).toBe('assistant')
    await state.handleScroll(-1)
    await state.handleTap()
    expect(state.lastGlassesFrame.dashboard).toBeDefined()
    expect(state.lastGlassesFrame.card.presentation).toBe('notifications')
    expect(state.lastGlassesFrame.card.entrance).toBe('down')
    await state.handleTap()
    expect(state.lastGlassesFrame.motion.direction).toBe('rise')
    await state.handleDoubleTap()
    expect(state.screen).toBe('notifications')
    expect(state.lastGlassesFrame.motion.direction).toBe('lower')
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(companion.setOsMirror).toHaveBeenCalledWith(expect.objectContaining({ motion: expect.objectContaining({ direction: 'retract' }) }))
    expect(state.dashboardSelection).toBe('notifications')
  })
  it('returns home after reading the last test notification', async () => {
    const { app, state } = setup()
    await state.openDashboard()
    await app.createTestNotifications()
    await state.openNotifications()
    for (let remaining = 2; remaining >= 0; remaining--) {
      await state.handleTap()
      expect(state.screen).toBe('dashboard-reader')
      expect(state.testNotifications).toHaveLength(remaining)
      await state.handleDoubleTap()
      expect(state.screen).toBe(remaining === 0 ? 'dashboard' : 'notifications')
    }
    expect(state.dashboardSelection).toBe('notifications')
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(0)
  })
  it('returns home when the phone inbox is empty on leaving its reader', async () => {
    const { state } = setup()
    state.phone = { connected: true, permissionGranted: true, apps: [], notifications: [
      { key: 'chat', revision: '1', packageName: 'org.signal', appName: 'Signal', title: 'Friends', arrivedAt: Date.now(), replyable: true, text: 'Message' },
    ] }
    await state.openDashboard()
    await state.openNotifications()
    await state.handleTap()
    expect(state.screen).toBe('phone-reader')
    state.phone = { ...state.phone, notifications: [] }
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.phoneKey).toBeNull()
    expect(state.notificationItems).toHaveLength(0)
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(0)
  })
  it('keeps the selected expanded notification when cancelling an assistant shortcut', async () => {
    const { app, state } = setup()
    await state.openDashboard()
    await app.createTestNotifications()
    await state.openNotifications()
    await state.handleScroll(1)
    const selection = state.notificationSelection
    await state.openAssistant()
    await state.handleDoubleTap()
    expect(state.screen).toBe('notifications')
    expect(state.notificationSelection).toBe(selection)
  })
  it('clears every alert for a session opened through Sessions and keeps completion markers', async () => {
    const { state } = setup()
    await state.openSessions()
    await state.handleScroll(1)
    state.acceptSessions(snapshot(1, true))
    state.acceptSessions(snapshot(2, true))
    expect(state.notifications.unread).toHaveLength(2)
    await state.handleTap()
    expect(state.notifications.unread).toHaveLength(0)
    await state.handleDoubleTap()
    state.acceptSessions(snapshot(2, true))
    expect(state.notifications.unread).toHaveLength(0)
  })
  it('shows an empty inbox when the last expanded notification is settled', async () => {
    const { state } = setup()
    await state.openSessions()
    state.acceptSessions(snapshot(1, true))
    await state.openNotifications()
    state.acceptSessions({ ...snapshot(2), unsettled: [], settled: [{ ...session, settled: true, completedTurn: { id: 'turn-1', completedAt: date(1) } }] })
    expect(state.screen).toBe('notifications')
    expect(state.notifications.unread).toHaveLength(0)
    expect(state.notificationItems).toHaveLength(0)
    expect(state.cards.map((card: any) => card.key)).toEqual(['notifications', 'assistant', 'sessions'])
  })
  it('adds test batches during reading without changing the current reader and bounds their memory', async () => {
    const { app, state } = setup()
    await state.openSessions()
    const rows = state.sessionRows
    for (let i = 0; i < 18; i++) await app.createTestNotifications()
    expect(state.screen).toBe('sessions')
    expect(state.sessionRows).toBe(rows)
    expect(state.testNotifications).toHaveLength(50)
    expect(new Set(state.testNotifications.map((card: any) => card.key)).size).toBe(50)
  })
  it('keeps the empty notification selector focused on the dashboard', async () => {
    const { state } = setup()
    state.acceptSessions(snapshot(0))
    state.acceptSessions(snapshot(1, true))
    await state.openDashboard()
    await state.handleScroll(-1)
    expect(state.dashboardSelection).toBe('notifications')
    state.acceptSessions({ ...snapshot(2), unsettled: [], settled: [{ ...session, settled: true }] })
    expect(state.screen).toBe('dashboard')
    expect(state.dashboardSelection).toBe('notifications')
    expect(state.cards.map((card: any) => card.key)).toEqual(['notifications', 'assistant', 'sessions'])
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(0)
  })
  it('refreshes arrivals and changed titles in the expanded inbox without replacing its selected key', async () => {
    const { app, state } = setup()
    await state.openDashboard()
    await app.createTestNotifications()
    await state.openNotifications()
    await state.handleScroll(1)
    const selected = state.notificationSelection
    await app.createTestNotifications()
    expect(state.screen).toBe('notifications')
    expect(state.notificationItems).toHaveLength(6)
    expect(state.notificationSelection).toBe(selected)
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(6)
    const item = state.testNotifications.find((card: any) => card.key === selected)
    item.notification.label = 'TX - Updated message'
    await state.refreshDashboards()
    expect(state.lastGlassesFrame.card.body).toContain('TX - Updated message')
  })
  it('settles the highlighted idle session from the hold menu and keeps that row selected', async () => {
    const { state, native, event, request } = setup()
    await state.openSessions()
    await state.handleScroll(1)
    const selection = state.sessionSelection
    state.acceptSessions(snapshot(1, true))
    expect(native.rebuildPageContainer.mock.calls.at(-1)![0].menuObject.menuItems).toContainEqual(expect.objectContaining({ itemID: 3, itemName: 'Settle session' }))
    await event({ menuItemClickEvent: { itemID: 3 } } as EvenHubEvent)
    expect(request).toHaveBeenCalledWith('thread.settle', { threadId: session.id })
    expect(state.notifications.unread).toHaveLength(0)
    expect(state.sessions.unsettled).toHaveLength(0)
    expect(state.sessions.settled[0].id).toBe(session.id)
    expect(state.sessionSelection).toBe(selection)
    await event({ menuItemClickEvent: { itemID: 3 } } as EvenHubEvent)
    expect(request.mock.calls.filter(([method]) => method === 'thread.settle')).toHaveLength(1)
  })
  it('rejects a stale hold action after the selected session starts working, and leaves failed settlements unchanged', async () => {
    const { state, event, request } = setup()
    await state.openSessions()
    await state.handleScroll(1)
    state.acceptSessions({ ...snapshot(1), unsettled: [{ ...session, status: 'running' }] })
    await event({ menuItemClickEvent: { itemID: 3 } } as EvenHubEvent)
    expect(request.mock.calls.some(([method]) => method === 'thread.settle')).toBe(false)
    state.acceptSessions(snapshot(2))
    request.mockRejectedValueOnce(new Error('Session is working'))
    await expect(state.settleSession(session.id)).rejects.toThrow('Session is working')
    expect(state.sessions.unsettled).toHaveLength(1)
    expect(state.settlementPending).toBe(false)
  })
  it('offers settlement in an idle transcript and ignores it during dictation', async () => {
    const { state, native, event, request } = setup()
    await state.openSessions()
    await state.handleScroll(1)
    await state.handleTap()
    expect(native.rebuildPageContainer.mock.calls.at(-1)![0].menuObject.menuItems).toContainEqual(expect.objectContaining({ itemID: 3 }))
    await state.handleTap()
    await event({ menuItemClickEvent: { itemID: 3 } } as EvenHubEvent)
    expect(request.mock.calls.some(([method]) => method === 'thread.settle')).toBe(false)
    await state.handleDoubleTap()
    await event({ menuItemClickEvent: { itemID: 3 } } as EvenHubEvent)
    expect(state.transcript.session.settled).toBe(true)
    expect(state.screen).toBe('transcript')
  })
  it('expands assistant to a text-only full screen and collapses back after cancellation', async () => {
    const { state, native, request, companion } = setup()
    await state.openDashboard()
    const original = request.getMockImplementation()!
    let resolve!: (value: unknown) => void
    request.mockImplementation((method, params) => method === 'projects.list'
      ? new Promise(yes => { resolve = yes }) : original(method, params))
    native.rebuildPageContainer.mockClear()
    native.updateImageRawData.mockClear()
    const opening = state.openAssistant()
    await vi.waitFor(() => expect(native.rebuildPageContainer.mock.calls.some(([page]) => page.textObject.some((item: any) => item.content === 'PREPARING ASSISTANT'))).toBe(true))
    expect(native.audioControl).not.toHaveBeenCalled()
    resolve({ projects: [project] })
    await opening
    const openingCalls = native.rebuildPageContainer.mock.calls.length
    expect(openingCalls).toBeGreaterThan(1)
    expect(openingCalls).toBeLessThanOrEqual(12)
    expect(native.updateImageRawData).not.toHaveBeenCalled()
    expect(state.lastGlassesFrame.dashboardSurface.view).toBe('voice')
    await state.handleTap()
    expect(state.screen).toBe('draft')
    expect(native.rebuildPageContainer).toHaveBeenCalledTimes(openingCalls)
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.dashboardSelection).toBe('assistant')
    expect(companion.setOsMirror).toHaveBeenCalledWith(expect.objectContaining({ motion: expect.objectContaining({ direction: 'collapse' }) }))
    expect(native.rebuildPageContainer.mock.lastCall![0].imageObject).toContainEqual(expect.objectContaining({ containerName: 'home-clock' }))
    expect(native.updateImageRawData).toHaveBeenCalledOnce()
  })
  it('keeps swiping and project/session browsing usable without assistant settings', async () => {
    const { state, request, native, event } = setup()
    state.settings.assistant = null
    await state.openDashboard()
    await state.handleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.assistantSetupMessage).toContain('Choose your assistant')
    expect(native.audioControl).not.toHaveBeenCalled()
    await state.handleScroll(1)
    await state.handleTap()
    expect(state.screen).toBe('sessions')
    expect(state.sessionRows.some((row: any) => row.key.startsWith('project:'))).toBe(false)
    await state.handleScroll(1)
    const selectedSession = state.sessionSelection
    await event({ menuItemClickEvent: { itemID: 2 } } as EvenHubEvent)
    expect(state.screen).toBe('sessions')
    expect(native.rebuildPageContainer.mock.calls.at(-1)![0].menuObject.menuItems.some((item: any) => item.itemID === 2)).toBe(false)
    await state.handleTap()
    expect(state.screen).toBe('transcript')
    await state.handleDoubleTap()
    expect(state.sessionSelection).toBe(selectedSession)
    expect(request.mock.calls.some(([method]) => method === 'voice.start')).toBe(false)
  })
  it('shows all compact dashboard actions and moves only their selection highlight', async () => {
    const { state, companion } = setup()
    await state.openDashboard()
    expect(companion.setDashboardMirror.mock.lastCall?.[2]).toEqual([
      { key: 'notifications', label: 'Notifications 0', selected: false, previews: undefined },
      { key: 'assistant', label: 'Ask assistant', selected: true },
      { key: 'sessions', label: 'Sessions', selected: false },
    ])
    expect(companion.setMirror.mock.lastCall).toEqual(['HOME', ''])
    expect(state.lastGlassesFrame.dashboardSurface.footer).toBe('')
    await state.handleScroll(1)
    expect(companion.setDashboardMirror.mock.lastCall?.[2].filter((row: any) => row.selected).map((row: any) => row.key)).toEqual(['sessions'])
    await state.handleScroll(1)
    expect(companion.setDashboardMirror.mock.lastCall?.[2].filter((row: any) => row.selected).map((row: any) => row.key)).toEqual(['notifications'])
  })
  it('can browse sessions with project prefixes when the project catalog is unavailable', async () => {
    const { state, request } = setup()
    const original = request.getMockImplementation()!
    request.mockImplementation(async (method, params) => {
      if (method === 'projects.list') throw new Error('Catalog unavailable')
      return original(method, params)
    })
    await state.openSessions()
    expect(state.screen).toBe('sessions')
    expect(state.sessionRows.find((row: any) => row.key.startsWith('session:')).text).toMatch(/^A1 - Original session/)
  })
  it('opens project selection from the first Sessions row and returns to Sessions on cancel', async () => {
    const { state, native } = setup()
    await state.openSessions()
    expect(state.sessionSelection).toBe('new')
    expect(state.sessionRows[0].text).toBe('START NEW SESSION')
    expect(native.rebuildPageContainer.mock.lastCall![0].menuObject?.menuItems.some((item: any) => item.itemID === 3)).toBeFalsy()
    await state.handleTap()
    expect(state.screen).toBe('projects')
    await state.handleDoubleTap()
    expect(state.screen).toBe('sessions')
    expect(state.sessionSelection).toBe('new')
  })
  it('preserves recent-project order from the bridge and selects the first project', async () => {
    const { state, request } = setup()
    request.mockResolvedValue({ projects: [{ ...project, id: 'recent', title: 'Zebra' }, project] })
    await state.openProjects()
    expect(state.projectRows.map((row: any) => row.key)).toEqual(['project:recent', 'project:p'])
    expect(state.projectSelection).toBe('project:recent')
  })
  it('returns a new project conversation and assistant cancellation to the selected project', async () => {
    const { state } = setup()
    await state.openProjects()
    const selected = state.projectSelection
    await state.handleTap()
    await state.handleTap()
    expect(state.screen).toBe('new-session')
    await state.handleTap()
    await state.handleTap()
    await state.handleTap()
    expect(state.screen).toBe('transcript')
    await state.handleDoubleTap()
    expect(state.screen).toBe('projects')
    expect(state.projectSelection).toBe(selected)
    await state.openAssistant()
    await state.cancelVoiceFlow()
    expect(state.screen).toBe('projects')
    expect(state.projectSelection).toBe(selected)
  })
  it('opens extension pages, freezes them through updates, and restores them after assistant cancellation', async () => {
    let text = 'Original article. '.repeat(150)
    const { app, state } = setup([{ id: 'news', cards: () => [{ key: 'story', title: 'News', body: 'Tap to read',
      action: { kind: 'reader', title: 'A story', text } }] }])
    await state.openDashboard()
    await state.handleScroll(-1)
    await state.handleScroll(-1)
    const selected = state.dashboardSelection
    await state.handleTap()
    expect(state.screen).toBe('dashboard-reader')
    await state.handleScroll(1)
    expect(state.dashboardReader.page).toBe(1)
    const pages = [...state.dashboardReader.pages]
    text = 'Updated article'
    await app.refreshDashboards()
    expect(state.screen).toBe('dashboard-reader')
    expect(state.dashboardReader.pages).toEqual(pages)
    await state.openAssistant()
    expect(state.screen).toBe('dictating')
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard-reader')
    expect(state.dashboardReader.page).toBe(1)
    await state.handleDoubleTap()
    expect(state.dashboardSelection).toBe(selected)
    await state.handleTap()
    expect(state.dashboardReader.pages).toEqual(['Updated article'])
  })
  it('keeps dashboard selection and session browsing frozen as alerts arrive', async () => {
    const { state } = setup()
    state.acceptSessions(snapshot(0))
    await state.openDashboard()
    expect(state.dashboardSelection).toBe('assistant')
    state.onBridgeEvent('sessions.changed', snapshot(1, true))
    expect(state.notifications.unread).toHaveLength(1)
    expect(state.dashboardSelection).toBe('assistant')
    await state.openSessions()
    const rows = state.sessionRows
    state.onBridgeEvent('sessions.changed', snapshot(2, true))
    expect(state.screen).toBe('sessions')
    expect(state.sessionRows).toBe(rows)
    state.onBridgeEvent('sessions.changed', snapshot(1, true))
    expect(state.latestSessions.snapshotId).toBe('2')
  })
  it('opens alerts only through Notifications, marks read after loading, and returns directly home when empty', async () => {
    const { state, request } = setup()
    state.acceptSessions(snapshot(0))
    state.acceptSessions(snapshot(1, true))
    await state.openDashboard()
    expect(state.dashboardSelection).toBe('assistant')
    expect(state.cards.map((card: { key: string }) => card.key)).toEqual(['notifications', 'assistant', 'sessions'])
    await state.handleScroll(1)
    await state.handleScroll(1)
    await state.handleTap()
    expect(state.screen).toBe('notifications')
    request.mockRejectedValueOnce(new Error('Unavailable'))
    await expect(state.handleTap()).rejects.toThrow('Unavailable')
    expect(state.notifications.unread).toHaveLength(1)
    await state.handleTap()
    expect(state.notifications.unread).toHaveLength(0)
    expect(state.screen).toBe('transcript')
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.dashboardSelection).toBe('notifications')
    expect(state.cards.find((card: any) => card.key === 'notifications').title).toBe('Notifications 0')
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(0)
  })
  it.each(['dashboard', 'notifications'])('removes three alerts immediately from %s when their thread resumes work', async (screen) => {
    const { state } = setup()
    state.acceptSessions(snapshot(0))
    for (let minute = 1; minute <= 3; minute++) state.acceptSessions(snapshot(minute, true))
    await state.openDashboard()
    if (screen === 'notifications') await state.openNotifications()
    const working = snapshot(4)
    working.unsettled[0] = { ...working.unsettled[0]!, status: 'running', completedTurn: { id: 'turn-3', completedAt: date(3) } }
    state.onBridgeEvent('sessions.changed', working)
    expect(state.notifications.unread).toEqual([])
    expect(state.notificationItems).toEqual([])
    expect(state.screen).toBe(screen)
    expect(state.cards.map((card: any) => card.key)).toEqual(['notifications', 'assistant', 'sessions'])
    expect(state.lastGlassesFrame.dashboard.panel.unread).toBe(0)
  })
  it('refreshes the open inbox on arrivals while preserving the selected notification', async () => {
    const { state } = setup()
    state.acceptSessions(snapshot(0))
    state.acceptSessions(snapshot(1, true))
    state.acceptSessions(snapshot(2, true))
    await state.openNotifications()
    await state.handleScroll(1)
    const selection = state.notificationSelection
    state.acceptSessions(snapshot(3, true))
    expect(state.notificationSelection).toBe(selection)
    expect(state.notificationItems).toHaveLength(3)
    await state.handleDoubleTap()
    state.dashboardSelection = 'notifications'
    await state.handleTap()
    expect(state.notificationItems).toHaveLength(3)
    expect(state.notificationSelection).toBe(state.notificationItems[0].key)
  })
  it('starts recording from menu, ignores re-entry and overlays, and sends only after review', async () => {
    const { state, event, request, native } = setup()
    await state.openDashboard()
    await event({ menuItemClickEvent: { itemID: 1 } } as EvenHubEvent)
    expect(state.screen).toBe('dictating')
    expect(native.audioControl).toHaveBeenCalledWith(true, expect.anything())
    await event({ menuItemClickEvent: { itemID: 1 } } as EvenHubEvent)
    await event({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } } as EvenHubEvent)
    expect(state.screen).toBe('dictating')
    expect(request.mock.calls.filter(([method]) => method === 'voice.start')).toHaveLength(1)
    await state.handleTap()
    expect(state.screen).toBe('draft')
    expect(request.mock.calls.some(([method]) => method === 'thread.start' || method === 'assistant.start')).toBe(false)
    await state.handleTap()
    expect(request.mock.calls.filter(([method]) => method === 'assistant.start')).toHaveLength(1)
    expect(request).toHaveBeenCalledWith('assistant.start', { projectId: 'p', modelSelection: { instanceId: 'provider', model: 'model' }, text: 'What should I focus on today?' })
    expect(request.mock.calls.some(([method]) => method === 'thread.start')).toBe(false)
    expect(state.transcript.session.id).toBe('assistant-thread')
    await state.handleTap()
    await state.handleTap()
    await state.handleTap()
    expect(request.mock.calls.filter(([method]) => method === 'turn.reply')).toHaveLength(1)
    expect(request.mock.calls.filter(([method]) => method === 'assistant.start')).toHaveLength(1)
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
  })
  it('routes a reviewed reply through the selected remote environment and validates the readback identity', async () => {
    const { state, request } = setup()
    const target = { kind: 'thread', threadId: 'remote-thread', environmentId: 'remote' as const }
    state.screen = 'draft'
    state.voiceDraft = { target, returnScreen: 'transcript', text: 'Remote reply', pages: ['Remote reply'], page: 0, sendOutcome: 'ready' }
    request.mockImplementation(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'turn.reply') return { threadId: 'remote-thread', environmentId: 'remote', text: params?.text, sequence: 3 }
      if (method === 'transcript.get') return { ...transcript('remote-thread'), environmentId: 'remote', session: { ...transcript('remote-thread').session, environmentId: 'remote' } }
      throw new Error(`Unexpected method ${method}`)
    })
    await state.sendVoiceDraft()
    expect(request).toHaveBeenCalledWith('turn.reply', { environmentId: 'remote', threadId: 'remote-thread', text: 'Remote reply' })
    expect(state.voiceDraft).toBeNull()

    state.screen = 'draft'
    state.voiceDraft = { target, returnScreen: 'transcript', text: 'Second reply', pages: ['Second reply'], page: 0, sendOutcome: 'ready' }
    request.mockImplementation(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
      if (method === 'turn.reply') return { threadId: 'remote-thread', environmentId: 'remote', text: params?.text, sequence: 4 }
      if (method === 'transcript.get') return { ...transcript('wrong-thread'), environmentId: 'remote', session: { ...transcript('wrong-thread').session, environmentId: 'remote' } }
      throw new Error(`Unexpected method ${method}`)
    })
    await state.sendVoiceDraft()
    expect(state.voiceDraft.sendOutcome).toBe('unknown')
    const replies = request.mock.calls.filter(([method]) => method === 'turn.reply').length
    await state.sendVoiceDraft()
    expect(request.mock.calls.filter(([method]) => method === 'turn.reply')).toHaveLength(replies)
  })
  it('keeps the assistant draft on an older bridge and never downgrades to ordinary creation', async () => {
    const { state, request } = setup()
    await state.openDashboard()
    await state.openAssistant()
    await state.handleTap()
    const draft = state.voiceDraft
    request.mockRejectedValueOnce(new BridgeRequestError({ code: 'method_not_found', message: 'Method not found' }))
    await state.handleTap()
    expect(state.screen).toBe('error')
    expect(state.lastGlassesFrame.body).toContain('Update the Mac bridge')
    expect(state.voiceDraft).toBe(draft)
    expect(request.mock.calls.filter(([method]) => method === 'assistant.start')).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'thread.start' || method === 'turn.send')).toBe(false)
    await state.returnFromError()
    expect(state.screen).toBe('draft')
    await state.cancelVoiceFlow()
    expect(state.screen).toBe('dashboard')
  })
  it('keeps ordinary project creation on the configured thread.start path', async () => {
    const { state, request } = setup()
    await state.openDashboard()
    await state.beginDictation({ kind: 'project', projectId: 'p', modelSelection: { instanceId: 'provider', model: 'model' } }, 'new-session')
    await state.handleTap()
    expect(request.mock.calls.some(([method]) => method === 'thread.start' || method === 'assistant.start')).toBe(false)
    await state.handleTap()
    expect(request.mock.calls.filter(([method]) => method === 'thread.start')).toHaveLength(1)
    expect(request.mock.calls.some(([method]) => method === 'assistant.start')).toBe(false)
    state.cancelTranscriptRefresh()
  })
  it('restores the originating transcript and page on cancellation', async () => {
    const { state, request } = setup()
    state.screen = 'transcript'
    state.transcript = transcript('original')
    state.transcriptPages = [{ ...state.transcriptPages[0], text: 'Page one' }, { ...state.transcriptPages[0], text: 'Page two' }]
    state.transcriptPage = 1
    await state.openAssistant()
    await state.cancelVoiceFlow()
    expect(state.screen).toBe('transcript')
    expect(state.transcript.session.id).toBe('original')
    expect(state.transcriptPage).toBe(1)
    expect(request.mock.calls.some(([method]) => method === 'thread.start' || method === 'assistant.start')).toBe(false)
    state.cancelTranscriptRefresh()
  })
  it('rejects unavailable choices before recording and restores navigation after the error', async () => {
    const { state, request } = setup()
    state.screen = 'sessions'
    state.settings.assistant.projectId = 'deleted'
    await state.openAssistant()
    expect(state.screen).toBe('error')
    expect(request.mock.calls.some(([method]) => method === 'voice.start')).toBe(false)
    await state.returnFromError()
    expect(state.screen).toBe('sessions')
  })
  it('keeps unsaved settings inactive when storage fails', async () => {
    const { app, state, native } = setup()
    const previous = state.settings
    native.setLocalStorage.mockResolvedValue(false)
    await expect(app.saveSettings({ ...previous, assistant: null })).rejects.toThrow('could not save')
    expect(state.settings).toBe(previous)
  })
  it('goes from sessions to dashboard and closes only at dashboard root', async () => {
    const { state, native } = setup()
    state.screen = 'sessions'
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(native.shutDownPageContainer).not.toHaveBeenCalled()
    await state.handleDoubleTap()
    expect(native.shutDownPageContainer).toHaveBeenCalledOnce()
  })
})
