/**
 * Minimal zip reading for workflow-artifact downloads: the GitHub API
 * serves every artifact as a zip archive, and the key tool needs the one
 * file inside. The central directory is the authority — streaming writers
 * leave local-header sizes zero — and members are either stored or
 * deflated, inflated here with the web-standard DecompressionStream.
 */

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! | (bytes[offset + 1]! << 8) |
    (bytes[offset + 2]! << 16)) + (bytes[offset + 3]! * 0x1000000);
}

export interface ZipMember {
  name: string;
  data: Uint8Array;
}

async function inflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart]).stream().pipeThrough(
    new DecompressionStream("deflate-raw"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Reads every member of a zip archive. */
export async function readZip(bytes: Uint8Array): Promise<ZipMember[]> {
  // Find the end-of-central-directory record from the tail; its comment can
  // push it up to 65535 bytes before the end. A candidate counts only when
  // its comment-length field reaches exactly the end of the archive, so
  // the signature bytes appearing inside a comment are not mistaken for
  // the record itself.
  let eocd = -1;
  const earliest = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= earliest; i--) {
    if (
      bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 0x05 &&
      bytes[i + 3] === 0x06 && i + 22 + u16(bytes, i + 20) === bytes.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip archive: no central directory");
  const entryCount = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const members: ZipMember[] = [];
  const decoder = new TextDecoder();
  for (let entry = 0; entry < entryCount; entry++) {
    if (
      !(bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b &&
        bytes[offset + 2] === 0x01 && bytes[offset + 3] === 0x02)
    ) {
      throw new Error("malformed zip: central directory entry expected");
    }
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const name = decoder.decode(
      bytes.subarray(offset + 46, offset + 46 + nameLength),
    );
    // The local header's own name and extra fields may differ in length
    // from the central directory's; read them from the local header.
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) {
      data = compressed.slice();
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      throw new Error(`unsupported zip compression method ${method}`);
    }
    if (!name.endsWith("/")) {
      members.push({ name, data });
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return members;
}
