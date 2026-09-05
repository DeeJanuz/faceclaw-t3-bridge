import { normalizeBridgeWebSocketUrl } from './connection-profile'
import type { ModelSummary, NewSessionModelSelection, ProjectSummary, WeatherLocation } from './protocol'

export interface WeatherSettings {
  enabled: boolean
  unit: 'fahrenheit' | 'celsius'
  fallbackCity: WeatherLocation | null
}
export interface AssistantSettings {
  projectId: string
  modelSelection: NewSessionModelSelection
}
export interface DashboardSettings {
  assistant: AssistantSettings | null
  weather: WeatherSettings
}
export interface DashboardStorage {
  getLocalStorage(key: string): Promise<string | null>
  setLocalStorage(key: string, value: string): Promise<boolean>
}

export function defaultDashboardSettings(): DashboardSettings {
  return { assistant: null, weather: { enabled: true, unit: 'fahrenheit', fallbackCity: null } }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}
function text(value: unknown, max = 200): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max &&
    value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)
}
export function validCoordinates(value: unknown): value is Record<string, unknown> & { latitude: number; longitude: number } {
  const r = record(value)
  return r !== null && typeof r.latitude === 'number' && Number.isFinite(r.latitude) &&
    Math.abs(r.latitude) <= 90 && typeof r.longitude === 'number' &&
    Number.isFinite(r.longitude) && Math.abs(r.longitude) <= 180
}
export function parseWeatherLocation(value: unknown): WeatherLocation | null {
  const r = record(value)
  if (!r || !validCoordinates(r) || !text(r.id) || !text(r.name, 100) ||
      !(r.region === '' || text(r.region, 100)) || !text(r.country, 100)) return null
  return { id: r.id, name: r.name, region: r.region, country: r.country,
    latitude: Math.round(r.latitude * 100) / 100, longitude: Math.round(r.longitude * 100) / 100 }
}
function assistantSettings(value: unknown): AssistantSettings | null {
  const r = record(value)
  const model = record(r?.modelSelection)
  if (!r || !model || !text(r.projectId) || !/^[A-Za-z0-9._:-]+$/.test(r.projectId) ||
      !text(model.instanceId) || !text(model.model, 256) ||
      !(model.reasoningId === undefined || text(model.reasoningId))) return null
  return { projectId: r.projectId, modelSelection: { instanceId: model.instanceId, model: model.model,
    ...(model.reasoningId === undefined ? {} : { reasoningId: model.reasoningId }) } }
}
export function parseDashboardSettings(value: unknown): DashboardSettings {
  const r = record(value)
  const weather = record(r?.weather)
  return { assistant: assistantSettings(r?.assistant), weather: {
    enabled: typeof weather?.enabled === 'boolean' ? weather.enabled : true,
    unit: weather?.unit === 'celsius' ? 'celsius' : 'fahrenheit',
    fallbackCity: parseWeatherLocation(weather?.fallbackCity),
  } }
}
function settingsKey(url: string): string {
  return `t3-dashboard-settings-v1:${normalizeBridgeWebSocketUrl(url)}`
}
export async function loadDashboardSettings(storage: DashboardStorage, url: string): Promise<DashboardSettings> {
  try {
    const raw = await storage.getLocalStorage(settingsKey(url))
    return typeof raw === 'string' && raw.length > 0 && raw.length <= 8192
      ? parseDashboardSettings(JSON.parse(raw)) : defaultDashboardSettings()
  } catch { return defaultDashboardSettings() }
}
export async function saveDashboardSettings(storage: DashboardStorage, url: string, settings: DashboardSettings): Promise<boolean> {
  try {
    const key = settingsKey(url)
    const serialized = JSON.stringify(parseDashboardSettings(settings))
    if (await storage.setLocalStorage(key, serialized) !== true) return false
    // The SDK forwards host values without runtime type checks. Confirm that
    // the native store actually retained the exact string before reporting save.
    return await storage.getLocalStorage(key) === serialized
  } catch { return false }
}
export function validateAssistantSelection(
  assistant: AssistantSettings | null, projects: readonly ProjectSummary[], models: readonly ModelSummary[],
): boolean {
  const safe = assistantSettings(assistant)
  if (!safe || !projects.some(p => p.id === safe.projectId && p.canStartSession)) return false
  const selected = safe.modelSelection
  return models.some(model => model.instanceId === selected.instanceId && model.model === selected.model &&
    (selected.reasoningId === undefined || model.reasoningChoices.some(r => r.id === selected.reasoningId)))
}
