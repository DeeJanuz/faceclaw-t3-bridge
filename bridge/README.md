# T3 Code Assistant Bridge server

Local, authenticated bridge for the Even Hub dashboard, an Android notification companion, and one T3 Code environment. The bridge exposes project/session reads, a reduced provider/model catalog, transcript reads, turn sends and steering, bounded activity summaries, voice transcription, and public weather lookups. It never exposes T3 filesystem, terminal, approval, account, or auth-management APIs. Speech recognition runs locally through whisper.cpp. No API key or cloud transcription service is required.

## Security model

The Even Hub WebView is an untrusted network client. The bridge holds the T3 credential and returns a reduced data model. It omits workspace paths, attachments, raw activity and tool payloads, tool results, and upstream error bodies. Live activity may include a bounded, redacted label such as an exact command preview. Transcript message text remains sensitive because showing it is the app's purpose.

Defaults are deliberately narrow:

- Bind `127.0.0.1` only.
- Require a 32-character or longer base64url `BRIDGE_TOKEN` for HTTP and WebSocket.
- Keep `BRIDGE_PASSPHRASE` opt-in. Pairing exchanges it for the bearer token through an origin-checked, rate-limited endpoint and never stores it on the phone.
- Deny requests with no `Origin` header. Set `BRIDGE_ALLOW_NO_ORIGIN=true` only for a trusted non-browser client.
- Require exact origins by default. Wildcards are rejected. The macOS installer explicitly enables the bounded Even loopback-origin exception described below.
- Start new T3 sessions in `approval-required` mode.
- Validate every new-session provider, model, and reasoning choice against a fresh T3 catalog before creating the thread.
- Force normal speed with `serviceTier: "default"` or `fastMode: false` when the selected model supports that setting.
- Cap JSON, audio, upstream responses, socket queues, subscriptions, request rate, and network timeouts.
- Keep audio in memory only. The bridge zeroes PCM and WAV buffers after preview, finish, cancel, disconnect, or failure.
- Accept only a numeric loopback `WHISPER_SERVER_URL`, so configuration cannot send dictated audio to another host.
- Launch whisper.cpp on `127.0.0.1` with a random request path and no `ffmpeg` conversion. Every inference request sets `no_context=true`.
- Suppress whisper-server output so dictated text does not enter bridge logs.

Do not put `BRIDGE_TOKEN` or `T3_ACCESS_TOKEN` in app source, `app.json`, `VITE_*` variables, or the `.ehpk`. Enter the bridge URL and pairing passphrase at runtime through the companion-app setup UI. The phone discards the passphrase and stores the returned bearer token. Treat that stored token as a bearer credential.

## Optional assistant archive

The optional assistant archive is supported on macOS and Linux only. Its filesystem protections require POSIX ownership checks, no-follow file opens, and directory synchronization. Windows rejects archive configuration before accessing files; leave `BRIDGE_ARCHIVE_PROJECT_ID` and `BRIDGE_ARCHIVE_WORKSPACE_ROOT` unset there. T3 access, notifications, weather, and local voice transcription remain available on Windows.

## Install and run

Requirements:

- Node.js 22.16 or newer
- A running T3 Code environment
- whisper.cpp `whisper-server` and the verified `base.en` model (Homebrew on macOS; a native build on Windows/Linux)

Use the [installer skill](../skills/t3-bridge-deploy/SKILL.md) for automated Windows, macOS, or Linux setup. For macOS deployment, run from the repository root:

```bash
./scripts/install.sh --dry-run
./scripts/install.sh
./scripts/service.sh status
```

The interactive installer keeps long-lived credentials in private user-only files outside the repository, configures private Tailscale HTTPS, installs the login LaunchAgent, starts the managed Whisper listener, and creates a user-specific Even Hub package. See the root [`README.md`](../README.md) for packaging and beta-install steps.

The commands below are the manual development path.

```bash
cd bridge
npm install
npm run setup:whisper
export BRIDGE_TOKEN="$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')"
read -r -s "BRIDGE_PASSPHRASE?Pairing passphrase: "
printf '\n'
export BRIDGE_PASSPHRASE
export BRIDGE_ALLOWED_ORIGINS="http://localhost:5178"
npm run start:t3
```

The hidden prompt keeps the passphrase out of shell history. Unset `BRIDGE_PASSPHRASE` to disable pairing.

