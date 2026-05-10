import { describe, expect, it } from "vitest";
import { decodeImageUploadBody, extensionForMimeType } from "../src/imageUpload.js";

describe("image uploads", () => {
  it("accepts supported data URL images", () => {
    const decoded = decodeImageUploadBody({
      name: "phone shot.png",
      dataUrl: "data:image/png;base64,aGVsbG8="
    });

    expect(decoded.name).toBe("phone shot.png");
    expect(decoded.mimeType).toBe("image/png");
    expect(decoded.extension).toBe("png");
    expect(decoded.buffer.toString("utf8")).toBe("hello");
  });

  it("rejects unsupported image types", () => {
    expect(() =>
      decodeImageUploadBody({
        name: "vector.svg",
        dataUrl: "data:image/svg+xml;base64,PHN2Zy8+"
      })
    ).toThrow(/Unsupported/);
  });

  it("maps mobile-friendly mime types to extensions", () => {
    expect(extensionForMimeType("image/jpeg")).toBe("jpg");
    expect(extensionForMimeType("image/webp")).toBe("webp");
    expect(extensionForMimeType("text/plain")).toBeNull();
  });
});
