import { afterEach, describe, expect, it, vi } from 'vitest'
import { WeatherController, WEATHER_REFRESH_MS } from './weather'
import { defaultDashboardSettings } from './dashboard-settings'

const settings = defaultDashboardSettings().weather
const city = { id: '1', name: 'Denver', region: 'Colorado', country: 'United States', latitude: 39.74, longitude: -104.99 }
const start = Date.parse('2026-09-04T12:00:00.000Z')
const current = (at = start) => ({ temperatureC: 20, condition: 'Partly cloudy', observedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString() })

afterEach(() => vi.useRealTimers())
describe('weather location privacy and display lifecycle', () => {
  it('recovers a missing first phone fix on the next dashboard tick', async () => {
    let now = start
    const getAppLocation = vi.fn().mockResolvedValueOnce(null).mockResolvedValue(city)
    const requestCurrent = vi.fn(async () => current(now))
    const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => now })
    expect((await weather.refresh(settings)).status).toBe('setup')
    now += 29_999
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(1)
    now = start + 60_000
    expect((await weather.refresh(settings)).source).toBe('phone')
    expect(getAppLocation).toHaveBeenCalledTimes(2)
    expect(requestCurrent).toHaveBeenCalledOnce()
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(2)
  })
  it('allows only one early retry after denial, then resumes the normal cadence until reset', async () => {
    let now = start
    const getAppLocation = vi.fn(async () => { throw new Error('denied') })
    const requestCurrent = vi.fn(async () => current(now))
    const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => now })
    await weather.refresh(settings)
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(2)
    for (let minute = 2; minute < 16; minute++) {
      now = start + minute * 60_000
      await weather.refresh(settings)
    }
    expect(getAppLocation).toHaveBeenCalledTimes(2)
    now = start + 16 * 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(3)
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(3)
    weather.reset()
    await weather.refresh(settings)
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(5)
    expect(requestCurrent).not.toHaveBeenCalled()
  })
  it('ignores the first late permission result but accepts the single bounded recovery lookup', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(start)
    let finishPermission!: (value: typeof city) => void
    const getAppLocation = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishPermission = resolve }))
      .mockResolvedValue(city)
    const requestCurrent = vi.fn(async () => current(Date.now()))
    const weather = new WeatherController({ getAppLocation, requestCurrent })
    const pending = weather.refresh(settings)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).status).toBe('setup')
    finishPermission(city)
    await Promise.resolve()
    expect(requestCurrent).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(55_000)
    expect((await weather.refresh(settings)).status).toBe('ready')
    expect(getAppLocation).toHaveBeenCalledTimes(2)
    expect(getAppLocation).toHaveBeenLastCalledWith({ accuracy: 'low', timeoutMs: 5000 })
  })
  it('retries phone location while using a saved city and never attributes city weather to a new phone location', async () => {
    let now = start
    const getAppLocation = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ latitude: 45, longitude: 12 })
    const requestCurrent = vi.fn(async () => current(now))
    const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => now })
    const fallback = { ...settings, fallbackCity: city }
    expect((await weather.refresh(fallback)).source).toBe('city')
    now += 60_000
    requestCurrent.mockRejectedValueOnce(new Error('unavailable'))
    const result = await weather.refresh(fallback)
    expect(result.source).toBe('phone')
    expect(result.status).toBe('unavailable')
    expect(result.lines).not.toContain('68°F')
  })
  it('does not run scheduled recovery while disabled and restores the allowance when settings change', async () => {
    let now = start
    const getAppLocation = vi.fn(async () => null)
    const weather = new WeatherController({ getAppLocation, requestCurrent: async () => current(now), now: () => now })
    await weather.refresh(settings)
    now += 60_000
    expect((await weather.refresh({ ...settings, enabled: false })).status).toBe('disabled')
    expect(getAppLocation).toHaveBeenCalledTimes(1)
    await weather.refresh(settings)
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(3)
  })
  it('restores one early retry after a successful phone fix', async () => {
    let now = start
    const getAppLocation = vi.fn().mockResolvedValue(null)
    const weather = new WeatherController({ getAppLocation, requestCurrent: async () => current(now), now: () => now })
    await weather.refresh(settings)
    now += 60_000
    await weather.refresh(settings)
    getAppLocation.mockResolvedValueOnce(city as never)
    now += WEATHER_REFRESH_MS
    expect((await weather.refresh(settings)).source).toBe('phone')
    now += WEATHER_REFRESH_MS
    expect((await weather.refresh(settings)).status).toBe('setup')
    now += 60_000
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(5)
  })
  it('uses one low accuracy lookup, rounds before sending, coalesces and throttles requests', async () => {
    let now = start
    const getAppLocation = vi.fn(async () => ({ latitude: 39.739234, longitude: -104.990334 }))
    const requestCurrent = vi.fn(async () => current(now))
    const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => now })
    const [first, second] = await Promise.all([weather.refresh(settings), weather.refresh(settings)])
    expect(first).toEqual(second)
    expect(first.lines).toEqual(['68°F', 'Partly cloudy'])
    expect(getAppLocation).toHaveBeenCalledExactlyOnceWith({ accuracy: 'low', timeoutMs: 5000 })
    expect(requestCurrent).toHaveBeenCalledExactlyOnceWith({ latitude: 39.74, longitude: -104.99 })
    now += WEATHER_REFRESH_MS - 1
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(1)
    now += 1
    await weather.refresh(settings)
    expect(getAppLocation).toHaveBeenCalledTimes(2)
    expect(weather.display({ ...settings, unit: 'celsius' }).lines[0]).toBe('20°C')
  })
  it('uses the saved city after denial or invalid phone location and labels it', async () => {
    for (const getAppLocation of [async () => { throw new Error('denied') }, async () => ({ latitude: NaN, longitude: 0 })]) {
      const requestCurrent = vi.fn(async () => current())
      const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => start })
      expect(await weather.refresh({ ...settings, fallbackCity: city })).toEqual({ lines: ['68°F', 'Partly cloudy', 'Saved city'], source: 'city', status: 'ready' })
      expect(requestCurrent).toHaveBeenCalledWith({ latitude: city.latitude, longitude: city.longitude })
    }
  })
  it('enforces the five-second timeout even if the native bridge never responds', async () => {
    vi.useFakeTimers()
    const requestCurrent = vi.fn(async () => current())
    const weather = new WeatherController({ getAppLocation: () => new Promise(() => {}), requestCurrent, now: () => start })
    const pending = weather.refresh(settings)
    await vi.advanceTimersByTimeAsync(5000)
    expect((await pending).status).toBe('setup')
    expect(requestCurrent).not.toHaveBeenCalled()
  })
  it('expires matching cached conditions after one hour and never shows a previous location', async () => {
    let now = start
    let latitude = 39.74
    const requestCurrent = vi.fn(async () => current())
    const weather = new WeatherController({ getAppLocation: async () => ({ latitude, longitude: -104.99 }), requestCurrent, now: () => now })
    await weather.refresh(settings)
    requestCurrent.mockRejectedValue(new Error('offline'))
    now += WEATHER_REFRESH_MS
    expect((await weather.refresh(settings)).status).toBe('stale')
    now = start + 60 * 60_000 + 1
    expect(weather.display(settings).status).toBe('unavailable')
    latitude = 40
    expect((await weather.refresh(settings, true)).status).toBe('unavailable')
    expect(weather.display(settings).lines).not.toContain('68°F')
  })
  it('ignores obsolete lookups after reset or fallback changes and does no work while disabled', async () => {
    let resolve!: (value: { latitude: number; longitude: number } | null) => void
    const getAppLocation = vi.fn(() => new Promise<{ latitude: number; longitude: number } | null>(r => { resolve = r }))
    const requestCurrent = vi.fn(async () => current())
    const weather = new WeatherController({ getAppLocation, requestCurrent, now: () => start })
    const pending = weather.refresh(settings)
    await Promise.resolve()
    weather.reset()
    resolve(city)
    await pending
    expect(requestCurrent).not.toHaveBeenCalled()
    expect((await weather.refresh({ ...settings, enabled: false })).status).toBe('disabled')
    expect(getAppLocation).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed provider data instead of rendering it', async () => {
    const weather = new WeatherController({ getAppLocation: async () => city, requestCurrent: async () => ({ ...current(), condition: 'Clear\nspoof' }), now: () => start })
    expect((await weather.refresh(settings)).status).toBe('unavailable')
  })
  it('does not let an old city response overwrite a changed fallback city', async () => {
    let finishOld!: (value: ReturnType<typeof current>) => void
    const requestCurrent = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
      .mockResolvedValue({ ...current(), temperatureC: 10 })
    const weather = new WeatherController({ getAppLocation: async () => null, requestCurrent, now: () => start })
    const first = weather.refresh({ ...settings, fallbackCity: city })
    await vi.waitFor(() => expect(requestCurrent).toHaveBeenCalledTimes(1))
    const nextSettings = { ...settings, fallbackCity: { ...city, id: '2', latitude: 45 } }
    expect((await weather.refresh(nextSettings)).lines[0]).toBe('50°F')
    finishOld(current())
    await first
    expect(weather.display(nextSettings).lines[0]).toBe('50°F')
  })
})
