# Android notifications and replies

Version 0.3.0 adds a custom Android companion in the sibling `android companion/` directory. The Mac bridge remains required for transport and whisper.cpp transcription. T3 does not need to be available to read or reply to phone notifications.

## Install and pair

1. Update the Mac bridge from this checkout and import the matching 0.3.0 Even Hub package. Existing bridge URL and Even pairing remain valid.
2. Sideload the signed release APK from `android companion/artifacts/`. Open **Even Phone Companion** and grant Android notification access using its setup button.
3. Keep Tailscale connected on the phone and Mac. Use the same private HTTPS host and port as the Even bridge URL. The Mac must be awake and reachable.
4. In the Even app's **Android notifications** settings, select **Pair Android companion**. Enter that temporary code and the bridge HTTPS address in the Android companion.
5. Enable the desired apps in Even settings. Apps start disabled. The list contains installed apps, including apps whose reply support has not yet been observed. Only an enabled app's notifications with free-form text reply actions enter the inbox.

Android supplies the reply capability on each notification. Signal, Google Messages, and WhatsApp are the initial device acceptance targets. Gmail and other apps use the same capability check; there are no app-specific messaging credentials or integrations.

Pairing saves credentials; app selection requires a live connection from Even Phone Companion to the bridge. If the status says **Phone disconnected**, the searchable app list and checked selections are the last saved snapshot. Choices stay disabled until the companion reconnects. Open the companion and check its connection status, keep Tailscale connected, and ensure the computer is awake. If it reports notification access is needed, enable that permission in Android settings. Updating an inbox notification preserves the existing app controls so it cannot interrupt a selection in progress.

## Glasses behavior

The shared inbox contains T3 completion alerts and Android notifications, ordered newest first with timestamps. New content updates the existing phone card and moves it up while keeping the selected item focused. Reading a phone notification leaves it active.

Glasses package 0.3.2 restores separate home cards for Notifications, Ask assistant, and Sessions. The inbox, phone reader, and dashboard voice capture use a raised right-side card. Changing its shape updates only right-side images; reading, selection, and voice review use text updates. The clock/weather sidebar remains resident. Swipe to select or page, tap to open or reply, double tap to return, and hold a phone notification to dismiss it. Arrival banners restore the current text after ten seconds. The existing Android APK remains compatible.

Tap a phone notification to read it, then tap to dictate. Tap to stop, review the recipient and complete draft, then tap to send. New incoming messages never cancel recording or steal focus. A top arrival banner uses at most two lines for the app, sender or thread, and truncated preview, and disappears within ten seconds.

Tap-and-hold opens the native contextual menu. In the phone notification reader, select **Dismiss notification** to dismiss without replying. Long press alone does not dismiss. Dismissal and confirmed reply handoff clear the notification on both devices. Android handoff confirms that the messaging app received the action, not delivery to the recipient. Newer content is preserved when detected before cancellation; Android does not offer an atomic reply-and-cancel transaction.

If the phone removes a notification while it is being read, dictated, or reviewed, microphone capture stops and the draft is discarded. The glasses show **Cancelled: notification no longer available** for one second, then return to the inbox, or home when it is empty.

Disconnection stops dictation, discards unsent drafts, and returns to the last confirmed phone inbox with actions disabled. Reconnection replaces that snapshot with the phone's active notifications before actions resume. Sends and dismissals are never automatically replayed. An uncertain send must be checked on the phone.

## Local integration test

The APK project README documents SDK setup, release signing, and debug-only synthetic notification hooks. The release APK excludes those hooks.

In two terminals in `t3 bridge/`, run:

```sh
npm run dev:phone
npm run dev
```

Open `http://localhost:5178/tests/manual/phone.html`. This fixture uses the real application and bridge transport on loopback port 18789. It deliberately makes T3 unavailable and substitutes a deterministic transcription result. It does not read installed bridge credentials or access a real microphone.

Pair the debug companion in the Android emulator to `http://10.0.2.2:18789` using the fixture's pairing button. Enable the companion's synthetic notification source in the app list, then post a debug notification. Navigate with the input controls, start dictation, press **Supply synthetic microphone audio**, stop, review, and send. Inspect the Android debug reply receiver to confirm the same text was handed off and the notification disappeared.

