import { afterEach, describe, expect, it, vi } from 'vitest'
import { type EvenAppBridge, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import { PlanFlow, PLAN_NEXT_MENU_ID, PLAN_PREVIOUS_MENU_ID, PLAN_REVIEW_MENU_ID } from './plan-flow'
import type { CompanionUi } from './companion-ui'
import { BridgeRequestError, type PendingPlanInput } from './protocol'

const pending: PendingPlanInput = { requestId: 'request', revision: 'a'.repeat(64), turnId: 'turn', createdAt: '2026-09-04T12:00:00.000Z',
  questions: ['First', 'Second'].map(id => ({ id, header: id, question: `${id} question?`, multiSelect: false,
    options: [{ label: 'Yes', description: 'Proceed.' }, { label: 'No', description: 'Wait.' }] })) }
function setup() {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout, clearTimeout })
  const storage = new Map<string, string>()
  const native = { audioControl: vi.fn().mockResolvedValue(true),
    getLocalStorage: vi.fn(async (key: string) => storage.get(key) ?? null),
    setLocalStorage: vi.fn(async (key: string, value: string) => { storage.set(key, value); return true }) }
  const companion = { setMirror: vi.fn(), setDashboardMirror: vi.fn(), setSettingsStatus: vi.fn(), recordInput: vi.fn() }
  let current: PendingPlanInput | null | undefined = structuredClone(pending)
  const transcript = () => ({ snapshotId: 's', session: { id: 'thread', status: 'running' }, turns: [],
    liveActivity: null, liveActivities: [], pendingPlanInput: current })
  const request = vi.fn(async (method: string): Promise<any> => {
    if (method === 'transcript.get') return transcript()
    if (method === 'voice.start') return { maxBytes: 10000 }
    if (method === 'voice.finish') return { text: 'My own answer' }
    if (method === 'voice.cancel') return { cancelled: true }
    if (method === 'plan.submit') return { threadId: 'thread', requestId: 'request', sequence: 1 }
    throw new Error(`Unexpected ${method}`)
  })
  const app = new EvenT3App(native as unknown as EvenAppBridge, companion as unknown as CompanionUi)
  const state = app as unknown as Record<string, any>
  state.endpoint = 'ws://127.0.0.1:8787/v1/events'
  state.client = { connected: true, request }
  state.display.render = vi.fn().mockResolvedValue(undefined)
  state.returnToSessions = vi.fn(async () => { state.screen = 'sessions' })
  state.openDashboard = vi.fn(async () => { state.screen = 'dashboard' })
  const menu = async (itemID: number) => { state.onEvenEvent({ menuItemClickEvent: { itemID } }); await state.eventQueue }
  return { state, app, native, companion, request, menu, setPending(value: typeof current) { current = value } }
}
afterEach(() => vi.unstubAllGlobals())
async function openReady(state: Record<string, any>) {
  await state.openTranscript('thread')
  await vi.waitFor(() => expect(state.planFlow?.stage).not.toBe('loading'))
}

