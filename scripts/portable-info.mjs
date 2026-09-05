#!/usr/bin/env node
import path from 'node:path';
import { dataDirectory, connectionInfo, verifyLocalPairing } from './portable-deployment.mjs';
import { readPrivateFile } from './portable-service.mjs';
import { verifyProviders } from './provider-check.mjs';

async function main() {
  if (process.argv.length === 3 && ['--help', '-h'].includes(process.argv[2])) { console.log('Usage: node scripts/portable-info.mjs [--verify]\nPrint configured endpoint URLs. --verify checks local pairing, rejects unauthenticated requests, verifies T3 through private HTTPS and Whisper using synthetic silence through private WSS.'); return; }
  if (!['win32', 'linux'].includes(process.platform)) throw new Error('On macOS use npm run connection-info');
  if (process.argv.slice(2).some(value => value !== '--verify')) throw new Error('Usage: node scripts/portable-info.mjs [--verify]');
  const directory = path.join(dataDirectory(), 'service');
  const config = JSON.parse(await readPrivateFile(path.join(directory, 'portable-config.json')));
  let providers;
  if (process.argv.includes('--verify')) {
    const credentials = JSON.parse(await readPrivateFile(path.join(directory, 'credentials.json')));
    await verifyLocalPairing(config.bridgePort, credentials);
    providers = await verifyProviders(config, credentials.bridgeToken);
  }
  console.log(JSON.stringify({ ...connectionInfo(config), ...(process.argv.includes('--verify') ? { verification: 'Local pairing and rejection of unauthenticated requests passed', providers } : {}) }, null, 2));
}
main().catch(error => {
  const safe = new Set(['Authenticated T3 readiness check failed', 'Authenticated WSS connection failed', 'Whisper verification capture failed', 'Local Whisper inference check failed', 'Provider verification connection closed', 'Provider verification timed out']);
  console.error(safe.has(error?.message) ? error.message : 'Connection information unavailable. Check the private portable installation, user service, Tailscale, and providers.');
  process.exitCode = 1;
});
