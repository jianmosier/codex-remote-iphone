import { describe, expect, it } from "vitest";
import { SessionManager } from "../src/sessionManager.js";

describe("SessionManager", () => {
  it("enforces the active device limit", () => {
    const sessions = new SessionManager(() => ({
      maxActiveDevices: 1,
      deviceTokenTtlMinutes: 10,
      requireDesktopPairingApproval: true,
      desktopApprovalPrompt: true,
      pairingApprovalTtlSeconds: 120,
      onDeviceLimitExceeded: "disconnectAll",
      auditLogRetentionDays: 30
    }));

    const first = sessions.create({ deviceName: "iPhone", ip: "1.1.1.1", userAgent: "Safari" });
    const second = sessions.create({ deviceName: "iPad", ip: "2.2.2.2", userAgent: "Safari" });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(sessions.activeCount()).toBe(1);
  });
});
