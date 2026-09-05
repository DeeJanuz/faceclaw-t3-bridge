import { describe, expect, it } from 'vitest'
import type {
  ModelSummary,
  ProjectSummary,
  SessionSummary,
  SessionsListResult,
  TranscriptTurn,
} from './protocol'
import {
  buildModelRows,
  buildProjectRows,
  buildReasoningRows,
  defaultModelKey,
  defaultReasoningId,
  buildSessionRows,
  projectAbbreviations,
  activeActivityMarker,
  extractActiveActivityLine,
  firstSelectableKey,
  freezeSessionOrder,
  formatDuration,
  moveSelection,
  modelKey,
  paginateText,
  paginateMessageText,
  paginateTranscript,
  paginateTranscriptWithLiveTurn,
  plainText,
  renderMenu,
  retainTranscriptPage,
  historicalActivityMarker,
  selectResponsePage,
  selectedValue,
  transcriptPageHeader,
  transcriptToText,
} from './view-model'

const session = (input: Partial<SessionSummary> & Pick<SessionSummary, 'id' | 'lastActivityAt'>): SessionSummary => ({
  id: input.id,
  projectId: input.projectId ?? 'project-1',
  projectTitle: input.projectTitle ?? 'Even Realities',
  title: input.title ?? input.id,
  settled: input.settled ?? false,
  lastActivityAt: input.lastActivityAt,
  status: input.status ?? 'idle',
})

describe('session menu', () => {
  it('keeps session creation available with an empty session list and project catalog', () => {
    const rows = buildSessionRows({ snapshotId: 'empty', frozenAt: '', unsettled: [], settled: [] }, 0, [])
    expect(rows[0]).toEqual({ key: 'new', text: 'START NEW SESSION', selectable: true })
    expect(firstSelectableKey(rows)).toBe('new')
    expect(rows[0]?.value).toBeUndefined()
  })
  it('puts running and starting sessions first across projects and settlement flags, ordered by recency', () => {
    const rows = buildSessionRows({ snapshotId: '1', frozenAt: '2026-09-04T12:00:00Z',
      unsettled: [
        session({ id: 'idle-newest', projectId: 'a', lastActivityAt: '2026-09-04T12:00:00Z' }),
        session({ id: 'running-older', projectId: 'z', status: 'running', lastActivityAt: '2026-09-04T09:00:00Z' }),
        session({ id: 'starting-newer', status: 'starting', lastActivityAt: '2026-09-04T10:00:00Z' }),
      ], settled: [
        session({ id: 'running-settled', settled: true, status: 'running', lastActivityAt: '2026-09-04T11:00:00Z' }),
        session({ id: 'settled-newest', settled: true, lastActivityAt: '2026-09-04T13:00:00Z' }),
      ] })
    expect(rows.map(row => row.key)).toEqual(['new', 'section:UNSETTLED', 'session:running-settled',
      'session:starting-newer', 'session:running-older', 'session:idle-newest',
      'section:SETTLED', 'session:settled-newest'])
    expect(rows.find(row => row.key === 'session:running-older')?.text).toMatch(/^ER - .*WORKING$/)
    expect(rows.filter(row => !row.selectable).map(row => row.text)).toEqual(['UNSETTLED', 'SETTLED'])
  })
  it('places unsettled sessions above settled sessions regardless of project or newer settled activity', () => {
    const input: SessionsListResult = {
      snapshotId: 'snapshot-1',
      frozenAt: '2026-09-03T12:00:00.000Z',
      unsettled: [
        session({ id: 'older-active', lastActivityAt: '2026-09-03T10:00:00.000Z' }),
        session({ id: 'newer-active', lastActivityAt: '2026-09-03T11:00:00.000Z' }),
      ],
      settled: [
        session({ id: 'older-settled', settled: true, lastActivityAt: '2026-09-01T10:00:00.000Z' }),
        session({ id: 'newer-settled', settled: true, lastActivityAt: '2026-09-03T11:30:00.000Z' }),
      ],
    }

    const rows = buildSessionRows(freezeSessionOrder(input), Date.parse(input.frozenAt))

    expect(rows.map((row) => row.key)).toEqual([
      'new',
      'section:UNSETTLED',
      'session:newer-active',
      'session:older-active',
      'section:SETTLED',
      'session:newer-settled',
      'session:older-settled',
    ])
  })

  it('moves only through actionable rows', () => {
    const rows = buildSessionRows({
      snapshotId: 'snapshot-1',
      frozenAt: '2026-09-03T12:00:00.000Z',
      unsettled: [session({ id: 'active', lastActivityAt: '2026-09-03T11:00:00.000Z' })],
      settled: [session({ id: 'settled', settled: true, lastActivityAt: '2026-09-02T11:00:00.000Z' })],
    })

    expect(firstSelectableKey(rows)).toBe('new')
    expect(moveSelection(rows, 'new', 1)).toBe('session:active')
    expect(moveSelection(rows, 'session:active', 1)).toBe('session:settled')
    expect(moveSelection(rows, 'session:settled', 1)).toBe('session:settled')
    expect(selectedValue(rows, 'session:active')).toBe('active')
  })

  it('retains sessions for unavailable projects without embedding project creation rows', () => {
    const rows = buildSessionRows({ snapshotId: '1', frozenAt: '2026-09-03T12:00:00Z', settled: [],
      unsettled: [session({ id: 'old', projectId: 'removed', lastActivityAt: '2026-09-03T12:00:00Z' })] })
    expect(rows.filter(row => row.key.startsWith('session:')).map(row => row.value)).toEqual(['old'])
  })

  it('keeps the selected row visible in a bounded menu', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      key: `row-${index}`,
      text: `ROW ${index}`,
      selectable: true,
      value: String(index),
    }))

    const menu = renderMenu(rows, 'row-10', 5)

    expect(menu.body).toContain('> ROW 10')
    expect(menu.body.split('\n')).toHaveLength(5)
    expect(menu.position).toBe(11)
    expect(menu.count).toBe(12)
  })
})

