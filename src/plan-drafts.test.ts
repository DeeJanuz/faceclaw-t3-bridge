import { describe, expect, it, vi } from 'vitest'
import { clearPlanDraft, loadPlanDraft, parsePendingPlanInput, savePlanDraft, validatePlanDraftAnswers } from './plan-drafts'
import type { PendingPlanInput, PlanAnswer } from './protocol'

const url = 'wss://bridge.example/v1/events'
const request: PendingPlanInput = { requestId: 'request', revision: 'a'.repeat(64), turnId: 'turn', createdAt: '2026-09-04T10:00:00.000Z',
  questions: [{ id: 'What should we do?', header: 'Choice', question: 'What should we do?', multiSelect: false,
    options: [{ label: 'Small', description: 'One change' }] }] }
const answers: PlanAnswer[] = [{ questionId: request.questions[0].id, optionIndexes: [0], text: '' }]
function fixture() {
  const values = new Map<string, string>()
  const wrapper = () => ({ getLocalStorage: async (key: string) => values.get(key) ?? null,
    setLocalStorage: async (key: string, value: string) => { values.set(key, value); return true } })
  return { values, wrapper, storage: wrapper() }
}

describe('plan draft storage boundary', () => {
  it('bounds hung native reads and avoids overwriting unknown stored contents', async () => {
    vi.useFakeTimers()
    try {
      const storage = { getLocalStorage: async (): Promise<string | null> => new Promise(() => undefined), setLocalStorage: vi.fn(async () => true) }
      const loading = loadPlanDraft(storage, url, 'thread', request)
      await vi.advanceTimersByTimeAsync(2000)
      expect(await loading).toEqual({ answers: [], submitted: false })
      expect(await savePlanDraft(storage, url, 'thread', request, answers)).toBe(false)
      expect(storage.setLocalStorage).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
  it('bounds unknown native writes, keeps memory, and prevents late-write reordering', async () => {
    vi.useFakeTimers()
    try {
      const storage = { getLocalStorage: async () => null, setLocalStorage: vi.fn(async (): Promise<boolean> => new Promise(() => undefined)) }
      const saving = savePlanDraft(storage, url, 'thread', request, answers)
      await vi.advanceTimersByTimeAsync(2000)
      expect(await saving).toBe(false)
      const custom = [{ questionId: request.questions[0].id, optionIndexes: [], text: 'Latest local choice' }]
      expect(await savePlanDraft(storage, url, 'thread', request, custom)).toBe(false)
      expect((await loadPlanDraft(storage, url, 'thread', request)).answers).toEqual(custom)
      expect(storage.setLocalStorage).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers() }
  })
  it('counts selected labels and dictated text toward the complete batch limit', () => {
    const multi = { ...request, questions: [{ ...request.questions[0], multiSelect: true,
      options: Array.from({ length: 12 }, (_, i) => ({ label: String(i).padEnd(500, 'x'), description: 'Choice' })) },
      { ...request.questions[0], id: 'custom' }] }
    expect(validatePlanDraftAnswers(multi, [
      { questionId: multi.questions[0].id, optionIndexes: Array.from({ length: 12 }, (_, i) => i), text: '' },
      { questionId: 'custom', optionIndexes: [], text: 'x'.repeat(2001) },
    ], true)).toBeNull()
  })
  it('restores partial choices across a new SDK wrapper, scoped to endpoint/thread/request/revision', async () => {
    const f = fixture()
    expect(await savePlanDraft(f.storage, url, 'thread', request, answers)).toBe(true)
    expect(await loadPlanDraft(f.wrapper(), 'wss://BRIDGE.example:443/v1/events', 'thread', request)).toEqual({ answers, submitted: false })
    for (const [endpoint, thread, pending] of [[url, 'other', request], ['wss://other.example/v1/events', 'thread', request],
      [url, 'thread', { ...request, requestId: 'other' }], [url, 'thread', { ...request, revision: 'b'.repeat(64) }]] as const) {
      expect(await loadPlanDraft(f.storage, endpoint, thread, pending)).toEqual({ answers: [], submitted: false })
    }
    expect([...f.values.values()].join()).not.toContain('One change')
  })
  it('serializes writes and keeps submitted batches immutable across queued partial edits and reopen', async () => {
    const f = fixture()
    const custom = [{ questionId: request.questions[0].id, optionIndexes: [], text: 'Different answer' }]
    await Promise.all([savePlanDraft(f.storage, url, 'thread', request, answers), savePlanDraft(f.storage, url, 'thread', request, answers, true),
      savePlanDraft(f.storage, url, 'thread', request, custom)])
    expect(await loadPlanDraft(f.wrapper(), url, 'thread', request)).toEqual({ answers, submitted: true })
    expect(await clearPlanDraft(f.storage, url, 'thread', request)).toBe(true)
    expect(await loadPlanDraft(f.wrapper(), url, 'thread', request)).toEqual({ answers: [], submitted: false })
  })
  it('retains memory on native failure without claiming durable success', async () => {
    for (const setLocalStorage of [async () => false, async () => true, async (): Promise<boolean> => { throw new Error('native failed') }]) {
      const storage = { getLocalStorage: async () => null, setLocalStorage }
      expect(await savePlanDraft(storage, url, 'thread', request, answers, true)).toBe(false)
      expect(await loadPlanDraft(storage, url, 'thread', request)).toEqual({ answers, submitted: true })
    }
  })
  it('rejects malformed input, missing full-set submit locks and credential-bearing endpoints', async () => {
    const f = fixture()
    for (const invalid of [[{ ...answers[0], optionIndexes: [99] }], [{ ...answers[0], text: 'mixed' }],
      [{ ...answers[0], questionId: 'unknown' }], [answers[0], answers[0]], [{ ...answers[0], optionIndexes: [], text: 'x'.repeat(8001) }]]) {
      expect(await savePlanDraft(f.storage, url, 'thread', request, invalid)).toBe(false)
    }
    expect(await savePlanDraft(f.storage, url, 'thread', request, [], true)).toBe(false)
    expect(await savePlanDraft(f.storage, 'wss://user:secret@bridge.example/v1/events', 'thread', request, answers)).toBe(false)
    expect(f.values.size).toBe(0)
  })
  it('bounds retained drafts and expires them after seven days', async () => {
    const f = fixture()
    for (let i = 0; i < 18; i++) await savePlanDraft(f.storage, url, `thread-${i}`, request, answers)
    expect(JSON.parse([...f.values.values()][0]).length).toBe(16)
    expect((await loadPlanDraft(f.wrapper(), url, 'thread-0', request)).answers).toEqual([])
    const now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60_000)
    try { expect((await loadPlanDraft(f.wrapper(), url, 'thread-17', request)).answers).toEqual([]) } finally { clock.mockRestore() }
  })
  it('ignores corrupt/oversized storage and malformed bridge question metadata', async () => {
    for (const raw of ['{', 'x'.repeat(200_001), JSON.stringify([{ threadId: 'thread', answers: [] }])]) {
      expect(await loadPlanDraft({ getLocalStorage: async () => raw, setLocalStorage: async () => true }, url, 'thread', request)).toEqual({ answers: [], submitted: false })
    }
    expect(parsePendingPlanInput(request)).toEqual(request)
    for (const invalid of [{ ...request, revision: 'invalid' }, { ...request, questions: [request.questions[0], request.questions[0]] },
      { ...request, createdAt: 'invalid' }, { ...request, questions: [{ ...request.questions[0], options: [{ label: '', description: 'x' }] }] }]) {
      expect(parsePendingPlanInput(invalid)).toBeNull()
    }
  })
})
