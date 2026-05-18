import { describe, expect, it } from "vitest";
import { hasEnoughDnsCoverage, parseTryCloudflareUrl } from "../src/tunnel.js";

describe("parseTryCloudflareUrl", () => {
  it("extracts a Quick Tunnel URL from cloudflared logs", () => {
    expect(parseTryCloudflareUrl("INF +--------------------------------------------------------------------------------------------+")).toBeNull();
    expect(parseTryCloudflareUrl("INF |  https://quiet-river-123.trycloudflare.com                                      |")).toBe(
      "https://quiet-river-123.trycloudflare.com"
    );
  });
});

describe("hasEnoughDnsCoverage", () => {
  it("accepts a majority of direct public resolver checks", () => {
    expect(
      hasEnoughDnsCoverage([{ ok: false }, { ok: true }, { ok: true }, { ok: true }, { ok: true }])
    ).toBe(true);
  });

  it("rejects when most direct public resolver checks fail", () => {
    expect(
      hasEnoughDnsCoverage([{ ok: false }, { ok: true }, { ok: false }, { ok: true }, { ok: false }])
    ).toBe(false);
  });
});
