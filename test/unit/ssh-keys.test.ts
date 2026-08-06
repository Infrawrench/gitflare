import { describe, expect, it } from 'vitest'
import { fingerprintSshKey, parseSshPublicKey } from '~/server/auth/ssh-keys'

// Real ed25519 public key generated with ssh-keygen, so the blob's embedded
// algorithm name and the fingerprint are genuine rather than hand-made.
const ED25519 =
  'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB2xBXvJ9GmvTMcYQZvVmL1RCnMkxBmXwUcTk6xLPFhZ astrid@example.com'

describe('parseSshPublicKey', () => {
  it('parses type, body, and comment', () => {
    const key = parseSshPublicKey(ED25519)
    expect(key.type).toBe('ssh-ed25519')
    expect(key.comment).toBe('astrid@example.com')
    expect(key.body.startsWith('AAAAC3NzaC1lZDI1NTE5')).toBe(true)
  })

  it('tolerates a missing comment and surrounding whitespace', () => {
    const [type, body] = ED25519.split(' ')
    expect(parseSshPublicKey(`  ${type} ${body}  `).comment).toBe('')
  })

  it('rejects a private key with advice to rotate it', () => {
    // Pasting the private half is a common slip, and a generic "malformed key"
    // would not prompt anyone to rotate what they just leaked.
    expect(() =>
      parseSshPublicKey('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----'),
    ).toThrow(/private key/i)
  })

  it('rejects a type the blob does not agree with', () => {
    // The algorithm is stated twice: once as the prefix, once inside the blob.
    // A mismatch means the key was edited or corrupted.
    const [, body] = ED25519.split(' ')
    expect(() => parseSshPublicKey(`ssh-rsa ${body}`)).toThrow(/does not match its declared type/)
  })

  it('rejects unsupported algorithms', () => {
    expect(() => parseSshPublicKey('ssh-dss AAAAB3NzaC1kc3M= old')).toThrow(/Unsupported key type/)
  })

  it('rejects non-base64 bodies', () => {
    expect(() => parseSshPublicKey('ssh-ed25519 !!!not-base64!!!')).toThrow(/valid base64/)
  })

  it('rejects an authorized_keys file with several keys', () => {
    expect(() => parseSshPublicKey(`${ED25519}\n${ED25519}`)).toThrow(/single public key/)
  })

  it('rejects empty input', () => {
    expect(() => parseSshPublicKey('   ')).toThrow(/empty/)
  })
})

describe('fingerprintSshKey', () => {
  it('produces an OpenSSH-format SHA256 fingerprint', async () => {
    const fingerprint = await fingerprintSshKey(parseSshPublicKey(ED25519))
    // Must match `ssh-keygen -lf` so users can compare by eye, and so it lines
    // up with what sshd passes to AuthorizedKeysCommand.
    expect(fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/)
    expect(fingerprint.endsWith('=')).toBe(false)
  })

  it('ignores the comment, which is not part of the key', async () => {
    const [type, body] = ED25519.split(' ')
    const withComment = await fingerprintSshKey(parseSshPublicKey(ED25519))
    const withoutComment = await fingerprintSshKey(parseSshPublicKey(`${type} ${body}`))
    expect(withComment).toBe(withoutComment)
  })
})