`setup:whisper` installs the Homebrew `whisper-cpp` formula when needed. It downloads `ggml-base.en.bin` to `~/Library/Application Support/Even T3 Bridge/models/`, caps the download at its expected size, and checks its published SHA-256 before installation. An existing model with the wrong digest is never overwritten automatically.

`start:t3` is the recommended macOS path. It starts the bridge immediately and supervises T3 and whisper.cpp independently. Missing or unavailable providers do not stop the phone inbox. T3 readiness and local Whisper startup retry every ten seconds without dropping the Even or phone connection.

The launcher finds `T3 Code.app` or `T3 Code (Alpha).app`, creates a two-minute one-time pairing credential, and exchanges it for a bearer token with only `orchestration:read orchestration:operate`. It validates the authenticated descriptor before enabling T3 methods. That credential stays in the bridge process and is revoked on refresh or graceful shutdown. T3 CLI and Whisper child environments exclude bridge and T3 secrets. Managed Whisper listens on numeric loopback with an unguessable request path. Missing transcription produces a temporary-unavailable error while notification reading stays available. Set `T3_APP_PATH`, `WHISPER_CPP_SERVER_PATH`, or `WHISPER_MODEL_PATH` when those files live elsewhere.

The wrapper uses `~/.t3` by default. Set `T3_BASE_DIR` only when the running T3 environment uses another state directory. An ungraceful machine or process kill may prevent revocation. Check T3 Code's authorized clients after a crash and revoke any `even-t3-bridge-*` session.

Windows and Linux use the [portable installer](../skills/t3-bridge-deploy/references/windows-linux.md), which discovers an explicit T3 executable/server entry and manages pairing locally. For a manually managed development deployment only, provide an existing bearer token with exactly the two orchestration scopes and run:

```bash
export T3_ACCESS_TOKEN="..."
export T3_BASE_URL="http://127.0.0.1:3773"
export BRIDGE_TOKEN="..."
export BRIDGE_ALLOWED_ORIGINS="https://your-app-origin.example"
whisper-server --host 127.0.0.1 --port 8178 --request-path /even-t3 --model /absolute/path/to/ggml-base.en.bin
export WHISPER_SERVER_URL="http://127.0.0.1:8178/even-t3/inference"
npm run build
npm start
```

For phone-only use with `npm start`, `T3_ACCESS_TOKEN` may be omitted. This selects an explicitly unavailable T3 provider and makes no T3 request with placeholder credentials.

The glasses choose a live provider, model, and optional reasoning level for each new session. A project does not need a stored default model.

## Tailscale and Even Hub networking

Keep the bridge on loopback and put Tailscale Serve in front of it:

```bash
tailscale serve --bg --https=8443 localhost:8787
```

Use the resulting `https://<machine>.<tailnet>.ts.net:8443` and `wss://<machine>.<tailnet>.ts.net:8443/v1/events` URLs. Do not use Tailscale Funnel or expose this bridge to the public internet.

The Even Hub manifest needs a `network` permission whose whitelist contains the exact HTTPS and WSS bridge origins. Even Hub's whitelist does not bypass browser CORS. The bridge separately checks the WebView's `Origin` header through `BRIDGE_ALLOWED_ORIGINS`.

```json
{
  "name": "network",
  "desc": "Connects to the user's private T3 Code bridge.",
  "whitelist": [
    "https://machine.tailnet.ts.net:8443",
    "wss://machine.tailnet.ts.net:8443"
  ]
}
```

Find the actual WebView origin in simulator or device network logs and configure that exact value. Multiple origins are comma-separated. Packaged WebViews may report `Origin: null`; allow the literal `null` only after verifying the device behavior.

The installed Even app was also observed using `http://127.0.0.1:43751` as its page origin. Set `BRIDGE_ALLOW_EVEN_LOOPBACK_ORIGIN=true` to allow the exact HTTP address `127.0.0.1` with any valid port, so a changing phone-local port does not require server reconfiguration. The standalone bridge defaults this setting to `false`; the macOS installer enables it. The same rule applies to HTTP, CORS responses, and WebSocket upgrades. Alternate IP spellings, other hosts, URL credentials, paths, and malformed ports do not qualify. This is separate from the destination whitelist in the Hub package.

A loopback origin does not authenticate the Even app. Passphrase/token authentication and rate limits remain required, and the bridge must remain privately reachable over Tailscale.

Direct LAN mode is available when Tailscale Serve cannot be used:

