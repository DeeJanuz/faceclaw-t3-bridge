import { debugToolsEnabled } from './debug-tools'
import { defaultDashboardSettings, parseDashboardSettings, validateAssistantSelection, type DashboardSettings } from './dashboard-settings'
import type { ModelSummary, ProjectSummary, WeatherLocation } from './protocol'
import { modelKey } from './view-model'

export interface SettingsActions {
  setPhoneAppEnabled?(packageName: string, enabled: boolean): Promise<void>
  createPhonePairing?(): Promise<string>
  save(settings: DashboardSettings): Promise<void>
  reload(): Promise<void>
  searchLocations(query: string): Promise<WeatherLocation[]>
  askAssistant(): void
  createTestNotifications?(): Promise<void>
}

export const settingsMarkup = `
  <section class="card" aria-labelledby="dashboard-settings-heading">
    <h2 id="dashboard-settings-heading">Dashboard settings</h2>
    <form id="dashboard-settings-form">
      <fieldset id="dashboard-settings-fields" disabled>
        <legend>Quick assistant</legend>
        <label>Assistant project<select id="assistant-project"><option value="">Not configured</option></select></label>
        <p class="help">Register your assistant context directory as a project in T3 Code, then select it here.</p>
        <label>Model<select id="assistant-model"></select></label>
        <label>Reasoning<select id="assistant-reasoning"></select></label>
        <p id="assistant-settings-status" class="help" role="status">Assistant choices save automatically when a project and model are selected.</p>
        <p class="help">Wait for "Assistant choices saved on this phone" before closing the app.</p>
        <p class="help">Each shortcut starts a fresh conversation with full access, without supervised approval prompts.</p>
        <label class="checkbox-label"><input id="weather-enabled" type="checkbox"> Show weather</label>
        <label>Temperature<select id="weather-unit"><option value="fahrenheit">Fahrenheit (°F)</option><option value="celsius">Celsius (°C)</option></select></label>
        <label>Find fallback city<input id="weather-city-query" type="search" maxlength="100" placeholder="City, region or country"></label>
        <button type="button" id="weather-city-search">Search cities</button>
        <label>Fallback city<select id="weather-city"><option value="">No fallback city</option></select></label>
        <p class="help">Your phone location is used automatically. A fallback city is optional. On Android, allow Location for the Even Realities app in phone settings. Approximate coordinates go through your computer to Open-Meteo. Phone location is not saved.</p>
        <button type="submit">Save dashboard settings</button>
      </fieldset>
    </form>
    <div class="settings-actions">
      <button type="button" id="settings-reload">Reload choices</button>
      <button type="button" id="assistant-shortcut">Ask assistant</button>
    </div>
    ${debugToolsEnabled ? `
    <button type="button" id="test-notifications" disabled>Add 3 test notifications</button>
    <p class="help">Adds clearly labeled local samples, including a long response. They disappear when the app reconnects or closes.</p>
    <p id="test-notifications-status" class="help" role="status"></p>
    ` : '<!-- Synthetic notification controls are disabled in beta builds. -->'}
    <p id="settings-status" class="help" role="status">Connect to configure your dashboard.</p>
    <p class="help">Weather data by <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>. City data by GeoNames. Phone reply notifications are controlled by the Android app toggles above.</p>
  </section>`

