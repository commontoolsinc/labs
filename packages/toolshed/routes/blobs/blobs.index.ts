// Blob routes are intentionally unauthenticated for the MVP. Anyone can POST a
// blob into any space DID; content addressing prevents overwriting a different
// payload, but callers can inject blobs and consume storage. Anyone with a hash
// can GET the blob. Revisit this before any production exposure.
import { createRouter } from "@/lib/create-app.ts";
import { memoryServer } from "@/routes/storage/memory.ts";
import { isDID } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-bytes";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  getDataModelConfig,
  resetDataModelConfig,
  setDataModelConfig,
} from "@commonfabric/data-model/fabric-value";
import {
  decodeMemoryBoundary,
  encodeMemoryBoundary,
} from "@commonfabric/memory/v2";
import {
  getJsonEncodingConfig,
  resetJsonEncodingConfig,
  setJsonEncodingConfig,
} from "@commonfabric/data-model/json-encoding";

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

const withUnifiedJsonEncoding = async <T>(
  fn: () => Promise<T> | T,
): Promise<T> => {
  const previous = getJsonEncodingConfig();
  const previousDataModel = getDataModelConfig();
  setDataModelConfig(true);
  setJsonEncodingConfig(true);
  try {
    return await fn();
  } finally {
    if (previousDataModel) {
      setDataModelConfig(true);
    } else {
      resetDataModelConfig();
    }
    if (previous) {
      setJsonEncodingConfig(true);
    } else {
      resetJsonEncodingConfig();
    }
  }
};

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

const parseBlobName = (blobName: string): { id: string; hash: string } => {
  const hash = blobName.split(".")[0] ?? "";
  const id = hash.startsWith("fid1:") ? hash : `fid1:${hash}`;
  return { id, hash: id.slice("fid1:".length) };
};

const suffixFor = (blobName: string | undefined, type: string): string => {
  const extension = blobName?.includes(".")
    ? blobName.split(".").pop()
    : undefined;
  if (extension) return extension;
  return DEFAULT_SUFFIX_BY_TYPE[type] ?? "bin";
};

const readRequestContents = async (request: Request) => {
  const source = await request.text();
  if (!source) {
    return undefined;
  }
  return await withUnifiedJsonEncoding(() =>
    asBlobContents(decodeMemoryBoundary(source))
  );
};

const loadBlobContents = async (
  spaceDid: string,
  id: string,
): Promise<BlobContents | undefined> => {
  const document = await memoryServer.readDocument(
    spaceDid,
    `cid:${id}`,
    { unifiedJsonEncoding: true },
  );
  return asBlobContents(document?.value);
};

const upload = async (c: any) => {
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
    { unifiedJsonEncoding: true },
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

  const { id } = parseBlobName(c.req.param("blobName"));
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

export const encodeBlobContents = (contents: BlobContents): string =>
  encodeMemoryBoundary(contents);

export default router;
