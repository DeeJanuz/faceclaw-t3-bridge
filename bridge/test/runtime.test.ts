import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { RecoveringT3Client, RecoveringTranscriber, startBridgeRuntime } from '../src/runtime.js';
import { HttpT3Client } from '../src/t3-client.js';
import type { T3Client, T3Descriptor } from '../src/types.js';
const config = () => loadConfig({ BRIDGE_TOKEN: 'abcdefghijklmnopqrstuvwxyzABCDEF' });
const descriptor: T3Descriptor = { environmentId: 'fixture', label: 'Fixture', serverVersion: '1', capabilities: { threadSettlement: true } };

test('missing T3 credentials are explicit; no placeholder client or egress', async () => {
  const settings = config();
  assert.equal(settings.t3AccessToken, null);
  let made = 0;
  const client = new RecoveringT3Client(settings, () => { made++; throw new Error('must not construct'); });
  await assert.rejects(client.shell(), /unavailable/);
  await assert.rejects(client.sendMessage({} as never), /unavailable/);
  assert.equal(made, 0);
  assert.throws(() => new HttpT3Client(settings), /unavailable/);
});

test('T3 recovery requires authenticated compatible descriptor, forwards without mutation retries', async () => {
  let compatible = false;
  let operations = 0;
  const shell = { snapshotSequence: 1, projects: [], threads: [] };
  const fake = { descriptor: async () => ({ ...descriptor, capabilities: { threadSettlement: compatible } }),
    shell: async () => shell,
    sendMessage: async () => { operations++; throw new Error('upstream failed'); },
  } as unknown as T3Client;
  const client = new RecoveringT3Client(config(), settings => { assert.equal(settings.t3AccessToken, 'scoped-real-token'); return fake; });
  await assert.rejects(client.useToken('scoped-real-token'), /settlement/);
  await assert.rejects(client.shell(), /unavailable/);
  compatible = true;
  await client.useToken('scoped-real-token');
  assert.deepEqual(await client.shell(), shell);
  await assert.rejects(client.sendMessage({} as never), /upstream failed/);
  assert.equal(operations, 1);
  client.clear();
  await assert.rejects(client.shell(), /unavailable/);
  await client.useToken('scoped-real-token');
  assert.deepEqual(await client.shell(), shell);
});

test('late readiness cannot resurrect a provider invalidated during shutdown', async () => {
  let resolve!: (value: T3Descriptor) => void;
  const candidate = { descriptor: () => new Promise<T3Descriptor>(done => { resolve = done; }) } as unknown as T3Client;
  const client = new RecoveringT3Client(config(), () => candidate);
  const ready = client.useToken('scoped-token');
  client.clear(); resolve(descriptor); await ready;
  await assert.rejects(client.shell(), /unavailable/);
});

test('phone HTTP starts without T3 or Whisper and transcriber fails closed until attached', async () => {
  const runtime = startBridgeRuntime({ ...config(), port: 0 });
  await once(runtime.server, 'listening');
  const address = runtime.server.address() as AddressInfo;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${address.port}/health`)).status, 200);
    assert.throws(() => runtime.useWhisper(new URL('https://external.example/inference')), /loopback/);
    const transcriber = new RecoveringTranscriber();
    const pcm = [Buffer.from('sensitive pcm')];
    await assert.rejects(transcriber.transcribe(pcm, new AbortController().signal), /temporarily unavailable/);
    let calls = 0;
    transcriber.set({ transcribe: async () => { calls++; return 'dictated reply'; } });
    assert.equal(await transcriber.transcribe(pcm, new AbortController().signal), 'dictated reply');
    transcriber.set(null);
    await assert.rejects(transcriber.transcribe(pcm, new AbortController().signal), /temporarily unavailable/);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>(resolve => runtime.server.close(() => resolve()));
  }
});
