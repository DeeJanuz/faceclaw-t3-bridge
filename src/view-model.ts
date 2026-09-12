import { getTextWidth, measureTextWrap } from '@evenrealities/pretext'
import type {
  LiveToolActivity,
  ModelSummary,
  ProjectSummary,
  ReasoningChoice,
  SessionSummary,
  SessionsListResult,
  TranscriptTurn,
} from './protocol'
import { projectIdentity, sessionIdentity } from './protocol'

export interface MenuRow {
  key: string
  text: string
  selectable: boolean
  value?: string
}

const sessionRunning = (session: SessionSummary) => ['running', 'starting'].includes(session.status)

/** Prefixes describe projects; navigation always uses the full project/thread ID. */
export function projectAbbreviations(projects: readonly Pick<ProjectSummary, 'id' | 'title' | 'environmentId'>[]): Map<string, string> {
  const result = new Map<string, string>()
  const singles = new Map<string, Array<{ id: string; title: string }>>()
  const initial = (word: string) => Array.from(word.toUpperCase())[0] ?? '?'
  for (const project of new Map(projects.map(project => [projectIdentity(project), project])).values()) {
    const identity = projectIdentity(project)
    const words = project.title.trim().split(/[\p{Dash_Punctuation}_\s]+/u).filter(Boolean)
    if (words.length > 1) result.set(identity, initial(words[0]!) + initial(words[1]!))
    else {
      const first = initial(words[0] ?? '')
      const group = singles.get(first) ?? []
      group.push({ ...project, id: identity })
      singles.set(first, group)
    }
  }
  for (const [first, group] of singles) {
    group.sort((a, b) => a.title.trim().localeCompare(b.title.trim(), 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id))
    group.forEach((project, index) => {
      // Preserve the two-character display beyond nine projects. An exhausted
      // alphabet uses '?' rather than silently truncating or wrapping a rank.
      const rank = index + 1
      result.set(project.id, first + (rank < 36 ? rank.toString(36).toUpperCase() : '?'))
    })
  }
  return result
}

/** Working sessions lead Unsettled; each section otherwise follows recency. */
export function buildSessionRows(result: SessionsListResult, now = Date.now(), projects: readonly ProjectSummary[] = []): MenuRow[] {
  const sessions = sortSessionsByLastActivity([...new Map([...result.settled, ...result.unsettled].map(session => [sessionIdentity(session), session])).values()])
  const abbreviations = projectAbbreviations([
    ...sessions.map(session => ({ id: session.projectId, title: session.projectTitle, environmentId: session.environmentId })), ...projects,
  ])
  const groups: Array<[string, SessionSummary[]]> = [
    ['UNSETTLED', sessions.filter(session => sessionRunning(session) || !session.settled)],
    ['SETTLED', sessions.filter(session => !sessionRunning(session) && session.settled)],
  ]
  const rows = groups.flatMap(([label, sessions]) => sessions.length ? [
    { key: `section:${label}`, text: label, selectable: false },
    ...sessions.map(session => sessionRow(session, now, abbreviations.get(projectIdentity({ id: session.projectId, environmentId: session.environmentId })) ?? '??')),
  ] : [])
  return [
    { key: 'new', text: 'START NEW SESSION', selectable: true },
    ...(rows.length ? rows : [{ key: 'sessions-empty', text: 'NO SESSIONS', selectable: false }]),
  ]
}

export function modelKey(model: Pick<ModelSummary, 'instanceId' | 'model'>): string {
  return JSON.stringify([model.instanceId, model.model])
}

export function buildModelRows(models: readonly ModelSummary[]): MenuRow[] {
  if (models.length === 0) {
    return [{ key: 'models-empty', text: 'NO CONFIGURED MODELS', selectable: false }]
  }
  const rows: MenuRow[] = []
  let provider = ''
  for (const model of models) {
    if (model.providerName !== provider) {
      provider = model.providerName
      rows.push({
        key: `provider:${model.instanceId}`,
        text: provider.toUpperCase(),
        selectable: false,
      })
    }
    const key = modelKey(model)
    rows.push({
      key: `model:${key}`,
      text: `${model.isDefault ? '* ' : '  '}${truncate(model.name, 36)}`,
      selectable: true,
      value: key,
    })
  }
  return rows
}

export function buildReasoningRows(choices: readonly ReasoningChoice[]): MenuRow[] {
  return choices.map((choice) => ({
    key: `reasoning:${choice.id}`,
    text: `${choice.isDefault ? '* ' : '  '}${truncate(choice.label, 36)}`,
    selectable: true,
    value: choice.id,
  }))
}

