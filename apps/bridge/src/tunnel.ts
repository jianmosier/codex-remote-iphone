import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { lookup, Resolver } from "node:dns/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getDataDir } from "./config.js";
import { commandExists, runCapture } from "./system.js";

export function parseTryCloudflareUrl(text: string): string | null {
  return text.match(/https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/)?.[0] ?? null;
}

export async function findCloudflared(): Promise<string | null> {
  const existing = await commandExists("cloudflared");
  if (existing) return existing;
  const cached = resolve(getDataDir(), "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const version = await runCapture(cached, ["--version"], { timeoutMs: 5_000 });
  return version.code === 0 ? cached : null;
}

export async function ensureCloudflared(onLog: (line: string) => void = () => undefined): Promise<string> {
  const existing = await findCloudflared();
  if (existing) return existing;

  const url = resolveCloudflaredUrl();
  onLog(`cloudflared not found; downloading ${url}`);
  const binDir = resolve(getDataDir(), "bin");
  await mkdir(binDir, { recursive: true });
  const archive = resolve(tmpdir(), `cloudflared-${Date.now()}.tgz`);
  const bin = resolve(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");

  await download(url, archive, onLog);
  if (url.endsWith(".tgz")) {
    const result = await runCapture("tar", ["-xzf", archive, "-C", binDir], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`Failed to extract cloudflared: ${result.stderr}`);
  } else {
    await rename(archive, bin);
  }
  await rm(archive, { force: true });
  await chmod(bin, 0o755);
  return bin;
}

export type QuickTunnel = {
  pid?: number;
  url: string;
  stop: () => void;
};

const maxAttempts = 5;
const dnsSettleMs = 15_000;
const dnsResolvers = [
  { name: "Cloudflare DNS", server: "1.1.1.1" },
  { name: "Google DNS", server: "8.8.8.8" },
  { name: "AliDNS", server: "223.5.5.5" },
  { name: "DNSPod", server: "119.29.29.29" },
  { name: "114DNS", server: "114.114.114.114" }
];

export async function startQuickTunnel(port: number, onLog: (line: string) => void): Promise<QuickTunnel> {
  const bin = await ensureCloudflared(onLog);
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      onLog(`starting cloudflared tunnel for http://127.0.0.1:${port} (attempt ${attempt}/${maxAttempts})`);
      return await startQuickTunnelOnce(bin, port, onLog);
    } catch (error) {
      lastError = error as Error;
      onLog(`cloudflared quick tunnel attempt ${attempt} failed: ${lastError.message}`);
      if (attempt < maxAttempts) await delay(1_500);
    }
  }
  throw lastError ?? new Error("cloudflared quick tunnel failed");
}

