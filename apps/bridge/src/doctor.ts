import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigPath, getDataDir, loadConfig } from "./config.js";
import { findCloudflared } from "./tunnel.js";
import { commandExists, isPortAvailable, runCapture } from "./system.js";

export type DoctorCheck = {
  name: string;
  ok: boolean;
  detail: string;
};

const nodeRequirement = "^20.19.0 || >=22.12.0";

export async function runDoctor(port = 8787): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: isSupportedNode(process.versions.node),
    detail: `${process.version} required ${nodeRequirement}`
  });

  const codex = await commandExists("codex");
  checks.push({
    name: "codex",
    ok: Boolean(codex),
    detail: codex ?? "codex command not found"
  });

  if (codex) {
    const appServer = await runCapture("codex", ["app-server", "--help"], { timeoutMs: 10_000 });
    checks.push({
      name: "codex app-server",
      ok: appServer.code === 0,
      detail: appServer.code === 0 ? "available" : appServer.stderr || appServer.stdout
    });

    const login = await runCapture("codex", ["login", "status"], { timeoutMs: 10_000 });
    checks.push({
      name: "codex login",
      ok: login.code === 0,
      detail: (login.stdout || login.stderr || "status checked").trim()
    });
  }

  checks.push({
    name: `port ${port}`,
    ok: await isPortAvailable(port),
    detail: `127.0.0.1:${port}`
  });

  const cloudflared = await findCloudflared();
  checks.push({
    name: "cloudflared",
    ok: Boolean(cloudflared),
    detail: cloudflared ?? "not installed; start will attempt a project-cache download"
  });

  const config = await loadConfig();
  checks.push({
    name: "config",
    ok: true,
    detail: `${getConfigPath()} ${JSON.stringify(config)}`
  });

  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist", "index.html");
  try {
    await access(webDist);
    checks.push({ name: "web build", ok: true, detail: webDist });
  } catch {
    checks.push({ name: "web build", ok: false, detail: "run npm run build or npm run start from the repo root" });
  }

  checks.push({ name: "data dir", ok: true, detail: getDataDir() });
  return checks;
}

function isSupportedNode(version: string): boolean {
  const [major = 0, minor = 0, patch = 0] = version.split(".").map((part) => Number(part));
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return false;
  if (major > 22) return true;
  if (major === 22) return minor >= 12;
  if (major === 20) return minor > 19 || (minor === 19 && patch >= 0);
  return false;
}
