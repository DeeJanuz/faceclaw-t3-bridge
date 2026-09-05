import { notificationPreview } from './notification-preview'
import { OS_FULL, OS_NOTIFICATION, OS_NOTIFICATION_CLOSED, OS_READER_CLOSED, homeFocusRect, type OsMotion } from './os-layout'
import { createPhoneCommandId, type PhoneSnapshot, type PhoneNotification } from './phone-protocol'
import {
  AudioInputSource,
  OsEventTypeList,
  type EvenAppBridge,
  type EvenHubEvent,
} from '@evenrealities/even_hub_sdk'
import { T3BridgeClient } from './bridge-client'
import { transcriptChangedThreadId } from './bridge-events'
import type { CompanionUi, ConnectionProfile, PairingRequest } from './companion-ui'
import {
  developmentBridgeUrlFromQuery,
  exchangePairingPassphrase,
  normalizeBridgeWebSocketUrl,
  selectConnectionProfile,
} from './connection-profile'
import { DASHBOARD_READER_BOX, GlassesDisplay, voiceOverlay, type GlassesFrame } from './glasses-display'
import { inputCode, inputLabel, inputTypeFromEvenHubEvent } from './input-events'
import { runIntegratedDisplayTests, type DisplayTestSelection } from './display-diagnostics'
import { ASK_ASSISTANT_MENU_ID, SETTLE_SESSION_MENU_ID, emptyNotifications, fitLines, markSessionRead, notificationCards, notificationStorageKey, parseNotifications, parseSessionsSnapshot, reconcileNotifications, type DashboardCard } from './dashboard'
import { dashboardClock } from './dashboard-clock'
import { DashboardRegistry, type DashboardModule } from './dashboard-modules'
import { defaultDashboardSettings, loadDashboardSettings, parseDashboardSettings, parseWeatherLocation, saveDashboardSettings, validateAssistantSelection, type DashboardSettings } from './dashboard-settings'
import { WeatherController } from './weather'
import { DeviceStatusController } from './device-status'
import { PlanFlow, PLAN_NEXT_MENU_ID, PLAN_PREVIOUS_MENU_ID, PLAN_REVIEW_MENU_ID } from './plan-flow'
import { BridgeRequestError } from './protocol'
import { loadPlanDraft, savePlanDraft, clearPlanDraft, parsePendingPlanInput, validatePlanDraftAnswers } from './plan-drafts'
import type {
  ProjectSummary,
  SessionSummary,
  ModelSummary,
  NewSessionModelSelection,
  SessionsListResult,
  TranscriptResult,
  VoiceTarget,
} from './protocol'
import {
  buildModelRows,
  buildReasoningRows,
  ACTIVITY_PULSE_FRAME_COUNT,
  defaultModelKey,
  defaultReasoningId,
  extractActiveActivityLine,
  buildSessionRows,
  buildProjectRows,
  firstSelectableKey,
  freezeSessionOrder,
  moveSelection,
  modelKey,
  paginateText,
  paginateMessageText,
  paginateTranscriptWithLiveTurn,
  renderActivityPulse,
  renderMenu,
  retainTranscriptPage,
  selectedValue,
  selectResponsePage,
  transcriptPageHeader,
  type MenuRow,
  type TranscriptPage,
} from './view-model'

// v2 intentionally leaves the previously auto-seeded production profile
// untouched and unread. This forces one clean manual pairing after upgrade
// without deleting unrelated or rollback-compatible Even Hub storage. Keep the
// development key stable so the local QR workflow retains its saved token.
const PROFILE_KEY = import.meta.env.DEV
  ? 't3-code-bridge.connection.v1'
  : 't3-code-bridge.connection.v2'
// Production packages intentionally have no seeded endpoint. A user must enter
// the exact URL printed by `npm run connection-info`, unless Even Hub already
// holds a valid saved profile. Development keeps its strictly validated seed
// for the explicit QR bootstrap flow.
const DEFAULT_BRIDGE_URL = import.meta.env.DEV
  ? (import.meta.env.VITE_DEFAULT_BRIDGE_URL ?? 'ws://127.0.0.1:8787/v1/events')
  : ''
const TRANSCRIPT_BOX = { width: 544, height: 216 }
const ACTIVITY_PULSE_INTERVAL_MS = 420
const DEV_BRIDGE_URL = import.meta.env.DEV ? import.meta.env.VITE_BRIDGE_URL : undefined
const DEV_BRIDGE_TOKEN = import.meta.env.DEV ? import.meta.env.VITE_BRIDGE_TOKEN : undefined

type AppVoiceTarget = VoiceTarget | { kind: 'phone'; key: string }
const DISMISS_PHONE_MENU_ID = 7

type ScreenKind =
  | 'phone-reader'
  | 'phone-cancelled'
  | 'setup'
  | 'dashboard'
  | 'notifications'
  | 'dashboard-reader'
  | 'sessions'
  | 'projects'
  | 'models'
  | 'reasoning'
  | 'new-session'
  | 'transcript'
  | 'plan'
  | 'assistant-preparing'
  | 'dictating'
  | 'finalizing'
  | 'draft'
  | 'sending'
  | 'error'

interface DictationState {
  target: AppVoiceTarget
  returnScreen: 'new-session' | 'transcript' | 'assistant' | 'plan' | 'notifications'
  startedAt: number
  maxBytes: number
  sentBytes: number
  partialText: string
  previewError: boolean
}

interface VoiceDraftState {
  target: AppVoiceTarget
  returnScreen: DictationState['returnScreen']
  text: string
  pages: string[]
  page: number
}

interface AssistantOrigin {
  screen: ScreenKind
  transcript: TranscriptResult | null
  pages: TranscriptPage[]
  page: number
  responseBaseline: Set<string> | null
  transcriptReturn: 'sessions' | 'projects' | 'dashboard' | 'notifications'
  previous: AssistantOrigin | null
}

export class EvenT3App {
  private readonly display: GlassesDisplay
  private client: T3BridgeClient | null = null
  private unsubscribeBridgeEvent: (() => void) | null = null
  private screen: ScreenKind = 'setup'
  private phone: PhoneSnapshot = { connected: false, permissionGranted: false, apps: [], notifications: [] }
  private phoneDismissal: { key: string } | null = null
  private phoneKey: string | null = null
  private phonePage = 0
  private arrivalBanner: string | undefined
  private bannerTimer: number | undefined
  private phoneResetGeneration = 0
  private sessions: SessionsListResult | null = null
  private sessionRows: MenuRow[] = []
  private projectRows: MenuRow[] = []
  private projectSelection: string | null = null
  private projectsReturn: 'sessions' | 'dashboard' = 'dashboard'
  private sessionSelection: string | null = null
  private projects: ProjectSummary[] = []
  private selectedProject: ProjectSummary | null = null
  private models: ModelSummary[] = []
  private modelRows: MenuRow[] = []
  private modelSelection: string | null = null
  private selectedModel: ModelSummary | null = null
  private reasoningRows: MenuRow[] = []
  private reasoningSelection: string | null = null
  private selectedReasoning: string | null = null
  private transcript: TranscriptResult | null = null
  private transcriptPages: TranscriptPage[] = [{
    text: 'Loading...',
    speakerLabel: 'T3',
    messageId: '',
    role: 'assistant',
    streaming: false,
    messageUpdatedAt: '',
    activeActivity: null,
    turnNumber: 0,
    turnCount: 0,
    durationLabel: '',
  }]
  private transcriptPage = 0
  private planFlow: PlanFlow | null = null
  private readonly planFlows = new Map<string, PlanFlow>()
  private planPollTimer: number | null = null
  private activityPulseFrame = 0
  private activityPulseTimer: number | null = null
  private activityPulseWritePending = false
  private responseBaselineMessageIds: Set<string> | null = null
  private dictation: DictationState | null = null
  private voiceDraft: VoiceDraftState | null = null
  private lastGlassesFrame: GlassesFrame = { header: 'T3 CODE', body: '' }
  private voiceBackgroundFrame: GlassesFrame | null = null
  private dictationTimer: number | null = null
  private voicePartialTimer: number | null = null
  private transcriptRefreshTimer: number | null = null
  private transcriptRefreshQueued = false
  private transcriptRefreshDirty = false
  private transcriptRefreshGeneration = 0
  private eventQueue: Promise<void> = Promise.resolve()
  private unsubscribeEvenEvents: (() => void) | null = null
  private displayTestController: AbortController | null = null
  private settings: DashboardSettings = defaultDashboardSettings()
  private endpoint = ''
  private endpointGeneration = 0
  private notifications = emptyNotifications()
  private latestSessions: SessionsListResult | null = null
  private cards: DashboardCard[] = []
  private readonly dashboards: DashboardRegistry
  private dashboardReader: { title: string; pages: string[]; page: number; returnTo?: 'notifications' } | null = null
  private dashboardSelection = 'assistant'
  private dashboardTimer: number | null = null
  private connectionLabel = 'Connecting'
  private notificationWrites: Promise<void> = Promise.resolve()
  private assistantOrigin: AssistantOrigin | null = null
  private testNotifications: DashboardCard[] = []
  private testNotificationBatch = 0
  private motionSequence = 0
  private notificationSelection = ''
  private notificationItems: DashboardCard[] = []
  private transcriptReturn: 'sessions' | 'projects' | 'dashboard' | 'notifications' = 'sessions'
  private settlementPending = false
  private assistantOpening = false
  private assistantSetupMessage: string | null = null
  private settingsSaving = false
  private pairing = false
  private closed = false
  private readonly weather: WeatherController
  private readonly deviceStatus: DeviceStatusController

  constructor(
    private readonly evenBridge: EvenAppBridge,
    private readonly companion: CompanionUi,
    dashboardModules: readonly DashboardModule[] = [],
  ) {
    this.dashboards = new DashboardRegistry(dashboardModules)
    this.display = new GlassesDisplay(evenBridge)
    this.deviceStatus = new DeviceStatusController(evenBridge)
    this.weather = new WeatherController({
      getAppLocation: options => this.evenBridge.getAppLocation(options),
      requestCurrent: coordinates => this.requireClient().request('weather.current', coordinates),
    })
  }

  async start(): Promise<void> {
    const explicitDevelopmentUrl = import.meta.env.DEV
      ? developmentBridgeUrlFromQuery(window.location.search, true, DEFAULT_BRIDGE_URL)
      : null
    if (explicitDevelopmentUrl !== null) {
      // Fill the phone form before any glasses SDK call can stall or fail.
      // The token remains empty until the one stored-profile read validates it.
      this.companion.setProfile({ url: explicitDevelopmentUrl, token: '' })
    }
    const profile = await this.loadProfile(explicitDevelopmentUrl)
    if (this.closed) return
    this.companion.setProfile(profile)
    await this.display.create()
    if (this.closed) return
    this.deviceStatus.start(() => {
      if (this.screen === 'dashboard') void this.renderDashboard().catch(() => undefined)
    })
    this.unsubscribeEvenEvents = this.evenBridge.onEvenHubEvent((event) => this.onEvenEvent(event))
    if (!profile.token) {
      await this.showSetup()
      return
    }
    await this.connect(profile)
  }

  async pairAndConnect(request: PairingRequest): Promise<void> {
    if (this.closed) return
    if (this.pairing) throw new Error('Pairing is already in progress.')
    if (this.voiceFlowBusy()) throw new Error('Finish or cancel dictation before changing bridges.')
    this.pairing = true
    const generation = this.endpointGeneration
    try {
      this.companion.setConnectionStatus('connecting', 'Pairing')
      const url = normalizeBridgeWebSocketUrl(request.url)
      const token = await exchangePairingPassphrase(url, request.passphrase)
      if (generation !== this.endpointGeneration || this.closed) return
      if (this.voiceFlowBusy()) throw new Error('Finish or cancel dictation before changing bridges.')
      const profile = { url, token }
      const saved = await this.evenBridge.setLocalStorage(PROFILE_KEY, JSON.stringify(profile))
      if (generation !== this.endpointGeneration || this.closed) return
      if (!saved) throw new Error('Even Hub could not save the bridge profile')
      await this.connect(profile)
    } finally { this.pairing = false }
  }