export function defaultModelKey(models: readonly ModelSummary[]): string | null {
  const model = models.find((candidate) => candidate.isDefault) ?? models[0]
  return model ? `model:${modelKey(model)}` : null
}

export function defaultReasoningId(choices: readonly ReasoningChoice[]): string | null {
  const choice = choices.find((candidate) => candidate.isDefault) ?? choices[0]
  return choice ? `reasoning:${choice.id}` : null
}

export interface RenderedMenu {
  body: string
  position: number
  count: number
}

export function sortSessionsByLastActivity(sessions: readonly SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const activeDifference = Number(sessionRunning(right)) - Number(sessionRunning(left))
    const timeDifference = timestamp(right.lastActivityAt) - timestamp(left.lastActivityAt)
    return activeDifference || timeDifference || left.id.localeCompare(right.id)
  })
}

export function freezeSessionOrder(result: SessionsListResult): SessionsListResult {
  return {
    ...result,
    unsettled: sortSessionsByLastActivity(result.unsettled),
    settled: sortSessionsByLastActivity(result.settled),
  }
}

export function buildProjectRows(projects: readonly ProjectSummary[]): MenuRow[] {
  const available = projects.filter((project) => project.canStartSession)
  if (available.length === 0) {
    return [{ key: 'projects-empty', text: 'NO PROJECTS AVAILABLE', selectable: false }]
  }
  return available.map((project) => ({
    key: `project:${projectIdentity(project)}`,
    text: truncate(project.environmentLabel ? `${project.title} · ${project.environmentLabel}` : project.title, 38),
    selectable: true,
    value: projectIdentity(project),
  }))
}

export function firstSelectableKey(rows: readonly MenuRow[]): string | null {
  return rows.find((row) => row.selectable)?.key ?? null
}

export function moveSelection(
  rows: readonly MenuRow[],
  currentKey: string | null,
  direction: -1 | 1,
): string | null {
  const selectable = rows.filter((row) => row.selectable)
  if (selectable.length === 0) return null
  const currentIndex = Math.max(0, selectable.findIndex((row) => row.key === currentKey))
  const nextIndex = Math.min(selectable.length - 1, Math.max(0, currentIndex + direction))
  return selectable[nextIndex]?.key ?? null
}

export function selectedValue(rows: readonly MenuRow[], selectedKey: string | null): string | null {
  return rows.find((row) => row.key === selectedKey && row.selectable)?.value ?? null
}

export function renderMenu(
  rows: readonly MenuRow[],
  selectedKey: string | null,
  maxLines = 8,
): RenderedMenu {
  const selectedRowIndex = Math.max(0, rows.findIndex((row) => row.key === selectedKey))
  let start = Math.max(0, selectedRowIndex - 2)
  start = Math.min(start, Math.max(0, rows.length - maxLines))
  const visibleRows = rows.slice(start, start + maxLines)
  const selectable = rows.filter((row) => row.selectable)
  const selectedPosition = selectable.findIndex((row) => row.key === selectedKey)
  return {
    body: visibleRows
      .map((row) => `${row.key === selectedKey ? '>' : ' '} ${row.text}`)
      .join('\n'),
    position: selectedPosition < 0 ? 0 : selectedPosition + 1,
    count: selectable.length,
  }
}

