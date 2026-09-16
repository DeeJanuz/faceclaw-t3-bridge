# Faceclaw T3 Bridge

This repository is the T3 Code bridge for our Faceclaw fork. It connects the fork to an existing T3 Code installation for projects, conversations, model selection, plan questions, voice transcription, and glasses tools.

**Development scope:** Make changes for this project in this checkout and target our Faceclaw fork. Use the local source and [Faceclaw integration guide](docs/faceclaw.md) as the starting point for development. Inherited package names, scripts, and compatibility code do not change that scope.

This work builds on the original Faceclaw and our earlier T3 bridge work. It is an independent community project, not an official T3 Code or Even Realities product.

## How it fits together

- **Faceclaw fork:** The phone and glasses experience, including assistant conversations, dictation, and device tools.
- **Computer bridge:** Connects Faceclaw to the local T3 Code server and the local environments of explicitly paired bridges over Tailscale, plus local Whisper transcription. T3 credentials remain on the computer; Faceclaw uses its own scoped pairing token.
- **T3 Code:** Owns projects, conversations, models, and agent execution. T3 Code and a working agent/provider must already be installed for real assistant use.

Keep the bridge on loopback. For a physical phone, use private HTTPS/WSS through Tailscale Serve with normal certificate validation. Keep T3 Code running and the computer awake while using the assistant.

## Develop and verify

Run from this repository:

```sh
npm ci
npm ci --prefix bridge
npm run check:all
```

For isolated Faceclaw integration testing:

```sh
npm --prefix bridge run build
node scripts/faceclaw-dev-server.mjs
```

The fixture runs on loopback port 18790 with synthetic projects, conversations, and responses. It does not load installed configuration, real credentials, or user T3 data. See the [local UI testing instructions](docs/faceclaw.md#local-ui-testing) for connection details and fixture limitations.

The fixture checks application flow. Real speech recognition, model execution, Bluetooth behavior, and Android handoff still require integration testing with the relevant services and hardware. Run `npm run check:all` after runtime changes.

## Pair computer bridges

Install a bridge on each T3 computer, then follow [peer setup and revocation](docs/peers.md). The phone's selected host aggregates paired computers without T3 Connect credentials or an open T3 desktop window. Update the standalone T3 APK to route sessions by their owning environment.

## Connect Faceclaw

Faceclaw pairs through `/v1/faceclaw/pair` and connects to `/v1/faceclaw/events`. Use the [Faceclaw integration guide](docs/faceclaw.md) for native transport, optional draft refinement, and provider setup that exposes glasses tools to T3.

Use the bridge origin and pairing details for your own computer. Do not paste credentials into conversations, GitHub issues, or screenshots. Keep existing T3 data, provider settings, and installed service configuration intact when changing setup.

The optional Signal APK has its own phone setup screen. On the glasses, New conversation opens its contact/group directory with voice search; the home list shows retained conversations in newest-message order. The bridge supplies `lastMessageAt` from retained messages, so contact sync and unsent drafts do not create chats. Signal history from before linking is unavailable (`historyImport: false`), and a chat leaves this list when its final retained message expires or is deleted. See the [Signal guide](docs/signal.md) for setup, retention and protocol details.

## Documentation

- [Optional Signal service, APK protocol and scoped assistant tools](docs/signal.md)
- [Faceclaw integration and local testing](docs/faceclaw.md)
- [Computer bridge internals and protocol](bridge/README.md)
- [Session behavior](docs/session-behavior.md)
- [Plan questions](docs/plan-questions.md)

T3's orchestration API is not a stable third-party SDK. Rerun compatibility checks after upgrading T3 Code.

## License

[MIT](LICENSE). You may use, modify, redistribute, or sell the original code while retaining its license notice. No monetization restriction or copyleft requirement is added. Fonts, icons, libraries, and external services retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).

## Transcript token usage

Normalized transcripts include `tokenUsage: { contextTokens, contextWindowTokens, totalTokens, updatedAt }`, with nullable values. The bridge reads T3 Code `context-window.updated` activities: the latest `usedTokens` and `maxTokens` supply context occupancy and capacity, and the greatest reported `totalProcessedTokens` supplies cumulative processed usage. It never adds cumulative snapshots or cached/reasoning subtotals. Compaction can reduce context without reducing the displayed total. Providers without the corresponding fields remain unknown. Raw provider payloads are not forwarded.

The source contract was checked against T3 Code commit `8ea52c8f2f4361e875d72ab30d72d37cfae4d87f` (`providerRuntime.ts`, `CodexAdapter.ts`, `ClaudeAdapter.ts`). Deploy the rebuilt bridge with the matching T3 APK to enable its CTX/TOTAL header.

### Assistant questions in ordinary sessions

Structured `user-input.requested` activities are exposed for running turns in both `default` and `plan` interaction modes. The existing `pendingPlanInput` and `plan.submit` wire names remain for compatibility. Answers still require the current request identity and revision, session/project authorization, review, and explicit submission through `thread.user-input.respond`. Approval events and free-form transcript text do not become questions. Restart the bridge after rebuilding to activate this behavior; use a T3 APK that displays pending-question alerts.
