import { execFile } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import qrcode from "qrcode-terminal";
import { AuditLog } from "./audit.js";
import { loadConfig, normalizeConfig, saveConfig, type AppConfig } from "./config.js";
import { runDoctor } from "./doctor.js";
import { isPidRunning, readPidFile, stopRecordedProcesses, type RuntimePids } from "./pidStore.js";
import { saveQrPng } from "./qrImage.js";
import { RemoteConsole } from "./server.js";
import { isPortAvailable } from "./system.js";
import { ensureCloudflared, requireCloudflared } from "./tunnel.js";

type CliOptions = {
  workspace: string;
  port: number;
  tunnel: boolean;
  threadId: string | null;
  requireResume: boolean;
  desktopSync: boolean;
};

const execFileAsync = promisify(execFile);

async function main(): Promise<void> {
  const [command = "start", ...args] = process.argv.slice(2);
  const normalizedArgs = command === "start" && args[0] === "new" ? ["--new-thread", ...args.slice(1)] : args;
  const normalizedCommand = command === "new" ? "start" : command;
  const options = parseOptions(normalizedCommand === "start" ? normalizedArgs : args);

  if (normalizedCommand === "help" || normalizedCommand === "--help" || normalizedCommand === "-h") {
    printHelp();
    return;
  }

  if (normalizedCommand === "doctor") {
    const checks = await runDoctor(options.port);
    for (const check of checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    process.exitCode = checks.every((check) => check.ok || check.name === "web build") ? 0 : 1;
    return;
  }

  if (normalizedCommand === "setup") {
    await setupDependencies();
    return;
  }

  if (normalizedCommand === "stop") {
    for (const line of await stopRecordedProcesses()) console.log(line);
    return;
  }

  if (normalizedCommand === "restart") {
    const previousSession = await readPidFile();
    const restartOptions = parseRestartOptions(args, previousSession);
    for (const line of await stopRecordedProcesses()) console.log(line);
    await waitForPort(restartOptions.port);
    await runRemote(restartOptions);
    return;
  }

  if (normalizedCommand === "update") {
    await updateFromGitHub();
    return;
  }

  if (normalizedCommand === "status") {
    await printStatus();
    return;
  }

  if (normalizedCommand === "qr") {
    await printQr();
    return;
  }

  if (normalizedCommand === "approvals") {
    await printPairingApprovals();
    return;
  }

  if (normalizedCommand === "policy") {
    await handlePolicy(args);
    return;
  }

  if (normalizedCommand === "max" || normalizedCommand === "devices") {
    await handleMaxDevices(args[0]);
    return;
  }

  if (normalizedCommand === "approve" || normalizedCommand === "deny") {
    await decidePairingApproval(normalizedCommand, args[0]);
    return;
  }

  if (normalizedCommand === "logs" || normalizedCommand === "audit") {
    await printLogs(args);
    return;
  }

  if (normalizedCommand !== "start") {
    console.error(`Unknown command: ${command}`);
    console.error("Run `npm run help` or use `[$codex-remote-iphone] help` for available commands.");
    process.exitCode = 1;
    return;
  }

  await runRemote(options);
}

async function setupDependencies(): Promise<void> {
  console.log("Checking cloudflared before starting codex-remote-iphone...");
  const bin = await ensureCloudflared((line) => console.log(line));
  console.log(`cloudflared ready: ${bin}`);
  console.log("Setup complete. You can now use `[$codex-remote-iphone] start`.");
}

async function runRemote(options: CliOptions): Promise<void> {
  if (options.tunnel) await requireCloudflared();
  const remote = await RemoteConsole.start(options);
  console.log("");
  console.log("codex-remote-iphone is running");
  console.log(`Workspace: ${options.workspace}`);
  console.log(`Thread: ${remote.threadLabel}`);
  console.log(`Codex mode: ${remote.codexMode}`);
  console.log(`URL: ${remote.url}`);
  console.log("");
  qrcode.generate(remote.url, { small: true });
  await printSavedQr(remote.url);
  console.log("");
  console.log("Scan the QR code with your phone. Press Ctrl-C to stop.");

  const stop = async () => {
    await remote.shutdown("signal");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

function printHelp(): void {
  console.log(`codex-remote-iphone

Skill usage:
  [$codex-remote-iphone] start
  [$codex-remote-iphone] new          # start an isolated phone-only session
  [$codex-remote-iphone] start new    # same as new
  [$codex-remote-iphone] qr
  [$codex-remote-iphone] status
  [$codex-remote-iphone] stop
  [$codex-remote-iphone] restart
  [$codex-remote-iphone] update       # pull the latest GitHub version safely
  [$codex-remote-iphone] setup        # install/check cloudflared before first start
  [$codex-remote-iphone] max          # show maximum active devices
  [$codex-remote-iphone] max 3        # set maximum active devices to 3
  [$codex-remote-iphone] approvals
  [$codex-remote-iphone] approve <id>
  [$codex-remote-iphone] deny <id>
  [$codex-remote-iphone] logs
  [$codex-remote-iphone] doctor

Raw npm usage:
  npm run start -- --workspace /absolute/path
  npm run new
  npm run start -- --new-thread
  npm run qr
  npm run status
  npm run stop
  npm run restart
  npm run update
  npm run setup
  npm run max
  npm run max -- 3
  npm run approvals
  npm run approve -- <id>
  npm run deny -- <id>
  npm run logs -- --lines 80
  npm run doctor

Commands:
  help                  Show this help.
  start                 Start bridge, Codex Desktop IPC/app-server, tunnel, URL, and QR.
  new                   Start a separate phone-only Codex thread, not the current Desktop thread.
  start new             Same as new.
  stop                  Stop recorded bridge, app-server, and tunnel processes.
  restart               Stop the recorded session, then start again with the same workspace, port, and thread mode.
  update                Safely update this clone to the latest GitHub version and reinstall the skill.
  setup                 Download or verify the project-local cloudflared binary before first start.
  status                Show workspace, thread, Codex mode, URL, and process health.
  qr                    Rotate a one-time pairing token and print a fresh QR.
  approvals             List phone pairing requests waiting for desktop confirmation.
  approve <id>          Allow a pending phone pairing request.
  deny <id>             Reject a pending phone pairing request.
  max                   Show maximum active devices.
  max <number>          Set maximum active devices to <number>, from 1 to 16.
  policy                Advanced: show full local policy config.
  policy <key> <value>  Advanced: set a raw policy key, for example token TTL or approval timeout.
  logs [--lines 80]     Show recent audit log events.
  audit [--lines 80]    Alias for logs.
  doctor                Check Codex, login, port, cloudflared, config, and web build.

Start options:
  --workspace, -w <path>  Workspace to control. Default: current directory.
  --port, -p <port>       Local bridge port. Default: 8787.
  --thread-id <id>        Resume a specific Codex thread.
  --new-thread            Force an isolated phone-only thread. Same behavior as new/start new.
  --no-desktop-sync       Force standalone codex app-server mode.
  --no-tunnel             Run local-only without Cloudflare Quick Tunnel.

Default safety:
  - QR token expires and is consumed after use.
  - Desktop pairing approval is required before a phone gets a session.
  - Default max devices is controlled by maxActiveDevices.

Advanced policy keys:
  maxActiveDevices, deviceTokenTtlMinutes, requireDesktopPairingApproval,
  desktopApprovalPrompt, pairingApprovalTtlSeconds, onDeviceLimitExceeded,
  auditLogRetentionDays
`);
}

function parseOptions(args: string[]): CliOptions {
  const options: CliOptions = {
    workspace: process.cwd(),
    port: 8787,
    tunnel: true,
    threadId: process.env.CODEX_THREAD_ID ?? null,
    requireResume: false,
    desktopSync: true
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--workspace" || arg === "-w") {
      options.workspace = resolve(args[++index] ?? process.cwd());
    } else if (arg === "--port" || arg === "-p") {
      options.port = Number(args[++index] ?? "8787");
    } else if (arg === "--no-tunnel") {
      options.tunnel = false;
    } else if (arg === "--thread-id") {
      options.threadId = args[++index] ?? null;
      options.requireResume = true;
    } else if (arg === "--new-thread") {
      options.threadId = null;
      options.requireResume = false;
      options.desktopSync = false;
    } else if (arg === "--no-desktop-sync") {
      options.desktopSync = false;
    }
  }
  return options;
}

function parseRestartOptions(args: string[], previousSession: RuntimePids | null): CliOptions {
  const overrides = parseOptions(args);
  if (!previousSession) return overrides;
  const thread = parseThreadLabel(previousSession.threadLabel);
  const hasWorkspace = hasOption(args, "--workspace", "-w");
  const hasPort = hasOption(args, "--port", "-p");
  const hasExplicitThread = args.includes("--thread-id");
  const forceNewThread = args.includes("--new-thread");
  const threadId = forceNewThread ? null : hasExplicitThread ? overrides.threadId : thread.threadId ?? overrides.threadId;
  return {
    workspace: hasWorkspace ? overrides.workspace : previousSession.workspace,
    port: hasPort ? overrides.port : previousSession.port,
    tunnel: args.includes("--no-tunnel") ? false : true,
    threadId,
    requireResume: Boolean(threadId),
    desktopSync: forceNewThread || args.includes("--no-desktop-sync")
      ? false
      : previousSession.appServerMode === "app-server"
        ? false
        : overrides.desktopSync
  };
}

function hasOption(args: string[], longName: string, shortName: string): boolean {
  return args.includes(longName) || args.includes(shortName);
}

function parseThreadLabel(threadLabel: string | undefined): { mode: string | null; threadId: string | null } {
  const match = threadLabel?.match(/^([^:]+):(.+)$/);
  if (!match) return { mode: null, threadId: null };
  if (match[1] !== "resumed") return { mode: match[1], threadId: null };
  return { mode: match[1], threadId: match[2] };
}

async function waitForPort(port: number): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (await isPortAvailable(port)) return;
    await delay(250);
  }
  throw new Error(`Port ${port} did not become available after stopping the previous session`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function printStatus(): Promise<void> {
  const session = await readPidFile();
  if (!session) {
    console.log("No recorded codex-remote-iphone session found.");
    return;
  }
  console.log("codex-remote-iphone status");
  console.log(`Workspace: ${session.workspace}`);
  if (session.threadLabel) console.log(`Thread: ${session.threadLabel}`);
  if (session.appServerMode) console.log(`Codex mode: ${session.appServerMode}`);
  console.log(`Started: ${session.startedAt}`);
  console.log(`Port: ${session.port}`);
  console.log(`URL: ${session.publicUrl}`);
  if (session.pairingUrl) console.log(`Pairing URL: ${session.pairingUrl}`);
  const approvals = await fetchPairingApprovals(session.port);
  if (approvals) {
    const pending = approvals.filter((item) => item.status === "pending");
    console.log(`Pairing approvals: ${pending.length ? pending.map((item) => item.id).join(", ") : "none"}`);
  }
  console.log(`Bridge PID: ${pidLine(session.pid)}`);
  console.log(`App-server PID: ${pidLine(session.appServerPid)}`);
  console.log(`Tunnel PID: ${pidLine(session.tunnelPid)}`);
}

async function updateFromGitHub(): Promise<void> {
  const repoRoot = (await runCommand("git", ["rev-parse", "--show-toplevel"], process.cwd())).stdout.trim();
  const status = (await runCommand("git", ["status", "--porcelain"], repoRoot)).stdout.trim();
  if (status) {
    console.log("Local changes detected. Commit, stash, or discard them before updating.");
    console.log("");
    console.log(status);
    process.exitCode = 1;
    return;
  }

  console.log(`Updating codex-remote-iphone at ${repoRoot}`);
  await runAndPrint("git", ["fetch", "--prune", "origin"], repoRoot);
  await runAndPrint("git", ["pull", "--ff-only"], repoRoot);
  await runAndPrint("npm", ["install"], repoRoot);
  await runAndPrint("npm", ["run", "install-skill"], repoRoot);
  await runAndPrint("npm", ["run", "setup"], repoRoot);
  console.log("");
  console.log("Update complete. If a remote console is running, use `[$codex-remote-iphone] restart` to load the new bridge and phone UI.");
}

async function runAndPrint(command: string, args: string[], cwd: string): Promise<void> {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = await runCommand(command, args, cwd);
  const output = `${result.stdout}${result.stderr}`.trim();
  if (output) console.log(output);
}

async function runCommand(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, { cwd, maxBuffer: 10 * 1024 * 1024 });
}

async function printPairingApprovals(): Promise<void> {
  const session = await readPidFile();
  if (!session) {
    console.log("No recorded codex-remote-iphone session found.");
    return;
  }
  const approvals = await fetchPairingApprovals(session.port);
  const pendingApprovals = approvals?.filter((approval) => approval.status === "pending") ?? [];
  if (!pendingApprovals.length) {
    console.log("No pending codex-remote-iphone pairing approvals.");
    return;
  }
  for (const approval of pendingApprovals) {
    console.log(`ID: ${approval.id}`);
    console.log(`  Status: ${approval.status}`);
    console.log(`  Device: ${approval.deviceName}`);
    console.log(`  IP: ${approval.ip}`);
    console.log(`  Expires: ${approval.expiresAt}`);
    console.log(`  Approve: npm run approve -- ${approval.id}`);
    console.log(`  Deny: npm run deny -- ${approval.id}`);
  }
}

async function handlePolicy(args: string[]): Promise<void> {
  const update = parsePolicyUpdate(args);
  const session = await readPidFile();
  if (!update) {
    const config = session ? await fetchLocalConfig(session.port) : null;
    printConfig(config ?? (await loadConfig()));
    return;
  }

  const current = session ? await fetchLocalConfig(session.port) : null;
  const next = normalizeConfig({ ...(current ?? (await loadConfig())), ...update });
  const saved = session ? await updateLocalConfig(session.port, next) : null;
  if (!saved) await saveConfig(next);
  printConfig(saved ?? next);
  console.log(session && saved ? "Policy updated live." : "Policy saved. Restart codex-remote-iphone for a running server to pick it up.");
}

async function handleMaxDevices(value: string | undefined): Promise<void> {
  if (!value) {
    const session = await readPidFile();
    const config = session ? await fetchLocalConfig(session.port) : null;
    console.log(`Max devices: ${(config ?? (await loadConfig())).maxActiveDevices}`);
    return;
  }
  await handlePolicy(["maxActiveDevices", value]);
}

function parsePolicyUpdate(args: string[]): Partial<AppConfig> | null {
  if (args.length === 0) return null;
  const [rawKey, rawValue] = args.length === 1 && args[0]?.includes("=") ? args[0].split("=", 2) : [args[0], args[1]];
  if (!rawKey || rawValue === undefined) {
    console.log("Usage: npm run policy -- maxActiveDevices 2");
    return null;
  }
  const key = rawKey.trim() as keyof AppConfig;
  if (!isConfigKey(key)) {
    console.log(`Unknown policy key: ${rawKey}`);
    console.log(`Supported keys: ${configKeys.join(", ")}`);
    return null;
  }
  return { [key]: parseConfigValue(key, rawValue) } as Partial<AppConfig>;
}

function parseConfigValue(key: keyof AppConfig, rawValue: string): AppConfig[keyof AppConfig] {
  if (key === "requireDesktopPairingApproval" || key === "desktopApprovalPrompt") {
    return rawValue === "true" || rawValue === "1" || rawValue === "yes";
  }
  if (key === "onDeviceLimitExceeded") {
    return rawValue === "rejectNew" ? "rejectNew" : "disconnectAll";
  }
  return Number(rawValue);
}

function printConfig(config: AppConfig): void {
  console.log(JSON.stringify(config, null, 2));
}

async function fetchLocalConfig(port: number): Promise<AppConfig | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local/config`);
    if (!response.ok) return null;
    return (await response.json()) as AppConfig;
  } catch {
    return null;
  }
}

async function updateLocalConfig(port: number, config: AppConfig): Promise<AppConfig | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    if (!response.ok) return null;
    return (await response.json()) as AppConfig;
  } catch {
    return null;
  }
}

async function decidePairingApproval(decision: "approve" | "deny", requestId: string | undefined): Promise<void> {
  if (!requestId) {
    console.log(`Usage: npm run ${decision} -- <pairing-request-id>`);
    return;
  }
  const session = await readPidFile();
  if (!session) {
    console.log("No recorded codex-remote-iphone session found.");
    return;
  }
  const response = await fetch(
    `http://127.0.0.1:${session.port}/api/local/pairing-requests/${encodeURIComponent(requestId)}/${decision}`,
    { method: "POST" }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.log(`${decision} failed: ${JSON.stringify(data)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${decision === "approve" ? "Approved" : "Denied"} pairing request ${requestId}.`);
}

