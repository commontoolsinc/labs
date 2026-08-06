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
const LISTEN_PORT = Number(Deno.env.get("LISTEN_PORT") ?? "8020");
const TARGET_PORT = Number(Deno.env.get("TARGET_PORT") ?? "8010");
const DELAY_MS = Number(Deno.env.get("DELAY_MS") ?? "95");
const BYTES_PER_SEC = Number(Deno.env.get("BYTES_PER_SEC") ?? "0");

const listener = Deno.listen({ hostname: "127.0.0.1", port: LISTEN_PORT });
console.log(
  `delay-proxy 127.0.0.1:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} ` +
    `(+${DELAY_MS}ms each way, cap ${BYTES_PER_SEC || "none"} B/s)`,
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop reading from the producer once this many bytes sit queued behind the
 * emulated link — the proxy's stand-in for the send buffer a real constrained
 * link would fill, so producers see backpressure instead of the proxy
 * buffering an entire transfer in memory.
 */
const HIGH_WATER_BYTES = 256 * 1024;

async function pump(from: Deno.Conn, to: Deno.Conn, counter: { n: number }) {
  let chain: Promise<void> = Promise.resolve();
  // Modeled instant at which the emulated link last finished transmitting;
  // the next chunk cannot start before it (serialization under the cap).
  let linkFreeAt = 0;
  let queuedBytes = 0;
  const buf = new Uint8Array(64 * 1024);
  try {
    while (true) {
      if (queuedBytes >= HIGH_WATER_BYTES) {
        await chain;
        continue;
      }
      const n = await from.read(buf);
      if (n === null) break;
      const chunk = buf.slice(0, n);
      counter.n += n;
      queuedBytes += n;
      const arrival = performance.now() + DELAY_MS;
      chain = chain.then(async () => {
        let ready = Math.max(arrival, linkFreeAt);
        if (BYTES_PER_SEC > 0) {
          ready += (chunk.length / BYTES_PER_SEC) * 1000;
        }
        linkFreeAt = ready;
        const wait = ready - performance.now();
        if (wait > 0) await sleep(wait);
        let off = 0;
        while (off < chunk.length) off += await to.write(chunk.subarray(off));
        queuedBytes -= chunk.length;
      });
    }
  } catch (_) {
    // Reader or writer side torn down; fall through to half-close.
  }
  try {
    await chain;
  } catch (_) {
    // Writer gone; nothing left to flush.
  }
  try {
    (to as Deno.TcpConn).closeWrite();
  } catch (_) {
    // Already closed.
  }
}

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
    await Promise.all([pump(conn, upstream, up), pump(upstream, conn, down)]);
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
