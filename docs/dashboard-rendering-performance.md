# Dashboard navigation performance

The dashboard uses one 128×144 image for its stacked dotted clock. Date, battery percentage, connection status, AM/PM, weather, Notifications N, action labels, and outlines use native text containers. Selecting an action does not rebuild the page or upload an image. Native expansion, collapse, notification drop/retract, and reader rise/lower animations are enabled.

## Why the previous dashboard was slow

Baseline: commit `a2369f3`. `renderDashboardLayer` composited the clock, weather icons, bell, and action outlines into four image tiles. A full-screen page discarded those image containers. Returning home rebuilt them and uploaded four tiles containing 134,803 raw pixel values for the standard dashboard. Selecting Sessions from Ask assistant could also change all four tiles because outlines crossed tile boundaries. Pixel comparison skipped identical tiles but did not send partial changes within a tile.

The current clock has 18,432 raw pixel values, about 86% fewer than that full dashboard. This is a payload comparison, not a measured latency improvement. The SDK compresses image data automatically; its 100 ms pacing is a floor, and a successful call indicates acceptance rather than visible pixels. [Display API](https://hub.evenrealities.com/docs/build/display)

## Current transfer behavior

| Operation | Native page/text work | Image uploads |
| --- | --- | --- |
| First dashboard display | One page with at most eight text containers | One clock image |
| Move home selection | Update old and new labels/brightness | None |
| Update notification count, weather, battery, or connection | Update changed text | None |
| Minute changes on home | AM/PM text changes only if needed | One clock image |
| Expand assistant or sessions | Intermediate native outlines/text, then full native page | None |
| Return home | Native collapse samples, then dashboard page | One clock image |
| Open/close notification dropdown or arrival banner | Rebuild native foreground/background layout | One clock image with the appropriate hour-row visibility |
| Browse notifications within the dropdown | Update foreground text | None |
| Reader, voice, plan, and expanded content updates | Native text and borders | None |

The full 576×288 display cannot be sent as one SDK image: each image container is limited to 288×144. A full-height left panel also needs at least two images. The current clock uses one image at (46,66); both rows fit within its 144-pixel height.

## Appearance and motion

`dashboard-clock-image.ts` reconstructs the dotted clock shown as 09 / 53 in the public Even OS guidelines. It uses an 18×21 dot grid per digit, three-dot strokes, clipped corners, and integer 2×2 dots separated by one dark pixel. This is a local raster reconstruction of the visible reference, not a callable firmware clock or a supplied font asset. No font or icon fetch is required. [OS reference](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=8447-80549)

`native-dashboard.ts` builds the surrounding labels and outlines. The connection label sits beside the battery percentage in the top row. The Notifications N option remains first and selectable at zero. Opening it shows the native notification foreground; the covered hour row is omitted from the clock image while the minute row stays in place.

`glasses-display.ts` compares geometry separately from text and clock content. It uploads the clock only after its container is recreated or the visible time changes. Failed native calls force recovery through a rebuild. Animation samples contain only text/borders, target 135 ms, and skip remaining samples after slow acknowledgements or new input. The destination clock uploads once after a return/drop/retract animation, never once per sample.

`os-mirror.ts` draws the same clock pixels and final container geometry. The phone mirror animates continuously; native animation is sampled and depends on host/Bluetooth latency. The public SDK does not expose the built-in dashboard renderer. Legacy bitmap diagnostic paths remain separate from the application's OS surfaces.

## Verification

Tests cover one-image geometry, dotted pixels and gutters, clipping without moving minutes, text-only focus/count/weather updates, a single minute upload, upload-failure recovery, native expanded pages, notification navigation, and all six animation directions. See [QA notes](qa/dashboard-native-2026-09-05/README.md). Physical glasses are still needed to measure visible latency.

Notification motion samples omit AM/PM along with the clock image so that the short foreground and both still-visible home actions never exceed eight text containers. The final page restores AM/PM. Tests check the native count limit independently of the SDK's JavaScript validator.
