import {
  getModernCellRepConfig,
  resetModernCellRepConfig,
  setModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { dataUriFromValue } from "@commonfabric/data-model/data-uri-codec";
import { fabricFromNativeValue } from "@commonfabric/data-model/fabric-value";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { createSession, Identity } from "@commonfabric/identity";
import {
  commitPreconditionValueHash,
  getCommitPreconditionsConfig,
  getPersistentSchedulerStateConfig,
  resetCommitPreconditionsConfig,
  resetPersistentSchedulerStateConfig,
  setCommitPreconditionsConfig,
  setPersistentSchedulerStateConfig,
  setSyncSchemaTableConfig,
} from "@commonfabric/memory/v2";
import { RuntimeTelemetry } from "@commonfabric/runner";
import {
  getContentAddressedSchemasConfig,
  setContentAddressedSchemasConfig,
} from "./schema-doc-config.ts";
import { StaticCache } from "@commonfabric/static";
import {
  type AsyncLocalStore,
  FallbackAsyncLocalStore,
} from "@commonfabric/utils/async-local-store";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { isDeno } from "@commonfabric/utils/env";

import { PatternEnvironment, setPatternEnvironment } from "./builder/env.ts";
import { popFrame, pushFrame } from "./builder/pattern.ts";
import type {
  AnyCell,
  Frame,
  JSONSchema,
  Module,
  NodeFactory,
  Pattern,
  Schema,
} from "./builder/types.ts";
import { registerBuiltins } from "./builtins/index.ts";
import {
  type Cell,
  createCell,
  internCellLinkSchema,
  isCell,
  schemaCellScope,
} from "./cell.ts";
import {
  buildCfcPolicySnapshot,
  buildCfcTrustConfig,
  type CfcDeclaredMonotonicityMode,
  type CfcEnforcementMode,
  type CfcFlowLabelsMode,
  type CfcLabelMetadataProtectionMode,
  type CfcLabelView,
  type CfcPolicyEvaluationMode,
  type CfcPolicyRecordInput,
  type CfcPrefixProvenanceSummary,
  type CfcTriggerReadGating,
  type CfcTrustConfig,
  type CfcTrustConfigInput,
  type CfcWriteFloorMode,
  DEFAULT_SINK_MAX_CONFIDENTIALITY,
  externalIngestStamp,
  flowLabelWorkExists,
  gatedSinkRequestExists,
  linkCfcLabelView,
  type PolicySnapshot,
  type SinkMaxConfidentiality,
  type TrustSnapshot,
} from "./cfc/mod.ts";
import {
  cfcPolicyManifestDocId,
  type PolicyArtifactManifestV1,
  validateCfcPolicyArtifactManifest,
} from "./cfc/policy.ts";
import { createRef, EntityId } from "./create-ref.ts";
import type { ConsoleMethod } from "./harness/console.ts";
import { Engine } from "./harness/index.ts";
import type { CompiledModuleArtifact } from "./harness/types.ts";
import type { ConsoleMessage } from "./interface.ts";
import { addressKey } from "./link-types.ts";
import {
  CellLink,
  isCellLink,
  isNormalizedFullLink,
  isSigilLink,
  type NormalizedFullLink,
  NormalizedLink,
  parseLink,
} from "./link-utils.ts";
import { ModuleRegistry } from "./module.ts";
import type { PatternCoverageCollector } from "./pattern-coverage.ts";
import { PatternManager } from "./pattern-manager.ts";
import { PatternUpdater } from "./pattern-updater.ts";
import { snapshotQueryResult } from "./query-result-proxy.ts";
import { AsyncSemaphoreQueue, type QueueConfig } from "./queue.ts";
import { type PieceSourceTransition, Runner } from "./runner.ts";
import { Action, Scheduler } from "./scheduler.ts";
import {
  type CommitBackpressurePolicy,
  resolveCommitBackpressure,
} from "./scheduler/backpressure.ts";
import { isCellScope, normalizeCellScope } from "./scope.ts";
import { normalizeSpaceHost, SpaceHostValidationError } from "./space-host.ts";
import { flattenBuilderArtifacts } from "./storage-preflight.ts";
import { ExtendedStorageTransaction } from "./storage/extended-storage-transaction.ts";
import type {
  ChangeGroup,
  CommitError,
  DID,
  IExtendedStorageTransaction,
  IStorageManager,
  MemorySpace,
  URI,
} from "./storage/interface.ts";
import { isRetryableCommitRejection } from "./storage/rejection.ts";
import type {
  WriteStackTraceEntry,
  WriteStackTraceMatcher,
} from "./storage/write-stack-trace.ts";
import {
  getWriteStackTrace,
  setWriteStackTraceMatchers,
} from "./storage/write-stack-trace.ts";
import type { NonIdempotentReport } from "./telemetry.ts";
import {
  createUnsafeHostTrustToken,
  type UnsafeHostTrust,
  type UnsafeHostTrustOptions,
} from "./unsafe-host-trust.ts";
import { toURI } from "./uri-utils.ts";

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

// Deno/Node `AsyncLocalStorage` when available, the promise-aware fallback
// otherwise. The `await import` stays here (not in the shared utils module): a
// top-level await in widely-imported utils stalls Deno module evaluation.
const WriteDebugContextStorage = (isDeno()
  // deno-lint-ignore cf-imports/no-inline-module-import
  ? (await import("node:async_hooks")).AsyncLocalStorage
  : FallbackAsyncLocalStore) as new <T>() => AsyncLocalStore<T>;

// @ts-ignore - This is temporary to debug integration test
Error.stackTraceLimit = 500;

export const DEFAULT_MAX_RETRIES = 5;

export type { IExtendedStorageTransaction, MemorySpace };

export interface ConsoleHandlerOutput {
  method: ConsoleMethod;
  args: any[];
  target?: Console;
}

export type ConsoleHandler = (
  message: ConsoleMessage,
) => any[] | ConsoleHandlerOutput;

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
 * can be enabled incrementally. Passed via `RuntimeOptions.experimental`;
 * lower-layer flags are propagated to their ambient control points, while
 * runtime-owned flags remain scoped to the Runtime instance.
 *
 * See the formal spec at `docs/specs/space-model-formal-spec/`.
 *
 * Every experimental flag in the repository — these options, the CFC
 * enforcement dials below, and the storage, memory-protocol, and shell flags —
 * is catalogued in `docs/development/EXPERIMENTAL_OPTIONS.md`. Update that
 * registry when adding, changing, or removing a flag.
 */
export interface ExperimentalOptions {
  /** Enable the modern "cell representation" classes. */
  modernCellRep?: boolean | undefined;
  /**
   * Link writers replace inline schemas with references to
   * content-addressed schema documents
   * (`docs/specs/content-addressed-schemas.md`, Phases 1 and 2): link
   * writers stamp references, and selectors externalize opportunistically
   * when their closure is already persisted in the target space. Gates
   * emission only; readers and the server accept both forms
   * unconditionally. Defaults to off.
   */
  contentAddressedSchemas?: boolean | undefined;
  /** Persist scheduler observations and use them for scheduler rehydration. */
  persistentSchedulerState?: boolean | undefined;
  /** Enforce scheduler-v2 lineage and event-receipt commit preconditions (default on). */
  commitPreconditions?: boolean | undefined;
  /**
   * Project a handler's plain JSON return into its per-event receipt cell
   * instead of the empty `{}` witness, so a caller — or a same-id retry that
   * collides on the receipt — can read the verb's result back by receipt
   * address. Reactive-bearing returns already project via the result-pattern
   * path; this covers plain values, which are otherwise discarded. Defaults
   * to on since the invocation-protocol integration proof (#5244's
   * three-topic fixture; verb contract,
   * docs/history/plans/pattern-verb-contract-implementation.md WS-C/WS-D).
   * Pass `false` (or `EXPERIMENTAL_PLAIN_RESULT_RECEIPTS=false`) as a
   * temporary rollback override while the flag exists.
   */
  plainResultReceipts?: boolean | undefined;
  /**
   * Mint computed-scheme entity ids (`computed:fid1:<hash>`) for derived
   * internal cells classified as replayable by the builder. Gates minting
   * only; readers accept both forms unconditionally. Defaults to on; pass
   * `false` as a temporary rollback override. See
   * `docs/specs/computed-cell-identity.md`.
   */
  computedCellIds?: boolean | undefined;
  /**
   * Materialize a lift's argument lazily: the body reads the paths it touches
   * and nothing else, instead of the whole of what its schema selects. A
   * reader that touches data the schema no longer describes refuses, and the
   * run is disposed of as an argument that did not resolve. On by default; pass
   * `false` as a temporary rollback override. See
   * `docs/plans/lazy-cell-materialization.md`.
   */
  lazyMaterialization?: boolean | undefined;
  /**
   * Roll toolshed-backed patterns forward in place when their source serves a
   * newer content identity. Persisted default roots reconcile before start;
   * other patterns check in the background after instantiation. Default off;
   * enabled per deployment once CI golden-replay coverage exists. See
   * docs/specs/pattern-imports/pattern-updates.md.
   */
  systemPatternAutoUpdate?: boolean | undefined;
}

/**
 * Content-addressed cache of compiled MODULE BYTES, injected via
 * `RuntimeOptions.moduleByteCache`. The ESM cell-cache compile path consults it
 * before the per-space storage read — a full hit skips both the storage read and
 * the whole transform-and-emit step (`compileToModules`) — and populates it after
 * a compile, so a module compiled in one runtime or space serves another
 * compiling the same module.
 *
 * Entries are keyed by a module's content identity scoped by the compiled-set
 * `runtimeVersion`; the emitted bytes are a deterministic function of that pair
 * (the emitter strips the whole-program path prefix, so a module's bytes are the
 * same in every program that contains it), so a hit always returns the bytes the
 * identity addresses.
 *
 * The runtime defines only this interface. The implementation, and its
 * persistence, live in test code, so the cache is instantiated only from tests
 * and never in production.
 */
export interface ModuleByteCache {
  /**
   * The cached bodies for `identities` iff EVERY identity is present, else
   * `undefined`. The transform-and-emit step is whole-program, so only a full
   * set lets a compile skip it.
   */
  getCompleteSet(
    runtimeVersion: string,
    identities: readonly string[],
  ): Map<string, CompiledModuleArtifact> | undefined;

  /**
   * Store a freshly compiled (or reused) module set, keyed by content identity
   * scoped by `runtimeVersion`. Idempotent and content-addressed.
   */
  putAll(
    runtimeVersion: string,
    modules: readonly ({ identity: string } & CompiledModuleArtifact)[],
  ): void;
}

export type RuntimeFetch = (
  input: RequestInfo | URL,
  init?: RequestInit & { client?: Deno.HttpClient },
) => Promise<Response>;

/**
 * One pattern materialization: the content-addressed pointer, where it landed,
 * and the entry file it came from.
 *
 * `main` is the program's entry filename (repo-root-relative, e.g.
 * `/packages/patterns/system/home.tsx`). It is what lets a later run map a
 * RECORDED identity back to a source file and compile today's version of it —
 * without it the record says a pattern was here but not which pattern.
 */
export interface PatternInstantiation {
  identity: string;
  symbol: string;
  main?: string;
  /** The result cell the pattern was materialized onto. */
  cell: NormalizedFullLink;
}

export type PatternInstantiationObserver = (
  instantiation: PatternInstantiation,
) => void;

export interface RuntimeOptions {
  apiUrl: URL;
  /**
   * Optional map from space DIDs to HTTP or HTTPS origins. Space-bound work
   * (LLM calls, fetches, blob uploads) for a mapped space targets
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
   * Called once for every pattern this runtime materializes onto a result
   * cell, with the content-addressed pointer and where it landed.
   *
   * Exists for the pattern-update state-continuity capture
   * (`tasks/pattern-vintage-run.ts`), which needs the list of update targets a
   * run produced. The store durably labels every root with its
   * `patternIdentity`, but there is no way to ENUMERATE those labels: the `_`
   * wildcard selector is unimplemented, and `sqliteQuery` reaches a
   * cell-derived db rather than the space store. Observing instantiation is
   * how the list is obtained at all — not a second copy of something already
   * readable.
   *
   * Capture-time only. Leave unset in production; a throwing callback is the
   * caller's bug and is not caught here.
   */
  onPatternInstantiated?: PatternInstantiationObserver;
  /**
   * Flow-label propagation dial (S16 default transition). Defaults to `off`.
   * Propagation requires enforcement mode ≥ `observe` to run at the commit
   * boundary; it derives and persists labels but never rejects by itself.
   */
  cfcFlowLabels?: CfcFlowLabelsMode;
  /**
   * Write-side `requiredIntegrity` floor dial (§8.12.4.1 / SC-18, Epic D3).
   * Defaults to `off`. `observe` evaluates the floor and emits diagnostics;
   * `enforce` records a prepare reason on a floor miss (rejecting the commit
   * under the enforcing enforcement modes). The floor tests the written
   * value's integrity, never the consumed-read set.
   */
  cfcWriteFloor?: CfcWriteFloorMode;
  /**
   * Trigger-read gating on the enforcement side (§8.9.2 / SC-3, Epic H5).
   * Defaults to `false`. When true, the addresses whose invalidating writes
   * scheduled a reactive rerun join the consumed set the sink-request egress
   * ceiling and input-requirement gates quantify over (fail-closed; extra
   * metadata resolution per prepare).
   */
  cfcTriggerReadGating?: CfcTriggerReadGating;
  /**
   * Exchange-rule policy evaluation dial (Epic B5, spec §4.4.5). Defaults to
   * `off` (gates decide on raw labels, byte-identical to before the dial).
   * `observe` evaluates gated labels to fixpoint and emits diagnostics while
   * still deciding on the un-rewritten label; `enforce` decides on the
   * rewritten label and fails closed on fuel exhaustion.
   */
  cfcPolicyEvaluation?: CfcPolicyEvaluationMode;
  /**
   * Cross-space label-metadata representation dial (inv-12 Stage 1 / SC-25,
   * spec §4.6.4.1; docs/specs/cfc-label-metadata-confidentiality.md §2/§5).
   * Defaults to `off` (persisted label bytes identical to before the dial).
   * `observe` computes the classification-governed transformed form for
   * cross-space entries and emits a structured divergence diagnostic while
   * persisting verbatim; `enforce` persists the transformed form (commitment
   * fields as `{digestOf: <hash>}` markers). Representation only — never
   * rejects a commit by itself.
   */
  cfcLabelMetadataProtection?: CfcLabelMetadataProtectionMode;
  /**
   * Declared-component monotonicity gate dial (WP5, spec §8.12.1/§8.12.8;
   * docs/specs/cfc-persisted-declassification.md §4 item 3). Defaults to
   * `off` (the declared re-mint persists exactly what it does today).
   * `observe` compares each re-minted declared labelMap entry against the
   * stored declared entry at the same path and emits a structured diagnostic
   * on a non-monotone re-mint while persisting today's bytes; `enforce`
   * records a fail-closed prepare reason (rejecting the commit under the
   * enforcing enforcement modes). Governs ONLY the `declared` component —
   * derived/link/structure components keep their §8.12.8 disciplines.
   */
  cfcDeclaredMonotonicity?: CfcDeclaredMonotonicityMode;
  /**
   * Per-prepare D4 write-prefix precision counters (value-level provenance
   * Stage 0 — docs/specs/cfc-value-level-provenance.md §6, SC-24). Defaults
   * to `false`: the prepare gate then skips all measurement, paying a single
   * presence check. When `true`, each prepared transaction with at least one
   * protected write aggregates prefix-vs-transaction-global gated-read
   * counts, bound-source classifications and S7-exemption fires into
   * `getCfcStats()`. Measurement only — enforcement decisions are
   * byte-identical either way.
   */
  cfcPrefixProvenanceStats?: boolean;
  /** Per-sink confidentiality ceilings for the sink-request egress gate. A sink
   *  absent from the map is ungated; a declared ceiling rejects (or, in observe
   *  mode, flags) a request carrying confidentiality outside it. Defaults to
   *  none declared (`DEFAULT_SINK_MAX_CONFIDENTIALITY`). */
  cfcSinkMaxConfidentiality?: SinkMaxConfidentiality;
  /**
   * Deployment policy records for the exchange-rule evaluator (Epic B2a,
   * spec §4.3). Validated, digested, and deep-frozen into a `PolicySnapshot`
   * at construction — malformed records throw at boot (fail-closed config,
   * mirroring the sink ceilings' freeze discipline). Defaults to none
   * configured (evaluation is a no-op).
   */
  cfcPolicyRecords?: readonly CfcPolicyRecordInput[];
  /**
   * Deployment trust config for concept-guard satisfaction (Epic B3, spec
   * §4.8): trust statements, verifier delegations, concept edges. Validated,
   * digested, and deep-frozen at construction; malformed config throws at
   * boot. The config digest folds into the DEFAULT trust-snapshot provider's
   * `revision`, so a config change invalidates prepared digests; hosts
   * supplying a custom `trustSnapshotProvider` must fold their own trust
   * versioning into `revision`. Defaults to none configured (every concept
   * guard fails closed).
   */
  cfcTrustConfig?: CfcTrustConfigInput;
  /** Deterministic provider for the trust snapshot attached to each new tx. */
  trustSnapshotProvider?: () => TrustSnapshot | undefined;
  /** Replace runner-owned frames with `<CF_INTERNAL>` in surfaced stacks. */
  hideInternalStackFrames?: boolean;
  /**
   * Tuning for committed-write backpressure under contention. Unset fields fall
   * back to DEFAULT_COMMIT_BACKPRESSURE; tests use this to shrink the backoff
   * and retry window. See scheduler/backpressure.ts.
   */
  commitBackpressure?: Partial<CommitBackpressurePolicy>;
  /**
   * Process-level, content-addressed cache of compiled MODULE BYTES, shared
   * across runtimes. When set, the ESM cell-cache compile path consults it before
   * the per-space storage read and populates it after a compile, so a module
   * compiled in one runtime or space serves another runtime or space compiling
   * the same module. When unset, the byte cache is off and only the per-space
   * cache applies. Holds emitted JS only, never live pattern instances. See
   * {@link ModuleByteCache}.
   */
  moduleByteCache?: ModuleByteCache;
  /**
   * Statement-coverage collector for authored patterns. When set, every compile
   * this runtime performs is instrumented — the transformer injects a hit call
   * in front of each authored statement — and the collector receives the hits.
   * The compiled-byte caches (the process byte cache and the per-space durable
   * cell cache) key the instrumented variant separately from the ordinary one,
   * so an instrumented and an uninstrumented compile of the same source never
   * collide, and a runtime with coverage on never serves or stores uninstrumented
   * bytes. A per-compile `patternCoverage` option still overrides this default.
   * Test-and-CI only; production runtimes leave it unset. See
   * packages/runner/src/pattern-coverage.ts and docs/development/COVERAGE.md.
   */
  patternCoverage?: PatternCoverageCollector;
  /**
   * Override for the outbound `fetch` used by network builtins (`fetchJson` et al).
   * Defaults to the host `globalThis.fetch`. Scoped to this runtime instance, so
   * a test harness can inject a deterministic mock without mutating process
   * globals. (LLM calls mock separately, at the `LLMClient` layer.)
   */
  fetch?: RuntimeFetch;
}

export interface CfcRuntimeStats {
  cfcRelevantTx: number;
  cfcPreparedTx: number;
  cfcPrepareRejects: number;
  cfcDigestInvalidations: number;
  cfcOutboxFlushes: number;
  sinkDedupHits: number;
  sinkReleaseRejects: number;
  // Stage-0 D4 write-prefix precision counters
  // (docs/specs/cfc-value-level-provenance.md §6, SC-24). All zero unless
  // `cfcPrefixProvenanceStats` is enabled. Aggregated over the per-prepare
  // summaries; the per-write detail lists are not retained here.
  /** Prepares that measured at least one protected write. */
  prefixProvenanceSummaries: number;
  /** Protected writes measured (requiredIntegrity / maxConfidentiality). */
  prefixProtectedWrites: number;
  /** Gated reads under the shipped D4 per-write prefix. */
  prefixGatedReads: number;
  /** What the pre-D4 transaction-global gate would have counted. */
  prefixTxGlobalGatedReads: number;
  /** Writes bounded by a logged overlapping attempt (prefix engaged). */
  prefixBoundReal: number;
  /** Writes on the +Infinity fallback (no logged overlapping attempt). */
  prefixBoundInfinityFallback: number;
  /** Writes with no ordered write-attempt evidence at all (clock-less). */
  prefixBoundClockLess: number;
  /** S7 provenance-only exemption fires within prefixes. */
  prefixS7ExemptionFires: number;
  /** Read activities without a clock position (treated at -Infinity). */
  prefixClockLessReads: number;
}

const initialCfcRuntimeStats = (): CfcRuntimeStats => ({
  cfcRelevantTx: 0,
  cfcPreparedTx: 0,
  cfcPrepareRejects: 0,
  cfcDigestInvalidations: 0,
  cfcOutboxFlushes: 0,
  sinkDedupHits: 0,
  sinkReleaseRejects: 0,
  prefixProvenanceSummaries: 0,
  prefixProtectedWrites: 0,
  prefixGatedReads: 0,
  prefixTxGlobalGatedReads: 0,
  prefixBoundReal: 0,
  prefixBoundInfinityFallback: 0,
  prefixBoundClockLess: 0,
  prefixS7ExemptionFires: 0,
  prefixClockLessReads: 0,
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

const CFC_POLICY_MANIFEST_DOC_SCHEMA = {
  type: "object",
  additionalProperties: true,
} as const satisfies JSONSchema;

export interface SpaceCellContents {
  defaultPattern: Cell<unknown>;
}

type RuntimeSetupOptions = {
  patternRepository?: string;
  pieceSourceTransition?: PieceSourceTransition;
  initializePieceSourceHistory?: boolean;
  initialPieceSourceOrigin?: string;
  reapplyStoredSetup?: boolean;
  prepareForResume?: boolean;
};

function isMemorySpaceDID(value: string): boolean {
  return /^did:[^:]+:.+/.test(value);
}

/**
 * Helper for `Runtime.getImmutableCell()`, which tells the storage preflight
 * what a `Cell` stands for -- the sigil link naming it -- and leaves everything
 * else to the walk. A cell has no fabric representation of its own, so one
 * reached anywhere inside a value bound for the data model has to become its
 * link first.
 */
function cellAsLink(value: object | ((...args: never[]) => unknown)): unknown {
  return isCell(value) ? value.toSigilLinkOrNull() : value;
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
  readonly patternUpdater: PatternUpdater;
  readonly moduleRegistry: ModuleRegistry;
  readonly harness: Engine;
  readonly runner: Runner;
  readonly navigateCallback?: NavigateCallback;
  readonly pieceCreatedCallback?: PieceCreatedCallback;
  readonly cfcEnforcementMode: CfcEnforcementMode;
  /** See `RuntimeOptions.onPatternInstantiated`. */
  readonly onPatternInstantiated?: PatternInstantiationObserver;
  readonly cfcFlowLabels: CfcFlowLabelsMode;
  readonly cfcWriteFloor: CfcWriteFloorMode;
  readonly cfcTriggerReadGating: CfcTriggerReadGating;
  readonly cfcPolicyEvaluation: CfcPolicyEvaluationMode;
  readonly cfcLabelMetadataProtection: CfcLabelMetadataProtectionMode;
  readonly cfcDeclaredMonotonicity: CfcDeclaredMonotonicityMode;
  readonly cfcPrefixProvenanceStats: boolean;
  readonly cfcSinkMaxConfidentiality: SinkMaxConfidentiality;
  /** Frozen deployment policy snapshot; undefined = no policies configured. */
  readonly cfcPolicySnapshot: PolicySnapshot | undefined;
  /** Frozen deployment trust config; undefined = no trust configured. */
  readonly cfcTrustConfig: CfcTrustConfig | undefined;
  readonly staticCache: StaticCache;
  readonly storageManager: IStorageManager;
  /** Optional process-level compiled-module-byte cache; see RuntimeOptions. */
  readonly moduleByteCache?: ModuleByteCache;
  /** Optional pattern statement-coverage collector; see RuntimeOptions. */
  readonly patternCoverage?: PatternCoverageCollector;
  readonly trustSnapshotProvider: () => TrustSnapshot | undefined;
  readonly telemetry: RuntimeTelemetry;
  /** Resolved experimental flags (all properties present with built-in defaults). */
  readonly experimental: ExperimentalOptions;
  /** Resolved committed-write backpressure policy (all fields present). */
  readonly commitBackpressure: CommitBackpressurePolicy;
  readonly apiUrl: URL;
  readonly spaceHostMap?: Record<string, string>;
  /**
   * Outbound `fetch` used by network builtins (e.g. `fetchJson`). Defaults to
   * the host `globalThis.fetch`; a test harness can inject a mock via
   * `RuntimeOptions.fetch`.
   */
  readonly fetch: RuntimeFetch;
  /** Runtime-learned host hints (site table); see registerSpaceHost. */
  #dynamicHosts = new Map<string, string>();
  readonly userIdentityDID: DID;
  /** Cache of resolved PatternFactory.inSpace("name") space DIDs. */
  private readonly spaceNameToDid = new Map<string, MemorySpace>();
  private defaultFrame?: Frame;
  private queues = new Map<string, AsyncSemaphoreQueue>();
  private writeDebugContext = new WriteDebugContextStorage<string>();
  private cfcStats: CfcRuntimeStats = initialCfcRuntimeStats();
  readonly #policyManifests = new Map<string, PolicyArtifactManifestV1>();
  readonly #policyManifestSpaces = new Map<string, Set<MemorySpace>>();
  // Attesting space -> successor module identity -> direct predecessor
  // identities whose writer authority it inherits. Entries come only from
  // verified source closures or integrity-valid compiled closures in that same
  // space. Transactions receive a transitive, immutable snapshot at creation
  // so an in-flight authorization decision cannot change when another module
  // loads, and authorization in one space can never borrow another space's
  // delegation metadata.
  readonly #moduleDelegations = new Map<
    MemorySpace,
    Map<string, Set<string>>
  >();

  registerModuleDelegations(
    space: MemorySpace,
    delegations: ReadonlyMap<string, ReadonlySet<string>>,
  ): void {
    if (typeof space !== "string" || space.length === 0) return;
    const spaceDelegations = this.#moduleDelegations.get(space) ?? new Map();
    for (const [identity, predecessors] of delegations) {
      if (typeof identity !== "string" || identity.length === 0) continue;
      const merged = spaceDelegations.get(identity) ?? new Set<string>();
      for (const predecessor of predecessors) {
        if (
          typeof predecessor === "string" && predecessor.length > 0 &&
          predecessor !== identity
        ) {
          merged.add(predecessor);
        }
      }
      if (merged.size > 0) spaceDelegations.set(identity, merged);
    }
    if (spaceDelegations.size > 0) {
      this.#moduleDelegations.set(space, spaceDelegations);
    }
  }

  private moduleDelegationSnapshot(): Map<
    MemorySpace,
    ReadonlyMap<string, readonly string[]>
  > {
    const snapshot = new Map<
      MemorySpace,
      ReadonlyMap<string, readonly string[]>
    >();
    for (const [space, spaceDelegations] of this.#moduleDelegations) {
      const spaceSnapshot = new Map<string, readonly string[]>();
      for (const identity of spaceDelegations.keys()) {
        const inherited = new Set<string>();
        const pending = [...(spaceDelegations.get(identity) ?? [])];
        while (pending.length > 0) {
          const predecessor = pending.pop()!;
          if (predecessor === identity || inherited.has(predecessor)) continue;
          inherited.add(predecessor);
          pending.push(...(spaceDelegations.get(predecessor) ?? []));
        }
        if (inherited.size > 0) {
          spaceSnapshot.set(identity, [...inherited].sort());
        }
      }
      if (spaceSnapshot.size > 0) {
        snapshot.set(space, spaceSnapshot);
      }
    }
    return snapshot;
  }

  registerCfcPolicyManifests(
    space: MemorySpace | undefined,
    inputs: readonly unknown[],
  ): void {
    for (const input of inputs) {
      const artifact = validateCfcPolicyArtifactManifest(input);
      const existing = this.#policyManifests.get(artifact.policyDigest);
      // Reaching this branch requires a collision in the canonical SHA-256
      // digest: validation recomputes the digest for both artifacts.
      if (existing !== undefined && !deepEqual(existing, artifact)) {
        throw new Error(
          `cfcPolicyManifest: immutable digest collision for ${artifact.policyDigest}`,
        );
      }
      this.#policyManifests.set(artifact.policyDigest, artifact);
      let spaces = this.#policyManifestSpaces.get(artifact.policyDigest);
      if (spaces === undefined) {
        spaces = new Set();
        this.#policyManifestSpaces.set(artifact.policyDigest, spaces);
      }
      if (space !== undefined) spaces.add(space);
    }
  }

  resolveCfcPolicyManifest(
    reference: unknown,
    tx?: IExtendedStorageTransaction,
    destinationSpace?: MemorySpace,
    bindCommit = true,
  ): PolicyArtifactManifestV1 | undefined {
    if (tx === undefined) return this.#registeredCfcPolicyManifest(reference);
    if (destinationSpace !== undefined) {
      return this.#readCfcPolicyManifest(
        destinationSpace,
        reference,
        tx,
        bindCommit,
      );
    }
    let artifact: PolicyArtifactManifestV1 | undefined;
    const spaces = new Set<MemorySpace>();
    const log = tx.getReactivityLog?.();
    for (const address of [...(log?.writes ?? []), ...(log?.reads ?? [])]) {
      spaces.add(address.space);
    }
    for (const space of spaces) {
      artifact = this.#readCfcPolicyManifest(space, reference, tx);
      if (artifact !== undefined) {
        if (bindCommit) {
          artifact = this.#readCfcPolicyManifest(space, reference, tx, true);
        }
        break;
      }
    }
    return artifact;
  }

  #registeredCfcPolicyManifest(
    reference: unknown,
  ): PolicyArtifactManifestV1 | undefined {
    if (
      !reference || typeof reference !== "object" || Array.isArray(reference)
    ) {
      return undefined;
    }
    const candidate = reference as Record<string, unknown>;
    if (typeof candidate.policyDigest !== "string") return undefined;
    const artifact = this.#policyManifests.get(candidate.policyDigest);
    return artifact !== undefined &&
        artifact.manifest.moduleIdentity === candidate.moduleIdentity &&
        artifact.manifest.symbol === candidate.symbol
      ? artifact
      : undefined;
  }

  hasCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx?: IExtendedStorageTransaction,
  ): boolean {
    const artifact = tx === undefined
      ? this.#registeredCfcPolicyManifest(reference)
      : this.#readCfcPolicyManifest(space, reference, tx);
    return artifact !== undefined &&
      this.#policyManifestSpaces.get(artifact.policyDigest)?.has(space) ===
        true;
  }

  installCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx?: IExtendedStorageTransaction,
  ): boolean {
    const artifact = this.#registeredCfcPolicyManifest(reference) ??
      (tx === undefined
        ? undefined
        : this.#readCfcPolicyManifest(space, reference, tx));
    if (artifact === undefined) return false;
    if (tx !== undefined) {
      const cell = this.getCellFromEntityId(
        space,
        cfcPolicyManifestDocId(artifact.policyDigest),
        [],
        CFC_POLICY_MANIFEST_DOC_SCHEMA,
        tx,
      );
      const existing = snapshotQueryResult(cell.get());
      if (existing === undefined) {
        cell.set(artifact);
        tx.markCreateOnly?.(cell.getAsNormalizedFullLink());
      } else {
        let verified: PolicyArtifactManifestV1;
        try {
          verified = validateCfcPolicyArtifactManifest(existing);
        } catch (error) {
          throw new Error(
            `cfcPolicyManifest: invalid destination artifact for ${artifact.policyDigest}`,
            { cause: error },
          );
        }
        if (!deepEqual(verified, artifact)) {
          throw new Error(
            `cfcPolicyManifest: immutable destination collision for ${artifact.policyDigest}`,
          );
        }
      }
    }
    // Both registered and durable-loaded artifacts pass through
    // registerCfcPolicyManifests(), which creates this companion set.
    const spaces = this.#policyManifestSpaces.get(artifact.policyDigest)!;
    spaces.add(space);
    return true;
  }

  #readCfcPolicyManifest(
    space: MemorySpace,
    reference: unknown,
    tx: IExtendedStorageTransaction,
    bindCommit = false,
  ): PolicyArtifactManifestV1 | undefined {
    if (
      !reference || typeof reference !== "object" || Array.isArray(reference)
    ) return undefined;
    const candidate = reference as Record<string, unknown>;
    if (typeof candidate.policyDigest !== "string") return undefined;
    const cell = this.getCellFromEntityId(
      space,
      cfcPolicyManifestDocId(candidate.policyDigest),
      [],
      CFC_POLICY_MANIFEST_DOC_SCHEMA,
      tx,
    );
    const stored = snapshotQueryResult(cell.get());
    if (bindCommit) {
      const link = cell.getAsNormalizedFullLink();
      const rawStored = tx.readOrThrow({
        space: link.space,
        id: link.id,
        scope: link.scope,
        type: "application/json",
        path: ["value"],
      });
      const alreadyWritten = tx.getReactivityLog?.().writes.some((address) =>
        address.space === link.space && address.id === link.id &&
        address.scope === link.scope
      ) ?? false;
      if (!alreadyWritten) {
        if (!tx.addCommitPrecondition) {
          throw new Error(
            "cfcPolicyManifest: storage cannot bind manifest consultation",
          );
        }
        tx.addCommitPrecondition(space, {
          kind: "entity-value-hash",
          id: link.id,
          scope: link.scope,
          valueHash: rawStored === undefined
            ? null
            : commitPreconditionValueHash(rawStored),
        });
      }
    }
    if (stored === undefined) return undefined;
    let artifact: PolicyArtifactManifestV1;
    try {
      artifact = validateCfcPolicyArtifactManifest(stored);
    } catch {
      return undefined;
    }
    if (
      artifact.policyDigest !== candidate.policyDigest ||
      artifact.manifest.moduleIdentity !== candidate.moduleIdentity ||
      artifact.manifest.symbol !== candidate.symbol
    ) return undefined;
    this.registerCfcPolicyManifests(space, [artifact]);
    return artifact;
  }

  constructor(options: RuntimeOptions) {
    this.experimental = {
      modernCellRep: undefined,
      persistentSchedulerState: undefined,
      commitPreconditions: undefined,
      plainResultReceipts: undefined,
      computedCellIds: undefined,
      lazyMaterialization: undefined,
      ...options.experimental,
    };

    // Log any overridden experimental flags. Never on stdout: the cf CLI's
    // machine-readable output (`cf piece ls` etc.) is consumed by scripts, and
    // this banner made every command's stdout non-empty under a flag override.
    // Not console.error/warn either: the cf test console enforcement fails
    // tests on those. Direct process stderr in Deno; plain console in browser
    // realms (no stdout contract there).
    const overrideFlags = Object.entries(this.experimental)
      .filter(([_, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${v}`);
    if (overrideFlags.length > 0) {
      const banner = `Experimental flag overrides: ${overrideFlags.join(", ")}`;
      if (typeof Deno !== "undefined" && Deno.stderr) {
        Deno.stderr.writeSync(new TextEncoder().encode(banner + "\n"));
      } else {
        console.log(banner);
      }
    }

    // Unlike ambient flags, computedCellIds and plainResultReceipts are
    // consumed from this Runtime instance (the builder frame and the runner's
    // receipt-only branch respectively). Normalize their local defaults after
    // override logging so an omitted option does not appear as an explicit
    // `true` override.
    this.experimental.computedCellIds ??= true;
    this.experimental.plainResultReceipts ??= true;
    this.experimental.lazyMaterialization ??= true;

    // Propagate experimental flags to their ambient control points, then read
    // back the effective state so `experimental.*` reflects what is actually in
    // effect (matters when the caller didn't pass an explicit value and the
    // default happens to be `true`; without this, consumers would see
    // `undefined` and probably get very confused).
    setModernCellRepConfig(this.experimental.modernCellRep);
    this.experimental.modernCellRep = getModernCellRepConfig();
    setContentAddressedSchemasConfig(
      this.experimental.contentAddressedSchemas,
    );
    this.experimental.contentAddressedSchemas =
      getContentAddressedSchemasConfig();
    if (this.experimental.contentAddressedSchemas) {
      // Content-addressed schema references and the sync schema table dedupe
      // the same link-schema positions; a reference-bearing link never needs
      // frame compression, so a flag-on process stops negotiating the table
      // entirely rather than running both mechanisms. Ambient and one-way
      // like the flag itself: once any runtime in the realm enables the
      // flag, the table stays off for the process.
      setSyncSchemaTableConfig(false);
    }
    setPersistentSchedulerStateConfig(
      this.experimental.persistentSchedulerState,
    );
    this.experimental.persistentSchedulerState =
      getPersistentSchedulerStateConfig();
    setCommitPreconditionsConfig(this.experimental.commitPreconditions);
    this.experimental.commitPreconditions = getCommitPreconditionsConfig();

    this.commitBackpressure = resolveCommitBackpressure(
      options.commitBackpressure,
    );

    this.id = options.storageManager.id;
    this.apiUrl = new URL(options.apiUrl);
    // Validate eagerly, mirroring the storage layer's resolver: a
    // malformed host should fail at configuration time naming the
    // space, not mid-builtin as a bare Invalid URL.
    const normalizedSpaceHostMap: Record<string, string> = {};
    for (const [space, host] of Object.entries(options.spaceHostMap ?? {})) {
      let route: URL;
      try {
        route = normalizeSpaceHost(host);
      } catch (cause) {
        if (!(cause instanceof SpaceHostValidationError)) throw cause;
        throw new Error(
          `Invalid spaceHostMap entry for ${space}`,
          { cause },
        );
      }
      normalizedSpaceHostMap[space] = route.toString();
    }
    // Snapshot + freeze: the map is fixed for the runtime's lifetime
    // (the per-space provider cache and routing decisions assume
    // space → host never changes), so a caller mutating their object
    // after construction must not change routing.
    this.spaceHostMap = options.spaceHostMap
      ? Object.freeze(normalizedSpaceHostMap)
      : undefined;
    // Default is a late-bound wrapper that reads `globalThis.fetch` at call time,
    // preserving the existing behavior where a test overrides the global AFTER
    // constructing the runtime (e.g. fetch-mutex-core.test.ts). An injected
    // mock is used as-is.
    this.fetch = options.fetch ??
      ((input, init) => globalThis.fetch(input, init));
    this.staticCache = isDeno()
      ? StaticCache.fromFileSystem()
      : new StaticCache(new URL("/static", this.apiUrl));

    this.telemetry = options.telemetry ?? new RuntimeTelemetry();

    // Create harness first (no dependencies on other services)
    this.harness = new Engine(this, {
      hideInternalStackFrames: options.hideInternalStackFrames,
    });

    this.storageManager = options.storageManager;
    // Hand the storage layer the telemetry bus so it can emit the
    // storage.push/pull markers (duck-typed: only the v2 StorageManager
    // implements it; emulated/test managers simply don't have the method).
    (this.storageManager as {
      setTelemetry?: (telemetry: RuntimeTelemetry) => void;
    }).setTelemetry?.(this.telemetry);
    this.moduleByteCache = options.moduleByteCache;
    this.patternCoverage = options.patternCoverage;
    // Validated + digested + frozen before the trust-snapshot provider
    // default below, whose `revision` covers the config digest (a trust
    // config change must invalidate prepared digests like any other
    // trust-snapshot change — see RuntimeOptions.cfcTrustConfig).
    this.cfcTrustConfig = buildCfcTrustConfig(options.cfcTrustConfig);
    const actingPrincipal = options.storageManager.as.did() as DID;
    const trustRevision = this.cfcTrustConfig === undefined
      ? this.id
      : `${this.id}/trust:${this.cfcTrustConfig.digest}`;
    this.trustSnapshotProvider = options.trustSnapshotProvider ?? (() => ({
      id: `principal:${actingPrincipal}`,
      actingPrincipal,
      revision: trustRevision,
    }));
    this.userIdentityDID = options.storageManager.as.did() as DID;
    this.moduleRegistry = new ModuleRegistry(this);
    this.patternManager = new PatternManager(this);
    this.patternUpdater = new PatternUpdater(this);
    this.runner = new Runner(this);
    this.onPatternInstantiated = options.onPatternInstantiated;
    this.cfcEnforcementMode = options.cfcEnforcementMode ??
      "enforce-explicit";
    this.cfcFlowLabels = options.cfcFlowLabels ?? "off";
    this.cfcWriteFloor = options.cfcWriteFloor ?? "off";
    this.cfcTriggerReadGating = options.cfcTriggerReadGating ?? false;
    this.cfcPolicyEvaluation = options.cfcPolicyEvaluation ?? "off";
    this.cfcLabelMetadataProtection = options.cfcLabelMetadataProtection ??
      "off";
    this.cfcDeclaredMonotonicity = options.cfcDeclaredMonotonicity ?? "off";
    this.cfcPrefixProvenanceStats = options.cfcPrefixProvenanceStats ?? false;
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
    // Validates + digests + deep-freezes; throws on malformed records so a
    // config error surfaces at boot, not as a silently inert rule (same
    // eager-validation posture as the spaceHostMap URLs above).
    this.cfcPolicySnapshot = buildCfcPolicySnapshot(options.cfcPolicyRecords);

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
   * Wait for reactive quiescence: no scheduler pass running, no queued events,
   * no background scheduler work. Does NOT wait for issued commits to be
   * confirmed by the server (`scheduler.idleWithPendingCommits()`), for async
   * builtin I/O (`settled()`), or for storage sync (`storageManager.synced()`).
   */
  idle(): Promise<void> {
    return this.scheduler.idle();
  }

  // In-flight async builtin operations — the work async builtins (fetchJson,
  // fetchProgram, llm/llmDialog, reactive sqlite queries, and navigation)
  // perform AFTER their handler returns, from a post-commit outbox flush: a
  // network / LLM / navigation call or a sqlite RPC, plus any result writeback.
  // `idle()` deliberately does NOT wait for these; `settled()` does.
  //
  // Each entry carries the pattern run it belongs to, as the address key of the
  // run's result cell — the `parentCell` every raw builtin is handed. Entries
  // with no owner belong to no single run: the scheduler's commit promises,
  // which are the barrier that a fire-and-forget builtin's outbox flush has
  // registered its own work. `settledFor` waits for those as well as the run's
  // own, because that handoff is how the run's work first becomes visible.
  #pendingAsyncWork = new Map<Promise<unknown>, string | undefined>();

  /**
   * Register an in-flight async builtin operation so `settled()` waits for it
   * instead of racing the post-commit flush. The scheduler registers an
   * effect-bearing commit's promise here (a race-free barrier — the flush runs
   * inside that commit), and the fire-and-forget builtins register their
   * network/LLM promise. Normalized to always resolve (failures are settled, not
   * thrown) and auto-removed once it settles, so a rejecting promise is safe and
   * never leaks.
   *
   * `owner` is the pattern run the work belongs to — the `parentCell` a raw
   * builtin is given, which is the result cell of the run that instantiated it.
   * Passing it is what lets `settledFor` wait for one run rather than the whole
   * runtime. Omit it only for work that belongs to no single run.
   */
  trackAsyncWork(promise: Promise<unknown>, owner?: Cell<any>): void {
    const tracked = promise.then(() => {}, () => {});
    const ownerKey = owner === undefined
      ? undefined
      : addressKey(owner.getAsNormalizedFullLink());
    this.#pendingAsyncWork.set(tracked, ownerKey);
    tracked.finally(() => this.#pendingAsyncWork.delete(tracked));
  }

  /**
   * Wait until the runtime is fully settled: the scheduler is idle, storage is
   * synced, AND every in-flight async builtin operation (`trackAsyncWork`) has
   * completed — including the reactive cascade its result writeback triggers.
   * This is the "wait for everything, including async builtin I/O" companion to
   * `idle()` (which intentionally returns before that I/O so handlers don't
   * block on the network). Bounded: a builtin whose result re-triggers more
   * async work converges in a few rounds.
   */
  async settled(maxRounds = 50): Promise<void> {
    for (let round = 0; round < maxRounds; round++) {
      // Use the commit-aware scheduler barrier. A successful handler commit can
      // synchronously schedule a deferred result pattern (notably navigateTo)
      // from its commit callback; plain idle() can resolve in the gap before
      // that callback queues the next scheduler turn. The joint barrier
      // rechecks scheduler work whenever pending commits drain.
      await this.scheduler.idleWithPendingCommits();
      await this.storageManager.synced();
      if (this.#pendingAsyncWork.size === 0) return;
      await Promise.allSettled([...this.#pendingAsyncWork.keys()]);
    }
  }

  /**
   * Wait until one pattern run has quiesced: the scheduler is idle including
   * in-flight commits, storage is synced, and no tracked async work belongs
   * either to `owner` or to nobody. Re-checked until all of those hold at once,
   * because each can restart the others.
   *
   * This is `settled()` narrowed to a single run. The narrowing matters where
   * `settled()` cannot be used at all: a caller that is itself running inside
   * tracked work — an LLM tool call, which runs inside its turn's promise —
   * would wait on the promise it is inside.
   *
   * The answer it gives is "this run is doing nothing further", which is what
   * distinguishes a run that finished having written nothing from one still
   * working. It is not "the run wrote a result": the caller reads the result
   * cell afterwards and finds whatever landed, including nothing.
   *
   * `idleWithPendingCommits()` rather than plain `idle()`, because a run's
   * result writeback travels through a commit and a plain idle can resolve
   * while that commit is still going to the server.
   *
   * Unlike `settled()` this carries no round cap. A cap would put a ceiling on
   * how much work a run may do before the barrier reports it finished anyway,
   * and a barrier that returns while the run is still working answers the
   * caller's question wrongly and silently. Each round awaits real promises, so
   * a run that keeps working keeps the barrier open rather than spinning.
   *
   * `signal` stops the loop for a caller that no longer needs the answer —
   * typically because it raced this against something that resolved first, and
   * without it an unbounded loop would outlive the caller.
   */
  async settledFor(
    owner: Cell<any>,
    signal?: AbortSignal,
  ): Promise<void> {
    const ownerKey = addressKey(owner.getAsNormalizedFullLink());
    while (!signal?.aborted) {
      await this.scheduler.idleWithPendingCommits();
      await this.storageManager.synced();
      const relevant = [...this.#pendingAsyncWork]
        .filter(([, key]) => key === undefined || key === ownerKey)
        .map(([promise]) => promise);
      if (relevant.length === 0) return;
      await Promise.allSettled(relevant);
    }
  }

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
   *
   * `closeStorage: false` leaves the storage manager OPEN for a caller that
   * OWNS it and is still using it — a second runtime sharing the same store, or
   * one that reads the store after this runtime is done writing to it. Every
   * other step still runs, which is the point: quiescing the WRITER is what
   * makes a subsequent read of the store a statement about a state this runtime
   * actually reached. `idle()` and `synced()` cannot substitute, because they
   * say nothing about the background work that only teardown stops —
   * `patternUpdater`'s source checks and the runner's pointer-commit
   * roll-forwards both live outside the scheduler and can still commit. That
   * path also drains in-flight async builtin work first; see below.
   *
   * It is about OWNERSHIP, not survivability. `close()` destroys the manager's
   * providers and rotates its session id rather than latching it shut, so what
   * a later write does is a matter of circumstance rather than contract — all
   * measured: over a caller-held server, a write to a doc the replica never saw
   * lands, a retrying writer (`editWithRetry`) recovers, and a bare `commit()`
   * to a doc the replica already knew fails its stale-read precondition and
   * LOSES the write; over `StorageManager.emulate`, which owns its server,
   * closing strands everything. A callee cannot see which of those its caller
   * is in, so it hands the decision back rather than betting on the recovery.
   *
   * Passing `false` makes closing the CALLER's job — nothing else will. Note
   * `await using` / `[Symbol.asyncDispose]` always takes the closing path.
   *
   * Either way this resets the PROCESS-GLOBAL experimental config to defaults
   * (`resetModernCellRepConfig` and friends). Under a non-default flag that is
   * visible to a second runtime still running against the same store, which is
   * exactly the caller this option serves — so set the flags per process, not
   * per runtime, if two of them must agree.
   */
  async dispose(
    { closeStorage = true }: { closeStorage?: boolean } = {},
  ): Promise<void> {
    try {
      // A kept store keeps RECORDING, so this path drains what could still write
      // into it. In-flight async builtin work is that shape: a fetch / llm call or
      // a sqlite RPC runs from a post-commit outbox flush and writes its result
      // back when it lands, and `trackAsyncWork` exists because neither `idle()`
      // nor `synced()` waits for it. `settled()` is the barrier that does. The
      // closing path skips it because a caller who let the store close has no
      // reader left to mislead, and waiting on the network in every teardown is a
      // real cost; here the caller is about to read what this runtime wrote.
      //
      // BEFORE the cancellation below, not after: `stopAll()` and
      // `scheduler.dispose()` would cut a writeback's reactive cascade midway,
      // leaving the store holding part of a result — which is worse than either
      // extreme for a reader trying to learn what state this runtime reached.
      //
      // UNCAPPED, deliberately. `settled()`'s default 50 rounds falls out of the
      // loop and returns — silently, with work still outstanding — which is
      // exactly the hole this drain exists to close, one layer down. Measured: 60
      // generations of chained tracked work, and a capped drain returned at
      // generation 50 while the chain kept running and writing. `settledFor`'s
      // JSDoc gives the reason a cap is wrong for this question and why removing
      // it cannot spin: every round awaits real promises, so a runtime that keeps
      // working keeps the barrier open rather than busy-looping.
      if (!closeStorage) await this.settled(Infinity);
      // Abort any pending (not-yet-started) queued jobs so they don't start
      // after storage is torn down.
      for (const queue of this.queues.values()) {
        queue.abortPending();
      }
      this.queues.clear();
      // Stop all running docs
      this.runner.stopAll();

      // Background source checks are deliberately outside the scheduler. Abort
      // and settle them before the storage sessions they may write through close.
      await this.patternUpdater.dispose();

      // Same contract for the runner's unloadable-pointer roll-forward commits
      // (CT-1923): settle before their storage sessions close. Commits only —
      // never the watcher pattern LOADS, which can be held/wedged arbitrarily
      // long and are lifecycle-epoch-guarded instead.
      await this.runner.settlePointerCommits();

      // Scheduler background work can still be using storage, for example the
      // lifecycle-guarded boot-time persistent-state listing. Let that finish
      // before tearing down storage sessions.
      await this.scheduler.idle();

      // Clear module registry
      this.moduleRegistry.clear();

      // Cancel all storage operations
      if (closeStorage) await this.storageManager.close();

      // Wait for any pending operations
      await this.scheduler.idle();
    } finally {
      // Released whatever happened above. `storageManager.close()` can reject
      // — through a provider's `replica.close()` — and it is the one await here
      // that can. Every statement below is synchronous field-clearing that
      // cannot fail in turn, so running them on the error path costs nothing
      // while skipping them strands the process: the config resets are
      // PROCESS-GLOBAL, and one skipped leaves a non-default experimental flag
      // set for every runtime built afterwards, with nothing to put it back.
      //
      // The error still propagates. What changes is how much has been released
      // by the time it does, not whether disposal fails.
      //
      // The unsubscribes come last, and after the final `idle()` above, because
      // a subscriber removed earlier would miss notifications the settling work
      // still depends on.
      this.scheduler.dispose();
      this.runner.dispose();

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
    }

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
      resolvePolicyManifest: (
        reference,
        tx,
        destinationSpace,
        bindCommit,
      ) =>
        this.resolveCfcPolicyManifest(
          reference,
          tx,
          destinationSpace,
          bindCommit,
        ),
      hasPolicyManifest: (space, reference, tx) =>
        this.hasCfcPolicyManifest(space, reference, tx),
      installPolicyManifest: (space, reference, tx) =>
        this.installCfcPolicyManifest(space, reference, tx),
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
      // Stage-0 D4 precision counters: installed only when the deployment
      // opted in, so the default prepare path skips all measurement.
      ...(this.cfcPrefixProvenanceStats
        ? {
          onPrefixProvenance: (summary: CfcPrefixProvenanceSummary) => {
            this.cfcStats.prefixProvenanceSummaries += 1;
            this.cfcStats.prefixProtectedWrites += summary.protectedWrites;
            this.cfcStats.prefixGatedReads += summary.prefixGatedReads;
            this.cfcStats.prefixTxGlobalGatedReads +=
              summary.txGlobalGatedReads;
            this.cfcStats.prefixBoundReal += summary.boundSources.real;
            this.cfcStats.prefixBoundInfinityFallback +=
              summary.boundSources.infinityFallback;
            this.cfcStats.prefixBoundClockLess +=
              summary.boundSources.clockLess;
            this.cfcStats.prefixS7ExemptionFires += summary.s7ExemptionFires;
            this.cfcStats.prefixClockLessReads += summary.clockLessReads;
          },
        }
        : {}),
    });
    wrapped.setCfcEnforcementMode(this.cfcEnforcementMode);
    wrapped.setCfcFlowLabelsMode(this.cfcFlowLabels);
    wrapped.setCfcWriteFloorMode(this.cfcWriteFloor);
    wrapped.setCfcTriggerReadGating(this.cfcTriggerReadGating);
    wrapped.setCfcPolicyEvaluationMode(this.cfcPolicyEvaluation);
    wrapped.setCfcLabelMetadataProtectionMode(this.cfcLabelMetadataProtection);
    wrapped.setCfcDeclaredMonotonicityMode(this.cfcDeclaredMonotonicity);
    wrapped.setCfcSinkMaxConfidentiality(this.cfcSinkMaxConfidentiality);
    wrapped.setCfcPolicySnapshot(this.cfcPolicySnapshot);
    wrapped.setCfcTrustConfig(this.cfcTrustConfig);
    wrapped.setCfcModuleDelegations(this.moduleDelegationSnapshot());
    wrapped.setCfcTrustSnapshot(this.trustSnapshotProvider());
    return wrapped;
  }

  // (space, scope, id) triples for which a missing-link-target load has been
  // kicked this session. The kicked sync establishes a live per-doc
  // subscription, so a later creation of the doc still arrives — one kick per
  // doc suffices. Scope is part of the key: scoped instances (user/session)
  // are distinct docs, and a kick for one scope must not suppress another's.
  private missingDocLoadKicks = new Set<string>();

  /**
   * Asynchronously load a link target that a read found absent from the
   * local replica. Cross-space targets (CT-1667): per-space server queries
   * cannot follow links across space boundaries, so the client must fetch
   * such targets itself. Same-space targets (fresh-replica read asymmetry):
   * a rejecting-selector sync delivers only the root doc, so a link can
   * point at a doc no selector ever walked — those are fetched only when
   * the local replica has never seen the doc (`shouldPullDoc`), so reads of
   * genuinely absent optional values do not become repeated server queries.
   * Fire-and-forget, but registered as a cross-space promise so
   * `storageManager.synced()` and `Cell.pull()`'s convergence loop can await
   * it; the absent doc is a tracked read, so the reader re-runs on arrival.
   * Deduped per (space, id): the kicked sync leaves a live subscription
   * behind, so repeat kicks add nothing.
   */
  ensureLinkedDocLoaded(
    link: NormalizedFullLink,
    sourceSpace?: MemorySpace,
  ): void {
    const { space, id, scope } = link;
    const key = `${space}\0${normalizeCellScope(scope)}\0${id}`;
    if (this.missingDocLoadKicks.has(key)) return;
    // A same-space target the replica already has state for (or a manager
    // without lazy replication) needs no fetch.
    const sameSpace = sourceSpace === space;
    const mgr = this.storageManager;
    const reserved = sameSpace &&
      mgr.shouldPullDoc?.(space, id, scope) === true;
    if (sameSpace && !reserved) return;
    this.missingDocLoadKicks.add(key);
    mgr.trackUntilSettled(
      this.getCellFromLink(link).sync().catch(() => {
        // Allow a retry on failure (e.g. transient disconnect): clear this
        // dedup set, and hand back the storage manager's reservation when
        // THIS kick took it — a cross-space kick never reserved, and must
        // not clear a reservation a concurrent same-space read holds.
        this.missingDocLoadKicks.delete(key);
        if (reserved) mgr.retractDocPullKick?.(space, id, scope);
      }),
    );
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
   * If the transaction fails with a RETRYABLE commit rejection, it will be
   * retried up to maxRetries times. Retryability is decided by the shared
   * rejection vocabulary (`isRetryableCommitRejection`, storage/rejection.ts),
   * which is an allow-list: a stale basis (server conflict or the local
   * inconsistency guard), a liveness failure the memory client heals on its own
   * (a transport failure, an undecodable frame), a discarded attempt
   * (`tx.abort()` or a CFC pre-storage refusal), or an authorization denial the
   * server itself marked `retriable`. Every other rejection — an ACL/protocol
   * refusal, an authorization denial, a precondition failure, a commit-rule
   * violation, a `SessionError` (nothing on this path remounts the session, so
   * every attempt reuses the handle the server just refused) — is returned on
   * the FIRST attempt, because re-running cannot change the outcome and each
   * doomed attempt costs a round-trip plus a subscriber revert notification.
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
    return tx.commit().then(async ({ error }) => {
      if (error) {
        if (maxRetries > 0 && isRetryableCommitRejection(error)) {
          // A CONFLICT means this replica is behind the authoritative
          // version: re-running immediately re-reads the same stale local
          // state and fails identically, so without waiting the retries all
          // burn on one deterministic conflict (CT-1824 — the compile-cache
          // write-back looped this way and stale-version pieces recompiled
          // on every cold boot). The conflict carries the catch-up gate;
          // await it so the retry runs against fresh state — same protocol
          // as the scheduler's conflict handling (scheduler/action-run.ts).
          // A readiness gate that rejects (session closed/replaced while
          // waiting) is control flow, not an error: retry anyway and let
          // commit produce the definitive outcome.
          const readyToRetry =
            (error as { readyToRetry?: () => unknown }).readyToRetry;
          if (typeof readyToRetry === "function") {
            try {
              await readyToRetry();
            } catch {
              // Readiness aborted — the retry's commit decides.
            }
          }
          // The catch-up gate advances the session past the conflicting
          // commit, but a doc this replica never READ does not arrive with
          // it — and a conflicted blind WRITE means exactly that (the
          // compile-cache write-back rewrites derived docs a cold replica
          // has never seen). Pull the named doc so the retry's write
          // carries its true version instead of re-asserting seq 0.
          const conflict = (error as {
            conflict?: { space?: MemorySpace; of?: string };
          }).conflict;
          if (
            conflict?.space !== undefined &&
            typeof conflict.of === "string" &&
            conflict.of !== "of:unknown"
          ) {
            try {
              await this.storageManager.open(conflict.space).sync(
                conflict.of as unknown as URI,
                { path: [], schema: false },
              );
            } catch {
              // Pull failed — the retry's commit decides.
            }
          }
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
      // A vouched ingest still needs its provenance mark minted even where CFC
      // enforcement is disabled (an explicit `cfcEnforcementMode: "disabled"`
      // opt-in — no shipped host today; toolshed passes no CFC options and so
      // runs the enforce-explicit default). The mint
      // is a builtin-authored boundary-commit step that never rejects, so run
      // prepare for it explicitly rather than forcing the enforcement dial up
      // (which would desync ingest txs from the runtime's real mode). The
      // stamp already marked the tx relevant; nothing else here applies when
      // disabled, so fall straight through to prepareCfc.
      if (externalIngestStamp(tx) !== undefined) {
        if (state.prepare.status === "unprepared") {
          tx.prepareCfc();
        }
      }
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
        ? linkCfcLabelView(cellLink)
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

  /**
   * Makes a read-only cell whose content is `data`, carried entirely in the
   * cell's own `data:` URI id; there is no document in a space to fetch.
   *
   * **Contract note:** `data` is an arbitrary value, deliberately NOT
   * limited to `FabricValue`. Callers pass, among other things, `Cell`
   * objects (wish candidate lists), userland event payloads (whatever
   * patterns and the DOM hand over, `Date`s and `Error`s included), and
   * pattern-authored schema defaults. A `Cell` becomes its sigil link on the
   * way in, by `cellAsLink()`; the conversion itself has no
   * representation for one. Everything past that converts via
   * `fabricFromNativeValue()`, the designed intake for exactly this: native
   * instances become their fabric counterparts, and input that is already a
   * deep-frozen `FabricValue` passes through by identity.
   *
   * @param space The space the cell claims as its own (it is not stored
   *   there; links within relate to it).
   * @param data The value to carry. Must be acyclic.
   * @param schema Optional schema for the resulting cell.
   * @param tx Optional transaction for the resulting cell.
   * @param cfcLabelView Optional CFC label view for the resulting cell.
   * @returns A read-only cell whose value is (the fabric conversion of)
   *   `data`.
   */
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
    // Not `dataUriFromValueWithResolvedLinks()`: its link-rewriting walk is
    // unwanted here (this data is immutable as given).
    //
    // Builder artifacts become their encodable form and cells become sigil
    // links HERE rather than at each caller. Neither has a fabric
    // representation, so both have to go before the value reaches
    // `fabricFromNativeValue()`. This is the designed intake, and the callers
    // are many: raw and JavaScript node inputs, wish candidates, schema
    // defaults. Covering them one at a time was tried and is whack-a-mole --
    // each site that is missed fails as a rejection at the conversion, or worse
    // as a cleanup error that masks it.
    //
    // One walk covers both. A cell is a leaf to it -- what stands in for a cell
    // is the link it names, not a container to descend into -- and an
    // artifact's encodable form is walked in turn, so a cell inside one is
    // reached as well.
    const asDataURI = dataUriFromValue(
      fabricFromNativeValue(
        flattenBuilderArtifacts(data, { replaceOther: cellAsLink }),
      ),
    );
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
   * This is the deliberate "shared profile space" behavior today; revisit once
   * we can derive unique space DIDs from a string.
   */
  async resolveSpaceName(name: string): Promise<MemorySpace> {
    const cached = this.resolveSpaceNameSync(name);
    if (cached !== undefined) return cached;
    const session = await createSession({
      identity: this.storageManager.as as unknown as Identity,
      spaceName: name,
    });
    // Register the derived identity only as fresh-space ACL bootstrap
    // authority. Storage continues to authenticate ordinary reads and writes
    // as the active user (`storageManager.as`), so resolving a name does not
    // grant an existing space's key to the caller.
    if (session.spaceIdentity) {
      this.storageManager.registerSpaceIdentity?.(session.spaceIdentity);
    }
    const did = session.space as MemorySpace;
    this.spaceNameToDid.set(name, did);
    return did;
  }

  // Convenience methods that delegate to the runner
  syncStoredSetupArgument(
    resultCell: Cell<unknown>,
  ): Promise<(candidate: Cell<unknown>) => boolean> {
    return this.runner.syncStoredSetupArgument(resultCell);
  }

  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RuntimeSetupOptions,
  ): Promise<Cell<R>> {
    return this.runner.setup<T, R>(
      tx,
      patternOrModule,
      argument,
      resultCell,
      options,
    );
  }
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: { schedulePatternUpdate?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: { schedulePatternUpdate?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: { schedulePatternUpdate?: boolean } = {},
  ): Cell<R> {
    return this.runner.run<T, R>(
      tx,
      patternOrModule,
      argument,
      resultCell,
      options,
    );
  }

  runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
    options?: {
      expectedPatternIdentity?: { identity: string; symbol: string };
      validateCurrentArgument?: (
        argumentCell: Cell<unknown>,
      ) => void;
      validateArgumentLinks?: (
        argumentCell: Cell<unknown>,
        argumentSchema: JSONSchema,
      ) => void;
      patternRepository?: string;
      pieceSourceTransition?: PieceSourceTransition;
    },
  ) {
    return this.runner.runSynced(resultCell, pattern, inputs, options);
  }

  start<T = any>(
    resultCell: Cell<T>,
    options: { schedulePatternUpdate?: boolean } = {},
  ): Promise<boolean> {
    return this.runner.start(resultCell, options);
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
   * default `apiUrl`. The single compute-side analog of the storage
   * layer's per-space address resolver.
   */
  hostForSpace(space: MemorySpace): URL {
    return new URL(this.mappedHostFor(space) ?? this.apiUrl);
  }

  /**
   * Records a runtime-learned HTTP or HTTPS origin for a space (the v0
   * site-table flow). Storage decides first. A seed or an accepted late hint
   * fixes the route for the session. A default-host provider stays provisional
   * while it is read-only. The first hint can replace it and replay its reads.
   * Compute routing follows when storage accepts the hint. Returns whether
   * storage accepted or confirmed the hint.
   */
  registerSpaceHost(space: MemorySpace, host: string): boolean {
    let route: URL;
    try {
      route = normalizeSpaceHost(host);
    } catch (cause) {
      if (!(cause instanceof SpaceHostValidationError)) throw cause;
      throw new Error(
        `Invalid host for space ${space}`,
        { cause },
      );
    }
    const normalized = route.toString();
    const accept = this.storageManager.registerSpaceHost?.(space, normalized);
    if (accept === undefined) return false; // manager has no remote resolution
    if (accept) this.#dynamicHosts.set(space, normalized);
    return accept;
  }

  /**
   * The default host's self-reported git commit, captured from its
   * `/_health` response's `x-cf-git-sha` header by the most recent
   * `healthCheck()` call. Null before any check or when the host omits
   * the header (older servers). Read from the headers — never the body
   * — so the capture completes exactly when the health probe does; a
   * stalled or truncated body cannot delay it.
   */
  get serverGitSha(): string | null {
    return this.#serverGitSha;
  }
  #serverGitSha: string | null = null;
  #healthCheckGeneration = 0;

  /**
   * True iff the default host AND every distinct mapped host are
   * reachable — one runtime can span hosts, so health is the
   * conjunction over all of them. The optional signal cancels the requests.
   */
  async healthCheck(signal?: AbortSignal): Promise<boolean> {
    // Overlapping calls each capture into their own generation; only the
    // newest call's capture publishes, so a slow earlier response cannot
    // overwrite a newer one after the fact.
    const generation = ++this.#healthCheckGeneration;
    this.#serverGitSha = null;
    const defaultHost = this.apiUrl.toString();
    const hosts = new Set([defaultHost]);
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
        const res = await fetch(new URL("/_health", host), { signal });
        if (
          host === defaultHost && generation === this.#healthCheckGeneration
        ) {
          const sha = res.headers.get("x-cf-git-sha")?.trim();
          this.#serverGitSha = sha ? sha : null;
        }
        return res.ok;
      } catch (_) {
        signal?.throwIfAborted();
        return false;
      }
    });
    return (await Promise.all(checks)).every(Boolean);
  }
}
