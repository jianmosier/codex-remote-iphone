---
name: codex-remote-iphone
description: Start, diagnose, and operate the codex-remote-iphone mobile control console for Codex. Use when the user wants to control the current Codex Desktop session from an iPhone or phone browser, generate a QR pairing link, start a Cloudflare Quick Tunnel, inspect audit logs, adjust remote-access device policy, or troubleshoot the bridge between the phone UI and Codex Desktop/app-server.
---

# Codex Remote iPhone

## Overview

Use the local `codex-remote-iphone` project to start a foreground mobile control console. The console starts a local bridge, publishes a temporary Cloudflare Quick Tunnel, and prints a QR code that pairs the phone with a short-lived token.

If the user selects this skill and asks to start, open, run, connect, show a QR code, or use the phone console, treat that as permission to run the normal start workflow. Do not require the user to type the npm command manually.

Installed copies of this skill should include `project-root.txt`, written by `npm run install-skill`, containing the absolute path to the user's clone of the `codex-remote-iphone` repository. Use that file as the first source of truth for all npm commands.

When `CODEX_THREAD_ID` is present, the console should use the current Codex Desktop thread by default. It first tries `desktop-ipc` mode: the bridge connects to the local Codex Desktop IPC socket, sends phone prompts as Desktop follower requests, and subscribes to Desktop stream-state broadcasts so the phone and desktop see the same turn. Use `new`, `start new`, `--new-thread`, or `--no-desktop-sync` only when the user asks for an isolated phone session or explicit standalone `codex app-server` mode.

The phone UI supports image attachments after pairing. Images are uploaded through the authenticated bridge, stored under `~/.codex-remote-iphone/uploads/`, then sent to Codex as `localImage` turn inputs. If the user asks why images require a restart after upgrading, explain that the running bridge serves the previously built web UI until `[$codex-remote-iphone] restart` rebuilds and restarts it.

Phone UI regressions to guard against: the composer should expose attachments through a compact `+` button that opens attachment choices such as Image; it should not place a dedicated Image button beside Send as a peer action. User-submitted prompts must appear in the Session transcript immediately and remain visible after the server echoes or reconnects.

## Command Interface

Treat `[$codex-remote-iphone] <command>` as the primary user interface. The user should not need to remember `cd`, npm workspace names, or script flags for normal operation.

Supported command meanings:

- `help`: run `npm run help` and summarize the supported skill commands and common examples.
- `start`, `open`, `run`, `connect`, or `qr` with no active session: run the normal start workflow and show the phone QR code.
- `new` or `start new`: run `npm run new` to start an isolated phone-only Codex thread. This does not bind the phone to the current Codex Desktop thread and uses standalone `app-server` mode.
- `stop`: locate the project, run `npm run stop`, and report whether the recorded bridge, app-server, and tunnel processes were signaled.
- `uninstall`: locate the project and run `npm run uninstall`. This stops recorded processes, removes the installed Codex skill, and removes only the project-local `cloudflared` cache under `~/.codex-remote-iphone/bin/`. It must not remove Homebrew or other system `cloudflared` installations.
- `restart`: locate the project, run `npm run restart`, and show the new phone URL/QR. This should reuse the recorded workspace, port, thread label, and Codex mode unless the user passes explicit flags.
- `update`: locate the project, run `npm run update`, and summarize whether the clone was fast-forwarded from GitHub. If the command reports local changes, tell the user to commit, stash, or discard them before updating. After a successful update, suggest `[$codex-remote-iphone] restart` if a remote console is already running.
- `setup`: run `npm run setup` to verify or download the project-local `cloudflared` binary before first start.
- `status`: run `npm run status` and summarize the active workspace, URL, current thread label, Codex mode, and process health.
- `qr`: when a session is already recorded, run `npm run qr`; this asks the local bridge to rotate a fresh one-time pairing token and then shows the new QR or URL. The tunnel hostname may stay the same, but the `#token=...` fragment should change.
- `approvals`: run `npm run approvals` and summarize phone pairing requests waiting for desktop confirmation.
- `approve <id>`: run `npm run approve -- <id>` to allow a scanned phone to finish pairing.
- `deny <id>`: run `npm run deny -- <id>` to reject a scanned phone pairing request.
- `max`: run `npm run max` and report the current maximum active device count.
- `max <number>`: run `npm run max -- <number>` to set the maximum active device count to that number, for example `max 3` means set the limit to 3 devices. This is the preferred short command for the common device-limit policy.
- `doctor`: run `npm run doctor` and summarize any failed checks with the next action.
- `logs` or `audit`: run `npm run logs -- --lines 80` or inspect `~/.codex-remote-iphone/audit.log`, then summarize recent access, failed logins, approvals, and disconnects.
- `policy`: advanced command. Inspect or edit the full local policy config, such as token TTL, desktop approval prompt, approval timeout, overflow strategy, and audit retention. Prefer short commands like `max` for common operations.

When responding to the user, present the skill command as the friendly interface, for example `[$codex-remote-iphone] stop`. Mention raw npm commands only as implementation details when helpful for debugging.

If the user asks what commands exist, how to use this skill, or asks for help, run `npm run help` and relay the concise command list.

## QR Display Rule

Every time `start`, `restart`, or `qr` prints a QR code, verify the output before responding:

- Use the `QR image:` path with the timestamp and nonce in the filename.
- Never display `~/.codex-remote-iphone/latest-qr.png` in chat; Codex/Desktop may cache that fixed path and show an old QR.
- Confirm the CLI printed `QR check: fresh unique file`.
- Confirm the URL/token you share matches the latest command output or `~/.codex-remote-iphone/session.json`.
- If a QR looks stale or the user reports it does not work, run `[$codex-remote-iphone] qr` to rotate a fresh token and show only the new unique QR file.

