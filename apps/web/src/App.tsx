import {
  Activity,
  Check,
  Coffee,
  ImagePlus,
  Lock,
  MessageSquare,
  Plus,
  Power,
  RefreshCcw,
  Send,
  Shield,
  Square,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type TranscriptEntry = {
  id: number;
  role: "user" | "assistant" | "plan" | "command" | "system" | "error";
  text: string;
  createdAt: string;
  clientMessageId?: string;
};

type SessionPayload = {
  workspace: string;
  publicUrl: string;
  threadId: string;
  threadMode: "new" | "resumed";
  appServerMode?: "app-server" | "desktop-ipc";
  currentTurnId: string | null;
  currentDiff: string;
  transcript?: TranscriptEntry[];
  config: {
    maxActiveDevices: number;
    deviceTokenTtlMinutes: number;
    requireDesktopPairingApproval: boolean;
    desktopApprovalPrompt: boolean;
    pairingApprovalTtlSeconds: number;
    onDeviceLimitExceeded: string;
    auditLogRetentionDays: number;
  };
  pairingApprovals: PairingApprovalState[];
  devices: Array<{
    deviceName: string;
    ip: string;
    userAgent: string;
    createdAt: string;
    lastSeenAt: string;
    connected: boolean;
    sessionIdHash: string;
  }>;
};

type AuditEvent = {
  type: string;
  at?: string;
  ip?: string;
  userAgent?: string;
  deviceName?: string;
  sessionIdHash?: string;
  detail?: Record<string, unknown>;
};

type Approval = {
  requestId: string | number;
  method: string;
  summary: Record<string, unknown>;
};

type UserInputRequest = {
  requestId: string | number;
  method: string;
  summary: {
    kind?: string;
    questions?: UserInputQuestion[];
  };
};

type UserInputQuestion = {
  id: string;
  header: string;
  question: string;
  isOther?: boolean;
  options?: Array<{
    label: string;
    description?: string;
  }>;
};

type PairingApprovalState = {
  id: string;
  deviceName: string;
  ip: string;
  userAgent: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  decidedAt?: string;
  decidedBy?: string;
  sessionIdHash?: string;
};

export type UploadedImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: string;
  previewUrl: string;
};

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES_PER_TURN = 4;

let localEntryId = -1;

