import { dashboardCards, type DashboardCard, type NotificationState } from './dashboard'
import type { SessionSummary } from './protocol'

export interface DashboardContext {
  testNotificationCount?: number
  notifications: NotificationState
  sessions: readonly SessionSummary[]
}

/** Trusted, statically imported modules return snapshots. Fetching belongs in their data controller. */
export interface DashboardModule {
  readonly id: string
  cards(context: DashboardContext): readonly DashboardCard[]
}

export const t3Dashboard: DashboardModule = {
  id: 't3',
  cards: context => dashboardCards(context.notifications, context.sessions, context.testNotificationCount),
}

export class DashboardRegistry {
  private readonly modules: readonly DashboardModule[]

  constructor(additionalModules: readonly DashboardModule[] = []) {
    this.modules = [t3Dashboard, ...additionalModules]
    if (new Set(this.modules.map(module => module.id)).size !== this.modules.length) {
      throw new Error('Dashboard module IDs must be unique')
    }
  }

  cards(context: DashboardContext): DashboardCard[] {
    return this.modules.flatMap(module => {
      try {
        const cards = module.cards(context)
        if (new Set(cards.map(card => card.key)).size !== cards.length) throw new Error('Duplicate dashboard card key')
        return cards.map(card => ({ ...card,
          // Preserve existing notification/assistant selection keys. Extension keys cannot collide.
          key: module.id === 't3' ? card.key : `module:${JSON.stringify([module.id, card.key])}`,
        }))
      } catch {
        return [{ key: `module:${JSON.stringify([module.id, 'unavailable'])}`, title: 'DASHBOARD UNAVAILABLE',
          body: 'This dashboard could not load.',
          action: { kind: 'reader' as const, title: 'Dashboard unavailable', text: 'Try refreshing this dashboard from its phone settings.' } }]
      }
    })
  }
}
