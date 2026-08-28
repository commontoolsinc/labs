/**
 * Encodes and decodes negotiated compression envelopes for memory WebSocket
 * messages. Envelopes remain text frames so proxies can forward them without
 * understanding the memory protocol.
 */

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { isObjectNotArray } from "@commonfabric/utils/types";

/** Prefix identifying the first version of the compression envelope. */
export const MEMORY_COMPRESSION_ENVELOPE_PREFIX = "mcmp1:";

/** Messages below this UTF-8 size stay in their original wire form. */
export const MEMORY_COMPRESSION_THRESHOLD_BYTES = 1_024;

/** Maximum expanded size accepted from one compression envelope. */
export const MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES = 64 * 1_024 * 1_024;

const MAX_GZIP_MEMORY_MESSAGE_BYTES = MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES +
  1_024 * 1_024;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();

/** JSON body carried after {@link MEMORY_COMPRESSION_ENVELOPE_PREFIX}. */
type CompressionEnvelope = {
  /** Compression format applied to `.payload`. */
  encoding: "gzip";
  /** Exact UTF-8 byte length required after expansion. */
  uncompressedBytes: number;
  /** Unpadded base64url encoding of one compressed message. */
  payload: string;
};

/**
 * Preserves message order while applying negotiated compression in both
 * directions of one text-frame channel.
 */
export class MemoryMessageCompressionChannel {
  #compressionEnabled = false;
  #closed = false;
  #incoming: Promise<void> = Promise.resolve();
  #outgoing: Promise<void> = Promise.resolve();
  #sendRaw: (payload: string) => void;
  #onError: (error: Error) => void;

  /** Constructs an instance around an ordinary text-frame sender. */
  constructor(
    sendRaw: (payload: string) => void,
    onError: (error: Error) => void,
  ) {
    this.#sendRaw = sendRaw;
    this.#onError = onError;
  }

  /** Enables compression envelopes for messages sent after this call. */
  enable(): void {
    this.#compressionEnabled = true;
  }

  /** Stops queued work and ignores later messages. */
  close(): void {
    this.#closed = true;
  }

  /** Resolves after every message already submitted in either direction. */
  async idle(): Promise<void> {
    await Promise.all([this.#incoming, this.#outgoing]);
  }

  /** Sends one payload after every payload submitted before it. */
  send(payload: string): void {
    if (this.#closed) return;
    if (!this.#compressionEnabled) {
      try {
        this.#sendRaw(payload);
      } catch (cause) {
        this.#fail(cause);
      }
      return;
    }
    const send = this.#outgoing.then(async () => {
      if (this.#closed) return;
      const frame = await encodeCompressedMemoryMessage(payload);
      if (!this.#closed) this.#sendRaw(frame);
    });
    this.#outgoing = send.catch((cause) => this.#fail(cause));
  }

  /** Expands one frame and delivers it after every frame submitted before it. */
  receive(
    frame: string,
    receiver: (payload: string) => void | Promise<void>,
  ): void {
    if (this.#closed) return;
    const receive = this.#incoming.then(async () => {
      if (this.#closed) return;
      const payload = this.#compressionEnabled
        ? await decodeCompressedMemoryMessage(frame)
        : frame;
      if (!this.#closed) await receiver(payload);
    });
    this.#incoming = receive.catch((cause) => this.#fail(cause));
  }

  /** Closes this channel and reports its first asynchronous failure. */
  #fail(cause: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#onError(
      cause instanceof Error
        ? cause
        : new Error("Memory message compression failure", { cause }),
    );
  }
}

/**
 * Compresses `payload` into a versioned text envelope when doing so reduces
 * its UTF-8 wire size. Small and incompressible payloads remain unchanged.
 */
export async function encodeCompressedMemoryMessage(
  payload: string,
): Promise<string> {
  const source = TEXT_ENCODER.encode(payload);
  if (source.byteLength < MEMORY_COMPRESSION_THRESHOLD_BYTES) {
    return payload;
  }
  if (source.byteLength > MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES) {
    return payload;
  }

  const compressed = await collectReadable(
    new Blob([source]).stream().pipeThrough(new CompressionStream("gzip")),
    MAX_GZIP_MEMORY_MESSAGE_BYTES,
  );
  const envelope: CompressionEnvelope = {
    encoding: "gzip",
    uncompressedBytes: source.byteLength,
    payload: toUnpaddedBase64url(compressed),
  };
  const encoded = MEMORY_COMPRESSION_ENVELOPE_PREFIX + JSON.stringify(envelope);
  return encoded.length < source.byteLength ? encoded : payload;
}

/**
 * Expands one compression envelope and returns ordinary memory wire text.
 * Payloads without the envelope prefix pass through unchanged.
 */
export async function decodeCompressedMemoryMessage(
  payload: string,
): Promise<string> {
  if (!payload.startsWith(MEMORY_COMPRESSION_ENVELOPE_PREFIX)) {
    return payload;
  }

  const envelope = parseCompressionEnvelope(
    payload.slice(MEMORY_COMPRESSION_ENVELOPE_PREFIX.length),
  );
  const compressed = fromBase64url(envelope.payload);
  const expanded = await collectReadable(
    new Blob([compressed.buffer as ArrayBuffer]).stream().pipeThrough(
      new DecompressionStream(envelope.encoding),
    ),
    envelope.uncompressedBytes,
  );
  if (expanded.byteLength !== envelope.uncompressedBytes) {
    throw new Error(
      "Memory compression envelope expanded to an unexpected size",
    );
  }
  return TEXT_DECODER.decode(expanded);
}

/** Collects `readable`, refusing output beyond `maximumBytes`. */
async function collectReadable(
  readable: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Memory compression envelope expands beyond its limit");
    }
    chunks.push(value);
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

/** Parses the JSON body and validates every compression-envelope field. */
function parseCompressionEnvelope(source: string): CompressionEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (cause) {
    throw new Error("Unable to parse memory compression envelope", { cause });
  }
  if (
    !isObjectNotArray(parsed) ||
    parsed.encoding !== "gzip" ||
    !Number.isSafeInteger(parsed.uncompressedBytes) ||
    (parsed.uncompressedBytes as number) < 0 ||
    (parsed.uncompressedBytes as number) >
      MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES ||
    typeof parsed.payload !== "string" ||
    parsed.payload.length > MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES
  ) {
    throw new Error("Invalid memory compression envelope");
  }
  return parsed as CompressionEnvelope;
}
