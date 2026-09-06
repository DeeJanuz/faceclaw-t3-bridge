/** Pixel-aligned Even OS geometry shared by native rendering and the phone mirror. */
export interface OsRect { x: number; y: number; width: number; height: number }
export type OsMotionDirection = 'expand' | 'collapse' | 'drop' | 'retract' | 'rise' | 'lower'
export interface OsMotion { direction: OsMotionDirection; id: number; from: OsRect; to: OsRect }
export const OS_MOTION_DURATION_MS = 135
export const OS_FULL: OsRect = { x: 0, y: 0, width: 576, height: 288 }
export const OS_NOTIFICATION: OsRect = { x: 16, y: 12, width: 544, height: 104 }
export const OS_NOTIFICATION_CLOSED: OsRect = { x: 16, y: 0, width: 544, height: 2 }
export const OS_READER_CLOSED: OsRect = { x: 0, y: 286, width: 576, height: 2 }
export function homeFocusRect(actions?: Array<{ key?: string; selected: boolean; previews?: string[] }>): OsRect {
  const selected = actions?.find(action => action.selected)
  if (selected?.key === 'notifications') return { x: 367, y: 14, width: 180, height: 40 }
  const rows = actions?.filter(action => action.key !== 'notifications') ?? []
  const index = Math.max(0, rows.findIndex(action => action.selected))
  return { x: 259, y: 95 + index * 54, width: 288, height: rows[index]?.previews?.length ? 154 : 44 }
}
export function interpolateRect(from: OsRect, to: OsRect, progress: number): OsRect {
  return Object.fromEntries((['x', 'y', 'width', 'height'] as const).map(key =>
    [key, Math.round(from[key] + (to[key] - from[key]) * progress)])) as unknown as OsRect
}
