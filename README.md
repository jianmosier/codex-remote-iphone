# codex-remote-iphone

Scan a QR code on your phone and control the Codex session on your computer through a temporary Cloudflare Quick Tunnel.

This is a v0.1 MVP / experimental project. It is MIT licensed: you can use, modify, distribute, self-host, and commercially use the code.

## What It Does

- Starts a local bridge server on `127.0.0.1:8787`.
- When launched from Codex Desktop with `CODEX_THREAD_ID`, connects to the Desktop app's local IPC and forwards phone prompts into the current desktop-owned thread.
- Falls back to `codex app-server` over stdio JSON-RPC when Desktop IPC is unavailable or when you ask for an isolated phone thread.
- Starts a temporary Cloudflare Quick Tunnel.
- Prints a QR code containing the temporary URL and pairing token.
- Lets your phone send prompts, watch streaming output, approve or deny commands, interrupt a turn, and stop the session.
- Records local audit logs in `~/.codex-remote-iphone/audit.log`.

## Requirements

- macOS is the primary supported desktop target for v0.1.
- Node.js `^20.19.0 || >=22.12.0` and npm.
- Codex CLI/Desktop installed and logged in.
- Network access from the computer to Cloudflare Quick Tunnel.
- A phone browser that can reach the generated `trycloudflare.com` URL.

`cloudflared` is optional before first run. If it is missing, `npm run start` attempts to download a project-local copy.

## Quick Start

```bash
git clone https://github.com/jianmosier/codex-remote-iphone.git
cd codex-remote-iphone
npm install
npm run install-skill
npm run doctor
```

Start a remote console for any local workspace:

```bash
npm run start -- --workspace /absolute/path/to/your/project
```

Scan the printed QR code with your phone. After scanning, the phone waits for desktop approval before it receives an authenticated session.

When started from inside Codex Desktop, `codex-remote-iphone` automatically uses the current `CODEX_THREAD_ID`. By default it first tries `desktop-ipc` mode: phone messages are sent to the Codex Desktop app as follower requests, so the desktop thread remains the owner and should show the same turn locally. The phone UI subscribes to Desktop stream-state broadcasts and mirrors output, approvals, command output, and diff summaries.

Use an isolated phone-only thread when you do not want to bind the phone to the current Desktop thread:

```bash
npm run new -- --workspace /absolute/path/to/your/project
```

You can also resume a specific thread or force standalone app-server mode:

```bash
npm run start -- --workspace /absolute/path/to/your/project --thread-id 019e...
npm run start -- --workspace /absolute/path/to/your/project --no-desktop-sync
```

For local-only development without Cloudflare:

```bash
npm run dev -- --workspace /absolute/path/to/your/project
```

Stop the foreground process with `Ctrl-C`, from the phone UI, or from another terminal:

```bash
npm run stop
```

## Skill Usage

Install the bundled Codex skill once from your clone:

```bash
npm run install-skill
```

The installer copies the skill into `$CODEX_HOME/skills/codex-remote-iphone` or `~/.codex/skills/codex-remote-iphone`, then records the current clone path in `project-root.txt`. After that, use the skill as the command surface:

```text
[$codex-remote-iphone] help
[$codex-remote-iphone] start
[$codex-remote-iphone] new
[$codex-remote-iphone] stop
[$codex-remote-iphone] status
[$codex-remote-iphone] qr
[$codex-remote-iphone] max
[$codex-remote-iphone] max 2
[$codex-remote-iphone] doctor
[$codex-remote-iphone] logs
```

`max 2` means "set the maximum active device count to 2".

`new` means "start an isolated phone-only Codex session". It does not bind phone turns to the current Codex Desktop thread.

Codex should translate those skill commands into the local npm scripts for you. You should not need to remember the project directory or the underlying script names during normal use.

The raw command reference is available with:

```bash
npm run help
```

QR behavior:

- `start` creates a new Quick Tunnel URL and a fresh one-time pairing token.
- While the same tunnel keeps running, the hostname can stay the same.
- `qr` rotates only the pairing token, so the `#token=...` part changes even when the hostname does not.
- Tokens expire after 10 minutes and are consumed after a successful login.

## Security Defaults

- The pairing token expires after 10 minutes.
- The token is placed in the URL fragment (`#token=...`) so it is not sent to the origin until the phone page explicitly logs in.
- Desktop pairing approval is enabled by default. After a phone scans the QR code, the bridge asks the computer to approve the pairing before it issues a session cookie.
- On macOS, the bridge shows a native approval dialog. The same flow can be controlled from the command line:

```bash
npm run approvals
npm run approve -- <pairing-request-id>
npm run deny -- <pairing-request-id>
npm run max -- 2
```

- Default active device limit is 1.
- If a new device exceeds the limit, the default policy is `disconnectAll`: interrupt the current turn, revoke sessions, close WebSockets, and stop the tunnel.
- All API and WebSocket traffic requires an authenticated session after pairing.

Edit local policy in:

```text
~/.codex-remote-iphone/config.json
```

Example:

```json
{
  "maxActiveDevices": 1,
  "deviceTokenTtlMinutes": 10,
  "requireDesktopPairingApproval": true,
  "desktopApprovalPrompt": true,
  "pairingApprovalTtlSeconds": 120,
  "onDeviceLimitExceeded": "disconnectAll",
  "auditLogRetentionDays": 30
}
```

## Codex Session Model

There are two runtime modes:

- `desktop-ipc`: default inside Codex Desktop when `CODEX_THREAD_ID` and the local Desktop IPC socket are available. The bridge does not expose Desktop IPC to the internet; it only accepts authenticated phone requests and relays them locally.
- `app-server`: fallback mode for CLI-only use, unavailable Desktop IPC, `--new-thread`, or `--no-desktop-sync`.

The phone Access Monitor shows the active mode. `npm run status` also prints `Codex mode`.

## Network Model

`codex-remote-iphone` treats the computer and phone as two different network paths:

- Computer egress: `cloudflared` is launched from the local computer and inherits `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, and related environment variables.
- Phone delivery: the QR URL must work for the phone browser directly. Startup checks the Quick Tunnel hostname through common global and China DNS resolvers, then performs direct HTTPS checks without using the computer's proxy before printing the QR code.
- If the computer can open a URL only through a proxy but the phone shows Cloudflare 1016/1033, treat it as a DNS/tunnel propagation issue and restart until the startup checks pass.

## Buy Me A Coffee / 请喝咖啡

Sponsorship is optional. The code remains MIT licensed either way.

GitHub Sponsors is not configured in the v0.1 placeholder release. When you are ready, uncomment and replace the username in `.github/FUNDING.yml`.

Domestic QR placeholders:

![WeChat Pay](docs/sponsor/wechat-placeholder.png)
![Alipay](docs/sponsor/alipay-placeholder.png)

Replace the placeholder images with real payment QR codes before promoting sponsorship.

## Caveats

- Cloudflare Quick Tunnel is intended for development/testing. It does not provide a permanent URL or production SLA.
- Quick Tunnel random hostnames can briefly fail DNS propagation on some recursive resolvers. Startup validates common public and China DNS resolvers plus no-proxy HTTP before showing the QR code.
- `codex app-server` is experimental. Protocol details may change across Codex versions.
- Desktop IPC is an internal Codex Desktop integration surface. If Codex changes that protocol, the bridge may fall back to standalone `app-server` mode until this project is updated.
- v0.1 is optimized for macOS + Codex Desktop. Other platforms may work through standalone `app-server` mode, but they are not the main target yet.
- Do not expose this tool casually; it can operate a local coding agent with file and command capabilities.
