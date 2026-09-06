import { createHash, createHmac, randomBytes } from 'node:crypto';
import { ApiError, secretMatches } from './security.js';
import { WakeRelay, type WakeSession } from './wake-relay.js';

export interface PhoneApp { packageName: string; name: string; replyObserved: boolean; enabled: boolean }
export interface PhoneNotification {
  key: string; revision: string; packageName: string; appName: string; title: string;
  text: string; arrivedAt: number; replyable: true; sender?: string; thread?: string;
}
export interface PhoneSnapshot {
  connected: boolean; permissionGranted: boolean; apps: PhoneApp[]; notifications: PhoneNotification[];
}
type Status = 'handed_off' | 'dismissed' | 'failed' | 'unavailable' | 'unknown';
interface Result { id: string; status: Status }
interface Command { id: string; issuedAt: number; expiresAt: number; operation: 'reply' | 'dismiss'; key: string; revision: string; text?: string }
interface Pending { command: Command; resolve: (result: Result) => void; timer: ReturnType<typeof setTimeout>; delivered: boolean }
interface Remembered { fingerprint: string; promise: Promise<Result>; expiresAt: number }
const STATUSES = new Set<unknown>(['handed_off', 'dismissed', 'failed', 'unavailable', 'unknown']);
const PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMAND_ID = /^(\d{13})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const COMMAND_LIFETIME_MS = 30_000;
const CLOCK_SKEW_MS = 5000;
function invalid(): never { throw new ApiError(400, 'invalid_phone_data', 'Invalid phone data'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function str(value: unknown, max: number, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) invalid();
  return value;
}
function packageName(value: unknown): string {
  const result = str(value, 256);
  if (!PACKAGE.test(result)) invalid();
  return result;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) invalid();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') invalid(); return value; }
function unique<T>(values: T[], key: (value: T) => string): T[] {
  if (new Set(values.map(key)).size !== values.length) invalid();
  return values;
}

/** Native input is untrusted. Only normalized data reaches glasses; no content persists or is logged. */
export class PhoneService {
  private readonly token: string;
  private pairing: { code: string; expiresAt: number } | null = null;
  private state: PhoneSnapshot = { connected: false, permissionGranted: false, apps: [], notifications: [] };
  private enabled: Set<string> | null = null;
  private lastSync = 0;
  private commandClock = Date.now();
  private readonly pending = new Map<string, Pending>();
  private readonly remembered = new Map<string, Remembered>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly wakeRelay = new WakeRelay();
  private wakeRelayEnabled = false;
  private wakePolling = false;
  constructor(bridgeToken: string, private readonly changed: (snapshot: PhoneSnapshot) => void,
    private readonly disconnectMs = 6000, private readonly commandMs = 10_000,
    private readonly wakeSessions?: () => Promise<readonly WakeSession[]>) {
    // Domain separation: possession of a native token cannot authenticate browser/T3 routes.
    this.token = createHmac('sha256', bridgeToken).update('even-phone-native-v1').digest('base64url');
    this.timer = setInterval(() => { this.checkConnection(); void this.pollWake(); }, Math.min(disconnectMs, 1000));
    this.timer.unref();
  }
  authenticated(token: string | undefined): boolean { return secretMatches(token, this.token); }
  createPairing(): { code: string; expiresAt: number } {
    this.pairing = { code: randomBytes(12).toString('base64url'), expiresAt: Date.now() + 300_000 };
    return { ...this.pairing };
  }
  pair(body: Record<string, unknown>): { token: string } {
    const code = typeof body.code === 'string' && body.code.length <= 256 ? body.code : undefined;
    if (Object.keys(body).length !== 1 || !this.pairing || this.pairing.expiresAt < Date.now() || !secretMatches(code, this.pairing.code)) {
      throw new ApiError(401, 'pairing_failed', 'Pairing failed');
    }
    this.pairing = null;
    return { token: this.token };
  }
  snapshot(): PhoneSnapshot { return structuredClone(this.state); }
  private publish(next: PhoneSnapshot): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    if (changed) this.changed(this.snapshot());
  }
  private commandNow(): number {
    // A backwards clock adjustment cannot resurrect an ID whose receipt was pruned.
    this.commandClock = Math.max(this.commandClock, Date.now());
    return this.commandClock;
  }
  private pruneReceipts(now: number): void {
    for (const [id, receipt] of this.remembered) {
      if (receipt.expiresAt + CLOCK_SKEW_MS < now && !this.pending.has(id)) this.remembered.delete(id);
    }
  }
  private checkConnection(): void {
    this.pruneReceipts(this.commandNow());
    if (this.state.connected && Date.now() - this.lastSync >= this.disconnectMs) {
      this.wakeRelay.reset();
      this.publish({ ...this.state, connected: false });
      for (const id of this.pending.keys()) this.finish(id, 'unknown');
    }
  }
  private async pollWake(): Promise<void> {
    if (this.wakePolling || !this.wakeRelayEnabled || !this.state.connected || !this.wakeSessions) return;
    this.wakePolling = true;
    const generation = this.wakeRelay.generation;
    try {
      const sessions = await this.wakeSessions();
      // An in-flight read must not cross disconnect, opt-out or baseline reset.
      this.checkConnection();
      if (this.wakeRelayEnabled && this.state.connected && this.wakeRelay.generation === generation) this.wakeRelay.sessions(sessions);
    } catch { if (this.wakeRelay.generation === generation) this.wakeRelay.resetSessions(); }
    finally { this.wakePolling = false; }
  }
  sync(body: Record<string, unknown>) {
    if (body.v !== 1) invalid();
    const permissionGranted = boolean(body.permissionGranted);
    const wakeRelayEnabled = body.wakeRelayEnabled === undefined ? false : boolean(body.wakeRelayEnabled);
    const enabled = unique(list(body.enabledPackages, 2048).map(packageName), value => value);
    const apps = unique(list(body.apps, 2048).map(value => {
      const app = object(value);
      const name = packageName(app.packageName);
      return { packageName: name, name: str(app.name, 128, true).trim() || name, replyObserved: boolean(app.replyObserved), enabled: false };
    }), value => value.packageName);
    const packages = new Set(apps.map(app => app.packageName));
    const notifications = unique(list(body.notifications, 100).map(value => {
      const item = object(value);
      if (item.replyable !== true || !Number.isSafeInteger(item.arrivedAt) || (item.arrivedAt as number) < 0 || (item.arrivedAt as number) > Date.now() + 86_400_000) invalid();
      const result: PhoneNotification = {
        key: str(item.key, 256), revision: str(item.revision, 128), packageName: packageName(item.packageName),
        appName: str(item.appName, 128), title: str(item.title, 256, true), text: str(item.text, 4000, true),
        arrivedAt: item.arrivedAt as number, replyable: true,
      };
      if (!packages.has(result.packageName)) invalid();
      if (item.sender !== undefined) result.sender = str(item.sender, 256, true);
      if (item.thread !== undefined) result.thread = str(item.thread, 256, true);
      return result;
    }), value => value.key);
    const results = unique(list(body.results, 32).map(value => {
      const result = object(value);
      const id = str(result.id, 50);
      // Legacy result IDs may drain during an app upgrade; never accepted for new commands.
      if (!(COMMAND_ID.test(id) || UUID.test(id)) || !STATUSES.has(result.status)) invalid();
      return { id, status: result.status as Status };
    }), value => value.id);
    // Complete validation happens before any state change, including result resolution.
    this.checkConnection();
    if (!this.state.connected || this.wakeRelayEnabled !== wakeRelayEnabled) this.wakeRelay.reset();
    this.wakeRelayEnabled = wakeRelayEnabled;
    if (this.state.permissionGranted !== permissionGranted) this.wakeRelay.resetPhone();
    if (this.enabled === null) this.enabled = new Set(enabled.filter(name => packages.has(name)));
    for (const app of apps) app.enabled = this.enabled.has(app.packageName);
    this.lastSync = Date.now();
    this.publish({ connected: true, permissionGranted, apps,
      notifications: permissionGranted ? notifications.filter(item => this.enabled!.has(item.packageName))
        .sort((a, b) => b.arrivedAt - a.arrivedAt || a.key.localeCompare(b.key)) : [] });
    if (this.wakeRelayEnabled) this.wakeRelay.phone(this.state.notifications);
    for (const result of results) {
      const pending = this.pending.get(result.id);
      // Native may only acknowledge an actually delivered command of the proper kind.
      if (!pending?.delivered) continue;
      if (result.status === 'handed_off' && pending.command.operation !== 'reply' ||
          result.status === 'dismissed' && pending.command.operation !== 'dismiss') continue;
      this.finish(result.id, result.status);
    }
    const commands: Command[] = [];
    for (const pending of this.pending.values()) {
      if (pending.delivered) continue;
      const item = this.state.notifications.find(item => item.key === pending.command.key && item.revision === pending.command.revision);
      if (!item || pending.command.expiresAt <= this.commandNow()) { this.finish(pending.command.id, 'unavailable'); continue; }
      pending.delivered = true; // Before HTTP response: a lost response is unknown, never replayed.
      commands.push({ ...pending.command });
    }
    return { v: 1 as const, enabledPackages: [...this.enabled], commands,
      ...(body.wakeRelayEnabled !== undefined ? { wakeEvents: this.wakeRelayEnabled ? this.wakeRelay.drain() : [] } : {}) };
  }
  setEnabled(params: Record<string, unknown>): PhoneSnapshot {
    const name = packageName(params.packageName);
    const enabled = boolean(params.enabled);
    this.checkConnection();
    if (!this.state.connected) throw new ApiError(409, 'phone_disconnected', 'Phone disconnected');
    if (!this.state.apps.some(app => app.packageName === name)) throw new ApiError(404, 'app_unavailable', 'App is unavailable');
    this.wakeRelay.resetPhone();
    if (enabled) this.enabled!.add(name); else this.enabled!.delete(name);
    this.publish({ ...this.state, apps: this.state.apps.map(app => app.packageName === name ? { ...app, enabled } : app),
      notifications: this.state.notifications.filter(item => item.packageName !== name || enabled) });
    if (!enabled) for (const [id, pending] of this.pending) {
      if (!pending.delivered && !this.state.notifications.some(item => item.key === pending.command.key)) this.finish(id, 'unavailable');
    }
    return this.snapshot();
  }
  command(operation: 'reply' | 'dismiss', params: Record<string, unknown>): Promise<Result> {
    const id = str(params.commandId, 50);
    const identity = COMMAND_ID.exec(id);
    if (!identity) invalid();
    const now = this.commandNow();
    const issuedAt = Number(identity[1]);
    const expiresAt = issuedAt + COMMAND_LIFETIME_MS;
    // ID embeds immutable creation time. Replaying it cannot obtain a fresh lease.
    if (issuedAt > now + CLOCK_SKEW_MS || expiresAt <= now) {
      throw new ApiError(409, 'phone_command_expired', 'Phone action expired or device clocks differ. Review and try again.');
    }
    this.pruneReceipts(now);
    const command: Command = { id, issuedAt, expiresAt, operation, key: str(params.key, 256), revision: str(params.revision, 128) };
    if (operation === 'reply') {
      command.text = str(params.text, 4000).trim();
      if (!command.text) invalid();
    }
    const fingerprint = createHash('sha256').update(JSON.stringify(command)).digest('hex');
    const previous = this.remembered.get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ApiError(409, 'command_conflict', 'Command identifier was already used');
      return previous.promise;
    }
    this.checkConnection();
    if (!this.state.connected) throw new ApiError(409, 'phone_disconnected', 'Phone disconnected');
    if (this.pending.size >= 32 || this.remembered.size >= 4096) throw new ApiError(429, 'phone_command_limit', 'Phone command limit reached');
    let resolve!: (result: Result) => void;
    const promise = new Promise<Result>(done => { resolve = done; });
    this.remembered.set(id, { fingerprint, promise, expiresAt });
    const item = this.state.notifications.find(item => item.key === command.key && item.revision === command.revision);
    if (!item) { resolve({ id, status: 'unavailable' }); return promise; }
    // One action per notification at a time, including commands from other glasses clients.
    if ([...this.pending.values()].some(pending => pending.command.key === command.key)) {
      resolve({ id, status: 'failed' }); return promise;
    }
    const timer = setTimeout(() => this.finish(id, 'unknown'), Math.min(this.commandMs, expiresAt - now));
    timer.unref();
    this.pending.set(id, { command, resolve, timer, delivered: false });
    return promise;
  }
  private finish(id: string, status: Status): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    pending.resolve({ id, status });
  }
  close(): void {
    clearInterval(this.timer);
    this.wakeRelayEnabled = false;
    this.wakeRelay.reset();
    for (const id of this.pending.keys()) this.finish(id, 'unknown');
    this.state = { connected: false, permissionGranted: false, apps: [], notifications: [] };
  }
}
