import { loadConfig } from './config.js';
import { startBridgeRuntime } from './runtime.js';

const config = loadConfig();
const runtime = startBridgeRuntime(config);
runtime.useWhisper(config.whisperServerUrl);
let stopped = false;
let retry: ReturnType<typeof setTimeout> | null = null;
async function connectT3(): Promise<void> {
  if (stopped || config.t3AccessToken === null) return;
  try { await runtime.useT3Token(config.t3AccessToken); }
  catch {
    runtime.clearT3();
    if (!stopped) { retry = setTimeout(() => void connectT3(), 10_000); retry.unref(); }
  }
}
void connectT3();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  stopped = true;
  if (retry) clearTimeout(retry);
  runtime.clearT3();
  runtime.server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});
