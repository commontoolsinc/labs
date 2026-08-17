export const DEFAULT_CHUNK_BYTES = 512 * 1024;

export interface EventChunk<T> {
  part: number;
  events: T[];
  byteLength: number;
}

const encoder = new TextEncoder();

export function encodedJsonBytes(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).byteLength;
}

function encodedJsonArrayElementBytes(value: unknown): number {
  return encodedJsonBytes([value]) - 2;
}

export function chunkEvents<T>(
  events: readonly T[],
  targetBytes = DEFAULT_CHUNK_BYTES,
): EventChunk<T>[] {
  if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0) {
    throw new Error("targetBytes must be a positive safe integer");
  }
  if (events.length === 0) {
    return [{ part: 0, events: [], byteLength: 2 }];
  }

  const chunks: EventChunk<T>[] = [];
  let current: T[] = [];
  let currentBytes = 2;
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
      currentBytes = 2 + eventBytes;
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
