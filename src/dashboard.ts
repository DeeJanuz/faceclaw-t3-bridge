import { getTextWidth } from '@evenrealities/pretext'
import { normalizeBridgeWebSocketUrl } from './connection-profile'
import { projectAbbreviations } from './view-model'
import type { ProjectSummary, SessionSummary, SessionsListResult } from './protocol'

export const ASK_ASSISTANT_MENU_ID = 1
export const SETTLE_SESSION_MENU_ID = 3
export const MAX_ALERTS = 50
export interface AlertReference { threadId: string; turnId: string; completedAt: string }
export interface NotificationState {
  initialized: boolean
  watermark: string
  markers: AlertReference[]
  unread: AlertReference[]
}
export type DashboardAction =
  | { kind: 'phone'; key: string }
  | { kind: 'assistant' }
  | { kind: 'sessions' }
  | { kind: 'notifications' }
  | { kind: 'projects' }
  | { kind: 'alert'; alert: AlertReference }
  | { kind: 'reader'; title: string; text: string }
export interface DashboardCard { key: string; title: string; body: string; action: DashboardAction; notification?: { label: string; completedAt: string } }

export function emptyNotifications(): NotificationState {
  return { initialized: false, watermark: '', markers: [], unread: [] }
}

export function notificationKey(alert: AlertReference): string {
  return JSON.stringify([alert.threadId, alert.turnId])
}

export function reconcileNotifications(state: NotificationState, snapshot: SessionsListResult): NotificationState {
  const sessions = [...snapshot.unsettled, ...snapshot.settled]
  const visible = new Set(sessions.map(session => session.id))
  const awaiting = new Set(sessions.filter(session => !session.settled && !['running', 'starting'].includes(session.status)).map(session => session.id))
  const completed = sessions.flatMap(session => session.completedTurn ? [{
    threadId: session.id, turnId: session.completedTurn.id, completedAt: session.completedTurn.completedAt,
  }] : []).sort((a, b) => b.completedAt.localeCompare(a.completedAt))
  const markers = new Map(state.markers.map(marker => [marker.threadId, marker]))
  const unread = new Map(state.unread.filter(alert => awaiting.has(alert.threadId)).map(alert => [notificationKey(alert), alert]))
  if (state.initialized) {
    for (const alert of completed) {
      const previous = markers.get(alert.threadId)
      if (previous ? previous.turnId !== alert.turnId && alert.completedAt >= previous.completedAt : alert.completedAt > state.watermark) {
        if (awaiting.has(alert.threadId)) unread.set(notificationKey(alert), alert)
      }
    }
  }
  const watermark = [state.watermark, snapshot.frozenAt, ...completed.map(alert => alert.completedAt)].sort().at(-1) ?? ''
  // Keep markers for running threads too, so their prior completion remains known.
  for (const alert of completed) markers.set(alert.threadId, alert)
  return {
    initialized: true,
    watermark,
    markers: [...markers.values()].filter(marker => visible.has(marker.threadId))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, MAX_ALERTS),
    unread: [...unread.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, MAX_ALERTS),
  }
}

export function markAlertRead(state: NotificationState, alert: AlertReference): NotificationState {
  return { ...state, unread: state.unread.filter(item => notificationKey(item) !== notificationKey(alert)) }
}

export function markSessionRead(state: NotificationState, session: Pick<SessionSummary, 'id' | 'completedTurn'>): NotificationState {
  const markers = new Map(state.markers.map(marker => [marker.threadId, marker]))
  const previous = markers.get(session.id)
  const hasUnread = state.unread.some(alert => alert.threadId === session.id)
  const newMarker = session.completedTurn && (!previous || (session.completedTurn.completedAt >= previous.completedAt && session.completedTurn.id !== previous.turnId))
  if (!hasUnread && !newMarker) return state
  if (session.completedTurn && (!previous || session.completedTurn.completedAt >= previous.completedAt)) {
    markers.set(session.id, { threadId: session.id, turnId: session.completedTurn.id, completedAt: session.completedTurn.completedAt })
  }
  return { ...state, unread: state.unread.filter(alert => alert.threadId !== session.id),
    markers: [...markers.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt)).slice(0, MAX_ALERTS) }
}

export function notificationCards(state: NotificationState, sessions: readonly SessionSummary[], projects: readonly ProjectSummary[] = []): DashboardCard[] {
  const abbreviations = projectAbbreviations([...sessions.map(session => ({ id: session.projectId, title: session.projectTitle })), ...projects])
  return state.unread.map(alert => {
    const session = sessions.find(item => item.id === alert.threadId)
    const label = fitLines(`${abbreviations.get(session?.projectId ?? '') ?? '??'} - ${session?.title ?? 'T3 session'}`, 252, 1)
    return {
      key: notificationKey(alert), title: 'Awaiting input', action: { kind: 'alert' as const, alert },
      notification: { label, completedAt: alert.completedAt }, body: `Awaiting input\n${label}`,
    }
  })
}

