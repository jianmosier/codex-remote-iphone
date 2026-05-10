import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import staticPlugin from "@fastify/static";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { AuditLog, hashSessionId } from "./audit.js";
import { AppServerClient, type CodexClient } from "./appServer.js";
import { mapApprovalDecision, summarizeApproval, type UiApprovalDecision } from "./approval.js";
import { type AppConfig, loadConfig, saveConfig, normalizeConfig } from "./config.js";
import { DesktopIpcClient } from "./desktopIpc.js";
import {
  PairingApprovalManager,
  type PairingApprovalRequest,
  type PublicPairingApprovalRequest
} from "./pairingApproval.js";
import { clearPidFile, writePidFile } from "./pidStore.js";
import { SessionManager } from "./sessionManager.js";
import { parseCookie } from "./system.js";
import { PairingTokenManager } from "./token.js";
import { startQuickTunnel, type QuickTunnel } from "./tunnel.js";

type StartOptions = {
  workspace: string;
  port: number;
  tunnel: boolean;
  threadId: string | null;
  requireResume: boolean;
  desktopSync: boolean;
};

type ClientMessage =
  | { type: "turn.start"; text: string }
  | { type: "turn.interrupt" }
  | { type: "approval.decide"; requestId: string | number; decision: UiApprovalDecision }
  | { type: "userInput.submit"; requestId: string | number; answers: UserInputAnswers }
  | { type: "session.stop" }
  | { type: "pairing.rotate" };

type UserInputAnswers = Record<string, { answers: string[] }>;

type TranscriptMessage = {
  id: number;
  role: "user" | "assistant" | "plan" | "command" | "system" | "error";
  text: string;
  createdAt: string;
};

export class RemoteConsole {
  private app: FastifyInstance;
  private wss = new WebSocketServer({ noServer: true });
  private audit = new AuditLog();
  private config!: AppConfig;
  private sessions!: SessionManager;
  private tokens!: PairingTokenManager;
  private pairingApprovals!: PairingApprovalManager;
  private appServer!: CodexClient;
  private quickTunnel: QuickTunnel | null = null;
  private publicUrl = "";
  private threadId = "";
  private threadMode: "new" | "resumed" = "new";
  private startedAt = "";
  private currentTurnId: string | null = null;
  private currentDiff = "";
  private shuttingDown = false;
  private transcript: TranscriptMessage[] = [];
  private nextTranscriptId = 1;

  private constructor(private options: StartOptions) {
    this.app = Fastify({ logger: false });
  }

  static async start(options: StartOptions): Promise<RemoteConsole> {
    const console = new RemoteConsole(options);
    try {
      await console.boot();
      return console;
    } catch (error) {
      await console.shutdown("boot-failed").catch(() => undefined);
      throw error;
    }
  }

  get url(): string {
    return this.tokens.url(this.publicUrl);
  }

  get tunnelUrl(): string {
    return this.publicUrl;
  }

  get threadLabel(): string {
    return `${this.threadMode}:${this.threadId}`;
  }

  get codexMode(): string {
    return this.appServer.mode;
  }

  get pids(): { appServerPid?: number; tunnelPid?: number } {
    return {
      appServerPid: this.appServer.pid,
      tunnelPid: this.quickTunnel?.pid
    };
  }

