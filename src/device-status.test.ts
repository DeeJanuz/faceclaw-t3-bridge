import { describe, expect, it, vi } from 'vitest'
import type { DeviceInfo, DeviceStatus } from '@evenrealities/even_hub_sdk'
import { DeviceStatusController } from './device-status'

const status = (batteryLevel: unknown = 72, sn = 'glasses-1', connectType = 'connected') =>
  ({ sn, connectType, batteryLevel }) as DeviceStatus
const info = (batteryLevel: unknown = 72, model = 'g2', sn = 'glasses-1') =>
  ({ model, sn, status: status(batteryLevel, sn) }) as DeviceInfo
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function setup() {
  let listener!: (value: DeviceStatus) => void
  const unsubscribe = vi.fn()
  const bridge = { getDeviceInfo: vi.fn<() => Promise<DeviceInfo | null>>().mockResolvedValue(info()),
    onDeviceStatusChanged: vi.fn((callback: (value: DeviceStatus) => void) => { listener = callback; return unsubscribe }) }
  const changed = vi.fn()
  const controller = new DeviceStatusController(bridge)
  return { controller, bridge, changed, unsubscribe, emit: (value: DeviceStatus) => listener(value) }
}

describe('glasses battery identity and lifecycle', () => {
  it('reads glasses charge, updates only on change, and accepts the zero and hundred endpoints', async () => {
    const { controller, changed, emit } = setup()
    expect(controller.batteryPercent).toBeNull()
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(72))
    expect(changed).toHaveBeenCalledTimes(1)
    emit(status(72))
    expect(changed).toHaveBeenCalledTimes(1)
    emit(status(0))
    expect(controller.batteryPercent).toBe(0)
    emit(status(100))
    expect(controller.batteryPercent).toBe(100)
    controller.stop()
  })
  it('never reports ring charge or charge with missing or mismatched device identity', async () => {
    for (const device of [info(99, 'ring1'), info(99, 'unknown'), info(99, 'g2', ''),
      { ...info(), status: status(99, 'ring-1') } as DeviceInfo, null]) {
      const { controller, bridge, changed } = setup()
      bridge.getDeviceInfo.mockResolvedValue(device)
      controller.start(changed)
      await Promise.resolve()
      expect(controller.batteryPercent).toBeNull()
      expect(changed).not.toHaveBeenCalled()
      controller.stop()
    }
  })
  it('uses authoritative glasses info when a ring event arrives', async () => {
    const { controller, changed, emit, bridge } = setup()
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(72))
    emit(status(99, 'ring-1'))
    await vi.waitFor(() => expect(bridge.getDeviceInfo).toHaveBeenCalledTimes(2))
    expect(controller.batteryPercent).toBe(72)
    expect(changed).toHaveBeenCalledTimes(1)
    controller.stop()
  })
  it('clears disconnected, absent, nonnumeric, nonfinite and out-of-range battery values', async () => {
    const { controller, changed, emit } = setup()
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(72))
    for (const battery of [-1, 101, NaN, Infinity, '72', null, undefined]) {
      emit(status(72))
      emit({ ...status(), batteryLevel: battery } as DeviceStatus)
      expect(controller.batteryPercent).toBeNull()
    }
    for (const connection of ['disconnected', 'connecting', 'none', 'connectionFailed']) {
      emit(status(72))
      emit(status(72, 'glasses-1', connection))
      expect(controller.batteryPercent).toBeNull()
    }
    emit(status(72))
    emit(null as unknown as DeviceStatus)
    expect(controller.batteryPercent).toBeNull()
    controller.stop()
  })
  it('resolves newly connected glasses through device info and clears a null refresh', async () => {
    const { controller, bridge, changed, emit } = setup()
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(72))
    bridge.getDeviceInfo.mockResolvedValue(info(35, 'g2', 'glasses-2'))
    emit(status(35, 'glasses-2'))
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(35))
    bridge.getDeviceInfo.mockResolvedValue(null)
    emit(status(99, 'ring-1'))
    await vi.waitFor(() => expect(controller.batteryPercent).toBeNull())
    controller.stop()
  })
  it('does not let an older device snapshot overwrite a newer disconnect event', async () => {
    const { controller, bridge, changed, emit } = setup()
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(72))
    const old = deferred<DeviceInfo | null>()
    bridge.getDeviceInfo.mockReturnValueOnce(old.promise)
    emit(status(99, 'ring-1'))
    emit(status(72, 'glasses-1', 'disconnected'))
    old.resolve(info(72))
    await Promise.resolve()
    expect(controller.batteryPercent).toBeNull()
    controller.stop()
  })
  it('coalesces unknown-device events and ignores callbacks or async results after stop', async () => {
    const { controller, bridge, changed, emit, unsubscribe } = setup()
    const old = deferred<DeviceInfo | null>()
    bridge.getDeviceInfo.mockReturnValueOnce(old.promise)
    controller.start(changed)
    emit(status(99, 'ring-1'))
    emit(status(99, 'ring-1'))
    expect(bridge.getDeviceInfo).toHaveBeenCalledTimes(1)
    controller.stop()
    old.resolve(info())
    emit(status())
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledOnce()
    expect(controller.batteryPercent).toBeNull()
    expect(changed).not.toHaveBeenCalled()
  })
  it('isolates restarted generations and fails safely when the SDK read rejects', async () => {
    const { controller, bridge, changed } = setup()
    const old = deferred<DeviceInfo | null>()
    bridge.getDeviceInfo.mockReturnValueOnce(old.promise)
    controller.start(changed)
    bridge.getDeviceInfo.mockResolvedValue(info(20))
    controller.start(changed)
    await vi.waitFor(() => expect(controller.batteryPercent).toBe(20))
    old.resolve(info(99))
    await Promise.resolve()
    expect(controller.batteryPercent).toBe(20)
    bridge.getDeviceInfo.mockRejectedValue(new Error('host unavailable'))
    controller.start(changed)
    await Promise.resolve()
    expect(controller.batteryPercent).toBeNull()
    controller.stop()
  })
})
