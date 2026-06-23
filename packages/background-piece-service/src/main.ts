import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { BackgroundPieceService } from "./service.ts";
import { getIdentity } from "./utils.ts";
import { env } from "./env.ts";

const { timeout } = parseArgs(Deno.args, {
  string: [
    "timeout",
  ],
});

// 10 minute timeout
const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60000;

const workerTimeoutMs = (() => {
  if (timeout) {
    const parsed = parseInt(timeout, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_WORKER_TIMEOUT_MS;
})();

const identity = await getIdentity(env.IDENTITY, env.OPERATOR_PASS);
const runtime = new Runtime({
  apiUrl: new URL(env.API_URL),
  storageManager: StorageManager.open({
    as: identity,
    memoryHost: new URL(env.API_URL),
  }),
  experimental: {
    modernCellRep: env.EXPERIMENTAL_MODERN_CELL_REP,
    persistentSchedulerState: env.EXPERIMENTAL_PERSISTENT_SCHEDULER_STATE,
  },
});
const service = new BackgroundPieceService({
  identity,
  toolshedUrl: env.API_URL,
  runtime,
  workerTimeoutMs,
});

function shutdown(service: BackgroundPieceService) {
  return () => {
    service.stop().then(() => {
      Deno.exit(0);
    });
  };
}

Deno.addSignalListener("SIGINT", shutdown(service));
Deno.addSignalListener("SIGTERM", shutdown(service));

service.initialize().then(() => {
  console.log("Background Piece Service started successfully");
  console.log("Press Ctrl+C to stop");
});
