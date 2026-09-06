import { afterEach, describe, expect, it, vi } from 'vitest'
import { type EvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import type { CompanionUi } from './companion-ui'
import { defaultDashboardSettings } from './dashboard-settings'
import type { SessionSummary, SessionsListResult, TranscriptResult } from './protocol'
import type { PhoneNotification, PhoneSnapshot } from './phone-protocol'
import { buildGlassesPage, type GlassesFrame } from './glasses-display'

const date = (minute: number) => `2026-09-06T12:${String(minute).padStart(2, '0')}:00.000Z`
const session = (id: string): SessionSummary => ({ id, projectId: 'project', projectTitle: 'Workspace', title: `Thread ${id}`,
  settled: false, status: 'idle', lastActivityAt: date(0), completedTurn: null })
const phone = (key = 'chat', revision = '1'): PhoneNotification => ({ key, revision, packageName: 'org.signal',
  appName: 'Signal', title: 'Friends', text: 'Meet for lunch?', arrivedAt: Number(revision) * 1000, replyable: true })
const phoneSnapshot = (notifications: PhoneNotification[], connected = true): PhoneSnapshot => ({ connected, permissionGranted: true, apps: [], notifications })

function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  const native = { audioControl: vi.fn().mockResolvedValue(true), setLocalStorage: vi.fn().mockResolvedValue(true),
    getAppLocation: vi.fn().mockResolvedValue(null), shutDownPageContainer: vi.fn().mockResolvedValue(true) }
  const companion = { setMirror: vi.fn(), setOsMirror: vi.fn(), setSettingsStatus: vi.fn(), setArrivalBanner: vi.fn() }
  const app = new EvenT3App(native as unknown as EvenAppBridge, companion as unknown as CompanionUi)
  const state = app as unknown as Record<string, any>
  const render = vi.spyOn(state.display, 'render').mockResolvedValue(undefined)
  let live: SessionsListResult = { snapshotId: '0', frozenAt: date(0), unsettled: ['a', 'b', 'c'].map(session), settled: [] }
  const request = vi.fn(async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'transcript.get') return { snapshotId: live.snapshotId,
      session: live.unsettled.find(item => item.id === params?.threadId) ?? session(String(params?.threadId)),
      turns: [], liveActivity: null, liveActivities: [] } satisfies TranscriptResult
    if (method === 'sessions.list') return live
    if (method === 'phone.notifications.list') return state.phone
    if (method === 'voice.cancel') return { cancelled: true }
    throw new Error(`Unexpected request: ${method}`)
  })
  state.client = { connected: true, request, close: vi.fn() }
  state.settings = { ...defaultDashboardSettings(), weather: { enabled: false, unit: 'fahrenheit', fallbackCity: null } }
  state.endpoint = 'ws://127.0.0.1:8787/v1/events'
  state.screen = 'dashboard'
  state.phone = phoneSnapshot([])
  state.acceptSessions(live)
  const arrive = async (id = 'b', minute = 1) => {
    live = { ...live, snapshotId: String(minute), frozenAt: date(minute), unsettled: live.unsettled.map(item => item.id === id
      ? { ...item, completedTurn: { id: `turn-${id}-${minute}`, completedAt: date(minute) } } : item) }
    state.acceptSessions(live)
    await state.refreshDashboards()
  }
  return { state, native, companion, render, request, arrive }
}

