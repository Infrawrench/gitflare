import { DurableObject } from 'cloudflare:workers'

/**
 * Git over SSH, via the inbound TCP `connect()` handler.
 *
 * Cloudflare's Spectrum terminates the TCP connection and hands the Worker a
 * raw socket. The Worker cannot implement SSH itself — that needs a real
 * userspace with key exchange, ciphers, and `git-upload-pack` — so the socket is
 * forwarded to a container running sshd, exactly as described in
 * https://blog.cloudflare.com/grpc-workers/. Sockets can be passed between
 * Workers, Durable Objects, and Containers, which is what makes this possible.
 *
 * ─── NOT DEPLOYABLE ON workers.dev ───────────────────────────────────────────
 * This requires two things that are not generally available:
 *   1. The inbound-TCP private beta (sign-up required).
 *   2. A Spectrum application on port 22 of a zone you own.
 * Spectrum cannot front a workers.dev subdomain, so there is no way to test this
 * without a custom domain. `vite.config.ts` therefore only includes this
 * auxiliary Worker when GITFLARE_SSH_ENABLED=1. Git over HTTPS is the supported
 * path until then; see src/server/git/http.ts. Details in ssh/README.md.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface SshEnv {
  SSH_SERVER: DurableObjectNamespace<SshServer>
  /** Main Worker, for public-key and repo authorization lookups. */
  GITFLARE: Fetcher
  ARTIFACTS_NAMESPACE: string
  GITFLARE_URL: string
  SSH_HOST_KEY: string
  INTERNAL_TOKEN: string
}

/** The socket handed to a `connect()` handler. */
interface InboundSocket {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  close?(): Promise<void>
}

export default {
  /**
   * Accepts an inbound TCP connection from Spectrum.
   *
   * The connection is routed to a Durable Object rather than handled here
   * because the container lives behind one: a DO instance owns a container
   * instance, and that is the only way to reach its TCP ports.
   */
  async connect(socket: InboundSocket, env: SshEnv): Promise<void> {
    // Sessions are spread over a small pool rather than pinned to one instance,
    // so a single container's connection limit does not cap the whole service.
    // Any instance can serve any repo — sshd holds no per-repo state.
    const id = env.SSH_SERVER.idFromName(`ssh-pool-${Math.floor(Math.random() * 4)}`)
    const stub = env.SSH_SERVER.get(id)
    await stub.handleSession(socket)
  },
}

export class SshServer extends DurableObject<SshEnv> {
  /**
   * Pipes an inbound socket to the container's sshd and back.
   *
   * Both directions are piped concurrently and the whole thing is awaited with
   * `allSettled`: SSH is full-duplex, and if one direction closes first the
   * other must still be allowed to drain. Using `all` would reject on the first
   * closed pipe and tear down a session that was still delivering data.
   */
  async handleSession(socket: InboundSocket): Promise<void> {
    const container = this.ctx.container
    if (!container) {
      await this.reject(socket, 'SSH container is not available')
      return
    }
    if (!container.running) {
      container.start({
        // Required: the git bridge reaches Artifacts over HTTPS, and the
        // authorization scripts call back to the main Worker. Without outbound
        // access every session would fail at the first curl.
        enableInternet: true,
        env: {
          SSH_HOST_KEY: this.env.SSH_HOST_KEY,
          GITFLARE_URL: this.env.GITFLARE_URL,
          INTERNAL_TOKEN: this.env.INTERNAL_TOKEN,
          ARTIFACTS_NAMESPACE: this.env.ARTIFACTS_NAMESPACE,
        },
      })
    }

    // getTcpPort() returns a Fetcher already bound to the container's port, but
    // its connect() still takes an address to satisfy the socket API. The host
    // is resolved inside the container's own network namespace.
    const upstream = container.getTcpPort(22).connect('127.0.0.1:22')

    await Promise.allSettled([
      socket.readable.pipeTo(upstream.writable),
      upstream.readable.pipeTo(socket.writable),
    ])
  }

  /**
   * Writes a plain-text reason before closing.
   *
   * A bare disconnect gives the user "Connection closed by remote host", which
   * says nothing. Anything written before the SSH banner is shown by most
   * clients, so this is the one chance to explain.
   */
  private async reject(socket: InboundSocket, reason: string): Promise<void> {
    try {
      const writer = socket.writable.getWriter()
      await writer.write(new TextEncoder().encode(`${reason}\r\n`))
      await writer.close()
    } catch {
      // The peer may already be gone; nothing useful to do.
    }
  }
}
