import { newDefaultJsonCodecEngine } from "@commonfabric/data-model/codecs";
import { stableFabricValue } from "./stable-fabric-value.ts";

export const DEFAULT_CHUNK_BYTES = 512 * 1024;

export interface EventChunk<T> {
  part: number;
  events: T[];
  byteLength: number;
}

const fabricJsonCodec = newDefaultJsonCodecEngine();
const textEncoder = new TextEncoder();

/**
 * The size a value takes on the wire, which is what a chunk budget is spent
 * on: the UTF-8 length of this format's serialized form.
 */
export function encodedJsonBytes(value: unknown): number {
  return textEncoder.encode(
    fabricJsonCodec.encode(stableFabricValue(value)),
  ).byteLength;
}

const EMPTY_ARRAY_BYTES = encodedJsonBytes([]);

function encodedJsonArrayElementBytes(value: unknown): number {
  return encodedJsonBytes([value]) - EMPTY_ARRAY_BYTES;
}

export function chunkEvents<T>(
  events: readonly T[],
  targetBytes = DEFAULT_CHUNK_BYTES,
): EventChunk<T>[] {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  if (events.length === 0) {
    return [{ part: 0, events: [], byteLength: EMPTY_ARRAY_BYTES }];
  }

  const chunks: EventChunk<T>[] = [];
  let current: T[] = [];
  let currentBytes = EMPTY_ARRAY_BYTES;
  for (const event of events) {
    const eventBytes = encodedJsonArrayElementBytes(event);
    const candidateBytes = currentBytes +
      (current.length === 0 ? 0 : 1) +
      eventBytes;
    if (current.length > 0 && candidateBytes > targetBytes) {
      chunks.push({
        part: chunks.length,
        events: current,
        byteLength: currentBytes,
      });
      current = [event];
      currentBytes = EMPTY_ARRAY_BYTES + eventBytes;
    } else {
      current.push(event);
      currentBytes = candidateBytes;
    }
  }
  chunks.push({
    part: chunks.length,
    events: current,
    byteLength: currentBytes,
  });
  return chunks;
}
