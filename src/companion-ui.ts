import { debugToolsEnabled } from './debug-tools'
import { mountOsMirror } from './os-mirror'
import type { PhoneSnapshot } from './phone-protocol'
import type { OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { INPUT_DEFINITIONS, inputCode } from './input-events'
import { displayCases, type DisplayTestSelection } from './display-diagnostics'
import { mountSettings, settingsMarkup, type SettingsActions } from './companion-settings'
import type { DashboardSettings } from './dashboard-settings'
import { renderDashboardPanel, type DashboardPanel } from './dashboard-panel'
import type { ModelSummary, ProjectSummary } from './protocol'
import type { GlassesCard, DashboardActionRow, GlassesFrame } from './glasses-display'

export interface ConnectionProfile {
  url: string
  token: string
}

export interface PairingRequest {
  url: string
  passphrase: string
}

export interface CompanionUi {
  setOsMirror?(frame: GlassesFrame): void
  setArrivalBanner?(text: string | undefined): void
  setPhoneSettings?(snapshot: PhoneSnapshot): void
  setConnectionStatus(kind: 'idle' | 'connecting' | 'connected' | 'error', message: string): void
  setArchiveStatus?(message: string): void
  setMirror(header: string, body: string): void
  setProfile(profile: ConnectionProfile): void
  recordInput(label: string, detail: string): void
  setDiagnosticsReady(): void
  setSettings?(settings: DashboardSettings, projects: ProjectSummary[], models: ModelSummary[]): void
  setSettingsStatus?(message: string): void
  setDashboardMirror?(left: string | null, panel?: DashboardPanel, actions?: DashboardActionRow[]): void
  setCardMirror?(card: GlassesCard | null): void
}

export function mountCompanionUi(
  onPair: (request: PairingRequest) => Promise<void>,
  onInput: (eventType: OsEventTypeList) => void,
  onDisplayTest: (selection: DisplayTestSelection, report: (line: string) => void, signal: AbortSignal) => Promise<void>,
  settingsActions?: SettingsActions,
): CompanionUi {
  const app = document.querySelector<HTMLDivElement>('#app')
  if (!app) throw new Error('Missing #app element')
  app.innerHTML = `
    <main class="shell">
      <header class="topbar">
        <div>
          <p class="eyebrow">EVEN REALITIES G2</p>
          <h1>T3 Code Bridge</h1>
        </div>
        <span id="status" class="status status-idle">Not connected</span>
      </header>

      <p id="archive-status" class="help" aria-live="polite">Assistant archive status pending.</p>

      <section class="preview" aria-label="Glasses display mirror">
        <p id="mirror-header" class="preview-header">T3 CODE</p>
        <div id="mirror-columns"><pre id="mirror-left" class="preview-body" hidden></pre><canvas id="mirror-panel" width="220" height="288" hidden></canvas><pre id="mirror-body" class="preview-body">Connecting…</pre></div>
        <pre id="mirror-card" hidden></pre><pre id="mirror-arrival" hidden></pre>
        <div id="mirror-actions" hidden></div>
      </section>

      <section class="card"><h2>Android notifications</h2><p id="phone-status" class="help">Companion not connected.</p>
        <button id="phone-pair">Pair Android companion</button><p id="phone-pair-code" role="status"></p>
        <p class="help">Enable apps to discover notifications with text replies. All apps start disabled.</p><label>Find an app<input id="phone-app-filter" type="search" placeholder="App name or package"></label><div id="phone-apps"></div></section>
      ${settingsMarkup}

      ${debugToolsEnabled ? `
      <section class="card input-card" aria-labelledby="input-test-heading">
        <div>
          <h2 id="input-test-heading">Input test panel</h2>
          <p class="help">Each button enters the same event path as the glasses. Exit events stop the app.</p>
        </div>
        ${inputGroup('Gestures', 'gesture')}
        ${inputGroup('Lifecycle', 'lifecycle')}
        ${inputGroup('Sensor', 'sensor')}
        <p id="input-status" class="input-status" aria-live="polite">No input received yet.</p>
        <ol id="input-log" class="input-log" aria-label="Recent input events"></ol>
      </section>

      <section class="card" aria-labelledby="display-test-heading">
        <h2 id="display-test-heading">Display diagnostics</h2>
        <p class="help">Uses the actual glasses renderer. The card test includes its background images, without recording or sending a message. Session updates resume when the test ends.</p>
        <button id="test-production-card" data-display-test disabled>Open production dictation card</button>
        <button id="test-all-layouts" data-display-test disabled>Run card + all layout tests</button>
        <button id="restore-display" disabled>Restore session / stop test</button>
        <details>
          <summary>Individual layout probes</summary>
          <p class="help">These isolate native layout acceptance. They do not upload image pixels.</p>
          <div id="display-probes" class="input-grid"></div>
        </details>
        <p id="display-test-status" class="input-status" aria-live="polite">Waiting for glasses display...</p>
        <label>Display report<textarea id="display-test-report" readonly rows="10" spellcheck="false"></textarea></label>
        <button id="copy-display-report">Copy report</button>
      </section>

      ` : '<!-- Debug input and display panels are disabled in beta builds. -->'}

      <form id="connection-form" class="card">
        <h2>Bridge connection</h2>
        <label>
          WebSocket URL
          <input id="bridge-url" name="url" type="url" required spellcheck="false"
            placeholder="wss://your-computer.your-tailnet.ts.net:8443/v1/events" />
        </label>
        <p class="help">Use the WebSocket URL provided by your installer agent.</p>
        <label>
          Pairing passphrase
          <input id="bridge-passphrase" name="passphrase" type="password" required autocomplete="off"
            placeholder="Enter pairing passphrase" />
        </label>
        <button type="submit">Save and connect</button>
        <p class="help">The passphrase is exchanged once and cleared. Even Hub stores only the returned bearer token.</p>
      </form>
    </main>
  `
  injectStyles()
  const settings = mountSettings(settingsActions)

  const status = requiredElement<HTMLSpanElement>('status')
  const header = requiredElement<HTMLParagraphElement>('mirror-header')
  const body = requiredElement<HTMLPreElement>('mirror-body')
  const url = requiredElement<HTMLInputElement>('bridge-url')
  const passphrase = requiredElement<HTMLInputElement>('bridge-passphrase')
  const form = requiredElement<HTMLFormElement>('connection-form')
  let recordDebugInput: CompanionUi['recordInput'] = () => {}
  let debugReady = () => {}
  if (debugToolsEnabled) {
    const inputStatus = requiredElement<HTMLParagraphElement>('input-status')
    const inputLog = requiredElement<HTMLOListElement>('input-log')
    let inputCount = 0
    const testStatus = requiredElement<HTMLParagraphElement>('display-test-status')
    const testReport = requiredElement<HTMLTextAreaElement>('display-test-report')
    const restore = requiredElement<HTMLButtonElement>('restore-display')
    let activeTest: AbortController | null = null
    function appendReport(line: string) {
      console.info('display-diagnostic', line)
      testReport.value = `${testReport.value}${line}\n`.split('\n').slice(-150).join('\n')
      testReport.scrollTop = testReport.scrollHeight
    }
    async function runTest(selection: DisplayTestSelection) {
      if (activeTest) return
      const controller = new AbortController()
      activeTest = controller
      app!.querySelectorAll<HTMLButtonElement>('[data-display-test], [data-input-event], #connection-form button').forEach(button => { button.disabled = true })
      restore.disabled = false
      testStatus.textContent = selection === 'card' ? 'Opening card.' : 'Testing. Watch the glasses display.'
      testReport.value = `T3 Bridge display report | ${new Date().toISOString()}\n`
      try {
        await onDisplayTest(selection, appendReport, controller.signal)
        testStatus.textContent = 'Finished. Check the report for accepted or failed steps.'
      } catch {
        appendReport('Test unavailable or restoration failed. Finish dictation before testing. If restoration failed, close and reopen the app.')
        testStatus.textContent = 'Test did not complete. See report.'
      } finally {
        activeTest = null
        restore.disabled = true
        app!.querySelectorAll<HTMLButtonElement>('[data-display-test], [data-input-event], #connection-form button').forEach(button => { button.disabled = false })
      }
    }
    requiredElement<HTMLButtonElement>('test-production-card').onclick = () => { void runTest('card') }
    requiredElement<HTMLButtonElement>('test-all-layouts').onclick = () => { void runTest('all') }
    restore.onclick = () => activeTest?.abort()
    const probes = requiredElement<HTMLDivElement>('display-probes')
    displayCases().forEach((test, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'input-button'
      button.dataset.displayTest = ''
      button.disabled = true
      button.textContent = test.name
      button.onclick = () => { void runTest(index) }
      probes.append(button)
    })
    requiredElement<HTMLButtonElement>('copy-display-report').onclick = async () => {
      try {
        await navigator.clipboard.writeText(testReport.value)
        testStatus.textContent = 'Report copied.'
      } catch {
        testReport.focus()
        testReport.select()
        testStatus.textContent = 'Report selected. Use your phone’s Copy command.'
      }
    }

    recordDebugInput = (label, detail) => {
      inputCount += 1
      const summary = `${label} | ${detail}`
      inputStatus.textContent = `#${inputCount} ${summary}`
      const row = document.createElement('li')
      row.textContent = `${new Date().toLocaleTimeString()} | ${summary}`
      inputLog.prepend(row)
      while (inputLog.children.length > 12) inputLog.lastElementChild?.remove()

    }
    debugReady = () => {
      app.querySelectorAll<HTMLButtonElement>('[data-display-test]').forEach(button => { button.disabled = false })
      testStatus.textContent = 'Ready. Open the production card first.'
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const request = { url: url.value.trim(), passphrase: passphrase.value }
    passphrase.value = ''
    void onPair(request)
  })
  app.querySelectorAll<HTMLButtonElement>('[data-input-event]').forEach((button) => {
    button.addEventListener('click', () => {
      const eventType = Number(button.dataset.inputEvent)
      if (!Number.isInteger(eventType)) return
      onInput(eventType as OsEventTypeList)
    })
  })

  requiredElement<HTMLButtonElement>('phone-pair').onclick = async () => {
    const node = requiredElement<HTMLElement>('phone-pair-code')
    try { node.textContent = await settingsActions?.createPhonePairing?.() ?? 'Connect to the bridge first.' }
    catch (error) { node.textContent = error instanceof Error ? error.message : String(error) }
  }
  requiredElement<HTMLInputElement>('phone-app-filter').oninput = () => {
    const query = requiredElement<HTMLInputElement>('phone-app-filter').value.trim().toLocaleLowerCase()
    document.querySelectorAll<HTMLElement>('#phone-apps label').forEach(label => { label.hidden = !label.dataset.search?.includes(query) })
  }
  let panelGeneration = 0
  let cardTransition: number | undefined
  return {
    setArrivalBanner(text) { const node = requiredElement<HTMLElement>('mirror-arrival'); node.textContent = text ?? ''; node.hidden = !text },
    setPhoneSettings(snapshot) {
      requiredElement<HTMLElement>('phone-status').textContent = snapshot.connected ? snapshot.permissionGranted ? 'Phone connected' : 'Enable notification access in Android settings.' : 'Phone disconnected. Actions unavailable.'
      const apps = requiredElement<HTMLElement>('phone-apps')
      apps.replaceChildren()
      for (const app of snapshot.apps) {
        const label = document.createElement('label')
        label.className = 'checkbox-label'
        label.dataset.search = `${app.name} ${app.packageName}`.toLocaleLowerCase()
        label.hidden = !label.dataset.search.includes(requiredElement<HTMLInputElement>('phone-app-filter').value.trim().toLocaleLowerCase())
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'
        toggle.checked = app.enabled
        toggle.disabled = !snapshot.connected
        toggle.onchange = async () => {
          toggle.disabled = true
          try { await settingsActions?.setPhoneAppEnabled?.(app.packageName, toggle.checked) }
          catch (error) { toggle.checked = app.enabled; requiredElement<HTMLElement>('phone-status').textContent = error instanceof Error ? error.message : String(error) }
          finally { toggle.disabled = !snapshot.connected }
        }
        label.append(toggle, document.createTextNode(`${app.name}${app.replyObserved ? ' · Reply supported' : ''}`))
        apps.append(label)
      }
    },
    setSettings: settings.setSettings,
    setSettingsStatus: settings.setStatus,
    setOsMirror: mountOsMirror(app.querySelector<HTMLElement>('.preview')!),
    setCardMirror(card) {
      const node = requiredElement<HTMLPreElement>('mirror-card')
      node.hidden = !card
      app.querySelector('.preview')!.classList.toggle('native-card', Boolean(card))
      node.style.transformOrigin = card?.entrance === 'down' ? 'top' : ''
      node.textContent = card ? `${card.title}\n\n${card.body}` : ''
      node.classList.toggle('notification-card', card?.presentation === 'notifications')
      node.classList.toggle('dashboard-card', card?.placement === 'dashboard')
      node.classList.toggle('plan-card', card?.presentation === 'plan')
      if (card?.entrance && card.transition !== cardTransition) {
        node.getAnimations().forEach(animation => animation.cancel())
        node.animate([
          { transform: card.entrance === 'down' ? 'scaleY(.6)' : card.entrance === 'bottom' ? 'translateY(100%)' : 'translateX(-15%)', opacity: .35 },
          { transform: 'translate(0)', opacity: 1 },
        ], { duration: 220, easing: 'ease-out' })
      }
      cardTransition = card?.transition
    },
    setDashboardMirror(left, panel, actions) {
      const generation = ++panelGeneration
      const node = requiredElement<HTMLPreElement>('mirror-left')
      node.hidden = left === null || Boolean(panel)
      node.textContent = left ?? ''
      requiredElement<HTMLDivElement>('mirror-columns').classList.toggle('dashboard-columns', left !== null)
      const canvas = requiredElement<HTMLCanvasElement>('mirror-panel')
      canvas.hidden = !panel
      canvas.setAttribute('aria-label', left ?? '')
      canvas.setAttribute('role', 'img')
      app.querySelector('.preview')!.classList.toggle('native-dashboard', Boolean(panel))
      const actionList = requiredElement<HTMLDivElement>('mirror-actions')
      actionList.hidden = !actions
      actionList.replaceChildren()
      app.querySelector('.preview')!.classList.toggle('dashboard-actions', Boolean(actions))
      app.querySelector('.preview')!.classList.toggle('pinned-notifications', Boolean(actions?.[0]?.previews?.length))
      app.querySelector('.preview')!.classList.toggle('dashboard-detail', Boolean(body.textContent))
      for (const action of actions ?? []) {
        const row = document.createElement('div')
        row.className = `mirror-action${action.selected ? ' selected' : ''}`
        row.classList.toggle('notification-preview', Boolean(action.previews?.length))
        row.textContent = `${action.selected ? '> ' : '  '}${action.label}${action.previews?.length ? '\n' + action.previews.join('\n') : ''}`
        row.setAttribute('aria-current', String(action.selected))
        actionList.append(row)
      }
      if (panel) void renderDashboardPanel(panel).then(rendered => {
        if (generation === panelGeneration) canvas.getContext('2d')!.drawImage(rendered, 0, 0)
      }).catch(() => { if (generation === panelGeneration) { canvas.hidden = true; node.hidden = false } })
    },
    setDiagnosticsReady: debugReady,
    setArchiveStatus(message) {
      requiredElement<HTMLParagraphElement>('archive-status').textContent = message
    },
    setConnectionStatus(kind, message) {
      if (kind !== 'connected') settings.disconnect()
      status.className = `status status-${kind}`
      status.textContent = message
    },
    setMirror(nextHeader, nextBody) {
      header.textContent = nextHeader
      body.textContent = nextBody
    },
    setProfile(profile) {
      url.value = profile.url
      passphrase.value = ''
    },
    recordInput: recordDebugInput,
  }
}

function inputGroup(label: string, group: 'gesture' | 'lifecycle' | 'sensor'): string {
  const buttons = INPUT_DEFINITIONS.filter((input) => input.group === group)
    .map((input) => `
      <button type="button" class="input-button${input.endsApp ? ' input-button-danger' : ''}"
        data-input-event="${input.eventType}">
        <span>${input.label}</span>
        <small>${inputCode(input.eventType)}</small>
      </button>`)
    .join('')
  return `
    <div class="input-group">
      <p class="input-group-label">${label}</p>
      <div class="input-grid">${buttons}</div>
    </div>`
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id} element`)
  return element as T
}

function injectStyles(): void {
  const style = document.createElement('style')
  style.textContent = `
    * { box-sizing: border-box; }
    .shell { width: min(100%, 720px); margin: 0 auto; padding: 24px; display: grid; gap: 20px; }
    .topbar { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
    .eyebrow { margin: 0 0 3px; color: #6eaa58; font-size: 11px; letter-spacing: .12em; }
    h1, h2 { margin: 0; font-weight: 600; }
    h1 { font-size: 22px; }
    h2 { font-size: 16px; }
    .status { max-width: 50%; border: 1px solid #465241; border-radius: 999px; padding: 5px 10px; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .status-connecting { color: #d8efcd; }
    .status-connected { color: #b8ff8a; border-color: #6eaa58; }
    .status-error { color: #ff938a; border-color: #99534d; }
    .preview { position: relative; overflow: hidden; width: 100%; aspect-ratio: 2 / 1; min-width: 0; min-height: 220px; border: 9px solid #0c0e0b; outline: 1px solid #3d463a;
      border-radius: 24px; background: #071006; color: #b8ff8a; padding: 16px 18px; display: grid;
      grid-template-rows: auto 1fr; gap: 8px; font: 13px/1.35 "SFMono-Regular", Consolas, monospace; }
    .os-layout > :not(.os-mirror) { visibility: hidden; }
    .preview.os-layout { min-height: 0; padding: 0; }
    .os-mirror { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 50; image-rendering: pixelated; }
    .preview-header { color: #6eaa58; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .preview-body { color: inherit; margin: 0; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; overflow: hidden; font: inherit; }
    #phone-apps { max-height: 320px; overflow-y: auto; display: grid; gap: 10px; }
    #phone-apps [hidden] { display: none; }
    #mirror-arrival { position: absolute; z-index: 40; top: 0; left: 1%; width: 98%; height: 19.5%; margin: 0; padding: 2px; border: 1px solid #8bd965; background: #000; color: #b8ff8a; overflow: hidden; white-space: pre; font: inherit; }
    #mirror-card { position: absolute; z-index: 20; inset: 10% 4.86%; margin: 0; padding: 8px; background: #000; border: 1px solid #8bd965; border-radius: 8px; white-space: pre-wrap; overflow: hidden; font: inherit; }
    #mirror-card.dashboard-card { inset: 10.07% 2.78% 10.07% 47.22%; }
    #mirror-card.notification-card { inset: 4.8611% 5.0347% 5.5556% 44.9653%; }
    #mirror-card.plan-card { inset: 20.14% 2.78% 3.47%; }
    .preview.native-card { container-type: inline-size; display: block; padding: 0; min-height: 0; aspect-ratio: auto; background: #000; }
    .preview.native-card::before { content: ''; display: block; padding-top: 50%; }
    .native-card .preview-header { position: absolute; inset: 0 0 auto; font: 3.47cqw/1.35 sans-serif; }
    .native-card #mirror-body { position: absolute; left: 0; top: 10.4167%; width: 100%; height: 89.5833%; padding: .347cqw; font: 3.47cqw/1.35 sans-serif; }
    .native-card #mirror-card { padding: 1.389cqw; font: 3.47cqw/1.35 sans-serif; }
    #mirror-columns { min-height: 0; }
    .dashboard-columns { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.92fr); gap: 16px; }
    .dashboard-columns #mirror-left { border-right: 1px solid #3d463a; padding-right: 8px; }
    .preview.native-dashboard { position: relative; container-type: inline-size; display: block; padding: 0; min-height: 0; background: #000; aspect-ratio: auto; overflow: hidden; }
    .preview.native-dashboard::before { content: ''; display: block; padding-top: 50%; }
    .native-dashboard #mirror-columns { display: block; }
    .native-dashboard #mirror-columns::before { content: ''; position: absolute; left: 40.1042%; top: 4.8611%; width: 54.8611%; height: 89.5833%; border: 1px solid #8bd965; border-radius: 6px; box-sizing: border-box; }
    .native-dashboard #mirror-panel { position: absolute; left: 0; top: 0; width: 38.1944%; height: 100%; filter: brightness(.9) sepia(1) saturate(4) hue-rotate(42deg); }
    .native-dashboard .preview-header { position: absolute; left: 42.8819%; top: 8.3333%; width: 48.9583%; font: 3.47cqw/1.2 sans-serif; }
    .native-dashboard #mirror-body { position: absolute; left: 40.1042%; top: 20.8333%; width: 54.8611%; height: 73.6111%; padding: 2.43cqw; font: 3.47cqw/1.35 sans-serif; }
    .dashboard-actions #mirror-columns::before { display: none; }
    .dashboard-actions #mirror-body { left: 42.8819%; top: 20.1389%; width: 50%; height: 18.75%; padding: 0; }
    #mirror-actions { position: absolute; left: 40.1042%; top: 22.2222%; width: 54.8611%; }
    .mirror-action { height: 9.0278cqw; margin-bottom: 2.7778cqw; padding: 1.3889cqw; border: 1px solid #41692f; border-radius: 6px; color: #6eaa58; white-space: pre; font: 3.47cqw/1.35 sans-serif; }
    .mirror-action.selected { color: #b8ff8a; }
    .dashboard-detail #mirror-actions { top: 43.0556%; }
    .dashboard-detail .mirror-action { height: 7.6389cqw; margin-bottom: 1.0417cqw; }
    .pinned-notifications #mirror-actions { left: 44.9653%; top: 4.8611%; width: 50%; }
    .pinned-notifications .preview-header, .pinned-notifications #mirror-body { visibility: hidden; }
    .pinned-notifications .mirror-action { height: 7.2917cqw; margin-bottom: 1.3889cqw; padding: 1.0417cqw; }
    .pinned-notifications .notification-preview { height: 26.7361cqw; margin-bottom: 1.7361cqw; }
    fieldset { border: 0; padding: 0; margin: 0; min-width: 0; display: grid; gap: 14px; }
    legend { color: #d8efcd; margin-bottom: 14px; }
    select { width: 100%; min-width: 0; border: 1px solid #465241; border-radius: 9px; background: #11140f; color: #e7eee3; padding: 10px 12px; }
    select:focus-visible { outline: 2px solid #6eaa58; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; }
    .checkbox-label input { width: auto; }
    .settings-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    a { color: #b8ff8a; }
    .card { display: grid; gap: 14px; border: 1px solid #3d463a; border-radius: 14px; padding: 18px; background: #20241e; }
    label { display: grid; gap: 6px; color: #aeb9a8; font-size: 13px; }
    input { width: 100%; border: 1px solid #465241; border-radius: 9px; background: #11140f; color: #e7eee3; padding: 10px 12px; }
    input:focus { outline: 2px solid #6eaa58; outline-offset: 1px; }
    button { justify-self: start; border: 0; border-radius: 9px; background: #d8efcd; color: #14200f; padding: 9px 14px; cursor: pointer; font-weight: 600; }
    button:disabled { opacity: .45; cursor: default; }
    textarea { width: 100%; resize: vertical; background: #11140f; color: #b8ff8a; padding: 10px; border: 1px solid #465241; border-radius: 8px; font: 12px/1.4 monospace; }
    summary { cursor: pointer; margin-bottom: 12px; }
    .input-card { gap: 12px; }
    .input-group { display: grid; gap: 7px; }
    .input-group-label { margin: 0; color: #aeb9a8; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
    .input-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 8px; }
    .input-button { justify-self: stretch; text-align: center; background: #30382c; color: #d8efcd; border: 1px solid #52634a; display: grid; gap: 2px; }
    .input-button small { color: #91a389; font: 9px/1.25 "SFMono-Regular", Consolas, monospace; overflow-wrap: anywhere; }
    .input-button:active { background: #6eaa58; color: #071006; }
    .input-button-danger { color: #ffaaa3; border-color: #99534d; }
    .input-status { margin: 2px 0 0; min-height: 34px; border-radius: 8px; background: #11140f; color: #b8ff8a; padding: 9px 10px; font: 12px/1.35 "SFMono-Regular", Consolas, monospace; }
    .input-log { max-height: 150px; margin: -4px 0 0; padding: 0 0 0 28px; overflow: auto; color: #aeb9a8; font: 11px/1.45 "SFMono-Regular", Consolas, monospace; }
    .input-log:empty { display: none; }
    .input-log li { padding: 3px 0; overflow-wrap: anywhere; }
    .help { margin: 0; color: #879080; font-size: 12px; }
    @media (max-width: 520px) { .shell { padding: 16px; } .preview { min-height: 235px; font-size: 10px; } .topbar { align-items: flex-start; } }
  `
  document.head.appendChild(style)
}
