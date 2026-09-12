import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountSettings, type SettingsActions } from './companion-settings'
import { defaultDashboardSettings, type DashboardSettings } from './dashboard-settings'
import { projectIdentity } from './protocol'
import { modelKey } from './view-model'

class Element {
  value = ''
  textContent = ''
  checked = false
  disabled = false
  children: Element[] = []
  private readonly listeners = new Map<string, (() => void)[]>()
  onclick: (() => unknown) | null = null
  onsubmit: ((event: { preventDefault(): void }) => unknown) | null = null
  get selectedIndex() { return this.children.findIndex(child => child.value === this.value) }
  replaceChildren() { this.children = []; this.value = '' }
  append(child: Element) { this.children.push(child) }
  addEventListener(event: string, callback: () => void) {
    this.listeners.set(event, [...this.listeners.get(event) ?? [], callback])
  }
  change(value: string) { this.value = value; this.listeners.get('change')?.forEach(callback => callback()) }
}
const project = { id: 'project', title: 'Assistant', updatedAt: '', canStartSession: true }
const model = { instanceId: 'provider', model: 'model', providerName: 'Provider', name: 'Model', isDefault: true,
  reasoningChoices: [{ id: 'high', label: 'High', isDefault: true }, { id: 'low', label: 'Low', isDefault: false }] }
const assistant = { projectId: project.id, modelSelection: { instanceId: model.instanceId, model: model.model, reasoningId: 'high' } }
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}
function setup(save: SettingsActions['save'] = async () => {}) {
  const elements = new Map<string, Element>()
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)!
  }
  vi.stubGlobal('document', { getElementById: element, createElement: () => new Element() })
  const actions = { save: vi.fn(save), reload: vi.fn(async () => {}), searchLocations: vi.fn(async () => []), askAssistant: vi.fn(), createTestNotifications: vi.fn(async () => {}) }
  const ui = mountSettings(actions)
  ui.setSettings(defaultDashboardSettings(), [project], [model])
  return { element, actions, ui }
}
afterEach(() => vi.unstubAllGlobals())