describe('project abbreviations', () => {
  it('keeps two-character prefixes when single-word ranks exceed nine', () => {
    const projects = Array.from({ length: 10 }, (_, index) => ({ id: String(index), title: `B${String(index).padStart(2, '0')}` }))
    expect([...projectAbbreviations(projects).values()]).toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'BA'])
  })
  it('splits dashes, underscores and whitespace, using the first two word initials', () => {
    const names = ['Even-Realities', 'Even_Realities', 'Even Realities', ' Even__-  Realities ', 'Even—Realities', 'Even Realities Bridge']
    const abbreviations = projectAbbreviations(names.map((title, index) => ({ id: String(index), title })))
    expect([...abbreviations.values()]).toEqual(names.map(() => 'ER'))
  })
  it('ranks single-word names by alphabet, without splitting camel case or depending on input order', () => {
    const projects = [{ id: 'z', title: 'BZAC' }, { id: 'bit', title: 'BitBooks' }, { id: 'a', title: 'Alpha' },
      { id: 'big', title: 'BigBook' }, { id: 'words', title: 'Bit Books' }]
    const expected = new Map([['words', 'BB'], ['big', 'B1'], ['bit', 'B2'], ['z', 'B3'], ['a', 'A1']])
    expect(projectAbbreviations(projects)).toEqual(expected)
    expect(projectAbbreviations([...projects].reverse())).toEqual(expected)
    expect(projectAbbreviations(projects.slice(0, 2))).toEqual(new Map([['bit', 'B1'], ['z', 'B2']]))
  })
  it('uses the full catalog and repeats one prefix for all sessions of the same project', () => {
    const projects = ['BitBooks', 'BZAC'].map((title, index) => ({ id: String(index), title, canStartSession: true, updatedAt: '' }))
    const snapshot: SessionsListResult = { snapshotId: '1', frozenAt: '', settled: [], unsettled: [
      session({ id: 'second', projectId: '1', projectTitle: 'BZAC', title: 'Second session', lastActivityAt: '2026-09-04T10:00:00Z' }),
      session({ id: 'first', projectId: '1', projectTitle: 'BZAC', title: 'First session', lastActivityAt: '2026-09-04T11:00:00Z' }),
    ] }
    const rows = buildSessionRows(snapshot, Date.parse('2026-09-04T12:00:00Z'), projects).filter(row => row.key.startsWith('session:'))
    expect(rows.map(row => row.text.slice(0, 5))).toEqual(['B2 - ', 'B2 - '])
    expect(rows.map(row => row.value)).toEqual(['first', 'second'])
  })
})

