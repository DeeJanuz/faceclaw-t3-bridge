import { isDashboardLayer } from './dashboard-overlay'
import { nativeDashboard } from './native-dashboard'
import { CLOCK_IMAGE, clockImageState, renderClockPixels } from './dashboard-clock-image'
import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'
import { OS_FULL, OS_MOTION_DURATION_MS, interpolateRect, type OsMotion, type OsRect } from './os-layout'
import { ASK_ASSISTANT_MENU_ID } from './dashboard'
import { dashboardSurfaceText, type DashboardSurface } from './dashboard-surface'
export { DASHBOARD_READER_BOX } from './dashboard-surface'
import { panelTiles, renderDashboardPanel, type DashboardPanel } from './dashboard-panel'

const HEADER_ID = 1
const BODY_ID = 2
const ACTIVITY_LEFT_ID = 9
const ACTIVITY_LABEL_ID = 4
const ACTIVITY_RIGHT_ID = 10
const CARD_ID = 6
const CARD_VEIL_ID = 13
// Hardware probes accepted IDs 9–12 with short names. Keep those identities
// stable across card, activity, and cleanup rebuilds.
const DISPLAY_IMAGE_SLOTS = [
  { containerID: ACTIVITY_LEFT_ID, containerName: 'tile-0' },
  { containerID: ACTIVITY_RIGHT_ID, containerName: 'tile-1' },
  { containerID: 11, containerName: 'tile-2' },
  { containerID: 12, containerName: 'tile-3' },
] as const
const BODY_Y = 30
const BODY_PADDING = 2
const LINE_HEIGHT = 27
const MAX_ACTIVITY_LINE_INDEX = 8
const SPINNER_SIZE = 20
const SPINNER_FRAME_COUNT = 8
const CARD_X = 28
const CARD_Y = 29
const CARD_WIDTH = 520
const CARD_HEIGHT = 230
const HIDDEN_IMAGE_SIZE = 20
const HIDDEN_IMAGE_X = 576 - HIDDEN_IMAGE_SIZE
const HIDDEN_IMAGE_Y = 288 - HIDDEN_IMAGE_SIZE
const ACTIVITY_LEFT_X = 0
const ACTIVITY_LABEL_X = 27
const ACTIVITY_GAP = 3
const MAX_ACTIVITY_LABEL_WIDTH = 400

export interface GlassesActivityLine {
  kind: 'thinking' | 'tool'
  label?: string
  frame: number
  lineIndex: number
}

export interface GlassesFrame {
  banner?: string
  header: string
  body: string
  mirrorBody?: string
  activity?: GlassesActivityLine
  card?: GlassesCard
  dashboard?: { left: string; panel?: DashboardPanel; actions?: DashboardActionRow[] }
  askAssistant?: boolean
  menuItems?: Array<{ itemID: number; itemName: string }>
  motion?: OsMotion
  // OS surfaces use native text and borders, plus one home clock image.
  dashboardSurface?: DashboardSurface
}

const SURFACE_FOOTER_ID = 7

function surfaceText(frame: GlassesFrame) {
  return dashboardSurfaceText(frame.dashboardSurface!, frame.banner)
}

function transitionPage(next: GlassesFrame, previous: GlassesFrame, motion: OsMotion, rect: OsRect): RebuildPageContainer {
  const closing = ['collapse', 'retract', 'lower'].includes(motion.direction)
  const source = closing ? previous : next
  if (['drop', 'retract'].includes(motion.direction) && isDashboardLayer(source.dashboardSurface)) {
    // While the dropdown is short, both home actions remain visible. Omit the
    // clock's period along with its image so the sample stays within 8 texts.
    const textObject = nativeDashboard(source.dashboardSurface!, source.banner, rect, { showPeriod: false })
    return new RebuildPageContainer({ containerTotalNum: textObject.length, textObject, imageObject: [] })
  }
  const outline = textContainer(5, 'os-transition', rect.x, rect.y, rect.width, rect.height, '', 0, 1)
  outline.borderWidth = 1; outline.borderColor = 4; outline.borderRadius = 8
  const textObject = [textContainer(8, 'surface-input', 0, 0, 576, 288, ' ', 1, 0), outline]
  const content = source.dashboardSurface ? surfaceText(source) : { title: source.header, text: source.body }
  if (rect.height >= 48) textObject.push(textContainer(HEADER_ID, 'header', rect.x + 16, rect.y + 10,
    rect.width - 32, 27, content.title, 0, 2))
  if (rect.height >= 80) textObject.push(textContainer(BODY_ID, 'body', rect.x + 16, rect.y + 42,
    rect.width - 32, Math.floor((rect.height - 50) / 27) * 27, content.text, 0, 3))
  return new RebuildPageContainer({ containerTotalNum: textObject.length, textObject, imageObject: [], menuObject: contextualMenu(next) })
}