describe('assistant settings autosave', () => {
  it('routes the test notification button and disables it when disconnected', async () => {
    const { element, actions, ui } = setup(async () => {})
    await element('test-notifications').onclick?.()
    expect(actions.createTestNotifications).toHaveBeenCalledOnce()
    expect(element('test-notifications-status').textContent).toContain('Added 3 test notifications')
    ui.disconnect()
    expect(element('test-notifications').disabled).toBe(true)
    await element('test-notifications').onclick?.()
    expect(actions.createTestNotifications).toHaveBeenCalledOnce()
  })
  it('saves complete project/model/reasoning edits without form submission and restores selections after remount', async () => {
    let persisted: DashboardSettings = defaultDashboardSettings()
    const { element, actions } = setup(async settings => { persisted = settings })
    element('assistant-project').change(project.id)
    expect(actions.save).not.toHaveBeenCalled()
    element('assistant-model').change(modelKey(model))
    element('assistant-reasoning').change('high')
    await vi.waitFor(() => expect(persisted.assistant).toEqual(assistant))
    expect(element('assistant-settings-status').textContent).toContain('saved on this phone')
    const reopened = setup()
    reopened.ui.setSettings(persisted, [project], [model])
    expect(reopened.element('assistant-project').value).toBe(project.id)
    expect(reopened.element('assistant-model').value).toBe(modelKey(model))
    expect(reopened.element('assistant-reasoning').value).toBe('high')
    expect(reopened.actions.save).not.toHaveBeenCalled()
  })
  it('serializes and coalesces rapid edits so the latest selection wins', async () => {
    const first = deferred()
    const { element, actions, ui } = setup(async () => { if (actions.save.mock.calls.length === 1) await first.promise })
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-reasoning').change('low')
    element('assistant-reasoning').change('high')
    element('assistant-reasoning').change('low')
    expect(actions.save).toHaveBeenCalledTimes(1)
    first.resolve()
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalledTimes(2))
    expect(actions.save.mock.calls[1][0].assistant?.modelSelection.reasoningId).toBe('low')
    expect(element('assistant-settings-status').textContent).toContain('saved on this phone')
  })
  it('keeps unsaved weather edits separate while manual Save commits all fields', async () => {
    const { element, actions, ui } = setup()
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('weather-unit').value = 'celsius'
    element('assistant-reasoning').change('low')
    await vi.waitFor(() => expect(element('assistant-settings-status').textContent).toContain('saved on this phone'))
    expect(actions.save.mock.calls[0][0].weather.unit).toBe('fahrenheit')
    await element('dashboard-settings-form').onsubmit!({ preventDefault() {} })
    expect(actions.save.mock.calls.at(-1)![0].weather.unit).toBe('celsius')
  })
  it('retains a queued manual weather save when a newer assistant edit replaces the pending selection', async () => {
    const first = deferred()
    const { element, actions, ui } = setup(async () => { if (actions.save.mock.calls.length === 1) await first.promise })
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-reasoning').change('low')
    element('weather-unit').value = 'celsius'
    const manual = element('dashboard-settings-form').onsubmit!({ preventDefault() {} })
    element('assistant-reasoning').change('high')
    first.resolve()
    await manual
    expect(actions.save).toHaveBeenCalledTimes(2)
    expect(actions.save.mock.calls[1][0].weather.unit).toBe('celsius')
    expect(actions.save.mock.calls[1][0].assistant?.modelSelection.reasoningId).toBe('high')
  })
  it('persists an explicit Not configured choice without keeping the previous assistant', async () => {
    const { element, actions, ui } = setup()
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-project').change('')
    await vi.waitFor(() => expect(element('assistant-settings-status').textContent).toContain('saved on this phone'))
    expect(actions.save.mock.calls[0][0].assistant).toBeNull()
  })
  it('does not overwrite saved choices with incomplete or unavailable selections', () => {
    const { element, actions, ui } = setup()
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-model').change('unavailable')
    expect(actions.save).not.toHaveBeenCalled()
    expect(element('assistant-settings-status').textContent).toContain('Choose an available')
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [], [])
    expect(element('assistant-settings-status').textContent).toContain('Saved assistant is unavailable')
    expect(actions.save).not.toHaveBeenCalled()
  })
  it('restores and saves assistant choices within the selected environment', async () => {
    const remoteProject = { ...project, environmentId: 'studio', environmentLabel: 'Studio Mac' }
    const localModel = { ...model, environmentId: 'local' }
    const remoteModel = { ...model, environmentId: 'studio' }
    const remoteAssistant = { ...assistant, environmentId: 'studio' }
    const { element, actions, ui } = setup()
    ui.setSettings({ ...defaultDashboardSettings(), assistant: remoteAssistant },
      [{ ...project, environmentId: 'local', environmentLabel: 'This computer' }, remoteProject],
      [localModel, remoteModel])
    expect(element('assistant-project').value).toBe(projectIdentity(remoteProject))
    expect(element('assistant-model').children.filter((item: Element) => item.value === modelKey(model))).toHaveLength(1)
    element('assistant-reasoning').change('low')
    await vi.waitFor(() => expect(actions.save).toHaveBeenCalled())
    expect(actions.save.mock.calls.at(-1)![0].assistant).toEqual({
      ...remoteAssistant, modelSelection: { ...remoteAssistant.modelSelection, reasoningId: 'low' },
    })
  })
  it('reports failure beside assistant controls and allows an explicit retry', async () => {
    const { element, actions, ui } = setup(async () => { throw new Error('Native readback failed') })
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-reasoning').change('low')
    await vi.waitFor(() => expect(element('assistant-settings-status').textContent).toContain('not saved'))
    actions.save.mockResolvedValueOnce(undefined)
    await element('dashboard-settings-form').onsubmit!({ preventDefault() {} })
    expect(element('assistant-settings-status').textContent).toContain('saved on this phone')
  })
  it('discards queued saves when disconnected and never restores stale status', async () => {
    const pending = deferred()
    const { element, actions, ui } = setup(async () => pending.promise)
    ui.setSettings({ ...defaultDashboardSettings(), assistant }, [project], [model])
    element('assistant-reasoning').change('low')
    element('assistant-reasoning').change('high')
    ui.disconnect()
    pending.resolve()
    await vi.waitFor(() => expect(element('settings-reload').disabled).toBe(true))
    expect(actions.save).toHaveBeenCalledTimes(1)
    expect(element('assistant-settings-status').textContent).toBe('Connect to configure your assistant.')
  })
})
