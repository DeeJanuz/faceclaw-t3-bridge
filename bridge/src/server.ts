import { PhoneService, type PhoneSnapshot } from "./phone.js";
import { SignalHttp } from './signal-http.js';
import { FaceclawRelay, faceclawToken, mintToolToken, verifyToolToken } from './faceclaw.js';
import { RefinementService } from './refinement.js';
import { FaceclawProviderGrants } from './faceclaw-provider.js';
import { AssistantArchive, type ArchiveStatus } from "./assistant-archive.js";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { diagnosticOrigin } from "./pairing-diagnostics.js";
import { WeatherService } from "./weather.js";
import { SessionControlsService, freshAllowedThread, requireIdleSession } from "./session-controls.js";
import { PlanInputService } from "./plan-input.js";
import { BridgeServiceRegistry } from "./service-registry.js";
import {
  findProject,
  findThread,
  normalizeProjects,
  normalizeSessions,
  normalizeTranscript,
} from "./normalize.js";
import {
  ApiError,
  FixedWindowRateLimiter,
  applySecurityHeaders,
  bearerToken,
  isSafeId,
  originAllowed,
  parsePathId,
  parseText,
  pairingPassphraseMatches,
  readJsonBody,
  safeRequestId,
  secretMatches,
  sendJson,
  websocketToken,
} from "./security.js";
import type {
  BridgeConfig,
  T3Client,
  T3ModelCatalog,
  T3NewSessionSelection,
  T3ThreadShell,
  Transcriber,
} from "./types.js";

const WS_PROTOCOL = "even-t3-v1";
const MAX_WS_FRAME_BYTES = 64 * 1024;
const MAX_WS_JSON_BYTES = 16 * 1024;
const MAX_WS_SUBSCRIPTIONS = 8;
const MAX_WS_BUFFERED_BYTES = 1024 * 1024;
const MIN_VOICE_BYTES = 3200;
const PAIRING_MAX_BODY_BYTES = 1024;
const PAIRING_ATTEMPTS_PER_WINDOW = 5;
const PAIRING_WINDOW_MS = 5 * 60_000;

interface VoiceRecording {
  readonly phoneKey: string | null;
  phase: "recording" | "finishing";
  readonly chunks: Buffer[];
  bytes: number;
  readonly abortController: AbortController;
  partialAbortController: AbortController | null;
  partialInFlight: boolean;
  lastPartialBytes: number;
  partialTimer: NodeJS.Timeout | null;
}

interface SocketState {
  nativeFaceclaw: boolean;
  refinement: AbortController | null;
  readonly socket: WebSocket;
  readonly subscriptions: Set<string>;
  shellSequence: number | null;
  readonly threadSequences: Map<string, number>;
  alive: boolean;
  voice: VoiceRecording | null;
}

interface RpcRequest {
  readonly v: 1;
  readonly type: "request";
  readonly id: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function clientKey(request: IncomingMessage): string {
  return request.socket.remoteAddress ?? "unknown";
}

function logRequest(requestId: string, method: string, path: string, status: number): void {
  process.stdout.write(
    `${JSON.stringify({ level: "info", requestId, method, path, status, at: new Date().toISOString() })}\n`,
  );
}

function websocketSend(state: SocketState, value: unknown): void {
  if (state.socket.readyState !== WebSocket.OPEN) return;
  if (state.socket.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    state.socket.close(1013, "Client is too slow");
    return;
  }
  state.socket.send(JSON.stringify(value));
}

function sendEvent(state: SocketState, event: string, payload: unknown): void {
  websocketSend(state, { v: 1, type: "event", event, payload });
}

function sendRpcResult(state: SocketState, id: string, result: unknown): void {
  websocketSend(state, { v: 1, type: "response", id, ok: true, result });
}

function sendRpcError(state: SocketState, id: string, error: unknown): void {
  const safe =
    error instanceof ApiError
      ? error
      : new ApiError(500, "internal_error", "The bridge could not complete the request");
  websocketSend(state, {
    v: 1,
    type: "response",
    id,
    ok: false,
    error: { code: safe.code, message: safe.message },
  });
}

function parseRpcRequest(raw: string): RpcRequest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_message", "Invalid request");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_message", "Invalid request");
  }
  const request = value as Record<string, unknown>;
  if (
    request.v !== 1 ||
    request.type !== "request" ||
    typeof request.id !== "string" ||
    !/^[A-Za-z0-9._:-]{1,64}$/.test(request.id) ||
    typeof request.method !== "string" ||
    typeof request.params !== "object" ||
    request.params === null ||
    Array.isArray(request.params)
  ) {
    throw new ApiError(400, "invalid_message", "Invalid request");
  }
  return request as unknown as RpcRequest;
}

function requiredId(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !isSafeId(value)) {
    throw new ApiError(400, "invalid_request", `${name} must be a valid identifier`);
  }
  return value;
}

function boundedSelectionString(
  value: unknown,
  name: string,
  maximumChars: number,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumChars ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ApiError(400, "invalid_request", `${name} must be a valid identifier`);
  }
  return value;
}