function dashboardSurfacePage(frame: GlassesFrame): PageContainers {
  const content = surfaceText(frame)
  if (!isDashboardLayer(frame.dashboardSurface)) {
    const rect = OS_FULL
    const border = textContainer(5, 'os-border', 0, 0, rect.width, rect.height, '', 0, 1)
    border.borderWidth = 1; border.borderColor = 4; border.borderRadius = 8
    const selectedLine = frame.dashboardSurface!.focusLine ?? -1
    const focus: TextContainerProperty[] = []
    if (!frame.banner && selectedLine >= 0 && selectedLine < 8) {
      border.borderColor = 2
      const item = textContainer(6, 'os-focus', 8, 38 + selectedLine * 27, 560, 35, '', 0, 1)
      item.borderWidth = 1; item.borderColor = 4; item.borderRadius = 4
      focus.push(item)
    }
    const textObject = [textContainer(8, 'surface-input', 0, 0, 576, 288, ' ', 1, 0), border, ...focus,
      textContainer(HEADER_ID, 'header', 16, 10, 544, 28, content.title, 0, 2),
      textContainer(BODY_ID, 'body', 16, 42, 544, 216, content.text || ' ', 0, 3),
      textContainer(SURFACE_FOOTER_ID, 'surface-footer', 16, 258, 544, 27, content.footer || ' ', 0, 4),
    ]
    if (frame.banner) {
      const [title = '', ...body] = frame.banner.split('\n')
      const header = textObject.find(item => item.containerID === HEADER_ID)!
      header.xPosition = 32; header.yPosition = 22; header.width = 512; header.content = title
      const underlying = textObject.find(item => item.containerID === BODY_ID)!
      underlying.content = content.text.split('\n').map((line, index) => index < 3 ? '' : line).join('\n') || ' '
      const popup = textContainer(3, 'arrival-border', 16, 12, 544, 104, '', 0)
      popup.borderWidth = 1; popup.borderColor = 4; popup.borderRadius = 8
      textObject.push(popup, textContainer(4, 'arrival-body', 32, 54, 512, 54, body.join('\n'), 0))
    }
    textObject.forEach((item, index) => { item.zOrderIndex = index })
    return { textObject, imageObject: [] }
  }
  return { textObject: nativeDashboard(frame.dashboardSurface!, frame.banner),
    imageObject: [new ImageContainerProperty(CLOCK_IMAGE)] }
}

export interface DashboardActionRow { key: string; label: string; selected: boolean; previews?: string[] }
const actionText = (row: DashboardActionRow) => `${row.selected ? '> ' : '  '}${row.label}${row.previews?.length ? '\n' + row.previews.join('\n') : ''}`

function pinnedNotifications(frame: GlassesFrame): boolean { return Boolean(frame.dashboard?.actions?.[0]?.previews?.length) }

export interface GlassesCard {
  title: string
  meta?: string
  body: string
  presentation?: 'plan' | 'voice' | 'notifications'
  placement?: 'dashboard'
  entrance?: 'bottom' | 'right' | 'down'
  transition?: number
  // Used only for the native entrance step; coordinates remain on-display.
  entering?: boolean
}

export function voiceOverlay(background: GlassesFrame, title: string, body: string): GlassesFrame {
  const panel = background.dashboard?.panel ?? background.dashboardSurface?.panel
  return { ...background, dashboard: background.dashboard ?? (panel ? { left: '', panel } : undefined), dashboardSurface: undefined, activity: undefined, menuItems: [], askAssistant: false,
    card: { title, body, presentation: 'voice', placement: panel ? 'dashboard' : undefined } }
}

// Dashboard cards use exposed background outlines instead of image masks.
// The sidebar is entirely left of the card; overlapping labels are hidden until
// dismissal so narrowing their containers cannot reflow text into the margin.
function clippedDashboardCard(frame: GlassesFrame): boolean {
  return (frame.card?.presentation === 'voice' || frame.card?.presentation === 'notifications')
    && frame.card.placement === 'dashboard' && Boolean(frame.dashboard?.panel)
}

function cardBounds(card: GlassesCard) {
  if (card.presentation === 'notifications') return { x: 259, y: 14, width: 288, height: card.entering ? 154 : 258 }
  if (card.placement === 'dashboard') return { x: 272, y: CARD_Y, width: 288, height: CARD_HEIGHT }
  if (card.presentation !== 'plan') return { x: CARD_X, y: CARD_Y, width: CARD_WIDTH, height: CARD_HEIGHT }
  const x = card.entering && card.entrance === 'right' ? 0 : 16
  const y = card.entering && card.entrance === 'bottom' ? 146 : 58
  return { x, y, width: 544, height: 278 - y }
}

interface ActivityLayout {
  textY: number
  imageY: number
  label: string
  rightX: number
}

interface PageContainers {
  textObject: TextContainerProperty[]
  imageObject: ImageContainerProperty[]
}

interface PendingRender {
  frame: GlassesFrame
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>
}

function activityLabel(activity: GlassesActivityLine): string {
  if (activity.kind === 'thinking') return 'thinking'
  const normalized = activity.label?.replace(/\s+/g, ' ').trim() || 'tool call'
  if (getTextWidth(normalized) <= MAX_ACTIVITY_LABEL_WIDTH) return normalized
  let fitted = normalized.slice(0, 160).replace(/\.*$/, '')
  while (fitted.length > 1 && getTextWidth(`${fitted}...`) > MAX_ACTIVITY_LABEL_WIDTH) {
    fitted = fitted.slice(0, -1)
  }
  return `${fitted}...`
}

function normalizedFrame(frame: number): number {
  return Math.abs(Math.floor(frame)) % SPINNER_FRAME_COUNT
}

function activityKey(activity?: GlassesActivityLine): string {
  return activity ? `${activity.kind}:${activityLabel(activity)}:${normalizedFrame(activity.frame)}` : ''
}

