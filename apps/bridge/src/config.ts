import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

export type DeviceLimitPolicy = "disconnectAll" | "rejectNew";

export type AppConfig = {
  maxActiveDevices: number;
  deviceTokenTtlMinutes: number;
  requireDesktopPairingApproval: boolean;
  desktopApprovalPrompt: boolean;
  pairingApprovalTtlSeconds: number;
  onDeviceLimitExceeded: DeviceLimitPolicy;
  auditLogRetentionDays: number;
};

export const defaultConfig: AppConfig = {
  maxActiveDevices: 1,
  deviceTokenTtlMinutes: 10,
  requireDesktopPairingApproval: true,
  desktopApprovalPrompt: true,
  pairingApprovalTtlSeconds: 120,
  onDeviceLimitExceeded: "disconnectAll",
  auditLogRetentionDays: 30
};

export function getDataDir(): string {
  return resolve(homedir(), ".codex-remote-iphone");
}

export function getConfigPath(): string {
  return resolve(getDataDir(), "config.json");
}

export async function loadConfig(): Promise<AppConfig> {
  await mkdir(getDataDir(), { recursive: true });
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    const normalized = normalizeConfig(parsed);
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) await saveConfig(normalized);
    return normalized;
  } catch {
    await saveConfig(defaultConfig);
    return defaultConfig;
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(getConfigPath(), `${JSON.stringify(normalizeConfig(config), null, 2)}\n`, "utf8");
}

export function normalizeConfig(input: Partial<AppConfig>): AppConfig {
  return {
    maxActiveDevices: clampInteger(input.maxActiveDevices, 1, 16, defaultConfig.maxActiveDevices),
    deviceTokenTtlMinutes: clampInteger(
      input.deviceTokenTtlMinutes,
      1,
      120,
      defaultConfig.deviceTokenTtlMinutes
    ),
    requireDesktopPairingApproval:
      typeof input.requireDesktopPairingApproval === "boolean"
        ? input.requireDesktopPairingApproval
        : defaultConfig.requireDesktopPairingApproval,
    desktopApprovalPrompt:
      typeof input.desktopApprovalPrompt === "boolean" ? input.desktopApprovalPrompt : defaultConfig.desktopApprovalPrompt,
    pairingApprovalTtlSeconds: clampInteger(
      input.pairingApprovalTtlSeconds,
      15,
      600,
      defaultConfig.pairingApprovalTtlSeconds
    ),
    onDeviceLimitExceeded:
      input.onDeviceLimitExceeded === "rejectNew" ? "rejectNew" : defaultConfig.onDeviceLimitExceeded,
    auditLogRetentionDays: clampInteger(
      input.auditLogRetentionDays,
      1,
      365,
      defaultConfig.auditLogRetentionDays
    )
  };
}

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value as number));
}
