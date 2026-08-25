import {
  type AgentDriver,
  type AgentSessionCommandReceipt,
  type AgentSourceConfig,
  type CollectedSource,
  collectSource,
  type CommandTarget,
  type CommandTaskFailure,
  CommandWorker,
  type DriverCapabilities,
} from "@commonfabric/agents-connector";
import type { CommandLedger } from "@commonfabric/agents-connector/command-ledger";
import { abortable } from "./abort.ts";
import { discoverGitCheckoutDirectories } from "./checkout-discovery.ts";

export type AgentsHostStatus =
  | "created"
  | "starting"
  | "syncing"
  | "ready"
  | "degraded"
  | "failed"
  | "stopping"
  | "stopped";

export type SourceStatus =
  | "disabled"
  | "pending"
  | "starting"
  | "collecting"
  | "ready"
  | "degraded"
  | "failed"
  | "stopped";

export interface AgentsHostActivity {
  id: string;
  at: string;
  type: string;
  message: string;
  sourceId?: string;
  details?: Record<string, unknown>;
}

export interface AgentsHostSourceHealth {
  id: string;
  driver: AgentSourceConfig["driver"];
  enabled: boolean;
  status: SourceStatus;
  capabilities: Partial<DriverCapabilities>;
  sessionCount?: number;
  complete?: boolean;
  lastCollectionStartedAt?: string;
  lastCollectionCompletedAt?: string;
  errors: Array<{ nativeSessionId?: string; message: string }>;
  lastError?: string;
}

export interface AgentsHostSyncHealth {
  reason: string;
  status: "running" | "complete" | "failed";
  startedAt: string;
  completedAt?: string;
  sessionCount?: number;
  error?: string;
}

export interface AgentsHostTargetDescription {
  spaceDid: string;
  debugPieceId?: string;
  cells: {
    recentIndex: string;
    allIndex: string;
    health: string;
    commands: string;
    receipts: string;
  };
}

export interface AgentsHostHealth {
  service: "agents-host";
  formatVersion: 1;
  status: AgentsHostStatus;
  startedAt: string;
  updatedAt: string;
  target: AgentsHostTargetDescription;
  commandProcessing: {
    accepting: boolean;
    pendingReceiptPublications: number;
    failedCommands: number;
    lastError?: string;
  };
  sync?: AgentsHostSyncHealth;
  sources: AgentsHostSourceHealth[];
  activity: AgentsHostActivity[];
}

