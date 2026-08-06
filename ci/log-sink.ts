import type { CiLogStream } from '../src/server/ci/log-stream'
import type { LogSink } from './sandbox-runner'

/**
 * Forwards sandbox output into the CiLogStream Durable Object.
 *
 * Output arrives from `execStream` in small, frequent chunks — often a line at a
 * time. One RPC per chunk would make a chatty build cost thousands of round
 * trips, so writes are coalesced: chunks accumulate and flush either when the
 * buffer is large enough or after a short delay, whichever comes first.
 *
 * The delay is what keeps it feeling live. Flushing only on size would leave the
 * last few lines of a quiet build sitting in the buffer indefinitely, which is
 * exactly when someone is watching most closely.
 */

const FLUSH_BYTES = 8 * 1024
const FLUSH_INTERVAL_MS = 250

export class DurableObjectLogSink implements LogSink {
  private buffer: { stepName: string; text: string; isStderr: boolean }[] = []
  private bufferedBytes = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<unknown> = Promise.resolve()

  constructor(private readonly stub: DurableObjectStub<CiLogStream>) {}

  append(stepName: string, text: string, isStderr: boolean): void {
    // Adjacent chunks from the same stream are merged, since a build usually
    // emits many small writes to one stream in a row.
    const last = this.buffer.at(-1)
    if (last && last.stepName === stepName && last.isStderr === isStderr) {
      last.text += text
    } else {
      this.buffer.push({ stepName, text, isStderr })
    }

    this.bufferedBytes += text.length
    if (this.bufferedBytes >= FLUSH_BYTES) {
      void this.flush()
      return
    }
    this.timer ??= setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS)
  }

  /** Writes whatever is buffered. Safe to call when there is nothing pending. */
  async flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer.length === 0) return

    const pending = this.buffer
    this.buffer = []
    this.bufferedBytes = 0

    // Chained rather than awaited in parallel: sequence numbers are assigned by
    // the DO in call order, and concurrent writes would interleave a step's
    // output with itself.
    this.inFlight = this.inFlight.then(async () => {
      for (const chunk of pending) {
        await this.stub.append(chunk.stepName, chunk.text, chunk.isStderr)
      }
    })
    await this.inFlight
  }

  /** Flushes and marks the run finished so streaming clients close cleanly. */
  async finish(status: string): Promise<void> {
    await this.flush()
    await this.stub.finish(status)
  }
}
