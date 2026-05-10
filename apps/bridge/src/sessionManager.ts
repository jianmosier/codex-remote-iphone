import { randomBytes } from "node:crypto";
import type { AppConfig } from "./config.js";

export type SessionInfo = {
  id: string;
  deviceName: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt: string;
  connected: boolean;
};

export type PublicSessionInfo = Omit<SessionInfo, "id"> & {
  sessionIdHash: string;
};

export class SessionManager {
  private sessions = new Map<string, SessionInfo>();

  constructor(private getConfig: () => AppConfig) {}

  create(input: Pick<SessionInfo, "deviceName" | "ip" | "userAgent">):
    | { ok: true; session: SessionInfo }
    | { ok: false; reason: "device-limit" } {
    if (this.activeCount() >= this.getConfig().maxActiveDevices) {
      return { ok: false, reason: "device-limit" };
    }
    const now = new Date().toISOString();
    const session: SessionInfo = {
      id: randomBytes(32).toString("base64url"),
      deviceName: input.deviceName || "iPhone",
      ip: input.ip,
      userAgent: input.userAgent,
      createdAt: now,
      lastSeenAt: now,
      connected: false
    };
    this.sessions.set(session.id, session);
    return { ok: true, session };
  }

  find(sessionId: string | null | undefined): SessionInfo | null {
    if (!sessionId) return null;
    return this.sessions.get(sessionId) ?? null;
  }

  touch(sessionId: string): SessionInfo | null {
    const session = this.find(sessionId);
    if (!session) return null;
    session.lastSeenAt = new Date().toISOString();
    return session;
  }

  setConnected(sessionId: string, connected: boolean): void {
    const session = this.find(sessionId);
    if (!session) return;
    session.connected = connected;
    session.lastSeenAt = new Date().toISOString();
  }

  revoke(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  revokeAll(): void {
    this.sessions.clear();
  }

  activeCount(): number {
    return this.sessions.size;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()];
  }
}
