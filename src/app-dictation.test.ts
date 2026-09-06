import { AudioInputSource, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EvenT3App } from './app'
import type { CompanionUi } from './companion-ui'
import type { GlassesFrame } from './glasses-display'
import type { VoiceTarget } from './protocol'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function setup() {
  vi.stubGlobal('window', { setInterval: vi.fn().mockReturnValue(1) })
  const bridge = { audioControl: vi.fn().mockResolvedValue(true) }
  const request = vi.fn().mockResolvedValue({ maxBytes: 32000 })
  const card = deferred<void>()
  const app = new EvenT3App(bridge as unknown as EvenAppBridge, {} as CompanionUi)
  // Isolate startup ordering from profile, transcript, and native rendering tests.
  const internals = app as unknown as {
    transcriptFrame(): GlassesFrame
    renderDictation(): Promise<void>
    requireClient(): { request: typeof request }
    beginDictation(target: VoiceTarget, screen: 'transcript'): Promise<void>
    dictation: unknown
  }
  vi.spyOn(internals, 'transcriptFrame').mockReturnValue({ header: 'SESSION', body: 'Transcript' })
  vi.spyOn(internals, 'renderDictation').mockReturnValue(card.promise)
  vi.spyOn(internals, 'requireClient').mockReturnValue({ request })
  return { bridge, request, card, internals }
}

afterEach(() => vi.unstubAllGlobals())

describe('dictation startup', () => {
  it('starts the microphone after voice.start without waiting for backdrop uploads', async () => {
    const { bridge, request, card, internals } = setup()
    const recording = deferred<{ maxBytes: number }>()
    request.mockReturnValueOnce(recording.promise)
    const starting = internals.beginDictation({ kind: 'thread', threadId: 'test' }, 'transcript')
    expect(bridge.audioControl).not.toHaveBeenCalled()
    recording.resolve({ maxBytes: 32000 })
    await vi.waitFor(() => expect(bridge.audioControl).toHaveBeenCalledWith(true, AudioInputSource.Glasses))
    expect(window.setInterval).not.toHaveBeenCalled()
    card.resolve()
    await starting
    expect(window.setInterval).toHaveBeenCalledOnce()
  })

  it('stops the microphone and cancels the recording if the card later fails', async () => {
    const { bridge, request, card, internals } = setup()
    const starting = internals.beginDictation({ kind: 'thread', threadId: 'test' }, 'transcript')
    const rejected = expect(starting).rejects.toThrow('display failed')
    await vi.waitFor(() => expect(bridge.audioControl).toHaveBeenCalledWith(true, AudioInputSource.Glasses))
    card.reject(new Error('display failed'))
    await rejected
    expect(bridge.audioControl).toHaveBeenLastCalledWith(false)
    expect(request).toHaveBeenLastCalledWith('voice.cancel')
    expect(internals.dictation).toBeNull()
    expect(window.setInterval).not.toHaveBeenCalled()
  })

  it('waits for a late microphone start before stopping it after a display failure', async () => {
    const { bridge, request, card, internals } = setup()
    const recording = deferred<{ maxBytes: number }>()
    request.mockReturnValueOnce(recording.promise)
    const starting = internals.beginDictation({ kind: 'thread', threadId: 'test' }, 'transcript')
    const rejected = expect(starting).rejects.toThrow('display failed')
    card.reject(new Error('display failed'))
    await Promise.resolve()
    expect(bridge.audioControl).not.toHaveBeenCalled()
    recording.resolve({ maxBytes: 32000 })
    await rejected
    expect(bridge.audioControl.mock.calls.map(([enabled]) => enabled)).toEqual([true, false])
    expect(request).toHaveBeenLastCalledWith('voice.cancel')
  })

  it('does not start the microphone if voice.start fails', async () => {
    const { bridge, request, card, internals } = setup()
    request.mockRejectedValueOnce(new Error('recording failed'))
    const starting = internals.beginDictation({ kind: 'thread', threadId: 'test' }, 'transcript')
    card.resolve()
    await expect(starting).rejects.toThrow('recording failed')
    expect(bridge.audioControl.mock.calls.some(([enabled]) => enabled)).toBe(false)
    expect(request).toHaveBeenLastCalledWith('voice.cancel')
  })
})

describe('empty dictation', () => {
  function setupDraft() {
    const { bridge, request, internals } = setup()
    const flow = internals as unknown as {
      screen: string
      dictation: unknown
      voiceDraft: { target: VoiceTarget | { kind: 'phone'; key: string }; returnScreen: string; text: string; pages: string[]; page: number } | null
      finishDictation(): Promise<void>
      sendVoiceDraft(): Promise<void>
      showVoiceState(): Promise<void>
      showError(message: string, returnScreen: string): Promise<void>
      renderVoiceDraft(): Promise<void>
    }
    vi.spyOn(flow, 'showVoiceState').mockResolvedValue()
    vi.spyOn(flow, 'showError').mockResolvedValue()
    vi.spyOn(flow, 'renderVoiceDraft').mockResolvedValue()
    return { bridge, request, flow }
  }

  it.each(['', ' \n\t '])('rejects a blank final transcript without presenting a sendable draft: %j', async (text) => {
    const { bridge, request, flow } = setupDraft()
    flow.screen = 'dictating'
    flow.dictation = { target: { kind: 'thread', threadId: 'test' }, returnScreen: 'transcript' }
    request.mockResolvedValue({ text })
    await flow.finishDictation()
    expect(bridge.audioControl).toHaveBeenCalledWith(false)
    expect(request.mock.calls).toEqual([['voice.finish']])
    expect(flow.dictation).toBeNull()
    expect(flow.voiceDraft).toBeNull()
    expect(flow.renderVoiceDraft).not.toHaveBeenCalled()
    expect(flow.showError).toHaveBeenCalledWith(expect.stringContaining('No speech was detected'), 'transcript')
  })

  it.each([
    [{ kind: 'thread', threadId: 'test' }, 'transcript'],
    [{ kind: 'thread', threadId: 'test' }, 'plan'],
    [{ kind: 'project', projectId: 'test', modelSelection: { instanceId: 'codex', model: 'test' } }, 'new-session'],
    [{ kind: 'assistant', projectId: 'test', modelSelection: { instanceId: 'codex', model: 'test' } }, 'assistant'],
    [{ kind: 'phone', key: 'test' }, 'notifications'],
  ] as const)('rejects a blank draft before dispatching to %j', async (target, returnScreen) => {
    const { request, flow } = setupDraft()
    flow.voiceDraft = { target, returnScreen, text: ' \n\t ', pages: [''], page: 0 }
    await flow.sendVoiceDraft()
    expect(request).not.toHaveBeenCalled()
    expect(flow.voiceDraft).toBeNull()
    expect(flow.showError).toHaveBeenCalledWith('No speech was detected. Nothing was sent.', returnScreen)
  })

  it('keeps nonempty speech available for review without sending it', async () => {
    const { request, flow } = setupDraft()
    flow.dictation = { target: { kind: 'thread', threadId: 'test' }, returnScreen: 'transcript' }
    request.mockResolvedValue({ text: '  A quiet reply.  ' })
    await flow.finishDictation()
    expect(flow.voiceDraft?.text).toBe('A quiet reply.')
    expect(flow.renderVoiceDraft).toHaveBeenCalledOnce()
    expect(request.mock.calls).toEqual([['voice.finish']])
    expect(flow.showError).not.toHaveBeenCalled()
  })
})
