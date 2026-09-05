import { describe, expect, it } from 'vitest'
import { EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { defaultDashboardSettings, loadDashboardSettings, saveDashboardSettings, parseDashboardSettings, validateAssistantSelection } from './dashboard-settings'
import type { ModelSummary, ProjectSummary } from './protocol'

describe('dashboard preference boundaries', () => {
  it('restores project, model and reasoning through a new SDK wrapper after saving', async () => {
    const native = new Map<string, string>()
    const open = () => {
      const host = { callEvenApp: async (method: string, params: { key: string; value?: string }) => {
        if (method === 'setLocalStorage') { native.set(params.key, params.value!); return true }
        return native.get(params.key) ?? ''
      } }
      return {
        getLocalStorage: (key: string) => EvenAppBridge.prototype.getLocalStorage.call(host as unknown as EvenAppBridge, key),
        setLocalStorage: (key: string, value: string) => EvenAppBridge.prototype.setLocalStorage.call(host as unknown as EvenAppBridge, key, value),
      }
    }
    const settings = { ...defaultDashboardSettings(), assistant: {
      projectId: 'project-123', modelSelection: { instanceId: 'codex-personal', model: 'openai/gpt-5.6', reasoningId: 'high' },
    } }
    expect(await saveDashboardSettings(open(), 'wss://BRIDGE.example:443/v1/events', settings)).toBe(true)
    expect(await loadDashboardSettings(open(), 'wss://bridge.example/v1/events')).toEqual(settings)
    expect((await loadDashboardSettings(open(), 'wss://other.example/v1/events')).assistant).toBeNull()
  })
  it('requires an actual boolean acknowledgement and matching native readback', async () => {
    const settings = defaultDashboardSettings()
    for (const acknowledgement of [false, null, 'true', { ok: true }]) {
      expect(await saveDashboardSettings({ getLocalStorage: async () => JSON.stringify(settings),
        setLocalStorage: async () => acknowledgement as boolean }, 'ws://localhost/v1/events', settings)).toBe(false)
    }
    for (const readback of [null, '', '{}', JSON.stringify({ ...settings, assistant: { projectId: 'wrong' } })]) {
      expect(await saveDashboardSettings({ getLocalStorage: async () => readback,
        setLocalStorage: async () => true }, 'ws://localhost/v1/events', settings)).toBe(false)
    }
    expect(await saveDashboardSettings({ getLocalStorage: async () => { throw new Error('host read failed') },
      setLocalStorage: async () => true }, 'ws://localhost/v1/events', settings)).toBe(false)
  })
  it('preserves model names up to the existing bridge limit instead of dropping the assistant on reload', async () => {
    let value = ''
    const storage = { getLocalStorage: async () => value, setLocalStorage: async (_key: string, next: string) => { value = next; return true } }
    const settings = { ...defaultDashboardSettings(), assistant: {
      projectId: 'project', modelSelection: { instanceId: 'provider', model: 'm'.repeat(256), reasoningId: 'high' },
    } }
    expect(await saveDashboardSettings(storage, 'ws://localhost/v1/events', settings)).toBe(true)
    expect(await loadDashboardSettings(storage, 'ws://localhost/v1/events')).toEqual(settings)
    expect(parseDashboardSettings({ ...settings, assistant: { ...settings.assistant,
      modelSelection: { ...settings.assistant.modelSelection, model: 'm'.repeat(257) } } }).assistant).toBeNull()
  })
  it('isolates normalized endpoints and only stores allowed fields, never credentials', async () => {
    const values = new Map<string, string>()
    const storage = { getLocalStorage: async (key: string) => values.get(key) ?? null,
      setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true } }
    const settings = { ...defaultDashboardSettings(), token: 'private', weather: { enabled: false, unit: 'celsius' as const, fallbackCity: null } }
    expect(await saveDashboardSettings(storage, 'wss://BRIDGE.example:443/v1/events', settings)).toBe(true)
    expect((await loadDashboardSettings(storage, 'wss://bridge.example/v1/events')).weather.enabled).toBe(false)
    expect((await loadDashboardSettings(storage, 'wss://other.example/v1/events')).weather.enabled).toBe(true)
    expect([...values.values()].join()).not.toContain('private')
    expect(await saveDashboardSettings(storage, 'wss://user:secret@bridge.example/v1/events', settings)).toBe(false)
  })
  it('handles missing, corrupt, oversized and failed storage', async () => {
    for (const raw of [null, '{', 'x'.repeat(9000)]) {
      expect(await loadDashboardSettings({ getLocalStorage: async () => raw, setLocalStorage: async () => false }, 'ws://localhost/v1/events')).toEqual(defaultDashboardSettings())
    }
    const storage = { getLocalStorage: async (): Promise<string> => { throw new Error('unavailable') }, setLocalStorage: async (): Promise<boolean> => { throw new Error('unavailable') } }
    expect(await loadDashboardSettings(storage, 'ws://localhost/v1/events')).toEqual(defaultDashboardSettings())
    expect(await saveDashboardSettings(storage, 'ws://localhost/v1/events', defaultDashboardSettings())).toBe(false)
  })
  it('drops malformed selections and city locations and rounds persisted city coordinates', () => {
    const city = { id: '1', name: 'Denver', region: 'Colorado', country: 'United States', latitude: 39.7392, longitude: -104.9903 }
    expect(parseDashboardSettings({ weather: { fallbackCity: city } }).weather.fallbackCity?.latitude).toBe(39.74)
    expect(parseDashboardSettings({ weather: { fallbackCity: { ...city, latitude: 999 } }, assistant: { projectId: '../private' } }).assistant).toBeNull()
    expect(parseDashboardSettings({ weather: { fallbackCity: { ...city, name: 'city\nspoof' } } }).weather.fallbackCity).toBeNull()
  })
  it('requires a current startable project, model and advertised reasoning', () => {
    const assistant = { projectId: 'p', modelSelection: { instanceId: 'provider', model: 'model', reasoningId: 'high' } }
    const projects: ProjectSummary[] = [{ id: 'p', title: 'Assistant', canStartSession: true, updatedAt: '' }]
    const models: ModelSummary[] = [{ instanceId: 'provider', model: 'model', name: 'Model', providerName: 'Provider', isDefault: true, reasoningChoices: [{ id: 'high', label: 'High', isDefault: true }] }]
    expect(validateAssistantSelection(assistant, projects, models)).toBe(true)
    expect(validateAssistantSelection(assistant, [], models)).toBe(false)
    expect(validateAssistantSelection(assistant, [{ ...projects[0], canStartSession: false }], models)).toBe(false)
    expect(validateAssistantSelection(assistant, projects, [])).toBe(false)
    expect(validateAssistantSelection(assistant, projects, [{ ...models[0], reasoningChoices: [] }])).toBe(false)
  })
})
