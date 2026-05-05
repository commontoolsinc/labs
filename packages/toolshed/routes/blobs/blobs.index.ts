// Blob routes are intentionally unauthenticated for the MVP. Anyone can POST a
// blob into any space DID; content addressing prevents overwriting a different
// payload, but callers can inject blobs and consume storage. Anyone with a hash
// can GET the blob. Revisit this before any production exposure.
import { createRouter } from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import { isDID } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-bytes";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { decodeMemoryBoundary } from "@commonfabric/memory/v2";
import type { Context } from "@hono/hono";

const router = createRouter();

type BlobContents = {
  type: string;
  body: FabricBytes;
};

const DEFAULT_SUFFIX_BY_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

const VALID_SUFFIX = /^[A-Za-z0-9]{1,8}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asBlobContents = (value: unknown): BlobContents | undefined => {
  if (!isRecord(value) || typeof value.type !== "string") {
    return undefined;
  }
  if (value.body instanceof FabricBytes) {
    return { type: value.type, body: value.body };
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

const readRequestContents = async (request: Request) => {
  const source = await request.text();
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
  return asBlobContents(document?.value);
};

const upload = async (c: Context) => {
  const spaceDid = c.req.param("spaceDid");
  if (!isDID(spaceDid)) {
    return c.text("Invalid space DID", 400);
  }

  let contents: BlobContents | undefined;
  try {
    contents = await readRequestContents(c.req.raw);
  } catch {
    return c.text("Invalid blob payload", 400);
  }
  if (!contents) {
    return c.text("Invalid blob payload", 400);
  }

  const id = hashOf(contents).toString();
  const blobName = c.req.param("blobName") as string | undefined;
  const suffix = suffixFor(blobName, contents.type);
  const hash = id.slice("fid1:".length);
  await memoryServer.writeDocument(
    spaceDid,
    `cid:${id}`,
    contents,
  );

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

  const bytes = contents.body.slice();
  const body = new Uint8Array(bytes).buffer;
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contents.type,
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
});

export default router;
