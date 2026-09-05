import { describe, expect, it, vi } from 'vitest'
import {
  developmentBridgeUrlFromQuery,
  derivePairingUrl,
  exchangePairingPassphrase,
  selectConnectionProfile,
} from './connection-profile'

const SAVED_TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEF'
const DEV_TOKEN = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654'
const DEFAULT_URL = 'wss://mac.example.ts.net:8443/v1/events'

describe('connection profile selection', () => {
  it('starts with an empty URL when a production package has no saved profile', () => {
    expect(selectConnectionProfile(null, {}, '')).toEqual({ url: '', token: '' })
  })

  it('retains a valid saved profile when a production package has no baked URL', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({ url: DEFAULT_URL, token: SAVED_TOKEN }),
        {},
        '',
      ),
    ).toEqual({ url: DEFAULT_URL, token: SAVED_TOKEN })
  })

  it('does not reuse an invalid saved profile when a production package has no baked URL', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'wss://mac.example.ts.net:8443/v1/events?token=secret',
          token: SAVED_TOKEN,
        }),
        {},
        '',
      ),
    ).toEqual({ url: '', token: '' })
  })

  it('prefers a valid saved runtime profile over development variables', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'wss://saved.example.ts.net:8443/v1/events',
          token: SAVED_TOKEN,
        }),
        { url: 'ws://127.0.0.1:8787/v1/events', token: DEV_TOKEN },
        DEFAULT_URL,
      ),
    ).toEqual({
      url: 'wss://saved.example.ts.net:8443/v1/events',
      token: SAVED_TOKEN,
    })
  })

  it('uses development variables only when no valid saved token exists', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({ url: DEFAULT_URL, token: 'stale' }),
        { url: 'ws://127.0.0.1:8787/v1/events', token: DEV_TOKEN },
        DEFAULT_URL,
      ),
    ).toEqual({
      url: 'ws://127.0.0.1:8787/v1/events',
      token: DEV_TOKEN,
    })
  })

  it('migrates only a stale loopback URL to the exact packaged WSS URL and retains its token', () => {
    for (const staleUrl of [
      'ws://127.0.0.1:8787/v1/events',
      'ws://localhost:8787/v1/events',
      'wss://[::1]:8787/v1/events',
    ]) {
      expect(
        selectConnectionProfile(
          JSON.stringify({ url: staleUrl, token: SAVED_TOKEN }),
          {},
          DEFAULT_URL,
        ),
      ).toEqual({ url: DEFAULT_URL, token: SAVED_TOKEN })
    }
  })

  it('preserves a valid user-selected non-loopback WSS profile', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'wss://user-selected.example.ts.net:9443/v1/events',
          token: SAVED_TOKEN,
        }),
        {},
        DEFAULT_URL,
      ),
    ).toEqual({
      url: 'wss://user-selected.example.ts.net:9443/v1/events',
      token: SAVED_TOKEN,
    })
  })

  it('does not migrate a loopback profile to an unsafe or non-remote default', () => {
    const stored = JSON.stringify({
      url: 'ws://127.0.0.1:8787/v1/events',
      token: SAVED_TOKEN,
    })
    for (const unsafeDefault of [
      'ws://127.0.0.1:8787/v1/events',
      'wss://user:secret@mac.example.ts.net:8443/v1/events',
      'wss://mac.example.ts.net:8443/v1/events?token=secret',
      'wss://mac.example.ts.net:8443/not-events',
    ]) {
      expect(selectConnectionProfile(stored, {}, unsafeDefault)).toEqual({
        url: 'ws://127.0.0.1:8787/v1/events',
        token: SAVED_TOKEN,
      })
    }
  })

  it('never accepts a stored URL containing query-string credentials', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'wss://saved.example.ts.net:8443/v1/events?token=secret',
          token: SAVED_TOKEN,
        }),
        {},
        DEFAULT_URL,
      ),
    ).toEqual({ url: DEFAULT_URL, token: '' })
  })

  it('uses the explicit baked dev URL with a valid stored loopback token', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'ws://127.0.0.1:8787/v1/events',
          token: SAVED_TOKEN,
        }),
        {},
        DEFAULT_URL,
        DEFAULT_URL,
      ),
    ).toEqual({ url: DEFAULT_URL, token: SAVED_TOKEN })
  })

  it('prefills the explicit baked dev URL without inventing a token', () => {
    expect(selectConnectionProfile(null, {}, DEFAULT_URL, DEFAULT_URL)).toEqual({
      url: DEFAULT_URL,
      token: '',
    })
  })

  it('does not redirect a valid remote profile token to another host', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({
          url: 'wss://user-selected.example.ts.net:9443/v1/events',
          token: SAVED_TOKEN,
        }),
        {},
        DEFAULT_URL,
        DEFAULT_URL,
      ),
    ).toEqual({
      url: 'wss://user-selected.example.ts.net:9443/v1/events',
      token: SAVED_TOKEN,
    })
  })

  it('ignores an explicit URL that does not exactly match the baked default', () => {
    expect(
      selectConnectionProfile(
        JSON.stringify({ url: DEFAULT_URL, token: SAVED_TOKEN }),
        {},
        DEFAULT_URL,
        'wss://attacker.example/v1/events',
      ),
    ).toEqual({ url: DEFAULT_URL, token: SAVED_TOKEN })
  })
})

