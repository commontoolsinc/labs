import { parseArgs } from "@std/cli/parse-args";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { BackgroundPieceService } from "./service.ts";
import { getIdentity } from "./utils.ts";
import { env, type EnvVars } from "./env.ts";
import { getTracer, initOpenTelemetry } from "./otel.ts";
import type { Identity } from "@commonfabric/identity";

// 10 minute timeout
export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60000;

type ServiceLike = Pick<BackgroundPieceService, "initialize" | "stop">;

export interface MainDependencies {
  env: EnvVars;
  getIdentity: typeof getIdentity;
  createRuntime: (env: EnvVars, identity: Identity) => Runtime;
  createService: (
    options: ConstructorParameters<typeof BackgroundPieceService>[0],
  ) => ServiceLike;
  addSignalListener: typeof Deno.addSignalListener;
  exit: typeof Deno.exit;
  log: typeof console.log;
}

export function parseWorkerTimeout(args: string[]): number {
  const { timeout } = parseArgs(args, {
    string: [
      "timeout",
    ],
  });

  if (timeout) {
    const parsed = parseInt(timeout, 10);
    if (!isNaN(parsed)) {
      return parsed;
    }
  }
  return DEFAULT_WORKER_TIMEOUT_MS;
}

export function createRuntime(env: EnvVars, identity: Identity): Runtime {
  return new Runtime({
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
}

export function shutdown(
  service: Pick<BackgroundPieceService, "stop">,
  exit: typeof Deno.exit = Deno.exit,
) {
  return () => {
    service.stop().then(() => {
      exit(0);
    });
  };
}

export async function startBackgroundPieceService(
  args: string[] = Deno.args,
  dependencies: MainDependencies = {
    env,
    getIdentity,
    createRuntime,
    createService: (options) => new BackgroundPieceService(options),
    addSignalListener: Deno.addSignalListener,
    exit: Deno.exit,
    log: console.log,
  },
): Promise<ServiceLike> {
  // Set up tracing before doing any work so spans (incl. runner-library spans)
  // are exported to the local OTel collector -> SigNoz. No-op unless OTEL_ENABLED.
  await initOpenTelemetry();

  const workerTimeoutMs = parseWorkerTimeout(args);
  const identity = await dependencies.getIdentity(
    dependencies.env.IDENTITY,
    dependencies.env.OPERATOR_PASS,
  );
  const runtime = dependencies.createRuntime(dependencies.env, identity);
  const service = dependencies.createService({
    identity,
    toolshedUrl: dependencies.env.API_URL,
    runtime,
    workerTimeoutMs,
  });

  dependencies.addSignalListener(
    "SIGINT",
    shutdown(service, dependencies.exit),
  );
  dependencies.addSignalListener(
    "SIGTERM",
    shutdown(service, dependencies.exit),
  );

  await getTracer().startActiveSpan(
    "bg-piece-service.startup",
    async (span) => {
      try {
        await service.initialize();
      } finally {
        span.end();
      }
    },
  );
  dependencies.log("Background Piece Service started successfully");
  dependencies.log("Press Ctrl+C to stop");
  return service;
}

export async function runIfMain(
  isMain = import.meta.main,
  start: () => Promise<unknown> = startBackgroundPieceService,
): Promise<void> {
  if (isMain) await start();
}

await runIfMain();