function parseModelSelection(params: Record<string, unknown>): T3NewSessionSelection {
  const value = params.modelSelection;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", "modelSelection must be an object");
  }
  const selection = value as Record<string, unknown>;
  const allowedKeys = new Set(["instanceId", "model", "reasoningId"]);
  if (Object.keys(selection).some((key) => !allowedKeys.has(key))) {
    throw new ApiError(400, "invalid_request", "modelSelection contains unsupported fields");
  }
  const instanceId = boundedSelectionString(selection.instanceId, "instanceId", 128);
  if (!isSafeId(instanceId)) {
    throw new ApiError(400, "invalid_request", "instanceId must be a valid identifier");
  }
  const model = boundedSelectionString(selection.model, "model", 256);
  if (selection.reasoningId === undefined) return { instanceId, model };
  const reasoningId = boundedSelectionString(selection.reasoningId, "reasoningId", 128);
  if (!isSafeId(reasoningId)) {
    throw new ApiError(400, "invalid_request", "reasoningId must be a valid identifier");
  }
  return { instanceId, model, reasoningId };
}

async function readPairingBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > PAIRING_MAX_BODY_BYTES) {
    request.resume();
    throw new ApiError(413, "request_too_large", "Request body is too large");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let exceeded = false;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    size += chunk.byteLength;
    if (size > PAIRING_MAX_BODY_BYTES) {
      exceeded = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (exceeded) throw new ApiError(413, "request_too_large", "Request body is too large");
  if (size === 0) throw new ApiError(401, "pairing_failed", "Pairing failed");
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new ApiError(401, "pairing_failed", "Pairing failed");
  }
}

function flattenModelCatalog(catalog: T3ModelCatalog) {
  return {
    models: catalog.providers.flatMap((provider) =>
      provider.models.map((model) => ({
        instanceId: provider.instanceId,
        providerName: provider.label,
        model: model.slug,
        name: model.name,
        isDefault: model.isDefault,
        reasoningChoices: model.reasoning?.choices ?? [],
      })),
    ),
  };
}

function wipeRecording(recording: VoiceRecording): void {
  if (recording.partialTimer !== null) {
    clearInterval(recording.partialTimer);
    recording.partialTimer = null;
  }
  recording.partialAbortController?.abort();
  recording.partialAbortController = null;
  for (const chunk of recording.chunks) chunk.fill(0);
  recording.chunks.length = 0;
  recording.bytes = 0;
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

function isExpectedPartialFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    (error.code === "no_speech" || error.code === "voice_cancelled")
  );
}

function startPartialTranscription(
  state: SocketState,
  recording: VoiceRecording,
  transcriber: Transcriber,
): void {
  if (
    state.voice !== recording ||
    recording.phase !== "recording" ||
    recording.partialInFlight ||
    recording.bytes < MIN_VOICE_BYTES ||
    recording.bytes === recording.lastPartialBytes
  ) {
    return;
  }

  recording.partialInFlight = true;
  recording.lastPartialBytes = recording.bytes;
  const pcm = Buffer.concat(recording.chunks, recording.bytes);
  const partialAbortController = new AbortController();
  recording.partialAbortController = partialAbortController;
  const signal = AbortSignal.any([
    recording.abortController.signal,
    partialAbortController.signal,
  ]);

  void transcriber.transcribe([pcm], signal).then(
    (text) => {
      if (state.voice === recording && recording.phase === "recording" && !signal.aborted) {
        sendEvent(state, "voice.partial", { text });
      }
    },
    (error: unknown) => {
      if (
        state.voice === recording &&
        recording.phase === "recording" &&
        !signal.aborted &&
        !isExpectedPartialFailure(error)
      ) {
        sendEvent(state, "voice.error", {
          error: {
            code: "partial_transcription_unavailable",
            message: "Live dictation preview is temporarily unavailable",
          },
        });
      }
    },
  ).finally(() => {
    pcm.fill(0);
    recording.partialInFlight = false;
    if (recording.partialAbortController === partialAbortController) {
      recording.partialAbortController = null;
    }
  });
}

