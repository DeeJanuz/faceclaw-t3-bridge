import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export interface InputDefinition {
  eventType: OsEventTypeList
  label: string
  group: 'gesture' | 'lifecycle' | 'sensor'
  endsApp?: boolean
}

export const INPUT_DEFINITIONS: readonly InputDefinition[] = [
  { eventType: OsEventTypeList.CLICK_EVENT, label: 'Tap', group: 'gesture' },
  { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT, label: 'Double tap', group: 'gesture' },
  { eventType: OsEventTypeList.SCROLL_TOP_EVENT, label: 'Swipe up', group: 'gesture' },
  { eventType: OsEventTypeList.SCROLL_BOTTOM_EVENT, label: 'Swipe down', group: 'gesture' },
  { eventType: OsEventTypeList.LONG_PRESS_EVENT, label: 'Long press', group: 'gesture' },
  {
    eventType: OsEventTypeList.LONG_PRESS_RELEASE_EVENT,
    label: 'Long press release',
    group: 'gesture',
  },
  { eventType: OsEventTypeList.FOREGROUND_ENTER_EVENT, label: 'Foreground enter', group: 'lifecycle' },
  { eventType: OsEventTypeList.FOREGROUND_EXIT_EVENT, label: 'Foreground exit', group: 'lifecycle' },
  {
    eventType: OsEventTypeList.SYSTEM_EXIT_EVENT,
    label: 'System exit',
    group: 'lifecycle',
    endsApp: true,
  },
  {
    eventType: OsEventTypeList.ABNORMAL_EXIT_EVENT,
    label: 'Abnormal exit',
    group: 'lifecycle',
    endsApp: true,
  },
  { eventType: OsEventTypeList.IMU_DATA_REPORT, label: 'IMU report', group: 'sensor' },
]

export function inputLabel(eventType: OsEventTypeList): string {
  return INPUT_DEFINITIONS.find((input) => input.eventType === eventType)?.label
    ?? `Unknown input ${String(eventType)}`
}

export function inputCode(eventType: OsEventTypeList): string {
  return `${OsEventTypeList[eventType] ?? 'UNKNOWN_EVENT'} (${eventType})`
}

export function normalizeInputType(raw: unknown): OsEventTypeList | null {
  return OsEventTypeList.fromJson(raw) ?? null
}

export function selectInputType(
  ...eventTypes: Array<OsEventTypeList | null>
): OsEventTypeList | null {
  const priority = [
    OsEventTypeList.DOUBLE_CLICK_EVENT,
    OsEventTypeList.SCROLL_TOP_EVENT,
    OsEventTypeList.SCROLL_BOTTOM_EVENT,
    OsEventTypeList.CLICK_EVENT,
    OsEventTypeList.SYSTEM_EXIT_EVENT,
    OsEventTypeList.ABNORMAL_EXIT_EVENT,
    OsEventTypeList.FOREGROUND_ENTER_EVENT,
    OsEventTypeList.FOREGROUND_EXIT_EVENT,
    OsEventTypeList.IMU_DATA_REPORT,
    OsEventTypeList.LONG_PRESS_EVENT,
    OsEventTypeList.LONG_PRESS_RELEASE_EVENT,
  ]
  return priority.find((eventType) => eventTypes.includes(eventType)) ?? null
}

export function inputTypeFromEvenHubEvent(event: EvenHubEvent): OsEventTypeList | null {
  return selectInputType(
    inputTypeFromEnvelope(event.sysEvent),
    inputTypeFromEnvelope(event.textEvent),
    inputTypeFromEnvelope(event.listEvent),
  )
}

function inputTypeFromEnvelope(envelope?: { eventType?: unknown }): OsEventTypeList | null {
  if (!envelope) return null

  // CLICK_EVENT is protobuf enum value 0. The G2 host omits the zero-valued
  // field, including on its sysEvent envelope, while retaining eventSource.
  if (envelope.eventType == null) return OsEventTypeList.CLICK_EVENT
  return normalizeInputType(envelope.eventType)
}