## Workflow

1. Locate the project. First read `project-root.txt` from this installed skill directory and use that absolute path if it contains a `package.json` named `codex-remote-iphone`. If the file is missing or stale, search likely workspace roots with `rg --files -g package.json` and choose the package whose root `package.json` has `"name": "codex-remote-iphone"`.
2. Run `npm run doctor` from the project root before starting a remote session. Fix missing npm dependencies with `npm install` if needed. If `cloudflared` is missing during a `start` request, stop there and tell the user to run `[$codex-remote-iphone] setup`; do not download `cloudflared` inside the start path. Do not start a remote tunnel until `cloudflared` is OK.
3. Start the console with an explicit workspace:

```bash
npm run start -- --workspace /absolute/path/to/workspace
```

This automatically uses `CODEX_THREAD_ID` and prefers Desktop IPC when Codex provides it. To force a specific existing thread:

```bash
npm run start -- --workspace /absolute/path/to/workspace --thread-id 019e...
```

4. Confirm the status or startup output says `Codex mode: desktop-ipc` when the user expects the phone to share the current Desktop session. If it says `app-server`, inspect logs for `appserver.mode.failed`.
5. Tell the user to scan the printed QR code. The URL is temporary and normally changes after restart. After scanning, the phone will wait for desktop approval. On macOS, a native approval dialog should appear; if it does not, use `[$codex-remote-iphone] approvals`, then `[$codex-remote-iphone] approve <id>` or `[$codex-remote-iphone] deny <id>`.
6. Stop the console with `Ctrl-C`, the phone Stop button, or:

```bash
npm run stop
```

7. After code or web UI updates, restart the recorded console with:

```bash
npm run restart
```

## Safety Defaults

- Do not expose `codex app-server` directly to the public internet.
- Use the project bridge and Cloudflare Quick Tunnel wrapper. In `desktop-ipc` mode, do not expose the Codex Desktop IPC socket either; the bridge is the only public-facing component.
- Local Mac egress may use `HTTP_PROXY`, `HTTPS_PROXY`, or `ALL_PROXY` for `cloudflared`.
- Phone delivery checks must be direct DNS/HTTPS checks and must not rely on the Mac proxy.
- Keep the default `maxActiveDevices` at 1 unless the user explicitly asks to change it.
- Prefer the short command `[$codex-remote-iphone] max 2` when the user asks to change the maximum connected devices.
- Keep desktop pairing approval enabled by default: QR token first, then local desktop approval before a session cookie is issued.
- Accept image uploads only through authenticated phone sessions; do not accept arbitrary local file paths from the browser.
- If device limit is exceeded, the default policy is `disconnectAll`.
- Audit logs live in `~/.codex-remote-iphone/audit.log`, not in the repo.

## Diagnostics

Use these commands from the project root:

```bash
npm run doctor
npm run stop
tail -n 80 ~/.codex-remote-iphone/audit.log
cat ~/.codex-remote-iphone/config.json
```

Common outcomes:

- Missing `cloudflared`: run `npm run setup` first. `start` intentionally fails fast instead of downloading during tunnel startup.
- Port busy: ask the user to run with `--port <free-port>`.
- Phone cannot connect: confirm the latest QR URL, that the computer is awake, and that the foreground process is still running.
- Phone gets a reply but the Codex Desktop window does not show it: run `npm run status` and check `Codex mode`. If it is `app-server`, the bridge fell back to a standalone runner; check `appserver.mode.failed`, confirm `CODEX_THREAD_ID` is set, and confirm the Codex Desktop IPC socket exists under the system temp directory at `codex-ipc/ipc-<uid>.sock`.
- Phone sends a prompt but nothing happens on desktop in `desktop-ipc` mode: inspect `npm run logs -- --lines 120` for `appserver.log`, `turn.start`, and Desktop IPC errors, then restart the console after the current desktop turn is idle.
- Phone is stuck waiting after scanning: run `npm run approvals` from the project root. Approve with `npm run approve -- <id>` or deny with `npm run deny -- <id>`. Check `desktopApprovalPrompt` in `~/.codex-remote-iphone/config.json` if the macOS dialog did not appear.
- Cloudflare 1016 or 1033: first check whether the Mac has proxy env vars. Do not rely on a proxied `curl`; it may succeed while the phone fails. Check `npm run logs -- --lines 80`, direct local bridge health, direct no-proxy public HTTP, and DNS from common resolvers such as `223.5.5.5`, `119.29.29.29`, `114.114.114.114`, `1.1.1.1`, and `8.8.8.8`. Restart the console only after the quick tunnel URL passes DNS and no-proxy HTTP checks.
- Login fails: pairing tokens expire after 10 minutes and are consumed after login; restart or rotate pairing from the authenticated UI.

## Policy Edits

Edit `~/.codex-remote-iphone/config.json` only when the user asks. Supported keys:

- `maxActiveDevices`: integer from 1 to 16.
- `deviceTokenTtlMinutes`: integer from 1 to 120.
- `requireDesktopPairingApproval`: boolean.
- `desktopApprovalPrompt`: boolean.
- `pairingApprovalTtlSeconds`: integer from 15 to 600.
- `onDeviceLimitExceeded`: `disconnectAll` or `rejectNew`.
- `auditLogRetentionDays`: integer from 1 to 365.
