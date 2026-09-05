import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WeatherService } from "../src/weather.js";

const now = Date.parse("2026-09-04T12:00:00.000Z");
const body = { current: { temperature_2m: 20, weather_code: 2, time: now / 1000 } };
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } }); }

describe("weather egress boundary", () => {
  it("aborts an unresponsive provider after five seconds without exposing its error", async () => {
    let aborted = false;
    const service = new WeatherService(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("private provider URL")); }, { once: true });
    }), () => now);
    await assert.rejects(service.current({ latitude: 1, longitude: 2 }), { code: "weather_unavailable", message: "Weather is unavailable" });
    assert.equal(aborted, true);
  });
  it("uses fixed HTTPS endpoints, drops redirects and rounds coordinates before egress", async () => {
    const calls: { url: URL; init: RequestInit | undefined }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: new URL(String(input)), init });
      return json(body);
    };
    const service = new WeatherService(fetcher, () => now);
    const result = await service.current({ latitude: 39.73924, longitude: -104.99034 });
    assert.equal(calls[0]!.url.origin, "https://api.open-meteo.com");
    assert.equal(calls[0]!.url.pathname, "/v1/forecast");
    assert.equal(calls[0]!.url.searchParams.get("latitude"), "39.74");
    assert.equal(calls[0]!.init?.redirect, "error");
    assert.equal(calls[0]!.init?.headers && JSON.stringify(calls[0]!.init?.headers).includes("Authorization"), false);
    assert.deepEqual(result, { temperatureC: 20, condition: "Partly cloudy", observedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString() });
  });
  it("rejects invalid coordinates, extra URL parameters and abusive queries before network access", async () => {
    let calls = 0;
    const service = new WeatherService(async () => { calls++; return json(body); }, () => now);
    for (const params of [{ latitude: 91, longitude: 0 }, { latitude: NaN, longitude: 0 }, { latitude: "1", longitude: 0 }, { latitude: 0, longitude: 0, url: "https://attacker.test" }]) {
      await assert.rejects(service.current(params), { code: "invalid_request" });
    }
    for (const params of [{ query: "a" }, { query: "a".repeat(101) }, { query: "Denver\n" }, { query: "Denver", url: "https://attacker.test" }]) {
      await assert.rejects(service.locations(params), { code: "invalid_request" });
    }
    assert.equal(calls, 0);
  });
  it("returns at most five disambiguated city choices with sanitized fields", async () => {
    let requested: URL | undefined;
    const service = new WeatherService(async input => {
      requested = new URL(String(input));
      return json({ results: Array.from({ length: 10 }, (_, id) => ({ id, name: "Springfield", admin1: `Region ${id}`, country: "United States", latitude: 39.12345, longitude: -104.12345, secret: "omit" })) });
    }, () => now);
    const result = await service.locations({ query: "Springfield" });
    assert.equal(requested?.origin, "https://geocoding-api.open-meteo.com");
    assert.equal(result.locations.length, 5);
    assert.deepEqual(result.locations[0], { id: "0", name: "Springfield", region: "Region 0", country: "United States", latitude: 39.12, longitude: -104.12 });
  });
  it("coalesces requests and caches by rounded coordinates for fifteen minutes", async () => {
    let clock = now, calls = 0;
    const service = new WeatherService(async () => { calls++; return json({ current: { ...body.current, time: clock / 1000 } }); }, () => clock);
    await Promise.all([service.current({ latitude: 1.001, longitude: 2 }), service.current({ latitude: 1.002, longitude: 2 })]);
    assert.equal(calls, 1);
    clock += 15 * 60_000 - 1;
    await service.current({ latitude: 1, longitude: 2 });
    assert.equal(calls, 1);
    clock++;
    await service.current({ latitude: 1, longitude: 2 });
    assert.equal(calls, 2);
  });
  it("caps concurrent upstream requests", async () => {
    const resolves: ((response: Response) => void)[] = [];
    const service = new WeatherService(() => new Promise(resolve => resolves.push(resolve)), () => now);
    const requests = Array.from({ length: 4 }, (_, latitude) => service.current({ latitude, longitude: 0 }));
    await assert.rejects(service.current({ latitude: 5, longitude: 0 }), { code: "weather_rate_limited" });
    resolves.forEach(resolve => resolve(json(body)));
    await Promise.all(requests);
  });
  it("limits response bytes and replaces provider errors with a generic error", async () => {
    for (const fetcher of [
      async () => new Response("x".repeat(65 * 1024)),
      async () => json({ current: { ...body.current, temperature_2m: 999 } }),
      async () => json({ current: { ...body.current, time: 0 } }),
      async () => { throw new Error("private URL and location"); },
      async () => new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
    ]) {
      const service = new WeatherService(fetcher, () => now);
      await assert.rejects(service.current({ latitude: 1, longitude: 2 }), { code: "weather_unavailable", message: "Weather is unavailable" });
    }
  });
});
