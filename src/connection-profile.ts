export interface StoredConnectionProfile {
  url: string
  token: string
}

const BRIDGE_TOKEN = /^[A-Za-z0-9_-]{32,256}$/
const MAX_PASSPHRASE_CHARS = 256
const MAX_PAIRING_RESPONSE_BYTES = 4096
const DEVELOPMENT_BRIDGE_QUERY_PARAMETER = 't3BridgeUrl'

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost'
}

export function normalizeBridgeWebSocketUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Bridge URL is invalid')
  }
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && isLoopback(url.hostname))) {
    throw new Error('Bridge URL must use WSS, except for loopback development')
  }
  if (
    url.pathname !== '/v1/events' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('Bridge URL must point exactly to /v1/events')
  }
  return url.toString()
}

export function derivePairingUrl(bridgeWebSocketUrl: string): string {
  const url = new URL(normalizeBridgeWebSocketUrl(bridgeWebSocketUrl))
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/v1/pair'
  return url.toString()
}

function validProfile(value: unknown): StoredConnectionProfile | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate.url !== 'string' || typeof candidate.token !== 'string') return null
  if (!BRIDGE_TOKEN.test(candidate.token)) return null
  try {
    return { url: normalizeBridgeWebSocketUrl(candidate.url), token: candidate.token }
  } catch {
    return null
  }
}

function nonLoopbackWssDefault(raw: string): string | null {
  let normalized: string
  try {
    normalized = normalizeBridgeWebSocketUrl(raw)
  } catch {
    return null
  }
  const url = new URL(normalized)
  return url.protocol === 'wss:' && !isLoopback(url.hostname) ? normalized : null
}

export function developmentBridgeUrlFromQuery(
  search: string,
  developmentMode: boolean,
  defaultUrl: string,
): string | null {
  if (!developmentMode) return null
  const packagedUrl = nonLoopbackWssDefault(defaultUrl)
  if (packagedUrl === null) return null
  const values = new URLSearchParams(search).getAll(DEVELOPMENT_BRIDGE_QUERY_PARAMETER)
  if (values.length !== 1 || values[0] !== packagedUrl) return null
  try {
    return normalizeBridgeWebSocketUrl(values[0]) === packagedUrl ? packagedUrl : null
  } catch {
    return null
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_PAIRING_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw new Error('Pairing failed')
  }
  if (response.body === null) throw new Error('Pairing failed')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_PAIRING_RESPONSE_BYTES) {
      await reader.cancel()
      throw new Error('Pairing failed')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export function selectConnectionProfile(
  storedJson: string | null,
  development: { url?: string; token?: string },
  defaultUrl: string,
  explicitDevelopmentUrl: string | null = null,
): StoredConnectionProfile {
  let storedProfile: StoredConnectionProfile | null = null
  if (storedJson !== null) {
    try {
      storedProfile = validProfile(JSON.parse(storedJson))
    } catch {
      // Invalid local data falls through to a development seed or empty setup.
    }
  }
  const packagedUrl = nonLoopbackWssDefault(defaultUrl)
  const explicitUrl = explicitDevelopmentUrl === packagedUrl ? packagedUrl : null
  if (explicitUrl !== null) {
    if (storedProfile === null) return { url: explicitUrl, token: '' }
    const storedUrl = new URL(storedProfile.url)
    if (isLoopback(storedUrl.hostname) || storedProfile.url === explicitUrl) {
      return { url: explicitUrl, token: storedProfile.token }
    }
    return storedProfile
  }
  if (storedProfile !== null) {
    if (isLoopback(new URL(storedProfile.url).hostname) && packagedUrl !== null) {
      return { url: packagedUrl, token: storedProfile.token }
    }
    return storedProfile
  }
  const developmentProfile = validProfile({
    url: development.url,
    token: development.token,
  })
  if (developmentProfile !== null) return developmentProfile
  if (defaultUrl === '') return { url: '', token: '' }
  try {
    return { url: normalizeBridgeWebSocketUrl(defaultUrl), token: '' }
  } catch {
    // A malformed build-time seed must not become a connection target.
    return { url: '', token: '' }
  }
}

export async function exchangePairingPassphrase(
  bridgeWebSocketUrl: string,
  passphrase: string,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (
    passphrase.length === 0 ||
    passphrase.length > MAX_PASSPHRASE_CHARS ||
    /[\r\n\u0000]/.test(passphrase)
  ) {
    throw new Error('Pairing failed')
  }
  let response: Response
  try {
    response = await fetcher(derivePairingUrl(bridgeWebSocketUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passphrase }),
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    })
  } catch {
    throw new Error('Pairing failed')
  }
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel()
    throw new Error('Pairing failed')
  }
  const text = await readBoundedResponse(response)
  try {
    const value = JSON.parse(text) as unknown
    const token =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).token
        : undefined
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      typeof token !== 'string' ||
      !BRIDGE_TOKEN.test(token)
    ) {
      throw new Error()
    }
    return token
  } catch {
    throw new Error('Pairing failed')
  }
}
