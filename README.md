# Gitflare

A Gitea-style code forge built on Cloudflare primitives:
[Artifacts](https://blog.cloudflare.com/artifacts-git-for-agents-beta/) for git
storage, [CI Workflows](https://blog.cloudflare.com/ci-workflows/) for pipelines,
and [gRPC in Workers](https://blog.cloudflare.com/grpc-workers/) for the API and
git-over-SSH.

> **Status: deployed and verified.** <https://gitflare.astrid-906.workers.dev>
>
> Artifacts beta access landed, and the git layer now works end to end: `git
> clone` and `git push` against the deployed proxy with an unmodified client.
> See [Verified against the live service](#verified-against-the-live-service).
>
> All 12 API services and the web UI are implemented, with 232 tests passing.
> Two things are still not runnable here: **CI**, whose container image is
> amd64-only, and **git over SSH**, which needs inbound TCP plus Spectrum. File
> and blob *content* also needs an account-scoped `Artifacts:Read` token that
> only the dashboard can mint. See [Blockers](#blockers) and
> [What is and isn't built](#what-is-and-isnt-built).

## Architecture

One Vite build produces a main Worker plus two auxiliary Workers
(`auxiliaryWorkers` in `@cloudflare/vite-plugin`, requires Vite 7+).

```
main worker     TanStack Start SSR + Connect/gRPC API + git smart-HTTP proxy
  ├─ D1         users, orgs, teams, repos, issues, PRs, CI runs, webhooks
  ├─ Artifacts  git objects
  ├─ KV         Access JWKS cache
  ├─ R2         release assets
  └─ Queues     webhook delivery
       │
       ├── gitflare-ci   (aux)  CIWorkflow + Sandbox container
       └── gitflare-ssh  (aux)  connect(socket) → sshd container   [gated]
```

### Three storage surfaces, one client

No single Artifacts interface can answer everything the forge needs, so
`src/server/artifacts/client.ts` hides the split:

| Need | Surface | Why |
|---|---|---|
| Create/fork/import/delete, tokens | Workers binding | The only place these exist |
| Commits, trees | Workers binding | `log`/`readCommit`/`readTree` — **undeclared** in the shipped types; see `augment.d.ts` |
| File and blob content | REST API | The binding has no content read |
| **Branches and tags** | **git protocol** | Neither the binding nor REST can list refs |

That last row is the interesting one. Artifacts has no ref-listing API at all, so
`listRefs()` performs a real git `info/refs` handshake against the remote and
parses the pkt-line advertisement (`src/server/git/pktline.ts`,
`src/server/git/refs.ts`). It is the only way to populate a branch switcher.

### Repo naming

Artifacts repo names are flat within a namespace, so `owner/repo` is stored as
`owner--repo`. That encoding is only unambiguous because `assertLogin` rejects
consecutive hyphens — otherwise `a--b` + `c` and `a` + `b--c` would collide on
the same git storage. See `src/server/artifacts/names.ts`.

### Writing git objects

Artifacts is read-only at the object level: the binding creates whole repos, the
REST API reads, and neither can write a blob. Anything that creates a commit
therefore builds the objects and pushes them in a packfile.

That is possible in a Worker because `crypto.subtle` does SHA-1 and
`CompressionStream('deflate')` produces the zlib framing git expects. The proof
is that git accepts the result:

```
$ node build-pack.mjs > out.pack
$ git index-pack --stdin < out.pack
pack 405515fc7fac4a014a4291f07f96fd4cd8b2a73f
$ git cat-file -p 4f9eb3e3e91f095a703ecf3976d1d89629e005d8
tree b4ed918248039b78f24383523fa4e51f80994fac
author Test <t@example.com> 1700000000 +0000
```

The subtle part is tree sorting: git orders a directory as though its name ended
in `/`, so `lib/` sorts after `lib.txt`. Sorting lexicographically yields a tree
that hashes differently from git's for identical content, and every id
downstream diverges. See `src/server/git/objects.ts`.

### Git over HTTPS

`git clone https://gitflare.example.com/astrid/api.git` works with an unmodified
client. The proxy authenticates with Basic auth (username + personal access
token), applies the forge's own permissions, mints a one-hour repo-scoped
Artifacts token, and streams the protocol through. Bodies are streamed in both
directions — buffering a packfile would exhaust the isolate on exactly the repos
that matter most.

Without this, clients would need `http.extraHeader="Authorization: Bearer …"`,
which is what the raw Artifacts remote requires.

### CI pipelines in TypeScript

A repo describes its pipeline in `.gitflare/ci.ts`:

```ts
import { defineCI } from '@gitflare/ci-config'

export default defineCI(({ run, parallel, context }) => {
  const deps = run('install', 'bun install --frozen-lockfile', {
    cache: ['package.json', 'bun.lock'],
  })

  parallel(
    deps.run('lint', 'bun run lint'),
    deps.run('test', 'bun run test'),
    deps.run('typecheck', 'bun run typecheck'),
  )

  if (context.isDefaultBranch) {
    deps.run('deploy', 'bun wrangler deploy', { cloudflareCredentials: true })
  }
})
```

**That file is never imported by the Worker.** It is untrusted code from anyone
who can push, and importing it would be remote code execution against the
control plane, with the Artifacts binding and D1 in scope. Instead it runs
inside the same Sandbox container that runs the build, and all that comes back
is JSON — `calling run()` records a node in a graph, it does not spawn anything.

The Workflow then replays that plan through `@cloudflare/ci`'s `ci.runner()`, so
every command is still a durable, retried Workflow step with snapshot caching.
Independent steps are grouped into waves and awaited together.

The shim written into the sandbox is compiled from the same file users import
(via a `?raw` import), so the two cannot drift.

### Two CI execution paths

There are deliberately two ways to run a pipeline, because one of them works
today and the other does not:

| | `GitflareCI` (ci/index.ts) | `runPlanInSandbox` (ci/sandbox-runner.ts) |
|---|---|---|
| Built on | `@cloudflare/ci` + Workflows | `@cloudflare/sandbox` directly |
| Durability | Every step is a retried Workflow step, with snapshot caching | One container, no replay |
| Source | **Artifacts only** | Any git URL |
| Logs | Available once a step finishes | Streamed live via `execStream` |
| Available now | No — Artifacts is gated | **Yes — Sandboxes went GA in April 2026** |

`@cloudflare/ci` hard-codes Artifacts: its `exports` map hides
`SourceControlProvider`, so there is no way to give it another backend. The
Sandbox SDK has no such coupling, so the direct runner is the one that can
actually be exercised, and it is what makes live logs possible — `execStream`
yields stdout and stderr as they are produced, which the Workflow path cannot do.

Both run the *same* plan produced by `@gitflare/ci-config`, so a repo's
`.gitflare/ci.ts` does not change between them.

The sandbox path is wired end to end in `ci/pipeline.ts`: clone → evaluate the
repo's config *inside the container it just cloned into* → run the plan →
stream output to the log Durable Object → record steps in D1. `POST /run` on the
CI Worker starts it, and the main Worker reaches that over a service binding.

**Verifying the sandbox runner locally.** Two environmental limits get in the
way, both found by trying:

- `@cloudflare/vitest-pool-workers` does not plumb the `containers` array
  through to workerd, so a Sandbox-backed Durable Object in the integration
  suite fails with *"Containers have not been enabled for this Durable Object
  class"* regardless of the wrangler config.
- `cloudflare/sandbox` publishes a **single-platform amd64 image** — no arm64
  variant exists in any version, including 0.13.x. On Apple Silicon it runs
  under QEMU and never passes the SDK's own startup probe, which gives up after
  8 attempts over ~141s.

`ci/dev-harness.ts` + `wrangler.sandbox.jsonc` exist for this: on an amd64 host,
`wrangler dev --config wrangler.sandbox.jsonc` runs the real container and
`POST /` with `{"demo":true}` executes a pipeline through it. The container image
builds and starts correctly here; only execution is blocked by emulation.

**Untrusted code.** A pipeline is written by anyone who can push, so every
command is hostile input. The container is the security boundary — process,
filesystem, and network isolation with CPU and memory bounds — and nothing from
the runner executes in the Worker isolate that holds D1 and the Artifacts
binding. Interpolated values (repo URL, branch, commit) are shell-quoted, and
the checkout token is passed via `http.extraHeader` rather than in the URL, so it
stays out of `ps`, `.git/config`, and git's error output.

## Verified against the live service

With beta access, the parts that were previously untestable were exercised
against real Artifacts. Four assumptions turned out to be wrong; each is
recorded where it was made.

**Works as designed**

- `git clone` / `git push` through the deployed smart-HTTP proxy, unmodified
  client, PAT as the password.
- The `owner--repo` encoding — `CreateRepo` produced Artifacts repo
  `astrid--hello`.
- Ref listing via the git protocol. The pkt-line parser handled a real empty-repo
  advertisement, including dropping the zero-SHA capability carrier and reading
  `symref=HEAD` — exactly what its unit tests predicted.
- `readCommit` and `readTree` — the **undeclared** binding methods do exist at
  runtime, as inferred from `@cloudflare/ci`'s source.
- **The packfile writer.** A blob, tree, and commit built in Worker-compatible
  code were pushed with `receive-pack` and accepted (`unpack ok`,
  `ok refs/heads/main`), then cloned back with real git: matching commit hash,
  correct content, `git fsck` clean.

**Wrong assumptions, corrected**

| Assumption | Reality |
|---|---|
| Commit signatures carry a timestamp | They carry only `name` and `email`. The declared `time: string` produced Invalid Dates and a `RangeError: NaN cannot be converted to a BigInt` from inside protobuf serialization. Timestamps are now omitted rather than rendered as 1970. |
| `log()` returns `{ commits: [...] }` | Not that shape. Reading `.commits` off it yielded an empty history — a wrong shape reads as "no commits" rather than as an error. Both forms are handled and anything else throws. |
| A repo-scoped token can read the REST content API | It cannot (401). File and blob content needs an account-scoped `Artifacts:Read` token, which only the dashboard can mint. |
| SSR loaders can prefetch by calling our own API | A Worker fetching its own hostname is **not** re-dispatched to the Worker — it falls through to the static-asset layer and returns 404. This works in development, where Vite serves both halves in one process, which is what made it look finished. The loaders were removed; doing it properly needs an in-process transport with per-request context, which is noted in `src/lib/connect.ts`. |

Also useful: **Artifacts namespaces are created implicitly** by creating the
first repo in them — there is no `namespaces create` command.

## Blockers

Verified against this account on 2026-08-06.

| Blocker | Evidence | Effect |
|---|---|---|
| **Artifacts is closed beta** | `wrangler artifacts namespaces list` → `Access denied by feature gate [code: 10004]` | No git storage. Request access at [developers.cloudflare.com/artifacts](https://developers.cloudflare.com/artifacts/) |
| **`@cloudflare/ci` is Artifacts-only** | Its `exports` map omits `SourceControlProvider`, so no custom backend is possible | CI cannot run without Artifacts either |
| **Inbound TCP is private beta** | Needs sign-up *and* a Spectrum app on a zone you own | SSH is written but undeployable — see `ssh/README.md` |
| **Access can't protect `workers.dev`** | Access applications require a zone you own | Web auth needs a custom domain; `wrangler dev` falls back to local sessions |
| **Artifacts has no local simulation** | `vite dev` opens a remote proxy session for the binding and dies: `You do not have access to use Artifacts [code: 10015]` | `wrangler.dev.jsonc` omits the binding so local dev works at all |

That last row is worth spelling out. The Artifacts binding cannot be emulated by
miniflare, so the Vite plugin proxies it to the real service — which means an
account without beta access cannot even *start* a dev server with the binding
declared. `pnpm dev` therefore uses `wrangler.dev.jsonc`, which leaves it out;
`ArtifactsClient` treats a missing binding exactly like a gated account, so the
UI and everything that does not touch git works locally.

Two config shapes in the announcement posts are also out of date, per wrangler
4.119's own validator:

- `triggers.events[].target` → **`targets`** (a non-empty array)
- `instance_type: "standard"` → **`"standard-1"`**

`wrangler login` was refreshed to include `artifacts:write`. D1, R2, KV,
Containers, and Queues are all verified working.

## What is and isn't built

### Working and verified

- **D1 schema** — 40 tables across 4 migrations, applied to real D1. Includes
  contentless FTS5 indexes whose triggers were verified to stay consistent
  across insert, update, owner rename, and delete.
- **Protobuf API** — 12 services, `buf lint` clean, codegen verified.
- **Artifacts client** — all three surfaces, with the closed-beta gate turned
  into an actionable message instead of an opaque auth error.
- **pkt-line / ref parsing** — including annotated-tag peeling and empty repos.
- **RBAC** — permissions resolve as a maximum across grants, so a read-only team
  cannot demote an org owner.
- **Access JWT verification** — RS256 pinned, audience checked, JWKS cached in
  KV with refresh-on-unknown-kid so key rotation doesn't cause an hour of 401s.
- **Git smart-HTTP proxy** — streaming, with correct 401-vs-403-vs-404 behaviour.
- **CI plan machinery** — `defineCI`, topological sort, cycle detection, wave
  grouping, sandbox evaluation, and sentinel parsing.
- **CI Workflow** — `GitflareCI extends CIWorkflow`, driven by
  `cf.artifacts.repo.pushed`, with idempotent D1 run recording.
- **SSH stack** — Worker, DO, container, sshd config, and authorization scripts.
- **UI** — TanStack Start with SSR, gRPC-web over TanStack Query: repo list,
  owner page, create/import form, and a code browser with branch and tag
  switching, tree navigation, and a blob viewer.
- **All 12 Connect services** — User, Repo, Git, Issue, Pull, CI, Search, Org,
  Webhook, Notification, Release, Wiki. Verified live: every one answers with a
  real domain error (`unauthenticated`, `permission_denied`,
  `failed_precondition`) rather than `unimplemented`.
- **Webhooks** — queue-backed delivery with retry and a delivery log. Signatures
  are HMAC-SHA256 over the exact bytes sent, checked against Node's `crypto` and
  a known RFC vector, because a signature only helps if a receiver can
  independently reproduce it.
- **Notifications and activity** — the actor is never notified of their own
  action, and repeat events on a thread collapse onto one row instead of stacking.
- **Search** — FTS5 over repos, issues, and users. Tested that a private repo's
  issue *titles* do not leak: the row is never rendered, but it would otherwise
  come back in the response body.
- **Writing git objects** — Artifacts has no object-write API, so blobs, trees,
  and commits are constructed in the Worker: SHA-1 from WebCrypto, zlib from
  `CompressionStream`. **A generated packfile was fed to `git index-pack --stdin`,
  which validated it and read every object back correctly** — object ids match
  `git hash-object` exactly. This is what makes real merge commits and web wiki
  edits possible; the empty pack used for a fast-forward is byte-identical to
  `git pack-objects --stdout`.
- **Merging** — a clean branch fast-forwards (no new objects); a diverged branch
  gets a real two-parent merge commit, base first so `--first-parent` behaves.
- **Permission SQL** — 19 integration tests run the real migrations against real
  D1 in a workerd isolate and exercise the collaborator, team, and org joins.
  The unit tests cover which grant wins; these cover whether the grants are
  *found* at all — a distinction that hides real security bugs, since a resolver
  handed an empty list correctly answers "no access". They include cross-org
  team leakage and repo-scoping of collaborator rows.
- **Issue, pull request, and CI pages** — list, detail, comment, open/close,
  new-issue form, a diff viewer with per-file collapse and merge affordance, and
  a run list plus a live log tail that consumes the server-streaming RPC.
- **Search, inbox, settings, wiki, releases, and org pages** — full-text search;
  an inbox with unread filtering; token and SSH key management; a wiki with an
  editor that writes real commits; releases with assets; org members and teams.
- **SSH authorization endpoints** — the container's half of the contract.
  Authorization stays in the Worker, so a key gets exactly the access its owner
  has. An unset `INTERNAL_TOKEN` means *off*, never *unauthenticated*.

  Verified by decoding each page's **route match chain**, not by status code.
  TanStack Router nests `a/b.tsx` under `a.tsx`, and a parent without an
  `<Outlet/>` silently renders *itself* for every child route — a 200 with the
  wrong component. Every repo-scoped route therefore carries a trailing
  underscore (`$owner_.$repo_.issues_.$number.tsx`) to opt out of nesting.
- **Diff engine** — Myers O(ND), hunk grouping, unified-diff output. Verified
  **byte-for-byte against real `git diff --unified=3`** (`test/unit/diff-vs-git.test.ts`),
  which is the whole point of implementing Myers rather than a cheaper heuristic:
  the hunks a reviewer sees here match what they see locally.

**232 tests pass (146 unit + 86 integration). `pnpm typecheck` is clean, `pnpm build` emits both Workers.**

Verified against a running dev server:

```
GET  /                                       200, SSR'd HTML
POST /api/forge.v1.RepoService/ListRepos     public repo listed; private repo
                                             correctly hidden from anonymous
POST /api/forge.v1.UserService/GetCurrentUser  unauthenticated (not internal)
POST /api/forge.v1.GitService/ListRefs       failed_precondition + how to fix
GET  /astrid/gitflare.git/info/refs          401 + WWW-Authenticate: Basic
  (with a repo the caller can read)          503 + Artifacts gate explanation

# authenticated with a personal access token
POST /api/…/IssueService/CreateLabel         label created, "#d73a4a" → "d73a4a"
POST /api/…/IssueService/CreateIssue         issue created; empty title rejected
                                             as invalid_argument, anonymous as
                                             unauthenticated
POST /api/…/IssueService/UpdateIssue         labels and assignees applied
POST /api/…/IssueService/CreateComment       comment added, count incremented
POST /api/…/IssueService/ListIssues          labels, assignees, and counts joined
```

### Not built

Everything in the original plan is implemented. What remains is not code but
access: three of the Cloudflare features this is built on are in closed beta, so
nothing git-backed has run end to end. See [Blockers](#blockers).


## Local development

```sh
pnpm install
pnpm generate                      # buf → src/gen
pnpm exec wrangler d1 migrations apply gitflare --local
pnpm test                          # 208 tests (131 unit + 77 integration)
pnpm typecheck
```

`pnpm dev` serves the app at http://localhost:5173. Git-backed views show the
Artifacts gate; everything else works.

## Deploying

Not yet possible — Artifacts is gated. When access is granted:

1. **Create resources** and put the real IDs in `wrangler.jsonc`:
   ```sh
   wrangler d1 create gitflare
   wrangler kv namespace create CACHE
   wrangler r2 bucket create gitflare-assets
   wrangler r2 bucket create gitflare-ci-cache
   wrangler queues create gitflare-webhooks
   wrangler queues create gitflare-webhooks-dlq
   ```
2. **Secrets** for the main Worker: `CLOUDFLARE_ACCOUNT_ID`, `CF_API_TOKEN`
   (needs `Artifacts:Read`).
3. **Secrets** for the CI Worker: `CLOUDFLARE_ACCOUNT_ID`, `CF_TOKEN`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`.

   > The two R2 values are **S3 API tokens**, which `wrangler` cannot mint —
   > create them under R2 → Manage API tokens in the dashboard. `@cloudflare/ci`
   > needs them for snapshot caching.
4. **Cloudflare Access**: create an application on your own domain, set
   `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`, and add a **bypass** policy for
   `/api/*` and `/*.git/*` — git clients and CLIs cannot complete an interactive
   SSO redirect, so those paths authenticate with personal access tokens.
5. `pnpm build && wrangler deploy`

## Layout

```
proto/forge/v1/     12 service definitions
src/gen/            generated protobuf code (committed)
src/server/
  artifacts/        dual client, name encoding, type augmentation
  auth/             Access JWT, PATs, sessions, RBAC
  git/              pkt-line, refs, smart-HTTP proxy, content sniffing
  db/               D1 queries with the permission join
  connect/          Connect router + 12 service implementations
  events/           webhook dispatch, notification and activity writes
  diff/             Myers diff and hunk grouping
  ci/               live log Durable Object, Sandbox class
src/routes/         TanStack Start pages
ci/                 CI Worker: Workflow path, Sandbox runner, plan emitter
ssh/                gated SSH Worker + container
packages/ci-config/ @gitflare/ci-config — the defineCI API
migrations/         D1 schema
test/unit/          131 tests — parsers, diffing, CI plans, signatures
test/worker/        77 tests — real D1 in a workerd isolate, via the Connect wire
```
