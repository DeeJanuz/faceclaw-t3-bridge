import { createHmac, randomUUID } from 'node:crypto';
import { ApiError, isSafeId, secretMatches } from './security.js';

export function faceclawToken(secret: string): string {
  return createHmac('sha256', secret).update('faceclaw-native-v1').digest('base64url');
}

export interface ToolBinding { projectId: string; threadId?: string; providerSessionId?: string; bindingKind?: 'provider-session'; expiresAt: number }
export function launcherToken(secret: string, projectId: string): string {
  return createHmac('sha256', secret).update(`faceclaw-launcher-v1:${projectId}`).digest('base64url');
}
export function mintToolToken(secret: string, binding: ToolBinding): string {
  const payload = Buffer.from(JSON.stringify(binding)).toString('base64url');
  return `fc1.${payload}.${createHmac('sha256', secret).update(`faceclaw-tools-v1:${payload}`).digest('base64url')}`;
}
export function verifyToolToken(secret: string, token: string | undefined, projectId: string | undefined, now = Date.now()): ToolBinding {
  const [, payload, signature, extra] = token?.split('.') ?? [];
  if (!token?.startsWith('fc1.') || !payload || payload.length > 1024 || !signature || extra ||
      !secretMatches(signature, createHmac('sha256', secret).update(`faceclaw-tools-v1:${payload}`).digest('base64url'))) {
    throw new ApiError(401, 'unauthorized', 'Tool credential required');
  }
  let value: ToolBinding;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ToolBinding; }
  catch { throw new ApiError(401, 'unauthorized', 'Tool credential required'); }
  const threadBinding = typeof value.threadId === 'string' && isSafeId(value.threadId) && value.providerSessionId === undefined;
  const providerBinding = value.threadId === undefined && typeof value.providerSessionId === 'string' && isSafeId(value.providerSessionId) && value.bindingKind === 'provider-session';
  if (!projectId || value.projectId !== projectId || (!threadBinding && !providerBinding) ||
      !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= now || value.expiresAt > now + 24 * 60 * 60_000) {
    throw new ApiError(403, 'tool_scope_denied', 'Tool credential is expired or out of scope');
  }
  return value;
}

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
type Peer = { id: object; send: (payload: unknown) => void; tools: Tool[] };
type Pending = { peer: object; resolve: (result: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** A single authenticated phone; actions drain once and are never retried. */
export class FaceclawRelay {
  private peer: Peer | null = null;
  private pending = new Map<string, Pending>();
  // Immutable request receipts survive phone disconnects. Fail closed at capacity.
  private receipts = new Set<string>();
  constructor(readonly projectId: string | undefined, private readonly timeoutMs = 30_000) {}

  register(id: object, params: Record<string, unknown>, send: Peer['send']): { registered: true } {
    if (!this.projectId || params.projectId !== this.projectId) throw new ApiError(403, 'tool_scope_denied', 'Assistant project is not enabled');
    if (this.peer && this.peer.id !== id) throw new ApiError(409, 'phone_already_connected', 'Another Faceclaw tool connection is active');
    if (!Array.isArray(params.tools) || params.tools.length > 128 || JSON.stringify(params).length > 48 * 1024) {
      throw new ApiError(400, 'invalid_tools', 'Invalid tool catalog');
    }
    const names = new Set<string>();
    const tools = params.tools.map((item: unknown): Tool => {
      if (!item || typeof item !== 'object') throw new ApiError(400, 'invalid_tools', 'Invalid tool catalog');
      const t = item as Tool;
      if (typeof t.name !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(t.name) || names.has(t.name) ||
          typeof t.description !== 'string' || t.description.length > 2048 || !t.inputSchema ||
          typeof t.inputSchema !== 'object' || Array.isArray(t.inputSchema) || t.inputSchema.type !== 'object') {
        throw new ApiError(400, 'invalid_tools', 'Invalid tool catalog');
      }
      names.add(t.name);
      return { name: t.name, description: t.description, inputSchema: t.inputSchema };
    });
    this.peer = { id, send, tools };
    return { registered: true };
  }
  list(): { tools: Tool[] } { return { tools: this.peer?.tools ?? [] }; }
  async call(binding: ToolBinding, requestId: string, params: Record<string, unknown>): Promise<unknown> {
    const peer = this.peer;
    if (!peer) throw new ApiError(503, 'faceclaw_disconnected', 'Faceclaw is disconnected');
    if (!peer.tools.some(t => t.name === params.name) || !params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
      throw new ApiError(400, 'invalid_tool_call', 'Invalid tool call');
    }
    if (binding.projectId !== this.projectId) throw new ApiError(403, 'tool_scope_denied', 'Assistant project is not enabled');
    if (binding.expiresAt <= Date.now()) throw new ApiError(403, 'tool_scope_denied', 'Tool credential expired');
    if (this.pending.size >= 8 || this.receipts.size >= 100_000) throw new ApiError(429, 'tool_limit', 'Tool capacity reached');
    const receipt = `${binding.providerSessionId ?? binding.threadId}:${requestId}`;
    if (this.receipts.has(receipt)) throw new ApiError(409, 'tool_replay_denied', 'Tool request was already dispatched; do not retry');
    this.receipts.add(receipt);
    const callId = randomUUID();
    const issuedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(callId);
        reject(new ApiError(504, 'tool_result_unknown', 'Tool result is unknown; do not retry'));
      }, this.timeoutMs);
      timer.unref();
      this.pending.set(callId, { peer: peer.id, resolve, reject, timer });
      peer.send({ callId, name: params.name, arguments: params.arguments, ...binding, issuedAt, expiresAt: Math.min(binding.expiresAt, issuedAt + this.timeoutMs) });
    });
  }
  result(id: object, params: Record<string, unknown>): { accepted: true } {
    if (typeof params.callId !== 'string') throw new ApiError(400, 'invalid_tool_result', 'Invalid tool result');
    const pending = this.pending.get(params.callId);
    if (!pending || pending.peer !== id) throw new ApiError(409, 'tool_result_expired', 'Tool call is no longer pending');
    const result = params.result as { content?: unknown; isError?: unknown } | undefined;
    if (!result || !Array.isArray(result.content) || result.content.length > 32 || JSON.stringify(result).length > 48 * 1024 ||
        (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new ApiError(400, 'invalid_tool_result', 'Invalid tool result');
    clearTimeout(pending.timer);
    this.pending.delete(params.callId);
    pending.resolve(result);
    return { accepted: true };
  }
  disconnect(id: object): void {
    if (this.peer?.id === id) this.peer = null;
    for (const [key, item] of this.pending) if (item.peer === id) {
      clearTimeout(item.timer); this.pending.delete(key);
      item.reject(new ApiError(503, 'faceclaw_disconnected', 'Connection dropped; tool result is unknown'));
    }
  }
}
