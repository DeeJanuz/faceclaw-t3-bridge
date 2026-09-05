import { describe, expect, it, vi } from 'vitest'
import { validateEvenHubPageContainer, ImageRawDataUpdateResult, StartUpPageCreateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk'
import { buildGlassesPage, GlassesDisplay } from './glasses-display'
import { displayCases, runDisplayCase, runIntegratedDisplayTests, type DisplayResult } from './display-diagnostics'

describe('on-device card diagnostics', () => {
  it('runs the layered card and close cleanup without another startup or microphone call', async () => {
    const bridge = {
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success),
      audioControl: vi.fn(),
    }
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    await display.render({ header: 'Private session title', body: 'Private transcript' })
    const controller = new AbortController()
    const report: string[] = []
    await runIntegratedDisplayTests(display, bridge, 'card', line => {
      report.push(line)
      if (line.includes('opaque card backdrop')) controller.abort()
    }, controller.signal)
    expect(bridge.updateImageRawData.mock.calls.slice(0, 4).every(([update]) => update.imageData.length === 29900)).toBe(true)
    expect(bridge.createStartUpPageContainer).toHaveBeenCalledOnce()
    expect(bridge.audioControl).not.toHaveBeenCalled()
    expect(report.join('\n')).toContain('Production close: transcript layout and image cleanup accepted')
    expect(report.join('\n')).toContain('Session display restored')
    expect(report.join('\n')).not.toContain('Private')
  })

  it('reports native card rejection and restores without waiting for user cancellation', async () => {
    const bridge = {
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValue(ImageRawDataUpdateResult.success),
    }
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const report: string[] = []
    await runIntegratedDisplayTests(display, bridge, 'card', line => report.push(line), new AbortController().signal)
    expect(report).toContain('Native rebuild: rejected.')
    expect(report.at(-1)).toContain('Some tests failed')
    expect(bridge.updateImageRawData.mock.calls.every(([update]) => update.imageData.length === 400)).toBe(true)
  })

  it('reports a backdrop failure and clears the image slots during restoration', async () => {
    const bridge = {
      createStartUpPageContainer: vi.fn().mockResolvedValue(StartUpPageCreateResult.success),
      rebuildPageContainer: vi.fn().mockResolvedValue(true),
      textContainerUpgrade: vi.fn().mockResolvedValue(true),
      updateImageRawData: vi.fn().mockResolvedValueOnce('failure').mockResolvedValue(ImageRawDataUpdateResult.success),
    }
    const display = new GlassesDisplay(bridge as unknown as EvenAppBridge)
    await display.create()
    const report: string[] = []
    const controller = new AbortController()
    await runIntegratedDisplayTests(display, bridge, 'card', line => {
      report.push(line)
      if (line.includes('opaque card backdrop')) controller.abort()
    }, controller.signal)
    expect(report.join(' ')).toContain('Production card/close: failed')
    expect(report.at(-1)).toContain('Session display restored')
    expect(bridge.updateImageRawData).toHaveBeenCalledTimes(8)
    expect(bridge.updateImageRawData.mock.calls.slice(4).map(([update]) => update.containerID)).toEqual([9, 10, 11, 12])
  })
  it('uses the production card builder and valid count, capture, and z-order rules', () => {
    const tests = displayCases()
    expect(tests).toHaveLength(14)
    expect(tests[5]!.pages[0]!.toJson()).toEqual(buildGlassesPage({
      header: 'DISPLAY TEST', body: 'Synthetic transcript behind card.',
      card: { title: 'DICTATION CARD TEST', body: 'No microphone or T3 connection is used.' },
    }).toJson())
    for (const test of tests) for (const page of test.pages) {
      expect(validateEvenHubPageContainer(page)).toEqual({ valid: true })
      expect(page.containerTotalNum).toBe((page.textObject?.length ?? 0) + (page.imageObject?.length ?? 0))
      expect(page.textObject!.filter(t => t.isEventCapture === 1)).toHaveLength(1)
      const ids = [...page.textObject!, ...(page.imageObject ?? [])].map(t => t.containerID)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
  it('isolates legacy image IDs from legacy names in the new hardware probes', () => {
    const cases = displayCases()
    const images = (index: number) => cases[index]!.pages[0]!.imageObject!
    expect(images(12).map(image => image.containerID)).toEqual(images(11).map(image => image.containerID))
    expect(images(12).map(image => image.containerName)).toEqual(images(5).map(image => image.containerName))
    expect(images(13).map(image => image.containerID)).toEqual(images(5).map(image => image.containerID))
    expect(images(13).map(image => image.containerName)).toEqual(images(11).map(image => image.containerName))
  })
  it('records the exact rejected step and sends no further transition after rejection', async () => {
    const bridge = { rebuildPageContainer: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) }
    const results: DisplayResult[] = []
    await runDisplayCase(bridge, displayCases()[10]!, result => results.push(result))
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(2)
    expect(results.map(r => r.status)).toEqual(['accepted', 'rejected'])
    expect(results[1]!.stage).toBe('layout 1')
  })
  it('stops if baseline reset fails and does not expose exception text in reports', async () => {
    const bridge = { rebuildPageContainer: vi.fn().mockRejectedValue(new Error('sensitive native exception')) }
    const results: DisplayResult[] = []
    await runDisplayCase(bridge, displayCases()[0]!, result => results.push(result))
    expect(bridge.rebuildPageContainer).toHaveBeenCalledTimes(1)
    expect(results[0]!.status).toBe('threw')
    expect(JSON.stringify(results)).not.toContain('sensitive')
  })
})
