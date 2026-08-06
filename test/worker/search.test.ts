import { beforeEach, describe, expect, it } from 'vitest'
import { SELF } from 'cloudflare:test'
import {
  addCollaborator,
  createRepo,
  createUser,
  resetDatabase,
  testEnv,
} from './helpers'

/**
 * Search over the real FTS5 indexes, through the Connect wire.
 *
 * Two things are being checked. First, that the contentless-FTS join actually
 * works: those tables return NULL for every column, so a query that reads from
 * them instead of joining to the base table silently returns empty rows.
 *
 * Second — and more important — that search cannot become a side channel into
 * private repositories. A leak here is subtle: the row is never rendered, but
 * its title comes back in the response.
 */

beforeEach(async () => {
  await resetDatabase()
})

async function search(body: unknown): Promise<Record<string, never>> {
  const response = await SELF.fetch('https://gitflare.test/api/forge.v1.SearchService/Search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as Record<string, never>
}

async function addIssue(
  repoId: string,
  authorId: string,
  number: number,
  title: string,
  body = '',
): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO issues (id, repo_id, number, title, body, state, author_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?7)`,
  )
    .bind(`i${repoId}${number}`, repoId, number, title, body, authorId, Date.now())
    .run()
}

describe('repo search', () => {
  it('finds a public repo by name and description', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'gitflare', { visibility: 'public' })
    await testEnv.DB.prepare(`UPDATE repos SET description = ?2 WHERE id = ?1`)
      .bind(repo, 'A Gitea-like forge on Cloudflare')
      .run()

    const byName = await search({ query: 'gitflare' })
    expect((byName.repos as unknown as { name: string }[]).map((r) => r.name)).toContain('gitflare')

    // Proves the contentless-FTS rowid join reads real rows: a query that read
    // columns from the index itself would return nulls here.
    const byDescription = await search({ query: 'forge' })
    expect((byDescription.repos as unknown as { name: string }[])[0]?.name).toBe('gitflare')
  })

  it('does not return a private repo to anonymous callers', async () => {
    const owner = await createUser('astrid')
    await createRepo(owner, 'skunkworks', { visibility: 'private' })

    const body = await search({ query: 'skunkworks' })
    expect(body.repos ?? []).toHaveLength(0)
  })

  it('finds a repo by its owner login', async () => {
    // The login is denormalized into the index so "astrid" matches their repos.
    const owner = await createUser('astrid')
    await createRepo(owner, 'tools', { visibility: 'public' })

    const body = await search({ query: 'astrid' })
    expect((body.repos as unknown as { name: string }[]).map((r) => r.name)).toContain('tools')
  })

  it('keeps the index consistent after a rename', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'oldname', { visibility: 'public' })

    await testEnv.DB.prepare(`UPDATE repos SET name = 'newname', name_lower = 'newname' WHERE id = ?1`)
      .bind(repo)
      .run()

    expect((await search({ query: 'newname' })).repos ?? []).toHaveLength(1)
    // A stale index would still answer for the old name.
    expect((await search({ query: 'oldname' })).repos ?? []).toHaveLength(0)
  })

  it('drops a deleted repo from the index', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'temporary', { visibility: 'public' })
    await testEnv.DB.prepare(`DELETE FROM repos WHERE id = ?1`).bind(repo).run()

    expect((await search({ query: 'temporary' })).repos ?? []).toHaveLength(0)
  })

  it('does not fail on punctuation in the query', async () => {
    // FTS5 has its own syntax; an unescaped quote is a syntax error, which would
    // surface as a 500 on an ordinary search.
    const owner = await createUser('astrid')
    await createRepo(owner, 'tools', { visibility: 'public' })

    for (const query of ['"unbalanced', 'a OR b', 'NEAR(', 'x AND']) {
      const body = await search({ query })
      expect(body.code).toBeUndefined()
    }
  })
})

describe('issue search', () => {
  it('finds an issue by title, with porter stemming', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await addIssue(repo, owner, 1, 'Push fails over HTTPS', 'receive-pack returns 403 when pushing')

    // The index is built with the porter tokenizer, so "push" matches "pushing".
    const body = await search({ query: 'push', kind: 'SEARCH_KIND_ISSUES' })
    const issues = body.issues as unknown as { title: string }[]
    expect(issues).toHaveLength(1)
    expect(issues[0]!.title).toBe('Push fails over HTTPS')
  })

  it('does not leak issue titles from a private repo', async () => {
    // The subtle leak: the issue is never rendered, but its title comes back.
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'secret', { visibility: 'private' })
    await addIssue(repo, owner, 1, 'Confidential security hole')

    const body = await search({ query: 'confidential', kind: 'SEARCH_KIND_ISSUES' })
    expect(body.issues ?? []).toHaveLength(0)
  })

  it('reindexes an issue when its title changes', async () => {
    const owner = await createUser('astrid')
    const repo = await createRepo(owner, 'api', { visibility: 'public' })
    await addIssue(repo, owner, 1, 'Original title')

    await testEnv.DB.prepare(`UPDATE issues SET title = 'Rewritten heading' WHERE repo_id = ?1`)
      .bind(repo)
      .run()

    expect((await search({ query: 'rewritten', kind: 'SEARCH_KIND_ISSUES' })).issues ?? []).toHaveLength(1)
    expect((await search({ query: 'original', kind: 'SEARCH_KIND_ISSUES' })).issues ?? []).toHaveLength(0)
  })

  it('scopes to one repo when asked', async () => {
    const owner = await createUser('astrid')
    const a = await createRepo(owner, 'alpha', { visibility: 'public' })
    const b = await createRepo(owner, 'beta', { visibility: 'public' })
    await addIssue(a, owner, 1, 'shared keyword here')
    await addIssue(b, owner, 1, 'shared keyword there')

    const body = await search({
      query: 'shared',
      kind: 'SEARCH_KIND_ISSUES',
      owner: 'astrid',
      repo: 'alpha',
    })
    expect(body.issues ?? []).toHaveLength(1)
  })
})

describe('user search', () => {
  it('matches on a login prefix', async () => {
    await createUser('astrid')
    await createUser('alastair')

    const body = await search({ query: 'as', kind: 'SEARCH_KIND_USERS' })
    const logins = (body.users as unknown as { login: string }[]).map((u) => u.login)
    // Prefix, not substring: "as" should not pull in "alastair".
    expect(logins).toContain('astrid')
    expect(logins).not.toContain('alastair')
  })

  it('ignores LIKE wildcards in the query', async () => {
    // Without stripping, "%" would match every user.
    await createUser('astrid')
    const body = await search({ query: '%', kind: 'SEARCH_KIND_USERS' })
    expect(body.users ?? []).toHaveLength(0)
  })
})

describe('validation', () => {
  it('rejects an empty query', async () => {
    const body = await search({ query: '   ' })
    expect(body.code).toBe('invalid_argument')
  })

  it('requires a repo for code search', async () => {
    // Without an index, an unscoped code search would walk every tree.
    const body = await search({ query: 'needle', kind: 'SEARCH_KIND_CODE' })
    expect(body.code).toBe('invalid_argument')
  })
})
