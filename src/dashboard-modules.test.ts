import { describe, expect, it } from 'vitest'
import { DashboardRegistry, type DashboardModule } from './dashboard-modules'
import { emptyNotifications } from './dashboard'

const context = () => ({ notifications: emptyNotifications(), sessions: [] })
const module = (id: string): DashboardModule => ({ id, cards: () => [{ key: 'assistant', title: 'News', body: 'A headline',
  action: { kind: 'reader', title: 'News', text: 'Article text' } }] })

describe('dashboard modules', () => {
  it('composes independent modules without collisions or changing built-in selection keys', () => {
    const cards = new DashboardRegistry([module('news'), module('tools')]).cards(context())
    expect(cards.map(card => card.key)).toEqual(['notifications', 'assistant', 'sessions', 'module:["news","assistant"]', 'module:["tools","assistant"]'])
    expect(cards[3]?.action.kind).toBe('reader')
  })
  it('rejects duplicate module registration and isolates a failed module', () => {
    expect(() => new DashboardRegistry([module('t3')])).toThrow('unique')
    const cards = new DashboardRegistry([{ id: 'broken', cards: () => { throw new Error('provider details') } }, module('news')]).cards(context())
    expect(cards).toHaveLength(5)
    expect(cards[3]?.title).toBe('DASHBOARD UNAVAILABLE')
    expect(JSON.stringify(cards)).not.toContain('provider details')
    expect(cards[4]?.title).toBe('News')
  })
})
