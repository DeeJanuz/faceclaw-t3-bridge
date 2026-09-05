import {
  List_ItemEvent,
  OsEventTypeList,
  Sys_ItemEvent,
  Text_ItemEvent,
} from '@evenrealities/even_hub_sdk'
import { describe, expect, it } from 'vitest'
import {
  INPUT_DEFINITIONS,
  inputCode,
  inputLabel,
  inputTypeFromEvenHubEvent,
  normalizeInputType,
  selectInputType,
} from './input-events'

describe('Even Hub input catalog', () => {
  it('covers every SDK event type exactly once', () => {
    const sdkValues = Object.values(OsEventTypeList).filter(
      (value): value is OsEventTypeList => typeof value === 'number',
    )
    const configuredValues = INPUT_DEFINITIONS.map((input) => input.eventType)

    expect(new Set(configuredValues).size).toBe(configuredValues.length)
    expect([...configuredValues].sort((left, right) => left - right)).toEqual(
      [...sdkValues].sort((left, right) => left - right),
    )
  })

  it('uses phone-friendly gesture names', () => {
    expect(inputLabel(OsEventTypeList.SCROLL_TOP_EVENT)).toBe('Swipe up')
    expect(inputLabel(OsEventTypeList.DOUBLE_CLICK_EVENT)).toBe('Double tap')
    expect(inputCode(OsEventTypeList.DOUBLE_CLICK_EVENT)).toBe('DOUBLE_CLICK_EVENT (3)')
  })

  it('accepts numeric and string forms sent by different Even Hub hosts', () => {
    expect(normalizeInputType(OsEventTypeList.DOUBLE_CLICK_EVENT)).toBe(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
    )
    expect(normalizeInputType('SCROLL_TOP_EVENT')).toBe(OsEventTypeList.SCROLL_TOP_EVENT)
    expect(normalizeInputType('SCROLL_BOTTOM')).toBe(OsEventTypeList.SCROLL_BOTTOM_EVENT)
    expect(normalizeInputType('not-an-event')).toBeNull()
  })

  it('prefers a double tap over a simultaneous click envelope', () => {
    expect(selectInputType(OsEventTypeList.CLICK_EVENT, OsEventTypeList.DOUBLE_CLICK_EVENT)).toBe(
      OsEventTypeList.DOUBLE_CLICK_EVENT,
    )
  })

  it('recovers a protobuf-default click omitted from any glasses event envelope', () => {
    expect(inputTypeFromEvenHubEvent({ sysEvent: new Sys_ItemEvent({ eventSource: 1 }) })).toBe(
      OsEventTypeList.CLICK_EVENT,
    )
    expect(inputTypeFromEvenHubEvent({ textEvent: new Text_ItemEvent({ containerID: 2 }) })).toBe(
      OsEventTypeList.CLICK_EVENT,
    )
    expect(inputTypeFromEvenHubEvent({ listEvent: new List_ItemEvent({ containerID: 2 }) })).toBe(
      OsEventTypeList.CLICK_EVENT,
    )
  })

  it('does not treat a missing envelope or malformed explicit type as a click', () => {
    expect(inputTypeFromEvenHubEvent({})).toBeNull()
    expect(
      inputTypeFromEvenHubEvent({
        textEvent: new Text_ItemEvent({ eventType: 'bad' as never }),
      }),
    ).toBeNull()
  })
})
