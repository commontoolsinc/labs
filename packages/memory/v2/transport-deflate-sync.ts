/**
 * Synchronous server-side codec for the `cf-memory.deflate.v1` memory websocket
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
import {
  MEMORY_WS_DEFLATE_MIN_BYTES,
  MEMORY_WS_INFLATE_MAX_BYTES,
} from "./transport-deflate.ts";
import {
  encodeMemoryBoundary,
  isAuthBearingWireMessage,
  type ServerMessage,
} from "../v2.ts";

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

/** Per-frame accounting hook for {@link encodeMemoryWireFrameSync}. */
export type OutboundFrameHook = (
  wireBytes: number,
  logicalBytes: number,
  compressed: boolean,
  cpuMs?: number,
) => void;

/**
 * Encodes one outbound server frame, owning the shared sender policy: text
 * when compression is off for this connection, for auth-bearing messages
 * (see `isAuthBearingWireMessage` in ../v2.ts), or below the size
 * threshold; compressed otherwise. Both memory websocket servers (toolshed
 * and the standalone harness) route sends through this single decision
 * tree; error handling and socket teardown stay per-site.
 */
export const encodeMemoryWireFrameSync = (
  message: ServerMessage,
  deflateOutbound: boolean,
  onFrame?: OutboundFrameHook,
): string | Uint8Array<ArrayBuffer> => {
  const payload = encodeMemoryBoundary(message);
  if (!deflateOutbound || isAuthBearingWireMessage(message)) {
    if (onFrame !== undefined) {
      const bytes = textEncoder.encode(payload).byteLength;
      onFrame(bytes, bytes, false);
    }
    return payload;
  }
  const payloadBytes = textEncoder.encode(payload);
  if (payloadBytes.byteLength < MEMORY_WS_DEFLATE_MIN_BYTES) {
    onFrame?.(payloadBytes.byteLength, payloadBytes.byteLength, false);
    return payload;
  }
  const started = performance.now();
  const compressed = deflateWirePayloadSync(payloadBytes);
  onFrame?.(
    compressed.byteLength,
    payloadBytes.byteLength,
    true,
    performance.now() - started,
  );
  return compressed;
};