describe('project menu', () => {
  it('omits projects that cannot start sessions', () => {
    const projects: ProjectSummary[] = [
      { id: 'one', title: 'One', canStartSession: true, updatedAt: '2026-09-03T12:00:00.000Z' },
      { id: 'two', title: 'Two', canStartSession: false, updatedAt: '2026-09-03T12:00:00.000Z' },
    ]

    expect(buildProjectRows(projects).map((row) => row.value)).toEqual(['one'])
  })
})

describe('new session model menus', () => {
  const models: ModelSummary[] = [
    {
      instanceId: 'codex',
      providerName: 'Codex',
      model: 'gpt-5.6-sol',
      name: 'GPT-5.6-Sol',
      isDefault: true,
      reasoningChoices: [
        { id: 'low', label: 'Low', isDefault: true },
        { id: 'high', label: 'High', isDefault: false },
      ],
    },
    {
      instanceId: 'grok',
      providerName: 'Grok',
      model: 'grok-4.6',
      name: 'Grok 4.6',
      isDefault: false,
      reasoningChoices: [{ id: 'high', label: 'High', isDefault: true }],
    },
  ]

  it('groups models by provider and marks defaults', () => {
    const rows = buildModelRows(models)

    expect(rows.map((row) => row.text)).toEqual([
      'CODEX',
      '* GPT-5.6-Sol',
      'GROK',
      '  Grok 4.6',
    ])
    expect(defaultModelKey(models)).toBe(`model:${modelKey(models[0]!)}`)
    expect(selectedValue(rows, defaultModelKey(models))).toBe(modelKey(models[0]!))
    expect(renderMenu(rows, defaultModelKey(models)).position).toBe(1)
  })

  it('marks and selects the model-specific default reasoning level', () => {
    const rows = buildReasoningRows(models[0]!.reasoningChoices)

    expect(rows.map((row) => row.text)).toEqual(['* Low', '  High'])
    expect(defaultReasoningId(models[0]!.reasoningChoices)).toBe('reasoning:low')
    expect(selectedValue(rows, defaultReasoningId(models[0]!.reasoningChoices))).toBe('low')
  })
})

