/**
 * Splits an oversized memory-protocol wire message into bounded text frames,
 * and reassembles those frames on the receiving side. This is framing only: a
 * reassembled payload is byte-identical to the unchunked encoding and flows
 * into the ordinary decode path, so nothing above the codec can tell a
 * chunked message from a whole one.
 *
 * A sender chunks only toward a peer that advertised the `wireChunking`
 * capability, and never chunks the handshake itself. The frames of one stream
 * go out contiguously — nothing else is emitted between the first and the
 * last — so a receiver holds at most one open stream per direction.
 *
 * State is per connection on both sides: a {@link WireChunker} owns the
 * stream identifiers a connection sends, a {@link WireReassembler} holds
 * what it has received of an open stream, and both are dropped on close.
 */

import { ProtocolError } from "../v2.ts";

/** Envelope tag of a chunk frame. An unchunked message starts `fvj1:`. */
const CHUNK_TAG = "fvc1:";

/**
 * Default send threshold and slice size, in UTF-16 code units. UTF-8 spends
 * at most three bytes per code unit, so a frame stays under 24 MiB — well
 * inside the 64 MiB ceiling a WebSocket peer enforces on an incoming frame,
 * and few enough frames that a real payload costs a handful of sends.
 */
export const DEFAULT_WIRE_CHUNK_SIZE = 8 * 1024 * 1024;

/**
 * Default cap on a reassembled payload, in UTF-16 code units. A receiver
 * whose open stream reaches past it treats the stream as a protocol
 * violation rather than accumulate without bound.
 */
export const DEFAULT_WIRE_REASSEMBLY_CAP = 512 * 1024 * 1024;

/** The violation a {@link WireChunkingError} reports. */
export type WireChunkingErrorCode =
  /** A `fvc1:` frame whose header fields are missing or unparsable. */
  | "malformed-header"
  /** An `index` that is not the open stream's expected next one. */
  | "unexpected-index"
  /** A frame belonging to anything but the open stream. */
  | "interleaved-frame"
  /** An open stream that reached past the reassembly cap. */
  | "reassembly-cap-exceeded";

/**
 * A received frame that violates the chunk framing contract. The receiver
 * closes the connection: the stream cannot be resynchronized, and a
 * reconnect re-syncs from scratch.
 */
export class WireChunkingError extends ProtocolError {
  /** Which of the framing rules the frame broke. */
  readonly code: WireChunkingErrorCode;

  /** Constructs an instance reporting `code`. */
  constructor(code: WireChunkingErrorCode, message: string) {
    super(message);
    this.name = "WireChunkingError";
    this.code = code;
  }
}

/** Tunable sizes of the chunk codec, in UTF-16 code units. */
export type WireChunkingConfig = {
  /**
   * Payload size at or under which a message goes out as one frame, and the
   * largest slice a chunked message is cut into.
   */
  chunkSize: number;
  /** Largest payload a {@link WireReassembler} accumulates. */
  reassemblyCap: number;
};

const DEFAULT_CONFIG: WireChunkingConfig = {
  chunkSize: DEFAULT_WIRE_CHUNK_SIZE,
  reassemblyCap: DEFAULT_WIRE_REASSEMBLY_CAP,
};

let config: WireChunkingConfig = DEFAULT_CONFIG;

/**
 * Ambient sizes of the chunk codec. A deployment runs the defaults; the seam
 * exists so a test can force chunking with payloads it can hold in memory.
 * An omitted field takes its default.
 */
export function setWireChunkingConfig(
  overrides?: Partial<WireChunkingConfig>,
): void {
  const chunkSize = overrides?.chunkSize ?? DEFAULT_WIRE_CHUNK_SIZE;
  const reassemblyCap = overrides?.reassemblyCap ??
    DEFAULT_WIRE_REASSEMBLY_CAP;
  // Two code units is the floor a surrogate pair imposes: a one-unit slice
  // cannot hold a pair, and no boundary rule can keep one whole.
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 2) {
    throw new RangeError(
      `Chunk size must be at least 2 code units: ${chunkSize}`,
    );
  }
  if (!Number.isSafeInteger(reassemblyCap) || reassemblyCap < 1) {
    throw new RangeError(
      `Reassembly cap must be a positive integer: ${reassemblyCap}`,
    );
  }
  config = { chunkSize, reassemblyCap };
}

/** The sizes in effect, as a copy the caller may keep. */
export function getWireChunkingConfig(): WireChunkingConfig {
  return { ...config };
}

/** Restores both sizes to their deployment defaults. */
export function resetWireChunkingConfig(): void {
  config = DEFAULT_CONFIG;
}

const isHighSurrogate = (unit: number): boolean =>
  unit >= 0xd800 && unit <= 0xdbff;

/**
 * The sending state of one connection: the stream identifiers its chunked
 * messages carry. Hold one per connection for the life of the connection and
 * drop it on close, opposite the {@link WireReassembler} on the receiving
 * side. Identifiers only have to tell one of this connection's streams from
 * the next, so each connection numbers its own from 0.
 */
export class WireChunker {
  #nextStreamId = 0;

  /** Takes the identifier for the next stream this connection sends. */
  claimStreamId(): number {
    return this.#nextStreamId++;
  }
}

