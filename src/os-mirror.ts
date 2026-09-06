import { buildGlassesPage, type GlassesFrame } from './glasses-display'
import { OS_NOTIFICATION, OS_NOTIFICATION_CLOSED, OS_MOTION_DURATION_MS, type OsRect } from './os-layout'
import { fitLines } from './dashboard'
import { CLOCK_IMAGE, clockImageState, renderClockPixels } from './dashboard-clock-image'

const clipRect = (rect: OsRect) => `inset(${rect.y / 288 * 100}% ${(576 - rect.x - rect.width) / 576 * 100}% ${(288 - rect.y - rect.height) / 288 * 100}% ${rect.x / 576 * 100}% round 8px)`

/** Uses the production container coordinates. Text rasterization remains a phone approximation. */
export function mountOsMirror(preview: HTMLElement): (frame: GlassesFrame) => void {
  const canvas = document.createElement('canvas')
  canvas.width = 576
  canvas.height = 288
  canvas.className = 'os-mirror'
  canvas.setAttribute('role', 'img')
  preview.append(canvas)
  let generation = 0
  let outgoing: HTMLCanvasElement | undefined
  let underlay: HTMLCanvasElement | undefined
  let lastBanner: string | undefined
  return frame => {
    if (frame.banner && frame.banner !== lastBanner && !frame.motion) frame = { ...frame,
      motion: { direction: 'drop', from: OS_NOTIFICATION_CLOSED, to: OS_NOTIFICATION, id: 0 } }
    lastBanner = frame.banner
    const current = ++generation
    if (!frame.motion && underlay) { underlay.remove(); underlay = undefined }
    if (frame.motion || !frame.dashboardSurface) { outgoing?.remove(); outgoing = undefined; underlay?.remove(); underlay = undefined }
    if (frame.motion && ['collapse', 'retract', 'lower'].includes(frame.motion.direction)) {
      outgoing = canvas.cloneNode() as HTMLCanvasElement
      outgoing.getContext('2d')!.drawImage(canvas, 0, 0)
      outgoing.setAttribute('aria-hidden', 'true')
      outgoing.style.zIndex = '51'
      preview.append(outgoing)
      const snapshot = outgoing
      snapshot.animate([{ clipPath: 'inset(0% 0% 0% 0% round 8px)' }, { clipPath: clipRect(frame.motion.to) }],
        { duration: OS_MOTION_DURATION_MS, easing: 'ease-in' }).finished.then(() => snapshot.remove(), () => snapshot.remove())
    }
    if (frame.motion?.direction === 'drop') {
      underlay = canvas.cloneNode() as HTMLCanvasElement
      underlay.getContext('2d')!.drawImage(canvas, 0, 0)
      underlay.setAttribute('aria-hidden', 'true')
      underlay.style.zIndex = '51'
      preview.append(underlay)
    }
    const surface = frame.dashboardSurface
    canvas.hidden = !surface
    preview.classList.toggle('os-layout', Boolean(surface))
    if (!surface) return
    canvas.setAttribute('aria-label', [surface.title, surface.text, surface.footer].filter(Boolean).join('. '))
    const draw = async () => {
      if (generation !== current) return
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, 576, 288)
      const page = buildGlassesPage(frame)
      if (page.imageObject?.some(item => item.containerName === CLOCK_IMAGE.containerName)) {
        const clock = clockImageState(surface, frame.banner)
        const pixels = renderClockPixels(clock.hour, clock.minute, clock.hiddenRows)
        ctx.fillStyle = '#b8ff8a'
        pixels.forEach((pixel, index) => {
          if (pixel) ctx.fillRect(CLOCK_IMAGE.xPosition + index % CLOCK_IMAGE.width,
            CLOCK_IMAGE.yPosition + Math.floor(index / CLOCK_IMAGE.width), 1, 1)
        })
      }
      for (const item of page.textObject ?? []) {
        const x = item.xPosition ?? 0, y = item.yPosition ?? 0
        const width = item.width ?? 0, height = item.height ?? 0
        ctx.save()
        ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip()
        if (item.borderWidth) {
          ctx.strokeStyle = item.borderColor === 2 ? '#6eaa58' : '#b8ff8a'
          ctx.lineWidth = item.borderWidth
          ctx.beginPath(); ctx.roundRect(x + .5, y + .5, width - 1, height - 1, item.borderRadius ?? 0); ctx.stroke()
        }
        ctx.fillStyle = item.textColor === 1 ? '#304c28' : item.textColor === 2 ? '#6eaa58' : '#b8ff8a'
        ctx.font = '20px Arial, sans-serif'
        ctx.textBaseline = 'top'
        const padding = item.paddingLength ?? 0
        let row = 0
        for (const line of (item.content ?? '').split('\n')) {
          for (const part of fitLines(line, width - 2 * padding, 20).split('\n')) {
            ctx.fillText(part, x + padding, y + padding + row++ * 27 + 3)
          }
        }
        ctx.restore()
      }
      if (frame.motion) {
        // The phone interpolates continuously. Native samples use the same
        // duration, with text/borders only and skips for slow acknowledgements.
        if (frame.motion.direction === 'drop' && underlay) {
          const background = underlay
          const overlay = canvas.cloneNode() as HTMLCanvasElement
          overlay.getContext('2d')!.drawImage(canvas, 0, 0)
          overlay.setAttribute('aria-hidden', 'true')
          overlay.style.zIndex = '52'
          preview.append(overlay)
          overlay.animate([{ clipPath: clipRect(frame.motion.from) }, { clipPath: clipRect(OS_NOTIFICATION) }],
            { duration: OS_MOTION_DURATION_MS, easing: 'ease-out' }).finished.then(() => { background.remove(); overlay.remove() }, () => { background.remove(); overlay.remove() })
        } else if (!['collapse', 'retract', 'lower'].includes(frame.motion.direction)) {
          canvas.getAnimations().forEach(animation => animation.cancel())
          canvas.animate([{ clipPath: clipRect(frame.motion.from) }, { clipPath: 'inset(0% 0% 0% 0% round 8px)' }],
            { duration: OS_MOTION_DURATION_MS, easing: 'ease-out' })
        }
      }
    }
    void draw().catch(() => { if (generation === current) canvas.hidden = true })
  }
}
