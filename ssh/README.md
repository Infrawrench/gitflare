# Git over SSH (gated)

This directory implements `git clone git@gitflare.example.com:astrid/api.git`
using the Workers inbound-TCP `connect()` handler from
[Cloudflare's gRPC/TCP announcement](https://blog.cloudflare.com/grpc-workers/).

**It is written but not deployed, and it cannot be tested on `workers.dev`.**

## Why it is gated

Two independent prerequisites, neither generally available:

| Requirement | Status | Consequence |
|---|---|---|
| Inbound TCP `connect()` handler | Private beta, sign-up required | The handler will not run |
| Spectrum application on port 22 | Enterprise, needs a zone you own | Nothing routes to the Worker |

Spectrum cannot front a `workers.dev` subdomain — it binds to a hostname in a
zone on your account. So there is no configuration in which this path works
without a custom domain, which is why `vite.config.ts` excludes this auxiliary
Worker unless `GITFLARE_SSH_ENABLED=1`.

**Git over HTTPS works today and needs none of this.** See
`src/server/git/http.ts`.

## How it works

```
git client --TCP:22--> Spectrum --> Worker.connect(socket)
                                          |
                                    SshServer (DO)
                                          |
                                 container.getTcpPort(22)
                                          |
                                        sshd
                                          |
                          git-upload-pack / git-receive-pack
                                          |
                            HTTPS + repo-scoped token --> Artifacts
```

A Worker cannot implement SSH — key exchange, ciphers, and `git-*-pack` need a
real userspace. So the Worker does the one thing it is good at (accepting the
connection and routing it) and hands the raw socket to a container, which is
exactly the pattern the announcement describes.

The container never holds long-lived credentials. Each session exchanges the
authenticated user and repo for a short-lived, repo-scoped Artifacts token
through the main Worker, so SSH is subject to the same permission rules as the
web UI and the HTTPS proxy.

### Authorization, step by step

1. **`authorized-keys-command.sh`** — sshd calls this with the offered public
   key. It asks the main Worker to resolve the key to a user. Live lookup, so
   revoking a key in the UI takes effect on the next connection.
2. The resolved user id is pinned into the `authorized_keys` line via
   `environment=`, so the next step knows who is connecting without trusting
   anything the client sends.
3. **`git-shell-wrapper.sh`** — the `ForceCommand`. Accepts only
   `git-upload-pack`, `git-upload-archive`, and `git-receive-pack`; anything
   else exits. It maps the verb to a read or write scope and asks the main
   Worker to authorize it, receiving a scoped Artifacts token in return.
4. The session is bridged to Artifacts over HTTPS with the token in a header
   rather than the URL, keeping it out of process listings and logs.

`sshd_config` disables passwords, PTY allocation, and every kind of forwarding.
A leaked key gets git access to repos that key's owner can already reach, and
nothing else.

## Enabling it

1. Get inbound-TCP beta access.
2. Create the host key and store it as a secret. Do **not** let the container
   generate one — a key that changes when an instance is replaced triggers
   `REMOTE HOST IDENTIFICATION HAS CHANGED` for every user, which teaches people
   to ignore the one warning that matters.
   ```sh
   ssh-keygen -t ed25519 -N '' -f gitflare_host_key
   wrangler secret put SSH_HOST_KEY --config wrangler.ssh.jsonc < gitflare_host_key
   wrangler secret put INTERNAL_TOKEN --config wrangler.ssh.jsonc
   ```
3. Point `GITFLARE_URL` in `wrangler.ssh.jsonc` at your deployed main Worker.
4. Build and deploy with the flag set:
   ```sh
   GITFLARE_SSH_ENABLED=1 pnpm build
   wrangler deploy --config wrangler.ssh.jsonc
   ```
5. Create a Spectrum application on port 22 of your zone, with this Worker as
   the origin.

## What is not implemented

The `/internal/ssh/authorized-key` and `/internal/ssh/authorize` endpoints on
the main Worker are the container's half of the contract. They are specified by
the two scripts here but not yet written — there was no way to exercise them, so
writing them would have meant shipping untested code behind an unreachable path.
Both are small: resolve a key fingerprint to a user, and run the existing
`requireRepo` check before minting a token via `ArtifactsClient.mintToken`.