/**
 * Splits `encoded` into the frames `chunker`'s connection sends for it. A
 * payload at or under the chunk size is returned unchanged as a single
 * frame; a larger one becomes two or more `fvc1:` frames of one stream,
 * which the caller sends in the order given and without interleaving
 * anything else.
 *
 * Slicing counts UTF-16 code units rather than encoded bytes, so a frame's
 * byte length is up to three times its slice length, and no slice exceeds
 * the chunk size. A slice never ends on a high surrogate, which would strand
 * its low surrogate in the next frame and leave neither frame encodable as
 * text; the chunk size is at least two code units, so giving the pair to the
 * next slice always leaves a non-empty one behind.
 */
export const splitWireMessage = (
  encoded: string,
  chunker: WireChunker,
): string[] => {
  const { chunkSize } = config;
  if (encoded.length <= chunkSize) return [encoded];

  const slices: string[] = [];
  let start = 0;
  while (start < encoded.length) {
    let end = Math.min(start + chunkSize, encoded.length);
    if (end < encoded.length && isHighSurrogate(encoded.charCodeAt(end - 1))) {
      end -= 1;
    }
    slices.push(encoded.slice(start, end));
    start = end;
  }

  const streamId = chunker.claimStreamId();
  const count = slices.length;
  return slices.map((slice, index) =>
    `${CHUNK_TAG}${streamId}:${index}:${count}:${slice}`
  );
};

const DECIMAL = /^[0-9]+$/;

const parseField = (text: string): number | undefined => {
  if (!DECIMAL.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
};

type ChunkFrame = {
  streamId: number;
  index: number;
  count: number;
  slice: string;
};

/**
 * Helper for {@link WireReassembler}, which reads the `fvc1:` header off a
 * frame and returns its fields together with the slice that follows them.
 * The slice is everything past the third separator, so a slice containing
 * `:` parses back exactly.
 */
const parseChunkFrame = (frame: string): ChunkFrame => {
  const malformed = () =>
    new WireChunkingError(
      "malformed-header",
      `Malformed \`${CHUNK_TAG}\` frame header.`,
    );

  const streamEnd = frame.indexOf(":", CHUNK_TAG.length);
  if (streamEnd < 0) throw malformed();
  const indexEnd = frame.indexOf(":", streamEnd + 1);
  if (indexEnd < 0) throw malformed();
  const countEnd = frame.indexOf(":", indexEnd + 1);
  if (countEnd < 0) throw malformed();

  const streamId = parseField(frame.slice(CHUNK_TAG.length, streamEnd));
  const index = parseField(frame.slice(streamEnd + 1, indexEnd));
  const count = parseField(frame.slice(indexEnd + 1, countEnd));
  if (streamId === undefined || index === undefined || count === undefined) {
    throw malformed();
  }
  // A message that fits in one frame is sent unchunked, so a stream always
  // has at least two frames and every index names one of them.
  if (count < 2 || index >= count) throw malformed();

  return { streamId, index, count, slice: frame.slice(countEnd + 1) };
};

/**
 * Reassembles the frames arriving on one direction of one connection. Hold
 * one per direction for the life of the connection and drop it on close: a
 * partially reassembled stream is abandoned there, and the reconnect
 * re-syncs from scratch.
 */
export class WireReassembler {
  #streamId: number | undefined = undefined;
  #count = 0;
  #nextIndex = 0;
  #length = 0;
  #slices: string[] = [];

  /**
   * Accepts one received frame, returning the payload it completes or `null`
   * while the open stream is unfinished. A frame that is not a chunk is its
   * own payload, returned unchanged.
   *
   * Throws {@link WireChunkingError} on any violation of the framing
   * contract, at which point the caller closes the connection and drops the
   * instance along with whatever it had accumulated.
   */
  accept(frame: string): string | null {
    if (!frame.startsWith(CHUNK_TAG)) {
      if (this.#streamId !== undefined) {
        throw new WireChunkingError(
          "interleaved-frame",
          `Unchunked frame arrived inside stream ${this.#streamId}.`,
        );
      }
      return frame;
    }

    const { streamId, index, count, slice } = parseChunkFrame(frame);

    if (this.#streamId === undefined) {
      if (index !== 0) {
        throw new WireChunkingError(
          "unexpected-index",
          `Stream ${streamId} opened at index ${index}, expected 0.`,
        );
      }
      this.#streamId = streamId;
      this.#count = count;
    } else {
      if (streamId !== this.#streamId) {
        throw new WireChunkingError(
          "interleaved-frame",
          `Stream ${streamId} arrived inside stream ${this.#streamId}.`,
        );
      }
      if (index !== this.#nextIndex) {
        throw new WireChunkingError(
          "unexpected-index",
          `Stream ${streamId} delivered index ${index}, expected ` +
            `${this.#nextIndex}.`,
        );
      }
      if (count !== this.#count) {
        throw new WireChunkingError(
          "malformed-header",
          `Stream ${streamId} declared count ${count} after ${this.#count}.`,
        );
      }
    }

    this.#length += slice.length;
    if (this.#length > config.reassemblyCap) {
      throw new WireChunkingError(
        "reassembly-cap-exceeded",
        `Stream ${streamId} reached ${this.#length} code units, past the ` +
          `${config.reassemblyCap} cap.`,
      );
    }
    this.#slices.push(slice);
    this.#nextIndex = index + 1;

    if (this.#nextIndex < this.#count) return null;

    const payload = this.#slices.join("");
    this.reset();
    return payload;
  }

  /** Discards the open stream, if any, leaving the instance ready to reuse. */
  reset(): void {
    this.#streamId = undefined;
    this.#count = 0;
    this.#nextIndex = 0;
    this.#length = 0;
    this.#slices = [];
  }
}
