import { describe, expect, it } from 'vitest'
import { notificationPreview } from './notification-preview'
import { buildGlassesPage } from './glasses-display'
import { validateEvenHubPageContainer } from '@evenrealities/even_hub_sdk'

describe('arrival popup previews', () => {
  it('uses subject, colon, message and truncates at two lines', () => {
    expect(notificationPreview(' Friends: ', '  Lunch at noon.')).toBe('Friends: Lunch at noon.')
    const preview = notificationPreview('Friends', 'A very long message with lots of detail. '.repeat(12))
    expect(preview).toMatch(/^Friends: A very long message/)
    expect(preview.split('\n')).toHaveLength(2)
    expect(preview).toMatch(/\.\.\.$/)
  })
  it.each(['reader', 'voice', 'content', 'plan'] as const)('overlays %s without moving underlying lines or exceeding native limits', view => {
    const page = buildGlassesPage({ header: 'Reader', body: '', banner: 'Signal\nFriends: Lunch at noon.',
      dashboardSurface: { view, title: 'Reader', text: 'First\nSecond\nThird\nFourth\nFifth', footer: 'Back', focusLine: 0,
        panel: { hour: '12', minute: '30', period: 'PM', hour24: 12, date: 'Sat', batteryPercent: 50, connection: 'Connected', weather: [], unread: 2 } } })
    expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
    expect(page.textObject!.find(item => item.containerName === 'body')).toMatchObject({ yPosition: 42, content: '\n\n\nFourth\nFifth' })
    expect(page.textObject!.find(item => item.containerName === 'arrival-body')).toMatchObject({ xPosition: 32, yPosition: 54, width: 512, height: 54, content: 'Friends: Lunch at noon.' })
    expect(page.imageObject).toEqual([])
  })
})