  simulateInput(eventType: OsEventTypeList): void {
    this.companion.recordInput(
      inputLabel(eventType),
      `${inputCode(eventType)} | phone test | screen ${this.screen}`,
    )
    this.routeInput(eventType)
  }

  async runDisplayDiagnostics(selection: DisplayTestSelection, report: (line: string) => void, signal: AbortSignal): Promise<void> {
    if (this.displayTestController) throw new Error('Display test already running')
    const controller = new AbortController()
    this.displayTestController = controller
    const stop = () => controller.abort()
    signal.addEventListener('abort', stop, { once: true })
    if (signal.aborted) stop()
    try {
      // Let an already-routed gesture finish before taking over the display.
      await this.eventQueue
      if (['dictating', 'finalizing', 'draft', 'sending'].includes(this.screen)) {
        report('Not started: finish or cancel dictation before running a display test.')
        return
      }
      await runIntegratedDisplayTests(this.display, this.evenBridge, selection, report, controller.signal)
    } finally {
      signal.removeEventListener('abort', stop)
      this.displayTestController = null
    }
  }

  cleanup(): void {
    this.closed = true
    this.phoneDismissal = null
    window.clearTimeout(this.bannerTimer)
    this.phoneResetGeneration += 1
    this.endpointGeneration += 1
    if (this.dashboardTimer !== null) window.clearInterval(this.dashboardTimer)
    this.dashboardTimer = null
    this.weather.reset()
    this.deviceStatus.stop()
    this.displayTestController?.abort()
    if (this.dictationTimer !== null) window.clearInterval(this.dictationTimer)
    if (this.voicePartialTimer !== null) window.clearTimeout(this.voicePartialTimer)
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    this.stopPlanPoll()
    this.planFlows.clear()
    this.planFlow = null
    void this.evenBridge.audioControl(false)
    this.unsubscribeEvenEvents?.()
    this.unsubscribeBridgeEvent?.()
    this.client?.close()
    this.client = null
    this.dictation = null
    this.voiceDraft = null
    this.screen = 'setup'
  }

  private async connect(profile: ConnectionProfile): Promise<void> {
    if (this.closed) return
    if (this.voiceFlowBusy()) throw new Error('Finish or cancel dictation before changing bridges.')
    this.endpointGeneration += 1
    this.endpoint = normalizeBridgeWebSocketUrl(profile.url)
    this.stopPlanPoll()
    this.planFlow = null
    this.planFlows.clear()
    const generation = this.endpointGeneration
    const endpoint = this.endpoint
    this.screen = 'setup'
    this.assistantOrigin = null
    this.assistantSetupMessage = null
    this.sessions = null
    this.sessionRows = []
    this.projectRows = []
    this.projectSelection = null
    this.latestSessions = null
    this.notifications = emptyNotifications()
    this.testNotifications = []
    this.weather.reset()
    this.connectionLabel = 'Connecting'
    this.unsubscribeBridgeEvent?.()
    this.client?.close()
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    const client = new T3BridgeClient(endpoint, profile.token)
    this.client = client
    const current = () => !this.closed && generation === this.endpointGeneration && this.client === client
    this.companion.setConnectionStatus('connecting', 'Connecting')
    try {
      await this.show({ header: 'T3 CODE', body: 'Connecting to your Mac...' })
      if (!current()) return
      await client.connect()
      if (!current()) { client.close(); return }
      const settings = await loadDashboardSettings(this.evenBridge, endpoint)
      if (!current()) return
      this.settings = settings
      try {
        const stored = await this.evenBridge.getLocalStorage(notificationStorageKey(endpoint))
        if (!current()) return
        this.notifications = parseNotifications(stored)
      } catch { if (current()) this.notifications = emptyNotifications() }
      if (!current()) return
      this.unsubscribeBridgeEvent = client.onEvent((event) => { if (current()) this.onBridgeEvent(event.event, event.payload) })
      this.companion.setConnectionStatus('connected', 'Connected')
      this.connectionLabel = 'Connected'
      await this.refreshPhone()
      void client.request('sessions.list').then(sessions => { if (current()) this.acceptSessions(sessions) }).catch(() => undefined)
      await this.openDashboard()
      if (!current()) return
      void this.refreshSettingsUi()
      if (this.dashboardTimer === null) this.dashboardTimer = window.setInterval(() => {
        if (this.screen !== 'dashboard') return
        if (!this.client?.connected) this.connectionLabel = 'Disconnected'
        void this.renderDashboard().catch(() => undefined)
        void this.refreshWeather()
      }, 60_000)
    } catch (error) {
      if (!current()) return
      this.companion.setConnectionStatus('error', errorMessage(error))
      await this.showSetup(errorMessage(error))
    }
  }

  async refreshPhone(): Promise<void> {
    try { await this.acceptPhone(await this.requireClient().request('phone.notifications.list'), false) }
    catch { await this.acceptPhone({ ...this.phone, connected: false }, false) }
  }

  async setPhoneAppEnabled(packageName: string, enabled: boolean): Promise<void> {
    await this.acceptPhone(await this.requireClient().request('phone.apps.setEnabled', { packageName, enabled }), false)
  }

  async createPhonePairing(): Promise<string> {
    const result = await this.requireClient().request('phone.pairing.create')
    return `Pairing code: ${result.code}. Enter it in the Android companion within five minutes.`
  }

  private async acceptPhone(snapshot: PhoneSnapshot, announce = true): Promise<void> {
    if (this.closed) return
    const previous = this.phone
    this.phone = snapshot
    if (!snapshot.connected) this.phoneDismissal = null
    this.companion.setPhoneSettings?.(snapshot)
    const active = this.phoneKey && (this.screen === 'phone-reader' || this.dictation?.target.kind === 'phone' || this.voiceDraft?.target.kind === 'phone')
    const selected = snapshot.notifications.find(item => item.key === this.phoneKey)
    if (active && (!snapshot.connected || (!selected && this.screen !== 'sending' && this.phoneDismissal?.key !== this.phoneKey))) {
      const reset = ++this.phoneResetGeneration
      this.phoneDismissal = null
      this.stopDictationTimer()
      this.dictation = null
      this.voiceDraft = null
      this.voiceBackgroundFrame = null
      this.phoneKey = null
      this.screen = snapshot.connected ? 'phone-cancelled' : 'notifications'
      void this.evenBridge.audioControl(false).catch(() => undefined)
      void this.client?.request('voice.cancel').catch(() => undefined)
      if (snapshot.connected) {
        await this.show({ header: 'Cancelled', body: 'Notification no longer available' })
        await new Promise(resolve => window.setTimeout(resolve, 1000))
        if (reset !== this.phoneResetGeneration || this.closed) return
      }
      await this.openNotifications(true)
      return
    }
    const arrived = announce && previous.connected && snapshot.connected
      ? snapshot.notifications.find(item => previous.notifications.find(old => old.key === item.key)?.revision !== item.revision) : undefined
    if (arrived) {
      this.arrivalBanner = `${fitLines(arrived.appName, 512, 1)}\n${notificationPreview(arrived.title || arrived.sender || arrived.thread || '', arrived.text)}`
      window.clearTimeout(this.bannerTimer)
      this.bannerTimer = window.setTimeout(() => { this.bannerTimer = undefined; this.arrivalBanner = undefined; if (!this.closed) void this.show(this.lastGlassesFrame) }, 3000)
    }
    if (selected && active) {
      this.voiceBackgroundFrame = { ...this.phoneReaderFrame(selected),
        dashboardSurface: this.voiceBackgroundFrame?.dashboardSurface ?? this.lastGlassesFrame.dashboardSurface }
      if (this.screen === 'phone-reader') await this.renderPhoneReader()
      else if (this.screen === 'dictating') await this.renderDictation()
      else if (this.screen === 'draft') await this.renderVoiceDraft()
    } else await this.refreshDashboards()
    if (arrived) await this.show(this.lastGlassesFrame)
  }

  private phoneReaderFrame(item: PhoneNotification): GlassesFrame {
    const pages = paginateMessageText(item.text, { width: DASHBOARD_READER_BOX.width, height: DASHBOARD_READER_BOX.height - 27 })
    this.phonePage = Math.min(this.phonePage, pages.length - 1)
    return { header: `${fitLines(`${item.appName} · ${item.sender ?? item.thread ?? item.title}`, 440, 1)} ${this.phonePage + 1}/${pages.length}`,
      body: `${new Date(item.arrivedAt).toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}\n${pages[this.phonePage] ?? ''}\n${this.phone.connected ? '' : 'Phone disconnected'}` }
  }

  private async renderPhoneReader(): Promise<void> {
    const item = this.phone.notifications.find(item => item.key === this.phoneKey)
    if (item) await this.show(this.phoneReaderFrame(item))
    else await this.openNotifications(true)
  }

  private async sendPhoneDraft(): Promise<void> {
    const draft = this.voiceDraft
    const item = this.phone.notifications.find(item => item.key === this.phoneKey)
    if (!draft || !item || !this.phone.connected || !draft.text.trim()) return
    this.screen = 'sending'
    await this.showVoiceState(draft.target, 'SENDING REPLY', draft.pages[draft.page] ?? draft.text)
    try {
      const result = await this.requireClient().request('phone.notifications.reply', { key: item.key, revision: item.revision, text: draft.text, commandId: createPhoneCommandId() })
      if (this.voiceDraft !== draft) return
      if (result.status === 'handed_off') {
        this.voiceDraft = null
        this.phoneKey = null
        this.voiceBackgroundFrame = null
        await this.refreshPhone()
        await this.openNotifications(true)
      } else if (result.status === 'unavailable') {
        this.screen = 'draft'
        await this.refreshPhone()
        if (this.voiceDraft === draft) await this.showError('Reply unavailable. Draft kept; check phone.', 'draft')
      }
      else await this.showError(result.status === 'unknown' ? 'Send status unknown; check phone. Draft kept.' : 'Reply failed. Draft kept.', 'draft')
    } catch (error) {
      if (this.voiceDraft === draft) await this.showError(error instanceof BridgeRequestError && error.code === 'phone_command_expired' ? `${error.message} Draft kept.` : 'Send status unknown; check phone. Draft kept.', 'draft')
    }
  }

  private async dismissPhone(): Promise<void> {
    const key = this.screen === 'phone-reader' ? this.phoneKey : this.screen === 'notifications' ? this.notificationItems.find(item => item.key === this.notificationSelection)?.action : null
    const notificationKey = typeof key === 'string' ? key : key?.kind === 'phone' ? key.key : null
    const item = this.phone.notifications.find(item => item.key === notificationKey)
    if (!item || !this.phone.connected) return
    if (this.phoneDismissal) return
    const pending = { key: item.key }
    this.phoneDismissal = pending
    try {
      const result = await this.requireClient().request('phone.notifications.dismiss', { key: item.key, revision: item.revision, commandId: createPhoneCommandId() })
      if (this.phoneDismissal !== pending) return
      this.phoneDismissal = null
      if (result.status === 'dismissed') { this.phoneKey = null; await this.refreshPhone(); await this.openNotifications(true) }
      else await this.showError('Dismissal not confirmed. Check phone.', 'notifications')
    } catch {
      if (this.phoneDismissal === pending) { this.phoneDismissal = null; await this.showError('Dismissal not confirmed. Check phone.', 'notifications') }
    }
  }

