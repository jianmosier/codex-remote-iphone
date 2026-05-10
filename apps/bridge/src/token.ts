import { randomBytes, timingSafeEqual } from "node:crypto";

export type PairingTokenSnapshot = {
  expiresAt: string;
  consumed: boolean;
};

export class PairingTokenManager {
  private tokenValue = "";
  private expiresAtMs = 0;
  private consumed = false;

  constructor(private ttlMinutes: number) {
    this.rotate(ttlMinutes);
  }

  rotate(ttlMinutes = this.ttlMinutes): string {
    this.ttlMinutes = ttlMinutes;
    this.tokenValue = randomBytes(32).toString("base64url");
    this.expiresAtMs = Date.now() + ttlMinutes * 60_000;
    this.consumed = false;
    return this.tokenValue;
  }

  token(): string {
    return this.tokenValue;
  }

  snapshot(): PairingTokenSnapshot {
    return {
      expiresAt: new Date(this.expiresAtMs).toISOString(),
      consumed: this.consumed
    };
  }

  url(publicBaseUrl: string): string {
    return `${publicBaseUrl.replace(/\/$/, "")}/#token=${encodeURIComponent(this.tokenValue)}`;
  }

  matches(candidate: string): boolean {
    if (!candidate || this.consumed || Date.now() > this.expiresAtMs) return false;
    const expected = Buffer.from(this.tokenValue);
    const actual = Buffer.from(candidate);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  consume(candidate: string): boolean {
    if (!this.matches(candidate)) return false;
    this.consumed = true;
    return true;
  }
}
