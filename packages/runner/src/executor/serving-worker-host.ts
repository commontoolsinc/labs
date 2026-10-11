// Starts the serving loop in a Worker of this process and keeps it running
// (serving-loop-worker.md): one `ServingPortBridge` per worker over the
// worker's own port, the service key and the host's options handed over as
// the first request, and a fresh worker, under a fresh lease-holder process
// component, when one dies.

import { type Identity, realmValueFromKeyPair } from "@commonfabric/identity";
import { adoptProcessInstanceId } from "@commonfabric/memory/v2/execution-lease";
import type { Server } from "@commonfabric/memory/v2/server";
import { getLogger } from "@commonfabric/utils/logger";
import { terminateWorker } from "@commonfabric/utils/worker-lifetime";
import type { ExperimentalOptions } from "../runtime.ts";
import type { MemorySpace } from "../storage/interface.ts";
import { type ExecutorHost, failureParkBackoffDelayMs } from "./host.ts";
import { ServingPortBridge } from "./serving-port-bridge.ts";
import type {
  LifecycleVerbDescriptor,
  ServingLoopDiagnostics,
  ServingWorkerInit,
} from "./serving-port-protocol.ts";
import type { SpaceServerPolicy } from "./space-server.ts";
import type { ServingLoopStats } from "./stats.ts";

const logger = getLogger("serving-worker-host", {
  enabled: true,
  level: "warn",
});

/**
 * The serving loop as whatever starts it hands it back, whichever thread
 * runs it: a toolshed's bootstrap, or the serving memory server tests build.
 */
export type ServingLoopHandle = {
  /** The loop's counters: the host's, or the last the worker posted. */
  stats(): ServingLoopStats | undefined;

  /**
   * What the loop's realm logged: this process's loggers where the loop
   * runs on its main thread, the worker's where it runs there.
   */
  diagnostics(): Promise<ServingLoopDiagnostics>;

  /** The host, when the loop runs on this thread; `undefined` in a worker. */
  readonly host: ExecutorHost | undefined;

  close(): Promise<void>;
};

export type { ServingLoopDiagnostics } from "./serving-port-protocol.ts";

export type ServingWorkerOptions = {
  server: Server;

  /** The service identity the worker's host serves as; its key crosses. */
  identity: Identity;

  /** The serving runtimes' patterns and compile base. */
  apiUrl: URL;

  /**
   * The worker's entry module. Default: the runner's own, which builds no
   * lifecycle verbs; a deployment names an entry of its own that calls
   * `serveFromPort()` with the verbs and fetch it uses.
   */
  workerModule?: URL;
  policy?: SpaceServerPolicy;
  ensureSpaceRoots?: boolean;
  experimental?: ExperimentalOptions;

  /** DIAGNOSTIC (tests): the worker's activation outcomes. */
  onActivationSettled?: (
    space: MemorySpace,
    outcome: "active" | "refused" | "failed",
  ) => void;

  /** DIAGNOSTIC (tests): the worker's parks. */
  onSpaceParked?: (space: MemorySpace, reason: string) => void;
};

/** One running worker and the bridge serving it. */
type WorkerGeneration = {
  worker: Worker;
  bridge: ServingPortBridge;
  ready: Promise<void>;
  lifetimeLock: string | undefined;
};

/**
 * The serving loop running in a Worker. `start()` spawns it; `ready`
 * settles once the worker's host serves; `close()` closes the host and the
 * worker. A worker that fails is replaced after the same backoff the host
 * applies to a space whose tenures keep failing, and the replacement adopts a
 * new lease-holder process component, so its commits never meet its
 * predecessor's under the engine's replay keying.
 */
export class ServingWorker {
  readonly #options: ServingWorkerOptions;
  #generation: WorkerGeneration | undefined;
  #failures = 0;
  #closed = false;

  constructor(options: ServingWorkerOptions) {
    this.#options = options;
    this.#generation = this.#spawn();
  }

