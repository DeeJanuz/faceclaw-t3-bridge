import type { DeviceStatus, EvenAppBridge } from '@evenrealities/even_hub_sdk'

type DeviceBridge = Pick<EvenAppBridge, 'getDeviceInfo' | 'onDeviceStatusChanged'>

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function serial(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200 &&
    value.trim() === value && !/[\p{Cc}\p{Cf}]/u.test(value)
}

/** Device identity stays in memory and is never displayed, persisted, or logged. */
export class DeviceStatusController {
  private percent: number | null = null
  private glassesSerial: string | null = null
  private generation = 0
  private revision = 0
  private running = false
  private refreshing = false
  private refreshAgain = false
  private unsubscribe: (() => void) | null = null
  private onChange: (() => void) | null = null

  constructor(private readonly bridge: DeviceBridge) {}

  get batteryPercent(): number | null { return this.percent }

  start(onChange: () => void): void {
    this.stop()
    this.running = true
    this.onChange = onChange
    const generation = this.generation
    try {
      this.unsubscribe = this.bridge.onDeviceStatusChanged(status => {
        if (this.running && generation === this.generation) this.acceptEvent(status)
      })
    } catch {
      // Older hosts may lack events; the initial read can still supply charge.
    }
    void this.refresh()
  }

  stop(): void {
    this.generation += 1
    this.running = false
    this.onChange = null
    this.percent = null
    this.glassesSerial = null
    this.refreshing = false
    this.refreshAgain = false
    try { this.unsubscribe?.() } catch { /* Host shutdown can invalidate its subscription. */ }
    this.unsubscribe = null
  }

  private setBattery(value: number | null): void {
    if (this.percent === value) return
    this.percent = value
    this.onChange?.()
  }

  private applyStatus(value: unknown): void {
    const status = record(value)
    const battery = status?.batteryLevel
    this.setBattery(status?.sn === this.glassesSerial && status?.connectType === 'connected' &&
      typeof battery === 'number' && Number.isFinite(battery) && battery >= 0 && battery <= 100
      ? battery : null)
  }

  private acceptEvent(value: DeviceStatus): void {
    const status = record(value)
    this.revision += 1
    if (status === null || !serial(status.sn)) {
      this.setBattery(null)
      return
    }
    if (status.sn === this.glassesSerial) {
      this.applyStatus(status)
      return
    }
    // Events do not advertise a model. Resolve identity through getDeviceInfo
    // before accepting charge from any previously unseen device, including rings.
    void this.refresh()
  }

  private async refresh(): Promise<void> {
    if (!this.running) return
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = true
    const generation = this.generation
    const revision = this.revision
    try {
      const info = record(await this.bridge.getDeviceInfo())
      if (!this.running || generation !== this.generation || revision !== this.revision) return
      if (!info || (info.model !== 'g1' && info.model !== 'g2') || !serial(info.sn)) {
        this.glassesSerial = null
        this.setBattery(null)
        return
      }
      this.glassesSerial = info.sn
      this.applyStatus(info.status)
    } catch {
      if (this.running && generation === this.generation && revision === this.revision) {
        this.glassesSerial = null
        this.setBattery(null)
      }
    } finally {
      if (generation === this.generation) {
        this.refreshing = false
        if (this.refreshAgain) { this.refreshAgain = false; void this.refresh() }
      }
    }
  }
}
