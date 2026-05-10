import { describe, expect, it } from "vitest";
import { buildTurnInput, normalizeImageIds, transcriptTextForTurn, type UploadedImageReference } from "../src/turnInput.js";

const image: UploadedImageReference = {
  id: "img-1",
  name: "photo.png",
  mimeType: "image/png",
  size: 12,
  path: "/tmp/photo.png"
};

describe("turn input", () => {
  it("builds text and local image input for Codex", () => {
    expect(buildTurnInput("  describe this  ", [image])).toEqual([
      { type: "text", text: "describe this", text_elements: [] },
      { type: "localImage", path: "/tmp/photo.png" }
    ]);
  });

  it("allows image-only turns", () => {
    expect(buildTurnInput("", [image])).toEqual([{ type: "localImage", path: "/tmp/photo.png" }]);
  });

  it("rejects empty turns", () => {
    expect(() => buildTurnInput("   ", [])).toThrow(/required/);
  });

  it("formats transcript text with image labels", () => {
    expect(transcriptTextForTurn("Look", [image])).toBe("Look\n[Image: photo.png]");
  });

  it("normalizes image ids from websocket payloads", () => {
    expect(normalizeImageIds([{ id: "a" }, { id: "b" }])).toEqual(["a", "b"]);
    expect(() => normalizeImageIds([{ path: "/tmp/file.png" }])).toThrow(/id/);
  });
});
