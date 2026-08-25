import { CommandLedger } from "@commonfabric/agents-connector/command-ledger";
import { createAgentDriver } from "@commonfabric/agents-connector/create-driver";
import type {
  AgentDriver,
  AgentSourceConfig,
} from "@commonfabric/agents-connector/types";
import type { Runtime } from "@commonfabric/runner";
import {
  deployAgentSessionsDebugView,
  describeAgentFabricTarget,
} from "./debug-view.ts";
import {
  type AgentFabricRuntime,
  openAgentFabricRuntime,
} from "./fabric-runtime.ts";
import { AgentsHost } from "./host.ts";
import {
  AgentsHostProcessLock,
  defaultTargetProcessLockPath,
} from "./process-lock.ts";
import { defaultTargetLedgerPath } from "./target-state.ts";
import { abortable } from "./abort.ts";

function failureSummary(failures: unknown[]): string {
  return failures.map((error) =>
    error instanceof Error ? error.message : String(error)
  ).join("; ");
}

export interface StartAgentsHostOptions {
  apiUrl: string;
  identityPath: string;
  space: string;
  sources: AgentSourceConfig[];
  checkoutRoots?: string[];
  targetLockPath?: string;
  debugView?: boolean;
  acceptCommands?: boolean;
  signal?: AbortSignal;
  createDriver?: (config: AgentSourceConfig) => AgentDriver;
}

export class RunningAgentsHost {
  readonly host: AgentsHost;
  readonly runtime: Runtime;
  readonly spaceDid: string;
  readonly debugPieceId?: string;
  readonly initialSessionCount: number;
  readonly ledgerPath: string;
  readonly #processLocks: AgentsHostProcessLock[];
  #stopTask?: Promise<void>;

  constructor(options: {
    host: AgentsHost;
    fabric: AgentFabricRuntime;
    debugPieceId?: string;
    initialSessionCount: number;
    ledgerPath: string;
    processLocks: AgentsHostProcessLock[];
  }) {
    this.host = options.host;
    this.runtime = options.fabric.runtime;
    this.spaceDid = options.fabric.spaceDid;
    this.debugPieceId = options.debugPieceId;
    this.initialSessionCount = options.initialSessionCount;
    this.ledgerPath = options.ledgerPath;
    this.#processLocks = [...options.processLocks];
  }

  stop(reason = "requested"): Promise<void> {
    this.#stopTask ??= this.#stop(reason);
    return this.#stopTask;
  }

  async #stop(reason: string): Promise<void> {
    const failures: unknown[] = [];
    await this.host.stop(reason).catch((error) => failures.push(error));
    await this.runtime.settled(Infinity).catch((error) => failures.push(error));
    await this.runtime.storageManager.synced().catch((error) =>
      failures.push(error)
    );
    await this.runtime.dispose().catch((error) => failures.push(error));
    for (const lock of [...this.#processLocks].reverse()) {
      await lock.release().catch((error) => failures.push(error));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `agent host shutdown completed with failures: ${
          failureSummary(failures)
        }`,
      );
    }
  }
}

