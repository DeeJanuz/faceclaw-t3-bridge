import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnosticOrigin } from "../src/pairing-diagnostics.js";

describe("pairing diagnostic origins", () => {
  it("keeps useful normalized origins and distinguishes opaque and missing origins", () => {
    assert.equal(diagnosticOrigin("http://127.0.0.1:50496"), "http://127.0.0.1:50496");
    assert.equal(diagnosticOrigin("HTTPS://EXAMPLE.COM:443"), "https://example.com");
    assert.equal(diagnosticOrigin("http://[::1]:5178"), "http://[::1]:5178");
    assert.equal(diagnosticOrigin("null"), "null");
    assert.equal(diagnosticOrigin(undefined), "[missing]");
  });

  it("never echoes malformed, unbounded, control-character, or credential-bearing values", () => {
    for (const value of [
      "https://user:private-password@example.com",
      "https://example.com/private-path",
      "https://example.com?token=private-token",
      "https://example.com#private-fragment",
      "https://example.com\\private-path",
      "https://example.com\nforged-log",
      "https://example.com\u202eforged-log",
      " https://example.com",
      "https://example.com ",
      `https://${"a".repeat(513)}.com`,
      "https://example.com:999999",
      "data:private-value",
      ["https://one.example", "https://two.example"],
      null,
      1,
    ]) {
      assert.equal(diagnosticOrigin(value), "[invalid]");
    }
  });
});
