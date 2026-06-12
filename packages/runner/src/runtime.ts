import {
  StaticCache,
  StaticCacheFS,
  StaticCacheHTTP,
} from "@commonfabric/static";
import { RuntimeTelemetry } from "@commonfabric/runner";
import type { NonIdempotentReport } from "./telemetry.ts";
import type {
  AnyCell,
  JSONSchema,
  Module,
  NodeFactory,
  Pattern,
  Schema,
} from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import {
  getCommitPreconditionsConfig,
  getPersistentSchedulerStateConfig,
  resetCommitPreconditionsConfig,
  resetPersistentSchedulerStateConfig,
  setCommitPreconditionsConfig,
  setPersistentSchedulerStateConfig,
} from "@commonfabric/memory/v2";
import { PatternEnvironment, setPatternEnvironment } from "./builder/env.ts";
import { AsyncSemaphoreQueue, type QueueConfig } from "./queue.ts";
import type {
  ChangeGroup,
  CommitError,
  DID,
  IExtendedStorageTransaction,
  IStorageManager,
  IStorageProvider,
  MemorySpace,
} from "./storage/interface.ts";
import {
  type Cell,
  createCell,
  internCellLinkSchema,
  schemaCellScope,
} from "./cell.ts";
import { createRef, EntityId } from "./create-ref.ts";
import { createSession, Identity } from "@commonfabric/identity";
import { Action, Scheduler } from "./scheduler.ts";
import { Engine } from "./harness/index.ts";
import {
  CellLink,
  isCellLink,
  isNormalizedFullLink,
  isSigilLink,
  type NormalizedFullLink,
  NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { LINK_V1_TAG } from "./sigil-types.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import {
  type CfcEnforcementMode,
  type CfcFlowLabelsMode,
  type CfcLabelView,
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  flowLabelWorkExists,
  gatedSinkRequestExists,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
} from "./cfc/mod.ts";
import { PatternManager } from "./pattern-manager.ts";
import { ModuleRegistry } from "./module.ts";
import { Runner } from "./runner.ts";
import { registerBuiltins } from "./builtins/index.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import { isCellScope, normalizeCellScope } from "./scope.ts";
import { toURI } from "./uri-utils.ts";
import { isDeno } from "@commonfabric/utils/env";
import { popFrame, pushFrame } from "./builder/pattern.ts";
import type { Frame } from "./builder/types.ts";
import type { ConsoleMessage } from "./interface.ts";
import type {
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "./storage/write-stack-trace.ts";
import {
  getWriteStackTrace,
  setWriteStackTraceMatchers,
} from "./storage/write-stack-trace.ts";
import {
  createUnsafeHostTrustToken,
  type UnsafeHostTrust,
  type UnsafeHostTrustOptions,
} from "./unsafe-host-trust.ts";

const isFullNormalizedLinkShape = (
  value: unknown,
): value is NormalizedLink & {
  id: string;
  space: MemorySpace;
  path: string[];
} => {
  if (typeof value !== "object" || value === null) return false;
  const link = value as NormalizedLink;
  if (link.scope === "inherit") {
    throw new Error(
      "NormalizedFullLink.scope cannot be 'inherit'; resolve scope before creating a full link",
    );
  }
  return typeof link.id === "string" &&
    typeof link.space === "string" &&
    Array.isArray(link.path) &&
    (link.scope === undefined || isCellScope(link.scope));
};

interface WriteDebugContextStore<T> {
  getStore(): T | undefined;
  run<R>(value: T, fn: () => R): R;
}

class FallbackAsyncLocalStorage<T> implements WriteDebugContextStore<T> {
  #store: T | undefined;

  getStore(): T | undefined {
    return this.#store;
  }

  run<R>(value: T, fn: () => R): R {
    const previous = this.#store;
    this.#store = value;
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(() => {
          this.#store = previous;
        }) as R;
      }
      this.#store = previous;
      return result;
    } catch (error) {
      this.#store = previous;
      throw error;
    }
  }
}

const WriteDebugContextStorage = isDeno()
  ? (await import("node:async_hooks"))
    .AsyncLocalStorage as new <T>() => WriteDebugContextStore<T>
  : FallbackAsyncLocalStorage;

// @ts-ignore - This is temporary to debug integration test
Error.stackTraceLimit = 500;

export const DEFAULT_MAX_RETRIES = 5;

export type { IExtendedStorageTransaction, IStorageProvider, MemorySpace };

export type ConsoleHandler = (
  message: ConsoleMessage,
) => any[];

export type ErrorWithContext = Error & {
  action: Action;
  pieceId: string;
  space: MemorySpace;
  patternId: string;
  spellId: string | undefined;
};

export type ErrorHandler = (error: ErrorWithContext) => void;
export type NavigateCallback = (target: Cell<any>) => void | Promise<void>;
export type PieceCreatedCallback = (piece: Cell<any>) => void;

