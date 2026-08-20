import { describe, expect, it } from 'vitest'
import { ArtifactsClient } from '~/server/artifacts/client'

const ACCOUNT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

function client(accountId: string) {
  return new ArtifactsClient({
    ARTIFACTS_NAMESPACE: 'gitflare',
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CF_API_TOKEN: '',
  })
}

describe('remoteFor', () => {
  it('builds the Artifacts git remote', () => {
    expect(client(ACCOUNT).remoteFor('astrid--api')).toBe(
      `https://${ACCOUNT}.artifacts.cloudflare.net/git/gitflare/astrid--api.git`,
    )
  })

  it('throws when the account id is unusable', () => {
    // The fetching callers cannot proceed with a bad URL, so this must stay loud.
    expect(() => client('').remoteFor('astrid--api')).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
    expect(() => client('not-an-account').remoteFor('astrid--api')).toThrow(/CLOUDFLARE_ACCOUNT_ID/)
  })
})

describe('tryRemoteFor', () => {
  it('matches remoteFor when the account id is valid', () => {
    expect(client(ACCOUNT).tryRemoteFor('astrid--api')).toBe(client(ACCOUNT).remoteFor('astrid--api'))
  })

  it('degrades to "" instead of failing the RPC', () => {
    // GetRepo/CreateRepo return this only as a display field for admins; an
    // unset account id used to take the whole call down with an internal error.
    expect(client('').tryRemoteFor('astrid--api')).toBe('')
    expect(client('not-an-account').tryRemoteFor('astrid--api')).toBe('')
  })
})
