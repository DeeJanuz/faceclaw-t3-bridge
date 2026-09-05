import { type OsEventTypeList, waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { EvenT3App } from './app'
import { dashboardModules } from './dashboard-config'
import { mountCompanionUi, type PairingRequest } from './companion-ui'

let app: EvenT3App | null = null
let pendingPairing: PairingRequest | null = null

const companion = mountCompanionUi(
  async (request) => {
    if (!app) {
      pendingPairing = request
      return
    }
    try {
      await app.pairAndConnect(request)
    } catch (error) {
      companion.setConnectionStatus('error', error instanceof Error ? error.message : String(error))
    }
  },
  (eventType: OsEventTypeList) => app?.simulateInput(eventType),
  async (selection, report, signal) => {
    if (!app) throw new Error('Glasses display not ready')
    await app.runDisplayDiagnostics(selection, report, signal)
  },
  {
    setPhoneAppEnabled: async (packageName, enabled) => { if (!app) throw new Error('App not ready'); await app.setPhoneAppEnabled(packageName, enabled) },
    createPhonePairing: async () => { if (!app) throw new Error('App not ready'); return app.createPhonePairing() },
    save: async settings => {
      if (!app) throw new Error('App not ready')
      await app.saveSettings(settings)
    },
    reload: async () => { await app?.refreshSettingsUi() },
    searchLocations: async query => {
      if (!app) throw new Error('App not ready')
      return app.searchWeatherLocations(query)
    },
    askAssistant: () => app?.requestAssistant(),
    createTestNotifications: async () => {
      if (!app) throw new Error('App not ready')
      await app.createTestNotifications()
    },
  },
)

try {
  const bridge = await waitForEvenAppBridge()
  app = new EvenT3App(bridge, companion, dashboardModules)
  await app.start()
  companion.setDiagnosticsReady()
  if (pendingPairing) {
    const request = pendingPairing
    pendingPairing = null
    await app.pairAndConnect(request)
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  companion.setConnectionStatus('error', message)
  companion.setMirror('T3 CODE • ERROR', message)
}

window.addEventListener('beforeunload', () => app?.cleanup())