export function formatRelativeTime(iso: string, now = Date.now()): string {
  const elapsedSeconds = Math.max(0, Math.floor((now - timestamp(iso)) / 1000))
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`
  const minutes = Math.floor(elapsedSeconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'WORKING'
  const wholeSeconds = Math.max(0, Math.floor(seconds))
  if (wholeSeconds < 60) return `WORKED ${wholeSeconds}S`
  const minutes = Math.floor(wholeSeconds / 60)
  if (minutes < 60) return `WORKED ${minutes}M ${wholeSeconds % 60}S`
  return `WORKED ${Math.floor(minutes / 60)}H ${minutes % 60}M`
}

export function transcriptToText(turns: readonly TranscriptTurn[]): string {
  if (turns.length === 0) return 'No transcript yet.'

  return turns.map((turn, index) => {
    const blocks = turn.messages.map(formatTranscriptMessage)
    const duration = turn.separatorLabel.trim().toUpperCase() || formatDuration(turn.durationSeconds)
    return [`TURN ${index + 1} | ${duration}`, ...blocks].join('\n\n')
  }).join('\n\n----------------\n\n')
}

export interface PageBox {
  width: number
  height: number
  lineHeight?: number
}

export interface TranscriptPage {
  text: string
  speakerLabel: string
  messageId: string
  role: TranscriptTurn['messages'][number]['role']
  streaming: boolean
  messageUpdatedAt: string
  activeActivity: ActivityMarkerKind | null
  activeActivityLabel?: string | null
  turnNumber: number
  turnCount: number
  durationLabel: string
}

export type ActivityMarkerKind = 'thinking' | 'tool'

const FIXED_SPACE = '\u00a0'
const MAX_ACTIVITY_LABEL_WIDTH = 400
const PULSE_GLYPHS = [
  ['◐', '◐'],
  ['◓', '◓'],
  ['◑', '◑'],
  ['◒', '◒'],
  ['◐', '◐'],
  ['◓', '◓'],
  ['◑', '◑'],
  ['◒', '◒'],
] as const

export const ACTIVITY_PULSE_FRAME_COUNT = PULSE_GLYPHS.length

function activityWord(kind: ActivityMarkerKind, label?: string | null): string {
  if (kind === 'thinking') return 'thinking'
  const normalized = (label ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'tool call'
  if (getTextWidth(normalized) <= MAX_ACTIVITY_LABEL_WIDTH) return normalized
  let fitted = normalized.slice(0, 160).replace(/\.*$/, '')
  while (fitted.length > 1 && getTextWidth(`${fitted}...`) > MAX_ACTIVITY_LABEL_WIDTH) {
    fitted = fitted.slice(0, -1)
  }
  return `${fitted}...`
}

export function activeActivityMarker(
  kind: ActivityMarkerKind,
  frame: number,
  label?: string | null,
): string {
  const glyphs = PULSE_GLYPHS[Math.abs(Math.floor(frame)) % PULSE_GLYPHS.length]!
  return `${glyphs[0]}${FIXED_SPACE}${activityWord(kind, label)}${FIXED_SPACE}${glyphs[1]}`
}

export function historicalActivityMarker(kind: ActivityMarkerKind, label?: string | null): string {
  return `-${FIXED_SPACE}${FIXED_SPACE}${FIXED_SPACE}${activityWord(kind, label)}${FIXED_SPACE}-`
}

export function renderActivityPulse(
  text: string,
  kind: ActivityMarkerKind,
  frame: number,
  label?: string | null,
): string {
  return text.replace(
    activeActivityMarker(kind, 0, label).trimEnd(),
    activeActivityMarker(kind, frame, label),
  )
}

export interface ExtractedActivityLine {
  body: string
  lineIndex: number
}

export function extractActiveActivityLine(
  text: string,
  kind: ActivityMarkerKind,
  width: number,
  label?: string | null,
): ExtractedActivityLine | null {
  const marker = activeActivityMarker(kind, 0, label).trimEnd()
  const markerIndex = text.lastIndexOf(marker)
  if (markerIndex < 0) return null
  const beforeMarker = text.slice(0, markerIndex)
  return {
    body: `${beforeMarker}${text.slice(markerIndex + marker.length)}`,
    lineIndex: Math.max(0, measureTextWrap(beforeMarker, width).lineCount - 1),
  }
}

export interface ResponsePageSelection {
  pageIndex: number
  hasResponseText: boolean
}

export function retainTranscriptPage(
  previousPages: readonly TranscriptPage[],
  previousIndex: number,
  nextPages: readonly TranscriptPage[],
): number {
  const fallback = Math.min(Math.max(0, previousIndex), Math.max(0, nextPages.length - 1))
  const previous = previousPages[previousIndex]
  if (!previous?.messageId) return fallback
  const occurrence = previousPages
    .slice(0, previousIndex + 1)
    .filter((page) => page.messageId === previous.messageId).length - 1
  const matching = nextPages
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => page.messageId === previous.messageId)
  return matching[Math.min(occurrence, matching.length - 1)]?.index ?? fallback
}

export function selectResponsePage(
  pages: readonly TranscriptPage[],
  baselineMessageIds: ReadonlySet<string>,
  working: boolean,
): ResponsePageSelection {
  const responsePages = pages.filter((page) => (
    page.role === 'assistant'
    && page.messageId.length > 0
    && !baselineMessageIds.has(page.messageId)
  ))
  const latestResponsePage = responsePages[responsePages.length - 1]
  if (!latestResponsePage) {
    return { pageIndex: Math.max(0, pages.length - 1), hasResponseText: false }
  }
  if (working) {
    return { pageIndex: pages.lastIndexOf(latestResponsePage), hasResponseText: true }
  }
  const finalMessageId = latestResponsePage.messageId
  return {
    pageIndex: pages.findIndex((page) => page.messageId === finalMessageId),
    hasResponseText: true,
  }
}

export function paginateTranscript(
  turns: readonly TranscriptTurn[],
  box: PageBox,
): TranscriptPage[] {
  if (turns.length === 0) {
    return [{
      text: 'No transcript yet.',
      speakerLabel: 'T3',
      messageId: '',
      role: 'assistant',
      streaming: false,
      messageUpdatedAt: '',
      activeActivity: null,
      turnNumber: 0,
      turnCount: 0,
      durationLabel: '',
    }]
  }

  return turns.flatMap((turn, index) => {
    const durationLabel = turn.separatorLabel.trim().toUpperCase() || formatDuration(turn.durationSeconds)
    if (turn.messages.length === 0) {
      return [{
        text: '(empty)',
        speakerLabel: 'T3',
        messageId: '',
        role: 'assistant',
        streaming: false,
        messageUpdatedAt: turn.endedAt ?? turn.startedAt,
        activeActivity: null,
        turnNumber: index + 1,
        turnCount: turns.length,
        durationLabel,
      }]
    }
    return turn.messages.flatMap((message) => {
      const content = plainText(message.text) || '(empty)'
      return paginateText(content, box).map((page) => ({
        text: page,
        speakerLabel: transcriptRoleLabel(message.role),
        messageId: message.id,
        role: message.role,
        streaming: message.streaming,
        messageUpdatedAt: message.updatedAt,
        activeActivity: null,
        turnNumber: index + 1,
        turnCount: turns.length,
        durationLabel,
      }))
    })
  })
}

export function paginateTranscriptWithLiveTurn(
  turns: readonly TranscriptTurn[],
  liveActivities: readonly LiveToolActivity[],
  liveActivity: { phase: ActivityMarkerKind; label?: string; updatedAt: string } | null,
  box: PageBox,
): TranscriptPage[] {
  if (liveActivity === null || turns.length === 0) return paginateTranscript(turns, box)

  const settledPages = turns.length > 1
    ? paginateTranscript(turns.slice(0, -1), box)
      .map((page) => ({ ...page, turnCount: turns.length }))
    : []
  const turn = turns[turns.length - 1]!
  const userPages = turn.messages
    .filter((message) => message.role === 'user')
    .flatMap((message) => paginateText(`YOU\n${plainText(message.text) || '(empty)'}`, box).map((text) => ({
      text,
      speakerLabel: 'YOU',
      messageId: message.id,
      role: 'user' as const,
      streaming: false,
      messageUpdatedAt: message.updatedAt,
      activeActivity: null,
      turnNumber: turns.length,
      turnCount: turns.length,
      durationLabel: 'WORKING',
    })))
  const timeline = [
    ...turn.messages
      .filter((message) => message.role !== 'user')
      .map((message) => ({
        type: 'message' as const,
        at: timestamp(message.createdAt),
        text: `${transcriptRoleLabel(message.role)}\n${plainText(message.text) || '(empty)'}`,
      })),
    ...liveActivities.map((activity) => ({
      type: 'tool' as const,
      at: timestamp(activity.startedAt),
      activity,
    })),
  ].sort((left, right) => left.at - right.at)
  const activeToolId = liveActivity.phase === 'tool'
    ? [...liveActivities]
        .filter((activity) => activity.completedAt === null)
        .sort((left, right) => timestamp(left.startedAt) - timestamp(right.startedAt))
        .at(-1)?.id ?? null
    : null

  const blocks: Array<{ text: string; activity: boolean }> = []
  let activeMarker: ActivityMarkerKind | null = null
  let activeMarkerLabel: string | null = null
  if (timeline.length === 0 && liveActivity.phase === 'thinking') {
    blocks.push({ text: activeActivityMarker('thinking', 0), activity: true })
    activeMarker = 'thinking'
  } else {
    blocks.push({ text: historicalActivityMarker('thinking'), activity: true })
    for (const item of timeline) {
      if (item.type === 'message') {
        blocks.push({ text: item.text, activity: false })
        continue
      }
      const toolIsActive = item.activity.id === activeToolId
      blocks.push({
        text: toolIsActive
          ? activeActivityMarker('tool', 0, item.activity.label)
          : historicalActivityMarker('tool', item.activity.label),
        activity: true,
      })
      if (toolIsActive) {
        activeMarker = 'tool'
        activeMarkerLabel = item.activity.label
      }
    }
    if (liveActivity.phase === 'thinking') {
      blocks.push({ text: activeActivityMarker('thinking', 0), activity: true })
      activeMarker = 'thinking'
    } else if (activeMarker === null) {
      activeMarkerLabel = liveActivity.label ?? 'tool call'
      blocks.push({ text: activeActivityMarker('tool', 0, activeMarkerLabel), activity: true })
      activeMarker = 'tool'
    }
  }

  const content = blocks.map((block, index) => {
    if (index === 0) return block.text
    const previous = blocks[index - 1]!
    return `${previous.activity || block.activity ? '\n' : '\n\n'}${block.text}`
  }).join('')
  const liveTexts = paginateText(content, box)
  const liveMessageTime = turn.messages.reduce(
    (latest, message) => Math.max(latest, timestamp(message.updatedAt)),
    timestamp(liveActivity.updatedAt),
  )
  const livePages = liveTexts.map((text) => ({
    text,
    speakerLabel: 'LIVE',
    messageId: `live:${turn.id}`,
    role: 'assistant' as const,
    streaming: true,
    messageUpdatedAt: new Date(liveMessageTime || Date.now()).toISOString(),
    activeActivity: text.includes(
      activeActivityMarker(activeMarker ?? 'thinking', 0, activeMarkerLabel).trimEnd(),
    )
      ? activeMarker
      : null,
    activeActivityLabel: activeMarker === 'tool' ? activeMarkerLabel : null,
    turnNumber: turns.length,
    turnCount: turns.length,
    durationLabel: 'WORKING',
  }))

  return [...settledPages, ...userPages, ...livePages]
}

export function transcriptPageHeader(
  page: TranscriptPage,
  pageNumber: number,
  pageCount: number,
): string {
  const turn = page.turnCount > 0 ? `TURN ${page.turnNumber}/${page.turnCount}` : 'NO TURNS'
  const duration = page.durationLabel.replace(/^WORKED\s+/, '')
  return [page.speakerLabel, turn, duration, `${pageNumber}/${pageCount}`]
    .filter(Boolean)
    .join(' | ')
}

/** Message prose uses flush-left lines; source text remains available for sending. */
export function paginateMessageText(source: string, box: PageBox): string[] {
  const text = source.replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/[^\S\n]+/g, ' ').trim()).join('\n')
  return paginateText(text, box)
}

export function paginateText(source: string, box: PageBox): string[] {
  const maxLines = Math.max(1, Math.floor(box.height / (box.lineHeight ?? 27)))
  const paragraphs = source.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean)
  const pages: string[] = []
  let buffer: string[] = []
  let bufferLines = 0

  const flush = () => {
    if (buffer.length === 0) return
    pages.push(buffer.join('\n\n'))
    buffer = []
    bufferLines = 0
  }

  for (const paragraph of paragraphs) {
    const paragraphLines = lineCount(paragraph, box.width)
    if (paragraphLines > maxLines) {
      flush()
      pages.push(...splitParagraph(paragraph, box.width, maxLines))
      continue
    }
    const cost = paragraphLines + (buffer.length > 0 ? 1 : 0)
    if (bufferLines + cost > maxLines) flush()
    buffer.push(paragraph)
    bufferLines += paragraphLines + (buffer.length > 1 ? 1 : 0)
  }
  flush()
  return pages.length > 0 ? pages : ['(empty)']
}

export function plainText(markdown: string): string {
  return markdown
    .replace(/\r/g, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '- ')
    .replace(/[*_~`]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatTranscriptMessage(message: TranscriptTurn['messages'][number]): string {
  const label = transcriptRoleLabel(message.role)
  return `${label}\n${plainText(message.text)}`
}

