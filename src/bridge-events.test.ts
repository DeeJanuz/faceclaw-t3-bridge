import { describe, expect, it } from 'vitest'
import { transcriptChangedSession, transcriptChangedThreadId } from './bridge-events'

describe('bridge event compatibility', () => {
  it('reads the current compact transcript notification', () => {
    expect(transcriptChangedThreadId({ threadId: 'thread-1', snapshotId: '9' })).toBe('thread-1')
  })

  it('reads the earlier full transcript notification', () => {
    expect(transcriptChangedThreadId({ session: { id: 'thread-2' }, turns: [] })).toBe('thread-2')
  })

  it('preserves environment identity for duplicate remote thread ids', () => {
    expect(transcriptChangedSession({ environmentId: 'studio', threadId: 'thread-1' })).toEqual({
      environmentId: 'studio', threadId: 'thread-1',
    })
    expect(transcriptChangedSession({ session: { environmentId: 'laptop', id: 'thread-1' } })).toEqual({
      environmentId: 'laptop', threadId: 'thread-1',
    })
  })

  it('rejects unrelated event payloads', () => {
    expect(transcriptChangedThreadId({ session: null })).toBeNull()
    expect(transcriptChangedThreadId('thread-3')).toBeNull()
  })
})
