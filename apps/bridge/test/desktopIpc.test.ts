import { describe, expect, it } from "vitest";
import { renderConversationOutput } from "../src/desktopIpc.js";

describe("desktop IPC conversation rendering", () => {
  it("keeps only user-facing assistant and plan text", () => {
    const output = renderConversationOutput({
      turns: [
        {
          items: [
            { type: "agentMessage", text: "hello" },
            { type: "commandExecution", commandActions: [{ cmd: "npm test" }], aggregatedOutput: "tests passed" },
            { type: "error", message: "internal error" },
            { type: "plan", text: "1. ship it" }
          ]
        }
      ]
    });

    expect(output).toBe("hello\n1. ship it");
  });
});
