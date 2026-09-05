/** The phone mirror and native image tiles share this 220 × 288 pixel panel. */
export interface DashboardPanel {
  hour: string
  minute: string
  period: 'AM' | 'PM'
  hour24: number
  date: string
  batteryPercent: number | null
  connection: string
  weather: string[]
  unread: number
}

export const PANEL_WIDTH = 220
export const PANEL_HEIGHT = 288
const asset = (name: string) => `${import.meta.env.BASE_URL}dashboard/${name}`
let fontReady: Promise<void> | undefined
const icons = new Map<string, Promise<HTMLImageElement>>()
let lastRender: { key: string; value: Promise<HTMLCanvasElement> } | undefined

export function weatherIcon(condition: string, hour: number): string {
  if (/thunder/i.test(condition)) return 'cloud-storm'
  if (/snow|sleet|ice|freezing/i.test(condition)) return 'cloud-snow'
  if (/rain|drizzle|shower/i.test(condition)) return 'cloud-rain'
  if (/fog|mist/i.test(condition)) return 'mist'
  if (/cloud|overcast/i.test(condition)) return 'cloud'
  return hour < 6 || hour >= 19 ? 'moon' : 'sun'
}

async function icon(name: string): Promise<HTMLImageElement> {
  let pending = icons.get(name)
  if (!pending) {
    pending = fetch(asset(`${name}.svg`)).then(response => {
      if (!response.ok) throw new Error('Dashboard icon unavailable')
      return response.text()
    }).then(svg => new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replaceAll('currentColor', '#ffffff'))}`
    }))
    icons.set(name, pending)
  }
  return pending
}

function lines(context: CanvasRenderingContext2D, text: string, width: number, limit: number): string[] {
  const words = text.split(/\s+/)
  const result: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (context.measureText(next).width > width && line) { result.push(line); line = word }
    else line = next
  }
  if (line) result.push(line)
  return result.slice(0, limit).map((value, index) => {
    let fitted = value
    const truncated = index === limit - 1 && result.length > limit
    while (fitted && context.measureText(fitted + (truncated ? '…' : '')).width > width) fitted = fitted.slice(0, -1)
    return fitted + (truncated ? '…' : '')
  })
}

export function renderDashboardPanel(panel: DashboardPanel): Promise<HTMLCanvasElement> {
  // The unread count lives in the top bell, outside this cached panel.
  const { unread: _unread, ...visual } = panel
  const key = JSON.stringify(visual)
  if (lastRender?.key === key) return lastRender.value
  const value = drawPanel(panel)
  lastRender = { key, value }
  void value.catch(() => { if (lastRender?.key === key) lastRender = undefined })
  return value
}

async function drawPanel(panel: DashboardPanel): Promise<HTMLCanvasElement> {
  fontReady ??= new FontFace('Dashboard Doto', `url(${asset('doto.ttf')})`, { weight: '700' }).load().then(font => {
    document.fonts.add(font)
  }).catch(() => { fontReady = undefined })
  await fontReady
  const canvas = document.createElement('canvas')
  canvas.width = PANEL_WIDTH
  canvas.height = PANEL_HEIGHT
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, PANEL_WIDTH, PANEL_HEIGHT)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  ctx.font = '700 18px "Dashboard Doto", monospace'
  ctx.fillText(panel.date, 22, 18, 146)
  const drawIcon = async (name: string, x: number, y: number, size: number) => {
    try { ctx.drawImage(await icon(name), x, y, size, size) } catch { /* Keep the clock usable offline. */ }
  }
  await drawIcon('battery', 182, 16, 24)
  if (panel.batteryPercent !== null) ctx.fillRect(185, 24, Math.round(14 * panel.batteryPercent / 100), 6)
  else { ctx.font = '12px monospace'; ctx.fillText('?', 188, 22) }

  ctx.font = '700 15px "Dashboard Doto", monospace'
  ctx.fillText(lines(ctx, panel.connection, 180, 1)[0] ?? '', 22, 43)
  ctx.font = '700 86px "Dashboard Doto", monospace'
  // A fine raster inside the glyphs reproduces the native clock's LED texture.
  const dot = document.createElement('canvas')
  dot.width = dot.height = 3
  const dotContext = dot.getContext('2d')!
  dotContext.fillStyle = '#fff'
  dotContext.fillRect(0, 0, 2, 2)
  ctx.fillStyle = ctx.createPattern(dot, 'repeat')!
  ctx.textAlign = 'center'
  ctx.fillText(panel.hour, 116, 64)
  ctx.fillText(panel.minute, 116, 134)
  ctx.textAlign = 'left'
  ctx.fillStyle = '#fff'

  ctx.font = '700 17px "Dashboard Doto", monospace'
  ctx.fillText(panel.period, 181, 181)

  const hasTemperature = /^-?\d+°[FC]$/.test(panel.weather[0] ?? '')
  const condition = hasTemperature ? panel.weather[1] ?? '' : panel.weather[0] ?? ''
  ctx.font = '16px sans-serif'
  const conditionLines = lines(ctx, condition, 188, 2)
  conditionLines.forEach((line, index) => ctx.fillText(line, 22, 222 + index * 18))
  const detailY = 222 + Math.max(1, conditionLines.length) * 18 + 6
  const source = panel.weather.slice(2).join(' · ')
  // Source/staleness remains visible even with a two-line condition.
  if (source) { ctx.font = '10px sans-serif'; ctx.fillText(source, hasTemperature ? 108 : 22, detailY + 6, hasTemperature ? 100 : 188) }
  if (hasTemperature) {
    await drawIcon(weatherIcon(condition, panel.hour24), 22, detailY, 21)
    ctx.font = '700 20px "Dashboard Doto", monospace'
    ctx.fillText(panel.weather[0]!, 50, detailY - 1)
  }
  return canvas
}

export function panelTiles(canvas: HTMLCanvasElement): number[][] {
  const context = canvas.getContext('2d')!
  return [0, 144].map(y => {
    const rgba = context.getImageData(0, y, PANEL_WIDTH, 144).data
    return Array.from({ length: PANEL_WIDTH * 144 }, (_, index) => rgba[index * 4]!)
  })
}
