import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import { MemoryWireAccountingAccumulator } from "@commonfabric/memory/v2/wire-accounting";
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

export const memoryWireAccountingAccumulator = isMemoryWireAccountingEnabled({
    token: env.CF_MEMORY_WIRE_ACCOUNTING_TOKEN,
    env: env.ENV,
  })
  ? new MemoryWireAccountingAccumulator()
  : undefined;

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
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
export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
