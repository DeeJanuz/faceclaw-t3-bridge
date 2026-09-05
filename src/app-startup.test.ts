import { StartUpPageCreateResult, ImageRawDataUpdateResult, OsEventTypeList, type EvenAppBridge, type EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompanionUi } from './companion-ui'

const DEFAULT_URL = 'wss://mac.example.ts.net:8443/v1/events'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function companion(): CompanionUi {
  return {
    setDiagnosticsReady: vi.fn(),
    setConnectionStatus: vi.fn(),
    setMirror: vi.fn(),
    setProfile: vi.fn(),
    recordInput: vi.fn(),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('EvenT3App startup profile ordering', () => {
  it('cancels an integrated card test through the real glasses double-tap route', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    let onEvent!: (event: EvenHubEvent) => void
    const bridge = {
      getLocalStorage: vi.fn().mockResolvedValue(null),
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success),
      audioControl: vi.fn(),
      onEvenHubEvent: vi.fn(callback => { onEvent = callback; return vi.fn() }),
    }
    const { EvenT3App } = await import('./app')
    const phone = companion()
    const app = new EvenT3App(bridge as unknown as EvenAppBridge, phone)
    await app.start()
    const report: string[] = []
    const running = app.runDisplayDiagnostics('card', line => report.push(line), new AbortController().signal)
    await vi.waitFor(() => expect(report.some(line => line.includes('opaque card backdrop'))).toBe(true))
    onEvent({ textEvent: { eventType: OsEventTypeList.CLICK_EVENT } } as EvenHubEvent)
    expect(bridge.audioControl).not.toHaveBeenCalled()
    onEvent({ textEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } } as EvenHubEvent)
    await running
    expect(report.at(-1)).toContain('Session display restored. Test stopped.')
    expect(phone.recordInput).toHaveBeenCalledTimes(2)
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledOnce()
  })
  it('does not prefill a production package from a baked environment URL', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_DEFAULT_BRIDGE_URL', DEFAULT_URL)
    vi.stubGlobal('window', {
      location: { search: `?t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}` },
    })
    const bridge = {
      getLocalStorage: vi.fn().mockResolvedValue(null),
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValue(true),
      onEvenHubEvent: vi.fn(() => vi.fn()),
    }
    const phone = companion()
    const { EvenT3App } = await import('./app')
    const app = new EvenT3App(bridge as unknown as EvenAppBridge, phone)

    await app.start()

    expect(bridge.getLocalStorage).toHaveBeenCalledTimes(1)
    expect(bridge.getLocalStorage).toHaveBeenCalledWith('t3-code-bridge.connection.v2')
    expect(phone.setProfile).toHaveBeenCalledTimes(1)
    expect(phone.setProfile).toHaveBeenCalledWith({ url: '', token: '' })
  })

  it('prefills the validated QR URL before storage or glasses initialization can stall', async () => {
    vi.stubEnv('VITE_DEFAULT_BRIDGE_URL', DEFAULT_URL)
    vi.stubGlobal('window', {
      location: { search: `?t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}` },
    })
    const storage = deferred<string | null>()
    const bridge = {
      getLocalStorage: vi.fn(() => storage.promise),
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValue(true),
      onEvenHubEvent: vi.fn(() => vi.fn()),
    }
    const phone = companion()
    const { EvenT3App } = await import('./app')
    const app = new EvenT3App(bridge as unknown as EvenAppBridge, phone)

    const starting = app.start()

    expect(phone.setProfile).toHaveBeenCalledTimes(1)
    expect(phone.setProfile).toHaveBeenLastCalledWith({ url: DEFAULT_URL, token: '' })
    expect(bridge.getLocalStorage).toHaveBeenCalledTimes(1)
    expect(bridge.getLocalStorage).toHaveBeenCalledWith('t3-code-bridge.connection.v1')
    expect(bridge.createStartUpPageContainer).not.toHaveBeenCalled()

    storage.resolve(null)
    await starting
    expect(bridge.getLocalStorage).toHaveBeenCalledTimes(1)
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1)
  })

  it('resolves the stored token once and updates the companion before glasses initialization', async () => {
    vi.stubEnv('VITE_DEFAULT_BRIDGE_URL', DEFAULT_URL)
    vi.stubGlobal('window', {
      location: { search: `?t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}` },
    })
    const displayCreation = deferred<StartUpPageCreateResult>()
    const token = 'abcdefghijklmnopqrstuvwxyzABCDEF'
    const bridge = {
      getLocalStorage: vi.fn().mockResolvedValue(JSON.stringify({
        url: 'ws://127.0.0.1:8787/v1/events',
        token,
      })),
      createStartUpPageContainer: vi.fn(() => displayCreation.promise),
      onEvenHubEvent: vi.fn(() => vi.fn()),
    }
    const phone = companion()
    const { EvenT3App } = await import('./app')
    const app = new EvenT3App(bridge as unknown as EvenAppBridge, phone)

    void app.start()
    await vi.waitFor(() => expect(bridge.createStartUpPageContainer).toHaveBeenCalledTimes(1))

    expect(bridge.getLocalStorage).toHaveBeenCalledTimes(1)
    expect(phone.setProfile).toHaveBeenNthCalledWith(1, { url: DEFAULT_URL, token: '' })
    expect(phone.setProfile).toHaveBeenNthCalledWith(2, { url: DEFAULT_URL, token })
  })
})