/**
 * Feature flags for the space-model data-layer changes. Each flag gates an
 * independent piece of the new fabric-value pipeline so that the features
 * can be enabled incrementally. Passed via `RuntimeOptions.experimental` and
 * propagated to the memory layer as ambient config.
 *
 * See the formal spec at `docs/specs/space-model-formal-spec/`.
 */
export interface ExperimentalOptions {
  /** Enable the modern "cell representation" classes. */
  modernCellRep?: boolean | undefined;
  /** Persist scheduler observations and use them for scheduler rehydration. */
  persistentSchedulerState?: boolean | undefined;
  /** Attach origin-committed preconditions to scheduler-v2 lineage commits. */
  commitPreconditions?: boolean | undefined;
  /** Preserve cumulative scheduler write history instead of using current-known writes. */
  schedulerHistoricalMightWrite?: boolean | undefined;
}

export interface RuntimeOptions {
  apiUrl: URL;
  /**
   * Optional space DID → host base URL map (federation). Space-bound
   * work (LLM calls, fetches, blob uploads) for a mapped space targets
   * that host; absent map or entry ⇒ `apiUrl`. Mirrors the storage
   * layer's map (StorageManager Options.spaceHostMap) — pass the same
   * one. Fixed for the runtime's lifetime.
   */
  spaceHostMap?: Record<string, string>;
  storageManager: IStorageManager;
  consoleHandler?: ConsoleHandler;
  errorHandlers?: ErrorHandler[];
  patternEnvironment?: PatternEnvironment;
  navigateCallback?: NavigateCallback;
  pieceCreatedCallback?: PieceCreatedCallback;
  debug?: boolean;
  telemetry?: RuntimeTelemetry;
  /** Optional feature flags for experimental space-model data-layer changes. */
  experimental?: ExperimentalOptions;
  /** Rollout mode for commit-boundary CFC enforcement. Defaults to `enforce-explicit`. */
  cfcEnforcementMode?: CfcEnforcementMode;
  /**
   * Flow-label propagation dial (S16 default transition). Defaults to `off`.
   * Propagation requires enforcement mode ≥ `observe` to run at the commit
   * boundary; it derives and persists labels but never rejects by itself.
   */
  cfcFlowLabels?: CfcFlowLabelsMode;
  /** Per-sink confidentiality ceilings for the sink-request egress gate. A sink
   *  absent from the map is ungated; a declared ceiling rejects (or, in observe
   *  mode, flags) a request carrying confidentiality outside it. Defaults to
   *  none declared (`DEFAULT_SINK_MAX_CONFIDENTIALITY`). */
  cfcSinkMaxConfidentiality?: SinkMaxConfidentiality;
  /** Deterministic provider for the trust snapshot attached to each new tx. */
  trustSnapshotProvider?: () => TrustSnapshot | undefined;
  /** Replace runner-owned frames with `<CF_INTERNAL>` in surfaced stacks. */
  hideInternalStackFrames?: boolean;
}

export interface CfcRuntimeStats {
  cfcRelevantTx: number;
  cfcPreparedTx: number;
  cfcPrepareRejects: number;
  cfcDigestInvalidations: number;
  cfcOutboxFlushes: number;
  sinkDedupHits: number;
  sinkReleaseRejects: number;
}

const initialCfcRuntimeStats = (): CfcRuntimeStats => ({
  cfcRelevantTx: 0,
  cfcPreparedTx: 0,
  cfcPrepareRejects: 0,
  cfcDigestInvalidations: 0,
  cfcOutboxFlushes: 0,
  sinkDedupHits: 0,
  sinkReleaseRejects: 0,
});

/**
 * For these schema, we use type object with empty properties, so that we
 * will fetch the objects and consider them valid, but will not walk into
 * their properties on the server traversal, so we don't need to return every
 * reachable object from these pieces.
 * @see SchemaObjectTraverser.traverseObjectWithSchema for more detail.
 */
export const spaceCellSchema = internSchema(
  {
    type: "object",
    properties: {
      defaultPattern: {
        type: "object",
        properties: {
          spaces: {
            type: "array",
            items: {
              type: "object",
              properties: { name: { type: "string" }, did: { type: "string" } },
            },
          },
          defaultAppUrl: { type: "string" },
          suggestionHistory: {
            type: "array",
            items: {
              type: "object",
              properties: {
                result: { type: "object", asCell: ["cell"] },
                messages: { type: "array" },
                timestamp: { type: "string" },
              },
            },
          },
          recordSuggestion: { asCell: ["stream"] },
        },
        asCell: ["cell"],
      },
    },
  },
);

export interface SpaceCellContents {
  defaultPattern: Cell<unknown>;
}