describe('development QR bridge URL', () => {
  it('accepts one encoded URL only in development when it exactly matches the baked WSS URL', () => {
    const query = `?t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}&v=cache-bust`
    expect(developmentBridgeUrlFromQuery(query, true, DEFAULT_URL)).toBe(DEFAULT_URL)
    expect(developmentBridgeUrlFromQuery(query, false, DEFAULT_URL)).toBeNull()
  })

  it('rejects duplicates, arbitrary hosts, credentials, query strings, wrong paths, and plaintext', () => {
    const candidates = [
      'wss://attacker.example/v1/events',
      'wss://user:secret@mac.example.ts.net:8443/v1/events',
      'wss://mac.example.ts.net:8443/v1/events?token=secret',
      'wss://mac.example.ts.net:8443/not-events',
      'ws://mac.example.ts.net:8443/v1/events',
    ]
    for (const candidate of candidates) {
      expect(
        developmentBridgeUrlFromQuery(
          `?t3BridgeUrl=${encodeURIComponent(candidate)}`,
          true,
          DEFAULT_URL,
        ),
      ).toBeNull()
    }
    expect(
      developmentBridgeUrlFromQuery(
        `?t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}&t3BridgeUrl=${encodeURIComponent(DEFAULT_URL)}`,
        true,
        DEFAULT_URL,
      ),
    ).toBeNull()
  })

  it('rejects a matching query value when the baked default itself is not remote WSS', () => {
    const loopback = 'ws://127.0.0.1:8787/v1/events'
    expect(
      developmentBridgeUrlFromQuery(
        `?t3BridgeUrl=${encodeURIComponent(loopback)}`,
        true,
        loopback,
      ),
    ).toBeNull()
  })
})

describe('pairing URL and exchange', () => {
  it('converts the exact WSS event URL to its HTTPS pairing endpoint', () => {
    expect(derivePairingUrl(DEFAULT_URL)).toBe('https://mac.example.ts.net:8443/v1/pair')
    expect(derivePairingUrl('ws://127.0.0.1:8787/v1/events')).toBe(
      'http://127.0.0.1:8787/v1/pair',
    )
  })

  it('rejects unsafe protocols, remote plaintext, credentials, and unexpected paths', () => {
    expect(() => derivePairingUrl('http://mac.example/v1/events')).toThrow()
    expect(() => derivePairingUrl('ws://mac.example/v1/events')).toThrow()
    expect(() => derivePairingUrl('wss://user:secret@mac.example/v1/events')).toThrow()
    expect(() => derivePairingUrl('wss://mac.example/not-events')).toThrow()
    expect(() => derivePairingUrl('wss://mac.example/v1/events?token=secret')).toThrow()
  })

  it('posts the passphrase in JSON and returns only a valid bearer token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: SAVED_TOKEN }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(exchangePairingPassphrase(DEFAULT_URL, 'passphrase', fetcher)).resolves.toBe(
      SAVED_TOKEN,
    )
    expect(fetcher).toHaveBeenCalledWith(
      'https://mac.example.ts.net:8443/v1/pair',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ passphrase: 'passphrase' }),
        credentials: 'omit',
        redirect: 'error',
      }),
    )
  })

  it('returns a generic error without exposing server or passphrase details', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: 'passphrase was passphrase' }), { status: 401 }),
    )
    await expect(exchangePairingPassphrase(DEFAULT_URL, 'passphrase', fetcher)).rejects.toThrow(
      /^Pairing failed$/,
    )
  })

  it('rejects an oversized success response before accepting a token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ token: SAVED_TOKEN, padding: 'x'.repeat(4096) }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    await expect(exchangePairingPassphrase(DEFAULT_URL, 'passphrase', fetcher)).rejects.toThrow(
      /^Pairing failed$/,
    )
  })
})