async function printQr(): Promise<void> {
  const session = await readPidFile();
  if (!session) {
    console.log("No recorded codex-remote-iphone session found.");
    return;
  }
  const rotatedUrl = await rotatePairingFromLocalBridge(session.port);
  const url = rotatedUrl ?? session.pairingUrl ?? session.publicUrl;
  console.log(`URL: ${url}`);
  if (rotatedUrl) {
    console.log("Generated a fresh one-time pairing token.");
  } else if (session.pairingUrl) {
    console.log("Could not rotate the pairing token; this stored QR may be expired or already consumed.");
  }
  console.log("");
  qrcode.generate(url, { small: true });
  await printSavedQr(url);
}

async function rotatePairingFromLocalBridge(port: number): Promise<string | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local/pairing-token`, { method: "POST" });
    if (!response.ok) return null;
    const data = (await response.json()) as { url?: string };
    return data.url ?? null;
  } catch {
    return null;
  }
}

async function fetchPairingApprovals(port: number): Promise<PairingApprovalSummary[] | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/local/pairing-requests`);
    if (!response.ok) return null;
    const data = (await response.json()) as { requests?: PairingApprovalSummary[] };
    return data.requests ?? [];
  } catch {
    return null;
  }
}

async function printLogs(args: string[]): Promise<void> {
  const limit = readNumberArg(args, "--lines", 80);
  const events = await new AuditLog().recent(limit);
  if (!events.length) {
    console.log("No audit log entries found.");
    return;
  }
  for (const event of events) console.log(JSON.stringify(event));
}

function readNumberArg(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(args[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function pidLine(pid?: number): string {
  if (!pid) return "not recorded";
  return `${pid} (${isPidRunning(pid) ? "running" : "not running"})`;
}

type PairingApprovalSummary = {
  id: string;
  deviceName: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  status: string;
};

const configKeys = [
  "maxActiveDevices",
  "deviceTokenTtlMinutes",
  "requireDesktopPairingApproval",
  "desktopApprovalPrompt",
  "pairingApprovalTtlSeconds",
  "onDeviceLimitExceeded",
  "auditLogRetentionDays"
] as const;

function isConfigKey(key: string): key is keyof AppConfig {
  return (configKeys as readonly string[]).includes(key);
}

async function printSavedQr(url: string): Promise<void> {
  try {
    const saved = await saveQrPng(url);
    console.log(`QR image: ${saved.timestampedPath}`);
    console.log(`QR check: fresh unique file, ${saved.bytes} bytes, generated ${saved.createdAt}`);
    if (saved.latestPath) console.log(`QR alias for local convenience only: ${saved.latestPath}`);
    console.log("Display the QR image path above; do not display latest-qr.png in chat.");
  } catch (error) {
    console.log(`Could not save QR image: ${(error as Error).message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
