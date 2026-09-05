import { AppLocationAccuracy, type AppLocation, type AppLocationOptions } from '@evenrealities/even_hub_sdk'
import { validCoordinates, type WeatherSettings } from './dashboard-settings'
import type { WeatherCurrentResult } from './protocol'

export const WEATHER_REFRESH_MS = 15 * 60_000
const STALE_LIMIT_MS = 60 * 60_000
const LOCATION_RECOVERY_DELAY_MS = 30_000
export interface WeatherDisplay {
  lines: string[]
  status: 'disabled' | 'setup' | 'loading' | 'ready' | 'stale' | 'unavailable'
  source: 'phone' | 'city' | null
}
interface WeatherDependencies {
  getAppLocation(options: AppLocationOptions): Promise<AppLocation | null>
  requestCurrent(position: { latitude: number; longitude: number }): Promise<WeatherCurrentResult>
  now?: () => number
}
interface ActiveLocation {
  key: string
  source: 'phone' | 'city'
}
function settingsKey(settings: WeatherSettings): string {
  return JSON.stringify([settings.enabled, settings.fallbackCity?.id,
    settings.fallbackCity?.latitude, settings.fallbackCity?.longitude])
}
function validWeather(value: WeatherCurrentResult, now: number): boolean {
  return value !== null && typeof value === 'object' &&
    typeof value.temperatureC === 'number' && Number.isFinite(value.temperatureC) &&
    value.temperatureC >= -100 && value.temperatureC <= 70 && typeof value.condition === 'string' &&
    value.condition.length > 0 && value.condition.length <= 40 && !/[\p{Cc}\p{Cf}]/u.test(value.condition) &&
    typeof value.observedAt === 'string' && value.observedAt.length <= 40 &&
    Math.abs(now - Date.parse(value.observedAt)) <= STALE_LIMIT_MS &&
    typeof value.fetchedAt === 'string' && value.fetchedAt.length <= 40 &&
    now - Date.parse(value.fetchedAt) >= -60_000 && now - Date.parse(value.fetchedAt) <= STALE_LIMIT_MS
}

/** All live coordinates remain in memory; only rounded coordinates reach the bridge. */
export class WeatherController {
  private readonly cache = new Map<string, WeatherCurrentResult>()
  private readonly now: () => number
  private active: ActiveLocation | null = null
  private activeSettings = ''
  private status: WeatherDisplay['status'] = 'loading'
  private lastAttempt = Number.NEGATIVE_INFINITY
  private locationRetryAt: number | null = null
  private locationRetryAvailable = true
  private pending: Promise<WeatherDisplay> | null = null
  private generation = 0

  constructor(private readonly dependencies: WeatherDependencies) {
    this.now = dependencies.now ?? Date.now
  }

  reset(): void {
    this.generation += 1
    this.cache.clear()
    this.active = null
    this.activeSettings = ''
    this.pending = null
    this.lastAttempt = Number.NEGATIVE_INFINITY
    this.locationRetryAt = null
    this.locationRetryAvailable = true
    this.status = 'loading'
  }

  display(settings: WeatherSettings): WeatherDisplay {
    if (!settings.enabled) return { lines: [], status: 'disabled', source: null }
    if (settingsKey(settings) !== this.activeSettings) return { lines: ['Loading weather'], status: 'loading', source: null }
    const current = this.active ? this.cache.get(this.active.key) : undefined
    if (current) {
      const age = Math.max(this.now() - Date.parse(current.fetchedAt), this.now() - Date.parse(current.observedAt))
      if (age <= STALE_LIMIT_MS) {
        const stale = this.status === 'unavailable' || this.now() - Date.parse(current.fetchedAt) >= WEATHER_REFRESH_MS
        const degrees = settings.unit === 'fahrenheit' ? current.temperatureC * 9 / 5 + 32 : current.temperatureC
        const lines = [`${Math.round(degrees)}°${settings.unit === 'fahrenheit' ? 'F' : 'C'}`, current.condition]
        if (this.active?.source === 'city' || stale) lines.push([this.active?.source === 'city' ? 'Saved city' : '', stale ? 'stale' : ''].filter(Boolean).join(' · '))
        return { lines, status: stale ? 'stale' : 'ready', source: this.active?.source ?? null }
      }
    }
    const status = this.status === 'setup' ? 'setup' : this.status === 'loading' ? 'loading' : 'unavailable'
    return { lines: [status === 'setup' ? 'Set weather location' : status === 'loading' ? 'Loading weather' : 'Weather unavailable'],
      status, source: this.active?.source ?? null }
  }

