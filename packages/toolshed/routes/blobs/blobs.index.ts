import { hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { isDID } from "@commonfabric/identity/did";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import { isObjectNotArray } from "@commonfabric/utils/types";
import type { Context } from "@hono/hono";

// Blob routes are intentionally unauthenticated for the MVP. Anyone can POST a
// blob into any space DID; content addressing prevents overwriting a different
// payload, but callers can inject blobs and consume storage. Anyone with a hash
// can GET the blob. Revisit this before any production exposure.
import { createRouter } from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";

const router = createRouter();

/**
 * A blob as the store keeps it: its media type, its bytes, and, when it was
 * stored with one, the name of the file they came from. A blob's id is the hash
 * of the whole record, so the same bytes stored under two names, or under a
 * name and under none, are two blobs.
 */
type BlobContents = {
  type: string;
  body: FabricBytes;
  name?: string;
};

const DEFAULT_SUFFIX_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const MAX_BLOB_UPLOAD_BYTES = 10 * 1024 * 1024;
const SAFE_RESPONSE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const VALID_SUFFIX = /^[A-Za-z0-9]{1,8}$/;

class BlobPayloadTooLarge extends Error {
  constructor() {
    super("Blob payload too large");
    this.name = "BlobPayloadTooLarge";
  }
}

/**
 * Interprets a stored blob's body as bytes, or returns `undefined` when it is
 * not byte-shaped. The result is always freshly allocated and unshared, so
 * a caller may cede it to something that takes ownership of a buffer.
 */
const toByteArray = (value: unknown): Uint8Array | undefined => {
  // The copy is what makes the contract above hold for this arm, and so is what
  // lets the caller cede the result.
  // TODO(seefeldb): This arm may be unreachable. Every value reaching here is
  // decoded from a string, and binary in a string form arrives as a
  // `FabricBytes`, which the caller returns before asking this. Remove the arm
  // and its copy once that is confirmed.
  if (value instanceof Uint8Array) {
    return new Uint8Array(value);
  }
  if (
    Array.isArray(value) &&
    value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    return Uint8Array.from(value);
  }
  if (!isObjectNotArray(value)) {
    return undefined;
  }

  const entries = Object.entries(value)
    .map(([key, item]) => [Number(key), item] as const)
    .filter(([index, item]) =>
      Number.isInteger(index) && index >= 0 &&
      typeof item === "number" && Number.isInteger(item) &&
      item >= 0 && item <= 255
    )
    .toSorted(([left], [right]) => left - right);
  if (
    entries.length === 0 ||
    entries.some(([index], position) => index !== position)
  ) {
    return undefined;
  }
  return Uint8Array.from(entries.map(([, item]) => item as number));
};

/**
 * Indicates whether `name` may name the file a blob holds, which is so of any
 * non-empty string of well-formed Unicode, one with no unpaired surrogate. A
 * download only ever offers the name as one to save under, encoded so that no
 * character of it can reach the header as itself (see
 * {@link contentDispositionFor}), so the store holds a name to no rule of a
 * file system's. The encoding is what needs it well-formed.
 */
const isFileName = (name: unknown): name is string =>
  typeof name === "string" && name.length > 0 && name.isWellFormed();

/**
 * Returns `value` as blob contents if its body is a `FabricBytes`, the one form
 * an upload may take, and its `name`, if it has one, is a file name (see
 * {@link isFileName}), or `undefined` otherwise.
 */
const asBlobContents = (value: unknown): BlobContents | undefined => {
  if (
    !isObjectNotArray(value) || typeof value.type !== "string" ||
    !(value.body instanceof FabricBytes)
  ) {
    return undefined;
  }
  if (value.name === undefined) {
    return { type: value.type, body: value.body };
  }
  return isFileName(value.name)
    ? { type: value.type, body: value.body, name: value.name }
    : undefined;
};

/**
 * Like {@link asBlobContents}, except that the body may also be one of the
 * byte-shaped forms {@link toByteArray} reads, which a stored blob may hold,
 * and that a `name` which is not a file name is dropped rather than refused, so
 * that the blob is still served, under no name.
 */
const asStoredBlobContents = (value: unknown): BlobContents | undefined => {
  if (!isObjectNotArray(value) || typeof value.type !== "string") {
    return undefined;
  }
  const name = isFileName(value.name) ? { name: value.name } : {};
  if (value.body instanceof FabricBytes) {
    return { type: value.type, body: value.body, ...name };
  }
  const bytes = toByteArray(value.body);
  if (bytes) {
    return { type: value.type, body: new FabricBytes(bytes, true), ...name };
  }
  return undefined;
};

const parseBlobName = (
  blobName: string,
): { id: string; hash: string } | undefined => {
  const hashSegment = blobName.split(".")[0] ?? "";
  const id = hashSegment.startsWith("fid1:")
    ? hashSegment
    : `fid1:${hashSegment}`;
  const hash = id.slice("fid1:".length);
  if (hash.length === 0) {
    return undefined;
  }
  return { id, hash: id.slice("fid1:".length) };
};

const suffixFor = (blobName: string | undefined, type: string): string => {
  const extension = blobName?.includes(".")
    ? blobName.split(".").pop()
    : undefined;
  if (extension && VALID_SUFFIX.test(extension)) return extension;
  return DEFAULT_SUFFIX_BY_TYPE[type] ?? "bin";
};

const safeResponseType = (type: string): string =>
  SAFE_RESPONSE_TYPES.has(type) ? type : "application/octet-stream";

/**
 * Returns the `Content-Disposition` a blob of media type `type` whose file is
 * named `name` is served with: `inline` for a type served as itself, and
 * `attachment` for one served as `application/octet-stream`, which a browser
 * saves rather than shows. The name is given twice, as RFC 6266 describes: as
 * percent-encoded UTF-8 in `filename*`, and as an ASCII stand-in in `filename`,
 * with `_` for each character a quoted string can't carry, for a client that
 * reads only that one.
 */
const contentDispositionFor = (name: string, type: string): string => {
  const disposition = SAFE_RESPONSE_TYPES.has(type) ? "inline" : "attachment";
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/gu, "_");
  // `encodeURIComponent()` leaves `'`, `(`, `)` and `*` as they are, and RFC
  // 5987 admits none of them unencoded.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
};

