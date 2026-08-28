/**
 * Encodes and decodes negotiated compression envelopes for memory WebSocket
 * messages. Compressed envelopes use binary WebSocket frames so the gzip
 * payload travels without another encoding layer.
 */

/** Frames produced by the compression encoder. */
export type EncodedMemoryMessage = string | Uint8Array<ArrayBuffer>;

/** WebSocket message forms accepted by the compression decoder. */
export type MemoryMessageFrame =
  | EncodedMemoryMessage
  | ArrayBuffer
  | Uint8Array<ArrayBufferLike>
  | Blob;

const MEMORY_COMPRESSION_MAGIC = [0x6d, 0x63, 0x6d, 0x70] as const;
const MEMORY_COMPRESSION_VERSION = 1;
const MEMORY_COMPRESSION_HEADER_BYTES = 9;

/** Messages below this UTF-8 size stay in their original wire form. */
export const MEMORY_COMPRESSION_THRESHOLD_BYTES = 1_024;

/** Maximum expanded size accepted from one compression envelope. */
export const MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES = 256 * 1_024 * 1_024;

const MAX_GZIP_MEMORY_MESSAGE_BYTES = MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES +
  1_024 * 1_024;

const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const TEXT_ENCODER = new TextEncoder();

/**
 * Preserves message order while applying negotiated compression in both
 * directions of one WebSocket channel.
 */
export class MemoryMessageCompressionChannel {
  #compressionEnabled = false;
  #closed = false;
  #incoming: Promise<void> = Promise.resolve();
  #outgoing: Promise<void> = Promise.resolve();
  #sendRaw: (payload: EncodedMemoryMessage) => void;
  #onError: (error: Error) => void;

  /** Constructs an instance around a WebSocket frame sender. */
  constructor(
    sendRaw: (payload: EncodedMemoryMessage) => void,
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
    frame: MemoryMessageFrame,
    receiver: (payload: string) => void | Promise<void>,
  ): void {
    if (this.#closed) return;
    const receive = this.#incoming.then(async () => {
      if (this.#closed) return;
      const payload = this.#compressionEnabled
        ? await decodeCompressedMemoryMessage(frame)
        : requireTextFrame(frame);
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
 * Compresses `payload` into a versioned binary envelope when doing so reduces
 * its UTF-8 wire size. Small and incompressible payloads remain text.
 */
export async function encodeCompressedMemoryMessage(
  payload: string,
): Promise<EncodedMemoryMessage> {
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
  const encoded = new Uint8Array(
    MEMORY_COMPRESSION_HEADER_BYTES + compressed.byteLength,
  );
  encoded.set(MEMORY_COMPRESSION_MAGIC);
  encoded[4] = MEMORY_COMPRESSION_VERSION;
  new DataView(encoded.buffer).setUint32(5, source.byteLength);
  encoded.set(compressed, MEMORY_COMPRESSION_HEADER_BYTES);
  return encoded.byteLength < source.byteLength ? encoded : payload;
}

/**
 * Expands one binary compression envelope and returns ordinary memory wire
 * text. Text frames pass through unchanged.
 */
export async function decodeCompressedMemoryMessage(
  frame: MemoryMessageFrame,
): Promise<string> {
  if (typeof frame === "string") return frame;

  const envelope = await parseCompressionEnvelope(frame);
  const expanded = await collectReadable(
    new Blob([envelope.compressed]).stream().pipeThrough(
      new DecompressionStream("gzip"),
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

/** Returns the wire size of a received WebSocket message. */
export function memoryMessageFrameBytes(frame: MemoryMessageFrame): number {
  if (typeof frame === "string") return TEXT_ENCODER.encode(frame).byteLength;
  if (frame instanceof Blob) return frame.size;
  return frame.byteLength;
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

/** Parses and validates the fixed binary compression-envelope header. */
async function parseCompressionEnvelope(
  frame: Exclude<MemoryMessageFrame, string>,
): Promise<{ uncompressedBytes: number; compressed: Uint8Array<ArrayBuffer> }> {
  const bytes = frame instanceof Blob
    ? new Uint8Array(await frame.arrayBuffer())
    : frame instanceof Uint8Array
    ? new Uint8Array(frame)
    : new Uint8Array(frame);
  const headerMatches = bytes.byteLength >= MEMORY_COMPRESSION_HEADER_BYTES &&
    MEMORY_COMPRESSION_MAGIC.every((byte, index) => bytes[index] === byte) &&
    bytes[4] === MEMORY_COMPRESSION_VERSION;
  if (!headerMatches) {
    throw new Error("Invalid memory compression envelope");
  }
  const uncompressedBytes = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    MEMORY_COMPRESSION_HEADER_BYTES,
  ).getUint32(5);
  const compressed = bytes.slice(MEMORY_COMPRESSION_HEADER_BYTES);
  if (
    uncompressedBytes > MAX_DECOMPRESSED_MEMORY_MESSAGE_BYTES ||
    compressed.byteLength > MAX_GZIP_MEMORY_MESSAGE_BYTES
  ) {
    throw new Error("Invalid memory compression envelope");
  }
  return { uncompressedBytes, compressed };
}

/** Refuses binary frames before compression has been negotiated. */
function requireTextFrame(frame: MemoryMessageFrame): string {
  if (typeof frame !== "string") {
    throw new Error("Memory websocket expects text before negotiation");
  }
  return frame;
}
