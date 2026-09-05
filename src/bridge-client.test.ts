import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { T3BridgeClient } from './bridge-client'

class Socket extends EventTarget {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  binaryType = ''
  sent: unknown[] = []
  constructor(readonly url: string, readonly protocols: string[]) { super(); Socket.instances.push(this) }
  send(value: unknown) { this.sent.push(value) }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')) }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')) }
  message(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })) }
}
beforeEach(() => {
  vi.useFakeTimers()
  Socket.instances = []
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('window', { setTimeout, clearTimeout })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
async function connected() {
  const client = new T3BridgeClient('wss://bridge.example/v1/events', 'private-token')
  const connect = client.connect()
  Socket.instances[0]!.open()
  await connect
  return client
}
it('connection loss rejects outstanding sends, reconnects transport, and never replays', async () => {
  const client = await connected()
  const listener = vi.fn(); client.onEvent(listener)
  const pending = client.request('phone.notifications.reply', { text: 'Sensitive draft' })
  const rejected = expect(pending).rejects.toThrow('disconnected')
  Socket.instances[0]!.close()
  await rejected
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ event: 'connection.changed', payload: { connected: false } }))
  await vi.advanceTimersByTimeAsync(1000)
  expect(Socket.instances).toHaveLength(2)
  Socket.instances[1]!.open()
  await Promise.resolve()
  expect(client.connected).toBe(true)
  expect(Socket.instances[1]!.sent).toEqual([])
  expect(listener).toHaveBeenCalledWith(expect.objectContaining({ event: 'connection.changed', payload: { connected: true } }))
  client.close()
})
it('explicit close stops retries and a stalled connection times out', async () => {
  const client = await connected()
  Socket.instances[0]!.close()
  client.close()
  await vi.advanceTimersByTimeAsync(60_000)
  expect(Socket.instances).toHaveLength(1)
  const next = new T3BridgeClient('wss://bridge.example/v1/events', 'token')
  const rejected = expect(next.connect()).rejects.toThrow('Could not connect')
  await vi.advanceTimersByTimeAsync(10_000)
  await rejected
  next.close()
})
it('old socket messages and remote connection events cannot spoof transport status', async () => {
  const client = await connected()
  const listener = vi.fn(); client.onEvent(listener)
  Socket.instances[0]!.message({ v: 1, type: 'event', event: 'connection.changed', payload: { connected: false } })
  expect(listener).not.toHaveBeenCalled()
  Socket.instances[0]!.close()
  listener.mockClear()
  Socket.instances[0]!.message({ v: 1, type: 'event', event: 'phone.changed', payload: {} })
  expect(listener).not.toHaveBeenCalled()
  client.close()
})
