/**
 * TCP delay/bandwidth proxy: emulates a WAN link in front of a local server so
 * remote-latency behavior can be reproduced and measured on loopback. Each
 * chunk is forwarded at (receipt time + DELAY_MS) with per-direction ordering
 * preserved, so a round trip costs ~2x DELAY_MS regardless of burst shape;
 * BYTES_PER_SEC additionally serializes chunks at a fixed link rate. Being
 * TCP-level, it carries HTTP and WebSocket traffic alike.
 *
 * Built for the Topics interaction-performance work
 * (docs/plans/topics-performance-improvement.md): put it in front of a
 * rehearsal-clone toolshed (docs/development/space-clone-rehearsal.md) and
 * point a client at the proxy port.
 *
 *   deno run --allow-net --allow-env scripts/delay-proxy.ts
 *
 * Environment:
 *   LISTEN_PORT   port to listen on (default 8020)
 *   TARGET_PORT   local port to forward to (default 8010)
 *   DELAY_MS      one-way delay per chunk (default 95, i.e. ~190 ms RTT)
 *   BYTES_PER_SEC per-direction throughput cap; 0 = uncapped (default 0)
 *
 * Each connection logs its total bytes up/down on close, which is the
 * cheapest way to see a workload's transfer volume.
 */

/**
 * Pure scheduling model for the emulated link: propagation delay plus an
 * optional serialization rate, with a bounded send buffer. Extracted from the
 * socket pump so the schedule is deterministically testable
 * (`delay-proxy.test.ts`) without sockets or timers.
 *
 * The buffer bound exists only to keep proxy memory finite; it must not
 * distort the schedule. Reads pause at `highWater` and resume once completions
 * drop the backlog below `lowWater`, so the serializer stays fed across a
 * pause window (the backlog between the marks is what the link drains
 * meanwhile) and no idle gap appears in the emitted schedule — provided
 * `lowWater` exceeds the link's bandwidth-delay product, which it does by
 * orders of magnitude for any link this tool emulates. The bound does imply a
 * throughput ceiling of roughly `highWater` per delay window (~340 MB/s at
 * the defaults) — far above any emulated link, so uncapped mode is not
 * meaningfully capped by it.
 */
export class LinkScheduler {
  #linkFreeAt = 0;
  #queuedBytes = 0;

  constructor(
    readonly delayMs: number,
    readonly bytesPerSec: number,
    readonly highWater = 32 * 1024 * 1024,
    readonly lowWater = 16 * 1024 * 1024,
  ) {}

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  /**
   * Account a chunk read at `nowMs` and return the instant it should be
   * written: propagation delay from receipt, then queued behind the link's
   * serializer when a rate cap is set.
   */
  enqueue(nowMs: number, bytes: number): number {
    this.#queuedBytes += bytes;
    const arrival = nowMs + this.delayMs;
    let ready = Math.max(arrival, this.#linkFreeAt);
    if (this.bytesPerSec > 0) {
      ready += (bytes / this.bytesPerSec) * 1000;
    }
    this.#linkFreeAt = ready;
    return ready;
  }

  /** Account a chunk fully written to the destination. */
  complete(bytes: number): void {
    this.#queuedBytes -= bytes;
  }

  shouldPause(): boolean {
    return this.#queuedBytes >= this.highWater;
  }

  canResume(): boolean {
    return this.#queuedBytes < this.lowWater;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Forward one direction of a connection through the emulated link. Exported
 * for the deterministic failure-path test; production entry is the listener
 * below.
 *
 * The write chain never rejects: a failed destination write flips
 * `writeFailed`, after which remaining queued chunks drain without delay so
 * completions keep flowing, a paused reader is woken to observe the failure,
 * and the loop stops consuming the producer.
 */
export async function pump(
  from: Deno.Conn,
  to: Deno.Conn,
  scheduler: LinkScheduler,
  counter: { n: number },
) {
  let chain: Promise<void> = Promise.resolve();
  let resumeSignal: (() => void) | null = null;
  let writeFailed = false;
  const buf = new Uint8Array(64 * 1024);
  try {
    while (!writeFailed) {
      if (scheduler.shouldPause()) {
        await new Promise<void>((resolve) => {
          resumeSignal = resolve;
        });
        continue;
      }
      const n = await from.read(buf);
      if (n === null) break;
      const chunk = buf.slice(0, n);
      counter.n += n;
      const ready = scheduler.enqueue(performance.now(), chunk.length);
      chain = chain.then(async () => {
        if (!writeFailed) {
          const wait = ready - performance.now();
          if (wait > 0) await sleep(wait);
          try {
            let off = 0;
            while (off < chunk.length) {
              off += await to.write(chunk.subarray(off));
            }
          } catch (_) {
            writeFailed = true;
          }
        }
        scheduler.complete(chunk.length);
        if (resumeSignal !== null && (scheduler.canResume() || writeFailed)) {
          const resume = resumeSignal;
          resumeSignal = null;
          resume();
        }
      });
    }
  } catch (_) {
    // Reader side torn down; fall through to half-close.
  }
  await chain;
  try {
    (to as Deno.TcpConn).closeWrite();
  } catch (_) {
    // Already closed.
  }
}

if (import.meta.main) {
  const LISTEN_PORT = Number(Deno.env.get("LISTEN_PORT") ?? "8020");
  const TARGET_PORT = Number(Deno.env.get("TARGET_PORT") ?? "8010");
  const DELAY_MS = Number(Deno.env.get("DELAY_MS") ?? "95");
  const BYTES_PER_SEC = Number(Deno.env.get("BYTES_PER_SEC") ?? "0");

  const listener = Deno.listen({ hostname: "127.0.0.1", port: LISTEN_PORT });
  console.log(
    `delay-proxy 127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} ` +
      `(+${DELAY_MS}ms each way, cap ${BYTES_PER_SEC || "none"} B/s)`,
  );

  let connections = 0;
  for await (const conn of listener) {
    (async () => {
      let upstream: Deno.TcpConn;
      try {
        upstream = await Deno.connect({
          hostname: "127.0.0.1",
          port: TARGET_PORT,
        });
      } catch (e) {
        console.error(`upstream connect failed: ${e}`);
        conn.close();
        return;
      }
      const id = ++connections;
      const up = { n: 0 };
      const down = { n: 0 };
      console.log(`conn ${id} open`);
      await Promise.all([
        pump(conn, upstream, new LinkScheduler(DELAY_MS, BYTES_PER_SEC), up),
        pump(upstream, conn, new LinkScheduler(DELAY_MS, BYTES_PER_SEC), down),
      ]);
      try {
        conn.close();
      } catch (_) {
        // Already closed.
      }
      try {
        upstream.close();
      } catch (_) {
        // Already closed.
      }
      console.log(`conn ${id} closed: up ${up.n} B, down ${down.n} B`);
    })();
  }
}