function isMemorySpaceDID(value: string): boolean {
  return /^did:[^:]+:.+/.test(value);
}

/**
 * Main Runtime class that orchestrates all services in the runner package.
 *
 * This class eliminates the singleton pattern by providing a single entry point
 * for creating and managing all runner services with proper dependency injection.
 *
 * Usage:
 * ```typescript
 * const runtime = new Runtime({
 *   apiUrl: 'https://storage.example.com',
 *   consoleHandler: customConsoleHandler,
 *   errorHandlers: [customErrorHandler]
 * });
 *
 * // Access services through the runtime instance
 * await runtime.storage.loadCell(cellLink);
 * await runtime.scheduler.idle();
 * const pattern = await runtime.patternManager.compilePattern(source);
 * ```
 */
export class Runtime {
  readonly id: string;
  readonly scheduler: Scheduler;
  readonly patternManager: PatternManager;
  readonly moduleRegistry: ModuleRegistry;
  readonly harness: Engine;
  readonly runner: Runner;
  readonly navigateCallback?: NavigateCallback;
  readonly pieceCreatedCallback?: PieceCreatedCallback;
  readonly cfc: ContextualFlowControl;
  readonly cfcEnforcementMode: CfcEnforcementMode;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcSinkMaxConfidentiality: SinkMaxConfidentiality;
  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;
  readonly trustSnapshotProvider: () => TrustSnapshot | undefined;
  readonly telemetry: RuntimeTelemetry;
  /** Resolved experimental flags (all properties present, defaulting to `false`). */
  readonly experimental: ExperimentalOptions;
  readonly apiUrl: URL;
  readonly spaceHostMap?: Record<string, string>;
  /** Runtime-learned host hints (site table); see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();
  readonly userIdentityDID: DID;
  /** Cache of resolved PatternFactory.inSpace("name") space DIDs. */
  private readonly spaceNameToDid = new Map<string, MemorySpace>();
  private defaultFrame?: Frame;
  private queues = new Map<string, AsyncSemaphoreQueue>();
  private writeDebugContext = new WriteDebugContextStorage<string>();
  private cfcStats: CfcRuntimeStats = initialCfcRuntimeStats();

