export function dashboardClock(now: Date): { hour: string; minute: string; period: 'AM' | 'PM'; hour24: number } {
  const hour24 = now.getHours()
  return {
    hour: String(hour24 % 12 || 12).padStart(2, '0'),
    minute: String(now.getMinutes()).padStart(2, '0'),
    period: hour24 < 12 ? 'AM' : 'PM',
    hour24,
  }
}
