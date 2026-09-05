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
| Home widgets | Persistent top bell/count, boxed Ask assistant and Sessions, and extension previews; thin inactive outlines and one heavier bright focus outline |
| Expanded widget | Full 576×288 screen with a 544-pixel text column |
| Assistant | Expand from its home selector; full-screen preparation, dictation, review, and conversation |
| Notification foreground | A compact 544×104 card at (16, 12) overlays the fixed dashboard; 12-hour time and position count sit inside its header; swipe browses the inbox |
| Notification reader | Rise from the bottom to full-screen; preserve reading and reply controls |
| Back | Reverse the corresponding transition, restore the inbox or prior home selection |
| Sessions and plans | Full-screen native text; retain hold menus, selection, plan answers, and explicit submission |

App screens and companion help omit gesture instructions. Single tap selects, double tap returns, and tap-and-hold opens the OS menu. Phone dismissal requires choosing its menu action in the reader. The bell remains selectable when empty. Swipe up from Ask assistant focuses it. The former home notification previews and lower bell are removed by user request. All home controls retain subdued outlines, with a heavier selected outline so focus remains distinct in monochrome rendering. Both inbox cards and live phone arrivals show `subject: message` truncated to two lines. Incoming phone messages use a three-second popup, replaced and restarted by a newer arrival; selection and dictation remain unchanged on expiry. Reading a T3 completion still clears that thread's alerts; back shows the remaining or empty inbox. Phone replies keep their original payload, while previews normalize stray indentation. The user explicitly requested full-screen dictation, so it differs from the OS's narrow Even AI listening bar. Application-specific source icons are not supplied by the notification protocol; the card preserves source text instead. The notification background uses the actual home pixels and existing native text positions, not a simplified substitute layout.

## Rendering and motion

`src/os-layout.ts` defines shared integer geometry and six navigation directions. Native navigation commits the destination layout once. SDK acknowledgements can precede physical redraw, so intermediate rebuilds can accumulate across Bluetooth even when the calls return quickly. The phone mirror retains its 180 ms transform animation.

Home and Notifications use the same four resident image containers. The right tiles omit permanently empty pixels; the standard home transfers 134,803 pixel values instead of 165,888, with unchanged visible geometry. The top card is composited into the two top tiles; all pixels outside its rectangle stay in place. Covered native text lines are hidden without shifting the uncovered lines. Time uses AM/PM, the count shares the card header, and no notification instruction footer appears beneath the dashboard. Opening and retracting the native overlay update the existing containers without animation rebuilds. The phone preview provides a pull-down animation above a stationary snapshot. Live arrivals use the same top card. Over full-screen readers or voice, native text containers hide the covered rows without moving the remaining rows; expiry restores them. These full-screen popup entry/exit operations rebuild text containers without image transfers. This distinction avoids discarding/reloading the native background to animate a card.

In-place text updates handle dictation, pagination, notification selection, and live activity. Native menus and selection borders rebuild when their structure changes. Returning from full-screen content creates usable labels immediately, then restores the dashboard images. Image calls remain serialized. A new input can interrupt the remaining stale image burst after the current upload; a no-op input completes missing tiles without resending successful tiles. A failed update forces a rebuild on the next render. [Display API](https://hub.evenrealities.com/docs/build/display), [page lifecycle](https://hub.evenrealities.com/docs/build/page-lifecycle)

The public SDK exposes no reusable Even OS dashboard renderer, transform animation, atomic frame swap, or in-place image visibility control. Full-screen content and contextual-menu changes still rebuild the page and invalidate its images. Text brightness cannot provide a removable opaque mask; a native simulator probe left the background visible. Successful image sends confirm acceptance, not visible pixels. This implementation follows the observed OS layout and requested navigation with native SDK primitives; it cannot establish pixel-identical background rendering or built-in motion smoothness. The native simulator verifies geometry and inputs; physical glasses are still required to assess radio latency and animation feel. [Image-send semantics](https://hub.evenrealities.com/docs/build/display#image-sends-are-paced-at-100ms), [SDK FAQ](https://hub.evenrealities.com/docs/reference/faq)