function activityLayout(activity: GlassesActivityLine): ActivityLayout {
  const label = activityLabel(activity)
  const lineIndex = Math.min(MAX_ACTIVITY_LINE_INDEX, Math.max(0, activity.lineIndex))
  const textY = BODY_Y + BODY_PADDING + lineIndex * LINE_HEIGHT
  return {
    textY,
    imageY: textY + Math.floor((LINE_HEIGHT - SPINNER_SIZE) / 2),
    label,
    rightX: ACTIVITY_LABEL_X + getTextWidth(label) + ACTIVITY_GAP,
  }
}

function sameLayout(left: ActivityLayout, right: ActivityLayout): boolean {
  return left.textY === right.textY && left.label === right.label && left.rightX === right.rightX
}

function textContainer(
  containerID: number,
  containerName: string,
  xPosition: number,
  yPosition: number,
  width: number,
  height: number,
  content: string,
  isEventCapture: number,
  zOrderIndex?: number,
  paddingLength = 0,
): TextContainerProperty {
  return new TextContainerProperty({
    xPosition,
    yPosition,
    width,
    height,
    paddingLength,
    borderWidth: 0,
    containerID,
    containerName,
    content: content.slice(0, 1000),
    isEventCapture,
    zOrderIndex,
    textColor: containerID === HEADER_ID ? 2 : 4,
  })
}

function pageContainers(frame: GlassesFrame, layout: ActivityLayout, label: string, preparingCard = false): PageContainers {
  if (frame.dashboardSurface) return dashboardSurfacePage(frame)
  const page = basePageContainers({ ...frame, banner: undefined }, layout, label, preparingCard)
  if (frame.banner) {
    // Reserve the top two lines while preserving the active event container.
    page.textObject = page.textObject.map(item => {
      const top = item.yPosition ?? 0
      const height = item.height ?? 1
      if (top >= 56) return item
      return new TextContainerProperty({ ...item, yPosition: 56,
        height: Math.max(1, height - (56 - top)), content: top + height <= 56 ? ' ' : item.content })
    })
    page.textObject.push(textContainer(15, 'arrival', 8, 0, 560, 56, frame.banner, 0, 30, 0))
  }
  return page
}

