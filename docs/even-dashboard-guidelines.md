# Even OS implementation guide

Verified September 5, 2026 against the **OS Guidelines** page of Even's public Figma file. The App Guidelines page is not the visual reference for this redesign.

## Source evidence

- [OS Guidelines](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=8359-80995): inspected the App Layer, Foreground system layer, and Core Principles examples in the public canvas.
- [Foreground system layer](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=8447-80549): compact notification near the top, source and recency on the first line, sender below, with dimmed background content. The pictured notification is an incoming call. Our card uses message source and sender instead.
- [Core Principles](https://www.figma.com/design/X82y5uJvqMH95jgOfmV34j/Even-Realities---Software-Design-Guidelines--Public-?node-id=8359-80995): full 576×288 canvas, pixel-aligned content, and one actionable focus target.
- [Dashboard tutorial](https://support.evenrealities.com/hc/en-us/articles/14269247458319-Dashboard) and [News reference](https://support.evenrealities.com/hc/article_attachments/15631415281167): home preview → full-width list → full-width reader; double tap returns a level.
- [Notification help](https://support.evenrealities.com/hc/en-us/articles/14274501482639-Notifications): supplementary reference for source/time/sender hierarchy and browsing notifications.

## Implemented mapping

| Surface | T3 Code Assistant behavior |
| --- | --- |
| Home widgets | Persistent top Notifications N, boxed Ask assistant and Sessions, and extension previews; fixed native outlines with a bright cursor and selected label |
| Expanded widget | Full 576×288 screen with a 544-pixel text column |
| Assistant | Expand from its home selector; full-screen preparation, dictation, review, and conversation |
| Notification foreground | A compact 544×104 card at (16, 12) overlays the fixed dashboard; 12-hour time and position count sit inside its header; swipe browses the inbox |
| Notification reader | Rise from the bottom to full-screen; preserve reading and reply controls |
| Back | Reverse the corresponding transition, restore the inbox or prior home selection |
| Sessions and plans | Full-screen native text; retain hold menus, selection, plan answers, and explicit submission |

App screens and companion help omit gesture instructions. Single tap selects, double tap returns, and tap-and-hold opens the OS menu. Phone dismissal requires choosing its menu action in the reader. The Notifications N control remains selectable when empty. Swipe up from Ask assistant focuses it. The former home notification previews and lower bell are removed by user request. All home controls retain subdued native outlines. A cursor and brighter text indicate focus without rebuilding the page. Both inbox cards and live phone arrivals show `subject: message` truncated to two lines. Incoming phone messages use a ten-second popup, replaced and restarted by a newer arrival; selection and dictation remain unchanged on expiry. Reading a T3 completion still clears that thread's alerts; back shows the remaining or empty inbox. Phone replies keep their original payload, while previews normalize stray indentation. The user explicitly requested full-screen dictation, so it differs from the OS's narrow Even AI listening bar. Application-specific source icons are not supplied by the notification protocol; the card preserves source text instead. The notification background uses the actual home pixels and existing native text positions, not a simplified substitute layout.

## Rendering and motion

The dashboard uses one 128×144 image for the stacked dotted clock from the OS reference. `src/dashboard-clock-image.ts` reconstructs the visible dot pattern locally with square dots and clipped corners; it does not depend on a firmware icon API or a downloaded font. Both hours and minutes fit in this single image at (46,66).

Date, battery percentage, connection, AM/PM, weather, Notifications N, actions, and previews are native text. Connection status sits beside the battery percentage on the top row. `src/native-dashboard.ts` stays within eight text containers and one image. Home focus changes update only the old and new labels through `textContainerUpgrade`, preserving the clock. Time changes upload one clock image; metadata changes do not. [Display API](https://hub.evenrealities.com/docs/build/display)

The notification foreground remains a 544×104 native card at (16,12). Entering/exiting it rebuilds the page and uploads one clock image. The hour row is hidden beneath the foreground; the minute row and lower native details keep their coordinates. Browsing notifications updates text in place. A return from a full-screen reader or assistant also reloads one clock image.

`src/os-layout.ts` defines six navigation directions. Native opening and closing animations use up to eleven intermediate text/border pages over a 135 ms target duration, followed by the final page. Calls remain serialized; slow acknowledgements, a newer render, or a new input skip remaining samples. Animation samples do not send images. The phone mirror uses the same clock raster and final native geometry with continuous animation.

A failed native update forces a rebuild on the next render. Readers, voice, plans, and contextual menus retain their existing behavior. Legacy bitmap card/activity rendering remains available for diagnostics; it is not used for the application's OS dashboard screens.

The SDK limits each image to 288×144 pixels. A full-screen image requires four tiles, and a full-height sidebar requires two. The public SDK does not expose the internal Even OS dashboard renderer, scalable native fonts, transform animation, or an atomic frame swap. Simulator checks verify rendering and interaction paths; physical G2 testing is required for visible latency. See [the performance comparison](dashboard-rendering-performance.md).
