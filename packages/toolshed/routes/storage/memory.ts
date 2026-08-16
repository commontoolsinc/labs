import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import * as FS from "@std/fs";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import { identity } from "@/lib/identity.ts";
import {
  memoryServiceDidsFor,
  serverExecutionEnabledFromEnv,
} from "@/lib/server-execution-flag.ts";

const memoryAudience = identity.did();

// Server-execution v2 (Phase 7): under the flag this process's own identity
// is a memory service principal — the serving loop's loopback sessions read
// foreign co-hosted spaces as it (see memoryServiceDidsFor, which also
// states honestly what else that grants: implicit OWNER everywhere for the
// process identity's ordinary session traffic; the narrower read-only
// shape is FLAGGED for the owner, verification-coverage.md OW31). OFF the
// flag — the landed default — the operator-configured list is used
// verbatim.
const serverExecutionOn = serverExecutionEnabledFromEnv(Deno.env.get);
const memoryServiceDids = memoryServiceDidsFor({
  configured: env.MEMORY_SERVICE_DIDS
    .split(",")
    .map((did) => did.trim())
    .filter((did) => did.length > 0),
  processIdentityDid: identity.did(),
  serverExecution: serverExecutionOn,
});
if (serverExecutionOn) {
  console.log(
    `Memory: server-execution v2 ON — process identity ${identity.did()} ` +
      "is a memory service principal (loopback serving reads; " +
      "docs/specs/server-side-execution/protocol.md §2b)",
  );
}

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

export const memoryServer = new MemoryServer.Server({
  store: memoryEngineStoreUrl,
  authorizeSessionOpen,
  sessionOpenAuth: {
    audience: memoryAudience,
  },
  acl: {
    mode: env.MEMORY_ACL_MODE,
    serviceDids: memoryServiceDids,
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
