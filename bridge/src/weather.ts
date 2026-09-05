import { ApiError, FixedWindowRateLimiter } from "./security.js";

interface WeatherLocation {
  id: string; name: string; region: string; country: string; latitude: number; longitude: number;
}
interface CurrentWeather {
  temperatureC: number; condition: string; observedAt: string; fetchedAt: string;
}
const FRESH_MS = 15 * 60_000;
const MAX_BODY_BYTES = 64 * 1024;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function coordinates(value: Record<string, unknown>): { latitude: number; longitude: number } {
  const { latitude, longitude } = value;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof longitude !== "number" || !Number.isFinite(longitude) || Math.abs(longitude) > 180) {
    throw new ApiError(400, "invalid_request", "Weather coordinates are invalid");
  }
  return { latitude: Math.round(latitude * 100) / 100, longitude: Math.round(longitude * 100) / 100 };
}
function label(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 200).replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/gu, " ").trim().slice(0, 100) : "";
}
function unavailable(): ApiError {
  return new ApiError(502, "weather_unavailable", "Weather is unavailable");
}
function condition(code: number): string {
  if (code === 0) return "Clear";
  if (code === 1) return "Mostly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if ([45, 48].includes(code)) return "Fog";
  if ([51, 53, 55].includes(code)) return "Drizzle";
  if ([56, 57, 66, 67].includes(code)) return "Freezing rain";
  if ([61, 63, 65].includes(code)) return "Rain";
  if ([71, 73, 75, 77].includes(code)) return "Snow";
  if ([80, 81, 82].includes(code)) return "Rain showers";
  if ([85, 86].includes(code)) return "Snow showers";
  if ([95, 96, 99].includes(code)) return "Thunderstorm";
  return "Conditions unknown";
}

/** Egress is fixed to Open-Meteo. Never log request URLs, coordinates, or provider errors. */
export class WeatherService {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly limiter = new FixedWindowRateLimiter(30);

  constructor(private readonly fetcher: typeof fetch = fetch, private readonly now = Date.now) {}

  async locations(params: Record<string, unknown>): Promise<{ locations: WeatherLocation[] }> {
    if (typeof params.query !== "string" || params.query.trim().length < 2 ||
        params.query.length > 100 || /[\p{Cc}\p{Cf}]/u.test(params.query) || Object.keys(params).some(k => k !== "query")) {
      throw new ApiError(400, "invalid_request", "Enter a city name between 2 and 100 characters");
    }
    const query = params.query.trim();
    return this.cached(`city:${query.toLowerCase()}`, async () => {
      const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
      url.search = new URLSearchParams({ name: query, count: "5", language: "en", format: "json" }).toString();
      const body = await this.json(url);
      if (body.results === undefined) return { locations: [] };
      if (!Array.isArray(body.results)) throw unavailable();
      const locations: WeatherLocation[] = [];
      for (const item of body.results.slice(0, 5)) {
        const city = record(item);
        if (!city || !Number.isSafeInteger(city.id) || Number(city.id) < 0) continue;
        const name = label(city.name), country = label(city.country);
        if (!name || !country) continue;
        try {
          locations.push({ id: String(city.id), name, region: label(city.admin1), country, ...coordinates(city) });
        } catch { /* Ignore malformed provider entries. */ }
      }
      return { locations };
    });
  }

  async current(params: Record<string, unknown>): Promise<CurrentWeather> {
    if (Object.keys(params).some(k => k !== "latitude" && k !== "longitude")) {
      throw new ApiError(400, "invalid_request", "Weather coordinates are invalid");
    }
    const position = coordinates(params);
    return this.cached(`weather:${position.latitude},${position.longitude}`, async () => {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({ latitude: String(position.latitude), longitude: String(position.longitude),
        current: "temperature_2m,weather_code", temperature_unit: "celsius", timeformat: "unixtime", timezone: "GMT" }).toString();
      const body = await this.json(url);
      const current = record(body.current);
      if (!current || typeof current.temperature_2m !== "number" || !Number.isFinite(current.temperature_2m) ||
          current.temperature_2m < -100 || current.temperature_2m > 70 ||
          typeof current.weather_code !== "number" || !Number.isInteger(current.weather_code) ||
          typeof current.time !== "number" || !Number.isFinite(current.time) ||
          Math.abs(this.now() - current.time * 1000) > 60 * 60_000) throw unavailable();
      return { temperatureC: current.temperature_2m, condition: condition(current.weather_code),
        observedAt: new Date(current.time * 1000).toISOString(), fetchedAt: new Date(this.now()).toISOString() };
    });
  }

  private async cached<T>(key: string, work: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < FRESH_MS) return cached.value as T;
    const pending = this.pending.get(key);
    if (pending) return pending as Promise<T>;
    if (this.pending.size >= 4 || !this.limiter.allow("weather")) {
      throw new ApiError(429, "weather_rate_limited", "Weather is busy; try again shortly");
    }
    const operation = work().then(value => {
      this.cache.delete(key);
      this.cache.set(key, { at: this.now(), value });
      while (this.cache.size > 32) this.cache.delete(this.cache.keys().next().value!);
      return value;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async json(url: URL): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.fetcher(url, { signal: controller.signal, redirect: "error", headers: { Accept: "application/json" } });
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_BODY_BYTES) throw unavailable();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_BODY_BYTES) throw unavailable();
        chunks.push(next.value);
      }
      const body = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!body || body.error) throw unavailable();
      return body;
    } catch { throw unavailable(); }
    finally { clearTimeout(timer); controller.abort(); await reader?.cancel().catch(() => {}); }
  }
}
