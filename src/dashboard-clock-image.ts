import type { DashboardSurface } from './dashboard-surface'

// Both rows fit in one SDK image. All surrounding labels remain native text.
export const CLOCK_IMAGE = { containerID: 9, containerName: 'home-clock',
  xPosition: 46, yPosition: 66, width: 128, height: 144, zOrderIndex: 0 } as const

// Reconstructed from the dotted 09 / 53 dashboard clock in the public Even OS
// guidelines: an 18 × 21 dot grid, three-dot strokes, and clipped outer corners.
// Rectangles are dot-grid x, y, width, height. Open stroke ends have no hooks.
const TOP = [3, 0, 12, 3], BOTTOM = [3, 18, 12, 3], MIDDLE = [3, 9, 12, 3]
const LEFT = [0, 3, 3, 15], RIGHT = [15, 3, 3, 15]
const DIGITS = [
  [TOP, LEFT, RIGHT, BOTTOM],
  [[12, 0, 3, 3], [15, 3, 3, 18]],
  [[0, 0, 15, 3], [15, 3, 3, 6], MIDDLE, [0, 12, 3, 6], [3, 18, 15, 3]],
  [[0, 0, 15, 3], RIGHT, MIDDLE, [0, 18, 15, 3]],
  [[0, 0, 3, 9], MIDDLE, [15, 0, 3, 21]],
  [[0, 0, 15, 3], [0, 3, 3, 6], [0, 9, 15, 3], [15, 12, 3, 6], [0, 18, 15, 3]],
  [TOP, LEFT, MIDDLE, [15, 12, 3, 6], BOTTOM],
  [[0, 0, 15, 3], [15, 3, 3, 18]],
  [TOP, LEFT, RIGHT, MIDDLE, BOTTOM],
  [TOP, [0, 3, 3, 6], RIGHT, MIDDLE, BOTTOM],
]

export function clockImageState(surface: DashboardSurface, banner?: string) {
  // Hide the intersecting hour row as a whole beneath the notification card.
  const hiddenRows = surface.view === 'notifications' || banner ? 81 : 0
  const { hour, minute } = surface.panel
  return { hour, minute, hiddenRows, key: `${hour}:${minute}:${hiddenRows}` }
}

/** Pixel-aligned 2 × 2 dots, separated by one dark pixel, with no font loading. */
export function renderClockPixels(hour: string, minute: string, hiddenRows = 0): number[] {
  const pixels = new Array<number>(CLOCK_IMAGE.width * CLOCK_IMAGE.height).fill(0)
  for (const [row, value] of [hour, minute].entries()) {
    for (const [column, digit] of value.padStart(2, '0').slice(-2).split('').entries()) {
      for (const [x, y, width, height] of DIGITS[Number(digit)] ?? []) {
        for (let gy = y!; gy < y! + height!; gy++) for (let gx = x!; gx < x! + width!; gx++) {
          for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
            const py = row * 81 + gy * 3 + dy
            if (py >= hiddenRows) pixels[py * CLOCK_IMAGE.width + 4 + column * 65 + gx * 3 + dx] = 255
          }
        }
      }
    }
  }
  return pixels
}
