import { waitForEvenAppBridge, TextContainerProperty, TextContainerUpgrade, OsEventTypeList } from '@evenrealities/even_hub_sdk'
import { getTextWidth } from '@evenrealities/pretext'

// Draft visual study. No bridge credentials, real T3 sessions, or deployment.
const bridge = await waitForEvenAppBridge()
const $ = (id: string) => document.getElementById(id) as HTMLInputElement
// Square corners and uninterrupted straight strokes.
const LARGE = [
  ['┌─┐', '│ │', '└─┘'], [' ┐ ', ' │ ', '<┴>'],
  ['<─┐', '┌─┘', '└─>'], ['<─┐', ' ─┤', '<─┘'],
  ['│ │', '└─┤', '  │'], ['┌─>', '└─┐', '<─┘'],
  ['┌─>', '├─┐', '└─┘'], ['<─┐', '  │', '  │'],
  ['┌─┐', '├─┤', '└─┘'], ['┌─┐', '└─┤', '<─┘'],
]
const padCells = (value: string) => value.replaceAll(' ', '    ').replaceAll('<', '─').replaceAll('>', '─')
let selected = 1
let previous: TextContainerProperty[] = []
let queue = Promise.resolve()
let nativeCalls = 0
const text = (id: number, name: string, x: number, y: number, width: number, height: number, content: string) =>
  new TextContainerProperty({ containerID: id, containerName: name, xPosition: x, yPosition: y, width, height,
    content, borderWidth: 0, paddingLength: 0, isEventCapture: 0, textColor: 4, zOrderIndex: id })
function page() {
  const hour = String(Math.max(1, Math.min(12, Number($('hour').value) || 12))).padStart(2, '0')
  const minute = String(Math.max(0, Math.min(59, Number($('minute').value) || 0))).padStart(2, '0')
  const spacing = Number($('spacing').value)
  const glyphs = (value: string, row: number) => [...value].map(d => padCells(LARGE[Number(d)]![row]!)).join(' ')
  const capture = text(8, 'input', 0, 0, 576, 288, ' ')
  capture.isEventCapture = 1
  const fields = [capture,
    text(1, 'status', 22, 12, 222, 270,
      ['─ 09/05 · SAT  50%', 'Connected', '', '', '', '',
        `${' '.repeat(31)}${$('period').value}`, '', '○ 72°F · Clear', 'Saved city'].join('\n')),
    ...[0, 1, 2].map(row => text(2 + row, `clock-row-${row}`, 50, 58 + row * spacing, 150, 108,
      `${glyphs(hour, row)}\n\n\n${glyphs(minute, row)}`)),
  ]
  const labels = ['Inbox (2)', 'Ask assistant', 'Sessions']
  labels.forEach((label, index) => {
    const item = text(5 + index, `action-${index}`, index === 0 ? 367 : 259, index === 0 ? 14 : 95 + (index - 1) * 54,
      index === 0 ? 180 : 288, index === 0 ? 40 : 44, `${selected === index ? '> ' : ''}${label}`)
    item.paddingLength = index === 0 ? 4 : 6
    item.borderWidth = 1; item.borderColor = 4; item.borderRadius = 6
    item.textColor = selected === index ? 4 : 2
    fields.push(item)
  })
  for (const item of fields) if (item.containerName?.startsWith('clock-')) {
    for (const line of item.content!.split('\n')) if (getTextWidth(line) > item.width!) throw new Error('Line art exceeds native width')
  }
  return fields
}
async function render(force = false) {
  const fields = page()
  if (force || !previous.length) {
    if (!await bridge.rebuildPageContainer({ containerTotalNum: fields.length, textObject: fields, imageObject: [] })) throw new Error('Native layout rejected')
    nativeCalls++
  } else {
    for (const item of fields) {
      const old = previous.find(candidate => candidate.containerID === item.containerID)
      if (item.content !== old?.content || item.textColor !== old?.textColor) {
        if (!await bridge.textContainerUpgrade(new TextContainerUpgrade({ containerID: item.containerID,
          containerName: item.containerName, content: item.content, textColor: item.textColor }))) throw new Error('Native text rejected')
        nativeCalls++
      }
    }
  }
  previous = fields
  $('status').textContent = `Native text/border calls: ${nativeCalls} · Image uploads: 0`
  console.info('clock-demo', JSON.stringify({ hour: $('hour').value, minute: $('minute').value,
    spacing: $('spacing').value, selected, nativeCalls, imageUploads: 0 }))
  ;(document.getElementById('preview') as HTMLImageElement).src = `http://127.0.0.1:9905/api/screenshot/glasses?t=${Date.now()}`
}
const request = (force = false) => { queue = queue.then(() => render(force)).catch(error => { $('status').textContent = String(error) }) }
const initial = text(8, 'input', 0, 0, 576, 288, ' '); initial.isEventCapture = 1
if (await bridge.createStartUpPageContainer({ containerTotalNum: 1, textObject: [initial] }) !== 0) throw new Error('Native startup rejected')
$('apply').onclick = () => request(true)
bridge.onEvenHubEvent(event => {
  const kind = event.textEvent?.eventType ?? event.sysEvent?.eventType
  if (kind === OsEventTypeList.SCROLL_TOP_EVENT || kind === OsEventTypeList.SCROLL_BOTTOM_EVENT) {
    selected = Math.max(0, Math.min(2, selected + (kind === OsEventTypeList.SCROLL_TOP_EVENT ? -1 : 1)))
    request()
  }
})
request(true)
