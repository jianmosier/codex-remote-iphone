import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditLog, hashSessionId } from "../src/audit.js";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("AuditLog", () => {
  it("writes and reads recent events", async () => {
    dir = await mkdtemp(resolve(tmpdir(), "cri-audit-"));
    const audit = new AuditLog(resolve(dir, "audit.log"));

    await audit.append({ type: "login.success", deviceName: "iPhone" });
    await audit.append({ type: "approval.decide", detail: { decision: "accept" } });

    const recent = await audit.recent(1);
    expect(recent).toHaveLength(1);
    expect(recent[0].type).toBe("approval.decide");
  });

  it("hashes session ids without exposing the original", () => {
    const hash = hashSessionId("secret-session-id");
    expect(hash).toHaveLength(16);
    expect(hash).not.toContain("secret");
  });
});
