# Adding dashboards and bridge services

Dashboard content, glasses rendering, and bridge services have separate extension points. The current release includes T3 alerts, assistant, sessions, and weather. RSS fetching and additional tools are future integrations.

## Dashboard modules

Register statically imported `DashboardModule` objects in `src/dashboard-config.ts`. They appear after the built-in T3 cards, in registration order. A module can supply several cards. Their keys must remain stable across refreshes; the registry namespaces extension keys so different modules can use the same local key.

`cards(context)` is synchronous and reads a prepared snapshot. It must not fetch data, mutate the context, or perform actions. Network requests, cache expiry, settings, and endpoint lifecycle belong in a dedicated data controller, as they do for weather. When a controller has a new snapshot, call `app.refreshDashboards()`. This preserves the selected card and does not replace an active reader, transcript, or dictation flow. Returning home rebuilds the available cards; removed selections fall back to Ask assistant.

For example, a future normalized news snapshot can supply cards through this module:

```ts
import { fitLines } from './dashboard'
import type { DashboardModule } from './dashboard-modules'

interface Story { id: string; title: string; summary: string; text: string }
let stories: readonly Story[] = []

export function replaceStories(next: readonly Story[]) { stories = next }

export const newsDashboard: DashboardModule = {
  id: 'news',
  cards: () => stories.map(story => ({
    key: story.id,
    title: 'NEWS',
    body: `${fitLines(story.title, 288, 3)}\n\nTap to read`,
    action: { kind: 'reader', title: story.title, text: story.text },
  })),
}
```

Import `newsDashboard` into `dashboard-config.ts` and add it to `dashboardModules`. Its data controller calls `replaceStories(normalizedStories)` followed by `app.refreshDashboards()`. The reader snapshots and paginates the text when opened. Swipes change pages; double tap returns to the selected card. The native assistant menu works in the reader and cancellation restores its page.

Cards use the existing dashboard shell and clock/weather sidebar. New content types need no changes to gesture dispatch or glasses containers. A substantially different physical layout would need a separate `GlassesFrame` layout variant. The current shell truncates dashboard previews to two body lines within the 288-pixel text width; put longer content in the reader action. Module failures show an unavailable card while other modules stay usable.

The manual fixture has an **Add demo dashboard** control demonstrating this registration and reader path with synthetic content.

## Bridge services

The Mac bridge composes explicit service definitions through `bridge/src/service-registry.ts`. Weather already uses this route. Add a trusted service definition at `createBridgeServer`, with a namespace and named handlers. See [bridge extension guidance](../bridge/README.md#adding-bridge-services-for-dashboards).

Add each phone-facing method and normalized response type to `src/protocol.ts` so `T3BridgeClient.request` retains typed results. An external tool can use the existing authenticated WebSocket protocol and registered methods. Adding a service does not create a public HTTP endpoint or bypass authentication, origin checks, request limits, or safe error handling.

A future RSS service should fetch on the bridge, parse and bound external data there, and return normalized text records to the phone. Its controller must clear source-specific state and invalidate late responses when the endpoint or feed changes. Configure approved feeds on the bridge; do not turn the registry into a client-controlled URL fetcher or dynamic code loader. Service-specific validation, permissions, timeouts, caching, and resource limits remain the service's responsibility.

The 12-hour clock formatter is separate from drawing. It retains the actual 24-hour value for day/night weather icons and exposes explicit AM/PM for both the native panel and its accessible mirror.
