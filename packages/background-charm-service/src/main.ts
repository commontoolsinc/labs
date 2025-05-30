import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commontools/runner";
import { BackgroundCharmService } from "./service.ts";
import { getIdentity, log } from "./utils.ts";
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
  storageUrl: env.TOOLSHED_API_URL,
  signer: identity,
});
const service = new BackgroundCharmService({
  identity,
  toolshedUrl: env.TOOLSHED_API_URL,
  runtime,
  workerTimeoutMs,
});

const shutdown = () => {
  // @ts-ignore: Object is possibly 'undefined'
  service.stop().then(() => {
    Deno.exit(0);
  });
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

service.initialize().then(() => {
  log("Background Charm Service started successfully");
  log("Press Ctrl+C to stop");
});
