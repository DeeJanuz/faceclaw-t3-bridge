import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { PhoneService } from '../src/phone.js';
const services: PhoneService[] = [];
afterEach(() => { for (const service of services.splice(0)) service.close(); });
function service(disconnect = 6000, timeout = 10_000) {
  const value = new PhoneService('bridge-secret', () => {}, disconnect, timeout);
  services.push(value); return value;
}
const app = { packageName: 'org.signal.app', name: 'Signal', replyObserved: true };
const notification = { key: 'notification', revision: 'r1', packageName: app.packageName, appName: app.name,
  title: 'Sender', text: 'Private message', arrivedAt: 1000, replyable: true };
function sync(overrides: Record<string, unknown> = {}) {
  return { v: 1, permissionGranted: true, apps: [app], notifications: [notification],
    enabledPackages: [app.packageName], results: [], ...overrides };
}
function command(overrides = {}) { return { key: notification.key, revision: 'r1', text: 'Reply', commandId: `${Date.now()}-${randomUUID()}`, ...overrides }; }

test('native pairing uses one-time codes, scoped stable credentials, and rejects broad tokens', () => {
  const phone = service();
  assert.throws(() => phone.pair({ code: 'bad' }));
  const pairing = phone.createPairing();
  const result = phone.pair({ code: pairing.code });
  assert.ok(phone.authenticated(result.token));
  assert.ok(!phone.authenticated('bridge-secret'));
  assert.ok(service().authenticated(result.token));
  assert.throws(() => phone.pair({ code: pairing.code }));
  assert.throws(() => phone.pair({ code: phone.createPairing().code, extra: true }));
});
test('disabled apps never reach glasses, inventory remains and bridge owns toggles', () => {
  const phone = service();
  phone.sync(sync({ enabledPackages: [] }));
  assert.equal(phone.snapshot().notifications.length, 0);
  phone.setEnabled({ packageName: app.packageName, enabled: true });
  assert.deepEqual(phone.sync(sync({ enabledPackages: [] })).enabledPackages, [app.packageName]);
  assert.equal(phone.snapshot().notifications.length, 1);
  phone.setEnabled({ packageName: app.packageName, enabled: false });
  phone.sync(sync());
  assert.equal(phone.snapshot().notifications.length, 0);
});
test('invalid snapshots are atomic and bounded; malicious text, duplicate keys and wrong types rejected', () => {
  const phone = service(); phone.sync(sync());
  for (const bad of [
    sync({ permissionGranted: 'yes' }), sync({ apps: Array(2049).fill(app) }),
    sync({ notifications: [notification, notification] }),
    sync({ notifications: [{ ...notification, text: '\u0000secret' }] }),
    sync({ notifications: [{ ...notification, packageName: 'unknown.app' }] }),
    sync({ notifications: [{ ...notification, text: 'x'.repeat(4001) }] }),
    sync({ notifications: [{ ...notification, replyable: false }] }),
  ]) assert.throws(() => phone.sync(bad));
  assert.equal(phone.snapshot().notifications[0]?.text, notification.text);
});
test('commands handed out once; duplicate explicit ID cannot resend, collision rejected', async () => {
  const phone = service(); phone.sync(sync());
  const params = command(); const pending = phone.command('reply', params);
  assert.equal(phone.sync(sync()).commands.length, 1);
  assert.equal(phone.sync(sync()).commands.length, 0);
  assert.throws(() => phone.command('reply', { ...params, text: 'different' }));
  phone.sync(sync({ results: [{ id: params.commandId, status: 'handed_off' }] }));
  assert.equal((await pending).status, 'handed_off');
  assert.equal((await phone.command('reply', params)).status, 'handed_off');
  assert.equal(phone.sync(sync()).commands.length, 0);
});
test('stale or removed notification cannot be acted on and newer messages survive handoff', async () => {
  const phone = service(); phone.sync(sync());
  assert.equal((await phone.command('reply', command({ revision: 'stale' }))).status, 'unavailable');
  const params = command(); const pending = phone.command('reply', params);
  phone.sync(sync());
  phone.sync(sync({ notifications: [{ ...notification, revision: 'r2', text: 'New incoming message', arrivedAt: 2000 }],
    results: [{ id: params.commandId, status: 'handed_off' }] }));
  assert.equal((await pending).status, 'handed_off');
  assert.equal(phone.snapshot().notifications[0]?.revision, 'r2');
  const next = phone.command('dismiss', command({ revision: 'r2' }));
  phone.sync(sync({ notifications: [] }));
  assert.equal((await next).status, 'unavailable');
});
test('timed out handoff is unknown and never replayed on later sync', async () => {
  const phone = service(6000, 15); phone.sync(sync());
  const params = command(); const pending = phone.command('reply', params);
  phone.sync(sync()); await wait(25);
  assert.equal((await pending).status, 'unknown');
  assert.equal(phone.sync(sync()).commands.length, 0);
  assert.equal((await phone.command('reply', params)).status, 'unknown');
});
test('disconnect preserves last phone snapshot, disables actions, replaces snapshot on reconnect', async () => {
  const phone = service(20); phone.sync(sync());
  const pending = phone.command('reply', command());
  await wait(50);
  assert.equal(phone.snapshot().connected, false);
  assert.equal(phone.snapshot().notifications.length, 1);
  assert.equal((await pending).status, 'unknown');
  assert.throws(() => phone.command('dismiss', command()));
  phone.sync(sync({ notifications: [] }));
  assert.equal(phone.snapshot().connected, true);
  assert.equal(phone.snapshot().notifications.length, 0);
});
test('permission revocation is connected with no notifications and prevents queued actions', async () => {
  const phone = service(); phone.sync(sync());
  const pending = phone.command('reply', command());
  assert.equal(phone.sync(sync({ permissionGranted: false })).commands.length, 0);
  assert.equal((await pending).status, 'unavailable');
  assert.equal(phone.snapshot().connected, true);
  assert.equal(phone.snapshot().permissionGranted, false);
  assert.equal(phone.snapshot().notifications.length, 0);
});
test('unsolicited results and wrong-operation acknowledgements cannot resolve commands', async () => {
  const phone = service(6000, 30); phone.sync(sync());
  const params = command(); const pending = phone.command('reply', params);
  assert.equal(phone.sync(sync({ results: [{ id: params.commandId, status: 'handed_off' }] })).commands.length, 1);
  phone.sync(sync({ results: [{ id: params.commandId, status: 'dismissed' }] }));
  await wait(40); assert.equal((await pending).status, 'unknown');
});