class EventHub {
  private readonly states = new Set<SocketState>();
  private timer: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly client: T3Client,
    private readonly config: BridgeConfig,
  ) {}

  add(socket: WebSocket): SocketState {
    const state: SocketState = {
      nativeFaceclaw: false,
      refinement: null,
      socket,
      subscriptions: new Set(),
      shellSequence: null,
      threadSequences: new Map(),
      alive: true,
      voice: null,
    };
    this.states.add(state);
    if (this.timer === null) {
      this.timer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
      this.timer.unref();
    }
    sendEvent(state, "bridge.status", { status: "connected", protocol: WS_PROTOCOL });
    return state;
  }

  phoneChanged(snapshot: PhoneSnapshot): void {
    for (const state of this.states) {
      const recording = state.voice;
      if (recording?.phoneKey && (!snapshot.connected || !snapshot.notifications.some(item => item.key === recording.phoneKey))) {
        recording.abortController.abort();
        wipeRecording(recording);
        state.voice = null;
      }
      sendEvent(state, "phone.changed", snapshot);
    }
  }

  archiveStatus(status: ArchiveStatus): void {
    for (const state of this.states) sendEvent(state, "archive.status", status);
  }

  remove(state: SocketState): void {
    state.refinement?.abort();
    if (state.voice !== null) {
      state.voice.abortController.abort();
      wipeRecording(state.voice);
      state.voice = null;
    }
    this.states.delete(state);
    if (this.states.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  heartbeat(): void {
    for (const state of this.states) {
      if (!state.alive) {
        state.socket.terminate();
        continue;
      }
      state.alive = false;
      state.socket.ping();
    }
  }

  async subscribe(state: SocketState, threadId: string): Promise<void> {
    if (state.subscriptions.size >= MAX_WS_SUBSCRIPTIONS && !state.subscriptions.has(threadId)) {
      throw new ApiError(400, "subscription_limit", "Too many session subscriptions");
    }
    const shell = await this.client.shell();
    findThread(shell, threadId, this.config);
    const snapshot = await this.client.thread(threadId);
    if (snapshot.thread.id !== threadId) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    state.subscriptions.add(threadId);
    state.threadSequences.set(threadId, snapshot.snapshotSequence);
  }

  unsubscribe(state: SocketState, threadId: string): void {
    state.subscriptions.delete(threadId);
    state.threadSequences.delete(threadId);
  }

  private async poll(): Promise<void> {
    if (this.polling || this.states.size === 0) return;
    this.polling = true;
    try {
      const shell = await this.client.shell();
      for (const state of this.states) {
        if (state.shellSequence !== shell.snapshotSequence) {
          state.shellSequence = shell.snapshotSequence;
          sendEvent(state, "sessions.changed", normalizeSessions(shell, this.config));
        }
      }
      const threadIds = new Set<string>();
      for (const state of this.states) {
        for (const threadId of state.subscriptions) threadIds.add(threadId);
      }
      await Promise.all(
        [...threadIds].map(async (threadId) => {
          try {
            findThread(shell, threadId, this.config);
            const snapshot = await this.client.thread(threadId);
            for (const state of this.states) {
              if (
                state.subscriptions.has(threadId) &&
                state.threadSequences.get(threadId) !== snapshot.snapshotSequence
              ) {
                state.threadSequences.set(threadId, snapshot.snapshotSequence);
                sendEvent(
                  state,
                  "transcript.changed",
                  {
                    threadId,
                    snapshotId: String(snapshot.snapshotSequence),
                  },
                );
              }
            }
          } catch {
            for (const state of this.states) {
              if (state.subscriptions.delete(threadId)) {
                state.threadSequences.delete(threadId);
                sendEvent(state, "subscription.error", {
                  threadId,
                  error: { code: "session_unavailable", message: "Session is unavailable" },
                });
              }
            }
          }
        }),
      );
    } catch {
      for (const state of this.states) {
        sendEvent(state, "bridge.status", { status: "upstream-unavailable" });
      }
    } finally {
      this.polling = false;
    }
  }
}

async function startThread(
  client: T3Client,
  config: BridgeConfig,
  projectId: string,
  text: string,
  selection: T3NewSessionSelection,
) {
  const shell = await client.shell();
  const project = findProject(shell, projectId, config);
  const threadId = randomUUID();
  const result = await client.startSession({
    project,
    threadId,
    text,
    // All new app sessions use the owner's full-access policy, including
    // their first turn. Existing-thread sends retain the thread's own mode.
    runtimeMode: "full-access",
    selection,
  });
  return { threadId, text, sequence: result.sequence };
}

async function sendTurn(
  client: T3Client,
  config: BridgeConfig,
  threadId: string,
  text: string,
  controls: { interactionMode?: "default" | "plan"; reasoningId?: string } = {},
) {
  const thread = await freshAllowedThread(client, config, threadId);
  requireIdleSession(thread);
  const result = await client.sendMessage({ thread, text, ...controls });
  return { threadId, text, sequence: result.sequence };
}

async function steerTurn(
  client: T3Client,
  config: BridgeConfig,
  threadId: string,
  text: string,
) {
  const shell = await client.shell();
  const thread = findThread(shell, threadId, config);
  if (thread.session?.status !== "running" && thread.session?.status !== "starting") {
    throw new ApiError(409, "session_not_running", "The session is no longer running");
  }
  const result = await client.steerMessage({ thread, text });
  return { threadId, text, sequence: result.sequence };
}

function requireSettleableThread(thread: T3ThreadShell): void {
  const status = thread.session === null ? "idle" : thread.session?.status;
  if (status === "running" || status === "starting" ||
      thread.latestTurn?.state === "running" || thread.hasPendingUserInput === true ||
      thread.session?.activeTurnId != null) {
    throw new ApiError(409, "session_busy", "Wait for the current turn and pending input to finish");
  }
  if (typeof status !== "string" || !["idle", "ready", "interrupted", "stopped", "error"].includes(status) ||
      (thread.latestTurn !== null && !["completed", "interrupted", "error"].includes(thread.latestTurn?.state)) ||
      (thread.hasPendingUserInput !== undefined && typeof thread.hasPendingUserInput !== "boolean")) {
    throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid session state");
  }
}

async function routeRpc(
  request: RpcRequest,
  state: SocketState,
  config: BridgeConfig,
  client: T3Client,
  transcriber: Transcriber,
  events: EventHub,
  services: BridgeServiceRegistry,
  phone: PhoneService,
  controls: SessionControlsService,
): Promise<unknown> {
  switch (request.method) {
    case "phone.pairing.create": return phone.createPairing();
    case "phone.apps.list":
    case "phone.notifications.list": return phone.snapshot();
    case "phone.apps.setEnabled": return phone.setEnabled(request.params);
    case "phone.notifications.reply": return phone.command("reply", request.params);
    case "phone.notifications.dismiss": return phone.command("dismiss", request.params);
    case "sessions.list":
      return normalizeSessions(await client.shell(), config);
    case "projects.list": {
      const snapshot = await client.shell();
      return {
        snapshotId: String(snapshot.snapshotSequence),
        projects: normalizeProjects(snapshot, config),
      };
    }
    case "models.list": {
      return flattenModelCatalog(await client.modelCatalog());
    }
    case "transcript.get": {
      const threadId = requiredId(request.params, "threadId");
      const shell = await client.shell();
      const allowed = findThread(shell, threadId, config);
      findProject(shell, allowed.projectId, config);
      const snapshot = await client.thread(threadId);
      if (snapshot.thread.id !== threadId || snapshot.thread.projectId !== allowed.projectId) {
        throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
      }
      await events.subscribe(state, threadId);
      const projectTitle =
        shell.projects.find((project) => project.id === snapshot.thread.projectId)?.title ??
        "Unknown project";
      return normalizeTranscript(snapshot, projectTitle);
    }
    case "transcript.unsubscribe": {
      const threadId = requiredId(request.params, "threadId");
      if (Object.keys(request.params).some((key) => key !== "threadId")) {
        throw new ApiError(400, "invalid_request", "Unsubscribe accepts only threadId");
      }
      events.unsubscribe(state, threadId);
      return { threadId, unsubscribed: true };
    }
    case "assistant.start":
    case "thread.start": {
      // Keep assistant requests strict; new-session permissions are selected
      // by the server, never supplied by the client.
      if (request.method === "assistant.start" && Object.keys(request.params).some(
        (key) => !["projectId", "modelSelection", "text"].includes(key),
      )) {
        throw new ApiError(400, "invalid_request", "Assistant creation accepts only projectId, modelSelection, and text");
      }
      const projectId = requiredId(request.params, "projectId");
      const selection = parseModelSelection(request.params);
      return startThread(
        client,
        config,
        projectId,
        parseText(request.params, config.maxTextChars),
        selection,
      );
    }
    case "thread.settle": {
      const threadId = requiredId(request.params, "threadId");
      if (Object.keys(request.params).some((key) => key !== "threadId")) {
        throw new ApiError(400, "invalid_request", "Settlement accepts only threadId");
      }
      const shell = await client.shell();
      const allowed = findThread(shell, threadId, config);
      findProject(shell, allowed.projectId, config);
      requireSettleableThread(allowed);
      if ((await client.descriptor()).capabilities.threadSettlement !== true) {
        throw new ApiError(502, "upstream_incompatible", "T3 Code does not support session settlement");
      }
      const snapshot = await client.thread(threadId);
      if (snapshot.thread.id !== threadId || snapshot.thread.projectId !== allowed.projectId) {
        throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
      }
      if (snapshot.thread.archivedAt !== null) {
        throw new ApiError(404, "not_found", "Session not found");
      }
      requireSettleableThread(snapshot.thread);
      const result = await client.settleThread(threadId);
      return { threadId, settled: true, sequence: result.sequence };
    }
    case "thread.model.set": return controls.setModel(request.params);
    case "thread.reasoning.set": return controls.setReasoning(request.params);
    case "turn.send": {
      const threadId = requiredId(request.params, "threadId");
      if (Object.keys(request.params).some((key) => !["threadId", "text", "interactionMode", "reasoningId"].includes(key)) ||
          (request.params.interactionMode !== undefined && request.params.interactionMode !== "default" && request.params.interactionMode !== "plan") ||
          (request.params.reasoningId !== undefined && (typeof request.params.reasoningId !== "string" || !isSafeId(request.params.reasoningId)))) {
        throw new ApiError(400, "invalid_request", "Invalid turn controls");
      }
      return sendTurn(client, config, threadId, parseText(request.params, config.maxTextChars), {
        ...(request.params.interactionMode !== undefined ? { interactionMode: request.params.interactionMode } : {}),
        ...(request.params.reasoningId !== undefined ? { reasoningId: request.params.reasoningId as string } : {}),
      });
    }
    case "turn.steer": {
      if (Object.keys(request.params).some((key) => !["threadId", "text"].includes(key))) {
        throw new ApiError(400, "invalid_request", "Active turns cannot change mode or reasoning");
      }
      const threadId = requiredId(request.params, "threadId");
      return steerTurn(client, config, threadId, parseText(request.params, config.maxTextChars));
    }
    case "voice.start": {
      let phoneKey: string | null = null;
      if (request.params.source !== undefined) {
        if (request.params.source !== "phone" || typeof request.params.key !== "string" || request.params.key.length > 256) {
          throw new ApiError(400, "invalid_request", "Invalid voice source");
        }
        const snapshot = phone.snapshot();
        if (!snapshot.connected || !snapshot.notifications.some(item => item.key === request.params.key)) {
          throw new ApiError(409, "phone_unavailable", "Phone notification is unavailable");
        }
        phoneKey = request.params.key;
      }
      if (state.voice !== null) {
        throw new ApiError(409, "voice_active", "Dictation is already active");
      }
      state.voice = {
        phoneKey,
        phase: "recording",
        chunks: [],
        bytes: 0,
        abortController: new AbortController(),
        partialAbortController: null,
        partialInFlight: false,
        lastPartialBytes: 0,
        partialTimer: null,
      };
      const recording = state.voice;
      recording.partialTimer = setInterval(
        () => startPartialTranscription(state, recording, transcriber),
        config.whisperPartialIntervalMs,
      );
      recording.partialTimer.unref();
      return {
        maxBytes: config.maxVoiceBytes,
        sampleRate: 16_000,
        channels: 1,
        format: "pcm_s16le",
      };
    }
    case "voice.cancel": {
      const recording = state.voice;
      if (recording === null) return { cancelled: false };
      recording.abortController.abort();
      wipeRecording(recording);
      if (state.voice === recording) state.voice = null;
      return { cancelled: true };
    }
    case "voice.finish": {
      const recording = state.voice;
      if (recording === null || recording.phase !== "recording") {
        throw new ApiError(409, "voice_not_active", "Dictation is not active");
      }
      recording.phase = "finishing";
      if (recording.partialTimer !== null) {
        clearInterval(recording.partialTimer);
        recording.partialTimer = null;
      }
      recording.partialAbortController?.abort();
      recording.partialAbortController = null;
      try {
        if (recording.bytes < MIN_VOICE_BYTES) {
          throw new ApiError(422, "no_speech", "Dictation is too short");
        }
        if (recording.abortController.signal.aborted) {
          throw new ApiError(409, "voice_cancelled", "Dictation was cancelled");
        }
        const text = await transcriber.transcribe(
          recording.chunks,
          recording.abortController.signal,
        );
        if (recording.abortController.signal.aborted) {
          throw new ApiError(409, "voice_cancelled", "Dictation was cancelled");
        }
        if (!text.trim()) throw new ApiError(422, "no_speech", "No speech was detected");
        return { text: text.trim() };
      } finally {
        wipeRecording(recording);
        if (state.voice === recording) state.voice = null;
      }
    }
    default:
      return services.dispatch(request.method, request.params);
  }
}

async function routeHttp(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
  client: T3Client,
  pairingLimiter: FixedWindowRateLimiter,
  archive: AssistantArchive,
  phone: PhoneService,
): Promise<number> {
  const url = new URL(request.url ?? "/", "http://bridge.invalid");
  const path = url.pathname;

  // Native API is isolated from browser origin exemptions and full bridge credentials.
  if (path.startsWith("/v1/phone/")) {
    if (request.headers.origin !== undefined || request.method !== "POST" || url.search) {
      throw new ApiError(403, "native_only", "Native phone endpoint required");
    }
    if (path === "/v1/phone/pair") {
      if (!pairingLimiter.allow(clientKey(request))) throw new ApiError(429, "pairing_failed", "Pairing failed");
      sendJson(response, 200, phone.pair(await readPairingBody(request)));
      return 200;
    }
    if (!phone.authenticated(bearerToken(request))) throw new ApiError(401, "unauthorized", "Authentication required");
    if (path === "/v1/phone/sync") {
      sendJson(response, 200, phone.sync(await readJsonBody(request, 256 * 1024)));
      return 200;
    }
    throw new ApiError(404, "not_found", "Route not found");
  }

  if (request.method === "OPTIONS") {
    if (!originAllowed(request, config)) {
      throw new ApiError(403, "origin_denied", "Origin is not allowed");
    }
    response.writeHead(204, {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    });
    response.end();
    return 204;
  }

  if (request.method === "GET" && path === "/health") {
    sendJson(response, 200, { status: "ok" });
    return 200;
  }

  if (!originAllowed(request, config)) {
    throw new ApiError(403, "origin_denied", "Origin is not allowed");
  }

  if (request.method === "POST" && path === "/v1/pair") {
    if (!pairingLimiter.allow(clientKey(request))) {
      throw new ApiError(429, "pairing_failed", "Pairing failed");
    }
    let body: Record<string, unknown>;
    try {
      body = await readPairingBody(request);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) throw error;
      throw new ApiError(401, "pairing_failed", "Pairing failed");
    }
    const passphrase =
      Object.keys(body).length === 1 &&
      typeof body.passphrase === "string" &&
      body.passphrase.length > 0 &&
      body.passphrase.length <= 256
        ? body.passphrase
        : undefined;
    if (!pairingPassphraseMatches(passphrase, config.bridgePassphrase)) {
      throw new ApiError(401, "pairing_failed", "Pairing failed");
    }
    sendJson(response, 200, { token: config.bridgeToken });
    return 200;
  }

  if (!secretMatches(bearerToken(request), config.bridgeToken)) {
    throw new ApiError(401, "unauthorized", "Authentication required");
  }

  if (request.method === "GET" && path === "/v1/status") {
    const descriptor = await client.descriptor();
    sendJson(response, 200, {
      bridgeVersion: "0.1.0",
      archive: archive.status(),
      t3: {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
      },
    });
    return 200;
  }

  if (request.method === "GET" && path === "/v1/projects") {
    const snapshot = await client.shell();
    sendJson(response, 200, {
      snapshotId: String(snapshot.snapshotSequence),
      projects: normalizeProjects(snapshot, config),
    });
    return 200;
  }

  if (request.method === "GET" && path === "/v1/sessions") {
    sendJson(response, 200, normalizeSessions(await client.shell(), config));
    return 200;
  }

  const transcriptMatch = /^\/v1\/sessions\/([^/]+)\/transcript$/.exec(path);
  if (request.method === "GET" && transcriptMatch !== null) {
    const threadId = parsePathId(transcriptMatch[1]);
    const shell = await client.shell();
    findThread(shell, threadId, config);
    const snapshot = await client.thread(threadId);
    if (snapshot.thread.id !== threadId) {
      throw new ApiError(502, "upstream_invalid_response", "T3 Code returned an invalid response");
    }
    const projectTitle =
      shell.projects.find((project) => project.id === snapshot.thread.projectId)?.title ??
      "Unknown project";
    sendJson(response, 200, normalizeTranscript(snapshot, projectTitle));
    return 200;
  }

  if (request.method === "POST" && path === "/v1/sessions") {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const result = await startThread(
      client,
      config,
      requiredId(body, "projectId"),
      parseText(body, config.maxTextChars),
      parseModelSelection(body),
    );
    sendJson(response, 201, result);
    return 201;
  }

  const messageMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path);
  if (request.method === "POST" && messageMatch !== null) {
    const result = await sendTurn(
      client,
      config,
      parsePathId(messageMatch[1]),
      parseText(await readJsonBody(request, config.maxBodyBytes), config.maxTextChars),
    );
    sendJson(response, 202, result);
    return 202;
  }

  throw new ApiError(404, "not_found", "Route not found");
}

