import { describe, expect, it } from 'vitest'
import { createHmac } from 'node:crypto'
import { sign } from '~/server/events/webhooks'

/**
 * Webhook signatures.
 *
 * A signature is only useful if a receiver can independently reproduce it, so
 * these check against Node's `crypto` rather than against our own output. A
 * self-consistent implementation that disagrees with every standard library
 * would pass a round-trip test and fail in the field.
 */

function nodeHmac(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

describe('sign', () => {
  it('matches HMAC-SHA256 as computed by Node', async () => {
    const secret = 'shhh'
    const body = JSON.stringify({ event: 'push', ref: 'refs/heads/main' })
    expect(await sign(secret, body)).toBe(nodeHmac(secret, body))
  })

  it('matches a known RFC-style vector', async () => {
    // Any receiver following the usual sha256=<hex> convention must agree.
    expect(await sign('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
  })

  it('produces lowercase hex of the full digest', async () => {
    const signature = await sign('secret', 'payload')
    expect(signature).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes when the body changes by one byte', async () => {
    const a = await sign('secret', '{"a":1}')
    const b = await sign('secret', '{"a":2}')
    expect(a).not.toBe(b)
  })

  it('changes when the secret changes', async () => {
    expect(await sign('one', 'body')).not.toBe(await sign('two', 'body'))
  })

  it('handles non-ASCII bodies the same way Node does', async () => {
    // UTF-8 encoding has to agree, or any payload with a name or emoji in it
    // would fail verification on the receiver.
    const body = JSON.stringify({ title: 'Fix ærror — 日本語 🎉' })
    expect(await sign('secret', body)).toBe(nodeHmac('secret', body))
  })

  it('handles an empty body', async () => {
    expect(await sign('secret', '')).toBe(nodeHmac('secret', ''))
  })

  it('handles a secret longer than the hash block size', async () => {
    // HMAC hashes an over-long key rather than using it directly; a hand-rolled
    // implementation commonly gets this wrong.
    const secret = 'x'.repeat(200)
    expect(await sign(secret, 'body')).toBe(nodeHmac(secret, 'body'))
  })
})
