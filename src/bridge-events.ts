export function transcriptChangedThreadId(payload: unknown): string | null {
  return transcriptChangedSession(payload)?.threadId ?? null
}

export function transcriptChangedSession(payload: unknown): { threadId: string; environmentId?: string } | null {
  if (!isRecord(payload)) return null
  const threadId = typeof payload.threadId === 'string' ? payload.threadId
    : isRecord(payload.session) && typeof payload.session.id === 'string' ? payload.session.id : null
  if (!threadId) return null
  const environmentId = typeof payload.environmentId === 'string' ? payload.environmentId
    : isRecord(payload.session) && typeof payload.session.environmentId === 'string' ? payload.session.environmentId : undefined
  return { threadId, ...(environmentId ? { environmentId } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