export interface AgentsHostTarget extends CommandTarget {
  beginSessionObservation(): number;
  publish(
    collected: CollectedSource[],
    options?: {
      observationSequence?: number;
      checkoutDirectories?: string[];
      signal?: AbortSignal;
      onCommit?: () => void;
    },
  ): Promise<number>;
  validateCheckout(
    directory: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
  publishHealth(value: Record<string, unknown>): Promise<void>;
  subscribeCommands(
    callback: (commands: unknown[]) => void,
  ): Promise<() => void>;
  readReceipt(
    commandId: string,
  ): Promise<AgentSessionCommandReceipt | undefined>;
}

export interface AgentsHostOptions {
  sources: AgentSourceConfig[];
  target: AgentsHostTarget;
  targetDescription: AgentsHostTargetDescription;
  ledger: CommandLedger;
  createDriver: (config: AgentSourceConfig) => AgentDriver;
  clock?: () => Date;
  logger?: Pick<Console, "error" | "info">;
  activityLimit?: number;
  checkoutRoots?: string[];
  discoverCheckouts?: typeof discoverGitCheckoutDirectories;
}

export interface AgentsHostStopOptions {
  flushPendingReceipts?: boolean;
  interruptInFlight?: boolean;
  publishHealth?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class AgentsHost {
  readonly #configs: AgentSourceConfig[];
  readonly #target: AgentsHostTarget;
  readonly #targetDescription: AgentsHostTargetDescription;
  readonly #ledger: CommandLedger;
  readonly #createDriver: AgentsHostOptions["createDriver"];
  readonly #clock: () => Date;
  readonly #logger: Pick<Console, "error" | "info">;
  readonly #activityLimit: number;
  readonly #checkoutRoots: string[];
  readonly #discoverCheckouts: typeof discoverGitCheckoutDirectories;
  readonly #drivers = new Map<string, AgentDriver>();
  readonly #cleanupDrivers = new Map<string, AgentDriver>();
  readonly #sources = new Map<string, AgentsHostSourceHealth>();
  readonly #activity: AgentsHostActivity[] = [];
  readonly #commandFailures = new Map<string, string>();
  readonly #startedAt: string;
  #updatedAt: string;
  #status: AgentsHostStatus = "created";
  #lastSync?: AgentsHostSyncHealth;
  #commandWorker?: CommandWorker;
  #cancelCommands?: () => void;
  #acceptingCommands = false;
  #started = false;
  #stopping = false;
  #stopped = false;
  #healthPublicationEnabled = true;
  #activitySequence = 0;
  #syncTail: Promise<void> = Promise.resolve();
  #healthTail: Promise<void> = Promise.resolve();
  #recoveryTask: Promise<void> = Promise.resolve();
  #subscriptionTask: Promise<void> = Promise.resolve();
  readonly #driverStopTasks = new Map<
    string,
    { driver: AgentDriver; task: Promise<void> }
  >();
  #stopTask?: Promise<void>;

  constructor(options: AgentsHostOptions) {
    this.#configs = options.sources.map((source) => structuredClone(source));
    this.#target = options.target;
    this.#targetDescription = structuredClone(options.targetDescription);
    this.#ledger = options.ledger;
    this.#createDriver = options.createDriver;
    this.#clock = options.clock ?? (() => new Date());
    this.#logger = options.logger ?? console;
    this.#activityLimit = options.activityLimit ?? 200;
    this.#checkoutRoots = [...(options.checkoutRoots ?? [])];
    this.#discoverCheckouts = options.discoverCheckouts ??
      discoverGitCheckoutDirectories;
    if (!Number.isSafeInteger(this.#activityLimit) || this.#activityLimit < 1) {
      throw new Error("activityLimit must be a positive safe integer");
    }
    this.#startedAt = this.#now();
    this.#updatedAt = this.#startedAt;
    for (const source of this.#configs) {
      this.#sources.set(source.id, {
        id: source.id,
        driver: source.driver,
        enabled: source.enabled,
        status: source.enabled ? "pending" : "disabled",
        capabilities: {},
        errors: [],
      });
    }
  }

  health(): AgentsHostHealth {
    return structuredClone({
      service: "agents-host",
      formatVersion: 1,
      status: this.#status,
      startedAt: this.#startedAt,
      updatedAt: this.#updatedAt,
      target: this.#targetDescription,
      commandProcessing: {
        accepting: this.#acceptingCommands,
        pendingReceiptPublications: this.#ledger.pendingPublicationCount(),
        failedCommands: this.#commandFailures.size,
        ...(this.#commandFailures.size > 0
          ? { lastError: [...this.#commandFailures.values()].at(-1) }
          : {}),
      },
      ...(this.#lastSync ? { sync: this.#lastSync } : {}),
      sources: [...this.#sources.values()],
      activity: this.#activity,
    });
  }

  async start(options: {
    signal?: AbortSignal;
    acceptCommands?: boolean;
    deferHealthUntilReady?: boolean;
    onHealthOwnership?: () => void;
  } = {}): Promise<number> {
    if (this.#started || this.#stopping || this.#stopped) {
      throw new Error("agent host has already been started");
    }
    options.signal?.throwIfAborted();
    if (options.onHealthOwnership && !options.deferHealthUntilReady) {
      throw new Error(
        "onHealthOwnership requires deferHealthUntilReady",
      );
    }
    this.#started = true;
    const deferHealthUntilReady = options.deferHealthUntilReady ?? false;
    if (deferHealthUntilReady) this.#healthPublicationEnabled = false;
    this.#setStatus("starting");
    this.#recordActivity("host-starting", "Host startup began");
    for (const source of this.#configs.filter((source) => source.enabled)) {
      const state = this.#sources.get(source.id)!;
      state.status = "starting";
      this.#recordActivity(
        "source-starting",
        "Source startup began",
        { driver: source.driver },
        source.id,
      );
    }
    await this.#publishHealth(options.signal);
    options.signal?.throwIfAborted();

    const startResults = await Promise.allSettled(
      this.#configs.filter((source) => source.enabled).map((source) =>
        this.#startSource(source, options.signal)
      ),
    );
    options.signal?.throwIfAborted();
    const startErrors = startResults.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (startErrors.length > 0) {
      this.#setStatus("failed");
      this.#recordActivity(
        "host-failed",
        "A source could not complete startup safely",
      );
      await this.#publishHealth(options.signal).catch((error) => {
        startErrors.push(error);
      });
      throw new AggregateError(
        startErrors,
        "one or more sources did not complete startup safely",
      );
    }
    options.signal?.throwIfAborted();

