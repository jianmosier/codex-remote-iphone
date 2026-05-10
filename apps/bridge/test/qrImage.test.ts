import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { saveQrPng } from "../src/qrImage.js";

let dir: string | null = null;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = null;
});

describe("saveQrPng", () => {
  it("returns a fresh unique QR image path instead of the latest alias", async () => {
    dir = await mkdtemp(resolve(tmpdir(), "cri-qr-"));
    const saved = await saveQrPng("https://example.trycloudflare.com/#token=fresh", dir);

    expect(basename(saved.timestampedPath)).toMatch(/^qr-example-/);
    expect(basename(saved.timestampedPath)).not.toBe("latest-qr.png");
    expect(saved.bytes).toBeGreaterThan(0);
    expect(await stat(saved.timestampedPath)).toMatchObject({ size: saved.bytes });
    expect(saved.latestPath ? basename(saved.latestPath) : null).toBe("latest-qr.png");
  });
});