  /** Settles once the current worker's host serves; rejects when it cannot. */
  get ready(): Promise<void> {
    return this.#generation?.ready ??
      Promise.reject(new Error("the serving worker is closed"));
  }

  /** The counters the worker last posted, or none before its first. */
  stats(): ServingLoopStats | undefined {
    return this.#generation?.bridge.stats();
  }

  /** The worker's counters as of now. */
  requestStats(): Promise<ServingLoopStats> {
    return this.#bridge().requestStats();
  }

  /** What the worker's realm logged, as of now. */
  diagnostics(): Promise<ServingLoopDiagnostics> {
    return this.#bridge().requestDiagnostics();
  }

  /** Runs a lifecycle verb on the worker's host. */
  runLifecycleVerb(
    space: MemorySpace,
    verb: LifecycleVerbDescriptor,
  ): Promise<unknown> {
    return this.#bridge().runLifecycleVerb(space, verb);
  }

  /** Closes the worker's host, then the worker; settles once both are gone. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const generation = this.#generation;
    this.#generation = undefined;
    if (generation === undefined) return;
    try {
      await generation.ready;
      await generation.bridge.closeHost();
    } catch (error) {
      logger.warn("worker-close-failed", () => [
        "closing the serving worker's host failed; terminating the worker",
        error,
      ]);
    } finally {
      generation.bridge.close();
      await terminateWorker(generation.worker, generation.lifetimeLock);
    }
  }

  #bridge(): ServingPortBridge {
    const generation = this.#generation;
    if (generation === undefined) {
      throw new Error("the serving worker is closed");
    }
    return generation.bridge;
  }

  #spawn(): WorkerGeneration {
    const { server, identity } = this.#options;
    // Both realms adopt the component before the worker writes a lease row
    // under it: the server's synchronous lease scan matches it from here.
    const processInstanceId = crypto.randomUUID();
    adoptProcessInstanceId(processInstanceId);
    const worker = new Worker(
      this.#options.workerModule ??
        new URL("./serving-worker.ts", import.meta.url),
      { type: "module", name: "serving-loop" },
    );
    const bridge = new ServingPortBridge({
      server,
      port: worker,
      onActivationSettled: (space, outcome) => {
        if (outcome === "active") this.#failures = 0;
        this.#options.onActivationSettled?.(space, outcome);
      },
      ...(this.#options.onSpaceParked === undefined
        ? {}
        : { onSpaceParked: this.#options.onSpaceParked }),
    });
    const generation: WorkerGeneration = {
      worker,
      bridge,
      lifetimeLock: undefined,
      ready: Promise.resolve(),
    };
    const init: ServingWorkerInit = {
      serviceKeyPair: realmValueFromKeyPair(identity.keyPair),
      processInstanceId,
      apiUrl: this.#options.apiUrl.href,
      policy: this.#options.policy,
      ensureSpaceRoots: this.#options.ensureSpaceRoots,
      experimental: this.#options.experimental,
    };
    generation.ready = bridge.init(init).then(({ lifetimeLock }) => {
      generation.lifetimeLock = lifetimeLock;
    });
    worker.onerror = (event) => {
      event.preventDefault();
      this.#onWorkerFailed(generation, event.message);
    };
    return generation;
  }

  /**
   * Replaces a worker that reported an error it did not handle. Its bridge
   * closes first, which closes the loopback connections its runtimes held, so
   * the server sees their sessions detach; the lease rows it wrote lapse on
   * their own.
   */
  #onWorkerFailed(generation: WorkerGeneration, message: string): void {
    if (this.#generation !== generation) return;
    this.#generation = undefined;
    generation.bridge.close();
    void terminateWorker(generation.worker, generation.lifetimeLock);
    if (this.#closed) return;
    this.#failures += 1;
    const delayMs = failureParkBackoffDelayMs(
      this.#failures,
      this.#options.policy,
    );
    logger.error(
      "worker-failed",
      `the serving worker failed (${message}); starting another in ${delayMs}ms`,
    );
    setTimeout(() => {
      if (this.#closed) return;
      this.#generation = this.#spawn();
    }, delayMs);
  }
}
