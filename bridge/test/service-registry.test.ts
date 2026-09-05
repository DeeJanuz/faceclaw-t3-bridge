import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApiError } from "../src/security.js";
import { BridgeServiceRegistry, type BridgeServiceMethod } from "../src/service-registry.js";
import { WeatherService } from "../src/weather.js";

describe("explicit bridge service registry", () => {
  it("dispatches only registered own methods by exact name", async () => {
    let calls = 0;
    const methods = Object.assign(Object.create({ inherited: () => "must not run" }), {
      read: (params: Record<string, unknown>) => { calls++; return { value: params.value }; },
    }) as Record<string, BridgeServiceMethod>;
    const registry = new BridgeServiceRegistry([{ namespace: "example", methods }]);
    assert.deepEqual(await registry.dispatch("example.read", { value: 1 }), { value: 1 });
    for (const method of ["example.inherited", "example.constructor", "example.toString", "example.__proto__",
      "example.read.extra", "example", "EXAMPLE.read", "unregistered.read", "rss.read"]) {
      await assert.rejects(registry.dispatch(method, {}), { code: "method_not_found", message: "Method not found" });
    }
    assert.equal(calls, 1);
  });

  it("rejects duplicate namespaces, reserved T3 namespaces and invalid method definitions", () => {
    assert.throws(() => new BridgeServiceRegistry([
      { namespace: "example", methods: {} }, { namespace: "example", methods: {} },
    ]), /duplicate/);
    for (const namespace of ["voice", "thread", "sessions", "models", "projects", "transcript", "turn", "bridge",
      "../module", "https://example.test", "", "a".repeat(33)]) {
      assert.throws(() => new BridgeServiceRegistry([{ namespace, methods: {} }]), /namespace/);
    }
    for (const methods of [{ "read.extra": () => null }, { read: "not callable" }, { "__proto__.read": () => null }]) {
      assert.throws(() => new BridgeServiceRegistry([{ namespace: "example", methods: methods as Record<string, BridgeServiceMethod> }]), /method/);
    }
  });

  it("captures the explicit allowlist instead of accepting later mutations", async () => {
    const methods: Record<string, BridgeServiceMethod> = { read: () => "original" };
    const registry = new BridgeServiceRegistry([{ namespace: "example", methods }]);
    methods.read = () => "replacement";
    methods.added = () => "unexpected";
    assert.equal(await registry.dispatch("example.read", {}), "original");
    await assert.rejects(registry.dispatch("example.added", {}), { code: "method_not_found" });
  });

  it("rejects non-object parameters before invoking a service", async () => {
    let calls = 0;
    const registry = new BridgeServiceRegistry([{ namespace: "example", methods: { read: () => calls++ } }]);
    for (const params of [null, [], "value", 1]) {
      await assert.rejects(registry.dispatch("example.read", params as unknown as Record<string, unknown>), { code: "invalid_request" });
    }
    assert.equal(calls, 0);
  });

  it("preserves validation errors and unexpected errors for the existing socket error mapper", async () => {
    const safe = new ApiError(400, "invalid_request", "Invalid value");
    const unexpected = new Error("private provider details");
    const registry = new BridgeServiceRegistry([{ namespace: "example", methods: {
      sync: () => { throw safe; }, async: async () => { throw unexpected; },
    } }]);
    await assert.rejects(registry.dispatch("example.sync", {}), error => error === safe);
    await assert.rejects(registry.dispatch("example.async", {}), error => error === unexpected);
  });

  it("preserves weather validation, normalized results and caching through service dispatch", async () => {
    const now = Date.parse("2026-09-04T12:00:00.000Z");
    let calls = 0;
    const weather = new WeatherService(async () => {
      calls++;
      return new Response(JSON.stringify({ current: { temperature_2m: 20, weather_code: 0, time: now / 1000 } }));
    }, () => now);
    const registry = new BridgeServiceRegistry([{ namespace: "weather", methods: {
      current: params => weather.current(params), locations: params => weather.locations(params),
    } }]);
    await assert.rejects(registry.dispatch("weather.current", { latitude: 999, longitude: 0 }), { code: "invalid_request" });
    await assert.rejects(registry.dispatch("weather.locations", { query: "x" }), { code: "invalid_request" });
    assert.equal(calls, 0);
    const first = await registry.dispatch("weather.current", { latitude: 1, longitude: 2 });
    assert.deepEqual(first, { temperatureC: 20, condition: "Clear", observedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString() });
    assert.deepEqual(await registry.dispatch("weather.current", { latitude: 1, longitude: 2 }), first);
    assert.equal(calls, 1);
  });
});
