# codex-remote-iphone

Use your iPhone to control the Codex session running on your computer.

`codex-remote-iphone` starts a small local bridge, opens a temporary Cloudflare Quick Tunnel, prints a QR code, and lets your phone send prompts into Codex Desktop after local approval.

This is a v0.1 MVP / experimental project. The code is MIT licensed and can be used, modified, self-hosted, distributed, and used commercially.

## Quick Start

### 1. Install

```bash
git clone https://github.com/jianmosier/codex-remote-iphone.git
cd codex-remote-iphone
npm install
npm run install-skill
npm run setup
npm run doctor
```

### 2. Start From Codex Desktop

In Codex, run:

```text
[$codex-remote-iphone] start
```

The command builds the phone UI, starts the bridge, starts a Cloudflare Quick Tunnel, and prints a QR code.

### 3. Scan And Approve

Scan the QR code with your phone, then approve the pairing on your computer. After pairing, the phone can control the same Codex Desktop thread.

## What The Phone Can Do

- Send prompts to the current Codex Desktop session.
- Attach images from Photos or camera with the `+` button.
- Watch Codex responses stream back.
- See your sent messages in the session history.
- Approve, deny, or cancel command/file approval requests.
- Interrupt a running turn.
- View connected devices and recent access events.

## Requirements

- macOS is the primary supported desktop target for v0.1.
- Node.js `^20.19.0 || >=22.12.0` and npm.
- Codex CLI/Desktop installed and logged in.
- Network access from the computer to Cloudflare Quick Tunnel.
- A phone browser that can reach the generated `trycloudflare.com` URL.

Run `npm run setup` once before the first start. It verifies `cloudflared` or clearly announces that it will download Cloudflare's `cloudflared` command-line tool into `~/.codex-remote-iphone/bin/`. `start` fails fast if `cloudflared` is still missing.

During a first-time download, setup prints staged progress and a heartbeat such as `waiting for cloudflared download response...`. On slow or proxied networks it may take 1-3 minutes; if no response arrives within 180 seconds, it fails with a timeout instead of silently hanging.

## Skill Commands

After `npm run install-skill`, use the skill as the normal command surface:

```text
[$codex-remote-iphone] start      # start or show a phone QR
[$codex-remote-iphone] qr         # rotate a fresh one-time pairing token
[$codex-remote-iphone] status     # show workspace, URL, mode, and process health
[$codex-remote-iphone] stop       # stop bridge and tunnel
[$codex-remote-iphone] uninstall  # remove installed skill and project-local cloudflared
[$codex-remote-iphone] restart    # rebuild UI and restart with the recorded workspace
[$codex-remote-iphone] update     # pull the latest GitHub version and reinstall the skill
[$codex-remote-iphone] setup      # install/check cloudflared before first start
[$codex-remote-iphone] new        # start an isolated phone-only Codex session
[$codex-remote-iphone] max        # show maximum active devices
[$codex-remote-iphone] max 2      # set maximum active devices to 2
[$codex-remote-iphone] approvals  # list pending desktop pairing approvals
[$codex-remote-iphone] logs       # show recent audit events
[$codex-remote-iphone] doctor     # diagnose local setup
```

You should not need to remember the project directory during normal use. The installed skill records the clone path in `project-root.txt`.

## Uninstall

Use:

```text
[$codex-remote-iphone] uninstall
```

This stops recorded processes, removes the installed Codex skill, and removes the project-local `cloudflared` cache under `~/.codex-remote-iphone/bin/`. It does not remove system `cloudflared` installations such as Homebrew, and it keeps local config, audit logs, uploads, QR images, and the cloned repository.

## How It Works

- `desktop-ipc`: default inside Codex Desktop when `CODEX_THREAD_ID` and the local Desktop IPC socket are available. Phone prompts are relayed into the desktop-owned thread.
- `app-server`: fallback mode for CLI-only use, unavailable Desktop IPC, `new`, or `--no-desktop-sync`.

The bridge never exposes Codex Desktop IPC or `codex app-server` directly to the internet. The public endpoint is the authenticated bridge only.

## Security Defaults

- Pairing tokens expire after 10 minutes and are consumed after login.
- Tokens live in the URL fragment (`#token=...`) so they are not sent to Cloudflare until the phone page explicitly logs in.
- Desktop pairing approval is enabled by default.
- Default active device limit is 1.
- If a new device exceeds the limit, the default policy is `disconnectAll`: interrupt the current turn, revoke sessions, close WebSockets, and stop the tunnel.
- Image attachments are uploaded only after pairing and stored under `~/.codex-remote-iphone/uploads/`.
- Audit logs are written to `~/.codex-remote-iphone/audit.log`.

Local policy lives at:

```text
~/.codex-remote-iphone/config.json
```

## Network Notes

`codex-remote-iphone` treats the computer and phone as two different network paths:

- Computer egress may use local proxy env vars such as `HTTP_PROXY`, `HTTPS_PROXY`, and `ALL_PROXY`.
- Phone delivery must work directly from the phone browser.
- Startup checks common DNS resolvers and no-proxy HTTPS before printing the QR code.

If the phone sees Cloudflare 1016/1033, rotate or restart until startup checks pass:

```text
[$codex-remote-iphone] qr
[$codex-remote-iphone] restart
```

## Repository Hygiene

The GitHub repository should contain the deliverable source project only. Local runtime and debugging artifacts are intentionally ignored, including:

- `node_modules/`
- `apps/web/dist/`
- `.playwright-cli/`
- `coverage/`
- `playwright-report/`
- local logs, env files, caches, and temporary output

Runtime data such as sessions, audit logs, uploaded images, downloaded `cloudflared`, and generated QR codes live under `~/.codex-remote-iphone/`, not in this repository.

## Buy Me A Coffee

<p align="center">
  <img src="docs/sponsor/coffee.svg" alt="Coffee cup illustration" width="320">
</p>

<details>
  <summary><strong>WeChat Pay</strong></summary>
  <p>
    <img src="docs/sponsor/wechat.jpg" alt="WeChat Pay QR code" width="220">
  </p>
</details>

<details>
  <summary><strong>Alipay</strong></summary>
  <p>
    <img src="docs/sponsor/alipay.jpg" alt="Alipay QR code" width="220">
  </p>
</details>

## Caveats

- Cloudflare Quick Tunnel is intended for development/testing. It does not provide a permanent URL or production SLA.
- `codex app-server` is experimental. Protocol details may change across Codex versions.
- Desktop IPC is an internal Codex Desktop integration surface and may change.
- v0.1 is optimized for macOS + Codex Desktop.
- Do not expose this tool casually; it can operate a local coding agent with file and command capabilities.
