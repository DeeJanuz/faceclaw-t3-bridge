import {
  RebuildPageContainer, TextContainerProperty, ImageContainerProperty,
  validateEvenHubPageContainer, type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import { buildGlassesPage, voiceOverlay, type GlassesDisplay, type GlassesFrame } from './glasses-display'

export type DisplayTestSelection = 'card' | 'all' | number

// Fixed diagnostic messages only. No transcript, connection profile, audio,
// or raw exception text is copied into the report.
export async function runIntegratedDisplayTests(
  display: GlassesDisplay,
  bridge: Pick<EvenAppBridge, 'rebuildPageContainer'>,
  selection: DisplayTestSelection,
  report: (line: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let testFailed = false
  await display.runDiagnostic(async (render, current) => {
    try {
      if (selection === 'card' || selection === 'all') {
        const background: GlassesFrame = { ...current, card: undefined }
        if (signal.aborted) return
        report('Production card: opening through the app renderer, preserving the background beneath the card...')
        try {
          await render(voiceOverlay(background, 'DICTATION DISPLAY TEST',
            'The screen stays visible around this raised card. Microphone is off.'))
          report('Production card: background and opaque card backdrop accepted.')
          // The single-card test stays visible for inspection until canceled.
          // The full suite advances automatically after a short inspection window.
          await waitForRestore(signal, selection === 'all' ? 1800 : undefined)
          await render(background)
          report('Production close: transcript layout and image cleanup accepted.')
        } catch {
          testFailed = true
          report('Production card/close: failed. Check the preceding native step results or run the layout probes.')
          if (selection === 'card') return
        }
      }
      if (signal.aborted) return
      if (selection === 'all' || typeof selection === 'number') {
        const cases = displayCases()
        const selected = typeof selection === 'number' ? [cases[selection]!] : cases
        for (const test of selected) {
          if (signal.aborted) break
          await runDisplayCase(bridge, test, result => {
            if (result.status !== 'accepted') testFailed = true
            report(`${result.test} | ${result.stage}: ${result.status} | ${result.textCount} text, ${result.imageCount} images [${result.imageSizes.join(', ')}]`)
          })
          await waitForRestore(signal, 600)
        }
      }
    } finally {
      report('Restoring session display...')
    }
  }, report)
  report(`Session display restored. ${signal.aborted ? 'Test stopped.' : testFailed ? 'Some tests failed.' : 'Tests completed.'}`)
}

function waitForRestore(signal: AbortSignal, milliseconds?: number): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = () => {
      if (timer !== undefined) clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
    if (milliseconds !== undefined) timer = setTimeout(finish, milliseconds)
  })
}

export interface DisplayCase {
  name: string
  pages: RebuildPageContainer[]
}

export function diagnosticBaseline(): RebuildPageContainer {
  return new RebuildPageContainer({ containerTotalNum: 2, textObject: [
    new TextContainerProperty({ containerID: 1, containerName: 'header', xPosition: 0, yPosition: 0, width: 576, height: 28, content: 'DISPLAY TEST', isEventCapture: 0 }),
    new TextContainerProperty({ containerID: 2, containerName: 'body', xPosition: 0, yPosition: 30, width: 576, height: 258, content: 'Synthetic display test.\nResults appear on your phone.', isEventCapture: 1 }),
  ] })
}

function fullCard(): RebuildPageContainer {
  return buildGlassesPage({ header: 'DISPLAY TEST', body: 'Synthetic transcript behind card.', card: { title: 'DICTATION CARD TEST', body: 'No microphone or T3 connection is used.' } })
}

function recount(page: RebuildPageContainer): RebuildPageContainer {
  page.containerTotalNum = (page.textObject?.length ?? 0) + (page.imageObject?.length ?? 0)
  return page
}