function basePageContainers(
  frame: GlassesFrame,
  layout: ActivityLayout,
  label: string,
  preparingCard = false,
): PageContainers {
  if (frame.dashboard && !frame.card) {
    if (frame.dashboard.panel && frame.dashboard.actions) return {
      textObject: [
        textContainer(HEADER_ID, 'header', 247, 24, 282, 28, pinnedNotifications(frame) ? ' ' : frame.header, 0, 0),
        textContainer(BODY_ID, 'body', 247, 58, 288, 54, pinnedNotifications(frame) ? ' ' : frame.body, 1, 1),
        ...frame.dashboard.actions.map((row, index) => new TextContainerProperty({
          containerID: 5 + index, containerName: `action-${index}`,
          xPosition: pinnedNotifications(frame) ? 259 : 231,
          yPosition: pinnedNotifications(frame) ? [14, 178, 228][index] : (frame.body ? 124 : 64) + index * (frame.body ? 50 : 68),
          width: pinnedNotifications(frame) ? 288 : 316,
          height: pinnedNotifications(frame) ? (index === 0 ? 154 : 42) : frame.body ? 44 : 52, paddingLength: pinnedNotifications(frame) ? 6 : 8,
          borderWidth: 1, borderColor: 2, borderRadius: 6,
          content: actionText(row), textColor: row.selected ? 4 : 2, isEventCapture: 0, zOrderIndex: 2 + index,
        })),
      ],
      imageObject: DISPLAY_IMAGE_SLOTS.slice(0, 2).map((slot, index) => new ImageContainerProperty({
        ...slot, xPosition: 0, yPosition: index * 144, width: 220, height: 144, zOrderIndex: 6 + index,
      })),
    }
    if (frame.dashboard.panel) return {
      textObject: [
        new TextContainerProperty({ xPosition: 231, yPosition: 14, width: 316, height: 258,
          paddingLength: 0, borderWidth: 1, borderColor: 4, borderRadius: 6, content: ' ',
          containerID: 5, containerName: 'dashboard-frame', isEventCapture: 0, zOrderIndex: 0 }),
        textContainer(HEADER_ID, 'header', 247, 24, 282, 28, frame.header, 0, 1),
        new TextContainerProperty({ xPosition: 231, yPosition: 60, width: 316, height: 212,
          paddingLength: 14, borderWidth: 0, zOrderIndex: 2,
          containerID: BODY_ID, containerName: 'body', content: frame.body.slice(0, 1000),
          isEventCapture: 1, textColor: 4 }),
      ],
      imageObject: DISPLAY_IMAGE_SLOTS.slice(0, 2).map((slot, index) => new ImageContainerProperty({
        ...slot, xPosition: 0, yPosition: index * 144, width: 220, height: 144, zOrderIndex: 3 + index,
      })),
    }
    return {
      textObject: [
        textContainer(HEADER_ID, 'header', 0, 0, 576, 28, frame.header, 0),
        textContainer(3, 'status', 0, BODY_Y, 192, 258, frame.dashboard.left, 0, undefined, 2),
        textContainer(BODY_ID, 'body', 208, BODY_Y, 368, 258, frame.body, 1, undefined, 2),
      ],
      imageObject: [],
    }
  }
  if (frame.card?.placement === 'dashboard' && frame.dashboard?.panel) {
    const background = pageContainers({ ...frame, card: undefined }, layout, label)
    const bounds = cardBounds(frame.card)
    const clipped = clippedDashboardCard(frame)
    return {
      textObject: [
        ...background.textObject.map((item, index) => {
          const overlaps = clipped && item.xPosition! < bounds.x + bounds.width
            && item.xPosition! + item.width! > bounds.x && item.yPosition! < bounds.y + bounds.height
            && item.yPosition! + item.height! > bounds.y
          const exposedWidth = Math.max(0, bounds.x - item.xPosition!)
          return new TextContainerProperty({ ...item,
            ...(overlaps ? { content: ' ', paddingLength: 0,
              width: exposedWidth || item.width, borderWidth: exposedWidth ? item.borderWidth : 0 } : {}),
            containerID: item.containerID === CARD_ID ? 15 : item.containerID,
            // The app moves the notification highlight. Capture gestures in the
            // blank background body so native text scrolling cannot also move
            // the expanded card's title and rows.
            isEventCapture: frame.card?.presentation === 'notifications' && item.containerID === BODY_ID ? 1 : 0, zOrderIndex: index })
        }),
        new TextContainerProperty({ xPosition: bounds.x, yPosition: bounds.y,
          width: bounds.width, height: bounds.height, paddingLength: 8,
          borderWidth: 1, borderColor: 4, borderRadius: 8,
          containerID: CARD_ID, containerName: 'voice-card',
          content: preparingCard ? ' ' : `${frame.card.title}\n\n${frame.card.body}`.slice(0, 1000),
          isEventCapture: frame.card.presentation === 'notifications' ? 0 : 1, textColor: 4, zOrderIndex: 10 }),
      ], imageObject: [
        ...background.imageObject.map((item, index) => new ImageContainerProperty({ ...item, zOrderIndex: 6 + index })),
        ...(clipped ? [] : DISPLAY_IMAGE_SLOTS.slice(2).map((slot, index) => new ImageContainerProperty({ ...slot,
          xPosition: bounds.x, yPosition: bounds.y + index * bounds.height / 2,
          width: bounds.width, height: bounds.height / 2, zOrderIndex: 8 + index }))),
      ],
    }
  }
  if (frame.card) {
    const bounds = cardBounds(frame.card)
    return {
      textObject: [
        textContainer(HEADER_ID, 'header', 0, 0, 576, 28, frame.header, 0, 1),
        // The four image tiles cover only the card rectangle. Keep the
        // transcript underneath so its margins remain in their original position.
        textContainer(BODY_ID, 'body', 0, BODY_Y, 576, 258, frame.body, 0, 2, BODY_PADDING),
        new TextContainerProperty({
          xPosition: bounds.x,
          yPosition: bounds.y,
          width: bounds.width,
          height: bounds.height,
          paddingLength: 8,
          borderWidth: 1,
          borderColor: 4,
          borderRadius: 8,
          containerID: CARD_ID,
          containerName: 'voice-card',
          content: preparingCard ? ' ' : `${frame.card.title}\n\n${frame.card.body}`.slice(0, 1000),
          isEventCapture: 1,
          textColor: 4,
          zOrderIndex: 7,
        }),
        // Keep the same transcript above the image layers while they upload.
        // Clearing this one text container reveals all four black tiles together.
        textContainer(CARD_VEIL_ID, 'card-veil', 0, BODY_Y, 576, 258,
          preparingCard ? frame.body : ' ', 0, 8, BODY_PADDING),
      ],
      imageObject: DISPLAY_IMAGE_SLOTS.map((slot, index) => new ImageContainerProperty({
        xPosition: bounds.x + (index % 2) * bounds.width / 2,
        yPosition: bounds.y + Math.floor(index / 2) * bounds.height / 2,
        width: bounds.width / 2,
        height: bounds.height / 2,
        containerID: slot.containerID,
        containerName: slot.containerName,
        zOrderIndex: index + 3,
      })),
    }
  }
  const textObject = [
    textContainer(HEADER_ID, 'header', 0, 0, 576, 28, frame.header, 0, 10),
    textContainer(
      BODY_ID,
      'body',
      0,
      BODY_Y,
      576,
      258,
      frame.body,
      1,
      11,
      BODY_PADDING,
    ),
    textContainer(
      ACTIVITY_LABEL_ID,
      'activity-label',
      ACTIVITY_LABEL_X,
      layout.textY,
      Math.max(20, Math.ceil(getTextWidth(label))),
      LINE_HEIGHT,
      label || ' ',
      0,
      12,
    ),
  ]
  const activityImages = frame.activity
    ? [
        new ImageContainerProperty({
          xPosition: ACTIVITY_LEFT_X,
          yPosition: layout.imageY,
          width: SPINNER_SIZE,
          height: SPINNER_SIZE,
          containerID: DISPLAY_IMAGE_SLOTS[0].containerID,
          containerName: DISPLAY_IMAGE_SLOTS[0].containerName,
          zOrderIndex: 13,
        }),
        new ImageContainerProperty({
          xPosition: layout.rightX,
          yPosition: layout.imageY,
          width: SPINNER_SIZE,
          height: SPINNER_SIZE,
          containerID: DISPLAY_IMAGE_SLOTS[1].containerID,
          containerName: DISPLAY_IMAGE_SLOTS[1].containerName,
          zOrderIndex: 14,
        }),
      ]
    : DISPLAY_IMAGE_SLOTS.slice(0, 2).map((slot, index) => new ImageContainerProperty({
        xPosition: HIDDEN_IMAGE_X,
        yPosition: HIDDEN_IMAGE_Y,
        width: HIDDEN_IMAGE_SIZE,
        height: HIDDEN_IMAGE_SIZE,
        containerID: slot.containerID,
        containerName: slot.containerName,
        zOrderIndex: index + 1,
      }))
  return {
    textObject,
    imageObject: [
      ...activityImages,
      ...DISPLAY_IMAGE_SLOTS.slice(2).map((slot, index) => new ImageContainerProperty({
        xPosition: HIDDEN_IMAGE_X,
        yPosition: HIDDEN_IMAGE_Y,
        width: HIDDEN_IMAGE_SIZE,
        height: HIDDEN_IMAGE_SIZE,
        containerID: slot.containerID,
        containerName: slot.containerName,
        zOrderIndex: index + 3,
      })),
    ],
  }
}

