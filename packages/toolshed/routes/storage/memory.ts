import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import * as FS from "@std/fs";
import * as Path from "@std/path";
import env from "@/env.ts";
import { resolveMemoryEngineStoreRootUrl } from "./memory-path.ts";
import { identity } from "@/lib/identity.ts";

const memoryAudience = identity.did();

// Session.open verification is shared with the standalone server. Toolshed
// requires the signed invocation to carry its audience DID and the challenge
// issued to this WebSocket connection.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

// Determine store URL: DB_PATH (single-file mode) or MEMORY_DIR (directory mode)
let storeUrl: URL;

if (env.DB_PATH) {
  // Single file mode: use explicit database file (must be absolute path)
  storeUrl = Path.toFileUrl(env.DB_PATH);
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  // Directory mode: use MEMORY_DIR (existing behavior)
  storeUrl = new URL(env.MEMORY_DIR);
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

export const memoryEngineStoreUrl = resolveMemoryEngineStoreRootUrl(storeUrl, {
  singleFileMode: Boolean(env.DB_PATH),
});
await FS.ensureDir(memoryEngineStoreUrl);

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
  sessionOpenAuth: {
    audience: memoryAudience,
  },
  acl: {
    mode: env.MEMORY_ACL_MODE,
    serviceDids: env.MEMORY_SERVICE_DIDS
      .split(",")
      .map((did) => did.trim())
      .filter((did) => did.length > 0),
  },
});
export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
