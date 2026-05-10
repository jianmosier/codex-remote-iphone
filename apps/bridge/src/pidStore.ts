import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getDataDir } from "./config.js";

export type RuntimePids = {
  pid: number;
  appServerPid?: number;
  tunnelPid?: number;
  port: number;
  workspace: string;
  publicUrl: string;
  pairingUrl?: string;
  threadLabel?: string;
  appServerMode?: string;
  startedAt: string;
};

const pidPath = resolve(getDataDir(), "session.json");

export async function writePidFile(pids: RuntimePids): Promise<void> {
  await mkdir(getDataDir(), { recursive: true });
  await writeFile(pidPath, `${JSON.stringify(pids, null, 2)}\n`, "utf8");
}

export async function readPidFile(): Promise<RuntimePids | null> {
  try {
    return JSON.parse(await readFile(pidPath, "utf8")) as RuntimePids;
  } catch {
    return null;
  }
}

export async function clearPidFile(): Promise<void> {
  await rm(pidPath, { force: true });
}

export function isPidRunning(pid?: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function stopRecordedProcesses(): Promise<string[]> {
  const pids = await readPidFile();
  if (!pids) return ["No recorded codex-remote-iphone session found."];
  const messages: string[] = [];
  for (const pid of [pids.tunnelPid, pids.appServerPid, pids.pid].filter(Boolean) as number[]) {
    try {
      process.kill(pid, "SIGTERM");
      messages.push(`Sent SIGTERM to pid ${pid}.`);
    } catch (error) {
      messages.push(`Could not stop pid ${pid}: ${(error as Error).message}`);
    }
  }
  await clearPidFile();
  return messages;
}
