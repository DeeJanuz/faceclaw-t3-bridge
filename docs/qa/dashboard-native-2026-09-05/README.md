# Single-clock native dashboard QA

September 5, 2026, macOS ARM64. SDK 0.0.14, simulator 0.9.5.

- `npm run check:all` passed: frontend tests/build, deployment tests, bridge typecheck/tests/build.
- Focused tests passed for the single clock upload, metadata/focus updates, minute ticks, failed-upload recovery, notification navigation, and six native motion directions.
- The full native simulator runs `tests/manual/dashboard.html?notifications=phone` with synthetic sessions, assistant responses, and two phone messages. The [home capture](home.png) shows the dotted clock, native top-row connection status, and Notifications N selection.
- Simulator telemetry confirmed initial home used one image. An Up button click changed focus with two native text upgrades and no additional image or rebuild. Interactive session opening, paging, and double-tap return were observed in the event log.
- Both the Glasses Display controls and fixture buttons route into the application. The first interactive run stopped responding after Vite reloaded the webview: the old display remained, while `createStartUpPageContainer` rejected a second startup before event handlers were installed. The interactive run was restarted on a dedicated Vite server with `server.hmr: false` and `server.watch: null`, preserving input handlers while repository checks run.

Native animation samples contain no images. Home/dropdown destination pages contain exactly one 128×144 clock image; expanded pages contain none. The image has 18,432 raw pixels versus the previous full dashboard's 134,803. These are transport counts, not measured physical-glasses latency. No package was deployed or published.

## Notification transition correction

Interactive testing exposed a nine-text-container intermediate dropdown frame, rejected by the simulator's eight-text limit. SDK JavaScript validation did not catch that count. Transition samples now omit AM/PM along with the clock image; the completed layout restores both. Regression tests explicitly assert at most eight text containers in every drop/retract sample and restore the period only on the destination page. The new assertion reproduced both failures before the fix.

After the correction, `npm run check:all` passed again. Native simulator automation opened and closed the notification dropdown twice without an error screen. The [notification capture](notification.png) shows the successful final foreground. The interactive simulator was left running on the dashboard with automatic reloads disabled.

## Hardware tuning: 0.5.4

The user reported equally choppy opening and closing on physical glasses with 0.5.3. At their request, 0.5.4 reduces the shared native/phone animation target from 180 ms to 135 ms (75% of the previous duration). The eleven-sample cap and slow-call/input skipping remain in place. This is a target-duration change; hardware smoothness and actual completion time still need comparison on the glasses.