test('command lifetime is immutable in ID; expired and future actions fail closed', () => {
  const phone = service(); phone.sync(sync());
  const old = command({ commandId: `${Date.now() - 31_000}-${randomUUID()}` });
  assert.throws(() => phone.command('reply', old), /expired/);
  assert.throws(() => phone.command('reply', command({ commandId: `${Date.now() + 6000}-${randomUUID()}` })), /clocks/);
  assert.throws(() => phone.command('reply', command({ commandId: randomUUID() })));
  assert.equal(phone.sync(sync()).commands.length, 0);
});

test('expired receipts free capacity without allowing old IDs to replay', async (context) => {
  const start = Date.now();
  context.mock.method(Date, 'now', () => start);
  const phone = service(); phone.sync(sync());
  const old = command({ revision: 'absent' });
  for (let index = 0; index < 4096; index++) {
    await phone.command('reply', index === 0 ? old : command({ revision: 'absent' }));
  }
  assert.throws(() => phone.command('reply', command()), /limit/);
  context.mock.method(Date, 'now', () => start + 36_000);
  phone.sync(sync());
  assert.equal((await phone.command('reply', command({ revision: 'absent' }))).status, 'unavailable');
  assert.throws(() => phone.command('reply', old), /expired/);
  // Clock rollback cannot revive a pruned command in this bridge process.
  context.mock.method(Date, 'now', () => start);
  assert.throws(() => phone.command('reply', old), /expired/);
});

test('native command lease matches immutable ID timestamp and allows small clock skew', async () => {
  const phone = service(); phone.sync(sync());
  const stamp = Date.now() + 1000;
  const params = command({ commandId: `${stamp}-${randomUUID()}` });
  const pending = phone.command('reply', params);
  const wire = phone.sync(sync()).commands[0]!;
  assert.equal(wire.issuedAt, stamp);
  assert.equal(wire.expiresAt, stamp + 30_000);
  phone.sync(sync({ results: [{ id: params.commandId, status: 'handed_off' }] }));
  await pending;
});
