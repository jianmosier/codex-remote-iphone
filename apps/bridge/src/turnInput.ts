export type CodexTurnInput =
  | { type: "text"; text: string; text_elements: [] }
  | { type: "localImage"; path: string };

export type UploadedImageReference = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

export const MAX_IMAGES_PER_TURN = 4;

export function buildTurnInput(text: string, images: UploadedImageReference[]): CodexTurnInput[] {
  const input: CodexTurnInput[] = [];
  const trimmed = text.trim();
  if (trimmed) input.push({ type: "text", text: trimmed, text_elements: [] });
  for (const image of images) input.push({ type: "localImage", path: image.path });
  if (input.length === 0) throw new Error("Prompt or image attachment required");
  return input;
}

export function transcriptTextForTurn(text: string, images: UploadedImageReference[]): string {
  const lines = [];
  const trimmed = text.trim();
  if (trimmed) lines.push(trimmed);
  for (const image of images) lines.push(`[Image: ${image.name}]`);
  return lines.join("\n");
}

export function normalizeImageIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Image attachments must be an array");
  if (value.length > MAX_IMAGES_PER_TURN) throw new Error(`Attach at most ${MAX_IMAGES_PER_TURN} images per turn`);
  return value.map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid image attachment");
    const id = (item as Record<string, unknown>).id;
    if (typeof id !== "string" || !id.trim()) throw new Error("Invalid image attachment id");
    return id;
  });
}