export function createBridgeServer(
  config: BridgeConfig,
  client: T3Client,
  transcriber: Transcriber,
): Server {
  const signal = SignalHttp.create(config);
  const nativeToken = faceclawToken(config.bridgeToken);
  // Session tool credentials intentionally die with the bridge process, so old
  // MCP request IDs cannot be replayed after the in-memory receipts are lost.
  const toolSecret = randomUUID();
  const providerGrants = new FaceclawProviderGrants(config, client, toolSecret);
  const relay = new FaceclawRelay(config.faceclawProjectId);
  const refinement = new RefinementService(config.refinementCodexPath);
  const faceclawRpcLimiter = new FixedWindowRateLimiter(600);
  const limiter = new FixedWindowRateLimiter(config.rateLimitPerMinute);
  const pairingLimiter = new FixedWindowRateLimiter(
    PAIRING_ATTEMPTS_PER_WINDOW,
    PAIRING_WINDOW_MS,
  );
  const events = new EventHub(client, config);
  const phone = new PhoneService(config.bridgeToken, (snapshot) => events.phoneChanged(snapshot), 6000, 10_000, async () => {
    // Native wake relays receive no titles, transcripts, project paths or T3 action authority.
    return normalizeSessions(await client.shell(), config).unsettled;
  });
  const phoneLimiter = new FixedWindowRateLimiter(240);
  const archive = new AssistantArchive(config, client, (status) => events.archiveStatus(status));
  const weather = new WeatherService();
  const plan = new PlanInputService(client, config);
  const controls = new SessionControlsService(client, config);
  // Services are explicitly composed here, never chosen by a client URL,
  // module path, or configuration supplied over the wire.
  const services = new BridgeServiceRegistry([
    { namespace: "plan", methods: { submit: (params) => plan.submit(params), approve: (params) => controls.approve(params) } },
    {
      namespace: "weather",
      methods: {
        locations: (params) => weather.locations(params),
        current: (params) => weather.current(params),
      },
    },
  ]);
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_WS_FRAME_BYTES,
    handleProtocols(protocols) {
      return protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false;
    },
  });

  const server = createServer((request, response) => {
    const requestId = safeRequestId();
    applySecurityHeaders(request, response, config);
    response.setHeader("X-Request-Id", requestId);
    let status = 500;
    void (async () => {
      try {
        const isPhoneSync = request.url === "/v1/phone/sync";
        if (!(isPhoneSync ? phoneLimiter : limiter).allow(clientKey(request))) {
          throw new ApiError(429, "rate_limited", "Too many requests");
        }
        const url = new URL(request.url ?? '/', 'http://bridge.invalid');
        if (signal) {
          const handled = await signal.handle(request, response, url);
          if (handled !== null) { status = handled; return; }
        }
        if (url.pathname.startsWith('/v1/faceclaw/')) {
          if (request.headers.origin !== undefined || request.method !== 'POST' || url.search) {
            throw new ApiError(403, 'native_only', 'Native Faceclaw endpoint required');
          }
          if (url.pathname === '/v1/faceclaw/pair') {
            if (!pairingLimiter.allow(clientKey(request))) throw new ApiError(429, 'pairing_failed', 'Pairing failed');
            const body = await readPairingBody(request);
            if (Object.keys(body).length !== 1 || typeof body.passphrase !== 'string' || !pairingPassphraseMatches(body.passphrase, config.bridgePassphrase)) {
              throw new ApiError(401, 'pairing_failed', 'Pairing failed');
            }
            sendJson(response, 200, { token: nativeToken }); status = 200; return;
          }
          if (url.pathname === '/v1/faceclaw/tool-credential') {
            // Owner-only provisioning. Native phone and MCP credentials cannot mint capabilities.
            if (!secretMatches(bearerToken(request), config.bridgeToken)) throw new ApiError(401, 'unauthorized', 'Owner credential required');
            const body = await readJsonBody(request, 2048);
            const threadId = requiredId(body, 'threadId');
            const shell = await client.shell();
            const thread = findThread(shell, threadId, config);
            if (!config.faceclawProjectId || thread.projectId !== config.faceclawProjectId) throw new ApiError(403, 'tool_scope_denied', 'Assistant project is not enabled');
            findProject(shell, thread.projectId, config);
            const binding = { projectId: thread.projectId, threadId, expiresAt: Date.now() + 60 * 60_000 };
            sendJson(response, 200, { ...binding, token: mintToolToken(toolSecret, binding) }); status = 200; return;
          }
          if (url.pathname === '/v1/faceclaw/provider-session') {
            sendJson(response, 200, await providerGrants.issue(bearerToken(request), await readJsonBody(request, 8192))); status = 200; return;
          }
          if (url.pathname === '/v1/faceclaw/provider-renew' || url.pathname === '/v1/faceclaw/provider-revoke') {
            const binding = verifyToolToken(toolSecret, bearerToken(request), config.faceclawProjectId);
            const body = await readJsonBody(request, 1024);
            const result = url.pathname.endsWith('-renew') ? providerGrants.renew(binding, body.leaseToken) : providerGrants.revoke(binding, body.leaseToken);
            sendJson(response, 200, result); status = 200; return;
          }
          if (url.pathname === '/v1/faceclaw/mcp') {
            const binding = verifyToolToken(toolSecret, bearerToken(request), config.faceclawProjectId);
            const shell = await client.shell();
            if (binding.providerSessionId) providerGrants.validate(binding);
            else {
              const thread = findThread(shell, binding.threadId!, config);
              if (thread.projectId !== binding.projectId) throw new ApiError(403, 'tool_scope_denied', 'Assistant project is not enabled');
            }
            findProject(shell, binding.projectId, config);
            const body = await readJsonBody(request, 16 * 1024);
            if (body.jsonrpc !== '2.0' || typeof body.method !== 'string' ||
                (body.id !== undefined && !(typeof body.id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(body.id)) && !(typeof body.id === 'number' && Number.isSafeInteger(body.id)))) {
              throw new ApiError(400, 'invalid_request', 'Invalid MCP request');
            }
            if (body.method === 'notifications/initialized' && body.id === undefined) { response.writeHead(202); response.end(); status = 202; return; }
            if (body.id === undefined) throw new ApiError(400, 'invalid_request', 'MCP request ID required');
            let result: unknown;
            try {
              if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'faceclaw-t3', version: '1.0.0' } };
              else if (body.method === 'ping') result = {};
              else if (body.method === 'tools/list') result = relay.list();
              else if (body.method === 'tools/call') {
                if (!body.params || typeof body.params !== 'object' || Array.isArray(body.params)) throw new ApiError(400, 'invalid_request', 'Invalid tool call');
                result = await relay.call(binding, String(body.id), body.params as Record<string, unknown>);
              } else throw new ApiError(404, 'method_not_found', 'MCP method not found');
              sendJson(response, 200, { jsonrpc: '2.0', id: body.id, result });
            } catch (error) {
              const safe = error instanceof ApiError ? error : new ApiError(500, 'internal_error', 'Tool request failed');
              sendJson(response, 200, { jsonrpc: '2.0', id: body.id, error: { code: -32000, message: safe.message, data: { code: safe.code } } });
            }
            status = 200; return;
          }
          throw new ApiError(404, 'not_found', 'Route not found');
        }
        status = await routeHttp(request, response, config, client, pairingLimiter, archive, phone);
      } catch (error) {
        if (response.headersSent || response.destroyed) return;
        const safe =
          error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "The bridge could not complete the request");
        status = safe.status;
        // Temporary, rejection-only pairing diagnostics. Do not log other headers,
        // request bodies, raw URLs, or any authentication material.
        if (
          safe.code === "origin_denied" &&
          (request.method === "OPTIONS" || request.method === "POST") &&
          new URL(request.url ?? "/", "http://bridge.invalid").pathname === "/v1/pair"
        ) {
          process.stdout.write(`${JSON.stringify({
            level: "info",
            event: "pairing_origin_denied",
            requestId,
            method: request.method,
            path: "/v1/pair",
            status,
            reason: "origin_denied",
            origin: diagnosticOrigin(request.headers.origin),
            at: new Date().toISOString(),
          })}\n`);
        }
        if (safe.status === 401) response.setHeader("WWW-Authenticate", "Bearer");
        sendJson(response, safe.status, {
          error: { code: safe.code, message: safe.message },
          requestId,
        });
      } finally {
        if (request.url !== "/v1/phone/sync") logRequest(
          requestId,
          request.method ?? "UNKNOWN",
          request.url?.split("?", 1)[0] ?? "/",
          status,
        );
      }
    })();
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://bridge.invalid");
    const native = url.pathname === '/v1/faceclaw/events';
    if (
      (native ? request.headers.origin !== undefined || !!url.search : url.pathname !== "/v1/events" || !originAllowed(request, config)) ||
      !limiter.allow(clientKey(request)) ||
      !secretMatches(websocketToken(request), native ? nativeToken : config.bridgeToken)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const protocols = request.headers["sec-websocket-protocol"];
    if (
      typeof protocols !== "string" ||
      !protocols
        .split(",")
        .map((value) => value.trim())
        .includes(WS_PROTOCOL)
    ) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  });

  websocketServer.on("connection", (socket, handshake) => {
    const state = events.add(socket);
    state.nativeFaceclaw = new URL(handshake.url ?? '/', 'http://bridge.invalid').pathname === '/v1/faceclaw/events';
    sendEvent(state, "archive.status", archive.status());
    sendEvent(state, "phone.changed", phone.snapshot());
    socket.on("pong", () => {
      state.alive = true;
    });
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        const recording = state.voice;
        if (recording === null || recording.phase !== "recording") {
          sendEvent(state, "voice.error", {
            error: { code: "voice_not_active", message: "Dictation is not active" },
          });
          return;
        }
        const chunk = rawDataBuffer(data);
        if (chunk.byteLength === 0 || chunk.byteLength % 2 !== 0) {
          chunk.fill(0);
          sendEvent(state, "voice.error", {
            error: { code: "invalid_audio", message: "Audio frame must contain 16-bit PCM" },
          });
          return;
        }
        if (recording.bytes + chunk.byteLength > config.maxVoiceBytes) {
          chunk.fill(0);
          recording.abortController.abort();
          wipeRecording(recording);
          state.voice = null;
          sendEvent(state, "voice.error", {
            error: { code: "audio_too_large", message: "Dictation reached its time limit" },
          });
          return;
        }
        recording.chunks.push(chunk);
        recording.bytes += chunk.byteLength;
        return;
      }

      const textData = rawDataBuffer(data);
      if (textData.byteLength > (state.nativeFaceclaw ? MAX_WS_FRAME_BYTES : MAX_WS_JSON_BYTES)) {
        socket.close(1009, "Request is too large");
        return;
      }
      let request: RpcRequest;
      try {
        request = parseRpcRequest(textData.toString("utf8"));
      } catch (error) {
        sendRpcError(state, "invalid", error);
        return;
      }
      const dispatch = async (): Promise<unknown> => {
        if (state.nativeFaceclaw && request.method !== 'refinement.cancel' && !['faceclaw.tools.result','faceclaw.capabilities.result'].includes(request.method) && !faceclawRpcLimiter.allow(clientKey(handshake))) {
          throw new ApiError(429, 'rate_limited', 'Too many Faceclaw requests');
        }
        if (request.method.startsWith('faceclaw.') || request.method.startsWith('refinement.')) {
          if (!state.nativeFaceclaw) throw new ApiError(403, 'native_only', 'Faceclaw connection required');
          switch (request.method) {
            case 'faceclaw.tools.register': return relay.register(state, request.params, payload => sendEvent(state, 'faceclaw.tool.call', payload));
            case 'faceclaw.tools.result': return relay.result(state, request.params);
            case 'faceclaw.capabilities.register': return relay.register(state, request.params, payload => sendEvent(state, 'faceclaw.capability.call', payload), true);
            case 'faceclaw.capabilities.result': return relay.result(state, request.params);
            case 'refinement.cancel': {
              const cancelled = state.refinement !== null;
              state.refinement?.abort();
              return { cancelled };
            }
            case 'refinement.rewrite': {
              if (state.refinement) throw new ApiError(409, 'refinement_busy', 'Refinement is already in progress');
              const abort = new AbortController(); state.refinement = abort;
              try { return await refinement.rewrite(request.params, abort.signal); }
              finally { if (state.refinement === abort) state.refinement = null; }
            }
            default: throw new ApiError(404, 'method_not_found', 'Method not found');
          }
        }
        return routeRpc(request, state, config, client, transcriber, events, services, phone, controls);
      };
      void dispatch().then(
        (result) => sendRpcResult(state, request.id, result),
        (error: unknown) => sendRpcError(state, request.id, error),
      );
    });
    socket.on("close", () => { relay.disconnect(state); events.remove(state); });
  });

  const heartbeat = setInterval(() => events.heartbeat(), 30_000);
  heartbeat.unref();
  server.once("listening", () => archive.start());
  server.once('listening', () => signal?.start());
  server.on("close", () => {
    signal?.close();
    archive.stop();
    phone.close();
    clearInterval(heartbeat);
    websocketServer.close();
  });

  return server;
}
