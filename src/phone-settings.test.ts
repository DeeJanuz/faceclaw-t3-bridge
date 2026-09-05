import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountPhoneSettings } from './phone-settings'
import type { PhoneSnapshot } from './phone-protocol'

class Element {
  value = ''; textContent = ''; checked = false; disabled = false; hidden = false
  dataset: Record<string, string> = {}
  children: Element[] = []
  parent: Element | null = null
  oninput: (() => void) | null = null
  onchange: (() => Promise<void>) | null = null
  append(...children: Element[]) { for (const child of children) this.insertBefore(child, null) }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null }
  insertBefore(child: Element, before: Element | null) {
    child.remove()
    const index = before ? this.children.indexOf(before) : this.children.length
    this.children.splice(index, 0, child); child.parent = this
  }
}
const app = { packageName: 'org.example.chat', name: 'Chat', enabled: false, replyObserved: false }
const snapshot = (overrides: Partial<PhoneSnapshot> = {}): PhoneSnapshot => ({ connected: true, permissionGranted: true, apps: [app], notifications: [], ...overrides })
function setup(save: (name: string, enabled: boolean) => Promise<void> = async () => {}) {
  vi.stubGlobal('document', { createElement: () => new Element(), createTextNode: (text: string) => Object.assign(new Element(), { textContent: text }) })
  const apps = new Element(), filter = new Element(), status = new Element()
  const setEnabled = vi.fn(save)
  const update = mountPhoneSettings(apps as unknown as HTMLElement, filter as unknown as HTMLInputElement, status as unknown as HTMLElement, setEnabled)
  return { apps, filter, status, setEnabled, update, toggle: () => apps.children[0].children[0] }
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => vi.unstubAllGlobals())

describe('phone app selection', () => {
  it('keeps the touched checkbox mounted across notification and inventory metadata updates', async () => {
    const ui = setup()
    ui.update(snapshot())
    const label = ui.apps.children[0], toggle = ui.toggle()
    const insert = vi.spyOn(ui.apps, 'insertBefore')
    ui.update(snapshot({ apps: [{ ...app, replyObserved: true }] }))
    expect(ui.apps.children[0]).toBe(label)
    expect(ui.toggle()).toBe(toggle)
    expect(insert).not.toHaveBeenCalled()
    toggle.checked = true
    await toggle.onchange!()
    expect(ui.setEnabled).toHaveBeenCalledWith(app.packageName, true)
    expect(label.children[1].textContent).toBe('Chat · Reply supported')
  })
  it('retains saved selections offline and refuses even a manually dispatched change until reconnect', async () => {
    const ui = setup()
    ui.update(snapshot({ connected: false, apps: [{ ...app, enabled: true }] }))
    expect(ui.status.textContent).toContain('Saved apps and selections')
    expect(ui.toggle().disabled).toBe(true)
    ui.toggle().checked = false
    await ui.toggle().onchange!()
    expect(ui.setEnabled).not.toHaveBeenCalled()
    expect(ui.toggle().checked).toBe(true)
    ui.filter.value = 'org.example'
    ui.filter.oninput!()
    expect(ui.apps.children[0].hidden).toBe(false)
    ui.update(snapshot({ permissionGranted: false, apps: [{ ...app, enabled: true }] }))
    expect(ui.toggle().disabled).toBe(false)
    expect(ui.status.textContent).toContain('Enable notification access')
  })
  it('keeps a pending change disabled across snapshots and accepts the confirmed selection', async () => {
    const saved = deferred()
    const ui = setup(() => saved.promise)
    ui.update(snapshot())
    const toggle = ui.toggle()
    toggle.checked = true
    const pending = toggle.onchange!()
    ui.update(snapshot())
    expect(toggle.disabled).toBe(true)
    expect(toggle.checked).toBe(true)
    await toggle.onchange!()
    expect(ui.setEnabled).toHaveBeenCalledOnce()
    ui.update(snapshot({ apps: [{ ...app, enabled: true }] }))
    saved.resolve(); await pending
    expect(toggle.checked).toBe(true)
    expect(toggle.disabled).toBe(false)
  })
  it('does not reenable a control from an old connected snapshot after a failed save and disconnect', async () => {
    const saved = deferred()
    const ui = setup(() => saved.promise)
    ui.update(snapshot())
    const toggle = ui.toggle()
    toggle.checked = true
    const pending = toggle.onchange!()
    ui.update(snapshot({ connected: false }))
    saved.reject(new Error('Phone disconnected')); await pending
    expect(toggle.checked).toBe(false)
    expect(toggle.disabled).toBe(true)
    expect(ui.status.textContent).toBe('Phone disconnected')
  })
  it('restores the latest confirmed choice on failure and prevents removed controls from submitting', async () => {
    const saved = deferred()
    const ui = setup(() => saved.promise)
    ui.update(snapshot())
    const toggle = ui.toggle()
    toggle.checked = true
    const pending = toggle.onchange!()
    ui.update(snapshot({ apps: [{ ...app, enabled: true }] }))
    saved.reject(new Error('Request failed')); await pending
    expect(toggle.checked).toBe(true)
    ui.update(snapshot({ apps: [] }))
    toggle.checked = false
    await toggle.onchange!()
    expect(ui.setEnabled).toHaveBeenCalledOnce()
    expect(ui.apps.children).toHaveLength(0)
  })
})
