import { createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { get } from "node:https";
import { lookup, Resolver } from "node:dns/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { getDataDir } from "./config.js";
import { commandExists, runCapture } from "./system.js";

const cloudflaredPathEnvVar = "CODEX_REMOTE_IPHONE_CLOUDFLARED";
const cloudflaredUrlEnvVar = "CODEX_REMOTE_IPHONE_CLOUDFLARED_URL";
const downloadResponseTimeoutMs = 45_000;
const downloadTimeoutMs = 180_000;

export function parseTryCloudflareUrl(text: string): string | null {
  return text.match(/https:\/\/[-a-zA-Z0-9]+\.trycloudflare\.com/)?.[0] ?? null;
}

export async function findCloudflared(): Promise<string | null> {
  const configured = process.env[cloudflaredPathEnvVar]?.trim();
  if (configured) {
    const version = await runCapture(configured, ["--version"], { timeoutMs: 5_000 });
    if (version.code === 0) return configured;
  }
  const existing = await commandExists("cloudflared");
  if (existing) return existing;
  const cached = resolve(getDataDir(), "bin", process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const version = await runCapture(cached, ["--version"], { timeoutMs: 5_000 });
  return version.code === 0 ? cached : null;
}

export async function requireCloudflared(): Promise<string> {
  const bin = await findCloudflared();
  if (!bin) {
    throw new Error(
      "cloudflared is not installed. Run `[$codex-remote-iphone] setup` or `npm run setup` once before starting the tunnel."
    );
  }
  return bin;
}

export async function ensureCloudflared(onLog: (line: string) => void = () => undefined): Promise<string> {
  const existing = await findCloudflared();
  if (existing) return existing;

  const sources = resolveInitialDownloadSources();
  onLog(`cloudflared not found; trying download sources: ${sources.map((source) => source.label).join(", ")}`);
  const binDir = resolve(getDataDir(), "bin");
  await mkdir(binDir, { recursive: true });
  const bin = resolve(binDir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const errors: string[] = [];
  let triedGitHubApi = false;

  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    const archive = resolve(tmpdir(), `cloudflared-${Date.now()}-${index}${source.archive ? ".tgz" : ""}`);
    try {
      onLog(`trying cloudflared source: ${source.label} (${source.url})`);
      await download(source, archive, onLog);
      await installDownloadedCloudflared(source, archive, binDir, bin, onLog);
      const version = await runCapture(bin, ["--version"], { timeoutMs: 5_000 });
      if (version.code !== 0) throw new Error(`installed binary did not run: ${version.stderr || version.stdout}`);
      onLog(`installed project-local cloudflared: ${bin}`);
      return bin;
    } catch (error) {
      await rm(archive, { force: true });
      await rm(bin, { force: true });
      const message = `${source.label} failed: ${formatError(error)}`;
      errors.push(message);
      onLog(message);
    }

    if (index === sources.length - 1 && !triedGitHubApi) {
      triedGitHubApi = true;
      const apiSource = await resolveGitHubApiDownloadSource(onLog);
      if (apiSource && !sources.some((candidate) => candidate.url === apiSource.url)) sources.push(apiSource);
    }
  }

  throw new Error(formatDownloadFailure(sources, bin, errors, await commandExists("curl"), await commandExists("wget")));
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
  const bin = await requireCloudflared();
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

export function resolveCloudflaredUrl(): string {
  return `https://github.com/cloudflare/cloudflared/releases/latest/download/${resolveCloudflaredAssetName()}`;
}

type DownloadSource = {
  label: string;
  url: string;
  archive: boolean;
};

function resolveCloudflaredAssetName(): string {
  if (process.platform === "darwin" && process.arch === "arm64") return "cloudflared-darwin-arm64.tgz";
  if (process.platform === "darwin" && process.arch === "x64") return "cloudflared-darwin-amd64.tgz";
  if (process.platform === "linux" && process.arch === "x64") return "cloudflared-linux-amd64";
  if (process.platform === "linux" && process.arch === "arm64") return "cloudflared-linux-arm64";
  throw new Error(`Automatic cloudflared download is not supported for ${process.platform}/${process.arch}`);
}

function resolveInitialDownloadSources(): DownloadSource[] {
  const configuredUrl = process.env[cloudflaredUrlEnvVar]?.trim();
  const sources: DownloadSource[] = [];
  if (configuredUrl) {
    sources.push({
      label: `${cloudflaredUrlEnvVar} override`,
      url: configuredUrl,
      archive: isArchiveUrl(configuredUrl)
    });
  }
  let officialUrl: string | null = null;
  try {
    officialUrl = resolveCloudflaredUrl();
  } catch (error) {
    if (sources.length === 0) throw error;
  }
  if (!officialUrl) return sources;
  sources.push({
    label: "GitHub latest release",
    url: officialUrl,
    archive: isArchiveUrl(officialUrl)
  });
  return sources;
}

async function download(source: DownloadSource, target: string, onLog: (line: string) => void): Promise<void> {
  const proxySummary = getProxyEnvSummary();
  const downloaders = await resolveDownloaders(proxySummary);
  const errors: string[] = [];

  if (proxySummary) onLog(`proxy env detected (${proxySummary}); trying proxy-aware and direct download paths`);

  for (const downloader of downloaders) {
    try {
      onLog(`trying ${downloader.label} for ${source.label}`);
      await downloader.run(source.url, target, onLog);
      return;
    } catch (error) {
      await rm(target, { force: true });
      const message = `${downloader.label} failed: ${formatError(error)}`;
      errors.push(message);
      onLog(message);
    }
  }

  throw new Error(errors.join("; "));
}

type Downloader = {
  label: string;
  run: (url: string, target: string, onLog: (line: string) => void) => Promise<void>;
};

async function resolveDownloaders(proxySummary: string | null): Promise<Downloader[]> {
  const curl = await commandExists("curl");
  const wget = await commandExists("wget");
  const downloaders: Downloader[] = [];

  if (proxySummary) {
    if (curl) downloaders.push({ label: "curl with environment proxy", run: downloadWithCurl });
    if (wget) downloaders.push({ label: "wget with environment proxy", run: downloadWithWget });
    downloaders.push({ label: "node:https direct", run: downloadWithNodeHttps });
    if (curl) {
      downloaders.push({
        label: "curl direct without proxy",
        run: (url, target, onLog) => downloadWithCurl(url, target, onLog, { noProxy: true })
      });
    }
    if (wget) {
      downloaders.push({
        label: "wget direct without proxy",
        run: (url, target, onLog) => downloadWithWget(url, target, onLog, { noProxy: true })
      });
    }
    return downloaders;
  }

  downloaders.push({ label: "node:https direct", run: downloadWithNodeHttps });
  if (curl) downloaders.push({ label: "curl", run: downloadWithCurl });
  if (wget) downloaders.push({ label: "wget", run: downloadWithWget });
  return downloaders;
}

async function installDownloadedCloudflared(
  source: DownloadSource,
  downloadedPath: string,
  binDir: string,
  bin: string,
  onLog: (line: string) => void
): Promise<void> {
  if (source.archive) {
    onLog(`extracting cloudflared archive from ${source.label}`);
    const result = await runCapture("tar", ["-xzf", downloadedPath, "-C", binDir], { timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(`Failed to extract cloudflared: ${result.stderr || result.stdout}`);
  } else {
    onLog(`installing cloudflared binary from ${source.label}`);
    await rename(downloadedPath, bin);
  }
  await rm(downloadedPath, { force: true });
  await chmod(bin, 0o755);
}

async function resolveGitHubApiDownloadSource(onLog: (line: string) => void): Promise<DownloadSource | null> {
  const apiUrl = "https://api.github.com/repos/cloudflare/cloudflared/releases/latest";
  try {
    const assetName = resolveCloudflaredAssetName();
    onLog(`resolving cloudflared versioned asset from GitHub API for ${assetName}`);
    const text = await readUrlText(apiUrl, onLog);
    const release = JSON.parse(text) as {
      assets?: Array<{ name?: string; browser_download_url?: string }>;
    };
    const asset = release.assets?.find((candidate) => candidate.name === assetName);
    if (!asset?.browser_download_url) {
      onLog(`GitHub API did not return an asset named ${assetName}`);
      return null;
    }
    return {
      label: "GitHub API versioned release",
      url: asset.browser_download_url,
      archive: isArchiveUrl(asset.browser_download_url)
    };
  } catch (error) {
    onLog(`GitHub API source lookup failed: ${formatError(error)}`);
    return null;
  }
}

function downloadWithNodeHttps(url: string, target: string, onLog: (line: string) => void, redirects = 0): Promise<void> {
  return new Promise((resolve, reject) => {
    let responseStarted = false;
    let request: ReturnType<typeof get>;
    const waiting = setInterval(() => {
      if (!responseStarted) onLog(`waiting for cloudflared download response from ${new URL(url).hostname}...`);
    }, 5_000);
    const cleanupWaiting = () => clearInterval(waiting);
    const noResponseTimer = setTimeout(() => {
      if (!responseStarted) request.destroy(new Error("No response from download source after 45 seconds"));
    }, downloadResponseTimeoutMs);
    const cleanupNoResponseTimer = () => clearTimeout(noResponseTimer);
    request = get(url, { headers: { "User-Agent": "codex-remote-iphone-setup" } }, (response) => {
      responseStarted = true;
      cleanupWaiting();
      cleanupNoResponseTimer();
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        if (redirects > 5) {
          reject(new Error("Too many redirects while downloading cloudflared"));
          return;
        }
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        onLog(`cloudflared download redirected to ${new URL(redirected).hostname}`);
        downloadWithNodeHttps(redirected, target, onLog, redirects + 1).then(resolve, reject);
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
    request.setTimeout(downloadTimeoutMs, () => {
      request.destroy(new Error("Timed out downloading cloudflared after 180 seconds"));
    });
    request.on("error", (error) => {
      cleanupWaiting();
      cleanupNoResponseTimer();
      reject(error);
    });
  });
}

function downloadWithCurl(
  url: string,
  target: string,
  onLog: (line: string) => void,
  options: { noProxy?: boolean } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stderr = "";
    let stdout = "";
    onLog(`downloading cloudflared with curl from ${new URL(url).hostname}`);
    const args = [
      "--fail",
      "--location",
      "--show-error",
      "--silent",
      "--retry",
      "2",
      "--retry-delay",
      "2",
      "--connect-timeout",
      "30",
      "--speed-limit",
      "1024",
      "--speed-time",
      "30",
      "--max-time",
      String(Math.floor(downloadTimeoutMs / 1000)),
      "--output",
      target,
      url
    ];
    if (options.noProxy) args.splice(0, 0, "--noproxy", "*");
    const child = spawn(
      "curl",
      args,
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const heartbeat = setInterval(() => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
      onLog(`waiting for curl download (${seconds}s elapsed)...`);
    }, 5_000);
    const cleanup = () => clearInterval(heartbeat);
    child.stdout.on("data", (chunk) => {
      stdout = trimLog(`${stdout}${String(chunk)}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimLog(`${stderr}${String(chunk)}`);
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      if (code === 0) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        onLog(`downloaded cloudflared with curl in ${seconds}s`);
        resolve();
        return;
      }
      reject(new Error(`curl exited with code ${code}: ${stderr || stdout || "no output"}`));
    });
  });
}

function downloadWithWget(
  url: string,
  target: string,
  onLog: (line: string) => void,
  options: { noProxy?: boolean } = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let stderr = "";
    let stdout = "";
    const args = [
      "--quiet",
      "--tries=2",
      "--timeout=30",
      `--output-document=${target}`,
      url
    ];
    const env = options.noProxy ? withoutProxyEnv() : process.env;
    onLog(`downloading cloudflared with wget from ${new URL(url).hostname}`);
    const child = spawn("wget", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    const heartbeat = setInterval(() => {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(0);
      onLog(`waiting for wget download (${seconds}s elapsed)...`);
    }, 5_000);
    const cleanup = () => clearInterval(heartbeat);
    const timer = setTimeout(() => child.kill("SIGTERM"), downloadTimeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = trimLog(`${stdout}${String(chunk)}`);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimLog(`${stderr}${String(chunk)}`);
    });
    child.on("error", (error) => {
      cleanup();
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      cleanup();
      clearTimeout(timer);
      if (code === 0) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        onLog(`downloaded cloudflared with wget in ${seconds}s`);
        resolve();
        return;
      }
      reject(new Error(`wget exited with code ${code}: ${stderr || stdout || "no output"}`));
    });
  });
}

async function readUrlText(url: string, onLog: (line: string) => void): Promise<string> {
  const proxySummary = getProxyEnvSummary();
  const curl = await commandExists("curl");
  const attempts: Array<{ label: string; run: () => Promise<string> }> = [];

  if (proxySummary && curl) {
    attempts.push({ label: "curl with environment proxy", run: () => readUrlTextWithCurl(url) });
    attempts.push({ label: "node:https direct", run: () => readUrlTextWithNodeHttps(url) });
    attempts.push({ label: "curl direct without proxy", run: () => readUrlTextWithCurl(url, { noProxy: true }) });
  } else {
    attempts.push({ label: "node:https direct", run: () => readUrlTextWithNodeHttps(url) });
    if (curl) attempts.push({ label: "curl", run: () => readUrlTextWithCurl(url) });
  }

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      onLog(`trying ${attempt.label} for GitHub API metadata`);
      return await attempt.run();
    } catch (error) {
      errors.push(`${attempt.label} failed: ${formatError(error)}`);
    }
  }
  throw new Error(errors.join("; "));
}

function readUrlTextWithNodeHttps(url: string, redirects = 0): Promise<string> {
  return new Promise((resolve, reject) => {
    let request: ReturnType<typeof get>;
    const timer = setTimeout(() => request.destroy(new Error("No response after 30 seconds")), 30_000);
    request = get(url, { headers: { "User-Agent": "codex-remote-iphone-setup" } }, (response) => {
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        if (redirects > 5) {
          reject(new Error("Too many redirects"));
          return;
        }
        response.resume();
        const redirected = new URL(response.headers.location, url).toString();
        readUrlTextWithNodeHttps(redirected, redirects + 1).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => resolve(text));
      response.on("error", reject);
    });
    request.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function readUrlTextWithCurl(url: string, options: { noProxy?: boolean } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const args = ["--fail", "--location", "--show-error", "--silent", "--connect-timeout", "15", "--max-time", "30", url];
    if (options.noProxy) args.splice(0, 0, "--noproxy", "*");
    const child = spawn("curl", args, { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = trimLog(`${stderr}${String(chunk)}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      reject(new Error(`curl exited with code ${code}: ${stderr || stdout || "no output"}`));
    });
  });
}

function formatDownloadFailure(
  sources: DownloadSource[],
  installPath: string,
  errors: string[],
  curl: string | null,
  wget: string | null
): string {
  const lines = [
    "Could not install project-local cloudflared automatically.",
    `Download sources tried: ${sources.map((source) => source.label).join(", ")}`,
    `Install location: ${installPath}`,
    `Failed attempts: ${errors.join("; ") || "none"}`,
    "Automatic setup exhausted the available official download routes and local downloaders.",
    "Fix options:",
    "1. Install cloudflared yourself with your platform package manager, for example `brew install cloudflared` on macOS, then rerun `npm run setup`.",
    `2. Or manually download the file above, extract/copy the cloudflared binary to ${installPath}, run \`chmod +x ${installPath}\`, then rerun \`npm run setup\`.`,
    `3. Or set ${cloudflaredPathEnvVar}=/absolute/path/to/cloudflared before running setup.`,
    `4. Or set ${cloudflaredUrlEnvVar}=https://your-mirror/cloudflared before running setup.`
  ];
  if (!curl) lines.push("Tip: installing curl gives setup another downloader and better proxy support.");
  if (!wget) lines.push("Tip: installing wget gives setup one more automatic download path.");
  return lines.join("\n");
}

function isArchiveUrl(url: string): boolean {
  return new URL(url).pathname.endsWith(".tgz");
}

function withoutProxyEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]) {
    delete env[name];
  }
  env.NO_PROXY = "*";
  env.no_proxy = "*";
  return env;
}

function getProxyEnvSummary(): string | null {
  const names = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const entries = names
    .map((name) => [name, process.env[name]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  if (entries.length === 0) return null;
  return entries.map(([name, value]) => `${name}=${redactProxy(value)}`).join(", ");
}

function redactProxy(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return value.replace(/\/\/[^/@]+@/, "//***@");
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trimLog(value: string): string {
  return value.length > 2_000 ? value.slice(-2_000) : value;
}
