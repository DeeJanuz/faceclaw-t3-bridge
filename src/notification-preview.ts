import { fitLines } from './dashboard'

/** One shared two-line preview for live arrivals and the notification browser. */
export function notificationPreview(subject: string, message: string): string {
  const clean = (value: string) => value.replace(/\s+/g, ' ').trim()
  const title = clean(subject).replace(/:$/, '')
  return fitLines([title, clean(message)].filter(Boolean).join(': '), 512, 2)
}