  constructor(options: RuntimeOptions) {
    this.experimental = {
      modernCellRep: undefined,
      persistentSchedulerState: undefined,
      commitPreconditions: undefined,
      schedulerHistoricalMightWrite: undefined,
      ...options.experimental,
    };

    // Log any overridden experimental flags.
    const overrideFlags = Object.entries(this.experimental)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    if (overrideFlags.length > 0) {
      console.log(
        `Experimental flag overrides: ${overrideFlags.join(", ")}`,
      );
    }

    // Propagate experimental flags to their ambient control points, then read
    // back the effective state so `experimental.*` reflects what is actually in
    // effect (matters when the caller didn't pass an explicit value and the
    // default happens to be `true`; without this, consumers would see
    // `undefined` and probably get very confused).
    setModernCellRepConfig(this.experimental.modernCellRep);
    this.experimental.modernCellRep = getModernCellRepConfig();
    setPersistentSchedulerStateConfig(
      this.experimental.persistentSchedulerState,
    );
    this.experimental.persistentSchedulerState =
      getPersistentSchedulerStateConfig();
    setCommitPreconditionsConfig(this.experimental.commitPreconditions);
    this.experimental.commitPreconditions = getCommitPreconditionsConfig();

    this.id = options.storageManager.id;
    this.apiUrl = new URL(options.apiUrl);
    // Validate eagerly, mirroring the storage layer's resolver: a
    // malformed host should fail at configuration time naming the
    // space, not mid-builtin as a bare Invalid URL.
    for (const [space, host] of Object.entries(options.spaceHostMap ?? {})) {
      try {
        new URL(host);
      } catch (cause) {
        throw new Error(
          `Invalid spaceHostMap entry for ${space}: "${host}"`,
          { cause },
        );
      }
    }
    // Snapshot + freeze: the map is fixed for the runtime's lifetime
    // (the per-space provider cache and routing decisions assume
    // space → host never changes), so a caller mutating their object
    // after construction must not change routing.
    this.spaceHostMap = options.spaceHostMap
      ? Object.freeze({ ...options.spaceHostMap })
      : undefined;
    this.staticCache = isDeno()
      ? new StaticCacheFS()
      : new StaticCacheHTTP(new URL("/static", this.apiUrl));

    this.telemetry = options.telemetry ?? new RuntimeTelemetry();

    // Create harness first (no dependencies on other services)
    this.harness = new Engine(this, {
      hideInternalStackFrames: options.hideInternalStackFrames,
    });

    this.storageManager = options.storageManager;
    const actingPrincipal = options.storageManager.as.did() as DID;
    this.trustSnapshotProvider = options.trustSnapshotProvider ?? (() => ({
      id: `principal:${actingPrincipal}`,
      actingPrincipal,
      revision: this.id,
    }));
    this.userIdentityDID = options.storageManager.as.did() as DID;
    this.moduleRegistry = new ModuleRegistry(this);
    this.patternManager = new PatternManager(this);
    this.runner = new Runner(this);
    this.cfc = new ContextualFlowControl();
    this.cfcEnforcementMode = options.cfcEnforcementMode ??
      "enforce-explicit";
    this.cfcFlowLabels = options.cfcFlowLabels ?? "off";
    // Deep-freeze: the ceiling is CFC enforcement config, so a caller must not
    // be able to mutate it (per-sink array or the map) after construction to
    // change what egresses are allowed (review on #3993).
    this.cfcSinkMaxConfidentiality = Object.freeze(
      Object.fromEntries(
        Object.entries(
          options.cfcSinkMaxConfidentiality ?? DEFAULT_SINK_MAX_CONFIDENTIALITY,
        ).map(([sink, atoms]) => [sink, Object.freeze([...atoms])]),
      ),
    );

    // Create core services with dependencies injected
    this.scheduler = new Scheduler(
      this,
      options.consoleHandler,
      options.errorHandlers,
    );

    // Register built-in modules with runtime injection
    registerBuiltins(this);

    // Set this runtime as the current runtime for global cell compatibility
    // Removed setCurrentRuntime call - no longer using singleton pattern

    // Set the navigate callback
    this.navigateCallback = options.navigateCallback;
    this.pieceCreatedCallback = options.pieceCreatedCallback;

    // Handle pattern environment configuration. Only set the (process-global)
    // pattern environment when a host explicitly provides one — setting it
    // unconditionally from every Runtime would let the last-constructed runtime
    // clobber the apiUrl other runtimes' patterns see. Hosts that run patterns
    // server-side (the toolshed) pass `patternEnvironment` so handler `fetch`es
    // reach the right toolshed rather than the hardcoded `localhost:<port>`
    // fallback in builder/env.ts. This is still a singleton. TODO(seefeld).
    if (options.patternEnvironment) {
      setPatternEnvironment(options.patternEnvironment);
    }

    if (options.debug) {
      console.log("Runtime initialized with services:", {
        scheduler: !!this.scheduler,
        storageManager: !!this.storageManager,
        patternManager: !!this.patternManager,
        moduleRegistry: !!this.moduleRegistry,
        harness: !!this.harness,
        runner: !!this.runner,
        telemetry: !!this.telemetry,
      });
    }

    // Push a default frame with this runtime so builder functions can access it
    this.defaultFrame = pushFrame({ runtime: this });
  }

  /**
   * Wait for all pending operations to complete
   */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  /**
   * Optional read-your-writes barrier provided by the embedding client
   * (e.g. the runtime-client worker): resolves once the client's in-flight
   * direct cell writes — including rebase retries of rejected commits — have
   * settled. The scheduler awaits this before running a queued event so a
   * handler can never observe the rollback window of a write the user
   * already saw rendered.
   */
  clientWriteBarrier: (() => Promise<void>) | undefined;

  /**
   * Proactively checks all computations for idempotency by force-dirtying
   * and re-executing them, then comparing write snapshots.
   */
  runIdempotencyCheck() {
    return this.scheduler.runIdempotencyCheck();
  }

  /**
   * Enables inline idempotency checking: every computation that runs through
   * the scheduler's run() will automatically get a second synchronous run
   * for comparison.
   */
  enableIdempotencyCheck(): void {
    this.scheduler.enableIdempotencyCheck();
  }

  /**
   * Returns violations collected while inline idempotency check mode is enabled.
   */
  getIdempotencyViolations(): NonIdempotentReport[] {
    return this.scheduler.getIdempotencyViolations();
  }

  /**
   * Get or create a named async queue for throttling concurrent operations.
   * Queues are shared across all builtins that reference the same name.
   */
  getOrCreateQueue(
    name: string,
    config?: QueueConfig,
  ): AsyncSemaphoreQueue {
    let q = this.queues.get(name);
    if (!q) {
      q = new AsyncSemaphoreQueue(config ?? { maxConcurrency: 2 });
      this.queues.set(name, q);
    }
    return q;
  }

  /**
   * Configure a named queue's concurrency. Creates the queue if it doesn't exist.
   */
  configureQueue(name: string, config: QueueConfig): void {
    const q = this.getOrCreateQueue(name, config);
    q.setMaxConcurrency(config.maxConcurrency);
  }