describe('transcript reader', () => {
  it('labels turns with elapsed work and preserves message order', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-1',
      startedAt: '2026-09-03T12:00:00.000Z',
      endedAt: '2026-09-03T12:02:05.000Z',
      durationSeconds: 125,
      separatorLabel: 'Worked 2m 5s',
      messages: [
        { id: 'm1', role: 'user', text: 'Build **this**.', streaming: false, createdAt: '2026-09-03T12:00:00.000Z', updatedAt: '2026-09-03T12:00:00.000Z' },
        { id: 'm2', role: 'assistant', text: 'Done. See [file](https://example.com).', streaming: false, createdAt: '2026-09-03T12:02:05.000Z', updatedAt: '2026-09-03T12:02:05.000Z' },
      ],
    }]

    expect(transcriptToText(turns)).toBe(
      'TURN 1 | WORKED 2M 5S\n\nYOU\nBuild this.\n\nT3\nDone. See file.',
    )
    expect(formatDuration(125)).toBe('WORKED 2M 5S')
  })

  it('removes common Markdown marks without collapsing paragraphs', () => {
    expect(plainText('# Result\n\n- first\n- second\n\n`code`')).toBe(
      'Result\n\n- first\n- second\n\ncode',
    )
  })

  it('normalizes message indentation and horizontal spacing while preserving paragraphs and literal punctuation', () => {
    expect(paginateMessageText('First  line\r\n \tSecond\u00a0 line\r\n\r\n  plan_v2 costs $5 * 2.', { width: 568, height: 206 }))
      .toEqual(['First line\nSecond line\n\nplan_v2 costs $5 * 2.'])
  })

  it('splits long transcripts into display-sized pages', () => {
    const pages = paginateText('word '.repeat(300), { width: 568, height: 206 })
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.every((page) => page.length > 0)).toBe(true)
  })

  it('keeps one speaker per page and moves all metadata into one header line', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-1',
      startedAt: '2026-09-03T12:00:00.000Z',
      endedAt: '2026-09-03T12:02:05.000Z',
      durationSeconds: 125,
      separatorLabel: 'Worked 2m 5s',
      messages: [{
        id: 'm1',
        role: 'assistant',
        text: 'word '.repeat(300),
        streaming: false,
        createdAt: '2026-09-03T12:00:00.000Z',
        updatedAt: '2026-09-03T12:02:05.000Z',
      }],
    }]

    const pages = paginateTranscript(turns, { width: 572, height: 254 })

    expect(pages.length).toBeGreaterThan(1)
    expect(pages.every((page) => page.speakerLabel === 'T3')).toBe(true)
    expect(pages.every((page) => page.messageId === 'm1')).toBe(true)
    expect(pages.every((page) => page.turnNumber === 1 && page.durationLabel === 'WORKED 2M 5S')).toBe(true)
    expect(pages.every((page) => !page.text.includes('TURN 1/1'))).toBe(true)
    expect(transcriptPageHeader(pages[0]!, 1, pages.length)).toBe(
      `T3 | TURN 1/1 | 2M 5S | 1/${pages.length}`,
    )
  })

  it('does not mix user and assistant text on one transcript page', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-1',
      startedAt: '2026-09-03T12:00:00.000Z',
      endedAt: '2026-09-03T12:00:05.000Z',
      durationSeconds: 5,
      separatorLabel: 'Worked 5s',
      messages: [
        { id: 'm1', role: 'user', text: 'Question', streaming: false, createdAt: '', updatedAt: '' },
        { id: 'm2', role: 'assistant', text: 'Answer', streaming: false, createdAt: '', updatedAt: '' },
      ],
    }]

    const pages = paginateTranscript(turns, { width: 572, height: 254 })

    expect(pages.map((page) => [page.speakerLabel, page.text])).toEqual([
      ['YOU', 'Question'],
      ['T3', 'Answer'],
    ])
  })

  it('marks streaming pages and keeps their message update time', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-1',
      startedAt: '',
      endedAt: null,
      durationSeconds: null,
      separatorLabel: 'WORKING',
      messages: [{
        id: 'assistant-live',
        role: 'assistant',
        text: 'A response in progress',
        streaming: true,
        createdAt: '2026-09-04T15:00:00.000Z',
        updatedAt: '2026-09-04T15:00:02.000Z',
      }],
    }]

    expect(paginateTranscript(turns, { width: 572, height: 254 })[0]).toMatchObject({
      messageId: 'assistant-live',
      role: 'assistant',
      streaming: true,
      messageUpdatedAt: '2026-09-04T15:00:02.000Z',
    })
  })

  it('follows the end while working, then shows the first page of the final message', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-1',
      startedAt: '',
      endedAt: null,
      durationSeconds: null,
      separatorLabel: 'WORKING',
      messages: [
        { id: 'old', role: 'assistant', text: 'Earlier', streaming: false, createdAt: '', updatedAt: '' },
        { id: 'commentary', role: 'assistant', text: 'Checking now.', streaming: false, createdAt: '', updatedAt: '' },
        { id: 'final', role: 'assistant', text: 'final '.repeat(300), streaming: true, createdAt: '', updatedAt: '' },
      ],
    }]
    const pages = paginateTranscript(turns, { width: 572, height: 254 })
    const baseline = new Set(['old'])
    const live = selectResponsePage(pages, baseline, true)
    const settled = selectResponsePage(pages, baseline, false)

    expect(live.pageIndex).toBe(pages.length - 1)
    expect(settled.pageIndex).toBe(pages.findIndex((page) => page.messageId === 'final'))
    expect(settled.hasResponseText).toBe(true)
  })

  it('uses fixed-width spinner markers around the activity text', () => {
    const frames = [0, 1, 2, 3].map((frame) => activeActivityMarker('thinking', frame))
    const space = '\u00a0'

    expect(frames).toEqual([
      `◐${space}thinking${space}◐`,
      `◓${space}thinking${space}◓`,
      `◑${space}thinking${space}◑`,
      `◒${space}thinking${space}◒`,
    ])
    expect(frames.map((frame) => frame.indexOf('thinking'))).toEqual([2, 2, 2, 2])
    expect(historicalActivityMarker('tool')).toBe(`-${space}${space}${space}tool call${space}-`)
    expect(historicalActivityMarker('tool', 'file read'))
      .toBe(`-${space}${space}${space}file read${space}-`)
    expect(historicalActivityMarker('tool', 'ran npm --prefix bridge run check_all'))
      .toContain('check_all')
    const longCommand = `sed -n '1,320p' ${'/very/long/path/'.repeat(12)}SKILL.md`
    const commandFrames = [0, 1, 2, 3].map((frame) => (
      activeActivityMarker('tool', frame, longCommand)
    ))
    expect(commandFrames.every((marker) => marker.includes('...'))).toBe(true)
    expect(commandFrames.map((marker) => marker.length)).toEqual([
      commandFrames[0]!.length,
      commandFrames[0]!.length,
      commandFrames[0]!.length,
      commandFrames[0]!.length,
    ])
  })

  it('extracts the live activity line for independent glasses positioning', () => {
    const marker = activeActivityMarker('thinking', 0)

    expect(extractActiveActivityLine(`T3\nWorking now.\n\n${marker}`, 'thinking', 572)).toEqual({
      body: 'T3\nWorking now.\n\n',
      lineIndex: 3,
    })
  })

  it('packs the active turn timeline into filled pages instead of one page per item', () => {
    const turns: TranscriptTurn[] = [{
      id: 'turn-live',
      startedAt: '2026-09-04T15:00:00.000Z',
      endedAt: null,
      durationSeconds: null,
      separatorLabel: 'WORKING',
      messages: [
        { id: 'user', role: 'user', text: 'Please check this.', streaming: false, createdAt: '2026-09-04T15:00:00.000Z', updatedAt: '2026-09-04T15:00:00.000Z' },
        { id: 'update', role: 'assistant', text: 'I am checking it now.', streaming: false, createdAt: '2026-09-04T15:00:02.000Z', updatedAt: '2026-09-04T15:00:02.000Z' },
      ],
    }]
    const pages = paginateTranscriptWithLiveTurn(
      turns,
      [{ id: 'tool:0', kind: 'tool', label: 'file read', startedAt: '2026-09-04T15:00:03.000Z', completedAt: '2026-09-04T15:00:04.000Z' }],
      { phase: 'thinking', updatedAt: '2026-09-04T15:00:05.000Z' },
      { width: 572, height: 254 },
    )

    expect(pages.length).toBeLessThan(5)
    expect(pages.map((page) => page.text).join('\n')).toContain('YOU\nPlease check this.')
    expect(pages.map((page) => page.text).join('\n')).toContain(`-${'\u00a0'.repeat(3)}file read\u00a0-`)
    expect(pages.map((page) => page.text).join('\n')).toContain(
      `${historicalActivityMarker('tool', 'file read')}\n${activeActivityMarker('thinking', 0)}`,
    )
    expect(pages[pages.length - 1]!.activeActivity).toBe('thinking')
  })

  it('starts live work on a fresh page after the newly sent user prompt', () => {
    const pages = paginateTranscriptWithLiveTurn(
      [{
        id: 'turn-live',
        startedAt: '2026-09-04T15:00:00.000Z',
        endedAt: null,
        durationSeconds: null,
        separatorLabel: 'WORKING',
        messages: [{
          id: 'steer',
          role: 'user',
          text: 'Change direction without placing this on the live page.',
          streaming: false,
          createdAt: '2026-09-04T15:00:00.000Z',
          updatedAt: '2026-09-04T15:00:00.000Z',
        }],
      }],
      [],
      { phase: 'thinking', updatedAt: '2026-09-04T15:00:01.000Z' },
      { width: 572, height: 254 },
    )

    expect(pages).toHaveLength(2)
    expect(pages[0]!.role).toBe('user')
    expect(pages[0]!.text).toContain('Change direction')
    expect(pages[1]!.role).toBe('assistant')
    expect(pages[1]!.text).not.toContain('Change direction')
    expect(pages[1]!.activeActivity).toBe('thinking')
  })

  it('keeps a live tool category in the pulsing marker and activity metadata', () => {
    const pages = paginateTranscriptWithLiveTurn(
      [{
        id: 'turn-live-tool',
        startedAt: '2026-09-04T15:00:00.000Z',
        endedAt: null,
        durationSeconds: null,
        separatorLabel: 'WORKING',
        messages: [],
      }],
      [
        {
          id: 'tool:command',
          kind: 'tool',
          label: 'ran command',
          startedAt: '2026-09-04T15:00:01.000Z',
          completedAt: null,
        },
        {
          id: 'tool:web',
          kind: 'tool',
          label: 'searched web',
          startedAt: '2026-09-04T15:00:02.000Z',
          completedAt: null,
        },
      ],
      { phase: 'tool', label: 'tool call', updatedAt: '2026-09-04T15:00:01.000Z' },
      { width: 572, height: 254 },
    )

    const livePage = pages[pages.length - 1]!
    const liveText = pages.map((page) => page.text).join('\n')
    expect(liveText).toContain(historicalActivityMarker('tool', 'ran command'))
    expect(liveText).not.toContain(activeActivityMarker('tool', 0, 'ran command'))
    expect(livePage.text).toContain(activeActivityMarker('tool', 0, 'searched web'))
    expect(livePage.activeActivity).toBe('tool')
    expect(livePage.activeActivityLabel).toBe('searched web')
  })

  it('retains the same transcript message page while newer pages append', () => {
    const original: TranscriptTurn[] = [{
      id: 'turn-old',
      startedAt: '',
      endedAt: '',
      durationSeconds: 1,
      separatorLabel: 'WORKED 1S',
      messages: [{ id: 'old', role: 'assistant', text: 'old '.repeat(300), streaming: false, createdAt: '', updatedAt: '' }],
    }]
    const previous = paginateTranscript(original, { width: 572, height: 254 })
    const next = paginateTranscript([
      ...original,
      {
        id: 'turn-new',
        startedAt: '',
        endedAt: '',
        durationSeconds: 1,
        separatorLabel: 'WORKED 1S',
        messages: [{ id: 'new', role: 'assistant', text: 'New answer', streaming: false, createdAt: '', updatedAt: '' }],
      },
    ], { width: 572, height: 254 })

    expect(retainTranscriptPage(previous, 1, next)).toBe(1)
  })
})
