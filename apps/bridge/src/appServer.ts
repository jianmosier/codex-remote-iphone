import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { CodexTurnInput } from "./turnInput.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type AppServerEvents = {
  notification: [message: Record<string, unknown>];
  serverRequest: [message: Record<string, unknown>];
  log: [line: string];
};

export type CodexClientMode = "app-server" | "desktop-ipc";

export interface CodexClient extends EventEmitter<AppServerEvents> {
  readonly mode: CodexClientMode;
  readonly pid?: number;
  initialize(): Promise<void>;
  startThread(workspace: string): Promise<{ threadId: string }>;
  resumeThread(threadId: string, workspace: string): Promise<{ threadId: string }>;
  startTurn(threadId: string, input: CodexTurnInput[], workspace: string): Promise<{ turnId: string }>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respond(id: string | number, result: unknown): void;
  stop(): void;
}

export class AppServerClient extends EventEmitter<AppServerEvents> {
  readonly mode = "app-server" satisfies CodexClientMode;
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<string | number, PendingRequest>();

  constructor(private cwd: string) {
    super();
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });

    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.child.stderr.on("data", (chunk) => {
      for (const line of String(chunk).split(/\r?\n/).filter(Boolean)) {
        this.emit("log", line);
      }
    });
    this.child.on("error", (error) => this.rejectAll(error));
    this.child.on("close", (code, signal) => {
      this.rejectAll(new Error(`codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`));
    });
  }

  async initialize(): Promise<void> {
    this.start();
    await this.request("initialize", {
      clientInfo: {
        name: "codex-remote-iphone",
        title: "Codex Remote iPhone",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });
    this.notify("initialized");
  }

  async startThread(workspace: string): Promise<{ threadId: string }> {
    const response = (await this.request("thread/start", {
      cwd: workspace,
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      serviceName: "codex-remote-iphone",
      experimentalRawEvents: false,
      persistExtendedHistory: true
    })) as { thread?: { id?: string } };
    const threadId = response.thread?.id;
    if (!threadId) throw new Error("thread/start did not return a thread id");
    return { threadId };
  }

  async resumeThread(threadId: string, workspace: string): Promise<{ threadId: string }> {
    const response = (await this.request("thread/resume", {
      threadId,
      cwd: workspace,
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
      persistExtendedHistory: true,
      excludeTurns: true
    })) as { thread?: { id?: string } };
    const resumedThreadId = response.thread?.id;
    if (!resumedThreadId) throw new Error("thread/resume did not return a thread id");
    return { threadId: resumedThreadId };
  }

  async startTurn(threadId: string, input: CodexTurnInput[], workspace: string): Promise<{ turnId: string }> {
    const response = (await this.request("turn/start", {
      threadId,
      input,
      cwd: workspace,
      approvalPolicy: "untrusted"
    })) as { turn?: { id?: string } };
    const turnId = response.turn?.id;
    if (!turnId) throw new Error("turn/start did not return a turn id");
    return { turnId };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, 15_000);
  }

  respond(id: string | number, result: unknown): void {
    this.send({ id, result });
  }

  stop(): void {
    if (!this.child) return;
    this.child.kill("SIGTERM");
    this.child = null;
  }

  private request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
    const id = this.nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({ method, id, params });
    return promise;
  }

  private notify(method: string, params?: unknown): void {
    const message: Record<string, unknown> = { method };
    if (params !== undefined) message.params = params;
    this.send(message);
  }

  private send(message: Record<string, unknown>): void {
    if (!this.child) throw new Error("codex app-server is not running");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.emit("log", line);
      return;
    }

    if ("id" in message && ("result" in message || "error" in message) && !("method" in message)) {
      const id = message.id as string | number;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if ("error" in message) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if ("method" in message && "id" in message) {
      this.emit("serverRequest", message);
      return;
    }

    if ("method" in message) {
      this.emit("notification", message);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit("log", error.message);
  }
}
