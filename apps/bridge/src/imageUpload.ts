import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { getDataDir } from "./config.js";

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_UPLOAD_BODY_LIMIT = 16 * 1024 * 1024;

export type ImageUploadBody = {
  name?: unknown;
  mimeType?: unknown;
  dataUrl?: unknown;
  dataBase64?: unknown;
};

export type UploadedImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
  createdAt: string;
};

const IMAGE_EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"]
]);

export function publicUploadedImage(image: UploadedImage): Omit<UploadedImage, "path"> {
  return {
    id: image.id,
    name: image.name,
    mimeType: image.mimeType,
    size: image.size,
    createdAt: image.createdAt
  };
}

export function extensionForMimeType(mimeType: string): string | null {
  return IMAGE_EXTENSIONS.get(mimeType.toLowerCase()) ?? null;
}

export function decodeImageUploadBody(body: ImageUploadBody): {
  name: string;
  mimeType: string;
  extension: string;
  buffer: Buffer;
} {
  const parsed = typeof body.dataUrl === "string" ? parseDataUrl(body.dataUrl) : null;
  const rawMimeType = parsed?.mimeType ?? (typeof body.mimeType === "string" ? body.mimeType : "");
  const mimeType = rawMimeType.toLowerCase();
  const extension = extensionForMimeType(mimeType);
  if (!extension) throw new Error("Unsupported image type. Use PNG, JPEG, WebP, or GIF.");

  const base64 = parsed?.base64 ?? (typeof body.dataBase64 === "string" ? body.dataBase64 : "");
  if (!base64.trim()) throw new Error("Missing image data");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(base64)) throw new Error("Image data must be base64 encoded");
  const buffer = Buffer.from(base64.replace(/\s+/g, ""), "base64");
  if (buffer.length === 0) throw new Error("Image data is empty");
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error("Image is too large. Maximum size is 8 MB.");

  const name = sanitizeFileName(typeof body.name === "string" ? body.name : "", extension);
  return { name, mimeType, extension, buffer };
}

export async function saveImageUpload(body: ImageUploadBody, dataDir = getDataDir()): Promise<UploadedImage> {
  const decoded = decodeImageUploadBody(body);
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const day = createdAt.slice(0, 10);
  const dir = resolve(dataDir, "uploads", day);
  await mkdir(dir, { recursive: true });
  const path = resolve(dir, `${id}.${decoded.extension}`);
  await writeFile(path, decoded.buffer);
  return {
    id,
    name: decoded.name,
    mimeType: decoded.mimeType,
    size: decoded.buffer.length,
    path,
    createdAt
  };
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl.trim());
  if (!match) return null;
  return { mimeType: match[1].toLowerCase(), base64: match[2] };
}

function sanitizeFileName(name: string, extension: string): string {
  const fallback = `image.${extension}`;
  const normalized = basename(name.trim()).replace(/[^\w .()+-]+/g, "_").slice(0, 100).trim();
  return normalized || fallback;
}