describe('plan questions in a thread', () => {
  it('keeps known over-limit answers editable and never locks or submits them', async () => {
    const { state, request } = setup()
    await openReady(state)
    const flow: PlanFlow = state.planFlow
    expect(flow.accept({ questionId: flow.question.id, optionIndexes: [], text: 'x'.repeat(8001) })).toBe(false)
    expect(flow.locked).toBe(false)
    expect(flow.notice).toContain('too long')
    expect(request.mock.calls.some(([method]) => method === 'plan.submit')).toBe(false)
  })
  it('reports microphone-start rejection before capture begins', async () => {
    const { state } = setup()
    await openReady(state)
    state.showError = vi.fn().mockResolvedValue(undefined)
    state.settingsSaving = true
    await state.handleTap()
    await state.handleScroll(1)
    await state.handleScroll(1)
    await state.handleTap()
    await vi.waitFor(() => expect(state.showError).toHaveBeenCalledWith('Wait for dashboard settings to finish saving.', 'plan'))
  })
  it('unlocks only a definitive pre-dispatch validation rejection for correction', async () => {
    const { state, request } = setup()
    await openReady(state)
    const flow: PlanFlow = state.planFlow
    flow.answers = pending.questions.map(question => ({ questionId: question.id, optionIndexes: [0], text: '' }))
    flow.stage = 'submitting'
    request.mockImplementationOnce(async () => { throw new BridgeRequestError({ code: 'invalid_plan_answers', message: 'Shorten answers' }) })
    await state.submitPlan(flow)
    expect(flow.stage).toBe('review')
    state.planFlows.clear()
    state.planFlow = null
    await openReady(state)
    expect(state.planFlow.locked).toBe(false)
    expect(state.planFlow.answers).toHaveLength(2)
  })
  it('does not resurrect a plan card after cleanup during native draft loading', async () => {
    const { state, native } = setup()
    let resolve!: (value: string | null) => void
    native.getLocalStorage.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const opening = state.openTranscript('thread')
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    state.closed = true
    state.endpointGeneration++
    state.screen = 'setup'
    state.planFlow = null
    resolve(null)
    await opening
    expect(state.screen).toBe('setup')
    expect(state.planFlow).toBeNull()
    expect(state.display.render).toHaveBeenCalledTimes(1)
    expect(state.display.render.mock.lastCall[0].card.title).toBe('LOADING SAVED ANSWERS')
  })

  it('allows double-tap exit while a partial-choice native write is pending', async () => {
    const { state, native, request } = setup()
    await openReady(state)
    let resolve!: (value: boolean) => void
    native.setLocalStorage.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    await state.handleTap()
    await state.handleTap()
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    await state.handleDoubleTap()
    expect(state.screen).toBe('sessions')
    resolve(false)
    await vi.waitFor(() => expect(state.planFlow.notice).toContain('session only'))
    expect(state.screen).toBe('sessions')
    expect(request.mock.calls.every(([method]) => method === 'transcript.get')).toBe(true)
  })

  it('does not send to a stale endpoint after submission persistence finishes', async () => {
    const { state, native, request } = setup()
    await openReady(state)
    const flow: PlanFlow = state.planFlow
    flow.answers = pending.questions.map(question => ({ questionId: question.id, optionIndexes: [0], text: '' }))
    flow.stage = 'submitting'
    let resolve!: (value: boolean) => void
    native.setLocalStorage.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const submitting = state.submitPlan(flow)
    await vi.waitFor(() => expect(resolve).toBeTypeOf('function'))
    state.endpointGeneration++
    state.endpoint = 'wss://other.example/v1/events'
    state.planFlow = null
    resolve(false)
    await submitting
    expect(request.mock.calls.some(([method]) => method === 'plan.submit')).toBe(false)
  })

  it('exits during microphone startup and rejects late capture activation', async () => {
    const { state, native, request } = setup()
    await openReady(state)
    let resolve!: (value: unknown) => void
    request.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    await state.handleTap()
    await state.handleScroll(1)
    await state.handleScroll(1)
    await state.handleTap()
    expect(state.screen).toBe('dictating')
    await state.handleDoubleTap()
    resolve({ maxBytes: 10000 })
    await Promise.resolve()
    expect(state.screen).toBe('sessions')
    expect(native.audioControl.mock.calls.some(([enabled]) => enabled === true)).toBe(false)
  })

  it('opens the bottom card and saves choices without any T3 mutation until final submit', async () => {
    const { state, request } = setup()
    await openReady(state)
    expect(state.screen).toBe('plan')
    expect(state.display.render.mock.lastCall[0].card.entrance).toBe('bottom')
    await state.handleTap()
    expect(state.display.render.mock.lastCall[0].card.entrance).toBe('right')
    await state.handleTap()
    expect(state.planFlow.questionIndex).toBe(1)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['transcript.get'])
    await state.handleTap()
    await state.handleTap()
    expect(state.planFlow.stage).toBe('review')
    await state.handleTap()
    await state.handleTap()
    expect(request.mock.calls.some(([method]) => method === 'plan.submit')).toBe(false)
    await state.handleTap()
    await vi.waitFor(() => expect(request.mock.calls.filter(([method]) => method === 'plan.submit')).toHaveLength(1))
    await state.handleTap()
    expect(request.mock.calls.filter(([method]) => method === 'plan.submit')).toHaveLength(1)
    state.cancelTranscriptRefresh()
  })

  it('restores partial answers and originating selection when exiting and reopening', async () => {
    const { state, request } = setup()
    state.sessionSelection = 'selected-thread'
    await openReady(state)
    await state.handleTap()
    await state.handleTap()
    await state.handleDoubleTap()
    expect(state.screen).toBe('sessions')
    expect(state.sessionSelection).toBe('selected-thread')
    // Simulate a cold UI state against the same native storage.
    state.planFlows.clear()
    state.planFlow = null
    await openReady(state)
    expect(state.planFlow.answers).toHaveLength(1)
    expect(state.planFlow.questionIndex).toBe(1)
    expect(request.mock.calls.every(([method]) => method === 'transcript.get')).toBe(true)
    state.transcriptReturn = 'dashboard'
    await state.handleDoubleTap()
    expect(state.screen).toBe('dashboard')
  })

  it('cycles and edits questions through native menu events without losing choices', async () => {
    const { state, menu } = setup()
    await openReady(state)
    await menu(PLAN_NEXT_MENU_ID)
    expect(state.planFlow.questionIndex).toBe(1)
    await state.handleTap()
    await state.handleTap()
    await menu(PLAN_REVIEW_MENU_ID)
    expect(state.planFlow.stage).toBe('review')
    await menu(PLAN_PREVIOUS_MENU_ID)
    expect(state.planFlow.stage).toBe('question')
    expect(state.planFlow.answers).toHaveLength(1)
    const before = state.planFlow.questionIndex
    state.onEvenEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT } })
    state.onEvenEvent({ sysEvent: { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT } })
    await state.eventQueue
    expect(state.planFlow.questionIndex).toBe(before)
  })

  it('accepts custom dictation locally and never routes it to thread.start, turn.send, turn.steer, or turn.reply', async () => {
    const { state, request } = setup()
    await openReady(state)
    await state.handleTap()
    await state.handleScroll(1)
    await state.handleScroll(1)
    await state.handleTap()
    expect(state.screen).toBe('dictating')
    await state.finishDictation()
    expect(state.screen).toBe('draft')
    await state.handleTap()
    expect(state.planFlow.answers[0].text).toBe('My own answer')
    expect(state.screen).toBe('plan')
    expect(request.mock.calls.map(([method]) => method)).toEqual(['transcript.get', 'voice.start', 'voice.finish'])
  })

  it('exits during finalization without resurrecting the draft when transcription arrives', async () => {
    const { state, native, request } = setup()
    await openReady(state)
    await state.beginDictation({ kind: 'thread', threadId: 'thread' }, 'plan')
    let resolve!: (value: any) => void
    request.mockImplementationOnce(() => new Promise(yes => { resolve = yes }))
    const finishing = state.finishDictation()
    await vi.waitFor(() => expect(state.screen).toBe('finalizing'))
    await state.handleDoubleTap()
    resolve({ text: 'Late answer' })
    await finishing
    expect(state.screen).toBe('sessions')
    expect(state.voiceDraft).toBeNull()
    expect(state.planFlow.answers).toEqual([])
    expect(native.audioControl).toHaveBeenLastCalledWith(false)
  })

  it('does not interrupt a plan screen or its choices on transcript updates and exits when resolved', async () => {
    const { state, setPending } = setup()
    await openReady(state)
    await state.handleTap()
    await state.handleScroll(1)
    const flow: PlanFlow = state.planFlow
    await state.openTranscript('thread', false, true)
    expect(state.planFlow).toBe(flow)
    expect(flow.optionCursor).toBe(1)
    setPending(null)
    await state.openTranscript('thread', false, true)
    expect(state.screen).toBe('transcript')
    expect(state.planFlow).toBeNull()
  })

  it('retains a locked complete draft after network uncertainty and allows exit while submit waits', async () => {
    const { state, request } = setup()
    await openReady(state)
    const flow: PlanFlow = state.planFlow
    flow.answers = pending.questions.map(question => ({ questionId: question.id, optionIndexes: [0], text: '' }))
    flow.stage = 'submitting'
    let reject!: (reason: Error) => void
    request.mockImplementationOnce(() => new Promise((_, no) => { reject = no }))
    const submitting = state.submitPlan(flow)
    await vi.waitFor(() => expect(reject).toBeTypeOf('function'))
    await state.handleDoubleTap()
    reject(new Error('Connection lost'))
    await submitting
    expect(state.screen).toBe('sessions')
    state.planFlows.clear()
    state.planFlow = null
    await openReady(state)
    expect(state.planFlow.locked).toBe(true)
    expect(state.planFlow.answers).toHaveLength(2)
  })

  it('leaves older bridges and ordinary thread dictation unchanged', async () => {
    const { state, setPending } = setup()
    setPending(undefined)
    await openReady(state)
    expect(state.screen).toBe('transcript')
    await state.handleTap()
    expect(state.dictation.returnScreen).toBe('transcript')
    await state.cancelVoiceFlow()
  })
})
