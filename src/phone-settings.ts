import type { PhoneApp, PhoneSnapshot } from './phone-protocol'

/** Keep controls mounted while unrelated notification snapshots arrive. */
export function mountPhoneSettings(
  apps: HTMLElement,
  filter: HTMLInputElement,
  status: HTMLElement,
  setEnabled?: (packageName: string, enabled: boolean) => Promise<void>,
): (snapshot: PhoneSnapshot) => void {
  let connected = false
  const rows = new Map<string, { label: HTMLLabelElement; toggle: HTMLInputElement; text: Text; app: PhoneApp; pending: boolean }>()
  const applyFilter = () => {
    const query = filter.value.trim().toLocaleLowerCase()
    for (const row of rows.values()) row.label.hidden = !row.label.dataset.search?.includes(query)
  }
  filter.oninput = applyFilter
  return snapshot => {
    connected = snapshot.connected
    status.textContent = connected
      ? snapshot.permissionGranted ? 'Phone connected' : 'Phone connected. Enable notification access in Android settings.'
      : 'Phone disconnected. Saved apps and selections are shown. Open Even Phone Companion and check its connection and Tailscale to change selections.'
    const packages = new Set(snapshot.apps.map(app => app.packageName))
    for (const [name, row] of rows) {
      if (!packages.has(name)) { row.label.remove(); rows.delete(name) }
    }
    for (const [index, app] of snapshot.apps.entries()) {
      let row = rows.get(app.packageName)
      if (!row) {
        const label = document.createElement('label')
        label.className = 'checkbox-label'
        const toggle = document.createElement('input')
        toggle.type = 'checkbox'
        const text = document.createTextNode('')
        row = { label, toggle, text, app, pending: false }
        const current = row
        toggle.onchange = async () => {
          if (!connected || current.pending || !setEnabled || rows.get(app.packageName) !== current) {
            toggle.checked = current.app.enabled
            return
          }
          current.pending = true
          toggle.disabled = true
          try { await setEnabled(app.packageName, toggle.checked) }
          catch (error) { status.textContent = error instanceof Error ? error.message : String(error) }
          finally {
            current.pending = false
            toggle.checked = current.app.enabled
            toggle.disabled = !connected || !setEnabled
          }
        }
        label.append(toggle, text)
        rows.set(app.packageName, row)
      }
      row.app = app
      row.label.dataset.search = `${app.name} ${app.packageName}`.toLocaleLowerCase()
      const labelText = `${app.name}${app.replyObserved ? ' · Reply supported' : ''}`
      if (row.text.textContent !== labelText) row.text.textContent = labelText
      if (!row.pending) row.toggle.checked = app.enabled
      row.toggle.disabled = !connected || row.pending || !setEnabled
      // No detach/reinsert when the inventory order is unchanged: pointer and focus stay valid.
      if (apps.children[index] !== row.label) apps.insertBefore(row.label, apps.children[index] ?? null)
    }
    applyFilter()
  }
}