function transcriptRoleLabel(role: TranscriptTurn['messages'][number]['role']): string {
  return role === 'user' ? 'YOU' : role === 'system' ? 'SYSTEM' : 'T3'
}

function sessionRow(session: SessionSummary, now: number, abbreviation: string): MenuRow {
  const status = ['running', 'starting'].includes(session.status)
    ? 'WORKING'
    : formatRelativeTime(session.lastActivityAt, now)
  return {
    key: `session:${sessionIdentity(session)}`,
    text: `${abbreviation} - ${truncate(session.title, session.environmentLabel ? 18 : 24).padEnd(session.environmentLabel ? 18 : 24)}${session.environmentLabel ? ` · ${truncate(session.environmentLabel, 5)}` : ''} ${status}`,
    selectable: true,
    value: sessionIdentity(session),
  }
}

function splitParagraph(text: string, width: number, maxLines: number): string[] {
  const tokens = text.split(/(\s+)/)
  const chunks: string[] = []
  let current = ''
  for (const token of tokens) {
    const candidate = current + token
    if (lineCount(candidate, width) > maxLines && current.trim()) {
      chunks.push(current.trim())
      current = token.replace(/^\s+/, '')
    } else {
      current = candidate
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks
}

function lineCount(text: string, width: number): number {
  return Math.max(1, measureTextWrap(text, width).lineCount)
}

function timestamp(iso: string): number {
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? parsed : 0
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}