  /**
   * Clean up resources and cancel all operations.
   *
   * NOTE: This does not wait for in-flight transactions to settle.
   * Any unawaited tx.commit() calls will be canceled when
   * storageManager.close() tears down storage sessions. Callers
   * should await all pending commits before calling dispose().
   */
  async dispose(): Promise<void> {
    // Abort any pending (not-yet-started) queued jobs so they don't start
    // after storage is torn down.
    for (const queue of this.queues.values()) {
      queue.abortPending();
    }
    this.queues.clear();
    // Stop all running docs
    this.runner.stopAll();

    // Scheduler background work can still be using storage, for example the
    // subscription-time persistent-state rehydration lookup. Let that finish
    // before tearing down storage sessions.
    await this.scheduler.idle();

    // Clear module registry
    this.moduleRegistry.clear();

    // Cancel all storage operations
    await this.storageManager.close();

    // Wait for any pending operations
    await this.scheduler.idle();

    // Clean up scheduler timers
    this.scheduler.dispose();

    // Pop the default frame
    if (this.defaultFrame) {
      popFrame(this.defaultFrame);
      this.defaultFrame = undefined;
    }

    // Dispose the Engine (clears compiler/runtime state and the console hook)
    this.harness.dispose();

    // Reset experimental config to defaults.
    resetModernCellRepConfig();
    resetPersistentSchedulerStateConfig();
    resetCommitPreconditionsConfig();

    // Clear the current runtime reference
    // Removed setCurrentRuntime call - no longer using singleton pattern
  }

