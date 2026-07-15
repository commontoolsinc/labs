import * as MemoryServer from "@commonfabric/memory/v2/server";
import { setRequestSchemaCasConfig } from "@commonfabric/memory/v2";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { MemoryWireAccountingAccumulator } from "@commonfabric/memory/v2/wire-accounting";
import { openSchemaStore } from "@commonfabric/memory/v2/schema-store";
import { resolveSchemaStoreUrl } from "@commonfabric/memory/v2/storage-path";
import * as FS from "@std/fs";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import { identity } from "@/lib/identity.ts";
import { isMemoryWireAccountingEnabled } from "./memory/memory-wire-accounting-policy.ts";

const memoryAudience = identity.did();

// Session.open verification is shared with the standalone server. Toolshed
// requires the signed invocation to carry its audience DID and the challenge
// issued to this WebSocket connection.
const authorizeSessionOpen = (
  message: Parameters<typeof verifySessionOpenAuthorization>[0],
  context: Parameters<typeof verifySessionOpenAuthorization>[1],
): Promise<string> => verifySessionOpenAuthorization(message, context);

// The store URL is derived in memory-store-url.ts (DB_PATH single-file mode or
// MEMORY_DIR directory mode). Log which mode is active for this server.
if (env.DB_PATH) {
  console.log(`Memory: Using single database file: ${env.DB_PATH}`);
} else {
  console.log(`Memory: Using directory mode: ${env.MEMORY_DIR}`);
}

export { memoryEngineStoreUrl };
await FS.ensureDir(memoryEngineStoreUrl);

// One store serves every space and every MemoryServer connection. The limits
// bound untrusted schema-definition ingestion while allowing normal schemas.
export const memorySchemaStore = await openSchemaStore({
  url: resolveSchemaStoreUrl(memoryEngineStoreUrl),
  maxSchemaBytes: 256 * 1024,
  maxEntries: 100_000,
  maxTotalBytes: 64 * 1024 * 1024,
});

export const memoryWireAccountingAccumulator = isMemoryWireAccountingEnabled({
    token: env.CF_MEMORY_WIRE_ACCOUNTING_TOKEN,
    env: env.ENV,
  })
  ? new MemoryWireAccountingAccumulator()
  : undefined;

if (env.CF_MEMORY_REQUEST_SCHEMA_CAS_ENABLED !== undefined) {
  setRequestSchemaCasConfig(env.CF_MEMORY_REQUEST_SCHEMA_CAS_ENABLED);
}

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  schemaStore: memorySchemaStore,
  wireAccountingObserver: memoryWireAccountingAccumulator,
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
let memorySchemaStoreClosed = false;
export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    try {
      await memoryServer.close();
    } finally {
      if (!memorySchemaStoreClosed) {
        memorySchemaStore.close();
        memorySchemaStoreClosed = true;
      }
    }
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