export function App() {
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState(() => extractToken());
  const [deviceName, setDeviceName] = useState("iPhone");
  const [session, setSession] = useState<SessionPayload | null>(null);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [userInputs, setUserInputs] = useState<UserInputRequest[]>([]);
  const [userInputAnswers, setUserInputAnswers] = useState<Record<string, string>>({});
  const [pairingApproval, setPairingApproval] = useState<PairingApprovalState | null>(null);
  const [loginBusy, setLoginBusy] = useState(false);
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<UploadedImage[]>([]);
  const [toolMenuOpen, setToolMenuOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState("Disconnected");
  const wsRef = useRef<WebSocket | null>(null);
  const outputRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pairingRequestRef = useRef<string | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const authenticatedRef = useRef(false);
  const stopRequestedRef = useRef(false);

  const hasRunningTurn = Boolean(session?.currentTurnId);
  const diffSummary = useMemo(() => summarizeDiff(session?.currentDiff ?? ""), [session?.currentDiff]);
  const conversationTranscript = useMemo(() => transcript.filter(isConversationEntry), [transcript]);

  useEffect(() => {
    authenticatedRef.current = authenticated;
  }, [authenticated]);

  useEffect(() => {
    fetchSession().catch(() => undefined);
    return () => {
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, []);

  useEffect(() => {
    outputRef.current?.scrollTo({ top: outputRef.current.scrollHeight, behavior: "smooth" });
  }, [transcript, approvals, userInputs]);

  async function fetchSession() {
    const response = await fetch("/api/session");
    const data = await response.json();
    setAuthenticated(data.authenticated);
    if (data.session) {
      setSession(data.session);
      setTranscript(data.session.transcript ?? []);
    }
    if (data.audit) setAudit(data.audit);
    if (data.authenticated) connectSocket();
  }

  async function login() {
    setLoginBusy(true);
    setPairingApproval(null);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, deviceName })
    });
    if (response.status === 202) {
      const data = await response.json();
      const pending = data.pairingApproval as PairingApprovalState;
      pairingRequestRef.current = pending.id;
      setPairingApproval(pending);
      setStatus("Waiting for desktop approval");
      pollPairingApproval(pending.id).catch((error) => {
        addLocalEntry("error", error.message);
        setLoginBusy(false);
      });
      return;
    }
    if (!response.ok) {
      addLocalEntry("error", `Login failed: ${await response.text()}`);
      setLoginBusy(false);
      return;
    }
    completeLogin(await response.json());
  }

  async function pollPairingApproval(requestId: string) {
    for (;;) {
      await delay(1500);
      if (pairingRequestRef.current !== requestId) return;
      const response = await fetch(`/api/pairing-requests/${encodeURIComponent(requestId)}`);
      const data = await response.json().catch(() => ({}));
      if (response.status === 202) {
        setPairingApproval(data.pairingApproval as PairingApprovalState);
        continue;
      }
      if (response.ok) {
        completeLogin(data);
        return;
      }
      pairingRequestRef.current = null;
      setPairingApproval(null);
      setLoginBusy(false);
      addLocalEntry("error", `Pairing failed: ${data.error ?? response.statusText}`);
      return;
    }
  }

  function completeLogin(data: { session: SessionPayload }) {
    pairingRequestRef.current = null;
    setPairingApproval(null);
    setLoginBusy(false);
    setAuthenticated(true);
    setSession(data.session);
    setTranscript(data.session.transcript ?? []);
    history.replaceState(null, "", location.pathname);
    connectSocket();
  }

  function connectSocket() {
    if (wsRef.current && wsRef.current.readyState <= WebSocket.OPEN) return;
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current);
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    wsRef.current = ws;
    setStatus("Connecting");

    ws.onopen = () => {
      reconnectAttemptsRef.current = 0;
      stopRequestedRef.current = false;
      setStatus(hasRunningTurn ? "Running" : "Connected");
    };
    ws.onclose = () => {
      if (wsRef.current === ws) wsRef.current = null;
      if (stopRequestedRef.current || !authenticatedRef.current) {
        setStatus("Disconnected");
        return;
      }
      setStatus("Reconnecting");
      scheduleReconnect();
    };
    ws.onerror = () => setStatus("Connection error");
    ws.onmessage = (event) => handleSocketMessage(JSON.parse(event.data));
  }

  function scheduleReconnect() {
    const attempt = reconnectAttemptsRef.current++;
    const delayMs = Math.min(10_000, 800 * 2 ** attempt);
    reconnectTimerRef.current = window.setTimeout(() => {
      connectSocket();
      fetchSession().catch(() => undefined);
    }, delayMs);
  }

  function handleSocketMessage(payload: Record<string, unknown>) {
    if (payload.type === "session.status") {
      if (payload.session) {
        const nextSession = payload.session as SessionPayload;
        setSession(nextSession);
        setTranscript(nextSession.transcript ?? []);
      }
      if (payload.status) setStatus(String(payload.status));
    } else if (payload.type === "transcript.append") {
      const entry = payload.entry as TranscriptEntry;
      setTranscript((current) => mergeTranscriptAppend(current, entry));
    } else if (payload.type === "transcript.update") {
      const entry = payload.entry as TranscriptEntry;
      setTranscript((current) => current.map((item) => (item.id === entry.id ? entry : item)));
    } else if (payload.type === "diff.updated") {
      setSession((current) => (current ? { ...current, currentDiff: String(payload.diff ?? "") } : current));
    } else if (payload.type === "approval.request") {
      setApprovals((current) => appendUniqueRequest(current, payload as Approval));
    } else if (payload.type === "userInput.request") {
      setUserInputs((current) => appendUniqueRequest(current, payload as UserInputRequest));
    } else if (payload.type === "approval.resolved" || payload.type === "userInput.resolved") {
      setApprovals((current) => current.filter((item) => item.requestId !== payload.requestId));
      setUserInputs((current) => current.filter((item) => item.requestId !== payload.requestId));
    } else if (payload.type === "turn.started") {
      setSession((current) => (current ? { ...current, currentTurnId: String(payload.turnId ?? "") } : current));
      setStatus("Running");
    } else if (payload.type === "turn.completed") {
      setSession((current) => (current ? { ...current, currentTurnId: null } : current));
      setStatus("Connected");
    } else if (payload.type === "security.lockdown") {
      addLocalEntry("error", `Security lockdown: ${payload.reason}`);
    } else if (payload.type === "error") {
      addLocalEntry("error", String(payload.message ?? "Unknown error"));
    }
  }

  function sendWs(message: unknown): boolean {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      addLocalEntry("error", "Connection is not ready. Reconnecting...");
      connectSocket();
      return false;
    }
    wsRef.current.send(JSON.stringify(message));
    return true;
  }

  function addLocalEntry(role: TranscriptEntry["role"], message: string, clientMessageId?: string) {
    if (!message) return;
    setTranscript((current) =>
      [
        ...current,
        {
          id: localEntryId--,
          role,
          text: message,
          createdAt: new Date().toISOString(),
          ...(clientMessageId ? { clientMessageId } : {})
        }
      ].slice(-300)
    );
  }

  async function uploadImages(files: FileList | null) {
    const selected = Array.from(files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!selected.length) return;

    const slots = MAX_IMAGES_PER_TURN - attachments.length;
    if (slots <= 0) {
      addLocalEntry("error", `Attach at most ${MAX_IMAGES_PER_TURN} images per message.`);
      return;
    }
    setUploading(true);
    const uploaded: UploadedImage[] = [];
    for (const file of selected.slice(0, slots)) {
      if (!file.type.startsWith("image/")) {
        addLocalEntry("error", `${file.name} is not an image.`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        addLocalEntry("error", `${file.name} is larger than 8 MB.`);
        continue;
      }
      try {
        const dataUrl = await readFileAsDataUrl(file);
        const response = await fetch("/api/uploads/images", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, mimeType: file.type, dataUrl })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error ?? response.statusText);
        uploaded.push({ ...(data as Omit<UploadedImage, "previewUrl">), previewUrl: dataUrl });
      } catch (error) {
        addLocalEntry("error", `Image upload failed: ${(error as Error).message}`);
      }
    }
    if (selected.length > slots) addLocalEntry("error", `Only ${MAX_IMAGES_PER_TURN} images can be attached to one message.`);
    if (uploaded.length) setAttachments((current) => [...current, ...uploaded].slice(0, MAX_IMAGES_PER_TURN));
    setUploading(false);
  }

  function removeAttachment(id: string) {
    setAttachments((current) => current.filter((image) => image.id !== id));
  }

  function startTurn(overrideText?: string) {
    const prompt = (overrideText ?? text).trim();
    const images = overrideText === undefined ? attachments : [];
    if (!prompt && images.length === 0) return;
    const clientMessageId = createClientMessageId();
    const displayText = displayTextForTurn(prompt, images);
    const message = {
      type: "turn.start",
      text: prompt,
      images: images.map((image) => ({ id: image.id })),
      clientMessageId
    };
    if (!sendWs(message)) return;
    addLocalEntry("user", displayText, clientMessageId);
    if (overrideText === undefined) {
      setText("");
      setAttachments([]);
      setToolMenuOpen(false);
    }
  }

  function decide(approval: Approval, decision: "accept" | "decline" | "cancel") {
    sendWs({ type: "approval.decide", requestId: approval.requestId, decision });
  }

  function submitUserInput(request: UserInputRequest) {
    const questions = request.summary.questions ?? [];
    const answers: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      const value = userInputAnswers[inputAnswerKey(request.requestId, question.id)]?.trim();
      if (!value) {
        addLocalEntry("error", "Answer every question before submitting.");
        return;
      }
      answers[question.id] = { answers: [value] };
    }
    if (sendWs({ type: "userInput.submit", requestId: request.requestId, answers })) {
      setUserInputs((current) => current.filter((item) => item.requestId !== request.requestId));
    }
  }

  async function stopServer() {
    stopRequestedRef.current = true;
    await fetch("/api/stop", { method: "POST" });
    setStatus("Stopping");
  }

  async function refreshAudit() {
    const response = await fetch("/api/session");
    const data = await response.json();
    setSession(data.session);
    if (data.session?.transcript) setTranscript(data.session.transcript);
    setAudit(data.audit ?? []);
  }

  if (!authenticated) {
    return (
      <main className="login-shell">
        <section className="login-panel">
          <div className="brand-row">
            <Shield size={28} />
            <div>
              <h1>Codex Remote iPhone</h1>
              <p>Pair this phone to the Codex session running on your computer.</p>
            </div>
          </div>
          <label>
            Pairing token
            <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Scan QR or paste token" />
          </label>
          <label>
            Device name
            <input value={deviceName} onChange={(event) => setDeviceName(event.target.value)} />
          </label>
          <button className="primary" onClick={login} disabled={loginBusy || Boolean(pairingApproval)}>
            {pairingApproval ? <Activity size={18} /> : <Lock size={18} />}
            {pairingApproval ? "Waiting" : "Pair device"}
          </button>
          {pairingApproval ? (
            <div className="pending-pairing">
              <strong>Waiting for desktop approval</strong>
              <span>{pairingApproval.deviceName} · {pairingApproval.status}</span>
              <small>Request {pairingApproval.id}</small>
              <small>Expires {new Date(pairingApproval.expiresAt).toLocaleTimeString()}</small>
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <h1>Codex Remote iPhone</h1>
          <p>{session?.workspace ?? "Workspace loading..."}</p>
        </div>
        <div className="topbar-actions">
          <div className={`status ${status.toLowerCase().replace(/\s+/g, "-")}`}>
            <Activity size={16} />
            {status}
          </div>
          <button className="danger subtle" onClick={stopServer} title="Close remote console">
            <Power size={17} />
            Close Remote
          </button>
        </div>
      </header>

      <section className="grid">
        <div className="panel conversation" ref={outputRef}>
          <h2>
            <MessageSquare size={18} />
            Session
          </h2>
          {conversationTranscript.length === 0 ? <p className="empty">Waiting for Codex output.</p> : null}
          <div className="conversation-list">
            {conversationTranscript.map((entry) => (
              <article className={`bubble ${entry.role}`} key={entry.id}>
                <div className="bubble-meta">
                  <strong>{labelForRole(entry.role)}</strong>
                  <time>{new Date(entry.createdAt).toLocaleTimeString()}</time>
                </div>
                {entry.role === "command" ? <pre>{entry.text}</pre> : <p>{entry.text}</p>}
                {entry.role === "plan" ? (
                  <button className="primary compact" onClick={() => startTurn(`PLEASE IMPLEMENT THIS PLAN:\n${entry.text}`)} disabled={hasRunningTurn}>
                    <Check size={16} />
                    Implement plan
                  </button>
                ) : null}
              </article>
            ))}
          </div>
        </div>

        <aside className="panel side-panel">
          <h2>
            <Shield size={18} />
            Needs You
          </h2>
          {approvals.length === 0 && userInputs.length === 0 ? <p className="empty">No pending decisions.</p> : null}
          {userInputs.map((request) => (
            <article className="approval" key={String(request.requestId)}>
              <strong>User input</strong>
              {(request.summary.questions ?? []).map((question) => (
                <div className="question" key={question.id}>
                  <span>{question.header || question.id}</span>
                  <p>{question.question}</p>
                  {question.options?.length ? (
                    <div className="option-grid">
                      {question.options.map((option) => {
                        const key = inputAnswerKey(request.requestId, question.id);
                        const selected = userInputAnswers[key] === option.label;
                        return (
                          <button
                            className={selected ? "selected" : ""}
                            key={option.label}
                            onClick={() => setUserInputAnswers((current) => ({ ...current, [key]: option.label }))}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  ) : null}
                  {!question.options?.length || question.isOther ? (
                    <input
                      value={userInputAnswers[inputAnswerKey(request.requestId, question.id)] ?? ""}
                      onChange={(event) =>
                        setUserInputAnswers((current) => ({
                          ...current,
                          [inputAnswerKey(request.requestId, question.id)]: event.target.value
                        }))
                      }
                      placeholder="Type an answer"
                    />
                  ) : null}
                </div>
              ))}
              <button className="primary" onClick={() => submitUserInput(request)}>
                Submit
              </button>
            </article>
          ))}
          {approvals.map((approval) => (
            <article className="approval" key={String(approval.requestId)}>
              <strong>{String(approval.summary.kind ?? approval.method)}</strong>
              <pre>{JSON.stringify(approval.summary, null, 2)}</pre>
              <div className="button-row">
                <button className="primary" onClick={() => decide(approval, "accept")}>
                  Approve
                </button>
                <button onClick={() => decide(approval, "decline")}>Deny</button>
                <button className="danger" onClick={() => decide(approval, "cancel")}>Cancel</button>
              </div>
            </article>
          ))}

          <h2>
            <RefreshCcw size={18} />
            Diff
          </h2>
          <p className="mono">{diffSummary}</p>
        </aside>
      </section>

      <section className="composer">
        {toolMenuOpen ? (
          <div className="attachment-menu">
            <button
              type="button"
              onClick={() => {
                setToolMenuOpen(false);
                fileInputRef.current?.click();
              }}
              disabled={uploading || hasRunningTurn || attachments.length >= MAX_IMAGES_PER_TURN}
            >
              <ImagePlus size={18} />
              Image
            </button>
          </div>
        ) : null}
        {attachments.length ? (
          <div className="attachment-strip" aria-label="Image attachments">
            {attachments.map((image) => (
              <div className="attachment-chip" key={image.id}>
                <img src={image.previewUrl} alt="" />
                <span>{image.name}</span>
                <small>{formatBytes(image.size)}</small>
                <button type="button" className="icon-button" onClick={() => removeAttachment(image.id)} title="Remove image">
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Ask Codex to work in this workspace..."
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !hasRunningTurn) startTurn();
          }}
        />
        <input
          ref={fileInputRef}
          className="file-input"
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          onChange={(event) => uploadImages(event.target.files)}
        />
        <div className="composer-actions">
          <div className="composer-tools">
            <button
              type="button"
              className="icon-button"
              onClick={() => setToolMenuOpen((open) => !open)}
              disabled={uploading || hasRunningTurn}
              title="Add attachment"
            >
              <Plus size={19} />
            </button>
            <span>{session?.appServerMode === "desktop-ipc" ? "Desktop session" : "Phone session"}</span>
          </div>
          {hasRunningTurn ? (
            <button className="danger" onClick={() => sendWs({ type: "turn.interrupt" })}>
              <Square size={18} />
              Stop response
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => startTurn()}
              disabled={uploading || (!text.trim() && attachments.length === 0) || status === "Reconnecting"}
            >
              <Send size={18} />
              Send
            </button>
          )}
        </div>
      </section>

      <details className="panel monitor">
        <summary>
          <span>
            <Activity size={18} />
            Access Monitor
          </span>
          <button
            onClick={(event) => {
              event.preventDefault();
              refreshAudit();
            }}
          >
            <RefreshCcw size={16} />
            Refresh
          </button>
        </summary>
        <div className="metrics">
          <div>
            <span>Max devices</span>
            <strong>{session?.config.maxActiveDevices}</strong>
          </div>
          <div>
            <span>Policy</span>
            <strong>{session?.config.onDeviceLimitExceeded}</strong>
          </div>
          <div>
            <span>Thread</span>
            <strong>{session?.threadMode ?? "..."}</strong>
          </div>
          <div>
            <span>Mode</span>
            <strong>{session?.appServerMode ?? "..."}</strong>
          </div>
          <div>
            <span>Active</span>
            <strong>{session?.devices.length ?? 0}</strong>
          </div>
          <div>
            <span>Pairing</span>
            <strong>{session?.config.requireDesktopPairingApproval ? "approval" : "token"}</strong>
          </div>
        </div>
        <div className="device-list">
          {session?.devices.map((device) => (
            <div key={device.sessionIdHash}>
              <strong>{device.deviceName}</strong>
              <span>{device.ip}</span>
              <small>{device.connected ? "online" : "paired"} · {device.sessionIdHash}</small>
            </div>
          ))}
        </div>
        <div className="audit-list">
          {audit.slice(-20).reverse().map((event, index) => (
            <p key={`${event.at}-${index}`}>
              <span>{event.at?.slice(11, 19)}</span>
              <strong>{event.type}</strong>
              {event.deviceName ? ` · ${event.deviceName}` : ""}
            </p>
          ))}
        </div>
      </details>

      <footer>
        <Coffee size={16} />
        MIT open source. Sponsorship is optional coffee money.
      </footer>
    </main>
  );
}

function extractToken(): string {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  return hash.get("token") ?? "";
}

function appendUniqueRequest<T extends { requestId: string | number }>(items: T[], item: T): T[] {
  return [...items.filter((current) => current.requestId !== item.requestId), item];
}

export function mergeTranscriptAppend(current: TranscriptEntry[], entry: TranscriptEntry): TranscriptEntry[] {
  if (entry.clientMessageId) {
    const withoutOptimistic = current.filter(
      (item) => item.id !== entry.id && item.clientMessageId !== entry.clientMessageId
    );
    return [...withoutOptimistic, entry].slice(-300);
  }
  return [...current.filter((item) => item.id !== entry.id), entry].slice(-300);
}

function inputAnswerKey(requestId: string | number, questionId: string): string {
  return `${String(requestId)}:${questionId}`;
}

function labelForRole(role: TranscriptEntry["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "Codex";
  if (role === "plan") return "Plan";
  if (role === "command") return "Command";
  if (role === "error") return "Error";
  return "System";
}

function isConversationEntry(entry: TranscriptEntry): boolean {
  return entry.role === "user" || entry.role === "assistant" || entry.role === "plan";
}

function summarizeDiff(diff: string): string {
  if (!diff) return "No file changes yet.";
  const added = diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const files = new Set(diff.match(/^diff --git .+$/gm) ?? []).size;
  return `${files || 1} file(s), +${added} / -${removed}`;
}

export function displayTextForTurn(text: string, images: UploadedImage[]): string {
  return [text.trim(), ...images.map((image) => `[Image: ${image.name}]`)].filter(Boolean).join("\n");
}

function createClientMessageId(): string {
  if ("randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not read image"));
    };
    reader.onerror = () => reject(reader.error ?? new Error("Could not read image"));
    reader.readAsDataURL(file);
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