const readLimitedText = async (request: Request): Promise<string> => {
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BLOB_UPLOAD_BYTES) {
    throw new BlobPayloadTooLarge();
  }

  const reader = request.body?.getReader();
  if (!reader) {
    return "";
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BLOB_UPLOAD_BYTES) {
      await reader.cancel();
      throw new BlobPayloadTooLarge();
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

const readRequestContents = async (request: Request) => {
  const source = await readLimitedText(request);
  if (!source) {
    return undefined;
  }
  return asBlobContents(decodeMemoryBoundary(source));
};

const loadBlobContents = async (
  spaceDid: string,
  id: string,
): Promise<BlobContents | undefined> => {
  const document = await memoryServer.readDocument(
    spaceDid,
    `cid:${id}`,
  );
  return asStoredBlobContents(document?.value);
};

const upload = async (c: Context) => {
  const spaceDid = c.req.param("spaceDid");
  if (!isDID(spaceDid)) {
    return c.text("Invalid space DID", 400);
  }

  let contents: BlobContents | undefined;
  try {
    contents = await readRequestContents(c.req.raw);
  } catch (error) {
    if (error instanceof BlobPayloadTooLarge) {
      return c.text("Blob payload too large", 413);
    }
    return c.text("Invalid blob payload", 400);
  }
  if (!contents) {
    return c.text("Invalid blob payload", 400);
  }

  const id = hashOf(contents).toString();
  const blobName = c.req.param("blobName") as string | undefined;
  const suffix = suffixFor(blobName ?? contents.name, contents.type);
  const hash = id.slice("fid1:".length);
  await memoryServer.writeDocument(spaceDid, `cid:${id}`, contents);

  return c.json({ id, url: `blobs/${hash}.${suffix}` }, 201);
};

router.post("/:spaceDid/blobs", upload);
router.post("/:spaceDid/blobs/:blobName", upload);

router.get("/:spaceDid/blobs/:blobName", async (c) => {
  const spaceDid = c.req.param("spaceDid");
  if (!isDID(spaceDid)) {
    return c.text("Invalid space DID", 400);
  }

  const parsed = parseBlobName(c.req.param("blobName"));
  if (!parsed) {
    return c.text("Invalid blob name", 400);
  }
  const { id } = parsed;
  const contents = await loadBlobContents(spaceDid, id);
  if (!contents) {
    return c.text("Blob not found", 404);
  }

  const body = contents.body.slice();
  const headers = new Headers({
    "Content-Type": safeResponseType(contents.type),
    "Cache-Control": "public, max-age=31536000, immutable",
  });
  if (contents.name !== undefined) {
    headers.set(
      "Content-Disposition",
      contentDispositionFor(contents.name, contents.type),
    );
  }
  return new Response(body, { status: 200, headers });
});

export default router;
