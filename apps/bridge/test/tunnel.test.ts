import { describe, expect, it } from "vitest";
import { parseTryCloudflareUrl } from "../src/tunnel.js";

describe("parseTryCloudflareUrl", () => {
  it("extracts a Quick Tunnel URL from cloudflared logs", () => {
    expect(parseTryCloudflareUrl("INF +--------------------------------------------------------------------------------------------+")).toBeNull();
    expect(parseTryCloudflareUrl("INF |  https://quiet-river-123.trycloudflare.com                                      |")).toBe(
      "https://quiet-river-123.trycloudflare.com"
    );
  });
});
