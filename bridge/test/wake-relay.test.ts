import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WakeRelay, type WakeSession } from '../src/wake-relay.js';
import type { PhoneNotification } from '../src/phone.js';
const now = 1_800_000_000_000;
const session = (turn = 'turn-1', status = 'idle', at = now): WakeSession => ({ id: 'thread', status, settled: false, completedTurn: { id: turn, completedAt: new Date(at).toISOString() } });
const phone = (text = 'message', revision = '1', at = now): PhoneNotification => ({ key: 'key', revision, packageName: 'app.test', appName: 'App', title: 'private title', text, arrivedAt: at, replyable: true });

test('wake relay baselines history, emits fresh metadata only, drains once, resets on reconnect', () => {
  const relay = new WakeRelay();
  relay.sessions([session()], now); relay.phone([phone()], now);
  assert.deepEqual(relay.drain(now), []);
  relay.sessions([session('turn-2')], now); relay.phone([phone('private body', '2')], now);
  const events = relay.drain(now);
  assert.deepEqual(events.map(event => event.kind), ['t3', 'phone']);
  for (const event of events) {
    assert.match(event.id, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(event), ['id', 'kind', 'issuedAt', 'expiresAt']);
    assert.equal(event.expiresAt - event.issuedAt, 30_000);
  }
  assert.doesNotMatch(JSON.stringify(events), /private|thread|turn-2/);
  assert.deepEqual(relay.drain(now), []);
  relay.sessions([session('turn-2')], now); relay.phone([phone('private body', '3')], now);
  assert.deepEqual(relay.drain(now), []);
  relay.reset(); relay.sessions([session('turn-3')], now); relay.phone([phone('newer')], now);
  assert.deepEqual(relay.drain(now), []);
});

test('wake relay excludes stale/future/settled events and expires a bounded batch', () => {
  const relay = new WakeRelay(); relay.sessions([], now); relay.phone([], now);
  relay.sessions([session('old', 'idle', now - 30_001)], now);
  relay.phone([phone('future', '1', now + 5001)], now);
  relay.sessions([{ ...session('settled'), settled: true }], now);
  assert.deepEqual(relay.drain(now), []);
  relay.phone(Array.from({ length: 20 }, (_, i) => ({ ...phone(String(i)), key: String(i) })), now);
  assert.equal(relay.drain(now).length, 8);
  relay.sessions([session('expires')], now);
  assert.deepEqual(relay.drain(now + 30_000), []);
});

test('a completed turn waits for idle; failures and opt-in changes rebaseline', () => {
  const relay = new WakeRelay(); relay.sessions([session()], now);
  relay.sessions([session('turn-2', 'running')], now);
  assert.deepEqual(relay.drain(now), []);
  relay.sessions([session('turn-2')], now);
  assert.equal(relay.drain(now).length, 1);
  relay.sessions([session('turn-3')], now); relay.resetSessions();
  relay.sessions([session('turn-4')], now);
  relay.phone([], now); relay.phone([phone()], now); relay.resetPhone(); relay.phone([phone('existing')], now);
  assert.deepEqual(relay.drain(now), []);
});


test('an identical message removed and reposted has a new arrival identity', () => {
  const relay = new WakeRelay();
  relay.phone([], now);
  relay.phone([phone()], now);
  const first = relay.drain(now)[0]!;
  relay.phone([phone('message', 'action-token-only')], now);
  assert.deepEqual(relay.drain(now), []);
  relay.phone([], now);
  relay.phone([phone('message', 'new-action', now + 1000)], now + 1000);
  const second = relay.drain(now + 1000)[0]!;
  assert.equal(second.kind, 'phone');
  assert.notEqual(first.id, second.id);
});

test('undelivered T3 alerts withdraw when the thread resumes or disappears', () => {
  const relay = new WakeRelay();
  relay.sessions([], now);
  relay.sessions([session()], now);
  relay.sessions([session('turn-1', 'running')], now);
  assert.deepEqual(relay.drain(now), []);
  relay.sessions([session('turn-2')], now);
  relay.sessions([], now);
  assert.deepEqual(relay.drain(now), []);
});