Exercise read-only filtering, disabled apps, same-notification updates, a second conversation, removal while recording and reviewing, explicit dismissal, bridge/phone connection loss, permission revocation, send failures, and reconnect reconciliation. Native G2 pixels, gesture delivery, real microphone capture, and the messaging apps' own behavior still require device testing.

For a repeatable Android-to-bridge test using only synthetic notifications:

```sh
node scripts/phone-emulator-smoke.mjs emulator-5554
```

This command requires the running fixture bridge and debug APK, refuses physical-device serials, and verifies disabled/read-only/immutable filtering, exact reply text by its hash, dismissal, newer-message preservation, cancelled reply intents, and permission recovery. It removes its own synthetic notifications and restores the app's prior toggle afterward. The browser fixture separately exercises the glasses gestures and draft state.

For native rendering, run the Even simulator against `tests/manual/phone-native.html?scene=dashboard`, `?scene=reader`, or `?scene=dictation`. Its screenshot encodes brightness in alpha; composite the PNG over black to inspect it. These scenes verify the two-line banner using real SDK containers without real notification data.

Run `npm run check:all` for frontend, bridge, and deployment regressions. Build and test the APK using the commands in the companion README.

## Experimental Auto Display wake

Update both the bridge and the Android companion, then open **Experimental display wake → Relay alerts to Even Auto Display** in the companion. Accept Android's notification permission prompt on Android 13+. **Android alert settings** opens the relay channel settings if notifications have been denied or disabled.

Press **Send test display alert** once so the companion can appear in Even's notification source list. This requires the relay toggle and Android permission/channel; it sends only a generic local test, with no T3 or phone message.

In the Even Realities app, enable Notifications, enable **Even Phone Companion** as a notification source, and turn on **Auto Display**. To avoid two native overlays for a tracked message, disable the original messaging app in Even's notification-source list while keeping it enabled in T3 Code Assistant's tracked-app list. The companion relay is off by default. After configuring Even, let the glasses sleep and press **Send test display alert** again to check wake.

New T3 completions and eligible tracked text/app notifications generate a generic native alert with no message body. Existing inbox content is skipped on first connection, opt-in and reconnection. Bursts are combined into one replaceable notification; Android removes it after five seconds. Removing that Android notification does not establish that Even's overlay also disappears. T3 read failures leave tracked phone alerts available.

[Even documents Auto Display](https://support.evenrealities.com/hc/en-us/articles/14274501482639-Notifications), and display wake while this Hub app runs was confirmed on the maintainer's phone/glasses with Notifications and Auto Display enabled. Other phone/glasses combinations still require testing. Even owns the native overlay and may consume its tap gestures. T3 Code Assistant's ten-second dropdown opens its associated thread or phone reader only when the app receives the tap; double tap returns to the previous app view. Native notification taps are not a supported shortcut to a T3 thread. Android runtime permission follows the [platform notification permission model](https://developer.android.com/develop/ui/views/notifications/notification-permission).

Device verification:

1. With the dashboard visible, complete a new T3 turn. Check native alert forwarding, dropdown timing, tap-to-thread, and double-tap return. Repeat while reading another thread, including a non-first page.
2. Let the glasses displays sleep, then complete a new T3 turn. Record whether they wake, which overlay appears, and which app receives a tap. Repeat with a new eligible SMS and an enabled linked app notification.
3. Disable relay, deny Android notification permission, disable its channel, and disconnect/reconnect. Verify no relay while disabled and no flood of old alerts when restored. Phone reading/replying should remain available without the wake option.
4. Send a short burst and update one existing notification. Verify one replaceable generic relay, no feedback loop, and no old relay after process restart. Repeat with original apps enabled and disabled in Even to assess duplicate overlays.

The existing debug simulation remains available only in debug builds on its `simulation` channel; relay notifications cannot enter it. Unit tests and emulator checks cannot establish physical display wake, Even overlay lifetime, or native gesture delivery.