export function mountSettings(actions?: SettingsActions) {
  const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
  const fieldset = element<HTMLFieldSetElement>('dashboard-settings-fields')
  const project = element<HTMLSelectElement>('assistant-project')
  const model = element<HTMLSelectElement>('assistant-model')
  const reasoning = element<HTMLSelectElement>('assistant-reasoning')
  const enabled = element<HTMLInputElement>('weather-enabled')
  const unit = element<HTMLSelectElement>('weather-unit')
  const city = element<HTMLSelectElement>('weather-city')
  const status = element<HTMLParagraphElement>('settings-status')
  const assistantStatus = element<HTMLParagraphElement>('assistant-settings-status')
  let models: ModelSummary[] = []
  let projects: ProjectSummary[] = []
  let cities: WeatherLocation[] = []
  let connected = false
  let revision = 0
  let searchRevision = 0
  let assistantEdit = 0
  let savedSettings = defaultDashboardSettings()
  let pendingSave: { settings: DashboardSettings; all: boolean; revision: number; edit: number } | null = null
  let saving: Promise<void> | null = null
  const setStatus = (message: string) => { status.textContent = message }
  function option(select: HTMLSelectElement, value: string, label: string) {
    const node = document.createElement('option')
    node.value = value
    node.textContent = label
    select.append(node)
  }
  function reasoningChoices(selected?: string) {
    const choice = models.find(item => modelKey(item) === model.value)
    reasoning.replaceChildren()
    option(reasoning, '', 'Provider default')
    choice?.reasoningChoices.forEach(item => option(reasoning, item.id, item.label))
    reasoning.value = selected ?? ''
    if (reasoning.selectedIndex < 0) {
      option(reasoning, selected ?? '', 'Saved reasoning unavailable')
      reasoning.value = selected ?? ''
    }
    reasoning.disabled = !choice?.reasoningChoices.length
  }
  function cityChoices(selected?: string) {
    city.replaceChildren()
    option(city, '', 'No fallback city')
    cities.forEach(item => option(city, String(item.id), [item.name, item.region, item.country].filter(Boolean).join(', ')))
    city.value = selected ?? ''
  }
  function selectedAssistant(): DashboardSettings['assistant'] | undefined {
    if (!project.value) return null
    const choice = models.find(item => modelKey(item) === model.value)
    if (!choice) return undefined
    const assistant = { projectId: project.value, modelSelection: {
      instanceId: choice.instanceId, model: choice.model, ...(reasoning.value ? { reasoningId: reasoning.value } : {}),
    } }
    return validateAssistantSelection(assistant, projects, models) ? assistant : undefined
  }
  function flushSaves(): void {
    if (saving || !actions) return
    const run = async () => {
      while (pendingSave) {
        const next = pendingSave
        pendingSave = null
        if (next.revision !== revision || !connected) continue
        const settings = next.all ? next.settings : { ...next.settings, weather: savedSettings.weather }
        if (next.edit === assistantEdit) assistantStatus.textContent = 'Saving assistant choices...'
        if (next.all) setStatus('Saving dashboard settings...')
        try {
          await actions.save(settings)
          if (next.revision !== revision) continue
          savedSettings = parseDashboardSettings(settings)
          if (next.edit === assistantEdit) assistantStatus.textContent = 'Assistant choices saved on this phone.'
          if (next.all && !pendingSave) setStatus('Dashboard settings saved.')
        } catch (error) {
          if (next.revision !== revision) continue
          const message = error instanceof Error ? error.message : 'Settings could not be saved.'
          if (next.edit === assistantEdit) assistantStatus.textContent = `Assistant choices not saved. ${message}`
          setStatus(message)
        }
      }
    }
    saving = run().finally(() => {
      saving = null
      element<HTMLButtonElement>('settings-reload').disabled = !connected
      if (pendingSave) flushSaves()
    })
  }
  function queueSave(settings: DashboardSettings, all: boolean): void {
    // An assistant change must not discard a queued explicit weather save.
    if (!all && pendingSave?.all && pendingSave.revision === revision) {
      settings = { ...settings, weather: pendingSave.settings.weather }
      all = true
    }
    pendingSave = { settings: parseDashboardSettings(settings), all, revision, edit: assistantEdit }
    assistantStatus.textContent = 'Saving assistant choices...'
    element<HTMLButtonElement>('settings-reload').disabled = true
    flushSaves()
  }
  function autosaveAssistant(): void {
    if (!actions || !connected) return
    assistantEdit += 1
    const assistant = selectedAssistant()
    if (assistant === undefined) {
      pendingSave = null
      assistantStatus.textContent = 'Choose an available project, model, and reasoning level to save.'
      return
    }
    queueSave({ assistant, weather: savedSettings.weather }, false)
  }
  project.addEventListener('change', autosaveAssistant)
  model.addEventListener('change', () => { reasoningChoices(); autosaveAssistant() })
  reasoning.addEventListener('change', autosaveAssistant)
  element<HTMLButtonElement>('settings-reload').onclick = () => {
    void actions?.reload().catch(() => setStatus('Could not reload choices. Connect and retry.'))
  }
  element<HTMLButtonElement>('assistant-shortcut').onclick = () => actions?.askAssistant()
  const testButton = element<HTMLButtonElement>('test-notifications')
  const testStatus = element<HTMLParagraphElement>('test-notifications-status')
  if (testButton) {
    testButton.disabled = true
    testButton.onclick = async () => {
      if (!connected || !actions?.createTestNotifications || testButton.disabled) return
      const current = revision
      testButton.disabled = true
      try {
        await actions.createTestNotifications()
        if (current === revision) testStatus.textContent = 'Added 3 test notifications.'
      } catch {
        if (current === revision) testStatus.textContent = 'Could not add test notifications. Connect and retry.'
      } finally { testButton.disabled = !connected || !actions?.createTestNotifications }
    }

  }

  element<HTMLButtonElement>('weather-city-search').onclick = async () => {
    if (!actions || !connected) return
    const current = revision
    const search = ++searchRevision
    const button = element<HTMLButtonElement>('weather-city-search')
    button.disabled = true
    setStatus('Searching cities...')
    try {
      const results = await actions.searchLocations(element<HTMLInputElement>('weather-city-query').value.trim())
      if (current !== revision || search !== searchRevision) return
      const selected = cities.find(item => String(item.id) === city.value)
      cities = selected && !results.some(item => item.id === selected.id) ? [selected, ...results] : results
      cityChoices(selected ? String(selected.id) : undefined)
      setStatus(results.length ? 'Select a city, then save settings.' : 'No matching cities. Try adding a region or country.')
    } catch (error) {
      if (current === revision && search === searchRevision) setStatus(error instanceof Error ? error.message : 'City search unavailable.')
    } finally { if (current === revision && search === searchRevision) button.disabled = false }
  }
  element<HTMLFormElement>('dashboard-settings-form').onsubmit = async event => {
    event.preventDefault()
    if (!actions || !connected) return
    const assistant = selectedAssistant()
    if (assistant === undefined) { setStatus('Select an available assistant project, model, and reasoning level.'); return }
    const settings: DashboardSettings = {
      assistant,
      weather: {
        enabled: enabled.checked,
        unit: unit.value === 'celsius' ? 'celsius' : 'fahrenheit',
        fallbackCity: cities.find(item => String(item.id) === city.value) ?? null,
      },
    }
    queueSave(settings, true)
    await saving
  }
  return {
    setStatus,
    disconnect() {
      revision += 1
      pendingSave = null
      connected = false
      if (testButton) testButton.disabled = true
      if (testStatus) testStatus.textContent = ''
      fieldset.disabled = true
      setStatus('Connect to configure your dashboard.')
      assistantStatus.textContent = 'Connect to configure your assistant.'
    },
    setSettings(settings: DashboardSettings, projectChoices: ProjectSummary[], choices: ModelSummary[]) {
      revision += 1
      pendingSave = null
      assistantEdit += 1
      savedSettings = parseDashboardSettings(settings)
      projects = projectChoices
      connected = true
      if (testButton) testButton.disabled = !actions?.createTestNotifications
      fieldset.disabled = !actions
      element<HTMLButtonElement>('weather-city-search').disabled = false
      element<HTMLButtonElement>('settings-reload').disabled = saving !== null
      project.replaceChildren()
      option(project, '', 'Not configured')
      projects.filter(item => item.canStartSession).forEach(item => option(project, item.id, item.title))
      project.value = settings.assistant?.projectId ?? ''
      if (project.selectedIndex < 0 && settings.assistant) {
        option(project, settings.assistant.projectId, 'Saved project unavailable')
        project.value = settings.assistant.projectId
      }
      models = choices
      model.replaceChildren()
      option(model, '', 'Choose a model')
      models.forEach(item => option(model, modelKey(item), `${item.providerName} · ${item.name}`))
      model.value = settings.assistant ? modelKey(settings.assistant.modelSelection) : ''
      if (model.selectedIndex < 0 && settings.assistant) {
        option(model, modelKey(settings.assistant.modelSelection), 'Saved model unavailable')
        model.value = modelKey(settings.assistant.modelSelection)
      }
      reasoningChoices(settings.assistant?.modelSelection.reasoningId)
      enabled.checked = settings.weather.enabled
      unit.value = settings.weather.unit
      cities = settings.weather.fallbackCity ? [settings.weather.fallbackCity] : []
      cityChoices(settings.weather.fallbackCity ? String(settings.weather.fallbackCity.id) : undefined)
      assistantStatus.textContent = settings.assistant
        ? validateAssistantSelection(settings.assistant, projects, models)
          ? 'Saved assistant choices restored.' : 'Saved assistant is unavailable. Choose an available project, model, and reasoning level.'
        : 'Assistant choices save automatically when a project and model are selected.'
      setStatus('Assistant choices save automatically. Use Save dashboard settings for weather changes.')
    },
  }
}