```bash
export BRIDGE_HOST="0.0.0.0"
export BRIDGE_ALLOWED_ORIGINS="https://your-exact-app-origin.example"
npm run start:t3
```

Non-loopback startup fails without an origin allowlist. Plain HTTP and WS expose the bridge token and transcripts to the LAN, so use a TLS reverse proxy or a trusted private network.

## WebSocket protocol

Connect to `/v1/events` with both subprotocols:

```ts
new WebSocket(bridgeUrl, ["even-t3-v1", `auth.${bridgeToken}`]);
```

The bridge authenticates `auth.<token>` but selects and echoes only `even-t3-v1`. Non-browser clients may send `Authorization: Bearer <token>` instead. Query-string tokens are not supported.

Request:

```json
{ "v": 1, "type": "request", "id": "req-1", "method": "sessions.list", "params": {} }
```

Success and failure:

```json
{ "v": 1, "type": "response", "id": "req-1", "ok": true, "result": {} }
{ "v": 1, "type": "response", "id": "req-1", "ok": false, "error": { "code": "invalid_request", "message": "..." } }
```

Server event:

```json
{ "v": 1, "type": "event", "event": "sessions.changed", "payload": {} }
```

Methods:

- `weather.locations { query }` searches Open-Meteo's fixed geocoding endpoint and returns `{ locations }` with bounded IDs, city names, regions, countries, and rounded coordinates.
- `weather.current { latitude, longitude }` returns `{ temperatureC, condition, observedAt, fetchedAt }` from Open-Meteo's fixed forecast endpoint. These methods use the existing WebSocket authentication, origin checks, and request limits. The bridge rejects redirects, caps provider responses and concurrent requests, coalesces requests, caches weather for 15 minutes, and returns sanitized failures. Coordinates and provider response bodies are not logged. No provider credential is required for the noncommercial service.
- `thread.settle { threadId }` returns `{ threadId, settled: true, sequence }`. Requires an authorized, unarchived thread with no running turn or pending input. The bridge checks fresh state, then dispatches T3’s native settlement command, which atomically rejects concurrent starts and blocking requests. Older installed bridges require a runtime update.
- `sessions.list {}` returns `{ snapshotId, frozenAt, unsettled, settled }`. Both groups sort by `lastActivityAt`, newest first. The response is one frozen snapshot. The client decides when to replace it.

Session summaries in lists, `sessions.changed`, and transcripts also include `completedTurn: { id, completedAt } | null`. It is present only for an explicitly completed latest turn with a valid bounded ID and timestamp. The client treats the field as optional for compatibility with older bridges. It does not infer completion from the settled flag.
- `projects.list {}` returns `{ snapshotId, projects }`. Each project has `id`, `title`, `canStartSession`, and `updatedAt`.
- `models.list {}` returns a flat list of usable provider/model choices and model-specific reasoning levels. It omits T3 option IDs, account details, and authentication state.
- `transcript.get { threadId }` returns `{ snapshotId, session, turns, liveActivity, liveActivities }` and subscribes that socket to transcript updates. A user message starts a turn. Following assistant/system messages stay in that turn until the next user message. Each turn includes `durationSeconds` and `separatorLabel`. During an active turn, `liveActivity` reports the current thinking or tool phase. `liveActivities` contains at most 32 ordered markers with bounded, redacted display labels, stable bridge IDs, and timestamps. Supported command activities may include the redacted command preview that T3 shows. Both activity fields become empty when the turn settles. Raw tool arguments, results, correlation IDs, and upstream error bodies never cross the bridge.

