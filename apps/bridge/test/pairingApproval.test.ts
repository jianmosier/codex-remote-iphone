import { describe, expect, it } from "vitest";
import { PairingApprovalManager } from "../src/pairingApproval.js";

describe("PairingApprovalManager", () => {
  it("creates pending requests and approves them", () => {
    const approvals = new PairingApprovalManager(60_000);
    const request = approvals.create({ deviceName: "iPhone", ip: "1.1.1.1", userAgent: "Safari" });

    expect(request.status).toBe("pending");
    expect(approvals.list()).toHaveLength(1);

    const approved = approvals.approve(request.id, "test");
    expect(approved?.status).toBe("approved");
    expect(approved?.decidedBy).toBe("test");
  });

  it("expires pending requests", () => {
    const approvals = new PairingApprovalManager(-1);
    const request = approvals.create({ deviceName: "iPhone", ip: "1.1.1.1", userAgent: "Safari" });

    expect(approvals.find(request.id)?.status).toBe("expired");
    expect(approvals.approve(request.id, "test")).toBeNull();
  });
});
