#!/usr/bin/env node
// Local-only integration fixture. Never loads installed-service configuration.
import { createBridgeServer } from '../bridge/dist/src/server.js'
import { loadConfig } from '../bridge/dist/src/config.js'

const config = loadConfig({
  BRIDGE_HOST: '127.0.0.1', BRIDGE_PORT: '18789',
  BRIDGE_TOKEN: 'even_phone_fixture_token_local_only_123456789',
  BRIDGE_PASSPHRASE: 'local-phone-fixture',
  BRIDGE_ALLOWED_ORIGINS: 'http://localhost:5178,http://127.0.0.1:5178',
  T3_BASE_URL: 'http://127.0.0.1:1', T3_ACCESS_TOKEN: 'fixture-never-used',
})
const unavailable = async () => { throw new Error('T3 is deliberately unavailable in the phone fixture') }
const client = {
  descriptor: unavailable, shell: unavailable, thread: unavailable,
  modelCatalog: unavailable, startSession: unavailable, sendMessage: unavailable,
  steerMessage: unavailable, settleThread: unavailable, respondToPlanInput: unavailable,
}
const server = createBridgeServer(config, client, {
  async transcribe() { return 'Synthetic glasses reply. See you at six.' },
})
server.listen(config.port, config.host, () => {
  console.log('Phone fixture bridge: http://127.0.0.1:18789')
  console.log('Open http://localhost:5178/tests/manual/phone.html in the development server.')
  console.log('Android emulator endpoint: http://10.0.2.2:18789 (debug APK only).')
  console.log('All T3 actions are disabled. Transcription returns synthetic text; no microphone is accessed.')
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
})
