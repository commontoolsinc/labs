/**
 * Building a zip, for tests that need a real one.
 *
 * Two paths in this repository read a zip and neither can be exercised
 * against a fixture nobody wrote: the artifact downloads a job's records
 * and metrics arrive in, and the sealed deliveries the record store
 * accepts. A zip built here is laid out the way an ordinary writer lays
 * one out, so what those readers are held to is the format rather than
 * this file's idea of it.
 */

// CRC32 of the deflate-format polynomial; zips carry one per member and a
// reader that trusts the central directory still deserves honest fixtures.
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

function u32le(value: number): number[] {
  return [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
}

/** Builds a single-member zip the way an ordinary writer lays one out. */
export async function buildZip(
  name: string,
  content: Uint8Array,
  method: 0 | 8,
): Promise<Uint8Array> {
  const nameBytes = new TextEncoder().encode(name);
  const data = method === 8 ? await deflateRaw(content) : content;
  const checksum = crc32(content);
  const local = [
    0x50,
    0x4b,
    0x03,
    0x04,
    ...u16le(20),
    ...u16le(0),
    ...u16le(method),
    ...u16le(0),
    ...u16le(0),
    ...u32le(checksum),
    ...u32le(data.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
  ];
  const localOffset = 0;
  const centralOffset = local.length + nameBytes.length + data.length;
  const central = [
    0x50,
    0x4b,
    0x01,
    0x02,
    ...u16le(20),
    ...u16le(20),
    ...u16le(0),
    ...u16le(method),
    ...u16le(0),
    ...u16le(0),
    ...u32le(checksum),
    ...u32le(data.length),
    ...u32le(content.length),
    ...u16le(nameBytes.length),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u16le(0),
    ...u32le(0),
    ...u32le(localOffset),
  ];
  const centralSize = central.length + nameBytes.length;
  const eocd = [
    0x50,
    0x4b,
    0x05,
    0x06,
    ...u16le(0),
    ...u16le(0),
    ...u16le(1),
    ...u16le(1),
    ...u32le(centralSize),
    ...u32le(centralOffset),
    ...u16le(0),
  ];
  return new Uint8Array([
    ...local,
    ...nameBytes,
    ...data,
    ...central,
    ...nameBytes,
    ...eocd,
  ]);
}
