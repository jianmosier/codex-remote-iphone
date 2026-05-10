import { describe, expect, it } from "vitest";
import { displayTextForTurn, mergeTranscriptAppend, type TranscriptEntry, type UploadedImage } from "./App";

describe("conversation transcript", () => {
  it("replaces optimistic user messages when the server echoes the same client id", () => {
    const optimistic: TranscriptEntry = {
      id: -1,
      role: "user",
      text: "hello",
      createdAt: "2026-05-10T00:00:00.000Z",
      clientMessageId: "client-1"
    };
    const server: TranscriptEntry = {
      id: 1,
      role: "user",
      text: "hello",
      createdAt: "2026-05-10T00:00:01.000Z",
      clientMessageId: "client-1"
    };

    expect(mergeTranscriptAppend([optimistic], server)).toEqual([server]);
  });

  it("formats text and image attachments for the visible user bubble", () => {
    const image: UploadedImage = {
      id: "image-1",
      name: "screen.png",
      mimeType: "image/png",
      size: 100,
      createdAt: "2026-05-10T00:00:00.000Z",
      previewUrl: "data:image/png;base64,AAA="
    };

    expect(displayTextForTurn("Look at this", [image])).toBe("Look at this\n[Image: screen.png]");
  });
});
