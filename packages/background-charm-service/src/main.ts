import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commontools/runner";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { BackgroundCharmService } from "./service.ts";
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
    address: new URL("/api/storage/memory", env.API_URL),
  }),
  experimental: {
    richStorableValues: env.EXPERIMENTAL_RICH_STORABLE_VALUES,
    storableProtocol: env.EXPERIMENTAL_STORABLE_PROTOCOL,
    unifiedJsonEncoding: env.EXPERIMENTAL_UNIFIED_JSON_ENCODING,
  },
});
const service = new BackgroundCharmService({
  identity,
  toolshedUrl: env.API_URL,
  runtime,
  workerTimeoutMs,
});

function shutdown(service: BackgroundCharmService) {
  return () => {
    service.stop().then(() => {
      Deno.exit(0);
    });
  };
}

Deno.addSignalListener("SIGINT", shutdown(service));
Deno.addSignalListener("SIGTERM", shutdown(service));

service.initialize().then(() => {
  console.log("Background Charm Service started successfully");
  console.log("Press Ctrl+C to stop");
});
