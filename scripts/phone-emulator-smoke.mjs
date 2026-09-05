#!/usr/bin/env node
// Runs only against the isolated fixture and an Android emulator's DEBUG APK.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
const require = createRequire(new URL('../bridge/package.json', import.meta.url))
const WebSocket = require('ws')
const execute = promisify(execFile)
const serial = process.argv[2] ?? 'emulator-5554'
if (!/^emulator-\d+$/.test(serial)) throw new Error('Use an emulator serial; physical devices are deliberately refused.')
const app = 'dev.evenbridge.companion'
const component = `${app}/.DebugNotificationReceiver`
const listener = `${app}/${app}.PhoneNotificationListener`
const adb = (...args) => execute('adb', ['-s', serial, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
await adb('shell', 'run-as', app, 'pwd') // Release builds fail this check.
const socket = new WebSocket('ws://127.0.0.1:18789/v1/events', ['even-t3-v1', 'auth.even_phone_fixture_token_local_only_123456789'], {
  origin: 'http://localhost:5178',
})
await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
const pending = new Map()
socket.on('message', raw => {
  const value = JSON.parse(raw.toString())
  if (value.type !== 'response') return
  const entry = pending.get(value.id)
  if (!entry) return
  pending.delete(value.id); clearTimeout(entry.timer)
  value.ok ? entry.resolve(value.result) : entry.reject(Object.assign(new Error(value.error.message), { code: value.error.code }))
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = randomUUID()
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, 15000)
  pending.set(id, { resolve, reject, timer })
  socket.send(JSON.stringify({ v: 1, type: 'request', id, method, params }))
})
const snapshot = () => rpc('phone.notifications.list')
async function until(predicate, label, timeout = 15000) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const result = await predicate()
    if (result) return result
    await pause(150)
  }
  throw new Error(`Timed out: ${label}`)
}
const hook = (operation, id = 900, text = 'Synthetic_message') => adb('shell', 'am', 'broadcast', '-n', component,
  '--es', 'operation', operation, '--ei', 'id', String(id), '--es', 'title', `Smoke_${id}`, '--es', 'text', text)
const item = async id => (await snapshot()).notifications.find(value => value.title === `Smoke_${id}`)
const command = item => ({ key: item.key, revision: item.revision, commandId: `${Date.now()}-${randomUUID()}` })
async function counters() {
  const { stdout } = await adb('shell', 'run-as', app, 'cat', 'shared_prefs/simulation.xml').catch(() => ({ stdout: '' }))
  return { count: Number(stdout.match(/name="replyCount" value="(\d+)"/)?.[1] ?? 0), hash: stdout.match(/name="lastReplyHash">([^<]+)/)?.[1] }
}
const checks = []
let priorEnabled = false
try {
  const pairing = await rpc('phone.pairing.create')
  await adb('shell', 'am', 'broadcast', '-n', component, '--es', 'operation', 'pair', '--es', 'origin', 'http://10.0.2.2:18789', '--es', 'code', pairing.code)
  await adb('shell', 'cmd', 'notification', 'allow_listener', listener)
  await adb('shell', 'pm', 'grant', app, 'android.permission.POST_NOTIFICATIONS')
  await until(async () => { const state = await snapshot(); return state.connected && state.permissionGranted && state.apps.length }, 'phone connection')
  priorEnabled = (await snapshot()).apps.find(value => value.packageName === app)?.enabled ?? false
  await rpc('phone.apps.setEnabled', { packageName: app, enabled: false })
  await hook('post'); await pause(1500)
  assert.equal(await item(900), undefined)
  checks.push('Disabled apps do not forward')
  await rpc('phone.apps.setEnabled', { packageName: app, enabled: true })
  await until(() => item(900), 'enabled replyable notification')
  await hook('readonly', 904); await pause(1500)
  assert.equal(await item(904), undefined)
  checks.push('Read-only notifications do not forward')
  await hook('immutable', 905); await pause(1500)
  assert.equal(await item(905), undefined)
  checks.push('Immutable actions that cannot accept reply text do not forward')

  await rpc('voice.start', { source: 'phone', key: (await item(900)).key })
  socket.send(Buffer.alloc(6400))
  const draft = await rpc('voice.finish')
  assert.equal(draft.text, 'Synthetic glasses reply. See you at six.')
  const firstRevision = (await item(900)).revision
  await hook('update', 900, 'New_message_during_review')
  const latest = await until(async () => { const value = await item(900); return value?.revision !== firstRevision && value }, 'updated notification revision')
  const before = await counters()
  const result = await rpc('phone.notifications.reply', { ...command(latest), text: draft.text })
  assert.equal(result.status, 'handed_off')
  await until(async () => !(await item(900)), 'reply dismissal')
  const after = await counters()
  assert.equal(after.count, before.count + 1)
  assert.equal(after.hash, createHash('sha256').update(draft.text).digest('hex'))
  checks.push('Dictation/review text reaches Android exactly once; reply clears notification')

  await hook('post', 901)
  const dismissible = await until(() => item(901), 'dismissible notification')
  assert.equal((await rpc('phone.notifications.dismiss', command(dismissible))).status, 'dismissed')
  await until(async () => !(await item(901)), 'explicit dismissal')
  assert.equal((await counters()).count, after.count)
  checks.push('Dismiss without replying preserves reply count')

  await hook('newer-on-reply', 902)
  const updating = await until(() => item(902), 'newer-on-reply notification')
  assert.equal((await rpc('phone.notifications.reply', { ...command(updating), text: draft.text })).status, 'handed_off')
  await until(async () => (await snapshot()).notifications.some(value => value.text === 'New message after reply'), 'preserved post-reply message')
  checks.push('Message arriving after reply survives')

  await hook('failure', 903)
  const failing = await until(() => item(903), 'cancelled reply intent')
  assert.equal((await rpc('phone.notifications.reply', { ...command(failing), text: draft.text })).status, 'unavailable')
  assert.ok(await item(903))
  checks.push('Cancelled Android reply intent reports unavailable without retry')

  await adb('shell', 'cmd', 'notification', 'disallow_listener', listener)
  await until(async () => { const state = await snapshot(); return !state.permissionGranted && state.notifications.length === 0 }, 'permission revocation')
  await adb('shell', 'cmd', 'notification', 'allow_listener', listener)
  await until(async () => (await snapshot()).permissionGranted, 'permission recovery')
  checks.push('Permission revocation clears capabilities; regrant reconciles')

  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2))
} finally {
  for (const id of [900, 901, 902, 903, 904, 905]) await hook('remove', id).catch(() => {})
  await rpc('phone.apps.setEnabled', { packageName: app, enabled: priorEnabled }).catch(() => {})
  await adb('shell', 'cmd', 'notification', 'allow_listener', listener).catch(() => {})
  socket.close()
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Fixture closed')) }
}