afterEach(() => { vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('notification dropdown navigation', () => {
  it('shows a fresh T3 alert for ten seconds, then hides it without marking it read', async () => {
    const { state, render, arrive, request } = setup()
    expect(state.arrivalBanner).toBeUndefined()
    await arrive()
    expect(state.arrivalBanner).toContain('Thread b')
    expect(state.screen).toBe('dashboard')
    const page = buildGlassesPage(render.mock.lastCall![0] as GlassesFrame)
    expect(page.textObject?.some(item => item.content?.includes('Thread b'))).toBe(true)
    await vi.advanceTimersByTimeAsync(9999)
    expect(state.arrivalTarget).toEqual({ kind: 'thread', threadId: 'b', turnId: 'turn-b-1' })
    await vi.advanceTimersByTimeAsync(1)
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.notifications.unread).toHaveLength(1)
    expect(request).not.toHaveBeenCalledWith('transcript.get', expect.anything())
  })

  it('opens the alert instead of the selected dashboard action and returns to the same selection', async () => {
    const { state, request, arrive } = setup()
    state.dashboardSelection = 'sessions'
    await arrive()
    await state.handleTap()
    expect(state.screen).toBe('transcript')
    expect(state.transcript.session.id).toBe('b')
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.notifications.unread).toHaveLength(0)
    expect(request.mock.calls.map(([method]) => method)).not.toContain('voice.start')
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.dashboardSelection).toBe('sessions')
    expect(state.assistantOrigin).toBeNull()
  })

  it('returns to the exact interrupted transcript page and resumes its refresh subscription', async () => {
    const { state, request, arrive } = setup()
    await state.openTranscript('a')
    const original = state.transcript
    const first = state.transcriptPages[0]
    const pages = [{ ...first, text: 'First page', messageId: 'first' }, { ...first, text: 'Second page', messageId: 'second' }]
    state.transcriptPages = pages
    state.transcriptPage = 0
    await state.renderTranscript()
    await arrive()
    await state.handleTap()
    expect(state.transcript.session.id).toBe('b')
    await state.handleDoubleTap()
    expect(state.screen).toBe('transcript')
    expect(state.transcript).toBe(original)
    expect(state.transcriptPages).toBe(pages)
    expect(state.transcriptPage).toBe(0)
    request.mockClear()
    await vi.advanceTimersByTimeAsync(120)
    await state.eventQueue
    expect(request).toHaveBeenCalledWith('transcript.get', { threadId: 'a' })
  })

  it('opens a tracked phone conversation over a T3 thread and double tap restores the thread', async () => {
    const { state, request } = setup()
    await state.openTranscript('a')
    await state.acceptPhone(phoneSnapshot([phone()]))
    await state.handleTap()
    expect(state.screen).toBe('phone-reader')
    expect(state.phoneKey).toBe('chat')
    await state.handleDoubleTap()
    expect(state.screen).toBe('transcript')
    expect(state.transcript.session.id).toBe('a')
    expect(request.mock.calls.map(([method]) => method)).not.toContain('phone.notifications.dismiss')
    expect(state.phone.notifications).toHaveLength(1)
  })

  it('stacks notifications and preserves a phone reader page when a T3 alert interrupts it', async () => {
    const { state, arrive } = setup()
    await state.acceptPhone(phoneSnapshot([{ ...phone(), text: 'A long conversation. '.repeat(160) }]))
    await state.handleTap()
    state.phonePage = 1
    await state.renderPhoneReader()
    await arrive()
    await state.handleTap()
    expect(state.transcript.session.id).toBe('b')
    await state.handleDoubleTap()
    expect(state.screen).toBe('phone-reader')
    expect(state.phonePage).toBe(1)
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.assistantOrigin).toBeNull()
  })

  it('binds a tap before expiry to that notification even while input is queued', async () => {
    const { state, arrive } = setup()
    await arrive()
    let release!: () => void
    state.eventQueue = new Promise<void>(resolve => { release = resolve })
    state.routeInput(OsEventTypeList.CLICK_EVENT)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.arrivalBanner).toBeUndefined()
    release()
    await state.eventQueue
    expect(state.transcript.session.id).toBe('b')
  })

  it('replaces bursts with the newest arrival and restarts the expiry timer', async () => {
    const { state, arrive } = setup()
    await arrive('b', 1)
    await vi.advanceTimersByTimeAsync(2000)
    await arrive('c', 2)
    await vi.advanceTimersByTimeAsync(1000)
    expect(state.arrivalTarget.threadId).toBe('c')
    await state.handleTap()
    expect(state.transcript.session.id).toBe('c')
    expect(state.notifications.unread.map((item: any) => item.threadId)).toEqual(['b'])
  })

  it('consumes a queued tap safely if the notification disappears before it is handled', async () => {
    const { state, request } = setup()
    await state.acceptPhone(phoneSnapshot([phone()]))
    let release!: () => void
    state.eventQueue = new Promise<void>(resolve => { release = resolve })
    state.routeInput(OsEventTypeList.CLICK_EVENT)
    await state.acceptPhone(phoneSnapshot([]))
    release()
    await state.eventQueue
    expect(state.screen).toBe('dashboard')
    expect(request).not.toHaveBeenCalled()
    expect(state.assistantOrigin).toBeNull()
  })

  it('clears the preview and its pending redraw when the app closes', async () => {
    const { state, render, arrive } = setup()
    await arrive()
    state.cleanup()
    render.mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.arrivalTarget).toBeNull()
    expect(state.arrivalBanner).toBeUndefined()
    expect(render).not.toHaveBeenCalled()
  })

  it('does not reannounce repeated snapshots or a phone reconnect baseline', async () => {
    const { state, arrive } = setup()
    await arrive()
    await vi.advanceTimersByTimeAsync(10_000)
    await arrive()
    expect(state.arrivalBanner).toBeUndefined()
    state.phone = phoneSnapshot([], false)
    await state.acceptPhone(phoneSnapshot([phone()]))
    expect(state.arrivalBanner).toBeUndefined()
  })

  it('dismisses the popup with double tap without leaving the dashboard or consuming the alert', async () => {
    const { state, native, arrive } = setup()
    await arrive()
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.notifications.unread).toHaveLength(1)
    expect(native.shutDownPageContainer).not.toHaveBeenCalled()
  })

  it.each([OsEventTypeList.SCROLL_TOP_EVENT, OsEventTypeList.SCROLL_BOTTOM_EVENT])(
    'dismisses a T3 dropdown with swipe %s without navigating or marking it read', async eventType => {
      const { state, arrive } = setup()
      state.dashboardSelection = 'sessions'
      await arrive()
      const scroll = vi.spyOn(state, 'handleScroll')
      state.routeInput(eventType)
      await state.eventQueue
      expect(state.arrivalBanner).toBeUndefined()
      expect(state.arrivalTarget).toBeNull()
      expect(state.screen).toBe('dashboard')
      expect(state.dashboardSelection).toBe('sessions')
      expect(state.notifications.unread).toHaveLength(1)
      expect(scroll).not.toHaveBeenCalled()
      state.routeInput(eventType)
      await state.eventQueue
      expect(scroll).toHaveBeenCalledOnce()
    },
  )

  it('consumes a phone-dropdown swipe even when queued past expiry and preserves the reader page', async () => {
    const { state, request } = setup()
    await state.openTranscript('a')
    const originalPage = state.transcriptPage
    await state.acceptPhone(phoneSnapshot([phone()]))
    const scroll = vi.spyOn(state, 'handleScroll')
    let release!: () => void
    state.eventQueue = new Promise<void>(resolve => { release = resolve })
    state.routeInput(OsEventTypeList.SCROLL_BOTTOM_EVENT)
    await vi.advanceTimersByTimeAsync(10_000)
    release()
    await state.eventQueue
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.screen).toBe('transcript')
    expect(state.transcriptPage).toBe(originalPage)
    expect(state.phone.notifications).toHaveLength(1)
    expect(scroll).not.toHaveBeenCalled()
    expect(request.mock.calls.map(([method]) => method)).not.toContain('phone.notifications.dismiss')
  })

  it('withdraws removed phone notifications and T3 alerts that resume work', async () => {
    const { state, arrive } = setup()
    await state.acceptPhone(phoneSnapshot([phone()]))
    await state.acceptPhone(phoneSnapshot([]))
    expect(state.arrivalBanner).toBeUndefined()
    await arrive()
    state.acceptSessions({ ...state.latestSessions, snapshotId: '2', frozenAt: date(2),
      unsettled: state.latestSessions.unsettled.map((item: SessionSummary) => ({ ...item, status: 'running' })) })
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.notifications.unread).toHaveLength(0)
  })

  it('restores the previous screen if opening the alert fails and keeps it unread', async () => {
    const { state, arrive, request, companion } = setup()
    await arrive()
    request.mockRejectedValueOnce(new Error('Thread unavailable'))
    await state.handleTap()
    expect(state.screen).toBe('dashboard')
    expect(state.assistantOrigin).toBeNull()
    expect(state.notifications.unread).toHaveLength(1)
    expect(companion.setSettingsStatus).toHaveBeenCalledWith(expect.stringContaining('Could not open notification'))
  })

  it('keeps new alerts in the inbox without covering or interrupting voice review', async () => {
    const { state, arrive, native } = setup()
    state.screen = 'draft'
    const draft = { target: { kind: 'thread', threadId: 'a' }, text: 'Reviewed reply', pages: ['Reviewed reply'], page: 0 }
    state.voiceDraft = draft
    await arrive()
    await state.acceptPhone(phoneSnapshot([phone()]))
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.voiceDraft).toBe(draft)
    expect(state.screen).toBe('draft')
    expect(native.audioControl).not.toHaveBeenCalled()
    expect(state.notifications.unread).toHaveLength(1)
    expect(state.phone.notifications).toHaveLength(1)
  })
})
