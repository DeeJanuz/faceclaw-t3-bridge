import { describe, expect, it } from 'vitest'
import { emptyNotifications, notificationStorageKey, parseNotifications, parseSessionsSnapshot } from './dashboard'

const date = '2026-09-04T12:00:00.000Z'
const session = { id: 'thread', projectId: 'project', title: 'Title', projectTitle: 'Project', settled: false,
  lastActivityAt: date, status: 'ready', completedTurn: { id: 'turn', completedAt: date } }
const snapshot = { snapshotId: '1', frozenAt: date, unsettled: [session], settled: [] }

describe('dashboard storage and event validation', () => {
  it('accepts current and legacy snapshots and strips unexpected fields', () => {
    expect(parseSessionsSnapshot({ ...snapshot, token: 'secret' })).toEqual(snapshot)
    expect(parseSessionsSnapshot({ ...snapshot, unsettled: [{ ...session, completedTurn: undefined }] })?.unsettled[0]?.completedTurn).toBeNull()
    expect(notificationStorageKey('wss://BRIDGE.example:443/v1/events')).toBe(notificationStorageKey('wss://bridge.example/v1/events'))
  })
  it('rejects malformed arrays, duplicate IDs, unbounded fields and invalid completion metadata', () => {
    for (const value of [null, [], { ...snapshot, unsettled: {} }, { ...snapshot, settled: [session] },
      { ...snapshot, frozenAt: '2026' }, { ...snapshot, unsettled: [{ ...session, title: 'x'.repeat(10001) }] },
      { ...snapshot, unsettled: [{ ...session, completedTurn: { id: 'turn\nspoof', completedAt: date } }] },
      { ...snapshot, unsettled: [{ ...session, completedTurn: { id: 'turn', completedAt: '2026-02-30T12:00:00.000Z' } }] }]) {
      expect(parseSessionsSnapshot(value)).toBeNull()
    }
  })
  it('allows the same thread id in different environments while rejecting a duplicate composite id', () => {
    const studio = { ...session, environmentId: 'studio', environmentLabel: 'Studio Mac' }
    const laptop = { ...session, environmentId: 'laptop', environmentLabel: 'Laptop' }
    expect(parseSessionsSnapshot({ ...snapshot, unsettled: [studio, laptop] })?.unsettled)
      .toEqual([studio, laptop])
    expect(parseSessionsSnapshot({ ...snapshot, unsettled: [studio, studio] })).toBeNull()
  })
  it('drops malformed alerts and noncanonical timestamps without persisting content', () => {
    const valid = { threadId: 'thread', turnId: 'turn', completedAt: date, text: 'private response' }
    const stored = { version: 1, initialized: true, watermark: date,
      markers: [valid, { ...valid, turnId: '../other' }], unread: [valid, valid, { ...valid, completedAt: '2026' }] }
    const parsed = parseNotifications(JSON.stringify(stored))
    expect(parsed.markers).toHaveLength(1)
    expect(parsed.unread).toHaveLength(1)
    expect(JSON.stringify(parsed)).not.toContain('private response')
    expect(parseNotifications(JSON.stringify({ ...stored, watermark: '2026' }))).toEqual(emptyNotifications())
  })
})