  async shutdown(reason = "manual"): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    await this.audit.append({ type: "server.stop", detail: { reason } });
    this.broadcast({ type: "session.status", status: "stopping", reason });
    if (this.threadId && this.currentTurnId) {
      await this.appServer.interruptTurn(this.threadId, this.currentTurnId).catch(() => undefined);
    }
    for (const client of this.wss.clients) client.close(1001, reason);
    this.quickTunnel?.stop();
    this.appServer.stop();
    await clearPidFile();
    await this.app.close().catch(() => undefined);
  }

  private async boot(): Promise<void> {
    this.config = await loadConfig();
    this.sessions = new SessionManager(() => this.config);
    this.tokens = new PairingTokenManager(this.config.deviceTokenTtlMinutes);
    this.pairingApprovals = new PairingApprovalManager(this.config.pairingApprovalTtlSeconds * 1000);

    this.appServer = await this.createCodexClient();
    this.bindCodexEvents();
    const thread = await this.openThread();
    this.threadId = thread.threadId;

    await this.registerRoutes();
    await this.app.listen({ host: "127.0.0.1", port: this.options.port });

    this.publicUrl = `http://127.0.0.1:${this.options.port}`;
    if (this.options.tunnel) {
      this.quickTunnel = await startQuickTunnel(this.options.port, (line) => {
        console.log(line);
        this.audit.append({ type: "cloudflared.log", detail: { line } }).catch(() => undefined);
      });
      this.publicUrl = this.quickTunnel.url;
    }

    this.startedAt = new Date().toISOString();
    await this.writeRuntimeFile(this.url);
    await this.audit.append({
      type: "server.start",
      detail: {
        workspace: this.options.workspace,
        publicUrl: this.publicUrl,
        threadId: this.threadId,
        threadMode: this.threadMode,
        appServerMode: this.appServer.mode
      }
    });
  }

  private async createCodexClient(): Promise<CodexClient> {
    if (this.options.desktopSync && this.options.threadId && DesktopIpcClient.canConnect()) {
      const desktop = new DesktopIpcClient(this.options.workspace);
      try {
        await desktop.initialize();
        await this.audit.append({ type: "appserver.mode", detail: { mode: desktop.mode } });
        return desktop;
      } catch (error) {
        desktop.stop();
        await this.audit.append({
          type: "appserver.mode.failed",
          detail: { mode: desktop.mode, error: (error as Error).message }
        });
      }
    }
    const appServer = new AppServerClient(this.options.workspace);
    await appServer.initialize();
    await this.audit.append({ type: "appserver.mode", detail: { mode: appServer.mode } });
    return appServer;
  }

  private async openThread(): Promise<{ threadId: string }> {
    if (this.options.threadId) {
      try {
        const thread = await this.appServer.resumeThread(this.options.threadId, this.options.workspace);
        this.threadMode = "resumed";
        await this.audit.append({
          type: "thread.resume",
          detail: { threadId: thread.threadId, source: this.options.requireResume ? "explicit" : "auto" }
        });
        return thread;
      } catch (error) {
        await this.audit.append({
          type: "thread.resume.failed",
          detail: { threadId: this.options.threadId, error: (error as Error).message }
        });
        if (this.options.requireResume) throw error;
      }
    }

    const thread = await this.appServer.startThread(this.options.workspace);
    this.threadMode = "new";
    await this.audit.append({ type: "thread.start", detail: { threadId: thread.threadId } });
    return thread;
  }

  private async registerRoutes(): Promise<void> {
    const webDist = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "dist");
    await this.app.register(staticPlugin, { root: webDist, wildcard: false });

    this.app.addHook("preHandler", async (request, reply) => {
      if (!request.url.startsWith("/api/")) return;
      if (request.method === "GET" && request.url === "/api/session") return;
      if (request.method === "GET" && request.url.startsWith("/api/pairing-requests/")) return;
      if (request.method === "POST" && request.url === "/api/login") return;
      if (request.url.startsWith("/api/local/")) return;
      const session = this.getSession(request);
      if (!session) {
        reply.code(401).send({ error: "not authenticated" });
        return reply;
      }
      this.sessions.touch(session.id);
    });

    this.app.post("/api/login", async (request, reply) => {
      if (!this.isAllowedOrigin(request)) {
        await this.audit.append({ type: "login.rejected", detail: { reason: "origin" } });
        return reply.code(403).send({ error: "origin rejected" });
      }
      const body = request.body as { token?: string; deviceName?: string };
      const ip = clientIp(request);
      const userAgent = request.headers["user-agent"] ?? "";
      if (!this.tokens.matches(body.token ?? "")) {
        await this.audit.append({ type: "login.failed", ip, userAgent, deviceName: body.deviceName });
        return reply.code(401).send({ error: "invalid or expired token" });
      }
      const deviceName = body.deviceName?.slice(0, 80) || "iPhone";
      if (this.config.requireDesktopPairingApproval) {
        this.tokens.consume(body.token ?? "");
        const approval = this.pairingApprovals.create({ deviceName, ip, userAgent: String(userAgent) });
        await this.audit.append({
          type: "pairing.approval.requested",
          ip,
          userAgent,
          deviceName,
          detail: { requestId: approval.id, expiresAt: approval.expiresAt }
        });
        this.announcePairingRequest(approval);
        this.promptDesktopPairingApproval(approval);
        return reply.code(202).send({
          authenticated: false,
          pairingApproval: publicPairingApproval(approval)
        });
      }
      this.tokens.consume(body.token ?? "");
      const established = await this.establishSession({ deviceName, ip, userAgent: String(userAgent) }, reply, request);
      return established ?? reply.code(423).send({ error: "device limit exceeded" });
    });

    this.app.get("/api/pairing-requests/:id", async (request, reply) => {
      const id = String((request.params as { id?: string }).id ?? "");
      const approval = this.pairingApprovals.find(id);
      if (!approval) return reply.code(404).send({ error: "pairing request not found" });
      if (approval.status === "pending") {
        return reply.code(202).send({ authenticated: false, pairingApproval: publicPairingApproval(approval) });
      }
      if (approval.status === "denied") {
        return reply.code(403).send({ error: "pairing request denied", pairingApproval: publicPairingApproval(approval) });
      }
      if (approval.status === "expired") {
        await this.audit.append({
          type: "pairing.approval.expired",
          ip: approval.ip,
          userAgent: approval.userAgent,
          deviceName: approval.deviceName,
          detail: { requestId: approval.id }
        });
        return reply.code(410).send({ error: "pairing request expired", pairingApproval: publicPairingApproval(approval) });
      }
      if (approval.sessionId) {
        const session = this.sessions.find(approval.sessionId);
        if (session) {
          this.sessions.touch(session.id);
          reply.header("Set-Cookie", makeSessionCookie(session.id, isSecureHost(request.headers.host)));
          return {
            authenticated: true,
            sessionIdHash: hashSessionId(session.id),
            session: this.sessionPayload()
          };
        }
      }
      const established = await this.establishSession(approval, reply, request);
      if (!established) return reply.code(423).send({ error: "device limit exceeded" });
      this.pairingApprovals.attachSession(approval.id, established.sessionId);
      return established.response;
    });

    this.app.get("/api/session", async (request) => {
      const session = this.getSession(request);
      if (session) this.sessions.touch(session.id);
      return {
        authenticated: Boolean(session),
        session: this.sessionPayload(),
        pairing: session ? this.tokens.snapshot() : undefined,
        audit: session ? await this.audit.recent(60) : []
      };
    });

    this.app.get("/api/audit", async () => ({ events: await this.audit.recent(120) }));

    this.app.get("/api/config", async () => this.config);

    this.app.post("/api/config", async (request) => {
      const next = normalizeConfig({ ...this.config, ...(request.body as Partial<AppConfig>) });
      this.config = next;
      await saveConfig(next);
      await this.audit.append({ type: "config.update", detail: next });
      this.broadcast({ type: "session.status", session: this.sessionPayload() });
      return next;
    });

    this.app.post("/api/pairing-token", async () => {
      return this.rotatePairing("ui");
    });

    this.app.post("/api/local/pairing-token", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) {
        await this.audit.append({ type: "pairing.rotate.rejected", detail: { reason: "not-local" } });
        return reply.code(403).send({ error: "local access only" });
      }
      return this.rotatePairing("local-cli");
    });

    this.app.get("/api/local/config", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) return reply.code(403).send({ error: "local access only" });
      return this.config;
    });

    this.app.post("/api/local/config", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) return reply.code(403).send({ error: "local access only" });
      const next = normalizeConfig({ ...this.config, ...(request.body as Partial<AppConfig>) });
      this.config = next;
      await saveConfig(next);
      await this.audit.append({ type: "config.update", detail: { source: "local-cli", config: next } });
      this.broadcast({ type: "session.status", session: this.sessionPayload() });
      return next;
    });

    this.app.get("/api/local/pairing-requests", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) return reply.code(403).send({ error: "local access only" });
      return { requests: this.pairingApprovals.list().map(publicPairingApproval) };
    });

    this.app.post("/api/local/pairing-requests/:id/approve", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) return reply.code(403).send({ error: "local access only" });
      const approved = await this.approvePairingRequest(String((request.params as { id?: string }).id ?? ""), "local-cli");
      if (!approved) return reply.code(404).send({ error: "pending pairing request not found" });
      return { ok: true, request: publicPairingApproval(approved) };
    });

    this.app.post("/api/local/pairing-requests/:id/deny", async (request, reply) => {
      if (!this.isLocalAdminRequest(request)) return reply.code(403).send({ error: "local access only" });
      const denied = await this.denyPairingRequest(String((request.params as { id?: string }).id ?? ""), "local-cli");
      if (!denied) return reply.code(404).send({ error: "pending pairing request not found" });
      return { ok: true, request: publicPairingApproval(denied) };
    });

    this.app.post("/api/stop", async () => {
      setTimeout(() => this.shutdown("api.stop").catch(() => undefined), 50);
      return { ok: true };
    });

    this.app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({ error: "not found" });
      const indexHtml = await readFile(resolve(webDist, "index.html"), "utf8");
      return reply.type("text/html").send(indexHtml);
    });

    this.app.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/ws")) return socket.destroy();
      const sessionId = parseCookie(request.headers.cookie).cri_session;
      const session = this.sessions.find(sessionId);
      if (!session) return socket.destroy();
      if (!this.isAllowedHost(request.headers.host)) return socket.destroy();
      this.wss.handleUpgrade(request, socket, head, (ws) => this.attachSocket(ws, session.id));
    });
  }

  private attachSocket(ws: WebSocket, sessionId: string): void {
    const session = this.sessions.find(sessionId);
    if (!session) return ws.close();
    this.sessions.setConnected(sessionId, true);
    this.audit
      .append({
        type: "ws.connected",
        ip: session.ip,
        userAgent: session.userAgent,
        deviceName: session.deviceName,
        sessionIdHash: hashSessionId(sessionId)
      })
      .catch(() => undefined);
    ws.send(JSON.stringify({ type: "session.status", session: this.sessionPayload() }));

    ws.on("message", (raw) => {
      this.handleClientMessage(sessionId, raw.toString()).catch((error) => {
        ws.send(JSON.stringify({ type: "error", message: error.message }));
      });
    });
    ws.on("close", () => {
      this.sessions.setConnected(sessionId, false);
      this.audit.append({ type: "ws.disconnected", sessionIdHash: hashSessionId(sessionId) }).catch(() => undefined);
      this.broadcast({ type: "session.status", session: this.sessionPayload() });
    });
  }

  private async handleClientMessage(sessionId: string, raw: string): Promise<void> {
    this.sessions.touch(sessionId);
    const message = JSON.parse(raw) as ClientMessage;
    if (message.type === "turn.start") {
      const text = message.text.trim();
      if (!text) return;
      this.appendTranscript("user", text);
      const turn = await this.appServer.startTurn(this.threadId, text, this.options.workspace);
      this.currentTurnId = turn.turnId;
      await this.audit.append({ type: "turn.start", sessionIdHash: hashSessionId(sessionId), detail: { turnId: turn.turnId } });
      this.broadcast({ type: "turn.started", turnId: turn.turnId });
      return;
    }
    if (message.type === "turn.interrupt") {
      if (this.currentTurnId) await this.appServer.interruptTurn(this.threadId, this.currentTurnId);
      await this.audit.append({ type: "turn.interrupt", sessionIdHash: hashSessionId(sessionId) });
      return;
    }
    if (message.type === "approval.decide") {
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) throw new Error("Approval request is no longer pending");
      this.appServer.respond(message.requestId, mapApprovalDecision(pending.method, message.decision));
      pendingApprovals.delete(message.requestId);
      await this.audit.append({
        type: "approval.decide",
        sessionIdHash: hashSessionId(sessionId),
        detail: { requestId: message.requestId, method: pending.method, decision: message.decision }
      });
      this.broadcast({ type: "approval.resolved", requestId: message.requestId, decision: message.decision });
      return;
    }
    if (message.type === "userInput.submit") {
      const pending = pendingApprovals.get(message.requestId);
      if (!pending) throw new Error("User input request is no longer pending");
      this.appServer.respond(message.requestId, { answers: message.answers });
      pendingApprovals.delete(message.requestId);
      await this.audit.append({
        type: "userInput.submit",
        sessionIdHash: hashSessionId(sessionId),
        detail: { requestId: message.requestId, method: pending.method }
      });
      this.broadcast({ type: "userInput.resolved", requestId: message.requestId });
      return;
    }
    if (message.type === "pairing.rotate") {
      const rotated = await this.rotatePairing("ws");
      this.broadcast({ type: "pairing.rotated", url: rotated.url, pairing: rotated.pairing });
      return;
    }
    if (message.type === "session.stop") {
      await this.shutdown("ws.stop");
    }
  }

  private bindCodexEvents(): void {
    this.appServer.on("notification", (message) => {
      const method = String(message.method);
      const params = (message.params ?? {}) as Record<string, unknown>;
      if (method === "item/agentMessage/delta") {
        this.appendTranscriptDelta("assistant", String(params.delta ?? ""));
        this.broadcast({ type: "codex.delta", delta: params.delta, turnId: params.turnId });
      } else if (method === "item/plan/delta") {
        this.appendTranscriptDelta("plan", String(params.delta ?? ""));
        this.broadcast({ type: "codex.planDelta", delta: params.delta, turnId: params.turnId });
      } else if (method === "item/commandExecution/outputDelta") {
        this.broadcast({ type: "command.output", delta: params.delta, itemId: params.itemId });
      } else if (method === "command/exec/outputDelta") {
        const text = Buffer.from(String(params.deltaBase64 ?? ""), "base64").toString("utf8");
        this.broadcast({ type: "command.output", delta: text, stream: params.stream });
      } else if (method === "turn/diff/updated") {
        this.currentDiff = String(params.diff ?? "");
        this.broadcast({ type: "diff.updated", diff: this.currentDiff });
      } else if (method === "turn/completed") {
        this.currentTurnId = null;
        this.broadcast({ type: "turn.completed", turnId: params.turnId });
      } else if (method === "error") {
        const message = JSON.stringify(params);
        this.broadcast({ type: "error", message });
      } else if (method === "serverRequest/resolved") {
        this.broadcast({ type: "approval.resolved", requestId: params.requestId });
      }
    });

    this.appServer.on("serverRequest", (message) => {
      const requestId = message.id as string | number;
      const method = String(message.method);
      const params = (message.params ?? {}) as Record<string, unknown>;
      pendingApprovals.set(requestId, { method, params });
      if (method === "item/tool/requestUserInput") {
        this.broadcast({
          type: "userInput.request",
          requestId,
          method,
          summary: summarizeUserInput(params)
        });
        this.audit.append({ type: "userInput.request", detail: { requestId, method } }).catch(() => undefined);
        return;
      }
      this.broadcast({
        type: "approval.request",
        requestId,
        method,
        summary: summarizeApproval(method, params)
      });
      this.audit.append({ type: "approval.request", detail: { requestId, method } }).catch(() => undefined);
    });

    this.appServer.on("log", (line) => {
      const compactLine = truncateLogLine(line);
      this.audit.append({ type: "appserver.log", detail: { line: compactLine } }).catch(() => undefined);
    });
  }

  private async handleDeviceLimit(ip: string, userAgent: string): Promise<void> {
    await this.audit.append({ type: "device.limit", ip, userAgent, detail: { policy: this.config.onDeviceLimitExceeded } });
    if (this.config.onDeviceLimitExceeded === "disconnectAll") {
      this.sessions.revokeAll();
      this.broadcast({ type: "security.lockdown", reason: "device limit exceeded" });
      await this.shutdown("device-limit");
    }
  }

  private async establishSession(
    input: Pick<PairingApprovalRequest, "deviceName" | "ip" | "userAgent">,
    reply: FastifyReply,
    request: FastifyRequest
  ): Promise<{ response: unknown; sessionId: string } | null> {
    const created = this.sessions.create({
      deviceName: input.deviceName,
      ip: input.ip,
      userAgent: input.userAgent
    });
    if (!created.ok) {
      await this.handleDeviceLimit(input.ip, input.userAgent);
      return null;
    }
    const sessionIdHash = hashSessionId(created.session.id);
    await this.audit.append({
      type: "login.success",
      ip: input.ip,
      userAgent: input.userAgent,
      deviceName: created.session.deviceName,
      sessionIdHash
    });
    reply.header("Set-Cookie", makeSessionCookie(created.session.id, isSecureHost(request.headers.host)));
    return {
      sessionId: created.session.id,
      response: {
        authenticated: true,
        sessionIdHash,
        session: this.sessionPayload()
      }
    };
  }

  private announcePairingRequest(request: PairingApprovalRequest): void {
    console.log("");
    console.log("codex-remote-iphone pairing request");
    console.log(`ID: ${request.id}`);
    console.log(`Device: ${request.deviceName}`);
    console.log(`IP: ${request.ip}`);
    console.log(`User-Agent: ${truncateLogLine(request.userAgent)}`);
    console.log(`Expires: ${request.expiresAt}`);
    console.log(`Approve: npm run approve -- ${request.id}`);
    console.log(`Deny: npm run deny -- ${request.id}`);
    console.log("");
  }

  private promptDesktopPairingApproval(request: PairingApprovalRequest): void {
    if (!this.config.desktopApprovalPrompt || process.platform !== "darwin") return;
    const seconds = Math.max(15, Math.min(600, this.config.pairingApprovalTtlSeconds));
    const message = [
      `Allow ${request.deviceName} to control Codex Remote iPhone?`,
      "",
      `IP: ${request.ip}`,
      `Request ID: ${request.id}`,
      "",
      "Only approve if this is your phone."
    ].join("\n");
    const script = `display dialog ${appleScriptString(message)} buttons {"Deny", "Approve"} default button "Approve" cancel button "Deny" with title "Codex Remote iPhone" giving up after ${seconds}`;
    const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      this.audit
        .append({ type: "pairing.approval.prompt.failed", detail: { requestId: request.id, error: error.message } })
        .catch(() => undefined);
    });
    child.on("close", () => {
      if (stdout.includes("button returned:Approve") && !stdout.includes("gave up:true")) {
        this.approvePairingRequest(request.id, "mac-dialog").catch(() => undefined);
        return;
      }
      if (stderr.trim()) {
        this.audit
          .append({ type: "pairing.approval.prompt.failed", detail: { requestId: request.id, error: stderr.trim() } })
          .catch(() => undefined);
      }
      this.denyPairingRequest(request.id, stdout.includes("gave up:true") ? "timeout" : "mac-dialog").catch(() => undefined);
    });
  }

  private async approvePairingRequest(id: string, source: string): Promise<PairingApprovalRequest | null> {
    const approved = this.pairingApprovals.approve(id, source);
    if (!approved) return null;
    await this.audit.append({
      type: "pairing.approval.approved",
      ip: approved.ip,
      userAgent: approved.userAgent,
      deviceName: approved.deviceName,
      detail: { requestId: approved.id, source }
    });
    console.log(`Approved codex-remote-iphone pairing request ${approved.id} from ${approved.deviceName}.`);
    return approved;
  }

  private async denyPairingRequest(id: string, source: string): Promise<PairingApprovalRequest | null> {
    const denied = this.pairingApprovals.deny(id, source);
    if (!denied) return null;
    await this.audit.append({
      type: "pairing.approval.denied",
      ip: denied.ip,
      userAgent: denied.userAgent,
      deviceName: denied.deviceName,
      detail: { requestId: denied.id, source }
    });
    console.log(`Denied codex-remote-iphone pairing request ${denied.id} from ${denied.deviceName}.`);
    return denied;
  }

  private getSession(request: FastifyRequest) {
    const sessionId = parseCookie(request.headers.cookie).cri_session;
    return this.sessions.find(sessionId);
  }

  private sessionPayload() {
    return {
      workspace: this.options.workspace,
      publicUrl: this.publicUrl,
      threadId: this.threadId,
      threadMode: this.threadMode,
      appServerMode: this.appServer.mode,
      currentTurnId: this.currentTurnId,
      currentDiff: this.currentDiff,
      transcript: this.transcript,
      config: this.config,
      pairingApprovals: this.pairingApprovals.list().map(publicPairingApproval),
      devices: this.sessions.list().map((session) => ({
        deviceName: session.deviceName,
        ip: session.ip,
        userAgent: session.userAgent,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        connected: session.connected,
        sessionIdHash: hashSessionId(session.id)
      }))
    };
  }

  private broadcast(payload: unknown): void {
    const message = JSON.stringify(payload);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    }
  }

  private appendTranscript(role: TranscriptMessage["role"], text: string): TranscriptMessage | null {
    if (!text) return null;
    const entry: TranscriptMessage = {
      id: this.nextTranscriptId++,
      role,
      text,
      createdAt: new Date().toISOString()
    };
    this.transcript = [...this.transcript, entry].slice(-300);
    this.broadcast({ type: "transcript.append", entry });
    return entry;
  }

  private appendTranscriptDelta(role: TranscriptMessage["role"], delta: string): void {
    if (!delta) return;
    const previous = this.transcript.at(-1);
    if (previous && previous.role === role) {
      const entry = { ...previous, text: `${previous.text}${delta}` };
      this.transcript = [...this.transcript.slice(0, -1), entry];
      this.broadcast({ type: "transcript.update", entry });
      return;
    }
    this.appendTranscript(role, delta);
  }

  private async rotatePairing(source: string): Promise<{ url: string; pairing: ReturnType<PairingTokenManager["snapshot"]> }> {
    this.tokens.rotate(this.config.deviceTokenTtlMinutes);
    const url = this.tokens.url(this.publicUrl);
    await this.writeRuntimeFile(url);
    await this.audit.append({ type: "pairing.rotate", detail: { source } });
    return { url, pairing: this.tokens.snapshot() };
  }

  private async writeRuntimeFile(pairingUrl: string): Promise<void> {
    await writePidFile({
      pid: process.pid,
      appServerPid: this.appServer.pid,
      tunnelPid: this.quickTunnel?.pid,
      port: this.options.port,
      workspace: this.options.workspace,
      publicUrl: this.publicUrl,
      pairingUrl,
      threadLabel: this.threadLabel,
      appServerMode: this.appServer.mode,
      startedAt: this.startedAt || new Date().toISOString()
    });
  }

  private isAllowedOrigin(request: FastifyRequest): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return this.isAllowedHost(new URL(origin).host);
    } catch {
      return false;
    }
  }

  private isAllowedHost(host: string | undefined): boolean {
    if (!host) return false;
    const normalized = host.toLowerCase();
    return (
      normalized === `127.0.0.1:${this.options.port}` ||
      normalized === `localhost:${this.options.port}` ||
      normalized === new URL(this.publicUrl).host.toLowerCase()
    );
  }

  private isLocalAdminRequest(request: FastifyRequest): boolean {
    const host = request.headers.host?.toLowerCase();
    return (
      host === `127.0.0.1:${this.options.port}` ||
      host === `localhost:${this.options.port}` ||
      host === `[::1]:${this.options.port}`
    );
  }
}

