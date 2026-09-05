import { describe, expect, it } from 'vitest'
import { dashboardClock } from './dashboard-clock'
import { weatherIcon } from './dashboard-panel'

describe('dashboard clock', () => {
  it.each([
    [0, 0, '12', '00', 'AM'], [11, 59, '11', '59', 'AM'],
    [12, 0, '12', '00', 'PM'], [13, 5, '01', '05', 'PM'], [23, 59, '11', '59', 'PM'],
  ] as const)('formats local %i:%i as %s:%s %s', (hour24, minute, hour, minutes, period) => {
    expect(dashboardClock(new Date(2026, 8, 4, hour24, minute))).toEqual({ hour, minute: minutes, period, hour24 })
  })
  it('keeps day/night weather independent of the displayed 12-hour digits', () => {
    expect(weatherIcon('Clear', dashboardClock(new Date(2026, 8, 4, 13)).hour24)).toBe('sun')
    expect(weatherIcon('Clear', dashboardClock(new Date(2026, 8, 4, 1)).hour24)).toBe('moon')
  })
})
