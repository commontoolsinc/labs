import * as MemoryServer from "@commonfabric/memory/v2/server";
import { verifySessionOpenAuthorization } from "@commonfabric/memory/v2/session-open-auth";
import * as FS from "@std/fs";
import env from "@/env.ts";
import { memoryEngineStoreUrl } from "./memory-store-url.ts";
import { identity } from "@/lib/identity.ts";
import type { Runtime } from "@commonfabric/runner";
import {
  type ExecutionPoolMetricsSnapshot,
  SharedExecutionPool,
} from "@commonfabric/runner/executor";
import { DenoSpaceExecutorFactory } from "@commonfabric/runner/executor/deno";
import {
  setServerExecutionControlMetricsProvider,
  setServerExecutionFeedMetricsProvider,
  setServerExecutionPoolMetricsProvider,
} from "@/lib/server-execution-observability.ts";

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
let executionPool: SharedExecutionPool | null = null;

export function serverExecutionPoolMetrics():
  | ExecutionPoolMetricsSnapshot
  | null {
  return executionPool?.metrics() ?? null;
}

setServerExecutionPoolMetricsProvider(serverExecutionPoolMetrics);
setServerExecutionControlMetricsProvider(() => memoryServer.executionStats);
setServerExecutionFeedMetricsProvider(() => memoryServer.feedStats);

/** Start client-demand execution after runtime flags are installed, but before
 * the HTTP server accepts connections. */
export function startServerExecutionPool(runtime: Runtime): void {
  if (
    executionPool !== null ||
    runtime.experimental.serverPrimaryExecution !== true
  ) return;
  executionPool = new SharedExecutionPool({
    control: memoryServer,
    factory: new DenoSpaceExecutorFactory({
      server: memoryServer,
      apiUrl: new URL(env.API_URL),
      patternApiUrl: new URL(env.API_URL),
      experimental: runtime.experimental,
      // F1 claim-coverage counters are the evidence channel (surfaced under
      // /api/health/stats serverExecutionControl); the debug logs remain for
      // per-candidate detail but are no longer what a measurement greps.
      onCandidateClaim: (candidate) => {
        memoryServer.recordExecutionCandidateClaimReady(candidate.claimKey);
        console.debug(
          "Memory: Server execution candidate claim-ready",
          candidate.claimKey,
        );
      },
      onCandidateDiagnostic: (diagnostic) => {
        memoryServer.recordExecutionCandidateUnserved(diagnostic);
        console.debug(
          "Memory: Server execution candidate unserved",
          diagnostic,
        );
      },
      onWriterDiscovery: (discovery) =>
        console.debug(
          "Memory: Server execution writer discovery",
          discovery,
        ),
    }),
  });
  executionPool.start();
  console.log("Memory: Server execution pool started");
}

export const memory = {
  async close(): Promise<
    { ok: Record<PropertyKey, never> } | { error: unknown }
  > {
    await executionPool?.close();
    executionPool = null;
    await memoryServer.close();
    return { ok: {} };
  },
};
console.log("Memory: Provider initialized successfully");
