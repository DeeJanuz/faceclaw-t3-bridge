import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk'
import { GlassesDisplay } from './glasses-display'
import { displayCases, runDisplayCase, type DisplayResult } from './display-diagnostics'

const status = document.querySelector<HTMLParagraphElement>('#status')!
const results = document.querySelector<HTMLTextAreaElement>('#results')!
const all = document.querySelector<HTMLButtonElement>('#all')!
const list = document.querySelector<HTMLDivElement>('#tests')!
const cases = displayCases()
let busy = false
function report(result: DisplayResult) {
  console.info('display-layout-result', result)
  results.value += `${result.test} | ${result.stage}: ${result.status} | ${result.textCount} text, ${result.imageCount} images [${result.imageSizes.join(', ')}]\n`
  results.scrollTop = results.scrollHeight
}
try {
  const bridge = await waitForEvenAppBridge()
  await new GlassesDisplay(bridge).create()
  results.value = 'Display diagnostics 0.2.5\nStartup: accepted\n'
  async function run(indices: number[]) {
    if (busy) return
    busy = true
    document.querySelectorAll('button').forEach(button => { button.disabled = true })
    try {
      for (const index of indices) {
        status.textContent = cases[index]!.name
        await runDisplayCase(bridge, cases[index]!, report)
        await new Promise(resolve => window.setTimeout(resolve, 500))
      }
      status.textContent = 'Finished. Copy the results below.'
    } finally {
      busy = false
      document.querySelectorAll('button').forEach(button => { button.disabled = false })
    }
  }
  cases.forEach((test, index) => {
    const button = document.createElement('button')
    button.textContent = test.name
    button.onclick = () => { void run([index]) }
    list.append(button)
  })
  all.disabled = false
  all.onclick = () => { void run(cases.map((_, index) => index)) }
  status.textContent = 'Ready. Run test 06 first, then all tests.'
  if (import.meta.env.DEV && location.hash === '#auto') void run(cases.map((_, index) => index))
} catch {
  status.textContent = 'Startup failed. Close and reopen the Hub app, then retry.'
  results.value += 'Startup: failed\n'
}