When T3 marks the latest turn completed and identifies its authoritative assistant message, the bridge removes temporary assistant progress messages from that turn. The identifier must match a bounded assistant message on the same turn. Missing or invalid identifiers leave all messages intact.
- `thread.start { projectId, modelSelection: { instanceId, model, reasoningId? }, text }` creates the thread, then starts its first turn. It returns `{ threadId, text, sequence }`.
- `assistant.start { projectId, modelSelection: { instanceId, model, reasoningId? }, text }` creates an Ask assistant thread and its first turn with server-selected `full-access`. It performs the same project/model checks as ordinary creation. Clients cannot supply an arbitrary runtime mode. Ordinary `thread.start` still uses `BRIDGE_RUNTIME_MODE`, and existing-thread sends preserve the thread's current mode.
- `turn.send { threadId, text }` starts a turn in an existing, idle thread. It returns `{ threadId, text, sequence }`.
- `turn.steer { threadId, text }` adds steering to a running or starting turn. It returns `{ threadId, text, sequence }`. T3 does not expose an atomic expected-turn precondition, so a turn can settle between the bridge status check and dispatch.
- `voice.start {}` opens one recording and returns `{ maxBytes, sampleRate: 16000, channels: 1, format: "pcm_s16le" }`.
- Binary frames after `voice.start` are raw little-endian signed 16-bit, 16 kHz, mono PCM. Each frame must contain an even number of bytes.
- During capture, `voice.partial` events carry `{ text }`. The default cadence is every two seconds. Each update replaces the previous draft rather than appending to it.
- `voice.finish {}` stops audio intake, transcribes the full recording, and returns `{ text }`. It does not call T3. The client must show this final draft before using `assistant.start`, `thread.start`, or `turn.send` on a later, explicit action.
- `voice.cancel {}` aborts transcription when possible, zeroes audio, and returns `{ cancelled }`.

Events are `bridge.status`, `sessions.changed`, `transcript.changed`, `subscription.error`, `voice.partial`, and `voice.error`. The bridge polls T3 snapshots and emits changes by `snapshotSequence`; default interval is 500 ms.

## Existing plan-mode input

`transcript.get` adds optional `pendingPlanInput` with a request ID, revision, turn ID, creation timestamp, and bounded questions/options. It is derived only from structured `user-input.requested` lifecycle activities in an active plan-mode thread; resolved or failed requests are removed. Tool approvals are not exposed through this path.

Authenticated `plan.submit { threadId, requestId, revision, answers }` accepts exactly one answer for every question. Each answer is `{ questionId, optionIndexes, text }`: selected option indexes or a nonempty custom answer. Multi-select questions may contain several indexes. The bridge freshly checks the thread's project permissions, active request and revision, rejects incomplete/duplicate/invalid answers, and dispatches `thread.user-input.respond` with a stable command ID. It preserves runtime permissions and interaction mode. T3 deduplicates that command ID durably; the bridge also coalesces identical concurrent submissions. Transport uncertainty produces `plan_submission_uncertain`, never a normal message fallback. See [the glasses interaction and persistence guide](../docs/plan-questions.md).

## Adding bridge services for dashboards

`src/service-registry.ts` provides an explicit service registry for future dashboard data or bridge-hosted tools. `createBridgeServer` composes its services once, in process. A definition contains a namespace and named handlers; the wire method is the exact `namespace.method` pair. Weather currently registers only `weather.locations` and `weather.current`.

To add a service, implement its operations and register closures in `createBridgeServer`. Each handler receives the request parameter object, validates its own schema, and returns a reduced result. Keep resource bounds, operation-specific permissions, timeouts, and safe errors in the service. Handlers that make network requests should use explicitly configured destinations and reject redirects that could escape those destinations. Never accept a client-supplied URL as a general proxy.

The registry runs only after the existing WebSocket authentication, origin, and frame checks. Unknown methods retain the `method_not_found` response, and the existing socket error mapper sanitizes unexpected failures. Registration rejects duplicate namespaces and reserves the T3/session/voice namespaces. Core T3 and voice routing stays separate. Services receive no credentials or broad T3 capabilities unless explicitly supplied through trusted server composition.

This is an extension point only. There is no RSS reader, arbitrary-URL fetch method, client-controlled registration, dynamic module loading, or new HTTP route. Add matching phone protocol types and dashboard integration when implementing a concrete service, then cover invalid input, unauthorized access, resource limits, and safe failure behavior in tests.

## HTTP fallback

All `/v1/*` routes except `POST /v1/pair` require `Authorization: Bearer <BRIDGE_TOKEN>` and the same origin policy. Pairing still requires an allowed origin, including the bounded Even loopback exception when enabled. It accepts `{ passphrase }`, allows five attempts per client address every five minutes, and returns `{ token }` only after a constant-time match.

- `GET /v1/status`
- `GET /v1/projects`
- `GET /v1/sessions`
- `GET /v1/sessions/:threadId/transcript`
- `POST /v1/sessions` with `{ projectId, modelSelection: { instanceId, model, reasoningId? }, text }`
- `POST /v1/sessions/:threadId/messages` with `{ text }`

`GET /health` is unauthenticated and returns only `{ "status": "ok" }`.

## Configuration

See `.env.example`. The process does not load `.env` automatically.

Useful controls:

