# Session selection and notification display

The New Session project picker follows the bridge's recent-interaction order and selects the first available project. Recency uses the latest user-message or turn-request timestamp across a project's sessions, including archived sessions. Session creation is the fallback when conversation timestamps are absent. Projects without sessions sort last; ties sort by title and ID. Assistant completion and project metadata changes do not move a project ahead of a more recent user interaction.

The bridge does not currently receive a last-viewed project signal from T3 Code. Merely opening or reading a project therefore does not change this order.

## Notification dropdowns

New T3 response alerts and tracked phone notifications show a dropdown for ten seconds while the dashboard or a conversation reader is open. Tap before it expires to open the associated T3 thread or phone conversation. Double tap in that reader returns to the interrupted screen and reading position. Further notification visits can be opened and returned from in order.

Expiry hides only the dropdown; the alert remains in the inbox. Swipe up or down, or double tap, on an unopened dropdown to dismiss it without marking the alert read or navigating the underlying screen. New arrivals replace the current preview and restart the timer. Removed or superseded notifications cannot open stale targets. Initial connection snapshots do not produce a burst of old dropdowns.

The open inbox keeps its current selection on arrivals. Dictation, draft review, sending, and plan-input screens keep their existing controls; arrivals update the inbox without covering those flows. Cancelling a phone reply opened from a dropdown returns to its reader; a subsequent double tap returns to the interrupted screen.

## Experimental automatic display wake

The installed Even Hub SDK 0.0.14 and the official [page lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle) and [device APIs](https://hub.evenrealities.com/docs/build/device-apis) documentation expose page rendering but no documented display-wake command. Rendering an arrival banner does not prove that sleeping displays turn on.

The Android companion now offers an opt-in relay: new T3 or tracked phone alerts cause a short, generic Android notification, which Even's native [Auto Display](https://support.evenrealities.com/hc/en-us/articles/14274501482639-Notifications) can forward. See [setup and physical-device checks](android-companion.md#experimental-auto-display-wake). Both the running computer bridge and Android companion must be updated.

This is a wake attempt, not a confirmed wake command. Even controls the native overlay and its gestures. A tap on that overlay may close it instead of reaching our dropdown, and it covers our preview while visible. With Even Display Time set to five seconds, our ten-second timer is intended to leave roughly five seconds to interact afterward; the timers start independently, so the remaining time can vary. The Android notification timeout does not guarantee the same timeout on the glasses. Verify sleeping-display wake, overlay duration, tap delivery, and return navigation on physical glasses before relying on the combined behavior.