  private notificationStorageKey(): string {
    return notificationStorageKey(this.endpoint)
  }

  private persistNotifications(): void {
    const key = this.notificationStorageKey()
    const value = JSON.stringify({ version: 1, ...this.notifications })
    const generation = this.endpointGeneration
    this.notificationWrites = this.notificationWrites.then(async () => {
      if (!await this.evenBridge.setLocalStorage(key, value)) throw new Error('Alerts could not be saved')
    }).catch(() => {
      if (generation === this.endpointGeneration) this.companion.setSettingsStatus?.('Alerts work for this session, but their read state could not be saved.')
    })
  }

  private acceptSessions(snapshot: SessionsListResult): void {
    const parsed = parseSessionsSnapshot(snapshot)
    if (!parsed) return
    snapshot = parsed
    if (this.latestSessions && Number(snapshot.snapshotId) < Number(this.latestSessions.snapshotId)) return
    this.latestSessions = snapshot
    this.notifications = reconcileNotifications(this.notifications, snapshot)
    if (this.screen === 'transcript' && this.transcript) {
      const viewed = [...snapshot.unsettled, ...snapshot.settled].find(session => session.id === this.transcript!.session.id)
      if (viewed) this.notifications = markSessionRead(this.notifications, viewed)
    }
    this.persistNotifications()
    this.connectionLabel = 'Connected'
    // Live notification views share one reconciliation path. The session
    // browser and active reading/voice flows keep their own stable state.
    void this.refreshDashboards().catch(() => undefined)
  }

  private async openDashboard(preserveSelection = false): Promise<void> {
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    this.screen = 'dashboard'
    if (!preserveSelection) this.dashboardSelection = 'assistant'
    this.rebuildDashboardCards()
    await this.renderDashboard()
    void this.refreshWeather()
  }

  async createTestNotifications(): Promise<void> {
    if (this.closed || !this.client?.connected) throw new Error('Connect before adding test notifications.')
    const batch = ++this.testNotificationBatch
    const examples = [
      ['Short response', 'Your sample task is complete.'],
      ['A longer notification title to check wrapping across the alert card', 'This sample response exercises notification titles and text wrapping.'],
      ['Multi-page response', 'A longer sample response.\n\n' + 'This is synthetic notification content for checking pagination and return navigation. '.repeat(18)],
    ]
    const cards: DashboardCard[] = examples.map(([title, text], index) => ({
      key: `test:${batch}:${index}`, title: 'Awaiting input',
      notification: { label: fitLines(`TX - TEST ${index + 1}: ${title}`, 252, 1), completedAt: new Date(Date.now() - index).toISOString() },
      body: `Awaiting input\n${fitLines(`TX - TEST ${index + 1}: ${title}`, 252, 1)}`,
      action: { kind: 'reader', title: `TEST NOTIFICATION ${index + 1}`, text: `TEST ONLY\n\n${text}` },
    }))
    this.testNotifications = [...cards, ...this.testNotifications].slice(0, 50)
    await this.refreshDashboards()
  }

  private allNotificationCards(): DashboardCard[] {
    return [...this.phone.notifications.map((item): DashboardCard => ({ key: `phone:${item.key}`, title: item.appName, body: item.text, action: { kind: 'phone', key: item.key }, notification: { label: fitLines(`${item.appName} ${item.sender ?? item.thread ?? item.title}`, 252, 1), completedAt: new Date(item.arrivedAt).toISOString() } })), ...this.testNotifications, ...notificationCards(this.notifications,
      this.latestSessions ? [...this.latestSessions.unsettled, ...this.latestSessions.settled] : [], this.projects)]
      .sort((a, b) => (b.notification?.completedAt ?? '').localeCompare(a.notification?.completedAt ?? ''))
  }

  private async openNotifications(preserveSelection = false): Promise<void> {
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    this.screen = 'notifications'
    this.dashboardSelection = 'notifications'
    this.notificationItems = this.allNotificationCards()
    this.rebuildDashboardCards()
    if (!preserveSelection || !this.notificationItems.some(card => card.key === this.notificationSelection)) this.notificationSelection = this.notificationItems[0]?.key ?? ''
    await this.renderNotifications(!preserveSelection)
  }

