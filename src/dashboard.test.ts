import { describe, expect, it } from 'vitest'
import { dashboardCards, emptyNotifications, markAlertRead, markSessionRead, notificationCards, parseNotifications, reconcileNotifications } from './dashboard'
import type { SessionSummary, SessionsListResult } from './protocol'

const date = (n: number) => `2026-09-04T12:${String(n).padStart(2, '0')}:00.000Z`
function session(id: string, turn: string | null, minute: number): SessionSummary {
  return { id, projectId: 'p', projectTitle: 'Project', title: 'Conversation', settled: false, status: 'idle', lastActivityAt: date(minute),
    completedTurn: turn ? { id: turn, completedAt: date(minute) } : null }
}
const snapshot = (minute: number, ...sessions: SessionSummary[]): SessionsListResult => ({
  snapshotId: String(minute), frozenAt: date(minute), unsettled: sessions, settled: [],
})

describe('dashboard alerts', () => {
  it.each(['running', 'starting'])('clears every old alert when a thread is %s and alerts again only on a later completion', (status) => {
    let state = reconcileNotifications(emptyNotifications(), snapshot(0))
    for (let minute = 1; minute <= 3; minute++) {
      state = reconcileNotifications(state, snapshot(minute, session('a', `turn-${minute}`, minute), session('b', 'other', 1)))
    }
    expect(state.unread.filter(alert => alert.threadId === 'a')).toHaveLength(3)
    state = reconcileNotifications(state, snapshot(4, { ...session('a', 'turn-3', 3), status }, session('b', 'other', 1)))
    expect(state.unread.map(alert => alert.threadId)).toEqual(['b'])
    state = parseNotifications(JSON.stringify({ version: 1, ...state }))
    state = reconcileNotifications(state, snapshot(5, session('a', 'turn-3', 3), session('b', 'other', 1)))
    expect(state.unread.map(alert => alert.threadId)).toEqual(['b'])
    state = reconcileNotifications(state, snapshot(6, session('a', 'turn-4', 6), session('b', 'other', 1)))
    expect(state.unread.map(alert => alert.turnId)).toEqual(['turn-4', 'other'])
  })
  it('records completions reported during active work without adding stale alerts when work stops', () => {
    const initial = reconcileNotifications(emptyNotifications(), snapshot(0))
    const working = reconcileNotifications(initial, snapshot(2, { ...session('a', 'turn', 1), status: 'running' }))
    expect(working.unread).toEqual([])
    expect(working.markers.map(marker => marker.turnId)).toEqual(['turn'])
    expect(reconcileNotifications(working, snapshot(3, session('a', 'turn', 1))).unread).toEqual([])
  })
  it('orders previews by completion and uses the same project abbreviations as Sessions', () => {
    const sessions = [{ ...session('a', 'new', 3), projectId: 'bit', projectTitle: 'BitBooks', title: 'A very long session title '.repeat(5) },
      { ...session('b', 'old', 2), projectId: 'bz', projectTitle: 'BZAC' }]
    const state = reconcileNotifications(reconcileNotifications(emptyNotifications(), snapshot(0)), snapshot(4, ...sessions))
    const cards = notificationCards(state, sessions)
    expect(cards[0]!.notification!.label).toMatch(/^B1 - /)
    expect(cards[0]!.notification!.label).toContain('...')
    expect(cards[1]!.notification!.label).toMatch(/^B2 - /)
    expect(cards[0]!.body).toMatch(/^Awaiting input/)
    expect(dashboardCards(state, sessions)[0]!.key).toBe('notifications')
  })
  it('persists a viewed completion marker even if its list event arrives later', () => {
    const initial = reconcileNotifications(emptyNotifications(), snapshot(0, session('a', null, 0)))
    const viewed = markSessionRead(initial, session('a', 'turn', 2))
    const restored = parseNotifications(JSON.stringify({ version: 1, ...viewed }))
    expect(reconcileNotifications(restored, snapshot(3, session('a', 'turn', 2))).unread).toEqual([])
    const settled = { ...session('a', 'next', 4), settled: true }
    const state = reconcileNotifications(restored, snapshot(5, settled))
    expect(state.unread).toEqual([])
    expect(reconcileNotifications(state, snapshot(6, { ...settled, settled: false })).unread).toEqual([])
  })
  it('silently establishes baseline, alerts on completed turns, and deduplicates snapshots', () => {
    let state = reconcileNotifications(emptyNotifications(), snapshot(1, session('a', 'old', 0)))
    expect(state.unread).toEqual([])
    state = reconcileNotifications(state, snapshot(3, session('a', 'new', 2)))
    expect(state.unread).toHaveLength(1)
    expect(reconcileNotifications(state, snapshot(4, session('a', 'new', 2))).unread).toHaveLength(1)
    const read = markAlertRead(state, state.unread[0]!)
    expect(reconcileNotifications(read, snapshot(5, session('a', 'new', 2))).unread).toEqual([])
  })
  it('catches completion after reconnect but never treats settlement as completion', () => {
    const initial = reconcileNotifications(emptyNotifications(), snapshot(1, session('a', null, 1)))
    const restored = parseNotifications(JSON.stringify({ version: 1, ...initial }))
    const done = reconcileNotifications(restored, snapshot(3, session('a', 't', 2)))
    expect(done.unread).toHaveLength(1)
    const legacy = session('b', null, 3)
    delete legacy.completedTurn
    legacy.settled = true
    expect(reconcileNotifications(done, snapshot(4, session('a', 't', 2), legacy)).unread).toHaveLength(1)
  })
  it('bounds references, removes inaccessible threads, and excludes text from storage', () => {
    const initial = reconcileNotifications(emptyNotifications(), snapshot(0))
    const sessions = Array.from({ length: 70 }, (_, i) => session(String(i), 'turn', 1))
    const state = reconcileNotifications(initial, snapshot(2, ...sessions))
    expect(state.unread).toHaveLength(50)
    expect(state.markers).toHaveLength(50)
    expect(JSON.stringify(state)).not.toContain('Conversation')
    expect(reconcileNotifications(state, snapshot(3)).unread).toEqual([])
  })
  it('keeps action keys stable and restores corrupted storage to a clean baseline', () => {
    expect(dashboardCards(emptyNotifications(), []).map(card => card.key)).toEqual(['notifications', 'assistant', 'sessions'])
    expect(parseNotifications('{bad')).toEqual(emptyNotifications())
  })
})
