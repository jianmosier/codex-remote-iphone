import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { Socket, connect as connectSocket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { AppServerEvents, CodexClient, CodexClientMode } from "./appServer.js";

type PendingIpcRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type IpcMessage = Record<string, unknown>;

type ConversationState = {
  id?: string;
  turns?: Array<{
    turnId?: string | null;
    status?: string | null;
    diff?: string | null;
    items?: Array<Record<string, unknown>>;
  }>;
  requests?: Array<{
    id?: string | number;
    method?: string;
    params?: Record<string, unknown>;
  }>;
};

type TrackedApproval = {
  conversationId: string;
  method: string;
};

const IPC_VERSIONS: Record<string, number> = {
  "thread-stream-state-changed": 6,
  "thread-read-state-changed": 1,
  "thread-archived": 2,
  "thread-unarchived": 1,
  "thread-follower-start-turn": 1,
  "thread-follower-compact-thread": 1,
  "thread-follower-steer-turn": 1,
  "thread-follower-interrupt-turn": 1,
  "thread-follower-set-model-and-reasoning": 1,
  "thread-follower-set-collaboration-mode": 1,
  "thread-follower-edit-last-user-turn": 1,
  "thread-follower-command-approval-decision": 1,
  "thread-follower-file-approval-decision": 1,
  "thread-follower-permissions-request-approval-response": 1,
  "thread-follower-submit-user-input": 1,
  "thread-follower-submit-mcp-server-elicitation-response": 1,
  "thread-follower-set-queued-follow-ups-state": 1,
  "thread-queued-followups-changed": 1
};

export class DesktopIpcClient extends EventEmitter<AppServerEvents> implements CodexClient {
  readonly mode = "desktop-ipc" satisfies CodexClientMode;
  private socket: Socket | null = null;
  private clientId = "initializing-client";
  private pending = new Map<string, PendingIpcRequest>();
  private readBuffer = Buffer.alloc(0);
  private nextFrameLength: number | null = null;
  private threadId: string | null = null;
  private conversation: ConversationState | null = null;
  private renderedOutput = "";
  private lastTurnStatus: string | null = null;
  private lastTurnId: string | null = null;
  private approvals = new Map<string | number, TrackedApproval>();

  constructor(
    private cwd: string,
    private socketPath = getDefaultIpcSocketPath()
  ) {
    super();
  }

  get pid(): undefined {
    return undefined;
  }

  static canConnect(socketPath = getDefaultIpcSocketPath()): boolean {
    return existsSync(socketPath);
  }

  async initialize(): Promise<void> {
    if (!DesktopIpcClient.canConnect(this.socketPath)) {
      throw new Error(`Codex Desktop IPC socket was not found at ${this.socketPath}`);
    }
    await this.connect();
    const response = (await this.request("initialize", { clientType: "codex-remote-iphone" }, 10_000)) as {
      clientId?: string;
    };
    if (typeof response.clientId === "string" && response.clientId.length > 0) {
      this.clientId = response.clientId;
    }
    this.emit("log", `connected to Codex Desktop IPC at ${this.socketPath}`);
  }

  async startThread(): Promise<{ threadId: string }> {
    throw new Error("desktop IPC mode needs an existing Codex Desktop thread");
  }

  async resumeThread(threadId: string): Promise<{ threadId: string }> {
    this.threadId = threadId;
    return { threadId };
  }

  async startTurn(threadId: string, text: string, workspace: string): Promise<{ turnId: string }> {
    this.threadId = threadId;
    this.resetOutputBaseline();
    const result = await this.request(
      "thread-follower-start-turn",
      {
        conversationId: threadId,
        turnStartParams: {
          input: [{ type: "text", text, text_elements: [] }],
          cwd: workspace || this.cwd
        }
      },
      15_000
    );
    const turnId = findTurnId(result) ?? `desktop-${Date.now()}`;
    this.lastTurnId = turnId;
    return { turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("thread-follower-interrupt-turn", { conversationId: threadId }, 10_000);
  }

  respond(id: string | number, result: unknown): void {
    const approval = this.approvals.get(id);
    if (!approval) {
      this.emit("log", `desktop approval ${String(id)} is no longer pending`);
      return;
    }
    const decision = readDecision(result);
    const method =
      approval.method === "item/commandExecution/requestApproval"
        ? "thread-follower-command-approval-decision"
        : approval.method === "item/fileChange/requestApproval"
          ? "thread-follower-file-approval-decision"
          : approval.method === "item/permissions/requestApproval"
            ? "thread-follower-permissions-request-approval-response"
            : approval.method === "item/tool/requestUserInput"
              ? "thread-follower-submit-user-input"
          : "";
    if (!method) {
      this.emit("log", `desktop approval method is not supported yet: ${approval.method}`);
      return;
    }
    const params =
      approval.method === "item/tool/requestUserInput" || approval.method === "item/permissions/requestApproval"
        ? { conversationId: approval.conversationId, requestId: id, response: result }
        : { conversationId: approval.conversationId, requestId: id, decision };
    this.request(method, params, 10_000)
      .then(() => this.approvals.delete(id))
      .catch((error) => this.emit("log", `desktop approval failed: ${error.message}`));
  }

  stop(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("desktop IPC stopped"));
    }
    this.pending.clear();
    this.socket?.destroy();
    this.socket = null;
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = connectSocket(this.socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out connecting to Codex Desktop IPC"));
      }, 10_000);
      socket.once("connect", () => {
        clearTimeout(timer);
        this.socket = socket;
        socket.on("data", (chunk) => this.handleData(chunk));
        socket.on("error", (error) => this.rejectAll(error));
        socket.on("close", () => this.rejectAll(new Error("Codex Desktop IPC closed")));
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  private request(method: string, params: unknown, timeoutMs = 10_000): Promise<unknown> {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    const requestId = randomUUID();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.write({
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version: IPC_VERSIONS[method] ?? 0,
      method,
      params
    });
    return promise;
  }

  private write(message: IpcMessage): void {
    if (!this.socket?.writable) throw new Error("Codex Desktop IPC is not connected");
    const raw = Buffer.from(JSON.stringify(message), "utf8");
    const frame = Buffer.alloc(4 + raw.length);
    frame.writeUInt32LE(raw.length, 0);
    raw.copy(frame, 4);
    this.socket.write(frame);
  }

  private handleData(chunk: Buffer): void {
    this.readBuffer = Buffer.concat([this.readBuffer, chunk]);
    for (;;) {
      if (this.nextFrameLength === null) {
        if (this.readBuffer.length < 4) return;
        this.nextFrameLength = this.readBuffer.readUInt32LE(0);
        this.readBuffer = this.readBuffer.subarray(4);
      }
      if (this.readBuffer.length < this.nextFrameLength) return;
      const frame = this.readBuffer.subarray(0, this.nextFrameLength);
      this.readBuffer = this.readBuffer.subarray(this.nextFrameLength);
      this.nextFrameLength = null;
      try {
        this.handleMessage(JSON.parse(frame.toString("utf8")) as IpcMessage);
      } catch (error) {
        this.emit("log", `desktop IPC parse failed: ${(error as Error).message}`);
      }
    }
  }

  private handleMessage(message: IpcMessage): void {
    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }
    if (message.type === "broadcast") {
      this.handleBroadcast(message);
      return;
    }
    if (message.type === "client-discovery-request") {
      this.write({
        type: "client-discovery-response",
        requestId: message.requestId,
        response: { canHandle: false }
      });
      return;
    }
    if (message.type === "request") {
      this.write({
        type: "response",
        requestId: message.requestId,
        resultType: "error",
        error: "no-handler-for-request"
      });
    }
  }

  private handleResponse(message: IpcMessage): void {
    const requestId = String(message.requestId ?? "");
    const pending = this.pending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (message.resultType === "error") {
      pending.reject(new Error(String(message.error ?? "desktop IPC request failed")));
      return;
    }
    pending.resolve(message.result);
  }

  private handleBroadcast(message: IpcMessage): void {
    const method = String(message.method ?? "");
    if (method !== "thread-stream-state-changed") return;
    if ((message.version ?? 0) !== IPC_VERSIONS[method]) return;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const conversationId = String(params.conversationId ?? "");
    if (this.threadId && conversationId !== this.threadId) return;
    const change = params.change as Record<string, unknown> | undefined;
    if (!change) return;
    if (change.type === "snapshot") {
      this.conversation = cloneJson(change.conversationState) as ConversationState;
      this.resetOutputBaseline();
    } else if (change.type === "patches" && this.conversation) {
      applyPatches(this.conversation, change.patches);
    }
    if (this.conversation) this.emitConversationUpdate(conversationId, this.conversation);
  }

  private emitConversationUpdate(conversationId: string, conversation: ConversationState): void {
    this.syncApprovals(conversationId, conversation.requests ?? []);
    const output = renderConversationOutput(conversation);
    if (output.startsWith(this.renderedOutput)) {
      const delta = output.slice(this.renderedOutput.length);
      if (delta) this.emit("notification", { method: "item/agentMessage/delta", params: { threadId: conversationId, delta } });
    } else if (output !== this.renderedOutput) {
      const commonPrefix = sharedPrefixLength(this.renderedOutput, output);
      const delta = output.slice(commonPrefix);
      this.emit("notification", {
        method: "item/agentMessage/delta",
        params: { threadId: conversationId, delta }
      });
    }
    this.renderedOutput = output;

    const latestTurn = conversation.turns?.at(-1);
    const latestTurnId = latestTurn?.turnId ?? null;
    const latestStatus = latestTurn?.status ?? null;
    if (typeof latestTurn?.diff === "string") {
      this.emit("notification", { method: "turn/diff/updated", params: { threadId: conversationId, diff: latestTurn.diff } });
    }
    if (latestTurnId) this.lastTurnId = latestTurnId;
    if (this.lastTurnStatus === "inProgress" && latestStatus && latestStatus !== "inProgress") {
      this.emit("notification", { method: "turn/completed", params: { threadId: conversationId, turnId: latestTurnId } });
    }
    this.lastTurnStatus = latestStatus;
  }

  private syncApprovals(
    conversationId: string,
    requests: Array<{ id?: string | number; method?: string; params?: Record<string, unknown> }>
  ): void {
    const active = new Set<string | number>();
    for (const request of requests) {
      if (request.id === undefined || !request.method) continue;
      if (
        request.method !== "item/commandExecution/requestApproval" &&
        request.method !== "item/fileChange/requestApproval" &&
        request.method !== "item/permissions/requestApproval" &&
        request.method !== "item/tool/requestUserInput"
      ) {
        continue;
      }
      active.add(request.id);
      if (!this.approvals.has(request.id)) {
        this.approvals.set(request.id, { conversationId, method: request.method });
        this.emit("serverRequest", {
          id: request.id,
          method: request.method,
          params: request.params ?? {}
        });
      }
    }
    for (const [requestId, approval] of this.approvals) {
      if (approval.conversationId !== conversationId || active.has(requestId)) continue;
      this.approvals.delete(requestId);
      this.emit("notification", { method: "serverRequest/resolved", params: { requestId, threadId: conversationId } });
    }
  }

  private resetOutputBaseline(): void {
    this.renderedOutput = this.conversation ? renderConversationOutput(this.conversation) : "";
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

export function getDefaultIpcSocketPath(): string {
  const uid = process.getuid?.();
  return join(tmpdir(), "codex-ipc", uid ? `ipc-${uid}.sock` : "ipc.sock");
}

function findTurnId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const nested = record.result && typeof record.result === "object" ? (record.result as Record<string, unknown>) : record;
  const turn = nested.turn && typeof nested.turn === "object" ? (nested.turn as Record<string, unknown>) : null;
  return typeof turn?.id === "string" ? turn.id : null;
}

function readDecision(value: unknown): string {
  if (!value || typeof value !== "object") return "decline";
  const decision = (value as Record<string, unknown>).decision;
  return typeof decision === "string" ? decision : "decline";
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function applyPatches(target: unknown, patches: unknown): void {
  if (!Array.isArray(patches)) return;
  for (const patch of patches) {
    if (!patch || typeof patch !== "object") continue;
    const record = patch as Record<string, unknown>;
    const path = normalizePatchPath(record.path);
    if (path.length === 0) continue;
    const parent = resolvePatchParent(target, path);
    if (!parent || typeof parent !== "object") continue;
    const key = path[path.length - 1]!;
    if (record.op === "remove") {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete (parent as Record<string, unknown>)[String(key)];
    } else if (record.op === "add" || record.op === "replace") {
      if (Array.isArray(parent)) parent[Number(key)] = record.value;
      else (parent as Record<string, unknown>)[String(key)] = record.value;
    }
  }
}

function normalizePatchPath(path: unknown): Array<string | number> {
  if (Array.isArray(path)) return path.filter((item): item is string | number => typeof item === "string" || typeof item === "number");
  if (typeof path !== "string") return [];
  return path
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function resolvePatchParent(target: unknown, path: Array<string | number>): unknown {
  let cursor = target as Record<string, unknown> | Array<unknown> | null;
  for (const segment of path.slice(0, -1)) {
    if (!cursor || typeof cursor !== "object") return null;
    cursor = (cursor as Record<string, unknown>)[String(segment)] as Record<string, unknown> | Array<unknown> | null;
  }
  return cursor;
}

export function renderConversationOutput(conversation: ConversationState): string {
  const chunks: string[] = [];
  for (const turn of conversation.turns ?? []) {
    for (const item of turn.items ?? []) {
      const text = renderItem(item);
      if (text) chunks.push(text);
    }
  }
  return chunks.join("\n");
}

function renderItem(item: Record<string, unknown>): string {
  const type = item.type;
  if (type === "agentMessage" || type === "plan") return stringValue(item.text);
  return "";
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(stringValue).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.cmd === "string") return record.cmd;
    if (typeof record.command === "string") return record.command;
    if (typeof record.text === "string") return record.text;
  }
  return "";
}

function sharedPrefixLength(left: string, right: string): number {
  const length = Math.min(left.length, right.length);
  let index = 0;
  while (index < length && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}
