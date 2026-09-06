import { afterEach, describe, expect, it, vi } from 'vitest'
import { OsEventTypeList, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import type { CompanionUi } from './companion-ui'
import type { PhoneSnapshot, PhoneNotification } from './phone-protocol'
import { BridgeRequestError } from './protocol'
import { buildGlassesPage } from './glasses-display'

const notification = (revision = '1', key = 'chat'): PhoneNotification => ({ key, revision, packageName: 'org.signal', appName: 'Signal', title: 'Friends', text: `Message ${revision}`, arrivedAt: Number(revision) * 1000, replyable: true })
const snapshot = (items = [notification()], connected = true): PhoneSnapshot => ({ connected, permissionGranted: true, apps: [], notifications: items })
function setup() {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout, setInterval, clearInterval })
  const audioControl = vi.fn().mockResolvedValue(true)
  const app = new EvenT3App({ audioControl } as unknown as EvenAppBridge, {} as CompanionUi)
  const state = app as unknown as Record<string, any>
  state.phone = snapshot()
  state.phoneKey = 'chat'
  state.screen = 'phone-reader'
  const show = vi.spyOn(state, 'show').mockResolvedValue(undefined)
  vi.spyOn(state, 'refreshDashboards').mockResolvedValue(undefined)
  const inbox = vi.spyOn(state, 'openNotifications').mockImplementation(async () => { state.screen = 'notifications' })
  const request = vi.fn().mockResolvedValue({ cancelled: true })
  state.client = { connected: true, request }
  return { state, show, inbox, request, audioControl }
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
describe('phone notification flow', () => {
  it('shows flush-left incoming, live, and reviewed message text while retaining the original reply payload', async () => {
    const { state, show, request } = setup()
    const text = 'Yes, I can meet at noon.\n    Bring  the notes.\n\n  See you there!'
    const displayed = 'Yes, I can meet at noon.\nBring the notes.\n\nSee you there!'
    expect(state.phoneReaderFrame({ ...notification(), text }).body).toContain(displayed)
    state.dictation = { target: { kind: 'phone', key: 'chat' }, returnScreen: 'phone-reader', startedAt: Date.now(),
      sentBytes: 0, maxBytes: 999, partialText: text }
    state.screen = 'dictating'
    await state.renderDictation()
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ card: expect.objectContaining({ body: expect.stringContaining(displayed) }) }))
    request.mockResolvedValueOnce({ text })
    await state.finishDictation()
    expect(state.voiceDraft.text).toBe(text)
    expect(state.voiceDraft.pages).toEqual([displayed])
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ card: expect.objectContaining({ body: expect.stringContaining(displayed) }) }))
    request.mockResolvedValueOnce({ status: 'handed_off' }).mockResolvedValueOnce(snapshot([]))
    await state.sendPhoneDraft()
    expect(request).toHaveBeenCalledWith('phone.notifications.reply', expect.objectContaining({ text }))
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ card: expect.objectContaining({ title: 'SENDING REPLY', body: expect.stringContaining(displayed) }) }))
  })
  it('updates a dictating conversation without covering it or stopping audio', async () => {
    const { state, audioControl } = setup()
    const recording = { target: { kind: 'phone', key: 'chat' }, startedAt: Date.now(), sentBytes: 0, maxBytes: 999, partialText: 'My reply' }
    state.screen = 'dictating'; state.dictation = recording
    await state.acceptPhone(snapshot([notification('2')]))
    expect(state.dictation).toBe(recording)
    expect(state.screen).toBe('dictating')
    expect(audioControl).not.toHaveBeenCalled()
    expect(state.arrivalBanner).toBeUndefined()
    expect(state.phone.notifications[0].revision).toBe('2')
  })
  it('cancels removal immediately, discards draft and returns after one second', async () => {
    const { state, inbox, audioControl, show } = setup()
    state.screen = 'draft'; state.voiceDraft = { target: { kind: 'phone', key: 'chat' }, text: 'Unsent' }
    const removing = state.acceptPhone(snapshot([]))
    expect(state.voiceDraft).toBeNull()
    expect(audioControl).toHaveBeenCalledWith(false)
    expect(show).toHaveBeenCalledWith({ header: 'Cancelled', body: 'Notification no longer available' })
    await vi.advanceTimersByTimeAsync(999); expect(inbox).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1); await removing; expect(inbox).toHaveBeenCalled()
  })
  it('disconnect stops recording and restores cached inbox without retaining a draft', async () => {
    const { state, inbox, audioControl } = setup()
    state.screen = 'dictating'; state.dictation = { target: { kind: 'phone', key: 'chat' } }
    await state.acceptPhone(snapshot([notification()], false))
    expect(state.dictation).toBeNull(); expect(state.voiceDraft).toBeNull()
    expect(state.phone.notifications).toHaveLength(1)
    expect(audioControl).toHaveBeenCalledWith(false); expect(inbox).toHaveBeenCalled()
  })
  it('ignores a late transcription result after disconnect resets the flow', async () => {
    const { state, request } = setup()
    let finish!: (result: { text: string }) => void
    const result = new Promise<{ text: string }>(resolve => { finish = resolve })
    request.mockImplementation((method: string) => method === 'voice.finish' ? result : Promise.resolve({ cancelled: true }))
    state.screen = 'dictating'
    state.dictation = { target: { kind: 'phone', key: 'chat' }, returnScreen: 'notifications' }
    const finishing = state.finishDictation()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    await state.acceptPhone(snapshot([notification()], false))
    finish({ text: 'Late transcript must be discarded' }); await finishing
    expect(state.voiceDraft).toBeNull()
    expect(state.screen).toBe('notifications')
  })
  it('uses the same app and two-line subject/message preview in arrivals and the inbox', async () => {
    const { state, show } = setup()
    const item = { ...notification('2'), text: 'Lunch at noon. '.repeat(30) }
    await state.acceptPhone(snapshot([item]))
    const [appName, ...preview] = state.arrivalBanner.split('\n')
    state.notificationItems = state.allNotificationCards()
    state.notificationSelection = state.notificationItems[0].key
    state.rebuildDashboardCards()
    await state.renderNotifications()
    const { card } = show.mock.lastCall![0] as { card: { title: string; body: string } }
    expect(card.title).toBe(appName)
    expect(card.body).toBe(preview.join('\n'))
    expect(card.body.split('\n')).toHaveLength(2)
    expect(card.body).toMatch(/^Friends: Lunch at noon/)
  })
  it('sorts updated phone cards newest first', () => {
    const { state } = setup()
    state.phone = snapshot([notification('1', 'old'), notification('3', 'new')])
    expect(state.allNotificationCards().map((card: any) => card.key)).toEqual(['phone:new', 'phone:old'])
  })
  it('dispatches phone reply using current revision without any T3 send', async () => {
    const { state, request } = setup()
    state.screen = 'draft'
    state.voiceDraft = { target: { kind: 'phone', key: 'chat' }, text: 'Hello', returnScreen: 'notifications', pages: ['Hello'], page: 0 }
    request.mockResolvedValueOnce({ status: 'handed_off' }).mockResolvedValueOnce(snapshot([]))
    await state.sendVoiceDraft()
    expect(request).toHaveBeenCalledWith('phone.notifications.reply', expect.objectContaining({ key: 'chat', revision: '1', text: 'Hello' }))
    expect(request.mock.calls.map(call => call[0])).not.toContain('turn.send')
    expect(state.voiceDraft).toBeNull()
  })
  it('long press leaves the notification intact; only menu selection dismisses it', async () => {
    const { state, request } = setup()
    request.mockResolvedValueOnce({ status: 'dismissed' }).mockResolvedValueOnce(snapshot([]))
    state.routeInput(OsEventTypeList.LONG_PRESS_EVENT); await state.eventQueue
    expect(request).not.toHaveBeenCalled()
    state.companion.recordInput = vi.fn()
    state.onEvenEvent({ menuItemClickEvent: { itemID: 7 } }); await state.eventQueue
    expect(request).toHaveBeenCalledWith('phone.notifications.dismiss', expect.objectContaining({ key: 'chat', revision: '1' }))
    request.mockClear(); state.phone = snapshot([notification()], false); state.phoneKey = 'chat'; state.screen = 'phone-reader'
    state.onEvenEvent({ menuItemClickEvent: { itemID: 7 } }); await state.eventQueue
    expect(request).not.toHaveBeenCalled()
  })
  it('gives the latest arrival a full ten seconds and replaces the previous popup', async () => {
    const { state } = setup()
    await state.acceptPhone(snapshot([notification('2')]))
    await vi.advanceTimersByTimeAsync(2000)
    await state.acceptPhone(snapshot([notification('3')]))
    expect(state.arrivalBanner).toContain('Message 3')
    await vi.advanceTimersByTimeAsync(9999)
    expect(state.arrivalBanner).toContain('Message 3')
    await vi.advanceTimersByTimeAsync(1)
    expect(state.arrivalBanner).toBeUndefined()
    await state.acceptPhone(snapshot([notification('4')]))
    expect(state.arrivalBanner).toContain('Message 4')
  })
  it('explains unavailable handoff while keeping an active draft', async () => {
    const { state, request, show } = setup()
    const draft = { target: { kind: 'phone', key: 'chat' }, text: 'Hello', returnScreen: 'notifications', pages: ['Hello'], page: 0 }
    state.voiceDraft = draft; state.screen = 'draft'
    request.mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce(snapshot())
    await state.sendVoiceDraft()
    expect(state.voiceDraft).toBe(draft)
    expect(state.screen).toBe('error')
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('Reply unavailable. Draft kept; check phone.') }))
  })
  it('uses removal cancellation when an unavailable reply snapshot no longer contains the notification', async () => {
    const { state, request, show, inbox } = setup()
    state.voiceDraft = { target: { kind: 'phone', key: 'chat' }, text: 'Hello', returnScreen: 'notifications', pages: ['Hello'], page: 0 }
    request.mockResolvedValueOnce({ status: 'unavailable' }).mockResolvedValueOnce(snapshot([]))
    const sending = state.sendVoiceDraft()
    await vi.advanceTimersByTimeAsync(0)
    expect(show).toHaveBeenCalledWith({ header: 'Cancelled', body: 'Notification no longer available' })
    expect(state.voiceDraft).toBeNull(); expect(inbox).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1000); await sending
    expect(inbox).toHaveBeenCalled()
  })
  it('does not flash removal cancellation when an explicit dismissal removal arrives before its acknowledgement', async () => {
    const { state, request, show, inbox } = setup()
    let acknowledge!: (value: unknown) => void
    request.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve })).mockResolvedValueOnce(snapshot([]))
    const dismissing = state.dismissPhone()
    await state.acceptPhone(snapshot([]))
    expect(show).not.toHaveBeenCalledWith(expect.objectContaining({ header: 'Cancelled' }))
    acknowledge({ status: 'dismissed' }); await dismissing
    expect(inbox).toHaveBeenCalled()
    expect(state.phoneDismissal).toBeNull()
  })
  it('resets pending dismissal on disconnect and ignores its late acknowledgement', async () => {
    const { state, request, inbox } = setup()
    let acknowledge!: (value: unknown) => void
    request.mockReturnValueOnce(new Promise(resolve => { acknowledge = resolve }))
    const dismissing = state.dismissPhone()
    await state.acceptPhone(snapshot([notification()], false))
    expect(inbox).toHaveBeenCalledTimes(1)
    acknowledge({ status: 'dismissed' }); await dismissing
    expect(inbox).toHaveBeenCalledTimes(1)
    expect(state.phone.connected).toBe(false)
  })
  it('reports an expired command as a definite rejection and keeps the draft', async () => {
    const { state, request, show } = setup()
    const draft = { target: { kind: 'phone', key: 'chat' }, text: 'Hello', returnScreen: 'notifications', pages: ['Hello'], page: 0 }
    state.voiceDraft = draft
    request.mockRejectedValueOnce(new BridgeRequestError({ code: 'phone_command_expired', message: 'Phone action expired or device clocks differ. Review and try again.' }))
    await state.sendVoiceDraft()
    expect(state.voiceDraft).toBe(draft)
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({ body: expect.stringContaining('Phone action expired') }))
  })
  it('renders a separate two-line top banner without changing reader content', () => {
    const page = buildGlassesPage({ header: 'Reading', body: 'Current content', banner: 'Signal · Friends\nNew message' })
    const banner = page.textObject?.find(item => item.containerName === 'arrival')
    expect(banner).toMatchObject({ yPosition: 0, height: 56, content: 'Signal · Friends\nNew message' })
    expect(page.textObject?.find(item => item.containerName === 'body')?.content).toBe('Current content')
  })
})
