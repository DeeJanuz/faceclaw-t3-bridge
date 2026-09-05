import { normalizeBridgeWebSocketUrl } from './connection-profile'
import type { DashboardStorage } from './dashboard-settings'
import type { PendingPlanInput, PlanAnswer, PlanQuestion } from './protocol'

export interface PlanDraft { answers: PlanAnswer[]; submitted: boolean }
interface Entry extends PlanDraft { threadId: string; requestId: string; revision: string; updatedAt: number }
interface EndpointState { entries: Entry[]; loaded: boolean; writable: boolean; queue: Promise<unknown> }
const states = new WeakMap<DashboardStorage, Map<string, EndpointState>>()
const MAX_AGE = 7 * 24 * 60 * 60_000
const MAX_BYTES = 200_000
const ID = /^[A-Za-z0-9._:-]{1,128}$/
const STORAGE_TIMEOUT_MS = 2000

async function boundedNative<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Native storage unavailable')), STORAGE_TIMEOUT_MS)
    })])
  } finally { if (timer !== undefined) clearTimeout(timer) }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value &&
    !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
}

export function parsePendingPlanInput(value: unknown): PendingPlanInput | null {
  const r = record(value)
  if (!r || !text(r.requestId, 256) || typeof r.revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.revision) ||
      !(r.turnId === null || (typeof r.turnId === 'string' && ID.test(r.turnId))) ||
      typeof r.createdAt !== 'string' || r.createdAt.length > 40 || !Number.isFinite(Date.parse(r.createdAt)) ||
      new Date(r.createdAt).toISOString() !== r.createdAt || !Array.isArray(r.questions) ||
      r.questions.length === 0 || r.questions.length > 12) return null
  const questions: PlanQuestion[] = []
  const ids = new Set<string>()
  for (const raw of r.questions) {
    const q = record(raw)
    if (!q || !text(q.id, 2000) || ids.has(q.id) || !text(q.header, 200) || !text(q.question, 4000) ||
        typeof q.multiSelect !== 'boolean' || !Array.isArray(q.options) || q.options.length > 12) return null
    const options: PlanQuestion['options'] = []
    const labels = new Set<string>()
    for (const rawOption of q.options) {
      const option = record(rawOption)
      if (!option || !text(option.label, 500) || !text(option.description, 2000) || labels.has(option.label)) return null
      options.push({ label: option.label, description: option.description })
      labels.add(option.label)
    }
    ids.add(q.id)
    questions.push({ id: q.id, header: q.header, question: q.question, multiSelect: q.multiSelect, options })
  }
  if (JSON.stringify(questions).length > 32_000) return null
  return { requestId: r.requestId, revision: r.revision, turnId: r.turnId, createdAt: r.createdAt, questions }
}

function parseAnswers(value: unknown, request?: PendingPlanInput): PlanAnswer[] | null {
  if (!Array.isArray(value) || value.length > 12) return null
  const answers: PlanAnswer[] = []
  const ids = new Set<string>()
  let chars = 0
  for (const raw of value) {
    const a = record(raw)
    if (!a || !text(a.questionId, 2000) || ids.has(a.questionId) || !Array.isArray(a.optionIndexes) ||
        a.optionIndexes.length > 12 || typeof a.text !== 'string' || a.text.length > 8000 ||
        (a.text !== '' && !text(a.text, 8000)) ||
        (a.text !== '' && a.optionIndexes.length > 0) || (a.text === '' && a.optionIndexes.length === 0)) return null
    const question = request?.questions.find(q => q.id === a.questionId)
    if (request && (!question || (!question.multiSelect && a.optionIndexes.length > 1))) return null
    const indexes: number[] = []
    for (const index of a.optionIndexes) {
      if (!Number.isInteger(index) || index < 0 || index >= (question?.options.length ?? 12) || indexes.includes(index)) return null
      indexes.push(index)
    }
    chars += a.text.length + indexes.reduce((sum, index) => sum + (question?.options[index]?.label.length ?? 0), 0)
    if (chars > 8000) return null
    ids.add(a.questionId)
    answers.push({ questionId: a.questionId, optionIndexes: indexes, text: a.text })
  }
  return answers
}

export function validatePlanDraftAnswers(request: PendingPlanInput, value: unknown, complete = false): PlanAnswer[] | null {
  const answers = parseAnswers(value, request)
  return answers && (!complete || answers.length === request.questions.length) ? answers : null
}