- `BRIDGE_PASSPHRASE` enables the temporary phone pairing exchange. It has no default. Unset it to disable pairing.
- `BRIDGE_PROJECT_IDS` restricts all lists, transcript reads, and sends to a comma-separated project ID allowlist.
- `BRIDGE_RUNTIME_MODE` accepts `approval-required`, `auto-accept-edits`, `auto`, or `full-access`. The last modes let dictated text cause workspace changes with less or no confirmation. Use them only on a bridge and projects you trust.
- `BRIDGE_MAX_VOICE_BYTES` defaults to `9600000`, or five minutes of the required PCM format.
- `WHISPER_SERVER_URL` must be an HTTP URL on numeric loopback and end in `/inference`. `start:t3` configures this automatically.
- `WHISPER_LANGUAGE` defaults to `en`. Set `auto` for detection or a two-to-three-letter language code when using a multilingual model.
- `WHISPER_PARTIAL_INTERVAL_MS` defaults to `2000` and accepts `1000` through `10000`.
- `WHISPER_TRANSCRIPTION_TIMEOUT_MS` defaults to `60000` per partial or final pass.

## T3 compatibility

Implemented and tested against T3 Code `0.0.38` and upstream commit `8ea52c8f2f4361e875d72ab30d72d37cfae4d87f` on September 3, 2026. It relies on:

- `GET /.well-known/t3/environment`
- `GET /api/orchestration/shell`
- `GET /api/orchestration/threads/:threadId`
- `POST /api/orchestration/dispatch`
- authenticated Effect RPC `server.getConfig` over `/ws`
- explicit `thread.create` followed by `thread.turn.start`
- bearer session claims containing `sid`, used only by the macOS launcher for revocation

T3 does not yet publish these orchestration contracts as a stable third-party SDK. Provider activation checks `threadSettlement`; response guards reject incompatible shapes; errors never return upstream bodies. An unavailable or incompatible T3 provider does not prevent the phone bridge from listening. Re-run this bridge's tests and a real create/send/stream smoke test after every T3 upgrade.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

Reference material: [T3 remote architecture](https://github.com/pingdotgg/t3code/blob/main/docs/internals/remote.md), [T3 environment authentication](https://github.com/pingdotgg/t3code/blob/main/docs/internals/environment-auth.md), [Even Hub networking](https://hub.evenrealities.com/docs/build/networking), [whisper.cpp](https://github.com/ggml-org/whisper.cpp), [whisper.cpp server](https://github.com/ggml-org/whisper.cpp/tree/master/examples/server), and [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Android companion protocol

See [companion setup and local testing](../docs/android-companion.md). The companion uses separate scoped native credentials. Browser credentials cannot authorize native synchronization, and native credentials cannot authorize T3 or Even browser RPCs. Existing browser origins and authentication remain enforced.

The authenticated Even connection exposes `phone.pairing.create`, `phone.apps.list`, `phone.apps.setEnabled`, `phone.notifications.list`, `phone.notifications.reply`, and `phone.notifications.dismiss`. List calls return the full `PhoneSnapshot` contract in `src/phone.ts`. `phone.changed` publishes updated connection, permission, app, and notification state.

The companion exchanges a single-use five-minute code at `POST /v1/phone/pair`, then calls `POST /v1/phone/sync` with its native bearer token and no browser Origin. A bounded full snapshot includes active notifications, installed-app metadata, selected packages, permission state, and prior command results. The response contains app selections and commands delivered once. Native Android intents never cross this interface. App toggles persist on the phone and repopulate the bridge after restart; message contents stay in memory.

Reply/dismiss requests supply a stable notification key, current revision, and `commandId` made with `createPhoneCommandId()`; replies also supply reviewed text. IDs embed a millisecond timestamp plus UUID and have an immutable 30-second validity window. Commands include matching `issuedAt` and `expiresAt`; consumed receipts are retained until safe expiry. This permits bounded cleanup without renewing stale commands. Clock rollback fails closed. Results distinguish `handed_off`, `dismissed`, `unavailable`, `failed`, and `unknown`. A lost result or disconnect never triggers automatic replay.

After six seconds without a phone snapshot, phone actions become unavailable and phone-targeted voice capture is cancelled. Removal and permission revocation also invalidate recording targets. Reconnection reconciles the phone's current active state. A successful dispatch is app handoff, not recipient delivery; native compare-and-cancel remains a best-effort check against Android's non-transactional API.
