/**
 * Entry point of the service binary: reads the environment, builds the runtime
 * and the service, wires shutdown to `SIGINT` and `SIGTERM`, and starts it.
 * Everything the entry point reaches outside itself is injectable, so a test
 * can drive it without a process, a network, or a signal.
 */

import { parseArgs } from "@std/cli/parse-args";

import type { Identity } from "@commonfabric/identity";
import {
  type EnvReader,
  experimentalOptionsFromEnv,
  Runtime,
  runtimePresets,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { SpanStatusCode } from "@opentelemetry/api";

import { env, type EnvVars } from "./env.ts";
import { getTracer, initOpenTelemetry, shutdownOpenTelemetry } from "./otel.ts";
import { BackgroundPieceService } from "./service.ts";
import { getIdentity } from "./utils.ts";

/**
 * How long a worker request may run before it fails, absent a `--timeout`
 * argument: ten minutes.
 */
export const DEFAULT_WORKER_TIMEOUT_MS = 10 * 60000;

/**
 * The part of a `BackgroundPieceService` the entry point drives, so a test can
 * stand one in.
 */
type ServiceLike = Pick<BackgroundPieceService, "initialize" | "stop">;

/** Everything the entry point reaches outside itself, each one replaceable. */
export interface MainDependencies {
  /** The parsed environment. */
  env: EnvVars;

  /** Derives the identity the service runs as. */
  getIdentity: typeof getIdentity;

  /** Constructs the runtime the service reads the registry through. */
  createRuntime: (env: EnvVars, identity: Identity) => Runtime;

  /** Constructs the service. */
  createService: (
    options: ConstructorParameters<typeof BackgroundPieceService>[0],
  ) => ServiceLike;

  /** Registers a handler for a process signal. */
  addSignalListener: typeof Deno.addSignalListener;

  /** Exits the process. */
  exit: typeof Deno.exit;

  /** Writes a line of startup output. */
  log: typeof console.log;
}

/**
 * Returns the worker timeout `args` names with `--timeout`, in milliseconds,
 * or the default when the argument is absent or not a number.
 */
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

/**
 * Constructs the service's runtime: a production-server runtime talking to
 * the toolshed `env` names, running as `identity`. The experimental flags are
 * read from the environment through the runner's own mapping, so that this
 * service, toolshed, and the CLI resolve them alike; the service forwards
 * this runtime's resolved flags to every worker it starts.
 */
export function createRuntime(
  env: EnvVars,
  identity: Identity,
  /**
   * Reads one environment variable; injectable for tests, like `loadEnv()`'s
   * `source`. The EXPERIMENTAL_* flags are read here rather than in
   * `loadEnv()`, since `EnvVars` does not declare them.
   */
  readEnv: EnvReader = (key) => Deno.env.get(key),
): Runtime {
  // Shared first-party posture. This runtime's experimental flags are the
  // single source the service forwards to its workers (service.ts).
  return new Runtime(runtimePresets.productionServer({
    apiUrl: new URL(env.API_URL),
    storageManager: StorageManager.open({
      as: identity,
      memoryHost: new URL(env.API_URL),
    }),
    experimental: experimentalOptionsFromEnv(readEnv),
  }));
}

/**
 * Returns the signal handler that stops `service`, flushes telemetry, and
 * exits the process through `exit`, exiting even when the stop or the flush
 * fails.
 */
export function shutdown(
  service: Pick<BackgroundPieceService, "stop">,
  exit: typeof Deno.exit = Deno.exit,
) {
  return () =>
    service.stop()
      // Flush buffered spans before exiting so shutdown telemetry isn't dropped.
      .then(() => shutdownOpenTelemetry())
      .catch((error) => {
        // A failed stop()/flush (e.g. the collector is unreachable, which makes
        // forceFlush reject) must not strand the process. Log and still exit so
        // the signal handler always terminates cleanly instead of hanging until
        // the orchestrator SIGKILLs us.
        console.error("Error during shutdown:", error);
      })
      .finally(() => {
        exit(0);
      });
}

/**
 * Starts the service: initializes telemetry, derives the identity, builds the
 * runtime and the service, registers the shutdown handler for `SIGINT` and
 * `SIGTERM`, and initializes the service under a startup span. Returns the
 * running service.
 *
 * @throws Whatever the service's `initialize()` throws, after recording it
 *   on the span.
 */
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
  // Use the injected env so tests/alternate callers control telemetry config.
  await initOpenTelemetry(dependencies.env);

  const workerTimeoutMs = parseWorkerTimeout(args);
  const identity = await dependencies.getIdentity(
    dependencies.env.IDENTITY,
    dependencies.env.OPERATOR_PASS,
  );
  const runtime = dependencies.createRuntime(dependencies.env, identity);
  // The server-execution v2 posture this service RESOLVED (the
  // productionServer preset: an explicit EXPERIMENTAL_SERVER_EXECUTION,
  // else the first-party default). Logged at
  // startup so the deployed-topology posture gate, and an operator reading
  // service logs, can verify the arm the binary actually runs — the role
  // /api/meta's `experimental` plays for toolshed; this binary has no HTTP
  // surface, so the log line is its posture probe.
  // (Optional-chained because the unit suite injects shape-only fake
  // runtimes; the real construction always carries `experimental`.)
  dependencies.log(
    `Background Piece Service server-execution posture: ${
      runtime.experimental?.serverExecution === true ? "ON" : "OFF"
    }`,
  );
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
      } catch (error) {
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
  dependencies.log("Background Piece Service started successfully");
  dependencies.log("Press Ctrl+C to stop");
  return service;
}

/**
 * Runs `start()` when this module is the program's main module, which is how
 * the binary starts; a test passes `isMain` explicitly.
 */
export async function runIfMain(
  isMain = import.meta.main,
  start: () => Promise<unknown> = startBackgroundPieceService,
): Promise<void> {
  if (isMain) await start();
}

await runIfMain();
