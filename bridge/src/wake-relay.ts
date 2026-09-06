import { createHash } from 'node:crypto';
import type { PhoneNotification } from './phone.js';

export interface WakeSession {
  id: string; status: string; settled: boolean;
  completedTurn: { id: string; completedAt: string } | null;
}
export interface WakeEvent { id: string; kind: 't3' | 'phone'; issuedAt: number; expiresAt: number }
const LIFETIME = 30_000;
const MAX_EVENTS = 8;
const hash = (parts: readonly unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Ephemeral, baseline-first relay. No contents or identifiers leave as plaintext. */
export class WakeRelay {
  generation = 0;
  private t3: Map<string, string> | null = null;
  private phones: Map<string, string> | null = null;
  private pending: WakeEvent[] = [];
  reset(): void { this.generation++; this.t3 = null; this.phones = null; this.pending = []; }
  resetSessions(): void { this.t3 = null; this.pending = this.pending.filter(event => event.kind !== 't3'); }
  resetPhone(): void { this.phones = null; this.pending = this.pending.filter(event => event.kind !== 'phone'); }
  private add(kind: WakeEvent['kind'], id: string, at: number, now: number): void {
    // Never wake for catch-up history, clock-skewed future data, or duplicate revisions.
    if (!Number.isFinite(at) || at < now - LIFETIME || at > now + 5000) return;
    if (this.pending.some(event => event.id === id)) return;
    this.pending.push({ id, kind, issuedAt: now, expiresAt: now + LIFETIME });
    this.pending = this.pending.filter(event => event.expiresAt > now).slice(-MAX_EVENTS);
  }
  sessions(sessions: readonly WakeSession[], now = Date.now()): void {
    const next = new Map<string, string>();
    const eligibleIds = new Set<string>();
    for (const session of sessions.slice(0, 10_000)) {
      const turn = session.completedTurn;
      if (!turn) continue;
      const id = hash(['t3', session.id, turn.id, turn.completedAt]);
      const eligible = !session.settled && !['running', 'starting'].includes(session.status);
      if (eligible) eligibleIds.add(id);
      // A completion may reach shell metadata just before the provider becomes idle.
      if (eligible || this.t3 === null) next.set(session.id, id);
      else if (this.t3.has(session.id)) next.set(session.id, this.t3.get(session.id)!);
      if (this.t3 !== null && this.t3.get(session.id) !== id && eligible) {
        this.add('t3', id, Date.parse(turn.completedAt), now);
      }
    }
    this.pending = this.pending.filter(event => event.kind !== 't3' || eligibleIds.has(event.id));
    this.t3 = next;
  }
  phone(items: readonly PhoneNotification[], now = Date.now()): void {
    const next = new Map<string, string>();
    for (const item of items) {
      // Action-token changes alone are not a new message.
      const id = hash(['phone', item.key, item.arrivedAt, item.title, item.text, item.sender]);
      next.set(item.key, id);
      if (this.phones !== null && this.phones.get(item.key) !== id) this.add('phone', id, item.arrivedAt, now);
    }
    this.phones = next;
  }
  drain(now = Date.now()): WakeEvent[] {
    const events = this.pending.filter(event => event.expiresAt > now);
    this.pending = []; // Lost HTTP responses are dropped, never resent as a wake storm.
    return events;
  }
}
