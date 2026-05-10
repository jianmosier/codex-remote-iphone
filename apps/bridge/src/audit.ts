import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { getDataDir } from "./config.js";

export type AuditEvent = {
  type: string;
  at?: string;
  ip?: string;
  userAgent?: string;
  deviceName?: string;
  sessionIdHash?: string;
  detail?: Record<string, unknown>;
};

export class AuditLog {
  readonly path: string;

  constructor(path = resolve(getDataDir(), "audit.log")) {
    this.path = path;
  }

  async append(event: AuditEvent): Promise<void> {
    await mkdir(getDataDir(), { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    await appendFile(this.path, `${line}\n`, "utf8");
  }

  async recent(limit = 80): Promise<AuditEvent[]> {
    try {
      const info = await stat(this.path);
      const raw = await readFile(this.path, "utf8");
      const lines = raw.trim().split("\n").filter(Boolean);
      return lines
        .slice(Math.max(0, lines.length - limit))
        .map((line) => JSON.parse(line) as AuditEvent)
        .map((event) => ({ ...event, detail: { ...event.detail, logBytes: info.size } }));
    } catch {
      return [];
    }
  }
}

export function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}
