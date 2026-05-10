import { randomBytes } from "node:crypto";

export type PairingApprovalStatus = "pending" | "approved" | "denied" | "expired";

export type PairingApprovalRequest = {
  id: string;
  deviceName: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  status: PairingApprovalStatus;
  decidedAt?: string;
  decidedBy?: string;
  sessionId?: string;
};

export type PublicPairingApprovalRequest = Omit<PairingApprovalRequest, "sessionId"> & {
  sessionIdHash?: string;
};

export class PairingApprovalManager {
  private requests = new Map<string, PairingApprovalRequest>();

  constructor(private ttlMs: number) {}

  create(input: Pick<PairingApprovalRequest, "deviceName" | "ip" | "userAgent">): PairingApprovalRequest {
    this.prune();
    const now = Date.now();
    const request: PairingApprovalRequest = {
      id: randomBytes(12).toString("base64url"),
      deviceName: input.deviceName || "iPhone",
      ip: input.ip,
      userAgent: input.userAgent,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.ttlMs).toISOString(),
      status: "pending"
    };
    this.requests.set(request.id, request);
    return request;
  }

  find(id: string): PairingApprovalRequest | null {
    const request = this.requests.get(id) ?? null;
    if (!request) return null;
    this.refreshStatus(request);
    return request;
  }

  list(): PairingApprovalRequest[] {
    this.prune();
    return [...this.requests.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  approve(id: string, decidedBy: string): PairingApprovalRequest | null {
    const request = this.find(id);
    if (!request || request.status !== "pending") return null;
    request.status = "approved";
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    return request;
  }

  deny(id: string, decidedBy: string): PairingApprovalRequest | null {
    const request = this.find(id);
    if (!request || request.status !== "pending") return null;
    request.status = "denied";
    request.decidedAt = new Date().toISOString();
    request.decidedBy = decidedBy;
    return request;
  }

  attachSession(id: string, sessionId: string): PairingApprovalRequest | null {
    const request = this.find(id);
    if (!request || request.status !== "approved") return null;
    request.sessionId = sessionId;
    return request;
  }

  prune(): void {
    const now = Date.now();
    for (const [id, request] of this.requests) {
      this.refreshStatus(request, now);
      if (request.status === "pending") continue;
      const decidedAt = request.decidedAt ? Date.parse(request.decidedAt) : Date.parse(request.expiresAt);
      if (Number.isFinite(decidedAt) && now - decidedAt > this.ttlMs) this.requests.delete(id);
    }
  }

  private refreshStatus(request: PairingApprovalRequest, now = Date.now()): void {
    if (request.status !== "pending") return;
    const expiresAt = Date.parse(request.expiresAt);
    if (Number.isFinite(expiresAt) && now > expiresAt) {
      request.status = "expired";
      request.decidedAt = new Date(now).toISOString();
      request.decidedBy = "timeout";
    }
  }
}
