/**
 * Synchronous server-side codec for the `fvj1.deflate` memory websocket
 * transport (see transport-deflate.ts for the negotiation contract).
 *
 * Servers use the synchronous zlib codec instead of the streaming one for a
 * structural reason beyond speed: a synchronous codec keeps websocket
 * dispatch synchronous inside the message event handler, so frame ordering,
 * pre-close delivery, and nothing-after-close remain properties of the event
 * loop itself rather than of hand-maintained queues. Browsers have no
 * synchronous codec, so the client side keeps the async machinery; both
 * codecs speak identical raw-deflate (RFC 1951) bytes.
 *
 * Deno/Node only — this module must never be imported into browser bundles.
 */

import { deflateRawSync, inflateRawSync } from "builtin-zlib";
import { MEMORY_WS_INFLATE_MAX_BYTES } from "./transport-deflate.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

/** Raw-deflate compression of a wire payload's UTF-8 bytes, synchronously.
 *  Accepts pre-encoded bytes so hot paths that already measured the payload
 *  do not encode twice. */
export const deflateWirePayloadSync = (
  payload: string | Uint8Array,
): Uint8Array<ArrayBuffer> => {
  const compressed = deflateRawSync(
    typeof payload === "string" ? textEncoder.encode(payload) : payload,
  );
  return new Uint8Array(
    compressed.buffer,
    compressed.byteOffset,
    compressed.byteLength,
  ) as Uint8Array<ArrayBuffer>;
};

/**
 * Inflates a binary frame back into a wire payload string, synchronously.
 * `maxBytes` bounds the inflated size (zlib aborts past it — zip-bomb
 * guard). Throws on malformed deflate data, invalid UTF-8, or an over-limit
 * payload.
 */
export const inflateWirePayloadSync = (
  data: ArrayBuffer | ArrayBufferView,
  maxBytes: number = MEMORY_WS_INFLATE_MAX_BYTES,
): string => {
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  const inflated = inflateRawSync(bytes, { maxOutputLength: maxBytes });
  return textDecoder.decode(inflated);
};