export function dashboardCards(state: NotificationState, _sessions: readonly SessionSummary[], testCount = 0): DashboardCard[] {
  const count = state.unread.length + testCount
  return [
    { key: 'notifications', title: `Notifications ${count}`, body: '',
      action: { kind: 'notifications' as const } },
    { key: 'assistant', title: 'Ask assistant', body: '', action: { kind: 'assistant' } },
    { key: 'sessions', title: 'Sessions', body: '', action: { kind: 'sessions' } },
  ]
}

export function fitLines(text: string, width: number, limit: number): string {
  const lines: string[] = ['']
  for (const word of text.replace(/\s+/g, ' ').trim().slice(0, 1000).split(' ')) {
    const last = lines.length - 1
    const combined = lines[last] ? `${lines[last]} ${word}` : word
    if (getTextWidth(combined) <= width) lines[last] = combined
    else {
      if (lines[last]) lines.push('')
      for (const char of word) {
        const current = lines.length - 1
        if (getTextWidth(lines[current] + char) <= width) lines[current] += char
        else lines.push(char)
      }
    }
  }
  const visible = lines.slice(0, limit)
  if (lines.length > limit) {
    const last = visible.length - 1
    while (visible[last] && getTextWidth(`${visible[last]}...`) > width) visible[last] = visible[last].slice(0, -1)
    visible[last] = `${visible[last].trimEnd()}...`
  }
  return visible.join('\n')
}

export function parseNotifications(raw: string | null): NotificationState {
  try {
    if (!raw || raw.length > 100_000) return emptyNotifications()
    const value = JSON.parse(raw)
    if (value?.version !== 1 || value.initialized !== true || !validDate(value.watermark)) return emptyNotifications()
    const parse = (items: unknown): AlertReference[] => Array.isArray(items)
      ? [...new Map(items.slice(0, MAX_ALERTS).filter(validAlert).map(item => [notificationKey(item), {
        threadId: item.threadId, turnId: item.turnId, completedAt: item.completedAt,
      }])).values()] : []
    return { initialized: true, watermark: value.watermark, markers: parse(value.markers), unread: parse(value.unread) }
  } catch { return emptyNotifications() }
}

function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
}
function validAlert(value: unknown): value is AlertReference {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return [item.threadId, item.turnId].every(validId)
    && validDate(item.completedAt)
}

export function notificationStorageKey(url: string): string {
  return `t3-dashboard-notifications-v1:${normalizeBridgeWebSocketUrl(url)}`
}

/** Reject malformed snapshots before they alter the notification baseline or navigation. */
export function parseSessionsSnapshot(value: unknown): SessionsListResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const data = value as Record<string, unknown>
  if (typeof data.snapshotId !== 'string' || data.snapshotId.length > 200 ||
      !validDate(data.frozenAt) || !Array.isArray(data.unsettled) || !Array.isArray(data.settled) ||
      data.unsettled.length + data.settled.length > 10_000) return null
  const ids = new Set<string>()
  const parse = (items: unknown[]): SessionSummary[] | null => {
    const result: SessionSummary[] = []
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return null
      const s = item as Record<string, unknown>
      if (!validId(s.id) || ids.has(s.id) || !validId(s.projectId) ||
          typeof s.title !== 'string' || s.title.length > 10_000 ||
          typeof s.projectTitle !== 'string' || s.projectTitle.length > 10_000 ||
          typeof s.status !== 'string' || s.status.length > 100 ||
          typeof s.settled !== 'boolean' || typeof s.lastActivityAt !== 'string' || s.lastActivityAt.length > 40) return null
      ids.add(s.id)
      let completedTurn: SessionSummary['completedTurn'] = null
      if (s.completedTurn !== undefined && s.completedTurn !== null) {
        if (typeof s.completedTurn !== 'object' || Array.isArray(s.completedTurn)) return null
        const turn = s.completedTurn as Record<string, unknown>
        if (!validId(turn.id) || !validDate(turn.completedAt)) return null
        completedTurn = { id: turn.id, completedAt: turn.completedAt }
      }
      result.push({ id: s.id, projectId: s.projectId, title: s.title, projectTitle: s.projectTitle,
        status: s.status, settled: s.settled, lastActivityAt: s.lastActivityAt, completedTurn })
    }
    return result
  }
  const unsettled = parse(data.unsettled), settled = parse(data.settled)
  return unsettled && settled ? { snapshotId: data.snapshotId, frozenAt: data.frozenAt, unsettled, settled } : null
}
