import { describe, expect, it } from "vitest";
import { PairingTokenManager } from "../src/token.js";

describe("PairingTokenManager", () => {
  it("validates then consumes a token", () => {
    const tokens = new PairingTokenManager(10);
    const token = tokens.token();

    expect(tokens.matches(token)).toBe(true);
    expect(tokens.consume(token)).toBe(true);
    expect(tokens.matches(token)).toBe(false);
    expect(tokens.consume(token)).toBe(false);
  });

  it("embeds the token in the URL fragment", () => {
    const tokens = new PairingTokenManager(10);
    const url = tokens.url("https://example.trycloudflare.com");

    expect(url).toContain("https://example.trycloudflare.com/#token=");
    expect(url).toContain(encodeURIComponent(tokens.token()));
  });
});