    if (this.#drivers.size === 0) {
      this.#setStatus("failed");
      this.#recordActivity(
        "host-failed",
        "No configured source started successfully",
      );
      await this.#publishHealth(options.signal);
      throw new Error("no configured agent source started successfully");
    }

    const observedTarget: CommandTarget = {
      publishReceipt: (receipt) => this.#publishReceipt(receipt),
      refreshSession: (driver, nativeSessionId) =>
        this.#refreshSession(driver, nativeSessionId),
      readReceipt: (commandId) => this.#target.readReceipt(commandId),
    };
    this.#commandWorker = new CommandWorker(
      this.#drivers,
      [observedTarget],
      this.#ledger,
      (receipt) => this.#recordReceipt(receipt),
      (failure) => this.#recordCommandFailure(failure),
    );
    this.#recoveryTask = this.#commandWorker.recoverUnpublishedReceipts();
    await abortable(this.#recoveryTask, options.signal);
    options.signal?.throwIfAborted();

    const sessionCount = await this.synchronize("startup", options.signal);
    options.signal?.throwIfAborted();

    if (options.acceptCommands ?? true) {
      this.#acceptingCommands = true;
      try {
        this.#subscriptionTask = this.#target.subscribeCommands(
          (commands) => {
            if (!this.#acceptingCommands) return;
            void this.#commandWorker?.handle(commands).catch((error) => {
              this.#logger.error(
                `command admission failed: ${errorMessage(error)}`,
              );
            });
          },
        ).then(async (cancel) => {
          if (!this.#acceptingCommands) {
            await Promise.resolve().then(cancel);
            return;
          }
          this.#cancelCommands = cancel;
        });
        await abortable(
          this.#subscriptionTask,
          options.signal,
        );
      } catch (error) {
        this.#acceptingCommands = false;
        throw error;
      }
      this.#recordActivity(
        "commands-subscribed",
        "Fabric command subscription started",
      );
    }
    options.signal?.throwIfAborted();
    this.#recordActivity("host-started", "Host startup completed", {
      sessionCount,
    });
    if (deferHealthUntilReady) {
      options.onHealthOwnership?.();
      this.#healthPublicationEnabled = true;
      await this.#publishHealth();
    } else {
      await this.#publishHealth(options.signal);
    }
    return sessionCount;
  }

  synchronize(reason = "manual", signal?: AbortSignal): Promise<number> {
    if (!this.#started || this.#stopping || this.#stopped) {
      return Promise.reject(new Error("agent host is not accepting sync work"));
    }
    let publicationCommitted = false;
    const operation = this.#syncTail.then(() =>
      this.#synchronize(reason, signal, () => {
        publicationCommitted = true;
      })
    );
    this.#syncTail = operation.then(() => undefined, () => undefined);
    return abortable(operation, signal, () => !publicationCommitted);
  }

  stop(
    reason = "requested",
    options: AgentsHostStopOptions = {},
  ): Promise<void> {
    this.#stopTask ??= this.#stop(reason, options);
    return this.#stopTask;
  }

  async #stop(
    reason: string,
    options: AgentsHostStopOptions,
  ): Promise<void> {
    if (this.#stopped) return;
    this.#stopping = true;
    this.#setStatus("stopping");
    this.#recordActivity("host-stopping", "Host shutdown began", { reason });
    const shutdownErrors: unknown[] = [];
    const publishHealth = options.publishHealth ?? true;
    this.#healthPublicationEnabled = publishHealth;
    this.#acceptingCommands = false;
    const cancelCommands = this.#cancelCommands;
    this.#cancelCommands = undefined;
    try {
      cancelCommands?.();
    } catch (error) {
      shutdownErrors.push(error);
      this.#recordActivity(
        "command-subscription-stop-failed",
        "Fabric command subscription failed while stopping",
        { error: errorMessage(error) },
      );
    }

    const interruptDrivers = new Map([
      ...this.#cleanupDrivers,
      ...this.#drivers,
    ]);
    if (options.interruptInFlight) {
      for (const [sourceId, driver] of interruptDrivers) {
        void this.#stopDriver(sourceId, driver).catch(() => undefined);
      }
    }

    if (publishHealth) {
      await this.#publishHealth().catch((error) => {
        shutdownErrors.push(error);
        this.#logger.error(
          `stopping health publication failed: ${errorMessage(error)}`,
        );
      });
    }

    await this.#syncTail;
    await this.#recoveryTask.catch((error) => {
      shutdownErrors.push(error);
    });
    await this.#subscriptionTask.catch((error) => {
      shutdownErrors.push(error);
    });
    await this.#healthTail;
    if (this.#commandWorker) {
      await this.#commandWorker.drain().catch((error) => {
        shutdownErrors.push(error);
        this.#recordActivity(
          "command-drain-failed",
          "An admitted command failed before shutdown",
          { error: errorMessage(error) },
        );
      });
      if (options.flushPendingReceipts ?? true) {
        await this.#commandWorker.recoverUnpublishedReceipts().then(
          () => {
            this.#recordActivity(
              "receipt-flush-completed",
              "Pending command receipt publication completed",
            );
          },
          (error) => {
            shutdownErrors.push(error);
            this.#recordActivity(
              "receipt-flush-failed",
              "Pending command receipt publication failed",
              { error: errorMessage(error) },
            );
          },
        );
      }
    }

    const driversToStop = new Map([
      ...this.#cleanupDrivers,
      ...this.#drivers,
    ]);
    const stoppedSources = await Promise.allSettled(
      [...driversToStop].map(([sourceId, driver]) =>
        this.#stopDriver(sourceId, driver, true)
      ),
    );
    const failedStops = new Set<string>();
    [...driversToStop.keys()].forEach((sourceId, index) => {
      const state = this.#sources.get(sourceId)!;
      const result = stoppedSources[index];
      if (result.status === "rejected") {
        failedStops.add(sourceId);
        shutdownErrors.push(result.reason);
        state.status = "failed";
        state.lastError = errorMessage(result.reason);
        this.#recordActivity(
          "source-stop-failed",
          "Source failed while stopping",
          { error: state.lastError },
          sourceId,
        );
      } else {
        state.status = "stopped";
        this.#recordActivity(
          "source-stopped",
          "Source stopped",
          undefined,
          sourceId,
        );
      }
    });
    this.#drivers.clear();
    this.#cleanupDrivers.clear();

    for (const state of this.#sources.values()) {
      if (
        state.enabled && !failedStops.has(state.id) &&
        state.status !== "stopped"
      ) {
        state.status = "stopped";
        this.#recordActivity(
          "source-stopped",
          "Source stopped",
          undefined,
          state.id,
        );
      }
    }

    this.#setStatus("stopped");
    this.#recordActivity("host-stopped", "Host shutdown completed", { reason });
    this.#stopped = true;
    if (publishHealth) {
      await this.#publishHealth().catch((error) => {
        shutdownErrors.push(error);
        this.#logger.error(
          `stopped health publication failed: ${errorMessage(error)}`,
        );
      });
    }
    await this.#healthTail;
    if (shutdownErrors.length > 0) {
      throw new AggregateError(
        shutdownErrors,
        `agent host stopped with failures: ${
          shutdownErrors.map(errorMessage).join("; ")
        }`,
      );
    }
  }

  #stopDriver(
    sourceId: string,
    driver: AgentDriver,
    retryFailure = false,
  ): Promise<void> {
    const existing = this.#driverStopTasks.get(sourceId);
    if (existing?.driver === driver) {
      if (!retryFailure) return existing.task;
      return existing.task.catch(() => {
        this.#driverStopTasks.delete(sourceId);
        return this.#stopDriver(sourceId, driver);
      });
    }
    const task = Promise.resolve().then(() => driver.stop());
    this.#driverStopTasks.set(sourceId, { driver, task });
    return task;
  }

  async #startSource(
    config: AgentSourceConfig,
    signal?: AbortSignal,
  ): Promise<void> {
    const state = this.#sources.get(config.id)!;
    let driver: AgentDriver | undefined;
    let startupError: unknown;
    let cleanupError: unknown;
    try {
      driver = this.#createDriver(config);
      this.#cleanupDrivers.set(config.id, driver);
      await driver.start(signal);
      signal?.throwIfAborted();
      this.#cleanupDrivers.delete(config.id);
      this.#drivers.set(config.id, driver);
      state.status = "ready";
      state.capabilities = structuredClone(driver.source.capabilities);
      state.lastError = undefined;
      this.#recordActivity(
        "source-started",
        "Source startup completed",
        { capabilities: state.capabilities },
        config.id,
      );
    } catch (error) {
      startupError = error;
      if (driver) {
        try {
          await this.#stopDriver(config.id, driver);
          this.#cleanupDrivers.delete(config.id);
        } catch (stopError) {
          this.#cleanupDrivers.set(config.id, driver);
          cleanupError = stopError;
          const cleanupMessage = errorMessage(stopError);
          state.lastError = `${
            errorMessage(error)
          }; cleanup failed: ${cleanupMessage}`;
          this.#recordActivity(
            "source-start-cleanup-failed",
            "Source cleanup failed after startup failure",
            { error: cleanupMessage },
            config.id,
          );
        }
      }
      state.status = "failed";
      state.lastError ??= errorMessage(error);
      this.#recordActivity(
        "source-start-failed",
        "Source startup failed",
        { error: state.lastError },
        config.id,
      );
    }
    try {
      await this.#publishHealth(signal);
    } catch (healthError) {
      if (cleanupError) {
        throw new AggregateError(
          [startupError, cleanupError, healthError],
          `source startup and cleanup failed: ${config.id}`,
        );
      }
      throw healthError;
    }
    if (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        `source cleanup failed after startup failure: ${config.id}`,
      );
    }
  }

  async #synchronize(
    reason: string,
    signal?: AbortSignal,
    onPublicationCommit?: () => void,
  ): Promise<number> {
    let publicationCommitted = false;
    const markPublicationCommitted = () => {
      publicationCommitted = true;
      onPublicationCommit?.();
    };
    const observationSequence = this.#target.beginSessionObservation();
    const startedAt = this.#now();
    const previousSourceStates = new Map(
      [...this.#drivers.keys()].map((sourceId) => {
        const state = this.#sources.get(sourceId)!;
        return [sourceId, {
          status: state.status,
          lastCollectionStartedAt: state.lastCollectionStartedAt,
        }] as const;
      }),
    );
    this.#lastSync = { reason, status: "running", startedAt };
    if (!this.#stopping) this.#setStatus("syncing");
    this.#recordActivity("sync-started", "Full collection began", { reason });
    for (const sourceId of this.#drivers.keys()) {
      const state = this.#sources.get(sourceId)!;
      state.status = "collecting";
      state.lastCollectionStartedAt = startedAt;
    }

    try {
      await this.#publishHealth(signal);
      const collected = await Promise.all(
        [...this.#drivers.entries()].map(([sourceId, driver]) =>
          this.#collectSource(sourceId, driver, signal)
        ),
      );
      signal?.throwIfAborted();
      const checkoutDirectories = this.#checkoutRoots.length > 0
        ? await this.#discoverCheckouts(
          this.#checkoutRoots,
          signal,
          (directory, checkoutSignal) =>
            this.#target.validateCheckout(directory, checkoutSignal),
        )
        : [];
      signal?.throwIfAborted();
      const sessionCount = await this.#target.publish(collected, {
        observationSequence,
        checkoutDirectories,
        signal,
        onCommit: markPublicationCommitted,
      });
      const completedAt = this.#now();
      this.#lastSync = {
        reason,
        status: "complete",
        startedAt,
        completedAt,
        sessionCount,
      };
      if (!this.#stopping) this.#setStatus(this.#operationalStatus());
      this.#recordActivity(
        "sync-completed",
        "Full collection completed",
        { reason, sessionCount },
      );
      await this.#publishHealth();
      return sessionCount;
    } catch (error) {
      for (const [sourceId, previous] of previousSourceStates) {
        const state = this.#sources.get(sourceId)!;
        if (state.status !== "collecting") continue;
        state.status = previous.status;
        state.lastCollectionStartedAt = previous.lastCollectionStartedAt;
      }
      if (signal?.aborted && !publicationCommitted) {
        this.#lastSync = {
          reason,
          status: "failed",
          startedAt,
          completedAt: this.#now(),
          error: errorMessage(signal.reason),
        };
        this.#recordActivity(
          "sync-cancelled",
          "Full collection was cancelled",
          { reason },
        );
        if (!this.#stopping) this.#setStatus(this.#operationalStatus());
        await this.#publishHealth().catch((healthError) => {
          this.#logger.error(
            `cancellation health publication failed: ${
              errorMessage(healthError)
            }`,
          );
        });
        throw signal.reason;
      }
      const message = errorMessage(error);
      this.#lastSync = {
        reason,
        status: "failed",
        startedAt,
        completedAt: this.#now(),
        error: message,
      };
      if (!this.#stopping) this.#setStatus("failed");
      this.#recordActivity(
        "sync-failed",
        "Full collection failed",
        { reason, error: message },
      );
      await this.#publishHealth().catch((healthError) => {
        this.#logger.error(
          `health publication failed: ${errorMessage(healthError)}`,
        );
      });
      throw error;
    }
  }

  async #collectSource(
    sourceId: string,
    driver: AgentDriver,
    signal?: AbortSignal,
  ): Promise<CollectedSource> {
    const state = this.#sources.get(sourceId)!;
    this.#recordActivity(
      "source-collection-started",
      "Source collection began",
      undefined,
      sourceId,
    );
    let collected: CollectedSource;
    try {
      collected = await collectSource(driver, signal);
    } catch (error) {
      signal?.throwIfAborted();
      collected = {
        source: driver.source,
        sessions: [],
        errors: [{ message: errorMessage(error) }],
        complete: false,
      };
    }

    state.capabilities = structuredClone(driver.source.capabilities);
    state.sessionCount = collected.sessions.length;
    state.complete = collected.complete;
    state.errors = structuredClone(collected.errors);
    state.lastCollectionCompletedAt = this.#now();
    state.lastError = collected.errors[0]?.message;
    state.status = collected.complete ? "ready" : "degraded";
    this.#recordActivity(
      "source-collection-completed",
      "Source collection completed",
      {
        complete: collected.complete,
        errorCount: collected.errors.length,
        sessionCount: collected.sessions.length,
      },
      sourceId,
    );
    return collected;
  }

  #operationalStatus(): "ready" | "degraded" {
    const degraded =
      [...this.#sources.values()].some((source) =>
        source.enabled && source.status !== "ready"
      ) || this.#ledger.pendingPublicationCount() > 0 ||
      this.#commandFailures.size > 0;
    return degraded ? "degraded" : "ready";
  }

  async #refreshSession(
    driver: AgentDriver,
    nativeSessionId: string,
  ): Promise<void> {
    try {
      await this.#target.refreshSession(driver, nativeSessionId);
    } catch (error) {
      const message = errorMessage(error);
      const state = this.#sources.get(driver.source.id);
      if (state) {
        state.status = "degraded";
        state.lastError = `post-command session refresh failed: ${message}`;
      }
      if (this.#status === "ready") this.#setStatus("degraded");
      this.#recordActivity(
        "session-refresh-failed",
        "Post-command session refresh failed",
        { nativeSessionId, error: message },
        driver.source.id,
      );
      await this.#publishHealth().catch((healthError) => {
        this.#logger.error(
          `refresh health publication failed: ${errorMessage(healthError)}`,
        );
      });
      throw error;
    }
    this.#recordActivity(
      "session-refresh-completed",
      "Post-command session refresh completed",
      { nativeSessionId },
      driver.source.id,
    );
    await this.#publishHealth().catch((error) => {
      this.#logger.error(
        `refresh health publication failed: ${errorMessage(error)}`,
      );
    });
  }

  async #publishReceipt(
    receipt: AgentSessionCommandReceipt,
  ): Promise<void> {
    try {
      await this.#target.publishReceipt(receipt);
    } catch (error) {
      const message = errorMessage(error);
      const state = this.#sources.get(receipt.sourceId);
      if (state) {
        state.status = "degraded";
        state.lastError = `command receipt publication failed: ${message}`;
      }
      if (this.#status === "ready") this.#setStatus("degraded");
      this.#recordActivity(
        "receipt-publication-failed",
        "Command receipt publication failed",
        {
          commandId: receipt.commandId,
          nativeSessionId: receipt.nativeSessionId,
          status: receipt.status,
          error: message,
        },
        receipt.sourceId,
      );
      await this.#publishHealth().catch((healthError) => {
        this.#logger.error(
          `receipt failure health publication failed: ${
            errorMessage(healthError)
          }`,
        );
      });
      throw error;
    }
  }

  #recordReceipt(receipt: AgentSessionCommandReceipt): void {
    this.#commandFailures.delete(receipt.commandId);
    this.#recordActivity(
      "command-receipt",
      `Command receipt is ${receipt.status}`,
      {
        commandId: receipt.commandId,
        nativeSessionId: receipt.nativeSessionId,
        status: receipt.status,
        ...(receipt.error ? { error: receipt.error } : {}),
      },
      receipt.sourceId,
    );
    void this.#publishHealth().catch((error) => {
      this.#logger.error(
        `receipt health publication failed: ${errorMessage(error)}`,
      );
    });
  }

  #recordCommandFailure(failure: CommandTaskFailure): void {
    const message = errorMessage(failure.error);
    this.#commandFailures.set(failure.commandId, message);
    const state = this.#sources.get(failure.sourceId);
    if (state) {
      state.status = "degraded";
      state.lastError = `command processing failed: ${message}`;
    }
    if (this.#status === "ready") this.#setStatus("degraded");
    this.#recordActivity(
      "command-task-failed",
      "Command processing failed",
      {
        commandId: failure.commandId,
        nativeSessionId: failure.nativeSessionId,
        error: message,
      },
      failure.sourceId,
    );
    void this.#publishHealth().catch((error) => {
      this.#logger.error(
        `command failure health publication failed: ${errorMessage(error)}`,
      );
    });
  }

  #recordActivity(
    type: string,
    message: string,
    details?: Record<string, unknown>,
    sourceId?: string,
  ): void {
    const at = this.#now();
    this.#activitySequence++;
    this.#activity.push({
      id: `${this.#startedAt}:${this.#activitySequence}`,
      at,
      type,
      message,
      ...(sourceId ? { sourceId } : {}),
      ...(details ? { details: structuredClone(details) } : {}),
    });
    if (this.#activity.length > this.#activityLimit) {
      this.#activity.splice(0, this.#activity.length - this.#activityLimit);
    }
    this.#updatedAt = at;
  }

  #setStatus(status: AgentsHostStatus): void {
    this.#status = status;
    this.#updatedAt = this.#now();
  }

  #now(): string {
    return this.#clock().toISOString();
  }

  #publishHealth(signal?: AbortSignal): Promise<void> {
    if (!this.#healthPublicationEnabled) {
      return abortable(this.#healthTail, signal);
    }
    const snapshot = this.health();
    const operation = this.#healthTail.then(async () => {
      signal?.throwIfAborted();
      await this.#target.publishHealth(
        snapshot as unknown as Record<string, unknown>,
      );
      signal?.throwIfAborted();
    });
    this.#healthTail = operation.catch(() => undefined);
    return abortable(operation, signal);
  }
}