async function startQuickTunnelOnce(
  bin: string,
  port: number,
  onLog: (line: string) => void
): Promise<QuickTunnel> {
  const proxySummary = summarizeProxyEnv();
  onLog(
    proxySummary
      ? `cloudflared egress may use local proxy env: ${proxySummary}`
      : "cloudflared egress has no proxy env configured"
  );
  const child = spawn(bin, ["tunnel", "--url", `http://127.0.0.1:${port}`], {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let url: string;
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for Cloudflare tunnel readiness")), 75_000);
      let resolved = false;
      let publishedUrl: string | null = null;
      let registered = false;
      const maybeResolve = () => {
        if (!publishedUrl || !registered || resolved) return;
        resolved = true;
        clearTimeout(timer);
        resolve(publishedUrl);
      };
      const handle = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        for (const line of text.split(/\r?\n/).filter(Boolean)) {
          onLog(line);
          const parsed = parseTryCloudflareUrl(line);
          if (parsed) publishedUrl = parsed;
          if (line.includes("Registered tunnel connection")) registered = true;
          maybeResolve();
        }
      };
      child.stdout.on("data", handle);
      child.stderr.on("data", handle);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        if (resolved) return;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited before the tunnel was ready, code ${code ?? "null"}`));
      });
    });
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }
  try {
    onLog(`waiting ${Math.round(dnsSettleMs / 1000)}s for quick tunnel DNS to settle`);
    await delay(dnsSettleMs);
    await verifyQuickTunnel(url, onLog);
  } catch (error) {
    child.kill("SIGTERM");
    throw error;
  }

  return {
    pid: child.pid,
    url,
    stop: () => child.kill("SIGTERM")
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPublicRoute(url: string): Promise<{ ok: boolean; detail: string }> {
  const startedAt = Date.now();
  let lastError = "";
  while (Date.now() - startedAt < 45_000) {
    const result = await probePublicRoute(url);
    if (result.ok) return result;
    lastError = result.detail;
    await delay(1_000);
  }
  return { ok: false, detail: lastError || "timed out" };
}

async function verifyQuickTunnel(url: string, onLog: (line: string) => void): Promise<void> {
  const hostname = new URL(url).hostname;
  onLog("phone delivery checks use direct DNS/HTTPS and intentionally ignore local proxy env");
  const dnsResults = await Promise.all(dnsResolvers.map((resolver) => resolveWithServer(hostname, resolver.server)));
  for (const [index, result] of dnsResults.entries()) {
    const resolver = dnsResolvers[index];
    onLog(
      `dns check ${resolver.name} (${resolver.server}): ${
        result.ok ? `ok ${result.addresses.join(",")}` : `failed ${result.detail}`
      }`
    );
  }
  const failedDns = dnsResults
    .map((result, index) => ({ ...result, resolver: dnsResolvers[index] }))
    .filter((result) => !result.ok);
  if (failedDns.length) {
    throw new Error(
      `quick tunnel DNS is not globally ready: ${failedDns
        .map((result) => `${result.resolver.name}/${result.resolver.server}: ${result.detail}`)
        .join("; ")}`
    );
  }

  const systemDns = await resolveWithSystem(hostname);
  onLog(
    `dns check system resolver: ${
      systemDns.ok ? `ok ${systemDns.addresses.join(",")}` : `failed ${systemDns.detail}`
    }`
  );
  if (!systemDns.ok) throw new Error(`quick tunnel DNS failed on system resolver: ${systemDns.detail}`);

  const publicRoute = await waitForPublicRoute(url);
  if (!publicRoute.ok) throw new Error(`quick tunnel public route failed: ${publicRoute.detail}`);
  onLog(`cloudflared public route is reachable: ${url}`);
}

function summarizeProxyEnv(): string {
  return ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]
    .flatMap((key) => {
      const value = process.env[key];
      if (!value) return [];
      return `${key}=${redactProxyValue(value)}`;
    })
    .join(", ");
}

function redactProxyValue(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value.replace(/\/\/([^/@]+)@/, "//****@");
  }
}

async function resolveWithServer(
  hostname: string,
  server: string
): Promise<{ ok: boolean; addresses: string[]; detail: string }> {
  const resolver = new Resolver();
  resolver.setServers([server]);
  try {
    const addresses = await withTimeout(resolver.resolve4(hostname), 5_000, `${server} timed out`);
    return addresses.length
      ? { ok: true, addresses, detail: "" }
      : { ok: false, addresses: [], detail: "no A records" };
  } catch (error) {
    return { ok: false, addresses: [], detail: (error as Error).message };
  }
}

async function resolveWithSystem(hostname: string): Promise<{ ok: boolean; addresses: string[]; detail: string }> {
  try {
    const records = await withTimeout(lookup(hostname, { all: true }), 5_000, "system resolver timed out");
    const addresses = records.map((record) => record.address);
    return addresses.length
      ? { ok: true, addresses, detail: "" }
      : { ok: false, addresses: [], detail: "no records" };
  } catch (error) {
    return { ok: false, addresses: [], detail: (error as Error).message };
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function probePublicRoute(url: string): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const request = get(url, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk.slice(0, Math.max(0, 2_000 - body.length));
      });
      response.on("end", () => {
        const statusCode = response.statusCode ?? 0;
        const cloudflareError = body.match(/Error\s+(1016|1033)/)?.[0];
        if (statusCode >= 200 && statusCode < 500 && !cloudflareError) {
          resolve({ ok: true, detail: `HTTP ${statusCode}` });
          return;
        }
        resolve({ ok: false, detail: cloudflareError ? `${cloudflareError} HTTP ${statusCode}` : `HTTP ${statusCode}` });
      });
    });
    request.setTimeout(5_000, () => {
      request.destroy(new Error("route probe timed out"));
    });
    request.on("error", (error) => {
      resolve({ ok: false, detail: error.message });
    });
  });
}

function resolveCloudflaredUrl(): string {
  if (process.platform === "darwin" && process.arch === "arm64") {
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz";
  }
  if (process.platform === "darwin" && process.arch === "x64") {
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz";
  }
  if (process.platform === "linux" && process.arch === "x64") {
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64";
  }
  if (process.platform === "linux" && process.arch === "arm64") {
    return "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64";
  }
  throw new Error(`Automatic cloudflared download is not supported for ${process.platform}/${process.arch}`);
}

function download(url: string, target: string, onLog: (line: string) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        if (redirects > 5) {
          reject(new Error("Too many redirects while downloading cloudflared"));
          return;
        }
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        download(redirected, target, onLog, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }
      let bytes = 0;
      const startedAt = Date.now();
      const progress = setInterval(() => {
        const mb = (bytes / 1024 / 1024).toFixed(1);
        onLog(`downloading cloudflared: ${mb} MB`);
      }, 5_000);
      const cleanup = () => clearInterval(progress);
      const file = createWriteStream(target);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
      });
      response.pipe(file);
      file.on("finish", () => {
        cleanup();
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        onLog(`downloaded cloudflared: ${(bytes / 1024 / 1024).toFixed(1)} MB in ${seconds}s`);
        file.close(() => resolve());
      });
      file.on("error", (error) => {
        cleanup();
        reject(error);
      });
    });
    request.setTimeout(180_000, () => {
      request.destroy(new Error("Timed out downloading cloudflared after 180 seconds"));
    });
    request.on("error", reject);
  });
}
