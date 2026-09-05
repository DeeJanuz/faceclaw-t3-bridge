export function transcriptChangedThreadId(payload: unknown): string | null {
  if (!isRecord(payload)) return null
  if (typeof payload.threadId === 'string') return payload.threadId
  return isRecord(payload.session) && typeof payload.session.id === 'string'
    ? payload.session.id
    : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