function blankImage(): number[] {
  return new Array<number>(SPINNER_SIZE * SPINNER_SIZE).fill(0)
}

// Diagnostics use the same page builder as production, with synthetic text only.
export function buildGlassesPage(frame: GlassesFrame): RebuildPageContainer {
  const layout = activityLayout(frame.activity ?? { kind: 'thinking', frame: 0, lineIndex: 0 })
  const page = pageContainers(frame, layout, frame.activity ? layout.label : ' ')
  return new RebuildPageContainer({
    containerTotalNum: page.textObject.length + page.imageObject.length,
    textObject: page.textObject,
    imageObject: page.imageObject,
    menuObject: contextualMenu(frame),
  })
}

function contextualMenu(frame: GlassesFrame): MenuContainerProperty | undefined {
  // Home and the overlay keep the standard OS menu. Context actions belong
  // to expanded pages.
  if (frame.dashboardSurface?.view === 'home' || frame.dashboardSurface?.view === 'notifications') return undefined
  const items = frame.menuItems ?? (frame.askAssistant ? [{ itemID: ASK_ASSISTANT_MENU_ID, itemName: 'Ask assistant' }] : [])
  return items.length ? new MenuContainerProperty({ menuItems: items.map(item => new MenuItemProperty(item)) }) : undefined
}

function spinnerImage(frame: number): number[] {
  const pixels = blankImage()
  const center = (SPINNER_SIZE - 1) / 2
  const radius = 7
  const headAngle = normalizedFrame(frame) * Math.PI / 4 - Math.PI / 2

  for (let y = 0; y < SPINNER_SIZE; y += 1) {
    for (let x = 0; x < SPINNER_SIZE; x += 1) {
      const distance = Math.hypot(x - center, y - center)
      const pixelAngle = Math.atan2(y - center, x - center)
      const angleDelta = Math.atan2(
        Math.sin(pixelAngle - headAngle),
        Math.cos(pixelAngle - headAngle),
      )
      if (Math.abs(distance - radius) <= 1 && Math.abs(angleDelta) <= Math.PI * 0.38) {
        pixels[y * SPINNER_SIZE + x] = 255
      }
    }
  }
  return pixels
}

export class GlassesDisplay {
  private frame: GlassesFrame = { header: '', body: '' }
  private renderedActivityKey = ''
  private currentActivityLayout = activityLayout({ kind: 'thinking', frame: 0, lineIndex: 0 })
  private pendingRender: PendingRender | null = null
  private rendering = false
  private diagnostic: {
    run: (render: (frame: GlassesFrame) => Promise<void>, current: GlassesFrame) => Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
    report?: (line: string) => void
  } | null = null
  private diagnosticActive = false
  private needsRebuild = false
  private motionInterrupted = false
  private dashboardTiles: number[][] = []
  private renderedClockKey = ''
  private diagnosticStep: ((line: string) => void) | undefined

  constructor(private readonly bridge: EvenAppBridge) {}

  async create(): Promise<void> {
    const initialFrame = { header: 'T3 CODE', body: 'Connecting...' }
    // Keep the native startup payload deliberately small. Activity spinners and
    // dictation-card image layers are introduced by a rebuild only when needed;
    // pre-allocating hidden image containers here is rejected by some Even Hub
    // host versions before the bridge connection is attempted.
    const textObject = [
      textContainer(HEADER_ID, 'header', 0, 0, 576, 28, initialFrame.header, 0),
      textContainer(
        BODY_ID,
        'body',
        0,
        BODY_Y,
        576,
        258,
        initialFrame.body,
        1,
        undefined,
        BODY_PADDING,
      ),
    ]
    const result = await this.bridge.createStartUpPageContainer(
      new CreateStartUpPageContainer({
        containerTotalNum: textObject.length,
        textObject,
      }),
    )
    if (result !== StartUpPageCreateResult.success) {
      const reason = StartUpPageCreateResult[result] ?? 'unknown'
      throw new Error(`createStartUpPageContainer failed: ${reason} (code ${result})`)
    }
    this.frame = initialFrame
  }

