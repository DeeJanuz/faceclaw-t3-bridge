import type { PendingPlanInput, PlanAnswer, PlanQuestion } from './protocol'
import type { GlassesCard } from './glasses-display'
import { paginateText } from './view-model'
import { validatePlanDraftAnswers } from './plan-drafts'

export const PLAN_NEXT_MENU_ID = 20
export const PLAN_PREVIOUS_MENU_ID = 21
export const PLAN_REVIEW_MENU_ID = 22
const BOX = { width: 524, height: 108 }
const pages = (text: string) => paginateText(text, BOX)
let transitionSequence = 0

/** Local interaction only. The caller owns persistence and the one submit RPC. */
export class PlanFlow {
  stage: 'loading' | 'question' | 'options' | 'review' | 'submitting' | 'uncertain' = 'question'
  questionIndex = 0
  page = 0
  optionCursor = 0
  checked: number[] = []
  answers: PlanAnswer[]
  transition = ++transitionSequence
  entrance: 'bottom' | 'right' = 'bottom'
  notice = ''

  constructor(readonly threadId: string, readonly request: PendingPlanInput, answers: PlanAnswer[] = [], readonly environmentId?: string) {
    this.answers = answers.map(answer => ({ ...answer, optionIndexes: [...answer.optionIndexes] }))
    this.questionIndex = Math.max(0, request.questions.findIndex(question => !this.answer(question)))
  }

  get question() { return this.request.questions[this.questionIndex]! }
  get complete() { return this.request.questions.every(question => Boolean(this.answer(question))) }
  get locked() { return this.stage === 'loading' || this.stage === 'submitting' || this.stage === 'uncertain' }
  private answer(question: PlanQuestion) { return this.answers.find(answer => answer.questionId === question.id) }

  private choices() {
    return [
      ...this.question.options.flatMap((option, index) => pages(`${this.question.multiSelect ? `${this.checked.includes(index) ? '[x]' : '[ ]'} ` : ''}${option.label}\n${option.description}`)
        .map(text => ({ index, text, kind: 'option' as const }))),
      ...(this.question.multiSelect ? [{ index: -1, text: 'Use selected answers', kind: 'accept' as const }] : []),
      { index: -1, text: 'Dictate your own answer', kind: 'dictate' as const },
    ]
  }

  openQuestion(index: number) {
    if (this.locked) return
    this.questionIndex = (index + this.request.questions.length) % this.request.questions.length
    this.stage = 'question'
    this.page = 0
    this.transition = ++transitionSequence
    this.entrance = 'bottom'
  }

  review() {
    if (this.locked) return
    this.stage = 'review'
    this.page = 0
    this.transition = ++transitionSequence
    this.entrance = 'right'
  }

  private reviewPages() {
    return this.request.questions.flatMap((question, index) => {
      const answer = this.answer(question)
      const text = answer?.text || answer?.optionIndexes.map(option => question.options[option]?.label).join('; ') || 'Not answered'
      return pages(`${index + 1}. ${question.question}\nAnswer: ${text}`)
    })
  }

  scroll(direction: -1 | 1) {
    if (this.stage === 'options') this.optionCursor = Math.max(0, Math.min(this.choices().length - 1, this.optionCursor + direction))
    else if (this.stage === 'question') this.page = Math.max(0, Math.min(pages(this.question.question).length - 1, this.page + direction))
    else if (this.stage === 'review') this.page = Math.max(0, Math.min(this.reviewPages().length, this.page + direction))
  }

  tap(): 'none' | 'answer' | 'dictate' | 'submit' {
    if (this.stage === 'question') {
      this.stage = 'options'
      this.optionCursor = 0
      this.checked = [...(this.answer(this.question)?.optionIndexes ?? [])]
      this.transition = ++transitionSequence
      this.entrance = 'right'
    } else if (this.stage === 'options') {
      const choice = this.choices()[this.optionCursor]!
      if (choice.kind === 'dictate') return 'dictate'
      if (choice.kind === 'accept') {
        if (!this.checked.length) return 'none'
        return this.accept({ questionId: this.question.id, optionIndexes: [...this.checked].sort((a, b) => a - b), text: '' }) ? 'answer' : 'none'
      }
      if (this.question.multiSelect) {
        this.checked = this.checked.includes(choice.index) ? this.checked.filter(index => index !== choice.index) : [...this.checked, choice.index]
      } else {
        return this.accept({ questionId: this.question.id, optionIndexes: [choice.index], text: '' }) ? 'answer' : 'none'
      }
    } else if (this.stage === 'review') {
      if (this.page === this.reviewPages().length) return this.complete ? 'submit' : 'none'
      this.page++
    }
    return 'none'
  }

  accept(answer: PlanAnswer) {
    if (this.locked) return false
    const candidate = [...this.answers.filter(existing => existing.questionId !== answer.questionId), answer]
    if (!validatePlanDraftAnswers(this.request, candidate)) {
      this.notice = 'Answers are too long. Choose or dictate shorter answers.'
      this.review()
      this.page = this.reviewPages().length
      return false
    }
    this.answers = candidate
    this.notice = ''
    const next = this.request.questions.findIndex((question, index) => index > this.questionIndex && !this.answer(question))
    const remaining = next >= 0 ? next : this.request.questions.findIndex(question => !this.answer(question))
    if (remaining < 0) this.review()
    else this.openQuestion(remaining)
    return true
  }

  card(): GlassesCard {
    let title: string
    let body: string
    if (this.stage === 'loading') {
      title = 'LOADING SAVED ANSWERS'
      body = 'Checking this phone for saved choices...'
    } else if (this.stage === 'question') {
      const content = pages(this.question.question)
      title = `QUESTION ${this.questionIndex + 1}/${this.request.questions.length} | ${this.page + 1}/${content.length}`
      body = content[this.page]!
    } else if (this.stage === 'options') {
      const choices = this.choices()
      const choice = choices[this.optionCursor]!
      title = `ANSWER ${this.questionIndex + 1}/${this.request.questions.length} | ${this.optionCursor + 1}/${choices.length}`
      body = choice.text
    } else if (this.stage === 'review') {
      const content = this.reviewPages()
      const final = this.page === content.length
      title = final ? `SUBMIT ${this.answers.length}/${this.request.questions.length} ANSWERS` : `REVIEW | ${this.page + 1}/${content.length}`
      body = final
        ? `${this.complete ? 'Ready to submit all answers.' : 'Answer every question first.'}\n${this.notice || 'Nothing has been sent.'}`
        : content[this.page]!
    } else {
      title = this.stage === 'submitting' ? 'SUBMITTING ANSWERS' : 'CHECKING SUBMISSION'
      body = this.stage === 'submitting' ? 'Sending the complete answer set...' : 'Submission not yet confirmed.\nReopen the thread to check.\nAnswers are locked to prevent duplicates.'
    }
    return { title, body, presentation: 'plan', entrance: this.entrance, transition: this.transition }
  }

  menuItems() {
    return this.locked ? [] : [
      { itemID: PLAN_NEXT_MENU_ID, itemName: 'Next question' },
      { itemID: PLAN_PREVIOUS_MENU_ID, itemName: 'Previous question' },
      { itemID: PLAN_REVIEW_MENU_ID, itemName: 'Review answers' },
    ]
  }
}