export function displayCases(): DisplayCase[] {
  const textZ = diagnosticBaseline()
  textZ.textObject!.forEach((t, i) => { t.zOrderIndex = i + 1 })
  const textCard = fullCard()
  textCard.imageObject = []
  const small = fullCard()
  small.imageObject = small.imageObject!.slice(0, 1)
  small.imageObject[0]!.width = 20
  small.imageObject[0]!.height = 20
  const oneLarge = fullCard()
  oneLarge.imageObject = oneLarge.imageObject!.slice(0, 1)
  const fourNoCard = fullCard()
  fourNoCard.textObject = fourNoCard.textObject!.slice(0, 2)
  fourNoCard.textObject[1]!.isEventCapture = 1
  const fourSmall = fullCard()
  fourSmall.imageObject!.forEach(i => { i.width = 20; i.height = 20 })
  const compactIds = fullCard()
  compactIds.textObject![2]!.containerID = 3
  compactIds.imageObject!.forEach((image, i) => { image.containerID = i + 4; image.containerName = `tile-${i}` })
  const noZ = fullCard()
  for (const item of [...noZ.textObject!, ...noZ.imageObject!]) delete item.zOrderIndex
  const freshIds = fullCard()
  freshIds.imageObject!.forEach((image, i) => { image.containerID = i + 9; image.containerName = `new-tile-${i}` })
  // Isolate the two variables changed together in the original passing probes.
  const legacySlots = [
    { containerID: 3, containerName: 'activity-left' },
    { containerID: 5, containerName: 'activity-right' },
    { containerID: 7, containerName: 'activity-spare-0' },
    { containerID: 8, containerName: 'activity-spare-1' },
  ]
  const legacy = fullCard()
  legacy.imageObject!.forEach((image, i) => Object.assign(image, legacySlots[i]))
  const legacyIds = fullCard()
  legacyIds.imageObject!.forEach((image, i) => { image.containerID = legacySlots[i]!.containerID })
  const legacyNames = fullCard()
  legacyNames.imageObject!.forEach((image, i) => { image.containerName = legacySlots[i]!.containerName })
  const spinner = buildGlassesPage({ header: 'DISPLAY TEST', body: 'Synthetic live activity.\n', activity: { kind: 'thinking', frame: 0, lineIndex: 1 } })
  return [
    { name: '01 Two text containers with z-order', pages: [textZ] },
    { name: '02 Text card, no images', pages: [recount(textCard)] },
    { name: '03 Card + one 20x20 image', pages: [recount(small)] },
    { name: '04 Card + one 260x115 image', pages: [recount(oneLarge)] },
    { name: '05 Four large images, no card text', pages: [recount(fourNoCard)] },
    { name: '06 Exact production card', pages: [fullCard()] },
    { name: '07 Full card with four small images', pages: [fourSmall] },
    { name: '08 Full card with compact IDs and short names', pages: [compactIds] },
    { name: '09 Full card without explicit z-order', pages: [noZ] },
    { name: '10 Full card with fresh image IDs', pages: [freshIds] },
    { name: '11 Spinner layout followed by production card', pages: [spinner, fullCard()] },
    { name: '12 Legacy image IDs and names', pages: [legacy] },
    { name: '13 Legacy image IDs with short names', pages: [legacyIds] },
    { name: '14 Fresh image IDs with legacy names', pages: [legacyNames] },
  ]
}

export interface DisplayResult {
  test: string
  stage: string
  status: 'accepted' | 'rejected' | 'sdk-invalid' | 'threw'
  textCount: number
  imageCount: number
  imageSizes: string[]
}

export async function runDisplayCase(
  bridge: Pick<EvenAppBridge, 'rebuildPageContainer'>,
  test: DisplayCase,
  report: (result: DisplayResult) => void,
): Promise<void> {
  const steps = [diagnosticBaseline(), ...test.pages]
  for (const [index, page] of steps.entries()) {
    let status: DisplayResult['status']
    const validation = validateEvenHubPageContainer(page)
    if (!validation.valid) status = 'sdk-invalid'
    else {
      try { status = await bridge.rebuildPageContainer(page) ? 'accepted' : 'rejected' }
      catch { status = 'threw' }
    }
    report({ test: test.name, stage: index === 0 ? 'reset' : `layout ${index}`, status,
      textCount: page.textObject?.length ?? 0, imageCount: page.imageObject?.length ?? 0,
      imageSizes: (page.imageObject ?? []).map((image: ImageContainerProperty) => `${image.width}x${image.height}`),
    })
    if (status !== 'accepted') return
  }
}