function parseEntries(value: unknown): Entry[] {
  if (!Array.isArray(value) || value.length > 16) return []
  const entries: Entry[] = []
  const now = Date.now()
  for (const raw of value) {
    const r = record(raw)
    if (!r || typeof r.threadId !== 'string' || !ID.test(r.threadId) || !text(r.requestId, 256) ||
        typeof r.revision !== 'string' || !/^[a-f0-9]{64}$/.test(r.revision) || typeof r.submitted !== 'boolean' ||
        typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt) || r.updatedAt > now + 60_000 || now - r.updatedAt > MAX_AGE) continue
    const answers = parseAnswers(r.answers)
    if (!answers) continue
    entries.push({ threadId: r.threadId, requestId: r.requestId, revision: r.revision, updatedAt: r.updatedAt, submitted: r.submitted, answers })
  }
  return entries
}

function stateFor(storage: DashboardStorage, endpoint: string): { key: string; state: EndpointState } {
  const key = `t3-plan-drafts-v1:${normalizeBridgeWebSocketUrl(endpoint)}`
  let endpoints = states.get(storage)
  if (!endpoints) { endpoints = new Map(); states.set(storage, endpoints) }
  let state = endpoints.get(key)
  if (!state) {
    if (endpoints.size >= 8) endpoints.delete(endpoints.keys().next().value!)
    state = { entries: [], loaded: false, writable: true, queue: Promise.resolve() }
    endpoints.set(key, state)
  }
  return { key, state }
}

async function withState<T>(storage: DashboardStorage, endpoint: string, action: (state: EndpointState, key: string) => Promise<T>): Promise<T> {
  const { key, state } = stateFor(storage, endpoint)
  const task = state.queue.then(async () => {
    if (!state.loaded) {
      try {
        const raw = await boundedNative(storage.getLocalStorage(key))
        state.entries = typeof raw === 'string' && raw.length <= MAX_BYTES && raw.length > 0 ? parseEntries(JSON.parse(raw)) : []
      } catch {
        // Do not replace unknown native contents after an unsuccessful read.
        state.writable = false
      }
      state.loaded = true
    }
    state.entries = state.entries.filter(entry => Date.now() - entry.updatedAt <= MAX_AGE)
    return action(state, key)
  })
  state.queue = task.catch(() => undefined)
  return task
}

function matches(entry: Entry, threadId: string, request: PendingPlanInput): boolean {
  return entry.threadId === threadId && entry.requestId === request.requestId && entry.revision === request.revision
}
async function persist(storage: DashboardStorage, key: string, state: EndpointState): Promise<boolean> {
  if (!state.writable) return false
  try {
    const raw = JSON.stringify(state.entries)
    if (raw.length > MAX_BYTES) return false
    if (await boundedNative(storage.setLocalStorage(key, raw)) !== true ||
        await boundedNative(storage.getLocalStorage(key)) !== raw) {
      state.writable = false
      return false
    }
    return true
  } catch {
    // A timed-out write can still finish in the host. Quarantine further writes
    // in this app session to avoid late old data replacing an acknowledged save.
    state.writable = false
    return false
  }
}

export async function loadPlanDraft(storage: DashboardStorage, endpoint: string, threadId: string, request: PendingPlanInput): Promise<PlanDraft> {
  try {
    if (!ID.test(threadId) || !parsePendingPlanInput(request)) return { answers: [], submitted: false }
    return await withState(storage, endpoint, async state => {
      const entry = state.entries.find(e => matches(e, threadId, request))
      const answers = entry ? parseAnswers(entry.answers, request) : null
      return { answers: answers ?? [], submitted: entry?.submitted === true }
    })
  } catch { return { answers: [], submitted: false } }
}

export async function savePlanDraft(storage: DashboardStorage, endpoint: string, threadId: string, request: PendingPlanInput, answers: PlanAnswer[], submitted = false): Promise<boolean> {
  try {
    const valid = parsePendingPlanInput(request)
    const parsed = valid ? parseAnswers(answers, valid) : null
    if (!ID.test(threadId) || !valid || !parsed || (submitted && parsed.length !== valid.questions.length)) return false
    return await withState(storage, endpoint, async (state, key) => {
      const previous = state.entries.find(e => matches(e, threadId, valid))
      // Once submitted, a queued autosave must never alter the batch or unlock it.
      const entry: Entry = previous?.submitted ? previous : {
        threadId, requestId: valid.requestId, revision: valid.revision, updatedAt: Date.now(), answers: parsed, submitted,
      }
      state.entries = [...state.entries.filter(e => !(e.threadId === threadId && e.requestId === valid.requestId)), entry].slice(-16)
      return persist(storage, key, state)
    })
  } catch { return false }
}

export async function clearPlanDraft(storage: DashboardStorage, endpoint: string, threadId: string, request: PendingPlanInput): Promise<boolean> {
  try {
    if (!ID.test(threadId) || !parsePendingPlanInput(request)) return false
    return await withState(storage, endpoint, async (state, key) => {
      state.entries = state.entries.filter(e => !matches(e, threadId, request))
      return persist(storage, key, state)
    })
  } catch { return false }
}