  private async renderNotifications(enter = false): Promise<void> {
    const index = Math.max(0, this.notificationItems.findIndex(item => item.key === this.notificationSelection))
    const card = this.notificationItems[index]
    const phoneKey = card?.action.kind === 'phone' ? card.action.key : undefined
    const phone = this.phone.notifications.find(item => item.key === phoneKey)
    const time = card ? new Date(card.notification?.completedAt ?? 0).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true }) : ''
    const source = phone?.appName ?? 'T3 Code Assistant'
    const subject = phone?.title || phone?.sender || phone?.thread || card?.notification?.label || card?.title || ''
    const message = phone?.text ?? (card?.action.kind === 'reader' ? card.action.text.replace(/^TEST ONLY\s+/, '') : card?.action.kind === 'alert' ? 'A response is ready.' : card?.body ?? '')
    const body = card ? notificationPreview(subject, message) : ''
    await this.show({ ...this.dashboardFrame(), card: { title: card ? fitLines(source, 280, 1) : 'Notifications (0)', meta: card ? `${time}  ${index + 1}/${this.notificationItems.length}` : '',
      body: body || 'No pending notifications.',
      placement: 'dashboard', presentation: 'notifications', entrance: enter ? 'down' : undefined,
      transition: enter ? ++this.motionSequence : undefined }, menuItems: [] })
  }

  private async returnFromNotification(): Promise<void> {
    this.dashboardSelection = 'notifications'
    await this.openNotifications(true)
  }

  private clearSessionNotifications(session: Pick<SessionSummary, 'id' | 'completedTurn'>): void {
    const updated = markSessionRead(this.notifications, session)
    if (updated === this.notifications) return
    this.notifications = updated
    this.persistNotifications()
    this.rebuildDashboardCards()
  }

  private async renderDashboard(): Promise<void> {
    await this.show(this.dashboardFrame())
  }

  private dashboardFrame(): GlassesFrame {
    const now = new Date()
    const clock = dashboardClock(now)
    const card = this.cards.find(item => item.key === this.dashboardSelection) ?? this.cards[0]
    const actionCards = this.cards.filter(item => ['assistant', 'sessions', 'notifications'].includes(item.key))
    const detail = card && !actionCards.includes(card)
    const message = card?.action.kind === 'assistant' ? this.assistantSetupMessage : null
    const weather = this.weather.display(this.settings.weather)
    const left = [
      `${clock.hour}:${clock.minute} ${clock.period}`,
      now.toLocaleDateString([], { month: 'short', day: 'numeric' }),
      ...weather.lines.flatMap(line => fitLines(line, 184, 2).split('\n')).slice(0, 4),
      fitLines(this.connectionLabel, 184, 1),
    ].join('\n')
    return {
      header: detail ? card.title : 'HOME',
      body: fitLines(message ?? (detail ? card.body : ''), 288, 2),
      dashboard: { left, actions: (detail ? [card] : actionCards).map(item => ({ key: item.key, label: item.title, selected: item.key === this.dashboardSelection,
        previews: detail ? [fitLines(card.body, 268, 4)] : undefined })), panel: {
        ...clock,
        date: `${now.toLocaleDateString([], { weekday: 'short' })} ${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`,
        batteryPercent: this.deviceStatus.batteryPercent, connection: this.connectionLabel,
        weather: weather.lines, unread: this.notifications.unread.length + this.testNotifications.length + this.phone.notifications.length,
      } },
    }
  }

  private rebuildDashboardCards(): void {
    this.cards = this.dashboards.cards({ notifications: this.notifications, testNotificationCount: this.testNotifications.length + this.phone.notifications.length,
      sessions: this.latestSessions ? [...this.latestSessions.unsettled, ...this.latestSessions.settled] : [] })
    if (!this.cards.some(card => card.key === this.dashboardSelection)) this.dashboardSelection = 'assistant'
  }

  /** Data controllers call this after publishing a new snapshot; active readers and voice flows stay put. */
  async refreshDashboards(): Promise<void> {
    if (this.closed) return
    this.rebuildDashboardCards()
    if (this.screen === 'dashboard') await this.renderDashboard()
    else if (this.screen === 'notifications') {
      const oldIndex = this.notificationItems.findIndex(card => card.key === this.notificationSelection)
      this.notificationItems = this.allNotificationCards()
      if (!this.notificationItems.some(card => card.key === this.notificationSelection)) {
        this.notificationSelection = this.notificationItems[Math.min(Math.max(0, oldIndex), this.notificationItems.length - 1)]?.key ?? ''
      }
      await this.renderNotifications()
    }
  }

  private async renderDashboardReader(): Promise<void> {
    const reader = this.dashboardReader
    if (!reader) { await this.openDashboard(true); return }
    await this.show({ header: `${fitLines(reader.title, reader.returnTo === 'notifications' ? 196 : 380, 1)} | ${reader.page + 1}/${reader.pages.length}`,
      body: reader.pages[reader.page] ?? 'No content available.' })
  }

  private async refreshWeather(force = false): Promise<void> {
    const generation = this.endpointGeneration
    await this.weather.refresh(this.settings.weather, force).catch(() => undefined)
    if (generation === this.endpointGeneration && this.screen === 'dashboard') await this.renderDashboard().catch(() => undefined)
  }

  async refreshSettingsUi(): Promise<void> {
    if (this.closed || this.settingsSaving) return
    const generation = this.endpointGeneration
    try {
      const [projects, models] = await Promise.all([
        this.requireClient().request('projects.list'), this.requireClient().request('models.list'),
      ])
      if (generation !== this.endpointGeneration || this.settingsSaving) return
      this.projects = projects.projects
      this.companion.setSettings?.(this.settings, projects.projects, models.models)
    } catch {
      if (generation === this.endpointGeneration) this.companion.setSettingsStatus?.('Could not load settings choices. Reconnect and retry.')
    }
  }

  async saveSettings(settings: DashboardSettings): Promise<void> {
    if (this.closed) throw new Error('Reopen the app before saving dashboard settings.')
    if (this.settingsSaving) throw new Error('Dashboard settings are already being saved.')
    if (this.voiceFlowBusy()) throw new Error('Finish or cancel dictation before changing settings.')
    this.settingsSaving = true
    try {
      const normalized = parseDashboardSettings(settings)
      const generation = this.endpointGeneration
      const endpoint = this.endpoint
      const [projects, models] = await Promise.all([
        this.requireClient().request('projects.list'), this.requireClient().request('models.list'),
      ])
      if (settings.assistant && !validateAssistantSelection(normalized.assistant, projects.projects, models.models)) {
        throw new Error('Choose an available assistant project, model, and reasoning level.')
      }
      if (generation !== this.endpointGeneration) throw new Error('Connection changed. Reload settings.')
      if (this.voiceFlowBusy()) throw new Error('Finish or cancel dictation before changing settings.')
      if (!await saveDashboardSettings(this.evenBridge, endpoint, normalized)) throw new Error('Even Hub could not save dashboard settings.')
      if (this.closed || generation !== this.endpointGeneration) throw new Error('Connection changed. Reload settings.')
      const weatherChanged = JSON.stringify(this.settings.weather) !== JSON.stringify(normalized.weather)
      this.settings = normalized
      this.assistantSetupMessage = null
      if (weatherChanged) this.weather.reset()
      this.companion.setSettingsStatus?.('Settings saved.')
      if (this.screen === 'dashboard') void this.renderDashboard().catch(() => undefined)
      if (weatherChanged) void this.refreshWeather(true)
    } finally {
      this.settingsSaving = false
      if (this.screen === 'dashboard') void this.renderDashboard().catch(() => undefined)
    }
  }

  async searchWeatherLocations(query: string) {
    const generation = this.endpointGeneration
    const result = await this.requireClient().request('weather.locations', { query })
    if (generation !== this.endpointGeneration) throw new Error('Connection changed. Search again.')
    if (!result || !Array.isArray(result.locations) || result.locations.length > 5) throw new Error('City search unavailable.')
    return result.locations.map(parseWeatherLocation).filter((city): city is NonNullable<typeof city> => city !== null)
  }

  requestAssistant(): void {
    if (this.canAskAssistant()) this.enqueue(() => this.openAssistant())
  }

  private voiceFlowBusy(): boolean {
    return this.settlementPending || this.assistantOpening || ['dictating', 'finalizing', 'draft', 'sending'].includes(this.screen)
  }

  private canAskAssistant(): boolean {
    return !this.settingsSaving && !this.voiceFlowBusy() && this.assistantMenuAvailable()
  }

  private assistantMenuAvailable(): boolean {
    return !this.closed && !this.displayTestController && this.client?.connected === true
      && ['dashboard', 'notifications', 'dashboard-reader', 'sessions', 'projects', 'models', 'reasoning', 'new-session', 'transcript'].includes(this.screen)
  }

  private async openAssistant(): Promise<void> {
    if (!this.canAskAssistant()) return
    this.assistantOpening = true
    const generation = this.endpointGeneration
    const origin: AssistantOrigin = {
      screen: this.screen, transcript: this.transcript, pages: this.transcriptPages, page: this.transcriptPage,
      responseBaseline: this.responseBaselineMessageIds, transcriptReturn: this.transcriptReturn, previous: this.assistantOrigin,
    }
    let readyToRecord = false
    try {
      const assistant = this.settings.assistant
      if (!assistant) throw new Error('Choose your assistant project and model in phone settings.')
      this.voiceBackgroundFrame = this.lastGlassesFrame
      this.screen = 'assistant-preparing'
      this.cancelTranscriptRefresh()
      this.stopActivityPulse()
      const [projects, models] = await Promise.all([
        this.requireClient().request('projects.list'), this.requireClient().request('models.list'),
        this.show(voiceOverlay(this.voiceBackgroundFrame, 'PREPARING ASSISTANT', 'Checking project and model...')),
      ])
      if (generation !== this.endpointGeneration) return
      if (!validateAssistantSelection(assistant, projects.projects, models.models)) {
        throw new Error('Assistant selection is unavailable. Update phone settings.')
      }
      readyToRecord = true
      this.assistantSetupMessage = null
      this.assistantOrigin = origin
      this.cancelTranscriptRefresh()
      this.stopActivityPulse()
      this.transcript = null
      await this.beginDictation({ kind: 'assistant', projectId: assistant.projectId, modelSelection: assistant.modelSelection }, 'assistant')
    } catch (error) {
      if (generation === this.endpointGeneration) {
        if (!readyToRecord && origin.screen === 'dashboard') {
          this.screen = 'dashboard'
          this.assistantSetupMessage = errorMessage(error)
          await this.renderDashboard()
          return
        }
        this.assistantOrigin = origin
        await this.showError(errorMessage(error), 'assistant')
      }
    } finally { this.assistantOpening = false }
  }

  private async restoreAssistantOrigin(): Promise<void> {
    const origin = this.assistantOrigin
    if (!origin) { await this.openDashboard(); return }
    this.cancelTranscriptRefresh()
    this.assistantOrigin = origin.previous
    this.transcript = origin.transcript
    this.transcriptPages = origin.pages
    this.transcriptPage = origin.page
    this.responseBaselineMessageIds = origin.responseBaseline
    this.transcriptReturn = origin.transcriptReturn
    this.screen = origin.screen
    switch (origin.screen) {
      case 'notifications': await this.openNotifications(true); break
      case 'dashboard-reader': await this.renderDashboardReader(); break
      case 'transcript':
        await this.renderTranscript()
        if (this.transcript) this.scheduleTranscriptRefresh(this.transcript.session.id)
        break
      case 'sessions': await this.renderSessions(); break
      case 'projects': await this.renderProjects(); break
      case 'models': await this.renderModels(); break
      case 'reasoning': await this.renderReasoning(); break
      case 'new-session': await this.openNewSession(); break
      default: await this.openDashboard(true)
    }
  }

  private async openSessions(): Promise<void> {
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    this.screen = 'sessions'
    const [result, catalog] = await Promise.all([
      this.requireClient().request('sessions.list'),
      this.requireClient().request('projects.list').catch(() => ({ projects: this.projects })),
    ])
    this.acceptSessions(result)
    this.sessions = freezeSessionOrder(result)
    this.projects = catalog.projects
    this.sessionRows = buildSessionRows(this.sessions, Date.now(), this.projects)
    this.sessionSelection = firstSelectableKey(this.sessionRows)
    await this.renderSessions()
  }

  private async renderSessions(): Promise<void> {
    if (!this.sessions) return
    const menu = renderMenu(this.sessionRows, this.sessionSelection)
    await this.show({
      header: `SESSIONS | ${menu.position}/${menu.count}`,
      body: menu.body,
      menuItems: this.assistantMenuAvailable() ? [
        { itemID: ASK_ASSISTANT_MENU_ID, itemName: 'Ask assistant' },
        ...(this.settleCandidate() ? [{ itemID: SETTLE_SESSION_MENU_ID, itemName: 'Settle session' }] : []),
      ] : [],
    })
  }

  private settleCandidate(): string | null {
    if (this.settlementPending || !this.canAskAssistant()) return null
    const id = this.screen === 'sessions' ? selectedValue(this.sessionRows, this.sessionSelection)
      : this.screen === 'transcript' ? this.transcript?.session.id : null
    if (!id) return null
    if (this.screen === 'transcript' && (this.transcript?.pendingPlanInput
      || ['running', 'starting'].includes(this.transcript?.session.status ?? ''))) return null
    const session = this.latestSessions
      ? [...this.latestSessions.unsettled, ...this.latestSessions.settled].find(item => item.id === id)
      : this.transcript?.session.id === id ? this.transcript.session : undefined
    return session && !session.settled && !['running', 'starting'].includes(session.status) ? id : null
  }

  private async settleSession(threadId: string): Promise<void> {
    if (this.settleCandidate() !== threadId) return
    const generation = this.endpointGeneration
    this.settlementPending = true
    try {
      await this.requireClient().request('thread.settle', { threadId })
      if (generation !== this.endpointGeneration || this.closed) return
      // Move only the explicitly settled row; keep unrelated browsing frozen.
      if (this.sessions) {
        const all = [...this.sessions.unsettled, ...this.sessions.settled]
          .map(session => session.id === threadId ? { ...session, settled: true } : session)
        this.sessions = freezeSessionOrder({ ...this.sessions,
          unsettled: all.filter(session => !session.settled), settled: all.filter(session => session.settled) })
        this.sessionRows = buildSessionRows(this.sessions, Date.now(), this.projects)
      }
      if (this.latestSessions) {
        const all = [...this.latestSessions.unsettled, ...this.latestSessions.settled]
          .map(session => session.id === threadId ? { ...session, settled: true } : session)
        this.latestSessions = { ...this.latestSessions,
          unsettled: all.filter(session => !session.settled), settled: all.filter(session => session.settled) }
      }
      this.clearSessionNotifications({ id: threadId })
      if (this.transcript?.session.id === threadId) this.transcript.session = { ...this.transcript.session, settled: true }
    } finally { this.settlementPending = false }
    if (this.screen === 'sessions') await this.renderSessions()
    else if (this.screen === 'transcript') await this.renderTranscript()
  }

  private async returnToSessions(): Promise<void> {
    if (!this.sessions) { await this.openSessions(); return }
    this.screen = 'sessions'
    await this.renderSessions()
  }

  private async openProjects(returnTo: 'sessions' | 'dashboard' = 'dashboard'): Promise<void> {
    this.cancelTranscriptRefresh()
    this.stopActivityPulse()
    const result = await this.requireClient().request('projects.list')
    this.projects = [...result.projects].sort((left, right) => left.title.localeCompare(right.title))
    this.projectRows = buildProjectRows(this.projects)
    this.projectSelection = firstSelectableKey(this.projectRows)
    this.projectsReturn = returnTo
    this.screen = 'projects'
    await this.renderProjects()
  }

  private async renderProjects(): Promise<void> {
    const menu = renderMenu(this.projectRows, this.projectSelection)
    await this.show({ header: `PROJECTS | ${menu.position}/${menu.count}`, body: menu.body })
  }

  private async returnToProjects(): Promise<void> {
    if (!this.projectRows.length) { await this.openProjects(); return }
    this.screen = 'projects'
    await this.renderProjects()
  }

  private async openModels(projectId: string): Promise<void> {
    const project = this.projects.find((candidate) => candidate.id === projectId)
    if (!project) throw new Error('The selected project is no longer available')
    this.selectedProject = project
    const result = await this.requireClient().request('models.list')
    this.models = result.models
    this.modelRows = buildModelRows(this.models)
    this.modelSelection = defaultModelKey(this.models)
    this.selectedModel = null
    this.selectedReasoning = null
    this.screen = 'models'
    await this.renderModels()
  }

  private async renderModels(): Promise<void> {
    const menu = renderMenu(this.modelRows, this.modelSelection)
    await this.show({
      header: `MODEL | ${menu.position}/${menu.count}`,
      body: menu.body,
    })
  }

  private async openReasoning(model: ModelSummary): Promise<void> {
    this.selectedModel = model
    this.reasoningRows = buildReasoningRows(model.reasoningChoices)
    this.reasoningSelection = defaultReasoningId(model.reasoningChoices)
    this.selectedReasoning = null
    this.screen = 'reasoning'
    await this.renderReasoning()
  }

  private async renderReasoning(): Promise<void> {
    if (!this.selectedModel) return
    const menu = renderMenu(this.reasoningRows, this.reasoningSelection)
    await this.show({
      header: `REASONING | ${menu.position}/${menu.count}`,
      body: menu.body,
    })
  }

  private async openNewSession(): Promise<void> {
    const project = this.selectedProject
    const model = this.selectedModel
    if (!project || !model) throw new Error('Choose a project and model first')
    this.screen = 'new-session'
    const reasoning = model.reasoningChoices.find((choice) => choice.id === this.selectedReasoning)
    await this.show({
      header: `${project.title.toUpperCase()} | NEW SESSION`,
      body: [
        model.name,
        reasoning ? `Reasoning: ${reasoning.label}` : 'Reasoning: Provider default',
        'Speed: Normal',
      ].join('\n'),
    })
  }

  private newSessionModelSelection(): NewSessionModelSelection {
    const model = this.selectedModel
    if (!model) throw new Error('Choose a model first')
    return {
      instanceId: model.instanceId,
      model: model.model,
      ...(this.selectedReasoning ? { reasoningId: this.selectedReasoning } : {}),
    }
  }

  private async openTranscript(
    threadId: string,
    followLatest = true,
    preserveScreen = false,
  ): Promise<void> {
    const generation = this.endpointGeneration
    const previousScreen = this.screen
    const wasLastPage = this.transcriptPage === this.transcriptPages.length - 1
    const previousPages = this.transcriptPages
    const previousPage = this.transcriptPage
    const result = await this.requireClient().request('transcript.get', { threadId })
    if (generation !== this.endpointGeneration || this.closed) return
    result.pendingPlanInput = parsePendingPlanInput(result.pendingPlanInput)
    this.transcript = result
    this.transcriptPages = paginateTranscriptWithLiveTurn(
      result.turns,
      result.liveActivities ?? [],
      result.liveActivity,
      TRANSCRIPT_BOX,
    )
    const working = ['running', 'starting'].includes(result.session.status)
    if (this.responseBaselineMessageIds !== null) {
      const response = selectResponsePage(
        this.transcriptPages,
        this.responseBaselineMessageIds,
        working,
      )
      if (followLatest || wasLastPage) {
        this.transcriptPage = response.pageIndex
      } else {
        this.transcriptPage = retainTranscriptPage(
          previousPages,
          previousPage,
          this.transcriptPages,
        )
      }
      if (!working) {
        this.responseBaselineMessageIds = null
      }
    } else if (!preserveScreen && (followLatest || wasLastPage)) {
      this.transcriptPage = this.transcriptPages.length - 1
    } else {
      this.transcriptPage = retainTranscriptPage(previousPages, previousPage, this.transcriptPages)
    }
    if (!preserveScreen) this.screen = 'transcript'
    await this.reconcilePlanInput(result)
    if (generation !== this.endpointGeneration || this.closed || this.transcript !== result ||
        !['transcript', 'plan', 'dictating', 'draft'].includes(this.screen)) return
    if (this.screen === 'plan') {
      await this.renderPlan()
      this.clearSessionNotifications(result.session)
      return
    }
    if (preserveScreen && previousScreen === 'dictating' && this.dictation) {
      await this.renderDictation()
    } else if (preserveScreen && previousScreen === 'draft' && this.voiceDraft) {
      await this.renderVoiceDraft()
    } else {
      await this.renderTranscript()
      this.clearSessionNotifications(result.session)
    }
  }

  private async renderTranscript(): Promise<void> {
    const frame = this.transcriptFrame()
    if (frame) {
      await this.show(frame)
      if (this.screen === 'transcript' && this.transcript) this.clearSessionNotifications(this.transcript.session)
    }
  }

  private async reconcilePlanInput(result: TranscriptResult): Promise<void> {
    const generation = this.endpointGeneration
    const request = result.pendingPlanInput
    const previous = this.planFlow
    if (previous && (previous.threadId !== result.session.id || previous.request.revision !== request?.revision)) {
      if (previous.threadId === result.session.id) {
        this.planFlows.delete(this.planKey(previous))
        void clearPlanDraft(this.evenBridge, this.endpoint, previous.threadId, previous.request).catch(() => undefined)
      }
      this.planFlow = null
      if (this.screen === 'plan') this.screen = 'transcript'
    }
    if (request && ['transcript', 'plan'].includes(this.screen)) {
      const key = `${this.endpoint}|${result.session.id}|${request.revision}`
      let flow = this.planFlows.get(key)
      if (!flow) {
        flow = new PlanFlow(result.session.id, request)
        flow.stage = 'loading'
        this.planFlows.set(key, flow)
        if (this.planFlows.size > 12) this.planFlows.delete(this.planFlows.keys().next().value!)
        const loading = flow
        // Reading phone storage runs outside the gesture queue. A loading card
        // is inert but remains dismissible, even if the native bridge hangs.
        void loadPlanDraft(this.evenBridge, this.endpoint, result.session.id, request).then(async saved => {
          if (generation !== this.endpointGeneration || this.closed || this.planFlows.get(key) !== loading) return
          const restored = new PlanFlow(result.session.id, request, saved.answers)
          loading.answers = restored.answers
          loading.questionIndex = restored.questionIndex
          loading.stage = saved.submitted ? 'uncertain' : 'question'
          if (this.planFlow === loading && this.screen === 'plan') await this.renderPlan()
        }).catch(() => undefined)
      }
      this.planFlow = flow
      this.screen = 'plan'
      this.stopActivityPulse()
      this.startPlanPoll()
    } else if (!request) this.stopPlanPoll()
  }

  private planKey(flow: PlanFlow): string { return `${this.endpoint}|${flow.threadId}|${flow.request.revision}` }

  private startPlanPoll(): void {
    if (this.planPollTimer !== null) return
    this.planPollTimer = window.setInterval(() => {
      if (this.screen === 'plan' && this.planFlow) this.scheduleTranscriptRefresh(this.planFlow.threadId)
    }, 5000)
  }

  private stopPlanPoll(): void {
    if (this.planPollTimer !== null) window.clearInterval(this.planPollTimer)
    this.planPollTimer = null
  }

  private async renderPlan(): Promise<void> {
    const background = this.transcriptFrame()
    this.stopActivityPulse()
    if (background && this.planFlow) await this.show({ ...background, activity: undefined,
      card: this.planFlow.card(), menuItems: this.planFlow.menuItems() })
  }

  private async savePlanChoices(flow: PlanFlow, submitted = false): Promise<void> {
    const generation = this.endpointGeneration
    if (this.closed || this.planFlow !== flow) return
    try {
      const saved = await savePlanDraft(this.evenBridge, this.endpoint, flow.threadId, flow.request, flow.answers, submitted)
      if (this.closed || generation !== this.endpointGeneration) return
      if (!saved) throw new Error('Storage unavailable')
      flow.notice = ''
    } catch {
      if (this.closed || generation !== this.endpointGeneration) return
      flow.notice = 'Choices saved for this app session only.'
      this.companion.setSettingsStatus?.('Plan choices remain in memory; Even Hub storage could not save them.')
    }
  }

  private async handlePlanTap(): Promise<void> {
    const flow = this.planFlow
    if (!flow) return
    const action = flow.tap()
    if (action === 'dictate') {
      // Native microphone startup must not trap the double-tap exit gesture.
      const generation = this.endpointGeneration
      void this.beginDictation({ kind: 'thread', threadId: flow.threadId }, 'plan').catch(async error => {
        if (!this.closed && generation === this.endpointGeneration && this.planFlow === flow && ['plan', 'dictating'].includes(this.screen)) {
          await this.showError(errorMessage(error), 'plan')
        }
      })
      return
    }
    if (action === 'answer') void this.savePlanChoices(flow)
    if (action === 'submit') {
      if (!validatePlanDraftAnswers(flow.request, flow.answers, true)) {
        flow.notice = 'Review every answer and keep the total under 8,000 characters.'
        await this.renderPlan()
        return
      }
      flow.stage = 'submitting'
      // Keep the gesture queue free so double tap can exit while the RPC waits.
      void this.submitPlan(flow)
    }
    await this.renderPlan()
  }

  private async submitPlan(flow: PlanFlow): Promise<void> {
    if (this.closed || this.planFlow !== flow || !flow.complete || flow.stage !== 'submitting' ||
        this.transcript?.session.id !== flow.threadId || this.transcript.pendingPlanInput?.revision !== flow.request.revision) return
    const generation = this.endpointGeneration
    try {
      const client = this.requireClient()
      await this.savePlanChoices(flow, true)
      if (generation !== this.endpointGeneration || this.closed || this.client !== client ||
          this.planFlow !== flow || this.transcript?.pendingPlanInput?.revision !== flow.request.revision) return
      await client.request('plan.submit', { threadId: flow.threadId, requestId: flow.request.requestId,
        revision: flow.request.revision, answers: flow.answers })
      flow.stage = 'uncertain'
    } catch (error) {
      // A transport failure may occur after T3 accepted the command. Preserve
      // its immutable answer set and let a fresh transcript resolve the state.
      if (error instanceof BridgeRequestError && error.code === 'invalid_plan_answers' &&
          !this.closed && generation === this.endpointGeneration) {
        // This exact bridge error is emitted only by pre-dispatch validation.
        // It is therefore safe to remove the local send lock and edit again.
        await clearPlanDraft(this.evenBridge, this.endpoint, flow.threadId, flow.request)
        flow.stage = 'review'
        await this.savePlanChoices(flow)
        flow.notice = 'T3 rejected these answers before sending. Review and shorten them.'
      } else flow.stage = 'uncertain'
      if (!this.closed && generation === this.endpointGeneration) this.companion.setSettingsStatus?.(`Plan submission: ${errorMessage(error)}`)
    }
    if (generation !== this.endpointGeneration || this.closed) return
    if (this.screen === 'plan' && this.planFlow === flow) {
      await this.renderPlan().catch(() => undefined)
      this.scheduleTranscriptRefresh(flow.threadId)
    }
  }

  private async exitPlan(): Promise<void> {
    this.stopPlanPoll()
    this.cancelTranscriptRefresh()
    if (this.assistantOrigin) await this.restoreAssistantOrigin()
    else if (this.transcriptReturn === 'dashboard') await this.openDashboard(true)
    else if (this.transcriptReturn === 'notifications') await this.returnFromNotification()
    else if (this.transcriptReturn === 'projects') await this.returnToProjects()
    else await this.returnToSessions()
  }

  private transcriptFrame(): GlassesFrame | null {
    if (!this.transcript) return null
    const page = this.transcriptPages[this.transcriptPage]
    const working = ['running', 'starting'].includes(this.transcript.session.status)
    const unreadPages = Math.max(0, this.transcriptPages.length - this.transcriptPage - 1)
    const pulsedBody = page?.activeActivity
      ? renderActivityPulse(
          page.text,
          page.activeActivity,
          this.activityPulseFrame,
          page.activeActivityLabel,
        )
      : page?.text ?? '(empty)'
    const extractedActivity = page?.activeActivity
      ? extractActiveActivityLine(
          page.text,
          page.activeActivity,
          TRANSCRIPT_BOX.width,
          page.activeActivityLabel,
        )
      : null
    this.syncActivityPulse(page?.activeActivity ?? null, working)
    return {
      header: page
        ? working
          ? unreadPages > 0
            ? `LIVE | +${unreadPages} NEW | ${this.transcriptPage + 1}/${this.transcriptPages.length}`
            : `LIVE | TURN ${page.turnNumber}/${page.turnCount} | ${this.transcriptPage + 1}/${this.transcriptPages.length}`
          : transcriptPageHeader(page, this.transcriptPage + 1, this.transcriptPages.length)
        : 'T3 | NO TURNS | 1/1',
      body: extractedActivity?.body ?? pulsedBody,
      mirrorBody: pulsedBody,
      activity: page?.activeActivity && extractedActivity
        ? {
            kind: page.activeActivity,
            label: page.activeActivityLabel ?? undefined,
            frame: this.activityPulseFrame,
            lineIndex: extractedActivity.lineIndex,
          }
        : undefined,
    }
  }

  private syncActivityPulse(activity: TranscriptPage['activeActivity'], working: boolean): void {
    if (!working || activity === null) {
      this.stopActivityPulse()
      return
    }
    if (this.activityPulseTimer !== null) return
    this.activityPulseTimer = window.setInterval(() => {
      if (!['transcript', 'dictating', 'draft'].includes(this.screen)) {
        this.stopActivityPulse()
        return
      }
      const page = this.transcriptPages[this.transcriptPage]
      if (!page?.activeActivity) {
        this.stopActivityPulse()
        return
      }
      if (this.activityPulseWritePending) return
      this.activityPulseFrame = (this.activityPulseFrame + 1) % ACTIVITY_PULSE_FRAME_COUNT
      this.activityPulseWritePending = true
      const render = this.screen === 'dictating'
        ? this.renderDictation()
        : this.screen === 'draft'
          ? this.renderVoiceDraft()
          : this.renderTranscript()
      void render.finally(() => {
        this.activityPulseWritePending = false
      })
    }, ACTIVITY_PULSE_INTERVAL_MS)
  }

  private stopActivityPulse(): void {
    if (this.activityPulseTimer !== null) window.clearInterval(this.activityPulseTimer)
    this.activityPulseTimer = null
    this.activityPulseFrame = 0
  }

  private async beginDictation(target: AppVoiceTarget, returnScreen: DictationState['returnScreen']): Promise<void> {
    if (this.closed) return
    if (this.settingsSaving) throw new Error('Wait for dashboard settings to finish saving.')
    const generation = this.endpointGeneration
    const client = this.requireClient()
    this.voiceBackgroundFrame = target.kind === 'thread' ? this.transcriptFrame()
      : returnScreen === 'assistant' ? this.voiceBackgroundFrame : this.lastGlassesFrame
    this.dictation = {
      target,
      returnScreen,
      startedAt: Date.now(),
      maxBytes: Number.MAX_SAFE_INTEGER,
      sentBytes: 0,
      partialText: '',
      previewError: false,
    }
    this.screen = 'dictating'
    const dictation = this.dictation
    const current = () => !this.closed && generation === this.endpointGeneration && this.dictation === dictation && this.screen === 'dictating'
    const cardReady = this.renderDictation()
    const microphoneReady = (async () => {
      const recording = await client.request('voice.start', target.kind === 'phone' ? { source: 'phone', key: target.key } : {})
      if (!current()) return
      dictation.maxBytes = recording.maxBytes
      const opened = await this.evenBridge.audioControl(true, AudioInputSource.Glasses)
      if (!current()) { await this.evenBridge.audioControl(false).catch(() => undefined); return }
      if (!opened) throw new Error('The glasses microphone could not start')
    })()
    try {
      // Recording depends on the bridge recording session, not decorative
      // image transfers. Prepare the display and microphone concurrently.
      await Promise.all([cardReady, microphoneReady])
    } catch (error) {
      await Promise.allSettled([cardReady, microphoneReady])
      await this.evenBridge.audioControl(false).catch(() => undefined)
      const active = current()
      if (active) {
        this.dictation = null
        this.voiceBackgroundFrame = null
      }
      try {
        await client.request('voice.cancel')
      } catch {
        // A failed start may not have created a bridge recording.
      }
      if (active) throw error
    }
    if (!current()) return
    this.dictationTimer = window.setInterval(() => {
      if (this.screen === 'dictating') void this.renderDictation()
    }, 1000)
  }

  private async renderDictation(): Promise<void> {
    if (!this.dictation) return
    const seconds = Math.floor((Date.now() - this.dictation.startedAt) / 1000)
    const full = this.dictation.sentBytes >= this.dictation.maxBytes
    const pages = paginateMessageText(
      this.dictation.partialText,
      { width: DASHBOARD_READER_BOX.width, height: this.dictation.target.kind === 'phone' ? 162 : 189 },
    )
    const liveText = this.dictation.partialText
      ? pages[pages.length - 1]
      : this.dictation.previewError
        ? 'Live preview is delayed.\n\nRecording continues.'
        : 'Speak your message...'
    await this.showVoiceState(
      this.dictation.target,
      full
        ? 'DICTATION LIMIT REACHED'
        : this.dictation.previewError
          ? `PREVIEW DELAYED | ${seconds}S`
          : `LISTENING | ${seconds}S`,
      liveText ?? 'Speak your message...',
    )
  }

  private async finishDictation(): Promise<void> {
    const dictation = this.dictation
    if (!dictation) return
    const generation = this.endpointGeneration
    const client = this.requireClient()
    this.stopDictationTimer()
    await this.evenBridge.audioControl(false)
    if (generation !== this.endpointGeneration || this.dictation !== dictation) return
    this.screen = 'finalizing'
    await this.showVoiceState(
      dictation.target,
      'FINISHING TRANSCRIPT',
      'Checking the complete local transcript...\n\nNothing has been sent.',
    )
    if (generation !== this.endpointGeneration || this.dictation !== dictation) return
    try {
      const result = await client.request('voice.finish')
      if (generation !== this.endpointGeneration || this.dictation !== dictation) return
      this.dictation = null
      this.voiceDraft = {
        target: dictation.target,
        returnScreen: dictation.returnScreen,
        text: result.text,
        pages: paginateMessageText(
          result.text,
          { width: DASHBOARD_READER_BOX.width, height: dictation.target.kind === 'phone' ? 162 : 189 },
        ),
        page: 0,
      }
      this.screen = 'draft'
      await this.renderVoiceDraft()
    } catch (error) {
      if (generation !== this.endpointGeneration || this.dictation !== dictation) return
      this.dictation = null
      this.voiceBackgroundFrame = null
      await this.showError(`Dictation failed\n\n${errorMessage(error)}`, dictation.returnScreen)
    }
  }

  private async renderVoiceDraft(): Promise<void> {
    if (!this.voiceDraft) return
    await this.showVoiceState(
      this.voiceDraft.target,
      `${this.voiceDraft.returnScreen === 'plan' ? 'ANSWER' : 'DRAFT'} | ${this.voiceDraft.page + 1}/${this.voiceDraft.pages.length} | ${this.voiceDraft.returnScreen === 'plan' ? 'TAP TO KEEP' : 'NOT SENT'}`,
      this.voiceDraft.pages[this.voiceDraft.page] ?? '(empty)',
    )
  }

  private async sendVoiceDraft(): Promise<void> {
    const draft = this.voiceDraft
    if (!draft) return
    if (draft.target.kind === 'phone') { await this.sendPhoneDraft(); return }
    if (draft.returnScreen === 'plan') {
      const flow = this.planFlow
      if (!flow || this.transcript?.pendingPlanInput?.revision !== flow.request.revision) {
        this.voiceDraft = null
        await this.exitPlan()
        return
      }
      if (!draft.text.trim()) throw new Error('Dictate an answer before accepting it.')
      const accepted = flow.accept({ questionId: flow.question.id, optionIndexes: [], text: draft.text.trim() })
      this.voiceDraft = null
      this.voiceBackgroundFrame = null
      if (accepted) void this.savePlanChoices(flow)
      this.screen = 'plan'
      await this.renderPlan()
      return
    }
    const generation = this.endpointGeneration
    const client = this.requireClient()
    this.screen = 'sending'
    await this.showVoiceState(draft.target, 'SENDING TO T3 CODE', draft.text)
    if (generation !== this.endpointGeneration) return
    try {
      this.responseBaselineMessageIds = new Set(
        draft.target.kind === 'thread'
          ? this.transcript?.turns.flatMap((turn) => turn.messages.map((message) => message.id)) ?? []
          : [],
      )
      const sessionWorking = draft.target.kind === 'thread'
        && ['running', 'starting'].includes(this.transcript?.session.status ?? '')
      const result = draft.target.kind === 'thread'
        ? await client.request(sessionWorking ? 'turn.steer' : 'turn.send', {
            threadId: draft.target.threadId,
            text: draft.text,
          })
        : await client.request(draft.target.kind === 'assistant' ? 'assistant.start' : 'thread.start', {
            projectId: draft.target.projectId,
            modelSelection: draft.target.modelSelection,
            text: draft.text,
          })
      if (generation !== this.endpointGeneration) return
      this.voiceDraft = null
      this.voiceBackgroundFrame = null
      await this.openTranscript(result.threadId, true)
    } catch (error) {
      if (generation !== this.endpointGeneration) return
      this.responseBaselineMessageIds = null
      const message = draft.target.kind === 'assistant' && error instanceof BridgeRequestError && error.code === 'method_not_found'
        ? 'Update the Mac bridge to create full-access assistant sessions. Your draft has been kept.'
        : errorMessage(error)
      await this.showError(`Send failed\n\n${message}`, 'draft')
    }
  }

  private async cancelVoiceFlow(): Promise<void> {
    if (this.closed) return
    const returnScreen = this.dictation?.returnScreen ?? this.voiceDraft?.returnScreen ?? 'transcript'
    const wasDictating = this.dictation !== null
    this.stopDictationTimer()
    this.dictation = null
    this.voiceDraft = null
    this.voiceBackgroundFrame = null
    let cardRemoved: Promise<void>
    if (returnScreen === 'notifications') {
      cardRemoved = this.openNotifications(true)
    } else if (returnScreen === 'plan') {
      cardRemoved = this.exitPlan()
    } else if (returnScreen === 'assistant') {
      cardRemoved = this.restoreAssistantOrigin()
    } else if (returnScreen === 'new-session' && this.selectedProject) {
      cardRemoved = this.openNewSession()
    } else if (this.transcript) {
      this.screen = 'transcript'
      cardRemoved = this.renderTranscript()
    } else {
      cardRemoved = this.openSessions()
    }
    const stopAudio = this.evenBridge.audioControl(false)
    const cancelRecording = wasDictating
      ? this.requireClient().request('voice.cancel').catch(() => undefined)
      : Promise.resolve(undefined)
    await cardRemoved
    await Promise.all([stopAudio, cancelRecording])
  }

  private async showError(
    message: string,
    returnScreen: 'new-session' | 'transcript' | 'sessions' | 'projects' | 'draft' | 'dashboard' | 'notifications' | 'assistant' | 'plan',
  ): Promise<void> {
    if (this.closed) return
    this.screen = 'error'
    await this.show({
      header: 'T3 CODE | ERROR',
      body: message,
    })
    this.errorReturnScreen = returnScreen
  }

  private errorReturnScreen: 'new-session' | 'transcript' | 'sessions' | 'projects' | 'draft' | 'dashboard' | 'notifications' | 'assistant' | 'plan' = 'sessions'

  private async handleTap(): Promise<void> {
    switch (this.screen) {
      case 'phone-reader':
        if (this.phone.connected && this.phoneKey) await this.beginDictation({ kind: 'phone', key: this.phoneKey }, 'notifications')
        return
      case 'plan':
        await this.handlePlanTap()
        return
      case 'dashboard': {
        const card = this.cards.find(item => item.key === this.dashboardSelection)
        if (card?.action.kind === 'assistant') await this.openAssistant()
        else if (card?.action.kind === 'sessions') await this.openSessions()
        else if (card?.action.kind === 'projects') await this.openProjects()
        else if (card?.action.kind === 'reader') {
          this.dashboardReader = { title: card.action.title, pages: paginateText(card.action.text, TRANSCRIPT_BOX), page: 0 }
          this.screen = 'dashboard-reader'
          await this.renderDashboardReader()
        } else if (card?.action.kind === 'notifications') await this.openNotifications()
        return
      }
      case 'notifications': {
        const card = this.notificationItems.find(item => item.key === this.notificationSelection)
        if (card?.action.kind === 'phone') {
          this.phoneKey = card.action.key
          this.phonePage = 0
          this.screen = 'phone-reader'
          await this.renderPhoneReader()
        } else if (card?.action.kind === 'alert') {
          this.assistantOrigin = null
          this.transcriptReturn = 'notifications'
          await this.openTranscript(card.action.alert.threadId)
        } else if (card?.action.kind === 'reader') {
          this.dashboardReader = { title: card.action.title, pages: paginateText(card.action.text, DASHBOARD_READER_BOX), page: 0, returnTo: 'notifications' }
          this.screen = 'dashboard-reader'
          await this.renderDashboardReader()
          this.testNotifications = this.testNotifications.filter(item => item.key !== card.key)
        }
        return
      }
      case 'sessions': {
        if (this.sessionSelection === 'new') {
          await this.openProjects('sessions')
          return
        }
        const threadId = selectedValue(this.sessionRows, this.sessionSelection)
        if (threadId) {
          this.assistantOrigin = null
          this.transcriptReturn = 'sessions'
          await this.openTranscript(threadId)
        }
        return
      }
      case 'projects': {
        const projectId = selectedValue(this.projectRows, this.projectSelection)
        if (projectId) {
          this.transcriptReturn = 'projects'
          await this.openModels(projectId)
        }
        return
      }
      case 'models': {
        const key = selectedValue(this.modelRows, this.modelSelection)
        const model = this.models.find((candidate) => modelKey(candidate) === key)
        if (!model) return
        this.selectedModel = model
        if (model.reasoningChoices.length > 0) {
          await this.openReasoning(model)
        } else {
          this.selectedReasoning = null
          await this.openNewSession()
        }
        return
      }
      case 'reasoning': {
        const reasoning = selectedValue(this.reasoningRows, this.reasoningSelection)
        if (!reasoning) return
        this.selectedReasoning = reasoning
        await this.openNewSession()
        return
      }
      case 'new-session':
        if (this.selectedProject) {
          await this.beginDictation({
            kind: 'project',
            projectId: this.selectedProject.id,
            modelSelection: this.newSessionModelSelection(),
          }, 'new-session')
        }
        return
      case 'transcript':
        if (this.transcript) {
          await this.beginDictation({ kind: 'thread', threadId: this.transcript.session.id }, 'transcript')
        }
        return
      case 'dictating':
        if (this.dictation?.returnScreen === 'plan') {
          void this.finishDictation().catch(error => this.showError(errorMessage(error), 'plan'))
          return
        }
        await this.finishDictation()
        return
      case 'draft':
        await this.sendVoiceDraft()
        return
      case 'error':
        await this.returnFromError()
        return
      default:
        return
    }
  }

  private async handleDoubleTap(): Promise<void> {
    switch (this.screen) {
      case 'phone-reader':
        this.phoneKey = null
        await this.openNotifications(true)
        return
      case 'plan':
        await this.exitPlan()
        return
      case 'dictating':
      case 'finalizing':
      case 'draft':
        await this.cancelVoiceFlow()
        return
      case 'models':
        await this.returnToProjects()
        return
      case 'reasoning':
        if (this.selectedModel) {
          const selectedKey = modelKey(this.selectedModel)
          this.modelSelection = this.modelRows.find((row) => row.value === selectedKey)?.key
            ?? defaultModelKey(this.models)
          this.screen = 'models'
          await this.renderModels()
        }
        return
      case 'new-session':
        if (this.selectedModel?.reasoningChoices.length) {
          this.reasoningSelection = this.reasoningRows.find(
            (row) => row.value === this.selectedReasoning,
          )?.key ?? defaultReasoningId(this.selectedModel.reasoningChoices)
          this.screen = 'reasoning'
          await this.renderReasoning()
        } else if (this.selectedModel) {
          const selectedKey = modelKey(this.selectedModel)
          this.modelSelection = this.modelRows.find((row) => row.value === selectedKey)?.key
            ?? defaultModelKey(this.models)
          this.screen = 'models'
          await this.renderModels()
        }
        return
      case 'transcript':
        if (this.assistantOrigin) await this.restoreAssistantOrigin()
        else if (this.transcriptReturn === 'dashboard') await this.openDashboard()
        else if (this.transcriptReturn === 'notifications') await this.returnFromNotification()
        else if (this.transcriptReturn === 'projects') await this.returnToProjects()
        else await this.returnToSessions()
        return
      case 'sessions':
        await this.openDashboard(true)
        return
      case 'projects':
        if (this.projectsReturn === 'sessions') await this.returnToSessions()
        else await this.openDashboard(true)
        return
      case 'dashboard-reader':
        if (this.dashboardReader?.returnTo === 'notifications') await this.returnFromNotification()
        else await this.openDashboard(true)
        return
      case 'notifications':
        await this.openDashboard(true)
        return
      case 'dashboard':
        if (this.settingsSaving) {
          await this.show({ header: 'SAVING SETTINGS', body: 'Settings are still saving.' })
          return
        }
        await this.evenBridge.shutDownPageContainer(1)
        this.cleanup()
        return
      case 'error':
        if (this.voiceDraft?.target.kind === 'phone') { await this.cancelVoiceFlow(); return }
        if (this.errorReturnScreen === 'plan') { await this.exitPlan(); return }
        await this.returnFromError()
        return
      default:
        return
    }
  }

  private async handleScroll(direction: -1 | 1): Promise<void> {
    if (this.screen === 'phone-reader') {
      this.phonePage = Math.max(0, this.phonePage + direction)
      await this.renderPhoneReader()
      return
    }
    if (this.screen === 'plan' && this.planFlow) {
      this.planFlow.scroll(direction)
      await this.renderPlan()
      return
    }
    if (this.screen === 'notifications') {
      const index = Math.max(0, this.notificationItems.findIndex(card => card.key === this.notificationSelection))
      this.notificationSelection = this.notificationItems[(index + direction + this.notificationItems.length) % this.notificationItems.length]?.key ?? ''
      await this.renderNotifications()
      return
    }
    if (this.screen === 'dashboard-reader' && this.dashboardReader) {
      this.dashboardReader.page = Math.max(0, Math.min(this.dashboardReader.pages.length - 1, this.dashboardReader.page + direction))
      await this.renderDashboardReader()
      return
    }
    if (this.screen === 'dashboard') {
      const index = Math.max(0, this.cards.findIndex(card => card.key === this.dashboardSelection))
      this.dashboardSelection = this.cards[(index + direction + this.cards.length) % this.cards.length]?.key ?? 'assistant'
      await this.renderDashboard()
      return
    }
    if (this.screen === 'sessions') {
      this.sessionSelection = moveSelection(this.sessionRows, this.sessionSelection, direction)
      await this.renderSessions()
      return
    }
    if (this.screen === 'projects') {
      this.projectSelection = moveSelection(this.projectRows, this.projectSelection, direction)
      await this.renderProjects()
      return
    }
    if (this.screen === 'models') {
      this.modelSelection = moveSelection(this.modelRows, this.modelSelection, direction)
      await this.renderModels()
      return
    }
    if (this.screen === 'reasoning') {
      this.reasoningSelection = moveSelection(this.reasoningRows, this.reasoningSelection, direction)
      await this.renderReasoning()
      return
    }
    if (this.screen === 'transcript') {
      this.transcriptPage = Math.min(
        this.transcriptPages.length - 1,
        Math.max(0, this.transcriptPage + direction),
      )
      await this.renderTranscript()
      return
    }
    if (this.screen === 'draft' && this.voiceDraft) {
      this.voiceDraft.page = Math.min(
        this.voiceDraft.pages.length - 1,
        Math.max(0, this.voiceDraft.page + direction),
      )
      await this.renderVoiceDraft()
    }
  }

  private async returnFromError(): Promise<void> {
    if (this.errorReturnScreen === 'projects') {
      await this.returnToProjects()
    } else if (this.errorReturnScreen === 'plan') {
      if (this.planFlow) { this.screen = 'plan'; await this.renderPlan() }
      else await this.exitPlan()
    } else if (this.errorReturnScreen === 'assistant') {
      await this.restoreAssistantOrigin()
    } else if (this.errorReturnScreen === 'notifications') {
      await this.openNotifications()
    } else if (this.errorReturnScreen === 'dashboard') {
      await this.openDashboard(true)
    } else if (this.errorReturnScreen === 'new-session' && this.selectedProject) {
      await this.openNewSession()
    } else if (this.errorReturnScreen === 'transcript' && this.transcript) {
      this.screen = 'transcript'
      await this.renderTranscript()
    } else if (this.errorReturnScreen === 'draft' && this.voiceDraft) {
      this.screen = 'draft'
      await this.renderVoiceDraft()
    } else {
      await this.openSessions()
    }
  }

  private onEvenEvent(event: EvenHubEvent): void {
    if (event.menuItemClickEvent) {
      this.companion.recordInput('Context menu', `item ${event.menuItemClickEvent.itemID} | screen ${this.screen}`)
      const id = event.menuItemClickEvent.itemID
      if (!this.displayTestController && this.screen === 'plan' && this.planFlow && !this.planFlow.locked) {
        this.enqueue(async () => {
          if (this.screen !== 'plan' || !this.planFlow || this.planFlow.locked) return
          if (id === PLAN_NEXT_MENU_ID) this.planFlow.openQuestion(this.planFlow.questionIndex + 1)
          else if (id === PLAN_PREVIOUS_MENU_ID) this.planFlow.openQuestion(this.planFlow.questionIndex - 1)
          else if (id === PLAN_REVIEW_MENU_ID) this.planFlow.review()
          else return
          await this.renderPlan()
        })
      } else if (id === DISMISS_PHONE_MENU_ID) {
        this.enqueue(() => this.dismissPhone())
      } else if (id === SETTLE_SESSION_MENU_ID) {
        const threadId = this.settleCandidate()
        if (threadId) this.enqueue(() => this.settleSession(threadId))
      } else if (id === ASK_ASSISTANT_MENU_ID) this.requestAssistant()
      return
    }
    const pcm = event.audioEvent?.audioPcm
    if (pcm && this.screen === 'dictating' && this.dictation) {
      const remaining = this.dictation.maxBytes - this.dictation.sentBytes
      if (remaining > 1) {
        const evenLength = Math.min(pcm.byteLength, remaining) & ~1
        if (evenLength > 0) {
          const chunk = evenLength === pcm.byteLength ? pcm : pcm.slice(0, evenLength)
          try {
            this.requireClient().sendAudio(chunk)
            this.dictation.sentBytes += evenLength
          } catch (error) {
            const returnScreen = this.dictation.returnScreen
            this.screen = 'finalizing'
            this.enqueue(() => this.failDictationStream(error, returnScreen))
          }
        }
      }
    }

    const eventType = inputTypeFromEvenHubEvent(event)
    if (eventType === null) return
    const channel = event.sysEvent ? 'system' : event.textEvent ? 'text' : 'list'
    this.companion.recordInput(
      inputLabel(eventType),
      `${inputCode(eventType)} | glasses ${channel} | screen ${this.screen}`,
    )
    this.routeInput(eventType)
  }

  private routeInput(eventType: OsEventTypeList): void {
    if (this.displayTestController && eventType !== OsEventTypeList.SYSTEM_EXIT_EVENT && eventType !== OsEventTypeList.ABNORMAL_EXIT_EVENT) {
      if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) this.displayTestController.abort()
      return
    }
    if (eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      this.enqueue(() => this.handleDoubleTap())
      return
    }
    if (eventType === OsEventTypeList.SCROLL_TOP_EVENT) {
      this.enqueue(() => this.handleScroll(-1))
      return
    }
    if (eventType === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
      this.enqueue(() => this.handleScroll(1))
      return
    }
    if (eventType === OsEventTypeList.CLICK_EVENT) {
      this.enqueue(() => this.handleTap())
      return
    }
    if (
      eventType === OsEventTypeList.SYSTEM_EXIT_EVENT
      || eventType === OsEventTypeList.ABNORMAL_EXIT_EVENT
    ) {
      this.cleanup()
    }
  }

  private onBridgeEvent(event: string, payload: unknown): void {
    if (event === 'phone.changed') { void this.acceptPhone(payload as PhoneSnapshot); return }
    if (event === 'connection.changed') {
      if (isRecord(payload) && payload.connected === true) void this.refreshPhone()
      else void this.acceptPhone({ ...this.phone, connected: false })
      return
    }
    if (event === 'sessions.changed') {
      const snapshot = parseSessionsSnapshot(payload)
      if (snapshot) this.acceptSessions(snapshot)
      return
    }
    if (event === 'archive.status') {
      const state = isRecord(payload) ? payload.state : null
      const message = state === 'ok' ? 'Assistant history archived.'
        : state === 'disabled' ? 'Assistant archive is disabled.'
        : state === 'pending' ? 'Waiting for assistant archive check.'
        : 'Assistant archive incomplete. Check the Mac bridge; it retries every 60 seconds.'
      this.companion.setArchiveStatus?.(message)
      return
    }
    if (event === 'bridge.status') {
      this.connectionLabel = isRecord(payload) && payload.status === 'connected' ? 'Connected' : 'Unavailable'
      if (this.screen === 'dashboard') void this.renderDashboard().catch(() => undefined)
      return
    }
    if (event === 'voice.partial') {
      if (this.screen !== 'dictating' || !this.dictation) return
      const text = isRecord(payload) && typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text || text === this.dictation.partialText) return
      this.dictation.partialText = text.slice(-8_000)
      this.dictation.previewError = false
      if (this.voicePartialTimer !== null) window.clearTimeout(this.voicePartialTimer)
      this.voicePartialTimer = window.setTimeout(() => {
        this.voicePartialTimer = null
        if (this.screen === 'dictating' && this.dictation) void this.renderDictation()
      }, 120)
      return
    }
    if (event === 'voice.error') {
      if (this.screen !== 'dictating' || !this.dictation) return
      this.dictation.previewError = true
      void this.renderDictation()
      return
    }
    if (
      event !== 'transcript.changed'
      || !['transcript', 'plan', 'dictating', 'draft'].includes(this.screen)
      || !this.transcript
    ) return
    const threadId = transcriptChangedThreadId(payload)
    if (threadId !== this.transcript.session.id) return
    this.scheduleTranscriptRefresh(threadId)
  }

  private scheduleTranscriptRefresh(threadId: string): void {
    this.transcriptRefreshDirty = true
    if (this.transcriptRefreshQueued) return
    this.transcriptRefreshQueued = true
    const generation = this.transcriptRefreshGeneration
    this.transcriptRefreshTimer = window.setTimeout(() => {
      this.transcriptRefreshTimer = null
      this.transcriptRefreshDirty = false
      this.enqueue(async () => {
        try {
          if (
            generation !== this.transcriptRefreshGeneration
            || !['transcript', 'plan', 'dictating', 'draft'].includes(this.screen)
            || this.transcript?.session.id !== threadId
          ) return
          await this.openTranscript(threadId, false, this.screen !== 'transcript')
        } finally {
          if (generation === this.transcriptRefreshGeneration) {
            this.transcriptRefreshQueued = false
            if (this.transcriptRefreshDirty) this.scheduleTranscriptRefresh(threadId)
          }
        }
      })
    }, 120)
  }

  private cancelTranscriptRefresh(): void {
    if (this.transcriptRefreshTimer !== null) window.clearTimeout(this.transcriptRefreshTimer)
    this.transcriptRefreshTimer = null
    this.transcriptRefreshQueued = false
    this.transcriptRefreshDirty = false
    this.transcriptRefreshGeneration += 1
  }

  private enqueue(task: () => Promise<void>): void {
    const generation = this.endpointGeneration
    this.eventQueue = this.eventQueue.then(async () => {
      if (!this.closed && generation === this.endpointGeneration) await task()
    }).catch(async (error) => {
      if (this.closed || generation !== this.endpointGeneration) return
      await this.showError(errorMessage(error), this.screen === 'plan' || this.dictation?.returnScreen === 'plan' ? 'plan' : this.screen === 'transcript' ? 'transcript' : this.screen === 'projects' ? 'projects' : this.screen === 'notifications' ? 'notifications' : this.screen === 'dashboard' ? 'dashboard' : 'sessions')
    })
  }

  private async showSetup(error?: string): Promise<void> {
    this.screen = 'setup'
    await this.show({
      header: 'T3 CODE | PHONE SETUP',
      body: error
        ? `Could not connect.\n\n${error}\n\nOpen Even Hub on your phone.`
        : 'Open Even Hub on your phone.\n\nBridge URL and pairing passphrase required.',
    })
  }

  private async showVoiceState(_target: AppVoiceTarget, title: string, body: string): Promise<void> {
    const recipient = _target.kind === 'phone' ? this.phone.notifications.find(item => item.key === _target.key) : null
    const background = this.voiceBackgroundFrame ?? this.lastGlassesFrame
    const width = DASHBOARD_READER_BOX.width
    await this.show(voiceOverlay(background, title, recipient ? `${fitLines(`To: ${recipient.appName} · ${recipient.sender ?? recipient.thread ?? recipient.title}`, width, 1)}\n${body}` : body))
  }

  private async show(frame: GlassesFrame): Promise<void> {
    if (this.closed) return
    // Background frames can be retained by dictation. Recompute the native
    // surface from the active screen so those overlays keep their own layout.
    frame = { ...frame, dashboardSurface: this.dashboardSurface(frame) }
    // Keep registration stable while a save or catalog lookup is pending;
    // canAskAssistant rejects invocation until that operation finishes.
    frame = { ...frame, askAssistant: frame.card?.presentation === 'voice' ? false : this.assistantMenuAvailable() }
    if (!frame.menuItems && frame.askAssistant && this.screen === 'transcript' && this.settleCandidate()) {
      frame.menuItems = [{ itemID: ASK_ASSISTANT_MENU_ID, itemName: 'Ask assistant' },
        { itemID: SETTLE_SESSION_MENU_ID, itemName: 'Settle session' }]
    }
    const previous = this.lastGlassesFrame.dashboardSurface
    const current = frame.dashboardSurface
    let motion: Omit<OsMotion, 'id'> | undefined
    if (previous && current && previous.view !== current.view) {
      if (previous.view === 'home') motion = current.view === 'notifications'
        ? { direction: 'drop', from: OS_NOTIFICATION_CLOSED, to: OS_NOTIFICATION }
        : { direction: 'expand', from: homeFocusRect(previous.actions), to: OS_FULL }
      else if (current.view === 'home') motion = previous.view === 'notifications'
        ? { direction: 'retract', from: OS_NOTIFICATION, to: OS_NOTIFICATION_CLOSED }
        : { direction: 'collapse', from: OS_FULL, to: homeFocusRect(current.actions) }
      else if (previous.view === 'notifications') motion = { direction: 'rise', from: OS_READER_CLOSED, to: OS_FULL }
      else if (current.view === 'notifications') motion = { direction: 'lower', from: OS_FULL, to: OS_READER_CLOSED }
      else if (current.view === 'plan' && previous.view !== 'voice') motion = { direction: 'rise', from: OS_READER_CLOSED, to: OS_FULL }
      else if (previous.view === 'plan' && current.view !== 'voice') motion = { direction: 'lower', from: OS_FULL, to: OS_READER_CLOSED }
    }
    frame = { ...frame, motion: motion ? { ...motion, id: ++this.motionSequence } : undefined }
    if (this.screen === 'phone-reader' || (this.screen === 'notifications' && this.notificationItems.find(item => item.key === this.notificationSelection)?.action.kind === 'phone')) frame.menuItems = [{ itemID: DISMISS_PHONE_MENU_ID, itemName: 'Dismiss notification' }]
    this.lastGlassesFrame = frame
    frame = { ...frame, banner: this.arrivalBanner }
    this.companion.setArrivalBanner?.(this.arrivalBanner)
    this.companion.setMirror(
      this.companion.setCardMirror ? frame.header : frame.card?.title ?? frame.header,
      this.companion.setCardMirror ? frame.mirrorBody ?? frame.body : frame.card?.body ?? frame.mirrorBody ?? frame.body,
    )
    this.companion.setCardMirror?.(frame.card ?? null)
    this.companion.setDashboardMirror?.(frame.dashboard?.left ?? null, frame.dashboard?.panel, frame.dashboard?.actions)
    this.companion.setOsMirror?.(frame)
    await this.display.render(frame)
  }

  private dashboardSurface(frame: GlassesFrame): GlassesFrame['dashboardSurface'] {
    if (frame.card?.presentation === 'voice') {
      return { view: 'voice', panel: frame.dashboard?.panel ?? this.dashboardFrame().dashboard!.panel!,
        title: fitLines(frame.card.title, DASHBOARD_READER_BOX.width, 1), text: frame.card.body,
        footer: '' }
    }
    if (this.screen === 'setup') return undefined
    if (this.screen === 'plan' && frame.card) return { view: 'plan', panel: this.dashboardFrame().dashboard!.panel!, title: frame.card.title, text: frame.card.body, footer: '' }
    const dashboard = frame.dashboard ?? this.dashboardFrame().dashboard!
    if (!dashboard.panel) return undefined
    let title = frame.header
    let text = frame.body
    let footer = ''
    if (this.screen === 'dashboard') {
      if (frame.body) footer = fitLines(frame.body, DASHBOARD_READER_BOX.width, 1)
    } else if (this.screen === 'notifications') {
      title = frame.card?.title ?? 'NOTIFICATIONS'
      text = frame.card?.body ?? ''
      footer = ''
    } else if (this.screen === 'phone-reader' || this.screen === 'dashboard-reader') {
      if (this.screen === 'phone-reader') {
        const lines = frame.body.split('\n')
        footer = lines.pop() ?? ''
        text = lines.map((line, index) => index === 0 ? fitLines(line, DASHBOARD_READER_BOX.width, 1) : line).join('\n')
      }
    }
    const menuScreen = ['sessions', 'projects', 'models', 'reasoning'].includes(this.screen)
    if (menuScreen) text = text.split('\n').map(line => fitLines(line, 528, 1)).join('\n')
    if (frame.activity) {
      const lines = text.split('\n')
      lines[frame.activity.lineIndex] = fitLines(`${frame.activity.kind === 'thinking' ? 'Thinking' : frame.activity.label ?? 'Tool call'}${'.'.repeat(1 + frame.activity.frame % 3)}`, 544, 1)
      text = lines.join('\n')
    }
    return { view: this.screen === 'dashboard' ? 'home' : this.screen === 'notifications' ? 'notifications' : this.screen === 'phone-reader' || this.screen === 'dashboard-reader' ? 'reader' : 'content',
      trailing: this.screen === 'notifications' ? frame.card?.meta : undefined,
      focusLine: menuScreen ? text.split('\n').findIndex(line => line.startsWith('>')) : undefined,
      actions: ['dashboard', 'notifications'].includes(this.screen) ? dashboard.actions : undefined,
      panel: dashboard.panel, title: fitLines(title, DASHBOARD_READER_BOX.width, 1), text,
      footer: fitLines(footer, DASHBOARD_READER_BOX.width, 1) }
  }

  private async loadProfile(explicitDevelopmentUrl: string | null): Promise<ConnectionProfile> {
    let stored: string | null = null
    try {
      stored = await this.evenBridge.getLocalStorage(PROFILE_KEY)
    } catch {
      // Missing or unreadable storage falls through to development setup.
    }
    return selectConnectionProfile(
      stored,
      { url: DEV_BRIDGE_URL, token: DEV_BRIDGE_TOKEN },
      DEFAULT_BRIDGE_URL,
      explicitDevelopmentUrl,
    )
  }

  private requireClient(): T3BridgeClient {
    if (!this.client) throw new Error('T3 bridge is not connected')
    return this.client
  }

  private async failDictationStream(
    error: unknown,
    returnScreen: DictationState['returnScreen'],
  ): Promise<void> {
    this.stopDictationTimer()
    await this.evenBridge.audioControl(false)
    try {
      await this.requireClient().request('voice.cancel')
    } catch {
      // The bridge also clears the recording when the connection closes.
    }
    this.dictation = null
    await this.showError(`Dictation failed\n\n${errorMessage(error)}`, returnScreen)
  }

  private stopDictationTimer(): void {
    if (this.dictationTimer !== null) window.clearInterval(this.dictationTimer)
    this.dictationTimer = null
    if (this.voicePartialTimer !== null) window.clearTimeout(this.voicePartialTimer)
    this.voicePartialTimer = null
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