  render(next: GlassesFrame): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.pendingRender) {
        this.pendingRender.frame = next
        this.pendingRender.waiters.push({ resolve, reject })
      } else {
        this.pendingRender = { frame: next, waiters: [{ resolve, reject }] }
      }
      if (!this.rendering) void this.drainRenders()
    })
  }

  /** A new gesture skips the remaining animation samples after the active call. */
  prioritizeInput(): void {
    if (this.rendering && !this.diagnosticActive) this.motionInterrupted = true
  }

  // Run diagnostics on the same native writer as production. Incoming session
  // renders remain coalesced until the test and restoration have completed.
  runDiagnostic(run: (render: (frame: GlassesFrame) => Promise<void>, current: GlassesFrame) => Promise<void>, report?: (line: string) => void): Promise<void> {
    if (this.diagnostic || this.diagnosticActive) return Promise.reject(new Error('Display test already running'))
    return new Promise((resolve, reject) => {
      this.diagnostic = { run, resolve, reject, report }
      if (!this.rendering) void this.drainRenders()
    })
  }

  private async drainRenders(): Promise<void> {
    this.rendering = true
    while (this.pendingRender || this.diagnostic) {
      if (this.diagnostic) {
        const job = this.diagnostic
        this.diagnostic = null
        this.diagnosticActive = true
        this.diagnosticStep = job.report
        const saved = this.frame
        try {
          try {
            await job.run(frame => this.renderNow(frame), saved)
          } finally {
            // Raw layout probes and failed image uploads can leave native
            // state different from our cached frame. Always rebuild it.
            this.needsRebuild = true
            await this.renderNow(saved)
          }
          job.resolve()
        } catch (error) {
          job.reject(error)
        } finally {
          this.diagnosticActive = false
          this.diagnosticStep = undefined
        }
        continue
      }
      const pending = this.pendingRender
      if (!pending) continue
      this.pendingRender = null
      try {
        await this.renderNow(pending.frame)
        for (const waiter of pending.waiters) waiter.resolve()
      } catch (error) {
        for (const waiter of pending.waiters) waiter.reject(error)
      }
    }
    this.rendering = false
  }

  private async renderNow(next: GlassesFrame): Promise<void> {
    this.motionInterrupted = false
    if (next.dashboardSurface && next.motion && next.motion.id !== this.frame.motion?.id && !this.diagnosticActive) {
      // Restore native motion on the fast text/border path. Never create image
      // placeholders in a sample. Slow acknowledgements or new input skip the
      // remaining samples instead of building a stale animation queue.
      const started = performance.now()
      for (let index = 1; index < 12; index++) {
        const progress = Math.max(index / 12, (performance.now() - started) / OS_MOTION_DURATION_MS)
        if (progress >= 1 || this.motionInterrupted || this.pendingRender) break
        const rect = interpolateRect(next.motion.from, next.motion.to, 1 - Math.pow(1 - progress, 3))
        this.needsRebuild = true
        if (!await this.bridge.rebuildPageContainer(transitionPage(next, this.frame, next.motion, rect))) {
          throw new Error('OS transition update failed')
        }
        const remaining = started + OS_MOTION_DURATION_MS * index / 11 - performance.now()
        if (remaining > 0 && !this.motionInterrupted && !this.pendingRender) await new Promise(resolve => setTimeout(resolve, remaining))
      }
    }
    if (!next.dashboardSurface && next.card?.presentation === 'plan' && next.card.entrance
      && next.card.transition !== this.frame.card?.transition) {
      // The SDK has no transform animation. Use one clipped native entrance
      // frame followed by the full card, serialized with the image transfers.
      await this.renderFrame({ ...next, card: { ...next.card, entering: true, body: ' ' } })
    }
    await this.renderFrame(next)
  }

  private async renderFrame(next: GlassesFrame): Promise<void> {
    if (next.dashboardSurface) {
      await this.renderDashboardSurface(next)
      return
    }
    const nextKey = activityKey(next.activity)
    const nextLayout = next.activity ? activityLayout(next.activity) : this.currentActivityLayout
    const activityToggled = Boolean(next.activity) !== Boolean(this.frame.activity)
    const cardToggled = next.card?.presentation !== this.frame.card?.presentation
      || Boolean(next.card) !== Boolean(this.frame.card)
      || JSON.stringify(next.card && cardBounds(next.card)) !== JSON.stringify(this.frame.card && cardBounds(this.frame.card))
    const dashboardToggled = Boolean(next.dashboard) !== Boolean(this.frame.dashboard)
      || next.dashboard?.actions?.length !== this.frame.dashboard?.actions?.length
      || pinnedNotifications(next) !== pinnedNotifications(this.frame)
      || (Boolean(next.dashboard?.actions) && Boolean(next.body) !== Boolean(this.frame.body))
    const menuToggled = JSON.stringify(contextualMenu(next)) !== JSON.stringify(contextualMenu(this.frame))
    const activityMoved = next.activity && !sameLayout(nextLayout, this.currentActivityLayout)
    if (this.frame.dashboardSurface || next.banner !== this.frame.banner || this.needsRebuild || cardToggled || dashboardToggled || menuToggled || (!next.card && (activityToggled || activityMoved))) {
      const clearAllImages = this.needsRebuild || this.frame.card !== undefined || Boolean(this.frame.dashboardSurface)
      this.needsRebuild = true
      // Layout rebuilds invalidate native image residency, even with identical
      // IDs. Only reuse pixels while the existing containers stay in place.
      this.dashboardTiles = []
      const page = pageContainers(next, nextLayout, next.activity ? nextLayout.label : ' ', Boolean(next.card))
      this.diagnosticStep?.(`Native rebuild: ${next.card ? 'card' : 'transcript'}, ${page.textObject.length} text + ${page.imageObject.length} images, sending...`)
      const rebuilt = await this.bridge.rebuildPageContainer(
        new RebuildPageContainer({
          containerTotalNum: page.textObject.length + page.imageObject.length,
          textObject: page.textObject,
          imageObject: page.imageObject,
          menuObject: contextualMenu(next),
        }),
      )
      this.diagnosticStep?.(`Native rebuild: ${rebuilt ? 'accepted' : 'rejected'}.`)
      if (!rebuilt) throw new Error(`rebuildPageContainer failed while ${next.card ? 'opening dictation card' : 'positioning live activity'}`)
      if (next.card) {
        if (next.card.placement === 'dashboard' && next.dashboard?.panel) await this.writeDashboard(next.dashboard.panel, Boolean(next.banner))
        if (!clippedDashboardCard(next)) {
          await this.writeCardBackdrop(next.card)
          // Text stays above the image layers until every tile is ready. Native
          // text updates preserve those images, unlike another layout rebuild.
          if (next.card.placement !== 'dashboard' && !await this.upgrade(CARD_VEIL_ID, 'card-veil', ' ')) {
            throw new Error('voice card reveal failed')
          }
        }
        if (!await this.upgrade(CARD_ID, 'voice-card', `${next.card.title}\n\n${next.card.body}`.slice(0, 1000))) {
          throw new Error('voice card text update failed')
        }
        this.diagnosticStep?.('Card reveal: required images finished; text visible.')
      } else if (next.dashboard?.panel) await this.writeDashboard(next.dashboard.panel, Boolean(next.banner))
      else if (page.imageObject.length) await this.writeSpinner(next.activity, clearAllImages)
      this.frame = next
      this.renderedActivityKey = nextKey
      this.currentActivityLayout = nextLayout
      this.needsRebuild = false
      return
    }

    if (!clippedDashboardCard(next) && !pinnedNotifications(next) && next.header !== this.frame.header) {
      await this.upgrade(HEADER_ID, 'header', next.header)
    }
    if (!clippedDashboardCard(next) && !pinnedNotifications(next) && next.body !== this.frame.body) {
      await this.upgrade(BODY_ID, 'body', next.body.slice(0, 2000))
    }
    if (!next.card && next.dashboard?.actions) {
      for (const [index, row] of next.dashboard.actions.entries()) {
        if (JSON.stringify(row) !== JSON.stringify(this.frame.dashboard?.actions?.[index])) {
          await this.bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: 5 + index,
            containerName: `action-${index}`, contentOffset: 0, contentLength: actionText(row).length,
            content: actionText(row), textColor: row.selected ? 4 : 2 }))
        }
      }
    }
    const previousLabel = this.frame.activity ? activityLabel(this.frame.activity) : ''
    const nextLabel = next.activity ? activityLabel(next.activity) : ''
    if (!next.card && nextLabel !== previousLabel) {
      await this.upgrade(ACTIVITY_LABEL_ID, 'activity-label', nextLabel || ' ')
    }
    if ((!next.card || next.card.placement === 'dashboard') && next.dashboard?.panel && JSON.stringify(next.dashboard.panel) !== JSON.stringify(this.frame.dashboard?.panel)) {
      await this.writeDashboard(next.dashboard.panel, Boolean(next.banner))
    } else if (!next.card && next.dashboard && !next.dashboard.panel && next.dashboard.left !== this.frame.dashboard?.left) {
      await this.upgrade(3, 'status', next.dashboard.left)
    }
    const previousCard = this.frame.card ? `${this.frame.card.title}\n\n${this.frame.card.body}` : ''
    const nextCard = next.card ? `${next.card.title}\n\n${next.card.body}` : ''
    if (next.card && nextCard !== previousCard) {
      await this.upgrade(CARD_ID, 'voice-card', nextCard.slice(0, 2000))
    }
    if (!next.card && nextKey !== this.renderedActivityKey) await this.writeSpinner(next.activity)
    this.frame = next
    this.renderedActivityKey = nextKey
    if (next.activity) this.currentActivityLayout = nextLayout
  }

  private async renderDashboardSurface(next: GlassesFrame): Promise<void> {
    const page = buildGlassesPage(next)
    const previous = this.frame.dashboardSurface ? buildGlassesPage(this.frame) : undefined
    // Compare native structure, separately from text/brightness. Selection and
    // count/weather updates keep their containers and leave the clock resident.
    const shape = (value: RebuildPageContainer) => JSON.stringify({ ...value,
      textObject: value.textObject?.map(({ content: _content, textColor: _color, ...layout }) => layout),
    })
    const rebuild = this.needsRebuild || !previous || shape(page) !== shape(previous)
    try {
      if (rebuild) {
        this.needsRebuild = true
        this.dashboardTiles = []
        this.renderedClockKey = ''
        if (!await this.bridge.rebuildPageContainer(page)) throw new Error('Dashboard layout update failed')
      } else {
        for (const item of page.textObject ?? []) {
          const old = previous?.textObject?.find(candidate => candidate.containerID === item.containerID)
          if ((item.content !== old?.content || item.textColor !== old?.textColor) && !await this.bridge.textContainerUpgrade(new TextContainerUpgrade({
            containerID: item.containerID, containerName: item.containerName, content: item.content || ' ', textColor: item.textColor,
          }))) throw new Error('Dashboard text update failed')
        }
      }
      if (page.imageObject?.length) {
        const clock = clockImageState(next.dashboardSurface!, next.banner)
        if (this.renderedClockKey !== clock.key) {
          const result = await this.bridge.updateImageRawData(new ImageRawDataUpdate({
            containerID: CLOCK_IMAGE.containerID, containerName: CLOCK_IMAGE.containerName,
            imageData: renderClockPixels(clock.hour, clock.minute, clock.hiddenRows),
          }))
          if (result !== ImageRawDataUpdateResult.success) throw new Error('Clock image update failed')
          this.renderedClockKey = clock.key
        }
      }
    } catch (error) {
      this.needsRebuild = true
      throw error
    }
    this.frame = next
    this.renderedActivityKey = ''
    this.needsRebuild = false
  }

  private async writeCardBackdrop(card: GlassesCard): Promise<void> {
    const { width, height } = cardBounds(card)
    const slots = card.placement === 'dashboard' ? DISPLAY_IMAGE_SLOTS.slice(2) : DISPLAY_IMAGE_SLOTS
    this.diagnosticStep?.(`Backdrop: uploading ${slots.length} tiles...`)
    const imageData = new Array<number>(width * height / slots.length).fill(0)
    const results = await this.settleImageUpdates(slots.map((slot) => () => (
      this.bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: slot.containerID,
        containerName: slot.containerName,
        imageData,
      }))
    )))
    this.diagnosticStep?.(`Backdrop image result codes: ${results.join(', ')}.`)
    if (results.some((result) => result !== ImageRawDataUpdateResult.success)) {
      throw new Error(`voice card background update failed: ${results.join(', ')}`)
    }
  }

  private async writeDashboard(panel: DashboardPanel, banner = false): Promise<void> {
    const tiles = panelTiles(await renderDashboardPanel(panel))
    if (banner) tiles[0]?.fill(0, 0, 220 * 56)
    await this.writeChangedTiles(tiles, this.dashboardTiles, DISPLAY_IMAGE_SLOTS.slice(0, 2), 'Dashboard image update failed')
  }

  private async writeChangedTiles(tiles: number[][], cache: number[][],
    slots: ReadonlyArray<{ containerID: number; containerName: string }>, errorMessage: string): Promise<void> {
    const changed = tiles.map((imageData, index) => ({ imageData, index })).filter(({ imageData, index }) => {
      const previous = cache[index]
      return !previous || previous.length !== imageData.length || imageData.some((pixel, offset) => pixel !== previous[offset])
    })
    for (const { imageData, index } of changed) {
      const result = await this.bridge.updateImageRawData(new ImageRawDataUpdate({ ...slots[index]!, imageData }))
        .catch(() => { throw new Error(errorMessage) })
      if (result !== ImageRawDataUpdateResult.success) throw new Error(errorMessage)
      cache[index] = imageData.slice()
    }
  }

  private async writeSpinner(
    activity?: GlassesActivityLine,
    clearCardBackdrop = false,
  ): Promise<void> {
    this.diagnosticStep?.(`Activity/cleanup: uploading ${clearCardBackdrop ? 4 : 2} images...`)
    const left = activity ? spinnerImage(activity.frame) : blankImage()
    const right = activity ? spinnerImage(activity.frame) : blankImage()
    const updates = [
      () => this.bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: ACTIVITY_LEFT_ID,
        containerName: 'tile-0',
        imageData: left,
      })),
      () => this.bridge.updateImageRawData(new ImageRawDataUpdate({
        containerID: ACTIVITY_RIGHT_ID,
        containerName: 'tile-1',
        imageData: right,
      })),
    ]
    if (clearCardBackdrop) {
      for (const slot of DISPLAY_IMAGE_SLOTS.slice(2)) {
        updates.push(() => this.bridge.updateImageRawData(new ImageRawDataUpdate({
          containerID: slot.containerID,
          containerName: slot.containerName,
          imageData: blankImage(),
        })))
      }
    }
    const results = await this.settleImageUpdates(updates)
    this.diagnosticStep?.(`Activity/cleanup image result codes: ${results.join(', ')}.`)
    if (results.some((result) => result !== ImageRawDataUpdateResult.success)) {
      throw new Error(`spinner image update failed: ${results.join(', ')}`)
    }
  }

  private upgrade(containerID: number, containerName: string, content: string): Promise<boolean> {
    return this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({ containerID, containerName, content }),
    )
  }

  private async settleImageUpdates(updates: Array<() => Promise<ImageRawDataUpdateResult>>): Promise<(ImageRawDataUpdateResult | 'threw')[]> {
    // The native image transport supports one upload at a time. Finish each
    // attempted upload before continuing or allowing diagnostic restoration.
    const results: (ImageRawDataUpdateResult | 'threw')[] = []
    for (const update of updates) {
      try {
        results.push(await update())
      } catch {
        results.push('threw')
      }
    }
    return results
  }
}
