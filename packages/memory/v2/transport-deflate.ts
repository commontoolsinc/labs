/**
 * transport-level per-message compression for the memory v2 websocket.
 *
 * Negotiated via the websocket subprotocol `cf-memory.deflate.v1`: the client offers
 * it in the upgrade request, and the server always selects an offer. Once
 * negotiated, either peer MAY send any memory wire payload as a binary frame
 * containing the raw-deflate (RFC 1951) compression of the payload's UTF-8
 * bytes. Text frames remain valid after negotiation and are processed
 * unchanged, so senders skip compression for small payloads. Peers that do
 * not negotiate the subprotocol keep the historical text-only framing byte
 * for byte, and the memory protocol itself (hello/flags, message shapes) is
 * untouched — this layer sits strictly below `encodeMemoryBoundary`.
 *
 * Compression is stateless per message (no shared sliding window), so
 * reconnects and replays need no transport state. Auth-bearing frames
 * (`hello`, `hello.ok`, `session.open`) are never compressed by either
 * peer, keeping credential material out of compression-size side channels;
 * receivers accept any frame either way — the exemption is sender policy.
 *
 * Servers use the synchronous codec (transport-deflate-sync.ts) so dispatch
 * stays inside the message event handler. Browser clients have only the
 * async streaming codec below, which detaches dispatch from event delivery —
 * so the client side funnels each direction through a `SerialTaskQueue` to
 * keep dispatch order identical to arrival order.
 *
 * Rollout caveat (per RFC 6455 §4.1): a client that offers a subprotocol
 * MUST fail the connection when the server selects none, so servers must
 * support (or at least select) the subprotocol before clients start offering
 * it. Deno clients can disable the offer with `CF_MEMORY_WS_DEFLATE=0`.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

export const MEMORY_WS_DEFLATE_SUBPROTOCOL = "cf-memory.deflate.v1";

/**
 * Payloads whose UTF-8 encoding is below this size are sent as plain text
 * frames even on a negotiated connection: raw deflate saves little below a
 * couple hundred bytes and every frame pays the async hop.
 */
export const MEMORY_WS_DEFLATE_MIN_BYTES = 192;

/**
 * Hard cap on a single inflated payload. Nothing legitimate approaches this
 * today (large sync frames are a few MB); the cap exists so a hostile peer
 * cannot expand a tiny binary frame into unbounded memory (zip bomb).
 */
export const MEMORY_WS_INFLATE_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Whether this process should OFFER the subprotocol (clients) and COMPRESS
 * its outbound payloads (either peer). Deliberately NOT consulted for
 * selection or inbound decompression: a server must select the subprotocol
 * whenever it is offered — a client that offers and is refused fails the
 * whole connection per RFC 6455 §4.1, and browsers cannot read env — so the
 * kill switch only stops this process from spending compression CPU.
 */
const defaultEnvReader = (): string | undefined =>
  (globalThis as { Deno?: typeof Deno }).Deno?.env?.get(
    "CF_MEMORY_WS_DEFLATE",
  );

export const memoryWsDeflateEnabled = (
  readEnv: () => string | undefined = defaultEnvReader,
): boolean => {
  try {
    const value = readEnv();
    return value !== "0" && value !== "false";
  } catch {
    // Browsers (no Deno global) default on; a Deno process whose env is
    // permission-restricted cannot express an opt-out, so default off there.
    return typeof (globalThis as { Deno?: unknown }).Deno === "undefined";
  }
};

let deflateRawSupport: boolean | null = null;

const defaultDeflateRawProbe = (): void => {
  new CompressionStream("deflate-raw");
  new DecompressionStream("deflate-raw");
};

/** Test seam: forget the cached probe result. */
export const resetMemoryWsDeflateSupport = (): void => {
  deflateRawSupport = null;
};

/**
 * Whether this runtime can construct `deflate-raw` compression streams.
 * Clients must not offer the subprotocol without this: an offer is a
 * commitment to inflate whatever the server compresses.
 */
export const memoryWsDeflateSupported = (
  probe: () => void = defaultDeflateRawProbe,
): boolean => {
  if (deflateRawSupport !== null) return deflateRawSupport;
  try {
    probe();
    deflateRawSupport = true;
  } catch {
    deflateRawSupport = false;
  }
  return deflateRawSupport;
};

/**
 * Cap on compressed bytes a client may have queued behind its serial
 * inflate hop. Inflation normally drains faster than frames arrive; the cap
 * exists so a peer cannot grow the queue without bound while the event loop
 * is busy. (Servers inflate synchronously and need no such bound.)
 */
export const MEMORY_WS_MAX_PENDING_INFLATE_BYTES = 16 * 1024 * 1024;

/**
 * Tighter inflate cap for server-side (inbound) frames. A server inflates
 * synchronously on the shared event loop, before any session authorization,
 * so the cap bounds how long one unauthenticated frame can block every
 * connection on the process. 8 MiB is a few milliseconds of inflation while
 * comfortably exceeding any legitimate client frame; server-to-client sync
 * frames may be larger, so clients keep the wider cap above.
 */
export const MEMORY_WS_SERVER_INFLATE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Picks the deflate subprotocol out of a `Sec-WebSocket-Protocol` offer
 * header, or undefined when it is absent or malformed. Selection is pure
 * compatibility (see `memoryWsDeflateEnabled`) — servers pass the result
 * straight to `Deno.upgradeWebSocket`'s `protocol` whenever it is defined.
 */
export const selectMemoryWsDeflateProtocol = (
  offerHeader: string | null | undefined,
): string | undefined => {
  if (typeof offerHeader !== "string") return undefined;
  const offered = offerHeader.split(",").map((token) => token.trim());
  return offered.includes(MEMORY_WS_DEFLATE_SUBPROTOCOL)
    ? MEMORY_WS_DEFLATE_SUBPROTOCOL
    : undefined;
};

/** Raw-deflate compression of a wire payload's UTF-8 bytes. */
export const deflateWirePayload = async (
  payload: string,
): Promise<Uint8Array<ArrayBuffer>> => {
  const stream = new Blob([textEncoder.encode(payload)]).stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

/**
 * Inflates a binary frame back into a wire payload string, enforcing
 * `maxBytes` on the inflated size while streaming so an over-limit payload
 * aborts before it is fully materialized. Throws on malformed deflate data,
 * invalid UTF-8, or an over-limit payload.
 */
export const inflateWirePayload = async (
  data: ArrayBuffer | ArrayBufferView,
  maxBytes: number = MEMORY_WS_INFLATE_MAX_BYTES,
): Promise<string> => {
  // Websocket frames are never SharedArrayBuffer-backed; the assertion keeps
  // the view zero-copy under TypeScript's ArrayBufferLike-generic typed arrays.
  const bytes =
    (ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data)) as Uint8Array<ArrayBuffer>;
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(
          `Memory websocket payload inflates past ${maxBytes} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    await stream.cancel().catch(() => {});
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return textDecoder.decode(joined);
};

/**
 * FIFO chain for the async compression hops. Order is fixed at `enqueue`
 * call time; a task's failure rejects that task's caller without poisoning
 * later tasks.
 */
export class SerialTaskQueue {
  #chain: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.#chain.then(task);
    this.#chain = result.then(() => {}, () => {});
    return result;
  }
}
