import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { bridgeEnvironment, cleanPath, connectionInfo, dataDirectory, loopbackT3Url, systemdUnit, windowsTaskScript } from './portable-deployment.mjs';
import { parseArguments, assertPrivateDirectory } from './install-portable.mjs';
import { readPrivateFile } from './portable-service.mjs';

test('data paths use per-user OS conventions and reject relative overrides', () => {
  assert.equal(dataDirectory('linux', '/home/user', {}), '/home/user/.local/share/even-t3-bridge');
  assert.equal(dataDirectory('win32', 'C:\\Users\\user', { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' }), 'C:\\Users\\user\\AppData\\Local\\Even T3 Bridge');
  assert.equal(dataDirectory('darwin', '/Users/user', {}), '/Users/user/Library/Application Support/Even T3 Bridge');
  assert.throws(() => dataDirectory('linux', '/home/user', { XDG_DATA_HOME: 'relative' }));
  assert.throws(() => dataDirectory('win32', 'C:\\Users\\user', {}));
});
test('managed pairing rejects remote hosts, URL credentials and redirects by origin construction', () => {
  assert.equal(loopbackT3Url('http://127.0.0.1:3773/'), 'http://127.0.0.1:3773');
  assert.equal(loopbackT3Url('http://[::1]:3773'), 'http://[::1]:3773');
  for (const value of ['https://example.com', 'http://localhost:3773', 'http://127.0.0.1:3773/path', 'http://user:secret@127.0.0.1:3773', 'http://127.0.0.1:3773?token=x', 'http://127.0.0.1:3773/#x']) assert.throws(() => loopbackT3Url(value));
});
test('systemd arguments cannot introduce shell commands, expansion, or extra directives', () => {
  const unit = systemdUnit('/opt/node', '/home/user/Bridge $HOME%', '/home/user/config');
  assert.ok(unit.includes('Bridge $$HOME%%'));
  assert.match(unit, /UMask=0077/);
  assert.throws(() => systemdUnit('/opt/node', '/tmp/runner\nExecStart=evil', '/tmp/config'));
  assert.throws(() => cleanPath('/tmp/runner"'));
  assert.doesNotMatch(unit, /BRIDGE_TOKEN|PASSPHRASE|T3_ACCESS_TOKEN/);
});
test('Windows startup quotes paths, uses current limited interactive user and refuses overwrite', () => {
  const script = windowsTaskScript('C:\\Program Files\\nodejs\\node.exe', "C:\\Users\\O'Neil\\Bridge\\scripts\\portable-service.mjs", "C:\\Users\\O'Neil\\config.json");
  assert.match(script, /O''Neil/);
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /Get-ScheduledTask/);
  assert.match(script, /ExecutionTimeLimit/);
  assert.doesNotMatch(script, /BRIDGE_TOKEN|PASSPHRASE|T3_ACCESS_TOKEN|cmd.exe|\-Force/);
  assert.throws(() => windowsTaskScript('C:\\node.exe', 'C:\\bad"path', 'C:\\config'));
});
test('configuration enforces authenticated private defaults and endpoint output contains no credentials', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\test' : '/home/test';
  const config = { bridgePort: 8787, host: 'computer.example.ts.net', httpsPort: 8443, t3BaseDir: root, t3Executable: path.join(root, 'T3'), t3Entry: path.join(root, 'bin.mjs'), whisperModel: path.join(root, 'model.bin') };
  const env = bridgeEnvironment(config);
  assert.equal(env.BRIDGE_HOST, '127.0.0.1');
  assert.equal(env.BRIDGE_ALLOW_NO_ORIGIN, 'false');
  assert.equal(env.BRIDGE_ALLOWED_ORIGINS, 'null');
  assert.equal(env.BRIDGE_RUNTIME_MODE, 'approval-required');
  assert.deepEqual(connectionInfo(config), { evenHubBridgeUrl: 'wss://computer.example.ts.net:8443/v1/events', androidBridgeUrl: 'https://computer.example.ts.net:8443' });
});
test('installer rejects missing prerequisites, unknown flags and duplicate ports without side effects', () => {
  assert.throws(() => parseArguments(['--token', 'secret']));
  assert.throws(() => parseArguments(['--dry-run']));
  assert.throws(() => parseArguments(['--bridge-port', '8443']));
});
test('private configuration refuses symlinks and public permissions', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX permission test; Windows uses installer-created user-only ACLs');
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'bridge-private-test-'));
  try {
    await assertPrivateDirectory(directory);
    const config = path.join(directory, 'private.json');
    await writeFile(config, '{"test":true}', { mode: 0o600 });
    assert.equal(await readPrivateFile(config), '{"test":true}');
    const link = path.join(directory, 'link'); await symlink(config, link);
    await assert.rejects(() => readPrivateFile(link));
    await assert.rejects(() => assertPrivateDirectory(link));
    await chmod(config, 0o644);
    await assert.rejects(() => readPrivateFile(config));
    await chmod(directory, 0o755);
    await assert.rejects(() => assertPrivateDirectory(directory));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('launcher enforces loopback before minting and runtime installation includes shared helpers', async () => {
  const source = await readFile(new URL('../bridge/scripts/start-with-t3.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('loopbackT3Url(config.t3BaseUrl.href)') < source.indexOf('const runtime = startBridgeRuntime(config)'));
  assert.match(source, /redirect: "error"/);
  assert.match(source, /orchestration:read orchestration:operate/);
  const installer = await readFile(new URL('./install.sh', import.meta.url), 'utf8');
  assert.match(installer, /portable-deployment.mjs.*deployment-helpers.mjs.*STAGING_SCRIPT_DIR/);
});

test('isolated macOS runtime layout can import the launcher without the source checkout', async () => {
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'bridge-stage-test-'));
  try {
    await mkdir(path.join(directory, 'bridge', 'scripts'), { recursive: true });
    await mkdir(path.join(directory, 'scripts'));
    for (const file of ['scripts/portable-deployment.mjs', 'scripts/deployment-helpers.mjs', 'bridge/scripts/start-with-t3.mjs']) {
      await copyFile(new URL('../' + file, import.meta.url), path.join(directory, file));
    }
    const launcher = await import(pathToFileURL(path.join(directory, 'bridge', 'scripts', 'start-with-t3.mjs')).href);
    assert.equal(typeof launcher.main, 'function');
    assert.equal(typeof launcher.findApp, 'function');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('installation verifies its own pairing token and unauthorized failure before exposure', async () => {
  const { verifyLocalPairing } = await import('./portable-deployment.mjs');
  const credentials = { bridgeToken: 'test-token', pairingPassphrase: 'test-passphrase' };
  const calls = [];
  await verifyLocalPairing(8787, credentials, async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/v1/pair') ? Response.json({ token: credentials.bridgeToken }) : new Response('', { status: 401 });
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/v1/pair');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Origin, 'null');
  assert.equal(calls[0].options.body, JSON.stringify({ passphrase: credentials.pairingPassphrase }));
  await assert.rejects(() => verifyLocalPairing(8787, credentials, async () => Response.json({ token: 'foreign' })), /unexpected token/);
  await assert.rejects(() => verifyLocalPairing(8787, credentials, async () => Response.json({ token: credentials.bridgeToken })), /require authentication/);
});
test('T3 Electron archive entry validates its container without asking native Node to traverse ASAR', async () => {
  const { resolveT3Entry } = await import('./portable-deployment.mjs');
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'bridge-asar-test-'));
  try {
    const archive = path.join(directory, 'app.asar');
    await writeFile(archive, 'fixture archive');
    const entry = path.join(archive, 'apps', 'server', 'dist', 'bin.mjs');
    assert.equal(await resolveT3Entry(entry), entry);
    await assert.rejects(() => resolveT3Entry(path.join(archive, 'arbitrary.mjs')), /Unexpected T3 ASAR/);
    await assert.rejects(() => resolveT3Entry(path.join(directory, 'missing.mjs')));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('installer and prerequisite help are read-only and available on every host', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  for (const script of ['scripts/install-portable.mjs', 'scripts/portable-info.mjs', 'scripts/package-evenhub.mjs', 'bridge/scripts/setup-whisper.mjs']) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../' + script, import.meta.url)), '--help'], { env: { ...process.env, PATH: '' } });
    assert.match(stdout, /Usage:/);
    assert.equal(stderr, '');
  }
});
test('provider check authenticates private endpoints and verifies synthetic inference without user messages', async () => {
  const { EventEmitter } = await import('node:events');
  const { verifyProviders } = await import('./provider-check.mjs');
  const calls = [];
  let finish = { result: { text: 'unused synthetic result' } };
  class FakeSocket extends EventEmitter {
    constructor(url, protocols, options) { super(); calls.push({ url, protocols, options }); queueMicrotask(() => this.emit('open')); }
    send(value) {
      if (Buffer.isBuffer(value)) { assert.equal(value.length, 32000); assert.equal(value.some(byte => byte !== 0), false); return; }
      const request = JSON.parse(value); calls.push(request.method);
      assert.ok(['voice.start', 'voice.finish'].includes(request.method));
      queueMicrotask(() => this.emit('message', Buffer.from(JSON.stringify({ type: 'response', id: request.id, ...(request.method === 'voice.start' ? { result: { format: 'pcm_s16le' } } : finish) }))));
    }
    terminate() { calls.push('closed'); }
  }
  const dependencies = { WebSocket: FakeSocket, request: async (url, options) => {
    assert.equal(url, 'https://computer.example.ts.net:8443/v1/status');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer secret-test-token');
    return new Response('private upstream details', { status: 200 });
  } };
  const config = { host: 'computer.example.ts.net', httpsPort: 8443 };
  const result = await verifyProviders(config, 'secret-test-token', dependencies);
  assert.equal(result.t3, 'ready');
  assert.doesNotMatch(JSON.stringify(result), /secret|unused|private upstream/);
  assert.deepEqual(calls[0].protocols, ['even-t3-v1', 'auth.secret-test-token']);
  assert.ok(calls.includes('closed'));
  finish = { error: { code: 'transcription_unavailable', message: 'private failure detail' } };
  await assert.rejects(() => verifyProviders(config, 'secret-test-token', dependencies), /^Error: Local Whisper inference check failed$/);
  finish = { error: { code: 'no_speech' } };
  assert.equal((await verifyProviders(config, 'secret-test-token', dependencies)).t3, 'ready');
  await assert.rejects(() => verifyProviders(config, 'secret-test-token', { ...dependencies, request: async () => new Response('', { status: 503 }) }), /T3 readiness check failed/);
});
test('custom macOS T3 configuration is persisted without broadening authentication or inherited environment', async () => {
  const { launchAgentPlist, macT3Environment } = await import('./deployment-helpers.mjs');
  const config = { t3AppPath: '/Applications/Selected & Renamed.app', t3BaseDir: '/Users/test/T3 state', t3BaseUrl: 'http://127.0.0.1:4773' };
  assert.deepEqual(macT3Environment(config), { T3_BASE_URL: config.t3BaseUrl, T3_APP_PATH: config.t3AppPath, T3_BASE_DIR: config.t3BaseDir });
  assert.deepEqual(macT3Environment(), { T3_BASE_URL: 'http://127.0.0.1:3773' });
  for (const invalid of [{ t3AppPath: 'relative.app' }, { t3AppPath: '/Apps/../Other.app' }, { t3AppPath: '/Apps/script.sh' }, { t3BaseDir: '/Users/test\nINJECT=value' }, { t3BaseUrl: 'http://example.com:3773' }, { t3BaseUrl: 'http://127.0.0.1:3773?token=private' }]) assert.throws(() => macT3Environment(invalid));
  const plist = launchAgentPlist({ ...config, label: 'com.example.test', bridgePort: 8787, httpsPort: 8443, host: 'computer.example.ts.net', runnerPath: '/tmp/runner.sh', workingDirectory: '/tmp', nodeExecutable: '/opt/node', stdoutPath: '/tmp/out', stderrPath: '/tmp/err' });
  assert.match(plist, /T3_APP_PATH=\/Applications\/Selected &amp; Renamed.app/);
  assert.match(plist, /T3_BASE_DIR=\/Users\/test\/T3 state/);
  assert.match(plist, /T3_BASE_URL=http:\/\/127.0.0.1:4773/);
  assert.match(plist, /<string>-i<\/string>/);
  assert.doesNotMatch(plist, /T3_ACCESS_TOKEN|BRIDGE_TOKEN|BRIDGE_PASSPHRASE/);
});
test('macOS launcher honors CFBundleExecutable in a renamed custom bundle', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Native macOS bundle metadata check');
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'bridge-custom-app-'));
  const saved = Object.fromEntries(['T3_APP_PATH', 'T3_CLI_EXECUTABLE', 'T3_CLI_ENTRY'].map(key => [key, process.env[key]]));
  try {
    const app = path.join(directory, 'Renamed.app');
    await mkdir(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    await mkdir(path.join(app, 'Contents', 'Resources'));
    await writeFile(path.join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Actual T3 Executable</string></dict></plist>');
    const executable = path.join(app, 'Contents', 'MacOS', 'Actual T3 Executable');
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(path.join(app, 'Contents', 'Resources', 'app.asar'), 'fixture');
    process.env.T3_APP_PATH = app; delete process.env.T3_CLI_EXECUTABLE; delete process.env.T3_CLI_ENTRY;
    const { findApp } = await import('../bridge/scripts/start-with-t3.mjs');
    assert.equal((await findApp()).executable, executable);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});
test('generated macOS LaunchAgent actually forwards only selected T3 settings through env -i', async (t) => {
  if (process.platform !== 'darwin') return t.skip('Native macOS plist and runner execution');
  const { launchAgentPlist } = await import('./deployment-helpers.mjs');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execute = promisify(execFile);
  const directory = await mkdtemp(path.join(await realpath(tmpdir()), 'bridge-custom-env-'));
  try {
    const runner = path.join(directory, 'runner.sh');
    await writeFile(runner, `"$NODE_EXECUTABLE" -e 'console.log(JSON.stringify({app:process.env.T3_APP_PATH,base:process.env.T3_BASE_DIR,url:process.env.T3_BASE_URL,secret:process.env.T3_ACCESS_TOKEN}))'\n`);
    const config = { t3AppPath: '/Applications/Renamed.app', t3BaseDir: '/Users/test/Custom T3', t3BaseUrl: 'http://127.0.0.1:4773' };
    const plist = path.join(directory, 'test.plist');
    const { fileURLToPath } = await import('node:url');
    await execute(process.execPath, [fileURLToPath(new URL('./deployment-helpers.mjs', import.meta.url)), 'launch-agent', plist, 'com.example.test', runner, directory, process.execPath, path.join(directory, 'out'), path.join(directory, 'err'), 'computer.example.ts.net', '8443', '8787', '', '', '', config.t3AppPath, config.t3BaseDir, config.t3BaseUrl]);
    const parsed = JSON.parse((await execute('/usr/bin/plutil', ['-convert', 'json', '-o', '-', plist])).stdout);
    const [program, ...args] = parsed.ProgramArguments;
    const result = JSON.parse((await execute(program, args, { env: { ...process.env, T3_ACCESS_TOKEN: 'must-not-inherit' } })).stdout);
    assert.deepEqual(result, { app: config.t3AppPath, base: config.t3BaseDir, url: config.t3BaseUrl });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