const pendingApprovals = new Map<string | number, { method: string; params: Record<string, unknown> }>();

function clientIp(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return request.ip;
}

function isSecureHost(host: string | undefined): boolean {
  return Boolean(host?.includes("trycloudflare.com"));
}

function makeSessionCookie(sessionId: string, secure: boolean): string {
  const parts = [
    `cri_session=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=43200"
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function truncateLogLine(line: string): string {
  return line.length > 1000 ? `${line.slice(0, 1000)}... [truncated]` : line;
}

function summarizeUserInput(params: Record<string, unknown>): Record<string, unknown> {
  const questions = Array.isArray(params.questions)
    ? params.questions
        .map((question) => {
          if (!question || typeof question !== "object") return null;
          const record = question as Record<string, unknown>;
          const options = Array.isArray(record.options)
            ? record.options
                .map((option) => {
                  if (!option || typeof option !== "object") return null;
                  const optionRecord = option as Record<string, unknown>;
                  return {
                    label: String(optionRecord.label ?? ""),
                    description: String(optionRecord.description ?? "")
                  };
                })
                .filter(Boolean)
            : [];
          return {
            id: String(record.id ?? ""),
            header: String(record.header ?? ""),
            question: String(record.question ?? ""),
            isOther: record.isOther === true,
            options
          };
        })
        .filter(Boolean)
    : [];

  return {
    kind: "userInput",
    itemId: params.itemId,
    turnId: params.turnId,
    questions
  };
}

function publicPairingApproval(request: PairingApprovalRequest): PublicPairingApprovalRequest {
  const { sessionId: _sessionId, ...publicRequest } = request;
  return request.sessionId ? { ...publicRequest, sessionIdHash: hashSessionId(request.sessionId) } : publicRequest;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
}
