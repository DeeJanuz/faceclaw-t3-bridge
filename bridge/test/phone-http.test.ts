import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import WebSocket from 'ws';
import { loadConfig } from '../src/config.js';
import { createBridgeServer } from '../src/server.js';
import type { T3Client, Transcriber } from '../src/types.js';
const token = 'abcdefghijklmnopqrstuvwxyzABCDEF';
const origin = 'https://glasses.example';
const sync = { v: 1, permissionGranted: true, apps: [], notifications: [], enabledPackages: [], results: [] };

test('native auth isolation, browser pairing, no-origin policy, phone RPC during T3 outage', async () => {
  const config = loadConfig({ BRIDGE_TOKEN: token, T3_ACCESS_TOKEN: 'unused', BRIDGE_ALLOWED_ORIGINS: origin, BRIDGE_POLL_INTERVAL_MS: '60000' });
  const server = createBridgeServer(config, {} as T3Client, {} as Transcriber);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const socket = new WebSocket(base.replace('http:', 'ws:') + '/v1/events', ['even-t3-v1', `auth.${token}`], { origin });
  const rpc = (method: string, params: unknown = {}) => new Promise<Record<string, unknown>>((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const listener = (data: WebSocket.RawData) => {
      const event = JSON.parse(data.toString());
      if (event.id === id) { socket.off('message', listener); resolve(event); }
    };
    socket.on('message', listener);
    socket.send(JSON.stringify({ v: 1, type: 'request', id, method, params }));
  });
  const post = (path: string, body: unknown, bearer?: string, withOrigin?: string) => fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), ...(withOrigin ? { Origin: withOrigin } : {}) },
    body: JSON.stringify(body),
  });
  try {
    await once(socket, 'open');
    const pairing = (await rpc('phone.pairing.create')).result as { code: string };
    assert.equal((await post('/v1/phone/pair', { code: pairing.code }, undefined, origin)).status, 403);
    const paired = await post('/v1/phone/pair', { code: pairing.code });
    assert.equal(paired.status, 200);
    const phoneToken = (await paired.json() as { token: string }).token;
    assert.notEqual(phoneToken, token);
    assert.equal((await post('/v1/phone/pair', { code: pairing.code })).status, 401);
    assert.equal((await post('/v1/phone/sync', sync, token)).status, 401);
    assert.equal((await post('/v1/phone/sync', sync, phoneToken, origin)).status, 403);
    assert.equal((await post('/v1/phone/sync', sync, phoneToken)).status, 200);
    const phone = await rpc('phone.notifications.list');
    assert.equal(phone.ok, true);
    assert.equal((phone.result as { connected: boolean }).connected, true);
    assert.equal((await fetch(base + '/v1/projects', { headers: { Origin: origin, Authorization: `Bearer ${phoneToken}` } })).status, 401);
    assert.equal((await fetch(base + '/v1/projects', { headers: { Authorization: `Bearer ${token}` } })).status, 403);
    const inventory = { ...sync, apps: [{ packageName: 'android', name: 'Android', replyObserved: true }] };
    assert.equal((await post('/v1/phone/sync', inventory, phoneToken)).status, 200);
    assert.equal((await rpc('phone.apps.setEnabled', { packageName: 'android', enabled: true })).ok, true);
    const active = { ...inventory, notifications: [{ key: 'active', revision: '1', packageName: 'android', appName: 'Android', title: 'Thread', text: 'Message', arrivedAt: Date.now(), replyable: true }] };
    assert.equal((await post('/v1/phone/sync', active, phoneToken)).status, 200);
    assert.equal((await rpc('voice.start', { source: 'phone', key: 'missing' })).ok, false);
    assert.equal((await rpc('voice.start', { source: 'phone', key: 'active' })).ok, true);
    assert.equal((await post('/v1/phone/sync', inventory, phoneToken)).status, 200);
    assert.deepEqual((await rpc('voice.cancel')).result, { cancelled: false });
    assert.equal((await rpc('voice.start')).ok, true);
    assert.equal((await post('/v1/phone/sync', { ...inventory, permissionGranted: false }, phoneToken)).status, 200);
    assert.deepEqual((await rpc('voice.cancel')).result, { cancelled: true });
    const denied = new WebSocket(base.replace('http:', 'ws:') + '/v1/events', ['even-t3-v1', `auth.${phoneToken}`], { origin });
    await assert.rejects(once(denied, 'open'), /401/);
  } finally {
    socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
