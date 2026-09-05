import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import { T3BridgeClient } from './bridge-client'
import type { CompanionUi } from './companion-ui'
import { defaultDashboardSettings } from './dashboard-settings'

const endpoint = 'wss://bridge.example/v1/events'
const date = '2026-09-04T12:00:00.000Z'
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function setup() {
  vi.stubGlobal('window', { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), setTimeout, clearTimeout })
  const native = {
    getLocalStorage: vi.fn().mockResolvedValue(null), setLocalStorage: vi.fn().mockResolvedValue(true),
    getAppLocation: vi.fn().mockResolvedValue(null), audioControl: vi.fn().mockResolvedValue(true),
    shutDownPageContainer: vi.fn().mockResolvedValue(true),
  }
  const companion = { setMirror: vi.fn(), setDashboardMirror: vi.fn(), setConnectionStatus: vi.fn(), setSettingsStatus: vi.fn(), setSettings: vi.fn() }
  const app = new EvenT3App(native as unknown as EvenAppBridge, companion as unknown as CompanionUi)
  const state = app as unknown as Record<string, any>
  state.display = { render: vi.fn().mockResolvedValue(undefined) }
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === 'projects.list') return { projects: [] }
    if (method === 'models.list') return { models: [] }
    if (method === 'sessions.list') return { snapshotId: '1', frozenAt: date, unsettled: [], settled: [] }
    if (method === 'voice.start') return { maxBytes: 1000 }
    if (method === 'voice.cancel') return { cancelled: true }
    throw new Error(`Unexpected method: ${method}`)
  })
  state.client = { connected: true, request, close: vi.fn() }
  state.endpoint = endpoint
  state.settings = { ...defaultDashboardSettings(), weather: { enabled: false, unit: 'fahrenheit', fallbackCity: null } }
  state.screen = 'dashboard'
  return { app, state, native, companion, request }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('dashboard asynchronous boundaries', () => {
  it('preserves weather cache and location cadence for assistant-only saves', async () => {
    const { app, state, native, request } = setup()
    state.settings.weather.enabled = true
    const reset = vi.spyOn(state.weather, 'reset')
    const refresh = vi.spyOn(state.weather, 'refresh')
    let stored = ''
    native.setLocalStorage.mockImplementation(async (_key: string, value: string) => { stored = value; return true })
    native.getLocalStorage.mockImplementation(async () => stored)
    request.mockImplementation(async (method: string) => {
      if (method === 'projects.list') return { projects: [{ id: 'p', title: 'Assistant', canStartSession: true, updatedAt: date }] }
      if (method === 'models.list') return { models: [{ instanceId: 'provider', model: 'model', name: 'Model',
        providerName: 'Provider', isDefault: true, reasoningChoices: [] }] }
      throw new Error('Unexpected request')
    })
    await app.saveSettings({ ...state.settings, assistant: { projectId: 'p', modelSelection: { instanceId: 'provider', model: 'model' } } })
    expect(reset).not.toHaveBeenCalled()
    expect(refresh).not.toHaveBeenCalled()
    expect(native.getAppLocation).not.toHaveBeenCalled()
    await app.saveSettings({ ...state.settings, weather: { ...state.settings.weather, unit: 'celsius' } })
    expect(reset).toHaveBeenCalledOnce()
    expect(refresh).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(native.getAppLocation).toHaveBeenCalledOnce())
  })
  it('rejects closed and obsolete saves rather than acknowledging a discarded selection', async () => {
    const first = setup()
    first.app.cleanup()
    await expect(first.app.saveSettings(defaultDashboardSettings())).rejects.toThrow('Reopen the app')
    expect(first.native.setLocalStorage).not.toHaveBeenCalled()

    const { app, state, native } = setup()
    const write = deferred<boolean>()
    native.setLocalStorage.mockReturnValueOnce(write.promise)
    native.getLocalStorage.mockImplementation(async () => native.setLocalStorage.mock.calls[0]?.[1] ?? null)
    const previous = state.settings
    const saving = app.saveSettings({ ...previous, weather: { ...previous.weather, unit: 'celsius' } })
    await vi.waitFor(() => expect(native.setLocalStorage).toHaveBeenCalledOnce())
    state.endpointGeneration++
    write.resolve(true)
    await expect(saving).rejects.toThrow('Connection changed')
    expect(state.settings).toBe(previous)
  })
  it('keeps the dashboard open while a verified settings write is unfinished', async () => {
    const { app, state, native } = setup()
    const write = deferred<boolean>()
    native.setLocalStorage.mockReturnValueOnce(write.promise)
    native.getLocalStorage.mockImplementation(async () => native.setLocalStorage.mock.calls[0]?.[1] ?? null)
    const saving = app.saveSettings(state.settings)
    await vi.waitFor(() => expect(native.setLocalStorage).toHaveBeenCalledOnce())
    await state.handleDoubleTap()
    expect(native.shutDownPageContainer).not.toHaveBeenCalled()
    expect(state.display.render.mock.calls.at(-1)?.[0].header).toBe('SAVING SETTINGS')
    write.resolve(true)
    await saving
    await state.handleDoubleTap()
    expect(native.shutDownPageContainer).toHaveBeenCalledExactlyOnceWith(1)
    expect(state.closed).toBe(true)
  })
  it('uses the same normalized preferences in memory and storage and rejects concurrent saves', async () => {
    const { app, state, native } = setup()
    const write = deferred<boolean>()
    native.setLocalStorage.mockReturnValueOnce(write.promise)
    native.getLocalStorage.mockImplementation(async () => native.setLocalStorage.mock.calls[0]?.[1] ?? null)
    const incoming = { ...state.settings, token: 'do not retain', weather: { enabled: false, unit: 'fahrenheit',
      fallbackCity: { id: '1', name: 'City', region: '', country: 'Country', latitude: 39.123456, longitude: 12.123456 } } }
    const save = app.saveSettings(incoming)
    await vi.waitFor(() => expect(native.setLocalStorage).toHaveBeenCalledOnce())
    await state.renderDashboard()
    expect(state.display.render.mock.calls.at(-1)?.[0].askAssistant).toBe(true)
    expect(state.canAskAssistant()).toBe(false)
    await expect(app.saveSettings(incoming)).rejects.toThrow('already being saved')
    write.resolve(true)
    await save
    expect(state.settings.token).toBeUndefined()
    expect(state.settings.weather.fallbackCity.latitude).toBe(39.12)
    expect(JSON.parse(native.setLocalStorage.mock.calls[0][1])).toEqual(state.settings)
  })
  it('does not install an old endpoint preference load after a new connection succeeds', async () => {
    const { state, native, request } = setup()
    const old = deferred<string>()
    vi.spyOn(T3BridgeClient.prototype, 'connect').mockResolvedValue(undefined)
    vi.spyOn(T3BridgeClient.prototype, 'onEvent').mockReturnValue(() => {})
    vi.spyOn(T3BridgeClient.prototype, 'request').mockImplementation(request as any)
    native.getLocalStorage.mockImplementation(async (key: string) => {
      if (key.includes('settings') && key.includes('old.example')) return old.promise
      if (key.includes('settings')) return JSON.stringify({ ...defaultDashboardSettings(), weather: { enabled: false, unit: 'celsius', fallbackCity: null } })
      return null
    })
    const first = state.connect({ url: 'wss://old.example/v1/events', token: 'a'.repeat(32) })
    await vi.waitFor(() => expect(native.getLocalStorage).toHaveBeenCalled())
    await state.connect({ url: 'wss://new.example/v1/events', token: 'b'.repeat(32) })
    old.resolve(JSON.stringify(defaultDashboardSettings()))
    await first
    expect(state.endpoint).toBe('wss://new.example/v1/events')
    expect(state.settings.weather.unit).toBe('celsius')
    expect(state.settings.weather.enabled).toBe(false)
    expect(state.screen).toBe('dashboard')
  })
  it('rejects obsolete and malformed city results before they reach the phone settings', async () => {
    const { app, state, request } = setup()
    const result = deferred<unknown>()
    request.mockReturnValueOnce(result.promise)
    const search = app.searchWeatherLocations('City')
    state.endpointGeneration++
    result.resolve({ locations: [] })
    await expect(search).rejects.toThrow('Connection changed')
    request.mockResolvedValueOnce({ locations: 'invalid' })
    await expect(app.searchWeatherLocations('City')).rejects.toThrow('unavailable')
    request.mockResolvedValueOnce({ locations: [{ id: '1', name: 'spoof\ncity', latitude: 0, longitude: 0 }] })
    expect(await app.searchWeatherLocations('City')).toEqual([])
  })
  it('never opens the microphone when cleanup overtakes voice startup', async () => {
    const { app, state, native, request } = setup()
    const recording = deferred<unknown>()
    request.mockReturnValueOnce(recording.promise)
    const start = state.beginDictation({ kind: 'thread', threadId: 'thread' }, 'transcript')
    app.cleanup()
    recording.resolve({ maxBytes: 1000 })
    await start
    expect(native.audioControl.mock.calls.every(([enabled]) => enabled === false)).toBe(true)
    expect(state.client).toBeNull()
    expect(state.dictation).toBeNull()
    expect(state.dictationTimer).toBeNull()
  })
  it('closes a microphone whose delayed open completes after cleanup', async () => {
    const { app, state, native } = setup()
    const microphone = deferred<boolean>()
    native.audioControl.mockImplementation((enabled: boolean) => enabled ? microphone.promise : Promise.resolve(true))
    const start = state.beginDictation({ kind: 'thread', threadId: 'thread' }, 'transcript')
    await vi.waitFor(() => expect(native.audioControl).toHaveBeenCalledWith(true, expect.anything()))
    app.cleanup()
    microphone.resolve(true)
    await start
    expect(native.audioControl.mock.calls.at(-1)).toEqual([false])
    expect(state.dictationTimer).toBeNull()
  })
  it('prevents bridge changes during assistant startup and discards queued actions on cleanup', async () => {
    const { app, state } = setup()
    state.assistantOpening = true
    await expect(app.pairAndConnect({ url: endpoint, passphrase: 'test' })).rejects.toThrow('Finish or cancel dictation')
    const action = vi.fn()
    state.enqueue(action)
    app.cleanup()
    await state.eventQueue
    expect(action).not.toHaveBeenCalled()
  })
  it('discards a late transcription after cleanup', async () => {
    const { app, state, request } = setup()
    const result = deferred<unknown>()
    state.dictation = { target: { kind: 'thread', threadId: 'thread' }, returnScreen: 'transcript' }
    request.mockReturnValueOnce(result.promise)
    const finish = state.finishDictation()
    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('voice.finish'))
    app.cleanup()
    result.resolve({ text: 'private dictation' })
    await finish
    expect(state.voiceDraft).toBeNull()
    expect(state.screen).toBe('setup')
  })
  it('does not send a draft when cleanup overtakes its pending display update', async () => {
    const { app, state, request } = setup()
    state.voiceDraft = { target: { kind: 'project', projectId: 'project', modelSelection: { instanceId: 'provider', model: 'model' } },
      text: 'private query', returnScreen: 'assistant', page: 0, pages: ['private query'] }
    const display = deferred<void>()
    state.display.render.mockReturnValueOnce(display.promise)
    const send = state.sendVoiceDraft()
    app.cleanup()
    display.resolve()
    await send
    expect(request).not.toHaveBeenCalled()
    expect(state.voiceDraft).toBeNull()
  })
})