  refresh(settings: WeatherSettings, force = false): Promise<WeatherDisplay> {
    const key = settingsKey(settings)
    if (key !== this.activeSettings) {
      this.generation += 1
      this.activeSettings = key
      this.pending = null
      this.active = null
      this.lastAttempt = Number.NEGATIVE_INFINITY
      this.locationRetryAt = null
      this.locationRetryAvailable = true
      this.status = 'loading'
    }
    if (!settings.enabled) return Promise.resolve(this.display(settings))
    if (this.pending) return this.pending
    const recoveryDue = this.locationRetryAt !== null && this.now() >= this.locationRetryAt
    if (!force && !recoveryDue && this.now() - this.lastAttempt < WEATHER_REFRESH_MS) return Promise.resolve(this.display(settings))
    this.locationRetryAt = null
    this.lastAttempt = this.now()
    const generation = this.generation
    this.status = 'loading'
    // A new lookup can discover movement. Do not attribute old weather to it.
    this.active = null
    const pending = this.update(settings, generation).then(() => this.display(settings)).finally(() => {
      if (this.pending === pending) this.pending = null
    })
    this.pending = pending
    return pending
  }

  private async phoneLocation(): Promise<AppLocation | null> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.dependencies.getAppLocation({ accuracy: AppLocationAccuracy.Low, timeoutMs: 5000 })),
        new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 5000) }),
      ])
    } catch { return null }
    finally { clearTimeout(timer) }
  }

  private async update(settings: WeatherSettings, generation: number): Promise<void> {
    const phone = await this.phoneLocation()
    if (generation !== this.generation) return
    const source = validCoordinates(phone) ? 'phone' : 'city'
    if (source === 'phone') {
      this.locationRetryAvailable = true
      this.locationRetryAt = null
    } else if (this.locationRetryAvailable) {
      // A first permission prompt or cold location fix can outlast five seconds.
      // Let the next dashboard tick retry once, then keep the normal cadence.
      this.locationRetryAvailable = false
      this.locationRetryAt = this.now() + LOCATION_RECOVERY_DELAY_MS
    }
    const location = source === 'phone' ? phone : settings.fallbackCity
    if (!validCoordinates(location)) { this.status = 'setup'; return }
    const position = { latitude: Math.round(location.latitude * 100) / 100, longitude: Math.round(location.longitude * 100) / 100 }
    const key = `${position.latitude},${position.longitude}`
    this.active = { key, source }
    const existing = this.cache.get(key)
    if (existing && this.now() - Date.parse(existing.fetchedAt) < WEATHER_REFRESH_MS) {
      this.status = 'ready'
      return
    }
    try {
      const current = await this.dependencies.requestCurrent(position)
      if (generation !== this.generation) return
      if (!validWeather(current, this.now())) throw new Error('Invalid weather response')
      this.cache.delete(key)
      this.cache.set(key, { temperatureC: current.temperatureC, condition: current.condition,
        fetchedAt: current.fetchedAt, observedAt: current.observedAt })
      while (this.cache.size > 16) this.cache.delete(this.cache.keys().next().value!)
      this.status = 'ready'
    } catch { if (generation === this.generation) this.status = 'unavailable' }
  }
}
