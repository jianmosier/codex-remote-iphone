import { describe, expect, it } from "vitest";
import { mapApprovalDecision } from "../src/approval.js";

describe("mapApprovalDecision", () => {
  it("maps v2 command approvals", () => {
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "accept")).toEqual({ decision: "accept" });
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "decline")).toEqual({ decision: "decline" });
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "cancel")).toEqual({ decision: "cancel" });
  });

  it("maps legacy approvals", () => {
    expect(mapApprovalDecision("execCommandApproval", "accept")).toEqual({ decision: "approved" });
    expect(mapApprovalDecision("applyPatchApproval", "decline")).toEqual({ decision: "denied" });
    expect(mapApprovalDecision("applyPatchApproval", "cancel")).toEqual({ decision: "abort" });
  });
});