  async [Symbol.asyncDispose]() {
    await this.dispose();
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   */
  edit(
    options: { changeGroup?: ChangeGroup } = {},
  ): IExtendedStorageTransaction {
    const tx = this.storageManager.edit();
    if (options.changeGroup !== undefined) {
      tx.changeGroup = options.changeGroup;
    }
    (tx as { writeTraceScopeId?: string }).writeTraceScopeId = this.id;
    const debugActionId = this.getWriteDebugContext();
    if (debugActionId) {
      (tx as { debugActionId?: string }).debugActionId = debugActionId;
    }
    const wrapped = new ExtendedStorageTransaction(tx, {
      onRelevantTx: () => {
        this.cfcStats.cfcRelevantTx += 1;
      },
      onPreparedTx: () => {
        this.cfcStats.cfcPreparedTx += 1;
      },
      onPrepareReject: () => {
        this.cfcStats.cfcPrepareRejects += 1;
      },
      onDigestInvalidation: () => {
        this.cfcStats.cfcDigestInvalidations += 1;
      },
      onOutboxFlush: () => {
        this.cfcStats.cfcOutboxFlushes += 1;
      },
      onSinkDedupHit: () => {
        this.cfcStats.sinkDedupHits += 1;
      },
      onSinkReleaseReject: () => {
        this.cfcStats.sinkReleaseRejects += 1;
      },
    });
    wrapped.setCfcEnforcementMode(this.cfcEnforcementMode);
    wrapped.setCfcFlowLabelsMode(this.cfcFlowLabels);
    wrapped.setCfcSinkMaxConfidentiality(this.cfcSinkMaxConfidentiality);
    wrapped.setCfcTrustSnapshot(this.trustSnapshotProvider());
    return wrapped;
  }

  // (space, id) pairs for which a missing-link-target load has been kicked
  // this session. The kicked sync establishes a live per-doc subscription, so
  // a later creation of the doc still arrives — one kick per doc suffices.
  private missingDocLoadKicks = new Set<string>();

  /**
   * Asynchronously load a cross-space link target that a read found absent
   * from the local replica (CT-1667): per-space server queries cannot follow
   * links across space boundaries, so the client must fetch such targets
   * itself. Fire-and-forget, but registered as a cross-space promise so
   * `storageManager.synced()` and `Cell.pull()`'s convergence loop can await
   * it; the absent doc is a tracked read, so the reader re-runs on arrival.
   * Deduped per (space, id): the kicked sync leaves a live subscription
   * behind, so repeat kicks add nothing.
   */
  ensureLinkedDocLoaded(link: NormalizedFullLink): void {
    const key = `${link.space}\0${link.id}`;
    if (this.missingDocLoadKicks.has(key)) return;
    this.missingDocLoadKicks.add(key);
    const maybePromise = this.getCellFromLink(link).sync();
    if (maybePromise instanceof Promise) {
      const promise = maybePromise.catch(() => {
        // Allow a retry on failure (e.g. transient disconnect).
        this.missingDocLoadKicks.delete(key);
      }).finally(() => {
        this.storageManager.removeCrossSpacePromise(promise);
      }) as unknown as Promise<void>;
      this.storageManager.addCrossSpacePromise(promise);
    }
  }

  getCfcStats(): Readonly<CfcRuntimeStats> {
    return { ...this.cfcStats };
  }

  resetCfcStats(): void {
    this.cfcStats = initialCfcRuntimeStats();
  }

  getWriteDebugContext(): string | undefined {
    return this.writeDebugContext.getStore() ?? this.scheduler.currentActionId;
  }

  createUnsafeHostTrust(
    options: UnsafeHostTrustOptions,
  ): UnsafeHostTrust {
    return createUnsafeHostTrustToken(
      options,
      (value) => this.harness.unsafeTrustHostValue(value, options),
    );
  }

  unsafeTrustPattern<T extends Pattern>(
    pattern: T,
    options: UnsafeHostTrustOptions,
  ): T {
    this.harness.unsafeTrustHostValue(pattern, options);
    return pattern;
  }

  unsafeTrustModule<T extends Module>(
    module: T,
    options: UnsafeHostTrustOptions,
  ): T {
    this.harness.unsafeTrustHostValue(module, options);
    return module;
  }

  withWriteDebugContext<T>(
    label: string | undefined,
    fn: () => T,
  ): T {
    if (!label) {
      return fn();
    }
    return this.writeDebugContext.run(label, fn);
  }

  setWriteStackTraceMatchers(matchers: WriteStackTraceMatcher[]): void {
    setWriteStackTraceMatchers(matchers, { scopeId: this.id });
  }

  getWriteStackTrace(): WriteStackTraceEntry[] {
    return getWriteStackTrace({ scopeId: this.id });
  }

  /**
   * Creates a storage transaction that can be used to read / write data into
   * locally replicated memory spaces. Transaction allows reading from many
   * multiple spaces but writing only to one space.
   *
   * If the transaction fails, it will be retried up to maxRetries times.
   *
   * @param fn - Function to execute with the transaction.
   * @param maxRetries - Maximum number of retries.
   * @returns Promise<boolean> that resolves to true on success, or false after exhausting retries.
   */
  editWithRetry<T = void>(
    fn: (tx: IExtendedStorageTransaction) => T,
    maxRetries: number = DEFAULT_MAX_RETRIES,
  ): Promise<
    { ok: T; error?: undefined } | { ok?: undefined; error: CommitError }
  > {
    const tx = this.edit();
    tx.tx.immediate = true;
    (tx.tx as { deferRunnerStartUntilCommit?: boolean })
      .deferRunnerStartUntilCommit = true;
    let result: T;
    try {
      result = fn(tx);
    } catch (error) {
      // fn(tx) threw before commit -- abort the transaction so it isn't
      // orphaned, and surface the error as a Result instead of a rejection.
      tx.abort(error);
      return Promise.resolve({
        error: {
          name: "StorageTransactionAborted" as const,
          message: `editWithRetry action threw: ${error}`,
          reason: error,
        },
      });
    }
    this.prepareTxForCommit(tx);
    return tx.commit().then(({ error }) => {
      if (error) {
        if (maxRetries > 0) {
          return this.editWithRetry<T>(fn, maxRetries - 1);
        } else {
          return { error };
        }
      }
      return { ok: result };
    }).catch((error) => {
      return {
        error: {
          name: "StorageTransactionAborted" as const,
          message: `editWithRetry commit rejected: ${error}`,
          reason: error,
        },
      };
    });
  }

  prepareTxForCommit(tx: IExtendedStorageTransaction): void {
    const state = tx.getCfcState();
    if (state.enforcementMode === "disabled") {
      return;
    }
    // Flow-label relevance is computed, not caller-marked (S16): the
    // laundering txs are exactly the ones nothing marked relevant.
    if (
      !state.relevant &&
      state.flowLabelsMode !== "off" &&
      flowLabelWorkExists(tx)
    ) {
      tx.markCfcRelevant("flow-labels");
    }
    // Sink-request ceiling relevance is also computed, not caller-marked
    // (audit item 21): a request assembled from a value pulled through a
    // schema-less link marks nothing, so without this the egress commits
    // without `prepareCfc` and the ceiling is never checked. Independent of
    // the flow dial — the ceiling enforces even when flow labels are off.
    if (!state.relevant && gatedSinkRequestExists(tx)) {
      tx.markCfcRelevant("sink-request-ceiling");
    }
    if (!state.relevant) {
      return;
    }
    if (state.prepare.status === "unprepared") {
      tx.prepareCfc();
    }
  }

  /**
   * Returns the given transaction if it is ready, otherwise creates a new
   * read-only fallback transaction.
   */
  readTx(tx?: IExtendedStorageTransaction): IExtendedStorageTransaction {
    if (tx?.status().status === "ready") {
      return tx;
    }
    return this.createReadTx();
  }

  private createReadTx(): IExtendedStorageTransaction {
    const tx = this.edit();
    tx.setReadOnly?.("runtime.readTx()");
    return tx;
  }

  // Cell factory methods
  getCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    cause: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<Schema<S>>;
  getCell<T>(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<T>;
  getCell(
    space: MemorySpace,
    cause: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<any> {
    // Creating a cell uses the schema to seed the initial link scope: an
    // explicit scope wins, otherwise a top-level schema scope, otherwise space.
    // (Per-property/asCell scopes are not a top-level concern here; they are
    // resolved during read/write, see data-updating.ts and link-resolution.ts.)
    const effectiveScope = scope ?? schemaCellScope(schema) ?? "space";
    return this.getCellFromLink(
      {
        id: toURI(createRef({}, cause)),
        path: [],
        space,
        scope: effectiveScope,
      },
      schema,
      tx,
    );
  }

  // Cell factory methods
  getSpaceCell<T = SpaceCellContents>(
    space: MemorySpace,
    schema?: undefined,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    schema: S,
    tx?: IExtendedStorageTransaction,
  ): Cell<Schema<S>>;
  getSpaceCell<T>(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<T>;
  getSpaceCell(
    space: MemorySpace,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
  ): Cell<any> {
    return this.getCell(
      space,
      space, // Use space DID as cause
      schema ?? spaceCellSchema,
      tx,
    );
  }

  getCellFromEntityId<T>(
    space: MemorySpace,
    entityId: EntityId | string,
    path?: readonly PropertyKey[],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<T>;
  getCellFromEntityId<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[],
    schema: S,
    tx?: IExtendedStorageTransaction,
    scope?: NormalizedFullLink["scope"],
  ): Cell<Schema<S>>;
  getCellFromEntityId(
    space: MemorySpace,
    entityId: EntityId | string,
    path: readonly PropertyKey[] = [],
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    scope: NormalizedFullLink["scope"] = "space",
  ): Cell<any> {
    return this.getCellFromLink(
      {
        id: toURI(entityId),
        path: path?.map(String) ?? [],
        space,
        scope,
      },
      schema,
      tx,
    );
  }

  getCellFromLink<T>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<T>;
  getCellFromLink<S extends JSONSchema = JSONSchema>(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema: S,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<Schema<S>>;
  getCellFromLink(
    cellLink: CellLink | NormalizedLink | AnyCell<unknown>,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<any> {
    const carriedLabelView = cfcLabelView ??
      (isSigilLink(cellLink)
        ? (cellLink["/"][LINK_V1_TAG] as { cfcLabelView?: CfcLabelView })
          .cfcLabelView
        : isNormalizedFullLink(cellLink)
        ? (cellLink as NormalizedLink & { cfcLabelView?: CfcLabelView })
          .cfcLabelView
        : undefined);
    let link = isCellLink(cellLink)
      ? parseLink(cellLink)
      : isNormalizedFullLink(cellLink)
      ? cellLink
      : isFullNormalizedLinkShape(cellLink)
      ? {
        ...cellLink,
        scope: isCellScope(cellLink.scope)
          ? cellLink.scope
          : normalizeCellScope(undefined),
      }
      : undefined;
    if (!link) throw new Error("Invalid cell link");
    if ("cfcLabelView" in link) {
      const { cfcLabelView: _cfcLabelView, ...cleanLink } = link as
        & NormalizedLink
        & { cfcLabelView?: CfcLabelView };
      link = cleanLink;
    }
    // Intern the schema so the link carries the canonical deep-frozen
    // instance: all downstream identity-keyed schema caches (schemaAtPath,
    // schema-ref memos, SelectorTracker standardization, value-hash) key off
    // deep-frozen identity and stay cold for mutable schema literals. The
    // explicit parameter takes precedence; a schema already embedded in the
    // link (sigil links preserve them through parseLink) is interned too, so
    // schema-bearing links don't bypass the seam. Note that this deep-freezes
    // the schema object in place — see `internCellLinkSchema` for the
    // contract and the proxy exception.
    const effectiveSchema = schema !== undefined ? schema : link.schema;
    if (effectiveSchema !== undefined) {
      link = { ...link, schema: internCellLinkSchema(effectiveSchema) };
    }
    return createCell(
      this,
      link as NormalizedFullLink,
      tx,
      false,
      undefined,
      carriedLabelView,
    );
  }

  getImmutableCell<T>(
    space: MemorySpace,
    data: T,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<T>;
  getImmutableCell<S extends JSONSchema = JSONSchema>(
    space: MemorySpace,
    data: any,
    schema: S,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<Schema<S>>;
  getImmutableCell(
    space: MemorySpace,
    data: any,
    schema?: JSONSchema,
    tx?: IExtendedStorageTransaction,
    cfcLabelView?: CfcLabelView,
  ): Cell<any> {
    const asDataURI = `data:application/json,${
      encodeURIComponent(JSON.stringify({ value: data }))
    }` as const as `${string}:${string}`;
    return createCell(
      this,
      {
        space,
        path: [],
        id: asDataURI,
        schema: internCellLinkSchema(schema),
      },
      tx,
      false,
      undefined,
      cfcLabelView,
    );
  }

  getHomeSpaceCell(
    tx?: IExtendedStorageTransaction,
  ): Cell<SpaceCellContents> {
    return this.getCell(
      this.userIdentityDID,
      this.userIdentityDID,
      spaceCellSchema,
      tx,
    ) as Cell<SpaceCellContents>;
  }

  /**
   * Returns the DID for a named `PatternFactory.inSpace("name")` target if it
   * has already been resolved (or is itself a DID), otherwise `undefined`.
   *
   * Synchronous so the pattern builder can route a child result into the target
   * space at graph-construction time. On a miss, the caller records the name as
   * pending and the runner resolves it via {@link resolveSpaceName} before
   * re-running the handler/action (see RetryImmediately).
   */
  resolveSpaceNameSync(name: string): MemorySpace | undefined {
    if (isMemorySpaceDID(name)) return name as MemorySpace;
    return this.spaceNameToDid.get(name);
  }

  /**
   * Resolves a named `inSpace` target to a DID, caching the result.
   *
   * NOTE(#1): The derivation is intentionally name-based for now — `createSession`
   * derives the space key from the name alone (the identity is ignored on the
   * `spaceName` path), so equal names map to the same shared space across users.
   * This is the deliberate "shared profile space" behaviour today; revisit once
   * we can derive unique space DIDs from a string.
   */
  async resolveSpaceName(name: string): Promise<MemorySpace> {
    const cached = this.resolveSpaceNameSync(name);
    if (cached !== undefined) return cached;
    const session = await createSession({
      identity: this.storageManager.as as unknown as Identity,
      spaceName: name,
    });
    // SECURITY INVARIANT: consume ONLY the resolved space DID. `createSession`
    // may also derive a per-name space identity (private key); we must never
    // adopt it as a signer here. Writes to the resolved space stay authorized
    // as the active user (`storageManager.as`) and are gated per-space by the
    // memory server's ACL, so resolving a name can never grant write access the
    // caller does not already hold.
    const did = session.space as MemorySpace;
    this.spaceNameToDid.set(name, did);
    return did;
  }

  // Convenience methods that delegate to the runner
  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>> {
    return this.runner.setup<T, R>(tx, patternOrModule, argument, resultCell);
  }
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Cell<R> {
    return this.runner.run<T, R>(tx, patternOrModule, argument, resultCell);
  }

  runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
  ) {
    return this.runner.runSynced(resultCell, pattern, inputs);
  }

  start<T = any>(resultCell: Cell<T>): Promise<boolean> {
    return this.runner.start(resultCell);
  }

  /**
   * The host explicitly known to serve a space, if any: the seed map
   * wins, then runtime-learned hints (site table). Undefined means
   * "no per-space fact" — callers choose their own default (storage
   * and hostForSpace use apiUrl; LLM/fetch keep their module-level
   * defaults, which may deliberately differ from apiUrl).
   */
  mappedHostFor(space: MemorySpace): string | undefined {
    return this.spaceHostMap?.[space] ?? this.#dynamicHosts.get(space);
  }

  /**
   * The host that serves a space's space-bound work (LLM, fetch, blob).
   * A mapped space resolves to its host; everything else to the
   * default `apiUrl`. The single compute-side analogue of the storage
   * layer's per-space address resolver.
   */
  hostForSpace(space: MemorySpace): URL {
    return new URL(this.mappedHostFor(space) ?? this.apiUrl);
  }

  /**
   * Record a runtime-learned host hint for a space (the v0 site-table
   * flow). Storage decides first — the seed map wins and an opened
   * space is never silently re-pointed — and compute routing follows
   * exactly when storage accepted, keeping the two layers in agreement.
   * Returns whether the hint is in effect.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    const accept = this.storageManager.registerSpaceHost?.(space, host);
    if (accept === undefined) return false; // manager has no remote resolution
    if (accept) this.#dynamicHosts.set(space, host);
    return accept;
  }

  /**
   * True iff the default host AND every distinct mapped host are
   * reachable — one runtime can span hosts, so health is the
   * conjunction over all of them.
   */
  async healthCheck(): Promise<boolean> {
    const hosts = new Set([this.apiUrl.toString()]);
    for (
      const host of [
        ...Object.values(this.spaceHostMap ?? {}),
        ...this.#dynamicHosts.values(),
      ]
    ) {
      try {
        hosts.add(new URL(host).toString());
      } catch {
        return false; // a malformed mapped host is unhealthy by definition
      }
    }
    const checks = [...hosts].map(async (host) => {
      try {
        const res = await fetch(new URL("/_health", host));
        return res.ok;
      } catch (_) {
        return false;
      }
    });
    return (await Promise.all(checks)).every(Boolean);
  }
}
