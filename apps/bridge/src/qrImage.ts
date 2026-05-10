import { randomUUID } from "node:crypto";
import { mkdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import QRCode from "qrcode";
import { getDataDir } from "./config.js";

export type SavedQrImage = {
  latestPath: string | null;
  timestampedPath: string;
  bytes: number;
  createdAt: string;
};

export async function saveQrPng(url: string, dataDir = getDataDir()): Promise<SavedQrImage> {
  await mkdir(dataDir, { recursive: true });
  const startedAt = Date.now();
  const latestPath = join(dataDir, "latest-qr.png");
  const host = new URL(url).host.split(".")[0]?.replace(/[^a-z0-9-]/gi, "-") || "local";
  const stamp = new Date().toISOString().replace(/[-:.]/g, "").replace("T", "-").replace("Z", "");
  const nonce = randomUUID().slice(0, 8);
  const timestampedPath = join(dataDir, `qr-${host}-${stamp}-${nonce}.png`);
  const options = { margin: 2, width: 720 };

  await QRCode.toFile(timestampedPath, url, options);
  const timestampedStats = await stat(timestampedPath);
  assertFreshUniqueQr(timestampedPath, timestampedStats.size, timestampedStats.mtimeMs, startedAt);

  let savedLatestPath: string | null = latestPath;
  try {
    await QRCode.toFile(latestPath, url, options);
  } catch {
    savedLatestPath = null;
  }

  return {
    latestPath: savedLatestPath,
    timestampedPath,
    bytes: timestampedStats.size,
    createdAt: timestampedStats.mtime.toISOString()
  };
}

function assertFreshUniqueQr(path: string, size: number, mtimeMs: number, startedAt: number): void {
  if (basename(path) === "latest-qr.png") throw new Error("refusing to use latest-qr.png as the display QR image");
  if (size <= 0) throw new Error("fresh QR image is empty");
  if (mtimeMs < startedAt - 5000) throw new Error("QR image was not freshly generated");
}