export async function startAgentsHost(
  options: StartAgentsHostOptions,
): Promise<RunningAgentsHost> {
  const processLocks: AgentsHostProcessLock[] = [];
  const startupTasks = new Set<Promise<unknown>>();
  let fabric: AgentFabricRuntime | undefined;
  let host: AgentsHost | undefined;
  let healthOwnership = false;
  const healthOwnershipStarted = Promise.withResolvers<void>();
  const trackStartup = <T>(task: Promise<T>): Promise<T> => {
    startupTasks.add(task);
    task.then(
      () => startupTasks.delete(task),
      () => startupTasks.delete(task),
    );
    return task;
  };
  const waitForStartup = <T>(task: Promise<T>): Promise<T> =>
    abortable(trackStartup(task), options.signal);
  try {
    options.signal?.throwIfAborted();
    fabric = await openAgentFabricRuntime(options);
    options.signal?.throwIfAborted();
    const targetLockPath = options.targetLockPath ??
      await defaultTargetProcessLockPath(options.apiUrl, fabric.spaceDid);
    options.signal?.throwIfAborted();
    processLocks.push(await AgentsHostProcessLock.acquire(targetLockPath));
    options.signal?.throwIfAborted();
    const ledgerPath = await defaultTargetLedgerPath(
      options.apiUrl,
      fabric.spaceDid,
    );
    options.signal?.throwIfAborted();
    processLocks.push(
      await AgentsHostProcessLock.acquire(`${ledgerPath}.lock`),
    );
    options.signal?.throwIfAborted();
    const debugPieceId = options.debugView === false
      ? undefined
      : await waitForStartup(
        deployAgentSessionsDebugView(
          fabric.manager,
          fabric.target,
          undefined,
          options.signal,
        ),
      );
    options.signal?.throwIfAborted();
    const ledger = await waitForStartup(
      CommandLedger.open(ledgerPath),
    );
    options.signal?.throwIfAborted();
    host = new AgentsHost({
      sources: options.sources,
      checkoutRoots: options.checkoutRoots,
      target: fabric.target,
      targetDescription: describeAgentFabricTarget(
        fabric.target,
        fabric.spaceDid,
        debugPieceId,
      ),
      ledger,
      createDriver: options.createDriver ?? createAgentDriver,
    });
    const hostStartTask = trackStartup(host.start({
      signal: options.signal,
      acceptCommands: options.acceptCommands,
      deferHealthUntilReady: true,
      onHealthOwnership: () => {
        healthOwnership = true;
        healthOwnershipStarted.resolve();
      },
    }));
    const beforeOwnership = await abortable(
      Promise.race([
        hostStartTask.then((sessionCount) => ({
          phase: "complete" as const,
          sessionCount,
        })),
        healthOwnershipStarted.promise.then(() => ({
          phase: "owned" as const,
        })),
      ]),
      options.signal,
    );
    const initialSessionCount = beforeOwnership.phase === "complete"
      ? beforeOwnership.sessionCount
      : await hostStartTask;
    return new RunningAgentsHost({
      host,
      fabric,
      debugPieceId,
      initialSessionCount,
      ledgerPath,
      processLocks,
    });
  } catch (error) {
    const cleanupFailures: unknown[] = [];
    const outstandingStartupTasks = [...startupTasks];
    if (options.signal?.aborted && !healthOwnership) {
      const stopTask = host?.stop("startup-cancelled", {
        flushPendingReceipts: false,
        interruptInFlight: true,
        publishHealth: false,
      });
      const startupResults = await Promise.allSettled(outstandingStartupTasks);
      for (const result of startupResults) {
        if (
          result.status === "rejected" &&
          result.reason !== options.signal.reason
        ) {
          cleanupFailures.push(result.reason);
        }
      }
      const stopResults = await Promise.allSettled(
        stopTask ? [stopTask] : [],
      );
      for (const result of stopResults) {
        if (result.status === "rejected") {
          cleanupFailures.push(result.reason);
        }
      }
      await fabric?.runtime.settled(Infinity).catch((settledError) => {
        cleanupFailures.push(settledError);
      });
      await fabric?.runtime.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
    } else {
      const stopReason = options.signal?.aborted
        ? "startup-owned-shutdown"
        : "startup-failed";
      await host?.stop(stopReason).catch((stopError) => {
        cleanupFailures.push(stopError);
      });
      await fabric?.runtime.settled(Infinity).catch((settledError) => {
        cleanupFailures.push(settledError);
      });
      await fabric?.runtime.dispose().catch((disposeError) => {
        cleanupFailures.push(disposeError);
      });
    }
    if (options.signal?.aborted && healthOwnership) {
      const startupResults = await Promise.allSettled(outstandingStartupTasks);
      for (const result of startupResults) {
        if (
          result.status === "rejected" &&
          result.reason !== options.signal.reason
        ) {
          cleanupFailures.push(result.reason);
        }
      }
    }
    for (const processLock of processLocks.reverse()) {
      await processLock.release().catch((lockError) => {
        cleanupFailures.push(lockError);
      });
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        `agent host startup and cleanup failed: ${
          failureSummary([error, ...cleanupFailures])
        }`,
      );
    }
    throw error;
  }
}
