export type UiApprovalDecision = "accept" | "decline" | "cancel";

export function mapApprovalDecision(method: string, decision: UiApprovalDecision): { decision: unknown } {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return {
      decision:
        decision === "accept"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel"
    };
  }

  return {
    decision:
      decision === "accept"
        ? "approved"
        : decision === "decline"
          ? "denied"
          : "abort"
  };
}

export function summarizeApproval(method: string, params: Record<string, unknown>): Record<string, unknown> {
  if (method === "item/commandExecution/requestApproval") {
    return {
      kind: "command",
      command: params.command,
      cwd: params.cwd,
      reason: params.reason,
      availableDecisions: params.availableDecisions
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "fileChange",
      reason: params.reason,
      grantRoot: params.grantRoot
    };
  }

  if (method === "applyPatchApproval") {
    return {
      kind: "patch",
      reason: params.reason,
      grantRoot: params.grantRoot,
      fileChanges: params.fileChanges
    };
  }

  if (method === "execCommandApproval") {
    return {
      kind: "exec",
      command: params.command,
      cwd: params.cwd,
      reason: params.reason
    };
  }

  return { kind: "unknown", params };
}
