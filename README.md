# T3 Code Bridge for Even Realities G2

An open-source bridge between your existing T3 Code installation, Even Realities G2 glasses, and an optional Android notification companion. Read conversations, dictate and review replies, answer plan questions, and see local weather from your glasses.

**Public beta:** Even Hub app 0.5.0. The computer bridge and glasses frontend are in this repository. The [Android companion](https://github.com/DeeJanuz/even-t3-android) has its own source and signed APK releases. This is an independent community project, not an official T3 Code or Even Realities product.

## Install with your T3 Code agent

T3 Code and a working agent/provider are assumed to be installed already. You do not need to follow a terminal setup guide yourself.

1. Download [SKILL.md](https://raw.githubusercontent.com/DeeJanuz/even-t3-bridge/main/skills/t3-bridge-deploy/SKILL.md), or copy its contents into a T3 Code conversation.
2. Ask your agent: **“Use this skill to install T3 Code Bridge on this computer, install its missing prerequisites, configure automatic startup, and give me my phone setup details.”**
3. Complete any operating-system administrator or Tailscale sign-in prompts on your own device. The agent builds the app, verifies the bridge, and supplies your `.ehpk`, endpoint URLs, and local pairing instructions.

The skill covers Windows, macOS, and Linux. It installs or discovers Node.js, Git, Tailscale, and local whisper.cpp transcription, preserving your existing T3 installation and projects. Mac uses a user LaunchAgent; Windows uses a user Scheduled Task; Linux uses a user systemd service. Startup is at sign-in. Keep T3 Code running and the computer awake while using the glasses.

Mac deployment has been exercised locally. Windows and Linux installers are beta paths with automated platform tests; a successful dry run or CI build does not establish a complete phone-to-glasses hardware test on those platforms.

## Finish setup on your phone

Use Android 9 or newer and an Even Realities app compatible with Even Hub SDK 0.0.14 (minimum host version 2.2.9).

1. **Private network:** Install Tailscale on the phone and sign in to the same tailnet as your computer. Complete VPN approval if Android requests it.
2. **Even Hub app:** Use the personalized `.ehpk` supplied by the installer. Upload it through your [Even Hub developer portal](https://hub.evenrealities.com/login), assign the build to a beta group containing your Even account, and install it from the Even Realities phone app. Your agent can prepare the package; account sign-in and beta access belong to you.
3. **Bridge connection:** In T3 Code Bridge’s phone settings, enter the installer’s **WebSocket URL** and your **pairing passphrase**, then save. The passphrase is exchanged for a scoped token and cleared from the form. Do not paste credentials into a T3 conversation, GitHub issue, or screenshot.
4. **Assistant and weather:** Choose an existing T3 project and model under Dashboard settings. Allow location for the Even Realities Android app, or choose a fallback city. New Ask assistant conversations use full access; ordinary T3 conversations keep their configured mode.
5. **Optional phone messages:** Download the signed beta APK from [Android releases](https://github.com/DeeJanuz/even-t3-android/releases). Open it on the phone and allow that installer to install unknown apps. Enable notification access for Even Phone Companion. If Android blocks a sideloaded app’s notification access, enable **Allow restricted settings** in that app’s Android settings first.
6. In Even Hub’s **Android notifications** section, select **Pair Android companion**. In the Android companion, enter the installer’s **HTTPS bridge origin** and the short-lived pairing code. Enable only the messaging apps you want to forward in Even Hub’s app list. No messaging-account password is needed.

The companion forwards individual notifications that offer a compatible text-reply action. It does not forward every notification. See the [Android setup and behavior guide](https://github.com/DeeJanuz/even-t3-android#readme) for permissions and device restrictions.

## Which URLs go where?

Your installer prints the exact values for **your** computer. These examples show the format; do not paste the example hostname into settings.

| Setting | Value |
| --- | --- |
| Even Hub → Bridge connection → WebSocket URL | `wss://YOUR-COMPUTER.YOUR-TAILNET.ts.net:8443/v1/events` |
| Android companion → HTTPS bridge origin | `https://YOUR-COMPUTER.YOUR-TAILNET.ts.net:8443` |
| Even Hub pairing passphrase | Your local bridge pairing passphrase, not a URL or Android pairing code |
| Android companion pairing code | A fresh code from Even Hub → Android notifications |

The default private HTTPS port is 8443. If the installer chooses another port, use that value in both URLs. `localhost` on your phone points to the phone, not your computer.

**Personalized Even Hub builds are required.** Even’s [networking documentation](https://hub.evenrealities.com/docs/build/networking) requires exact allowed origins and does not support wildcard hosts. A package built for one computer cannot be reused for an unrelated hostname. The skill builds your package for your hostname; changing hosts requires repackaging. We do not publish a universal `.ehpk` pointing at the maintainer’s private computer or expose the bridge through Tailscale Funnel.

## What runs where?

- **Computer:** Authenticated bridge, connection to your existing T3 Code server, and local Whisper transcription. Notification forwarding works independently of T3 availability; T3 actions require T3 Code to be available.
- **Glasses / Even Hub:** Dashboard, top notification bell, conversations, full-screen dictation and review, and phone settings. Standard single tap, double tap, swipe, and contextual-menu behavior applies without gesture hints on each screen.
- **Optional Android companion:** Opt-in notification access and local reply handoff. Notification/reply contents are not stored by the companion. Android handoff confirms acceptance by the messaging app, not delivery to the recipient.

The transport stays private through Tailscale Serve and normal HTTPS certificate validation. T3 credentials remain on the computer; the phone uses separately scoped credentials. Weather queries use approximate coordinates and the Open-Meteo noncommercial service. Source-code licensing does not change third-party service terms.

## Develop and verify

```sh
npm ci
npm ci --prefix bridge
npm run check:all
```

Run `npm run dev` for local frontend development. Debug input panels, display probes, and synthetic-notification buttons are omitted from beta builds; local developers can opt in with `?debug=1`. `tests/manual/dashboard.html?notifications=phone` provides synthetic native-simulator scenarios without sending real messages.

See [computer bridge internals](bridge/README.md), [dashboard extensions](docs/dashboard-extensions.md), [plan questions](docs/plan-questions.md), and the [installer skill](skills/t3-bridge-deploy/SKILL.md). T3’s orchestration API is not a stable third-party SDK; rerun compatibility checks after upgrading T3 Code. Real glasses and a physical Android phone remain necessary to assess Bluetooth latency, microphone delivery, and background restrictions.

## License

[MIT](LICENSE). You may use, modify, redistribute, or sell the original code while retaining its license notice. No monetization restriction or copyleft requirement is added. Fonts, icons, libraries, and external services retain their own terms; see [third-party notices](THIRD_PARTY_NOTICES.md).
