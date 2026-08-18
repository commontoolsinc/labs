import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { readZip } from "./test-records-zip.ts";

// CRC32 of the deflate-format polynomial; zips carry one per member and a
// reader that trusts the central directory still deserves honest fixtures.
function crc32(bytes: Uint8Array): number {
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
async function buildZip(
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

describe("test-records-zip", () => {
  describe("readZip()", () => {
    it("returns a stored member byte for byte", async () => {
      const content = new TextEncoder().encode('{"v":1,"ct":"abc"}');
      const zip = await buildZip("delivery.sealed", content, 0);
      const members = await readZip(zip);
      expect(members.length).toBe(1);
      expect(members[0]!.name).toBe("delivery.sealed");
      expect(members[0]!.data).toEqual(content);
    });

    it("inflates a deflated member", async () => {
      const content = new TextEncoder().encode(
        "repeated repeated repeated repeated repeated content",
      );
      const zip = await buildZip("delivery.sealed", content, 8);
      const members = await readZip(zip);
      expect(members[0]!.data).toEqual(content);
    });

    it("throws for bytes with no central directory", async () => {
      await expect(readZip(new Uint8Array(100))).rejects.toThrow(
        "no central directory",
      );
    });

    it("reads past a comment containing the directory signature", async () => {
      const content = new TextEncoder().encode("commented");
      const zip = await buildZip("delivery.sealed", content, 0);
      // An archive comment whose first bytes mimic the record signature;
      // its fake comment-length field does not reach the end of the
      // archive, so the scan must continue to the real record.
      const comment = new Uint8Array(22).fill(0xaa);
      comment.set([0x50, 0x4b, 0x05, 0x06], 0);
      const commented = new Uint8Array(zip.length + comment.length);
      commented.set(zip, 0);
      commented.set(comment, zip.length);
      commented[zip.length - 2] = comment.length;
      commented[zip.length - 1] = 0;
      const members = await readZip(commented);
      expect(members.length).toBe(1);
      expect(members[0]!.data).toEqual(content);
    });
  });
});
