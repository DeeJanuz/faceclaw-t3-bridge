import {
  BRIDGE_PROTOCOL,
  BridgeRequestError,
  PROTOCOL_VERSION,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeMethodResult,
  type BridgeResponse,
} from './protocol'

const REQUEST_TIMEOUT_MS = 45_000
const TRANSCRIPTION_TIMEOUT_MS = 75_000

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timeout: number
}

export type BridgeEventListener = (event: BridgeEvent) => void

export class T3BridgeClient {
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private readonly eventListeners = new Set<BridgeEventListener>()
  private sequence = 0
  private stopped = false
  private reconnectTimer: number | null = null
  private reconnectAttempts = 0
  private connecting: Promise<void> | null = null

  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
  }

  async connect(): Promise<void> {
    this.stopped = false
    if (this.connected) return
    if (this.connecting) return this.connecting
    this.connecting = this.openSocket().finally(() => { this.connecting = null })
    return this.connecting
  }

  private async openSocket(): Promise<void> {
    if (!this.url.startsWith('ws://') && !this.url.startsWith('wss://')) {
      throw new Error('Bridge URL must start with ws:// or wss://')
    }
    if (!this.token.trim()) throw new Error('Bridge token is required')

    const socket = new WebSocket(this.url, [BRIDGE_PROTOCOL, `auth.${this.token}`])
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup()
        if (this.stopped || this.socket !== socket) { socket.close(); reject(new Error('Bridge connection closed')); return }
        this.bindSocket(socket)
        this.reconnectAttempts = 0
        this.emitConnection(true)
        resolve()
      }
      const onError = () => {
        cleanup()
        socket.close()
        if (this.socket === socket) this.socket = null
        reject(new Error('Could not connect to the T3 bridge'))
      }
      const onClose = () => {
        cleanup()
        if (this.socket === socket) this.socket = null
        reject(new Error('The T3 bridge closed the connection'))
      }
      const timeout = window.setTimeout(onError, 10_000)
      const cleanup = () => {
        window.clearTimeout(timeout)
        socket.removeEventListener('open', onOpen)
        socket.removeEventListener('error', onError)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('open', onOpen, { once: true })
      socket.addEventListener('error', onError, { once: true })
      socket.addEventListener('close', onClose, { once: true })
    })
  }

  close(): void {
    this.stopped = true
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close(1000, 'app closed')
    this.socket = null
    this.rejectPending(new Error('Bridge connection closed'))
  }

  onEvent(listener: BridgeEventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  request<M extends BridgeMethod>(
    method: M,
    params: Record<string, unknown> = {},
  ): Promise<BridgeMethodResult[M]> {
    if (!this.connected || !this.socket) {
      return Promise.reject(new Error('T3 bridge is not connected'))
    }

    const id = `${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    this.socket.send(JSON.stringify({ v: PROTOCOL_VERSION, type: 'request', id, method, params }))

    return new Promise<BridgeMethodResult[M]>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, method === 'voice.finish' ? TRANSCRIPTION_TIMEOUT_MS : REQUEST_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => resolve(value as BridgeMethodResult[M]),
        reject,
        timeout,
      })
    })
  }

  sendAudio(chunk: Uint8Array): void {
    if (!this.connected || !this.socket) throw new Error('T3 bridge is not connected')
    const bytes = chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
      ? chunk
      : chunk.slice()
    this.socket.send(bytes)
  }

  private bindSocket(socket: WebSocket): void {
    socket.addEventListener('message', (event) => {
      if (this.socket === socket) this.handleMessage(event)
    })
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return
      this.socket = null
      this.rejectPending(new Error('T3 bridge disconnected'))
      this.emitConnection(false)
      this.scheduleReconnect()
    })
  }

  private emitConnection(connected: boolean): void {
    for (const listener of this.eventListeners) listener({
      v: PROTOCOL_VERSION, type: 'event', event: 'connection.changed', payload: { connected },
    })
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempts++, 5))
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      // Retry transport only. Pending RPCs and audio are always discarded.
      void this.connect().catch(() => this.scheduleReconnect())
    }, delay)
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== 'string') return
    let message: BridgeResponse | BridgeEvent
    try {
      message = JSON.parse(event.data) as BridgeResponse | BridgeEvent
    } catch {
      return
    }
    if (!message || typeof message !== 'object' || message.v !== PROTOCOL_VERSION) return
    if (message.type === 'event' && message.event === 'connection.changed') return

    if (message.type === 'event') {
      for (const listener of this.eventListeners) listener(message)
      return
    }

    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    window.clearTimeout(pending.timeout)
    if (message.ok) {
      pending.resolve(message.result)
      return
    }
    pending.reject(new BridgeRequestError(message.error ?? {
      code: 'unknown_error',
      message: 'The bridge rejected the request',
    }))
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeout)
      pending.reject(error)
    }
    this.pending.clear()
  }
}
