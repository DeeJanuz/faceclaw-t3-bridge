import { describe, expect, it } from 'vitest'
import { transcriptChangedThreadId } from './bridge-events'

describe('bridge event compatibility', () => {
  it('reads the current compact transcript notification', () => {
    expect(transcriptChangedThreadId({ threadId: 'thread-1', snapshotId: '9' })).toBe('thread-1')
  })

  it('reads the earlier full transcript notification', () => {
    expect(transcriptChangedThreadId({ session: { id: 'thread-2' }, turns: [] })).toBe('thread-2')
  })

  it('rejects unrelated event payloads', () => {
    expect(transcriptChangedThreadId({ session: null })).toBeNull()
    expect(transcriptChangedThreadId('thread-3')).toBeNull()
  })
})
