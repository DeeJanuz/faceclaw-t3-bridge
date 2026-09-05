import { describe, expect, it } from 'vitest'
import { PlanFlow } from './plan-flow'
import type { PendingPlanInput } from './protocol'

export const pendingPlan: PendingPlanInput = {
  requestId: 'request', revision: 'a'.repeat(64), turnId: 'turn', createdAt: '2026-09-04T12:00:00.000Z',
  questions: [
    { id: 'audience', header: 'Audience', question: 'Who is the plan for?', multiSelect: false,
      options: [{ label: 'Personal', description: 'For your own use.' }, { label: 'Team', description: 'Share with the team.' }] },
    { id: 'format', header: 'Format', question: 'Which format should we use?', multiSelect: false,
      options: [{ label: 'Checklist', description: 'A short list.' }, { label: 'Detailed', description: 'A full explanation.' }] },
  ],
}

describe('plan question interaction', () => {
  it('shows question first, advances answered questions, and submits only on the final review page', () => {
    const flow = new PlanFlow('thread', pendingPlan)
    expect(flow.card().body).toContain('Who is the plan for?')
    expect(flow.tap()).toBe('none')
    expect(flow.stage).toBe('options')
    flow.scroll(1)
    expect(flow.tap()).toBe('answer')
    expect(flow.answers[0]?.optionIndexes).toEqual([1])
    expect(flow.questionIndex).toBe(1)
    flow.tap()
    flow.tap()
    expect(flow.stage).toBe('review')
    expect(flow.complete).toBe(true)
    expect(flow.tap()).toBe('none')
    expect(flow.tap()).toBe('none')
    expect(flow.tap()).toBe('submit')
  })

  it('always ends the option list with custom dictation and permits previous-question edits', () => {
    const flow = new PlanFlow('thread', pendingPlan)
    flow.tap()
    for (let i = 0; i < 20; i++) flow.scroll(1)
    expect(flow.card().body).toContain('Dictate your own answer')
    expect(flow.tap()).toBe('dictate')
    expect(flow.answers).toEqual([])
    flow.accept({ questionId: 'audience', optionIndexes: [], text: 'A small volunteer group' })
    flow.openQuestion(0)
    flow.tap()
    flow.tap()
    expect(flow.answers).toEqual([{ questionId: 'audience', optionIndexes: [0], text: '' }])
  })

  it('supports multiple selections without accepting a partial question automatically', () => {
    const request = structuredClone(pendingPlan)
    request.questions[0]!.multiSelect = true
    const flow = new PlanFlow('thread', request)
    flow.tap()
    flow.tap()
    expect(flow.answers).toEqual([])
    flow.scroll(1)
    flow.tap()
    flow.scroll(1)
    expect(flow.card().body).toContain('Use selected answers')
    expect(flow.tap()).toBe('answer')
    expect(flow.answers[0]?.optionIndexes).toEqual([0, 1])
  })

  it('restores at the first unanswered question and cannot submit an incomplete review', () => {
    const flow = new PlanFlow('thread', pendingPlan, [{ questionId: 'audience', optionIndexes: [0], text: '' }])
    expect(flow.questionIndex).toBe(1)
    flow.review()
    for (let i = 0; i < 30; i++) flow.scroll(1)
    expect(flow.tap()).toBe('none')
    expect(flow.card().body).toContain('Answer every question first')
  })

  it('keeps long questions and descriptions readable across pages', () => {
    const request = structuredClone(pendingPlan)
    request.questions[0]!.question = 'Long question text. '.repeat(50) + 'END OF QUESTION'
    request.questions[0]!.options[0]!.description = 'Long explanation. '.repeat(50) + 'END OF OPTION'
    const flow = new PlanFlow('thread', request)
    for (let i = 0; i < 100; i++) flow.scroll(1)
    expect(flow.card().body).toContain('END OF QUESTION')
    flow.tap()
    const seen: string[] = []
    for (let i = 0; i < 100; i++) { seen.push(flow.card().body); flow.scroll(1) }
    expect(seen.join('\n')).toContain('END OF OPTION')
    expect(flow.card().body).toContain('Dictate your own answer')
  })

  it('locks question changes and submission after an uncertain attempt', () => {
    const flow = new PlanFlow('thread', pendingPlan)
    flow.stage = 'uncertain'
    flow.openQuestion(1)
    flow.review()
    expect(flow.questionIndex).toBe(0)
    expect(flow.stage).toBe('uncertain')
    expect(flow.tap()).toBe('none')
    expect(flow.menuItems()).toEqual([])
  })
})
