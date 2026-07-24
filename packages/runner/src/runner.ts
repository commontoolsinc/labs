import {
  fabricFromNativeValue,
  type FabricValue,
  nativeFromFabricValue,
} from "@commonfabric/data-model/fabric-value";
import {
  getPersistentSchedulerStateConfig,
  type SchedulerActionSnapshotCursor,
} from "@commonfabric/memory/v2";
import type { EntityKind } from "./entity-kind.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import { rendererVDOMSchema } from "./schemas.ts";
import { forEachSubschema } from "./schema-walk.ts";
import {
  type CellScope,
  type Frame,
  isModule,
  isPattern,
  isStreamValue,
  type JSONSchema,
  JSONValue,
  type Module,
  NAME,
  type NodeFactory,
  type Pattern,
  UI,
} from "./builder/types.ts";
import {
  patternFromFrame,
  popFrame,
  pushFrameFromCause,
} from "./builder/pattern.ts";
import { type Cell, createCell, isCell } from "./cell.ts";
import { type Action } from "./scheduler.ts";
import {
  isSchedulerActionObservation,
  type PersistedSchedulerObservationSnapshot,
} from "./scheduler/persistent-observation.ts";
import { RetryImmediately } from "./scheduler/retry-immediately.ts";
import {
  findAllWriteRedirectCells,
  opaqueArgumentKeys,
  unwrapOneLevelAndBindtoDoc,
} from "./pattern-binding.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCell,
  getDerivedInternalCellLink,
  getMetaCell,
  getMetaLink,
  isAliasBinding,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  KeepAsCell,
  type NormalizedFullLink,
  parseAliasBinding,
  parseLink,
  toMemorySpaceAddress,
} from "./link-utils.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { sendValueToBinding } from "./pattern-binding.ts";
import {
  type AddCancel,
  type Cancel,
  type DeferredCancelOwnership,
  useCancelGroup,
  useDeferredCancelOwnership,
} from "./cancel.ts";
import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageProviderWithReplica,
  IStorageSubscription,
  MemorySpace,
  URI,
} from "./storage/interface.ts";
import { TransactionWrapper } from "./storage/extended-storage-transaction.ts";
import { ignoreReadForScheduling } from "./scheduler.ts";
import {
  machineryRead,
  schedulerDependencyRead,
} from "./storage/reactivity-log.ts";
import { isRawBuiltinResult, type RawBuiltinReturnType } from "./module.ts";
import "./builtins/index.ts";
import { isCellScope, narrowestScope } from "./scope.ts";
import {
  describePatternOrModule,
  extractDefaultValues,
  mergeSchemaDefaults,
  sanitizeDebugLabel,
  schemaAcceptsOpaqueCellValue,
  setRunnableName,
} from "./runner-utils.ts";
import { normalizeSandboxResult } from "./sandbox/result-normalization.ts";
import {
  resolveBuiltinImplementationIdentity,
  resolvePolicyFacingImplementationIdentity,
} from "./cfc/implementation-identity.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type ImplementationIdentity,
} from "./cfc/types.ts";
import { validateSchemaValue } from "./cfc/schema-sanitization.ts";
import { runInActionExecution } from "./builder/action-context.ts";
import { getVerifiedProvenance } from "./harness/verified-provenance.ts";
import {
  getArtifactEntryRef,
  isTrustedBuilderArtifact,
  resolveOriginal,
} from "./builder/pattern-metadata.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { setResultCell } from "./result-utils.ts";
import { SigilLink } from "./sigil-types.ts";
export {
  extractDefaultValues,
  mergeObjects,
  mergeSchemaDefaults,
  schemaAcceptsOpaqueCellValue,
  schemaHasDefaultValue,
} from "./runner-utils.ts";
export { validateAndCheckReactives } from "./sandbox/result-normalization.ts";

const logger = getLogger("runner", { enabled: true, level: "warn" });
const triggerFlowLogger = getLogger("runner.trigger-flow", {
  enabled: true,
  level: "warn",
  logCountEvery: 0,
});
const sourceLocationLogger = getLogger("runner.source-location", {
  enabled: false,
  level: "warn",
  logCountEvery: 0,
});

const EAGER_RESULT_BUILTIN_REFS = new Set([
  "fetchBinary",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "fetchText",
  "generateObject",
  "generateText",
  "llm",
  "llmDialog",
  "navigateTo",
  "streamData",
]);

type InternalCellDescriptor = {
  partialCause: JSONValue;
  /**
   * Entity kind of the materialized cell's id. Part of the manifest match
   * key alongside `partialCause`: a kind flip across pattern versions must
   * re-materialize the cell under its new id rather than reuse the old link.
   */
  kind?: EntityKind;
  link: SigilLink;
};

type StartAttempt = {
  readonly lifecycleEpoch: number;
  readonly schedulePatternUpdate: boolean;
  readonly generationsByDoc: Map<string, number>;
  readonly preResolutionStopKeys: Set<string>;
};

// The debug-name builders reuse the action's already-computed
// `schedulerActionInstanceKey` as their uniquifying suffix instead of hashing
// the same links a second time (one hashOf per action creation, not two). The
// name stays per-instance-unique — same-named actions differ in links, so the
// suffix differs; differently-named actions differ in the prefix.
function schedulerRawActionName(
  rawTargetName: string,
  instanceKey: string,
): string {
  return `raw:${rawTargetName}:${instanceKey}`;
}

function schedulerJavaScriptActionName(
  actionName: string,
  instanceKey: string,
): string {
  return `action:${actionName}:${instanceKey}`;
}

function schedulerActionLinkIdentity(link: NormalizedFullLink) {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: link.path,
  };
}

/**
 * A source-location-INDEPENDENT, per-instance discriminator for a scheduler
 * action: a short hash of the action's `{ process, reads, writes }` cell links.
 * Two instances of the same hoisted op (e.g. one `lift` called twice) differ in
 * their reads/writes, so this distinguishes them; the links are reload-stable,
 * so it is too. Unlike `schedulerJavaScriptActionName`/`schedulerRawActionName`
 * it folds in NO source-derived name, so it is independent of `fn.src` and the
 * debug annotation. It is appended to the content-addressed action id
 * (`cf:module/<hash>:<symbol>:<instanceKey>`, `getSchedulerActionId`) so that the
 * per-symbol content address stays the implementation *fingerprint* while the
 * action id — the `actionStats` key and the durable observation key — stays
 * per-*instance*. Without it, N instances of one symbol collide on a single id.
 */
function schedulerActionInstanceKey(parts: {
  process?: NormalizedFullLink;
  reads?: readonly NormalizedFullLink[];
  writes?: readonly NormalizedFullLink[];
}): string {
  return hashOf({
    process: parts.process ? schedulerActionLinkIdentity(parts.process) : null,
    reads: (parts.reads ?? []).map(schedulerActionLinkIdentity),
    writes: (parts.writes ?? []).map(schedulerActionLinkIdentity),
  }).hashString.slice(0, 12);
}

function schemaCellScope(
  schema: JSONSchema | undefined,
): CellScope | undefined {
  return isRecord(schema) && isCellScope(schema.scope)
    ? schema.scope
    : undefined;
}

function patternDefaultScope(pattern: Pattern): CellScope | undefined {
  return schemaCellScope(pattern.resultSchema) ?? pattern.defaultScope;
}

const recordOutputSchemaPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
  resultSchema: JSONSchema | undefined,
  schemaPath: readonly string[] = [],
): void => {
  if (resultSchema === undefined) {
    return;
  }

  if (isWriteRedirectLink(outputBinding) || isAliasBinding(outputBinding)) {
    const bindingBase = resultCell.getAsNormalizedFullLink();
    const bindingLink = isAliasBinding(outputBinding)
      ? parseAliasBinding(outputBinding, bindingBase)
      : parseLink(outputBinding, bindingBase);
    // Output-redirect resolution is result-plumbing machinery
    // (machineryRead, same family as sendValueToBinding's walk): its reads
    // must not consume `*`-path membership templates (bot review on this
    // PR — these resolve the SAME redirects immediately before the send).
    const link = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        resolveLink(
          runtime,
          tx,
          bindingLink,
          "writeRedirect",
        ),
    );
    const schema = schemaPath.length === 0
      ? resultSchema
      : runtime.cfc.getSchemaAtPath(resultSchema, [...schemaPath]);
    if (schema === undefined) {
      return;
    }
    for (const targetLink of [bindingLink, link]) {
      tx.recordCfcWritePolicyInput({
        kind: "schema",
        target: {
          space: targetLink.space,
          id: targetLink.id,
          scope: targetLink.scope,
          path: [...targetLink.path],
        },
        schema,
      });
    }
    return;
  }

  if (Array.isArray(outputBinding)) {
    outputBinding.forEach((child, index) =>
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
        resultSchema,
        [...schemaPath, String(index)],
      )
    );
    return;
  }

  if (isRecord(outputBinding) && !isCellLink(outputBinding)) {
    for (const [key, child] of Object.entries(outputBinding)) {
      recordOutputSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
        resultSchema,
        [...schemaPath, key],
      );
    }
  }
};

const recordSchemaPolicyInputForLink = (
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  schema: JSONSchema | undefined,
): void => {
  if (schema === undefined) {
    return;
  }
  tx.recordCfcWritePolicyInput({
    kind: "schema",
    target: {
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: [...link.path],
    },
    schema,
  });
};

const recordRawBuiltinBindingSchemaPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
): void => {
  if (isWriteRedirectLink(outputBinding) || isAliasBinding(outputBinding)) {
    const bindingBase = resultCell.getAsNormalizedFullLink();
    const bindingLink = isAliasBinding(outputBinding)
      ? parseAliasBinding(outputBinding, bindingBase)
      : parseLink(outputBinding, bindingBase);
    // Result-plumbing machinery, as in recordOutputSchemaPolicyInputs.
    const link = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        resolveLink(
          runtime,
          tx,
          bindingLink,
          "writeRedirect",
        ),
    );
    const schema = bindingLink.schema ?? link.schema;
    recordSchemaPolicyInputForLink(tx, bindingLink, schema);
    recordSchemaPolicyInputForLink(tx, link, schema);
    return;
  }

  if (Array.isArray(outputBinding)) {
    outputBinding.forEach((child) =>
      recordRawBuiltinBindingSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
      )
    );
    return;
  }

  if (isRecord(outputBinding) && !isCellLink(outputBinding)) {
    for (const child of Object.values(outputBinding)) {
      recordRawBuiltinBindingSchemaPolicyInputs(
        tx,
        runtime,
        resultCell,
        child,
      );
    }
  }
};

const schemaForRawBuiltinRootOutputBinding = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>, // used as the base for output bindings
  outputBinding: unknown,
): JSONSchema | undefined => {
  if (!isWriteRedirectLink(outputBinding) && !isAliasBinding(outputBinding)) {
    return undefined;
  }
  const bindingBase = resultCell.getAsNormalizedFullLink();
  const bindingLink = isAliasBinding(outputBinding)
    ? parseAliasBinding(outputBinding, bindingBase)
    : parseLink(outputBinding, bindingBase);
  // Result-plumbing machinery, as in recordOutputSchemaPolicyInputs.
  const link = tx.runWithAmbientReadMeta(
    machineryRead,
    () =>
      resolveLink(
        runtime,
        tx,
        bindingLink,
        "writeRedirect",
      ),
  );
  return bindingLink.schema ?? link.schema;
};

const resultForRawBuiltinOutputBinding = (
  result: unknown,
  outputBindingSchema: JSONSchema | undefined,
  builtinIdentity: ImplementationIdentity | undefined,
): unknown => {
  if (
    !isCell(result) ||
    outputBindingSchema === undefined ||
    builtinIdentity?.kind !== "builtin" ||
    builtinIdentity.builtinId !== "generateObject"
  ) {
    return result;
  }
  return result.asSchema(outputBindingSchema).getAsLink({
    includeSchema: true,
  });
};

const recordRawBuiltinResultSchemaPolicyInput = (
  tx: IExtendedStorageTransaction,
  result: unknown,
): void => {
  if (!isCell(result)) {
    return;
  }
  recordSchemaPolicyInputForLink(
    tx,
    result.getAsNormalizedFullLink(),
    result.schema,
  );
};

/**
 * Find the first write-redirect link within an output binding and return its
 * FULLY RESOLVED normalized link (`id` and `space` populated). The output spot
 * a pattern node writes through is reserved for that node, so its resolved
 * coordinates form a stable, position-derived, program-independent identity —
 * suitable as the cause for the node's result cell instead of hashing the
 * pattern object (which drags in the session-varying `program`). Returns
 * undefined if the binding contains no write redirect.
 */
function firstResolvedOutputRedirect(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  binding: unknown,
  baseCell: Cell<any>,
): NormalizedFullLink | undefined {
  if (isWriteRedirectLink(binding) || isAliasBinding(binding)) {
    const bindingBase = baseCell.getAsNormalizedFullLink();
    return resolveLink(
      runtime,
      tx,
      isAliasBinding(binding)
        ? parseAliasBinding(binding, bindingBase)
        : parseLink(binding, bindingBase),
      "writeRedirect",
    );
  }
  if (Array.isArray(binding)) {
    for (const child of binding) {
      const found = firstResolvedOutputRedirect(runtime, tx, child, baseCell);
      if (found) return found;
    }
    return undefined;
  }
  if (isRecord(binding) && !isCellLink(binding)) {
    for (const child of Object.values(binding)) {
      const found = firstResolvedOutputRedirect(runtime, tx, child, baseCell);
      if (found) return found;
    }
  }
  return undefined;
}

const recordSetupProjectionPolicyInputs = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  resultCell: Cell<any>,
  resultSchema: JSONSchema | undefined,
  projection: unknown,
  schemaPath: readonly string[] = [],
): void => {
  if (resultSchema === undefined) {
    return;
  }

  const schema = schemaPath.length === 0
    ? resultSchema
    : runtime.cfc.getSchemaAtPath(resultSchema, [...schemaPath]);
  if (schema === undefined) {
    return;
  }

  // Sigil redirects only, deliberately NOT paired with `isAliasBinding`: the
  // projection is about to be STORED (argument via diffAndUpdate, result via
  // setRawUntyped), and in stored data only sigil links function as
  // redirects — a residual `$alias` record (e.g. a still-deferred binding of
  // an embedded pattern) is inert there. The prepare gate agrees: marker
  // verification requires the stored value to be a sigil redirect
  // (`setupProjectionSourceMatchesValue`), and recording a marker for an
  // alias would wrongly widen `writeIsPatternSetupInitialization`'s
  // trusted-initialization exemption to a path nothing redirects to.
  if (isWriteRedirectLink(projection)) {
    const target = resultCell.getAsNormalizedFullLink();
    const source = parseLink(projection, target);
    tx.recordCfcWritePolicyInput({
      kind: "structural-provenance",
      target: {
        space: target.space,
        id: target.id,
        scope: target.scope,
        path: [...target.path, ...schemaPath],
      },
      claim: CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
      sources: [{
        space: source.space,
        id: source.id,
        scope: source.scope,
        path: [...source.path],
      }],
    });
    return;
  }

  if (Array.isArray(projection)) {
    projection.forEach((child, index) =>
      recordSetupProjectionPolicyInputs(
        tx,
        runtime,
        resultCell,
        resultSchema,
        child,
        [...schemaPath, String(index)],
      )
    );
    return;
  }

  if (isRecord(projection) && !isCellLink(projection)) {
    for (const [key, child] of Object.entries(projection)) {
      recordSetupProjectionPolicyInputs(
        tx,
        runtime,
        resultCell,
        resultSchema,
        child,
        [...schemaPath, key],
      );
    }
  }
};

type SetupResult<R> = {
  resultCell: Cell<R>;
  pattern?: Pattern;
  needsStart: boolean;
};

type SetupValidationOptions = {
  /** Optional layer-specific invariant checked inside the setup transaction. */
  validateArgumentLinks?: (
    argumentCell: Cell<unknown>,
    argumentSchema: JSONSchema,
  ) => void;
  /** Optional repository locator written atomically with pattern setup. */
  patternRepository?: string;
};

type RunResult<R> = {
  resultCell: Cell<R>;
  /** The exact local cancel registration installed by this invocation. */
  installedCancel?: Cancel;
  /**
   * Cancels a start that this invocation deferred until its transaction
   * commits. Before installation it tombstones the pending start; afterwards
   * it stops the piece only when this invocation actually installed it.
   */
  cancelDeferredStart?: Cancel;
};

type DeferredStartResult<R> = {
  resultCell: Cell<R>;
  cancelDeferredStart?: Cancel;
};

type BoundNodeIO = {
  inputs: FabricValue;
  outputs: FabricValue;
  reads: NormalizedFullLink[];
  writes: NormalizedFullLink[];
};

type ResolvedJavaScriptModule = {
  fn: (...args: any[]) => any;
  name: string | undefined;
};

type JavaScriptNodeContext = BoundNodeIO & {
  tx: IExtendedStorageTransaction;
  module: Module;
  resultCell: Cell<any>;
  addCancel: AddCancel;
  pattern: Pattern;
  fn: (...args: any[]) => any;
  name: string | undefined;
  schedulerRehydration: SchedulerRehydrationSubscriptionOptions;
};

type JavaScriptActionResultCells = {
  byScope: Map<CellScope, Cell<any>>;
};

type SchedulerRehydrationSubscriptionOptions = {
  rehydrateFromStorage?: {
    space: MemorySpace;
    pieceId: string;
    processGeneration: number;
    // Resumed from a synced state: propagated so container-minting builtins and
    // cross-space child runs defer their initial runs until sync too.
    awaitSync?: boolean;
    snapshotsByActionId?: ReadonlyMap<
      string,
      readonly PersistedSchedulerObservationSnapshot[]
    >;
    addressesCurrentAtOrBelow?: NonNullable<
      IStorageProviderWithReplica["areSchedulerAddressesCurrentAtOrBelow"]
    >;
    hasPendingWriteOverlapping?: NonNullable<
      IStorageProviderWithReplica["schedulerHasPendingWriteOverlapping"]
    >;
  };
  // The owning pattern instance for this reader, set unconditionally (not only
  // under persistent scheduler state) so the scheduler can group a pattern's
  // shaped cell-flip wakes by instance (timing side-channel mitigation, plan B)
  // and tell a pattern reader from internal machinery.
  observationIdentity?: {
    pieceId: string;
    ownerSpace: MemorySpace;
  };
  // Defer initial action runs until the space finishes syncing, without
  // restoring persisted scheduler state. Set for resumed patterns when
  // persistent scheduler state is disabled, so re-running actions read
  // confirmed-loaded inputs.
  awaitSyncBeforeInitialRun?: {
    space: MemorySpace;
  };
};

// Whether resumed nodes should hold their initial run until the space syncs,
// from either the rehydration path or the flag-off await-sync path. Used to
// propagate the intent to cross-space child runs and container-minting builtins.
function defersInitialRunUntilSynced(
  options: SchedulerRehydrationSubscriptionOptions,
): boolean {
  return !!(options.rehydrateFromStorage?.awaitSync ||
    options.awaitSyncBeforeInitialRun);
}

// Options shared by run()/startWithTx()/startAfterSuccessfulCommit().
type RunnerRunOptions = {
  doNotUpdateOnPatternChange?: boolean;
  // Default roots reconcile against their system source before start (or are
  // compiled from that source during creation), so their caller suppresses
  // the otherwise-automatic lazy check while retaining identity hot-swaps.
  schedulePatternUpdate?: boolean;
  // Resumed-from-synced-state: hold each action's initial rehydration/run until
  // the space has finished syncing, so consumers don't race the data.
  awaitSyncBeforeInitialRun?: boolean;
};

function dedupeNormalizedLinks(
  links: readonly NormalizedFullLink[],
): NormalizedFullLink[] {
  const deduped: NormalizedFullLink[] = [];
  for (const link of links) {
    if (deduped.some((existing) => areNormalizedLinksSame(existing, link))) {
      continue;
    }
    deduped.push(link);
  }
  return deduped;
}

export class Runner {
  readonly cancels = new Map<`${MemorySpace}/${CellScope}/${URI}`, Cancel>();
  private allCancels = new Set<Cancel>();
  private locallyPreparedResults = new Map<
    `${MemorySpace}/${CellScope}/${URI}`,
    string
  >();
  private locallyStoppedResults = new Map<
    `${MemorySpace}/${CellScope}/${URI}`,
    string
  >();
  // Successful event-result starts that are still live in this runner. This is
  // intentionally local and bounded by live starts: it lets a sequential
  // redelivery avoid re-materializing an already-won result before the
  // create-only receipt guard rejects the duplicate. It is not a replacement
  // for the system-wide commit precondition.
  private locallyCommittedHandlerResultStarts = new Set<
    `${MemorySpace}/${CellScope}/${URI}`
  >();
  // Map whose key is the result cell's full key, and whose values are the
  // patterns as strings
  private resultPatternCache = new Map<
    `${MemorySpace}/${CellScope}/${URI}`,
    string
  >();
  // Per-transaction accumulator of cross-space child spaces, so that when a
  // parent materializes several `Child.inSpace(...)` results into different
  // spaces we commit ALL child spaces before the parent (the parent's link to
  // each child must never be durable before that child's target). Each call
  // re-supplies the full order rather than replacing it with just the latest
  // child + parent. Keyed weakly by transaction so it is reclaimed with the tx.
  // Per-doc rehydration (docs/specs/scheduler-v2/per-doc-rehydration.md):
  // one space-wide snapshot listing per resumed boot, bucketed per piece doc
  // (`${scope}:${id}` of each piece's result cell). Descendants started with
  // resume intent consume their own bucket synchronously at registration.
  // Replaced by the next top-level resume load for the space; the in-flight
  // map single-flights concurrent resumes onto one listing.
  private resumeSnapshotsBySpace = new Map<
    MemorySpace,
    ReadonlyMap<
      string,
      ReadonlyMap<string, readonly PersistedSchedulerObservationSnapshot[]>
    >
  >();
  private resumeSnapshotLoads = new Map<
    MemorySpace,
    Promise<
      | ReadonlyMap<
        string,
        ReadonlyMap<string, readonly PersistedSchedulerObservationSnapshot[]>
      >
      | undefined
    >
  >();
  // Invalidates asynchronous start/resume continuations when stopAll() begins.
  // A later explicit start captures the new epoch and may proceed normally.
  private lifecycleEpoch = 0;
  // Per-result generation for starts that have not installed their cancel
  // group yet. stop(result) advances it so an in-flight sync/listing cannot
  // start that piece after the caller has already stopped it. Entries exist
  // only while at least one tracked start attempt for that doc is unsettled.
  private startGenerationByDoc = new Map<string, number>();
  private activeStartAttemptsByDoc = new Map<string, Set<StartAttempt>>();
  // Covers the pre-resolution window where a link attempt does not know its
  // eventual target doc and therefore cannot appear in the per-doc index yet.
  private activeStartAttempts = new Set<StartAttempt>();
  private crossSpaceChildSpaces = new WeakMap<
    IExtendedStorageTransaction,
    MemorySpace[]
  >();

  constructor(readonly runtime: Runtime) {
    this.runtime.storageManager.subscribe(this.createStorageSubscription());
  }

  /**
   * Creates and returns a new storage subscription.
   *
   * This will be used to remove the cached pattern information when the result
   * cell changes. As a result, if we are scheduled, we will run that pattern
   * and regenerate the result.
   *
   * @returns A new IStorageSubscription instance
   */
  private createStorageSubscription(): IStorageSubscription {
    return {
      next: (notification) => {
        const space = notification.space;
        if ("changes" in notification) {
          for (const change of notification.changes) {
            this.resultPatternCache.delete(
              `${space}/${
                change.address.scope ?? "space"
              }/${change.address.id}`,
            );
          }
        } else if (notification.type === "reset") {
          // copy keys, since we'll mutate the collection while iterating
          const cacheKeys = [...this.resultPatternCache.keys()];
          cacheKeys.filter((key) => key.startsWith(`${notification.space}/`))
            .forEach((key) => this.resultPatternCache.delete(key));
        }
        return { done: false };
      },
    };
  }

  /**
   * Prepare a piece for running by creating/updating its process and result
   * cells, registering the pattern, and applying defaults/arguments.
   * This does not schedule any nodes. Use start() to schedule execution.
   * If the piece is already running and the pattern changes, it will stop the
   * piece.
   */
  setup<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: SetupValidationOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: SetupValidationOptions,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: SetupValidationOptions = {},
  ): Promise<Cell<R>> {
    if (providedTx) {
      this.setupInternal(
        providedTx,
        patternOrModule,
        argument,
        resultCell,
        options,
      );
      return Promise.resolve(resultCell);
    } else {
      // Ignore retry/commit errors after retrying for now, as outside the tx,
      // we'll see the latest true value; it just lost the race against someone
      // else changing the pattern or argument. Correct action is anyhow similar
      // to what would have happened if the write succeeded and was immediately
      // overwritten. Still surface real callback failures from setupInternal so
      // callers don't silently continue after a broken setup.
      return this.runtime.editWithRetry((tx) => {
        this.setupInternal(tx, patternOrModule, argument, resultCell, options);
      }).then(({ error }) => {
        if (error) {
          if (
            error.name === "StorageTransactionAborted" &&
            error.message.startsWith("editWithRetry action threw:")
          ) {
            throw error.reason instanceof Error
              ? error.reason
              : new Error(error.message);
          }
          if (
            error.name === "StorageTransactionAborted" &&
            error.message.startsWith("CFC enforcement rejected commit")
          ) {
            throw new Error(error.message, { cause: error.reason });
          }
        }

        return resultCell;
      });
    }
  }

  private resolveSetupPattern(
    patternOrModule: Pattern | Module | undefined,
    previousIdentityRef: { identity: string; symbol: string } | undefined,
  ):
    | {
      pattern: Pattern;
      entryRef: { identity: string; symbol: string };
      resolvedPatternOrModule: Pattern | Module;
    }
    | undefined {
    let resolvedPatternOrModule = patternOrModule;

    // No pattern in hand: resolve the previously-stored `{ identity, symbol }`
    // pointer synchronously from the in-session artifact index (the module is
    // live this session — the reload path loaded it before reaching here).
    if (!resolvedPatternOrModule) {
      if (!previousIdentityRef) return undefined;
      const resolved = this.runtime.patternManager.artifactFromIdentitySync(
        previousIdentityRef.identity,
        previousIdentityRef.symbol,
      ) as Pattern | undefined;
      if (!resolved) {
        throw new Error(
          `Unknown pattern: ${previousIdentityRef.identity}#${previousIdentityRef.symbol}`,
        );
      }
      resolvedPatternOrModule = resolved;
    }

    const pattern = isModule(resolvedPatternOrModule)
      ? this.moduleToPattern(resolvedPatternOrModule)
      : resolvedPatternOrModule;
    const entryRef = this.entryRefForPattern(pattern);

    return { pattern, entryRef, resolvedPatternOrModule };
  }

  /**
   * The pattern pointer to record for `pattern`: its real content-addressed
   * entry ref when it has one (a compiled pattern), else a stable
   * session-synthetic ref minted for the keyless pattern object (so a separate
   * start() / setup-without-pattern can resolve it in-session). See
   * `syntheticPatternIdentity`.
   */
  private entryRefForPattern(
    pattern: Pattern,
  ): { identity: string; symbol: string } {
    const real = this.runtime.patternManager.getArtifactEntryRef(pattern);
    if (real) {
      // Artifact refs are process-global metadata on the pattern object, while
      // the addressable artifact index is runtime-local. Re-associate a pattern
      // handed to this runtime so a subsequent start-by-durable-identity can
      // resolve it even when another runtime minted the ref first.
      this.runtime.patternManager.associatePatternIdentity(
        resolveOriginal(pattern) as Pattern,
        real,
      );
      return real;
    }
    // Keyless: a content-hash session pointer (structurally-identical patterns
    // share it — no churn). See PatternManager.ensureKeylessPatternIdentity.
    return this.runtime.patternManager.ensureKeylessPatternIdentity(pattern);
  }

  private updateArgument<T>(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argument: T,
    argumentSchema: JSONSchema | undefined,
  ): void {
    const argumentCell = this.runtime.getCellFromLink(
      argumentLink,
      undefined,
      tx,
    );
    argumentCell.set(argument);
    recordSetupProjectionPolicyInputs(
      tx,
      this.runtime,
      argumentCell,
      argumentSchema,
      argument,
    );
    diffAndUpdate(
      this.runtime,
      tx,
      argumentLink,
      argument,
      argumentLink,
    );
  }

  /** Stage an argument write, materialize aliases in the same transaction, and
   * reject the transaction unless the resulting value satisfies its schema. */
  private updateAndValidateArgument<T>(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argument: T,
    argumentSchema: JSONSchema,
    defaults: FabricValue,
  ): void {
    this.updateArgument(tx, argumentLink, argument, argumentSchema);
    this.validateArgument(tx, argumentLink, argumentSchema, defaults);
  }

  private validateArgument(
    tx: IExtendedStorageTransaction,
    argumentLink: NormalizedFullLink,
    argumentSchema: JSONSchema,
    defaults: FabricValue,
  ): void {
    const argumentCell = this.runtime.getCellFromLink(
      argumentLink,
      undefined,
      tx,
    );
    const materializedArgument = argumentCell.asSchema(undefined).withTx(tx)
      .get();
    const validationArgument = mergeSchemaDefaults(
      materializedArgument,
      defaults,
      argumentSchema,
      { mergeMaterializedLinks: true },
    );
    const validationFailure = validateSchemaValue(
      argumentSchema,
      validationArgument,
      argumentSchema,
      { acceptOpaqueValue: schemaAcceptsOpaqueCellValue },
    );
    if (validationFailure !== undefined) {
      throw new Error(
        `updated arguments do not match the candidate schema: ${validationFailure}`,
      );
    }
  }

  private updateResultSchemaMeta<R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    resultSchema: JSONSchema | undefined,
  ): void {
    if (resultSchema === undefined) return;
    const cell = resultCell.withTx(tx);
    const previous = cell.getMetaRaw("schema", {
      meta: ignoreReadForScheduling,
    });
    if (!deepEqual(previous, resultSchema)) {
      cell.setMetaRaw("schema", resultSchema as FabricValue);
    }
  }

  private maybeReuseRunningSetup<T, R>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<R>,
    argument: T,
    pattern: Pattern,
    samePattern: boolean,
  ): SetupResult<R> | undefined {
    const key = this.getDocKey(resultCell);
    if (!this.cancels.has(key)) return undefined;

    if (argument === undefined && samePattern) {
      return { resultCell, needsStart: false };
    }

    if (samePattern) {
      const argumentLink = getMetaLink(resultCell, "argument")!;
      const defaults = extractDefaultValues(pattern.argumentSchema);
      const nextArgument = mergeSchemaDefaults(
        argument,
        defaults,
        pattern.argumentSchema,
      );
      // Nested-pattern replay passes opaque Cell handles here. Candidate-
      // schema validation materializes the argument cell and would dereference
      // those handles before validating them, rejecting a valid `asCell` slot
      // when its payload is cold or absent. Piece API argument mutations
      // validate their exact supplied value before entering Runner;
      // pattern-changing updates always take the validated path below.
      this.updateArgument(
        tx,
        argumentLink,
        nextArgument,
        pattern.argumentSchema,
      );
      return { resultCell, needsStart: false };
    }

    return undefined;
  }

  private updateResultProjection<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<R>,
    options: { preserveName: boolean },
  ): void {
    const writableResultCell = pattern.resultSchema === undefined
      ? resultCell.withTx(tx)
      : resultCell.withTx(tx).asSchema(pattern.resultSchema);
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    let result = unwrapOneLevelAndBindtoDoc<R, any>(
      this.runtime.cfc,
      pattern.result as R,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    const previousResult = writableResultCell.getRaw({
      meta: ignoreReadForScheduling,
    });
    if (
      options.preserveName &&
      isRecord(previousResult) &&
      previousResult[NAME]
    ) {
      result = { ...result, [NAME]: previousResult[NAME] };
    }
    // TODO(danfuzz): This compares a runtime result value with `deepEqual`,
    // which mishandles `FabricValue` (same-class `FabricPrimitive`s, with state
    // in private `#fields` and zero own-props, compare equal regardless of
    // value). Use a Fabric-aware equality for value comparison.
    if (!deepEqual(result, previousResult)) {
      recordSetupProjectionPolicyInputs(
        tx,
        this.runtime,
        resultCell,
        pattern.resultSchema,
        result,
      );
      // Convert-and-freeze (default): a deep-frozen value lets the storage
      // write boundary's `cloneIfNecessary` identity-pass instead of
      // deep-cloning-to-freeze.
      writableResultCell.setRawUntyped(
        fabricFromNativeValue(result),
      );
    }
  }

  /**
   * Creates and initializes any internal cells needed for the pattern.
   *
   * @param tx
   * @param pattern
   * @param resultCell
   * @param internal a FabricValue with the existing array of InternalCellDescriptors
   * @returns a FabricValue with the array of InternalCellDescriptors
   */
  private materializeDerivedInternalCells<R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    resultCell: Cell<R>,
    internal: FabricValue,
  ): FabricValue {
    const descriptors = pattern.derivedInternalCells;
    if (!descriptors?.length) return [];

    // Our internal meta field contains a manifest with information about all
    // the individual internal cells.
    const nativeInternal = nativeFromFabricValue(internal);
    const existingManifest: InternalCellDescriptor[] =
      Array.isArray(nativeInternal)
        ? [...nativeInternal] as InternalCellDescriptor[]
        : [];
    // We'll build the updated manifest from the existing
    const manifest: InternalCellDescriptor[] = [];

    for (const descriptor of descriptors) {
      const derivedCell = getDerivedInternalCell(
        resultCell,
        descriptor,
        tx,
      );
      const manifestMatch = existingManifest.findIndex((existingDescriptor) =>
        deepEqual(existingDescriptor.partialCause, descriptor.partialCause) &&
        existingDescriptor.kind === descriptor.kind
      );
      // Re-emit the manifest link and backlink from the current descriptor on
      // every setup. A compatible setsrc may narrow an internal schema while
      // retaining the same partial cause; preserving the old manifest entry
      // would leave stale producer authority attached to that cell.
      const derivedSigilLink = derivedCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      });
      manifest.push({
        partialCause: descriptor.partialCause,
        ...(descriptor.kind !== undefined && { kind: descriptor.kind }),
        link: derivedSigilLink,
      });
      setResultCell(derivedCell, resultCell.asSchema(pattern.resultSchema));
      if (manifestMatch === -1) {
        // Seed the build-time default for the freshly created cell. The
        // manifest entry and this default are written together in one
        // transaction, so a manifest-referenced cell is already durable; on a
        // cold-cache resume its value may simply be unsynced. Reading and
        // seeding only when there is no manifest entry keeps resume read-mostly:
        // a probe read of the not-yet-loaded value would otherwise enter the
        // commit's conflict set and lose to the durable value when it streams
        // in, reverting the whole instantiation commit.
        const schemaDefault = isRecord(descriptor.schema)
          ? descriptor.schema.default as JSONValue | undefined
          : undefined;
        if (schemaDefault !== undefined) {
          const currentValue = derivedCell.getRawUntyped({
            meta: ignoreReadForScheduling,
          });
          if (currentValue === undefined) {
            derivedCell.setRawUntyped(fabricFromNativeValue(schemaDefault));
          }
        }
      }
    }

    return fabricFromNativeValue(manifest);
  }

  /**
   * When this function is first called, the resultCell may not have its
   * internal, argument, and pattern cells set up, so do that here.
   */
  private applySetupState<T, R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    entryRef: { identity: string; symbol: string } | undefined,
    samePattern: boolean,
    argument: T,
    resultCell: Cell<R>,
  ): void {
    const defaults = extractDefaultValues(pattern.argumentSchema) as Partial<T>;
    let argumentLink = getMetaLink(resultCell, "argument");
    const previousInternal = resultCell.getMetaRaw("internal", {
      meta: ignoreReadForScheduling,
    });
    const internalManifest = this.materializeDerivedInternalCells(
      tx,
      pattern,
      resultCell,
      previousInternal,
    );
    resultCell.withTx(tx).setMetaRaw("internal", internalManifest);

    let nextArgument: T | undefined = argument;
    let argumentUpdated = false;
    // The argument meta field of the result cell should be a link to the
    // argument cell. If it doesn't exist, we need to apply the defaults
    // I don't include the schema here, since I don't want cfc enforcement yet
    if (argumentLink === undefined) {
      let newArgumentCell = getMetaCell(
        resultCell,
        "argument",
        tx,
      );
      setResultCell(newArgumentCell, resultCell.asSchema(pattern.resultSchema));
      nextArgument = mergeSchemaDefaults<T>(
        argument,
        defaults,
        pattern.argumentSchema,
      );
      //newArgumentCell.set(nextArgument);

      newArgumentCell = newArgumentCell.asSchema(pattern.argumentSchema);
      const newArgumentSigilLink = newArgumentCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
      resultCell.withTx(tx).setMetaRaw("argument", newArgumentSigilLink);

      argumentLink = newArgumentCell.getAsNormalizedFullLink();
      if (argumentLink === undefined) {
        throw new Error("Invalid argument link in updateArgument");
      }
    } else if (!samePattern) {
      const previousArgumentCell = this.runtime.getCellFromLink(
        argumentLink,
        undefined,
        tx,
      );
      const previousArgument = previousArgumentCell.getRaw({
        meta: ignoreReadForScheduling,
      }) as T | undefined;
      nextArgument = mergeSchemaDefaults<T>(
        argument === undefined ? previousArgument : argument,
        defaults,
        pattern.argumentSchema,
      );

      const nextArgumentCell = previousArgumentCell.asSchema(
        pattern.argumentSchema,
      );
      const nextArgumentSigilLink = nextArgumentCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
        keepAsCell: KeepAsCell.All,
      });
      resultCell.withTx(tx).setMetaRaw("argument", nextArgumentSigilLink);
      argumentLink = nextArgumentCell.getAsNormalizedFullLink();

      // Stage the exact Fabric-layer representation before validating it. The
      // untyped materialization below resolves ordinary sigil links through
      // this same transaction without dropping fields that fail the candidate
      // schema. A thrown validation error aborts the transaction, so neither
      // this write nor the schema retarget can become durable on failure.
      if (nextArgument !== undefined) {
        this.updateAndValidateArgument(
          tx,
          argumentLink,
          nextArgument,
          pattern.argumentSchema,
          defaults,
        );
        argumentUpdated = true;
      } else {
        this.validateArgument(
          tx,
          argumentLink,
          pattern.argumentSchema,
          defaults,
        );
      }
    }
    if (nextArgument !== undefined && !argumentUpdated) {
      // A changed pattern with an existing argument either validated above or
      // produced no value to write, so this branch is only reachable for new
      // argument cells and same-pattern replay. Piece API argument mutations
      // validate their exact supplied value before entering Runner.
      this.updateArgument(
        tx,
        argumentLink,
        nextArgument,
        pattern.argumentSchema,
      );
    }

    // Record the content-addressed {identity, symbol} reference — the ONLY
    // pattern pointer — when the pattern's entry identity is known (every
    // space-compiled pattern post-E4). On reload this loads the pattern straight
    // from the compiled cache by identity (or, on a version bump, recompiles
    // from the source-doc closure). A KEYLESS hand-built pattern has no entry
    // ref and so gets no durable pointer: it is session-only (run()-only), the
    // sanctioned "keyless → session-only" behavior. The ref carries the
    // authoritative export symbol (recorded at compile/load time); we never
    // recompute it from `pattern`'s program here, since a source-free reloaded
    // pattern only has a stub program (mainExport "default"), which would
    // clobber a non-"default" export name.
    if (entryRef) {
      resultCell.withTx(tx).setMetaRaw("patternIdentity", {
        identity: entryRef.identity,
        symbol: entryRef.symbol,
      });
    }

    this.updateResultProjection(tx, pattern, resultCell.withTx(tx), {
      preserveName: samePattern,
    });
  }

  /**
   * Internal setup that returns whether scheduling is required.
   */
  private setupInternal<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    validationOptions: SetupValidationOptions = {},
  ): SetupResult<R> {
    const tx = providedTx ?? this.runtime.edit();

    logger.debug("cell-info", () => [
      `resultCell: ${resultCell.getAsNormalizedFullLink().id}`,
    ]);

    const previousIdentityRef = getPatternIdentityRef(resultCell.withTx(tx));
    const resolvedPattern = this.resolveSetupPattern(
      patternOrModule,
      previousIdentityRef,
    );

    if (!resolvedPattern) {
      console.warn(
        "No pattern provided and no pattern found in result metadata. Not running.",
      );
      this.locallyPreparedResults.delete(this.getDocKey(resultCell));
      return { resultCell, needsStart: false };
    }

    const { pattern, entryRef, resolvedPatternOrModule } = resolvedPattern;
    // "Same pattern between runs" — drives name preservation and
    // reuse-running-setup. Compare the new pattern pointer against the stored
    // one. A keyless pattern carries a stable session-synthetic ref (minted per
    // pattern object), so re-setting up the same object compares equal too.
    const samePattern = previousIdentityRef !== undefined &&
      entryRef.identity === previousIdentityRef.identity &&
      entryRef.symbol === previousIdentityRef.symbol;
    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`setup-internal/${sourceKey}`, () => [
      `[SETUP] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(resolvedPatternOrModule)}`,
      `previousPatternIdentity=${
        previousIdentityRef ? previousIdentityRef.identity : "none"
      }`,
      `nextPatternIdentity=${entryRef ? entryRef.identity : "keyless"}`,
    ]);

    if (isCellLink(argument)) {
      argument = createSigilLinkFromParsedLink(
        parseLink(argument),
        {
          base: resultCell.getAsNormalizedFullLink(),
          includeSchema: true,
          overwrite: "redirect",
        },
      ) as T;
    }

    this.updateResultSchemaMeta(tx, resultCell, pattern.resultSchema);

    if (validationOptions.patternRepository !== undefined) {
      setPatternRepository(
        resultCell,
        tx,
        validationOptions.patternRepository,
      );
    }

    const runningSetup = this.maybeReuseRunningSetup(
      tx,
      resultCell,
      argument,
      pattern,
      samePattern,
    );
    if (runningSetup) {
      return runningSetup;
    }

    this.applySetupState(
      tx,
      pattern,
      entryRef,
      samePattern,
      argument,
      resultCell,
    );

    if (validationOptions.validateArgumentLinks !== undefined) {
      // applySetupState() either installs this link or throws.
      const argumentLink = getMetaLink(resultCell.withTx(tx), "argument")!;
      validationOptions.validateArgumentLinks(
        this.runtime.getCellFromLink(argumentLink, undefined, tx),
        pattern.argumentSchema,
      );
    }

    const key = this.getDocKey(resultCell);
    const preparedPatternKey = patternIdentityKey(entryRef);
    this.locallyPreparedResults.set(key, preparedPatternKey);
    tx.addCommitCallback((_tx, result) => {
      if (
        result.error &&
        this.locallyPreparedResults.get(key) === preparedPatternKey
      ) {
        this.locallyPreparedResults.delete(key);
      }
    });

    return { resultCell, pattern, needsStart: true };
  }

  /**
   * Start scheduling nodes for a previously set up piece.
   * If already started, this is a no-op.
   *
   * Returns a Promise that resolves to true on success, or rejects with an error.
   * Runs synchronously when data is available (important for tests).
   */
  start<T = any>(
    resultCell: Cell<T>,
    options: { schedulePatternUpdate?: boolean } = {},
  ): Promise<boolean> {
    const startKey = this.getDocKey(resultCell);
    const attempt: StartAttempt = {
      lifecycleEpoch: this.lifecycleEpoch,
      schedulePatternUpdate: options.schedulePatternUpdate ?? true,
      generationsByDoc: new Map(),
      preResolutionStopKeys: new Set(),
    };
    this.activeStartAttempts.add(attempt);
    this.trackStartAttempt(attempt, startKey);
    try {
      return this.doStart(resultCell, new Set(), attempt).finally(() => {
        this.finishStartAttempt(attempt);
      });
    } catch (error) {
      this.finishStartAttempt(attempt);
      return Promise.reject(error);
    }
  }

  /** Convert a module to pattern format */
  private moduleToPattern(module: Module): Pattern {
    const resultSchema = module.resultSchema ?? {};
    return {
      argumentSchema: module.argumentSchema ?? {},
      resultSchema,
      derivedInternalCells: [{
        partialCause: "$result",
        schema: resultSchema,
      }],
      result: { $alias: { partialCause: "$result", path: [] } },
      nodes: [
        {
          module,
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { partialCause: "$result", path: [] } },
        },
      ],
    } satisfies Pattern;
  }

  /** Resolve a Pattern or Module to a Pattern */
  private resolveToPattern(patternOrModule: Pattern | Module): Pattern {
    return isModule(patternOrModule)
      ? this.moduleToPattern(patternOrModule as Module)
      : (patternOrModule as Pattern);
  }

  /**
   * Core start implementation. Sets up cancel groups, instantiates nodes,
   * and watches for pattern changes.
   *
   * @param resultCell - The result cell to start
   * @param options.tx - Transaction to use for initial setup (optional)
   * @param options.givenPattern - Pattern to use instead of looking up by ID
   * @returns The exact cancel registration installed for this start
   */
  private startCore<T = any>(
    resultCell: Cell<T>,
    options: {
      tx?: IExtendedStorageTransaction;
      givenPattern?: Pattern;
      doNotUpdateOnPatternChange?: boolean;
      schedulePatternUpdate?: boolean;
      schedulerRehydration?: SchedulerRehydrationSubscriptionOptions;
      // Resumed-from-synced-state: hold each action's initial rehydration/run
      // until the space has finished syncing, so consumers don't race the data.
      awaitSyncBeforeInitialRun?: boolean;
    } = {},
  ): Cancel {
    const {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange,
      schedulePatternUpdate = true,
    } = options;
    const key = this.getDocKey(resultCell);
    this.locallyStoppedResults.delete(key);

    // Create cancel group early, before wiring pattern/node sinks.
    const [cancelGroup, addCancel] = useCancelGroup();
    const startLifecycleEpoch = this.lifecycleEpoch;
    let active = true;
    const cancel = () => {
      if (!active) return;
      active = false;
      this.locallyCommittedHandlerResultStarts.delete(key);
      cancelGroup();
    };
    this.cancels.set(key, cancel);
    this.allCancels.add(cancel);

    // Helper to clean up on error
    const cleanup = () => {
      this.cancels.delete(key);
      this.allCancels.delete(cancel);
      cancel();
    };

    // Track the current pattern's identity key and node cancellation. The key
    // is `patternIdentityKey({identity, symbol})` for a keyed pattern, or a
    // keyless sentinel for a hand-built pattern with no stored pointer (whose
    // pattern can only change via a fresh run(), not via the meta watcher).
    const KEYLESS = "\0keyless";
    let currentPatternKey: string | undefined;
    let cancelNodes: Cancel | undefined;
    let initialSchedulerRehydrationAvailable = true;

    // Helper to instantiate nodes for a pattern
    const instantiatePattern = (
      pattern: Pattern,
      useTx?: IExtendedStorageTransaction,
    ) => {
      if (!active || startLifecycleEpoch !== this.lifecycleEpoch) return;
      // Create new cancel group for nodes
      const [nodeCancel, addNodeCancel] = useCancelGroup();
      cancelNodes = nodeCancel;
      addCancel(nodeCancel);

      // Instantiate nodes
      const actualTx = useTx ?? this.runtime.edit();
      const shouldCommit = !useTx;
      // A boot snapshot belongs to exactly one pattern instantiation. A later
      // patternIdentity hot-swap must register fresh under the same durable
      // piece identity rather than replaying the old implementation's cache.
      const schedulerRehydration = initialSchedulerRehydrationAvailable
        ? options.schedulerRehydration ?? this.schedulerRehydrationOptions(
          resultCell,
          undefined,
          options.awaitSyncBeforeInitialRun,
        )
        : this.schedulerRehydrationOptions(resultCell);
      initialSchedulerRehydrationAvailable = false;
      try {
        for (const node of pattern.nodes) {
          const baseCell = resultCell.withTx(actualTx);
          this.instantiateNode(
            actualTx,
            node.module,
            node.inputs,
            node.outputs,
            baseCell,
            addNodeCancel,
            pattern,
            schedulerRehydration,
          );
        }
        if (!doNotUpdateOnPatternChange && schedulePatternUpdate) {
          // Source reconciliation is lazy for ordinary pieces: the current
          // pattern is fully instantiated first, and only a successful commit
          // launches the fire-and-forget check. An aborted setup must neither
          // fetch nor mutate a piece that never came into existence.
          actualTx.addCommitCallback((_tx, result) => {
            if (
              !result.error && active &&
              startLifecycleEpoch === this.lifecycleEpoch
            ) {
              this.runtime.patternUpdater.schedule(resultCell);
            }
          });
        }
      } finally {
        if (shouldCommit) {
          this.runtime.prepareTxForCommit(actualTx);
          actualTx.commit();
        }
      }
    };

    // Helper to set up the pattern watcher. Sinks on the `patternIdentity` meta
    // (the only pattern pointer); a keyless pattern writes none, so its watcher
    // is inert by design (keyless patterns change only via a fresh run()).
    const setupPatternWatcher = () => {
      // A hot-swap targets a DIFFERENT program over this piece's existing doc:
      // the incoming pattern's internal cells — handler { "$stream": true }
      // markers included — and its argument-schema defaults have never been
      // materialized here. A fresh start() does that in its setup phase;
      // skipping it makes every handler node of the incoming pattern fail as
      // "Handler used as lift" at instantiation (the 2026-07-22 estuary
      // home-root swap failure). Run the same setup state first, and only
      // tear down the old nodes once it commits — a failed setup leaves the
      // running pattern in place instead of a dead piece.
      const swapToPattern = (
        loaded: Pattern | NodeFactory<unknown, unknown>,
        newRef: { identity: string; symbol: string },
      ) => {
        const pattern = this.resolveToPattern(loaded as Pattern);
        const setupTx = this.runtime.edit();
        try {
          this.applySetupState(
            setupTx,
            pattern,
            newRef,
            false,
            undefined,
            resultCell,
          );
          this.runtime.prepareTxForCommit(setupTx);
          setupTx.commit();
        } catch (error) {
          logger.error(
            "pattern-swap-setup-error",
            `Setup for swapped-in pattern ${newRef.identity}#${newRef.symbol} failed`,
            error,
          );
          return;
        }
        cancelNodes?.();
        instantiatePattern(pattern);
      };
      addCancel(
        resultCell.sinkMeta("patternIdentity", (newValue) => {
          if (!active || startLifecycleEpoch !== this.lifecycleEpoch) return;
          const newRef = asPatternIdentityRef(newValue);
          if (!newRef) return;
          const newKey = patternIdentityKey(newRef);
          if (newKey === currentPatternKey) return; // No change
          currentPatternKey = newKey;

          // In-memory fast path: the module is usually live this session.
          const live = this.runtime.patternManager.artifactFromIdentitySync(
            newRef.identity,
            newRef.symbol,
          ) as Pattern | undefined;
          if (live) {
            swapToPattern(live, newRef);
            return;
          }
          // Async load for a pattern change after initial start. Errors are
          // logged here since there's no caller to propagate to.
          this.runtime.patternManager
            .loadPatternByIdentity(
              newRef.identity,
              newRef.symbol,
              resultCell.space,
            )
            .then((loaded) => {
              if (
                !active ||
                startLifecycleEpoch !== this.lifecycleEpoch ||
                currentPatternKey !== newKey
              ) return;
              if (!loaded) {
                logger.error(
                  "pattern-load-error",
                  `Failed to load pattern ${newRef.identity}#${newRef.symbol}`,
                );
                return;
              }
              logger.info("pattern changed", {
                to: { ref: newRef, pattern: loaded },
              });
              swapToPattern(loaded, newRef);
            })
            .catch((err) => {
              if (!active || startLifecycleEpoch !== this.lifecycleEpoch) {
                return;
              }
              logger.error(
                "pattern-load-error",
                `Failed to load pattern ${newRef.identity}#${newRef.symbol}`,
                err,
              );
            });
        }),
      );
    };

    const resultCellForRead = tx ? resultCell.withTx(tx) : resultCell;
    const initialRef = getPatternIdentityRef(resultCellForRead);

    // Determine initial pattern
    if (givenPattern) {
      currentPatternKey = initialRef ? patternIdentityKey(initialRef) : KEYLESS;
      try {
        instantiatePattern(givenPattern, tx);
      } catch (error) {
        // Without cleanup the piece stays registered in `this.cancels`, so
        // every later start() reports "already running" for a piece that has
        // no nodes or event handlers — events sent to it are then dropped.
        cleanup();
        throw error;
      }
      if (!doNotUpdateOnPatternChange) {
        setupPatternWatcher();
      }
      return cancel;
    }

    if (!initialRef) {
      cleanup();
      throw new Error("Cannot start: no pattern identity");
    }

    // Sync lookup by identity (the module is live this session).
    const initialResolved = this.runtime.patternManager
      .artifactFromIdentitySync(
        initialRef.identity,
        initialRef.symbol,
      ) as Pattern | undefined;
    if (!initialResolved) {
      cleanup();
      throw new Error(
        `Unknown pattern: ${initialRef.identity}#${initialRef.symbol}`,
      );
    }

    // Sync path - instantiate immediately
    currentPatternKey = patternIdentityKey(initialRef);
    instantiatePattern(this.resolveToPattern(initialResolved), tx);
    if (!doNotUpdateOnPatternChange) {
      setupPatternWatcher();
    }

    return cancel;
  }

  /**
   * Internal start implementation with cascade of checks.
   * Each check: if it fails and needs async work, return a promise that
   * resolves the missing piece and retries.
   */
  private doStart<T = any>(
    resultCell: Cell<T>,
    seenCells: Set<Cell>,
    attempt: StartAttempt,
  ): Promise<boolean> {
    if (!this.isStartAttemptCurrent(attempt)) {
      return Promise.resolve(false);
    }
    // `synced === true` means this cell was rehydrated from storage rather than
    // assembled purely from writes in the current runtime, so start() may need
    // to await dependency sync before process startup.
    const wasSyncedAtEntry =
      (resultCell as Cell<any> & { synced?: boolean }).synced === true;

    // Step 1: For subpath cells, resolve to root cell
    const link = resultCell.getAsNormalizedFullLink();
    const rootCell = link.path.length > 0
      ? this.runtime.getCellFromLink({ ...link, path: [] })
      : resultCell;

    const key = this.getDocKey(rootCell);
    // Step 2: Already started? Return success
    if (this.cancels.has(key)) return Promise.resolve(true);

    // Step 3: Not synced yet? Sync and retry
    // Once getRaw() has a value, all properties including source are synced.
    if (rootCell.getRaw() === undefined) {
      const rootSyncStart = performance.now();
      return rootCell.sync().then(() => {
        if (!this.isStartAttemptCurrent(attempt)) return false;
        logger.time(rootSyncStart, "start", "rootCellSync");
        if (rootCell.getRaw() === undefined) {
          return Promise.reject(new Error("No data at cell"));
        } else {
          return this.doStart(rootCell, seenCells, attempt);
        }
      });
    }

    // Step 4: Check whether the pattern is available, otherwise load it
    const identityRef = getPatternIdentityRef(rootCell);
    if (!identityRef) {
      // We may have a slug instead of a resultCell, so try the link.
      const maybeLink = parseLink(rootCell.getRaw(), rootCell);
      if (maybeLink) {
        const nextCell = this.runtime.getCellFromLink(maybeLink);
        if (seenCells.has(nextCell)) {
          return Promise.reject(new Error("Circular link detected"));
        }
        seenCells.add(nextCell);
        // A slug/link only locates the piece; once resolved, stopping the
        // target doc must invalidate any asynchronous work that follows.
        // Track that doc and capture its current generation before entering
        // the target's start cascade.
        const nextStartKey = this.getDocKey(nextCell);
        this.trackStartAttempt(attempt, nextStartKey);
        return this.doStart(nextCell, seenCells, attempt);
      }

      return Promise.reject(
        new Error(`Cannot start: no pattern identity`),
      );
    }
    const currentPatternKey = patternIdentityKey(identityRef);
    const preparedPatternKey = this.locallyPreparedResults.get(key);
    const stoppedPatternKey = this.locallyStoppedResults.get(key);
    const wasPreparedLocally = preparedPatternKey === currentPatternKey;
    const wasStoppedLocally = stoppedPatternKey === currentPatternKey;
    if (preparedPatternKey !== undefined && !wasPreparedLocally) {
      this.locallyPreparedResults.delete(key);
    }
    if (stoppedPatternKey !== undefined && !wasStoppedLocally) {
      this.locallyStoppedResults.delete(key);
    }
    return this.startAvailablePattern(
      rootCell,
      identityRef,
      wasSyncedAtEntry,
      wasPreparedLocally,
      wasStoppedLocally,
      seenCells,
      attempt,
    );
  }

  private startAvailablePattern<T = any>(
    rootCell: Cell<T>,
    identityRef: { identity: string; symbol: string },
    wasSyncedAtEntry: boolean,
    wasPreparedLocally: boolean,
    wasStoppedLocally: boolean,
    seenCells: Set<Cell>,
    attempt: StartAttempt,
  ): Promise<boolean> {
    if (!this.isStartAttemptCurrent(attempt)) {
      return Promise.resolve(false);
    }
    const pm = this.runtime.patternManager;
    const pattern = pm.artifactFromIdentitySync(
      identityRef.identity,
      identityRef.symbol,
    ) as Pattern | undefined;
    if (!pattern) {
      // Load by content identity: in-memory live module → compiled closure →
      // cold recompile from the verified source-doc closure (a version bump).
      // No patternId, no meta cell — the source docs are the single durable
      // source. A piece carrying only a legacy `pattern` link is unrecoverable
      // (the sanctioned data-wipe outcome).
      const loadStart = performance.now();
      return pm
        .loadPatternByIdentity(
          identityRef.identity,
          identityRef.symbol,
          rootCell.space,
        )
        .then((loaded) => {
          if (!this.isStartAttemptCurrent(attempt)) return false;
          // Resume-boot decomposition: source-doc fetch + module load/eval for
          // a pattern this runtime has never instantiated.
          logger.time(loadStart, "start", "loadPatternByIdentity");
          if (loaded) {
            return this.doStart(rootCell, seenCells, attempt);
          } else {
            return Promise.reject(
              new Error(
                `Could not load pattern ${identityRef.identity}#${identityRef.symbol}`,
              ),
            );
          }
        });
    }

    const resolvedPattern = this.resolveToPattern(pattern);

    // Fast path for pieces prepared in the current runtime via setup()/run() or
    // explicitly restarted after stop(). Those writes are already present
    // locally, so we should preserve the historical synchronous start()
    // behavior. The dependency sync + snapshot resume below is specifically for
    // pieces resumed from storage in a fresh runtime.
    //
    // We gate on the locally-assembled signals (`wasPreparedLocally` /
    // `wasStoppedLocally`) rather than the cell's `synced` flag: a fresh-runtime
    // resume reaches here past Step 3 with `getRaw()` populated, so it is not
    // locally assembled iff neither flag is set. The `synced` flag is no longer
    // reliably set for a storage-loaded cell, which would otherwise drop the
    // resume path and re-run the piece from scratch (`wasSyncedAtEntry` kept for
    // diagnostics).
    void wasSyncedAtEntry;
    if (wasPreparedLocally || wasStoppedLocally) {
      if (!this.isStartAttemptCurrent(attempt)) return Promise.resolve(false);
      try {
        this.startCore(rootCell, {
          givenPattern: resolvedPattern,
          schedulePatternUpdate: attempt.schedulePatternUpdate,
        });
      } catch (err) {
        return Promise.reject(err);
      }

      return Promise.resolve(true);
    }

    // Step 5: Sync the cells this running pattern depends on before wiring the
    // scheduler back up in a fresh runtime. Without this, resumed pieces can
    // observe the last persisted result but miss subsequent input updates.
    const expectedPatternKey = patternIdentityKey(identityRef);
    const patternIdentityStillCurrent = (): boolean => {
      const current = getPatternIdentityRef(rootCell);
      return current !== undefined &&
        patternIdentityKey(current) === expectedPatternKey;
    };
    return (async () => {
      await this.syncCellsForRunningPattern(rootCell, resolvedPattern);
      if (!this.isStartAttemptCurrent(attempt)) return false;
      // The result doc can hot-swap while the dependency pre-sync is awaiting
      // I/O. Never carry the old resolved Pattern into the new identity; restart
      // the resolution cascade against the current metadata instead.
      if (!patternIdentityStillCurrent()) {
        return await this.doStart(rootCell, seenCells, attempt);
      }

      const snapshotsStart = performance.now();
      const snapshotsByActionId = await this
        .loadSchedulerRehydrationSnapshots(rootCell, attempt.lifecycleEpoch);
      if (!this.isStartAttemptCurrent(attempt)) return false;
      logger.time(snapshotsStart, "start", "loadRehydrationSnapshots");
      // The listing is another asynchronous gap. If patternIdentity changed,
      // its snapshots and resolved implementation belong to the old pattern;
      // re-enter doStart before installing either one.
      if (!patternIdentityStillCurrent()) {
        return await this.doStart(rootCell, seenCells, attempt);
      }
      // we may already be in the midst of starting this, so don't start again
      if (this.cancels.has(this.getDocKey(rootCell))) {
        return true;
      }

      const startCoreStart = performance.now();
      try {
        this.startCore(rootCell, {
          givenPattern: resolvedPattern,
          schedulePatternUpdate: attempt.schedulePatternUpdate,
          schedulerRehydration: this.schedulerRehydrationOptions(
            rootCell,
            snapshotsByActionId,
            // Resumed from a synced state (it just awaited
            // syncCellsForRunningPattern): hold each action's initial run
            // until the space finishes syncing so we don't race the data
            // (e.g. maps reconciling an empty array, then re-running once it
            // streams in).
            true,
          ),
        });
      } finally {
        // Synchronous instantiation cost of the resumed piece (pattern
        // setup, node wiring), distinct from the syncs around it.
        logger.time(startCoreStart, "start", "startCoreResume");
      }

      return true;
    })();
  }

  private startWithTx<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
  ): Cancel | undefined {
    const key = this.getDocKey(resultCell);
    if (this.cancels.has(key)) return undefined;

    return this.startCore(resultCell, {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange: options.doNotUpdateOnPatternChange,
      schedulePatternUpdate: options.schedulePatternUpdate,
      awaitSyncBeforeInitialRun: options.awaitSyncBeforeInitialRun,
    });
  }

  private createDeferredStartOwnership<T>(
    resultCell: Cell<T>,
  ): DeferredCancelOwnership {
    const key = this.getDocKey(resultCell);
    return useDeferredCancelOwnership((installedCancel) => {
      // A result key can be stopped and restarted while deferred startup is
      // re-entering runner code. Only stop if this attempt's exact cancel
      // registration is still current; a later replacement owns itself.
      if (this.cancels.get(key) !== installedCancel) return;
      this.stop(resultCell);
    });
  }

  private startAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
    pullOnceAfterStart: boolean = false,
  ): Cancel {
    const resultLink = resultCell.getAsNormalizedFullLink();
    const ownership = this.createDeferredStartOwnership(resultCell);
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error || ownership.isCancelled()) {
        return;
      }

      const startTx = this.runtime.edit();
      const committedResultCell = this.runtime.getCellFromLink<T>(
        resultLink,
        undefined,
        startTx,
      );
      try {
        if (
          ownership.markInstalled(
            this.startWithTx(
              startTx,
              committedResultCell,
              givenPattern,
              options,
            ),
          )
        ) {
          startTx.abort("Deferred runner start was cancelled");
          return;
        }
        this.runtime.prepareTxForCommit(startTx);
        startTx.commit().then(({ error }) => {
          if (error) {
            ownership.cancel();
            logger.error(
              "tx-commit-error",
              "Error committing deferred start transaction",
              error,
            );
            return;
          }
          if (pullOnceAfterStart && !ownership.isCancelled()) {
            this.pullCellOnceInPullMode(committedResultCell);
          }
        }).catch((error) => {
          ownership.cancel();
          logger.error(
            "tx-commit-error",
            "Deferred start transaction commit rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        ownership.cancel();
        logger.error("runner-start", "Deferred start failed", error);
        throw error;
      }
    });
    return ownership.cancel;
  }

  private runPatternAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    pattern: Pattern,
    inputs: FabricValue,
    pullOnceAfterStart = false,
    markCreateOnlyResult = false,
  ): Cancel {
    const resultLink = resultCell.getAsNormalizedFullLink();
    const ownership = this.createDeferredStartOwnership(resultCell);
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error || ownership.isCancelled()) return;

      const startTx = this.runtime.edit();
      const committedResultCell = this.runtime.getCellFromLink<T>(
        resultLink,
        pattern.resultSchema,
        startTx,
      );
      try {
        if (
          ownership.markInstalled(
            this.runWithStartOwnership(
              startTx,
              pattern,
              inputs,
              committedResultCell,
            ).installedCancel,
          )
        ) {
          startTx.abort("Deferred runner start was cancelled");
          return;
        }
        if (markCreateOnlyResult) {
          startTx.markCreateOnly?.(
            committedResultCell.getAsNormalizedFullLink(),
          );
        }
        this.runtime.prepareTxForCommit(startTx);
        startTx.commit().then(({ error }) => {
          if (error) {
            ownership.cancel();
            logger.error(
              "tx-commit-error",
              "Error committing deferred cross-space pattern transaction",
              error,
            );
            return;
          }
          if (pullOnceAfterStart && !ownership.isCancelled()) {
            this.pullCellOnceInPullMode(committedResultCell);
          }
        }).catch((error) => {
          ownership.cancel();
          logger.error(
            "tx-commit-error",
            "Deferred cross-space pattern transaction rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        ownership.cancel();
        logger.error(
          "runner-start",
          "Deferred cross-space pattern failed",
          error,
        );
        throw error;
      }
    });
    return ownership.cancel;
  }

  /**
   * Run a pattern.
   *
   * resultCell is required and should have an id. Pattern, argument, and
   * internal links are stored in result-cell metadata.
   *
   * If no pattern is provided, the previous one is used, and the pattern is
   * started if it isn't already started.
   *
   * If no argument is provided, the previous one is used, and the pattern is
   * started if it isn't already running.
   *
   * If a new pattern or any argument value is provided, a currently running
   * pattern is stopped, the pattern and argument replaced and the pattern
   * restarted.
   *
   * @param patternFactory - Function that takes the argument and returns a
   * pattern.
   * @param argument - The argument to pass to the pattern. Can be static data
   * and/or cell references, including cell value proxies, docs and regular
   * cells.
   * @param resultCell - Cell to run the pattern off.
   * @returns The result cell.
   */
  run<T, R>(
    tx: IExtendedStorageTransaction | undefined,
    patternFactory: NodeFactory<T, R>,
    argument: T,
    resultCell: Cell<R>,
    options?: RunnerRunOptions,
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: RunnerRunOptions,
  ): Cell<R>;
  run<T, R = any>(
    providedTx: IExtendedStorageTransaction,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions = {},
  ): Cell<R> {
    return this.runWithStartOwnership(
      providedTx,
      patternOrModule,
      argument,
      resultCell,
      options,
    ).resultCell;
  }

  /**
   * Internal run variant that reports whether this invocation installed or
   * commit-gated the result wrapper's local start/cancel registration. Callers
   * that attach failure compensation must only compensate work they own: a
   * duplicate event can reuse a winner's deterministic result cell, and must
   * never stop that shared winner when its create-only receipt loses.
   */
  private runWithStartOwnership<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: RunnerRunOptions = {},
  ): RunResult<R> {
    const tx = providedTx ?? this.runtime.edit();
    const sourceKey = getTxDebugActionId(tx) ?? "none";

    triggerFlowLogger.debug(`runner-run/${sourceKey}`, () => [
      `[RUN] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternOrModule)}`,
      `providedTx=${Boolean(providedTx)}`,
    ]);

    const { needsStart, pattern } = this.setupInternal(
      tx,
      patternOrModule,
      argument,
      resultCell,
    );

    let installedCancel: Cancel | undefined;
    let cancelDeferredStart: Cancel | undefined;
    if (needsStart) {
      const pullOnceAfterStart = this.patternNeedsOneShotPull(pattern);
      if (
        tx.tx.immediate === true &&
        (tx.tx as { deferRunnerStartUntilCommit?: boolean })
            .deferRunnerStartUntilCommit === true
      ) {
        cancelDeferredStart = this.startAfterSuccessfulCommit(
          tx,
          resultCell,
          pattern,
          options,
          pullOnceAfterStart,
        );
      } else {
        installedCancel = this.startWithTx(
          tx,
          resultCell,
          pattern,
          options,
        );
        if (pullOnceAfterStart) {
          this.pullCellOnceAfterSuccessfulCommit(tx, resultCell);
        }
      }
    }

    if (!providedTx) {
      this.runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return {
      resultCell,
      installedCancel,
      cancelDeferredStart,
    };
  }

  async runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
    options?: {
      expectedPatternIdentity?: { identity: string; symbol: string };
      validateArgumentLinks?: SetupValidationOptions["validateArgumentLinks"];
      patternRepository?: string;
    },
  ) {
    await resultCell.sync();

    const synced = await this.syncCellsForRunningPattern(
      resultCell,
      pattern,
      inputs,
    );

    // Run the pattern.
    //
    // If the result cell has a transaction attached, and it is still open,
    // we'll use it for all reads and writes as it might be a pending read.
    //
    // TODO(seefeld): There is currently likely a race condition with the
    // scheduler if the transaction isn't committed before the first functions
    // run. Though most likely the worst case is just extra invocations.
    const givenTx = resultCell.tx?.status().status === "ready" && resultCell.tx;
    let setupRes: ReturnType<typeof this.setupInternal> | undefined;
    const assertExpectedPatternIdentity = (
      cell: Cell<any>,
    ): void => {
      const expected = options?.expectedPatternIdentity;
      if (!expected) return;
      const current = getPatternIdentityRef(cell);
      if (
        current === undefined ||
        patternIdentityKey(current) !== patternIdentityKey(expected)
      ) {
        throw new Error(
          "piece pattern changed while the source update was compiling",
        );
      }
    };
    if (givenTx) {
      // If tx is given, i.e. result cell was part of a tx that is still open,
      // caller manages retries
      assertExpectedPatternIdentity(resultCell.withTx(givenTx));
      setupRes = this.setupInternal(
        givenTx,
        pattern,
        inputs,
        resultCell.withTx(givenTx),
        {
          patternRepository: options?.patternRepository,
          validateArgumentLinks: options?.validateArgumentLinks,
        },
      );
    } else {
      const { error } = await this.runtime.editWithRetry((tx) => {
        assertExpectedPatternIdentity(resultCell.withTx(tx));
        setupRes = this.setupInternal(
          tx,
          pattern,
          inputs,
          resultCell.withTx(tx),
          {
            patternRepository: options?.patternRepository,
            validateArgumentLinks: options?.validateArgumentLinks,
          },
        );
      });
      if (error) {
        if (
          error.name === "StorageTransactionAborted" &&
          error.message.startsWith("editWithRetry action threw:") &&
          error.reason instanceof Error
        ) {
          throw error.reason;
        }
        if (options?.expectedPatternIdentity) {
          throw error;
        }
        logger.error("pattern-setup-error", "Error setting up pattern", error);
        setupRes = undefined;
      }
    }

    // If a new pattern was specified, make sure to sync any new cells
    if (pattern || !synced) {
      await this.syncCellsForRunningPattern(resultCell, pattern);
    }

    if (setupRes?.needsStart) {
      if (givenTx) {
        this.startWithTx(
          givenTx,
          resultCell.withTx(givenTx),
          setupRes.pattern,
        );
      } else {
        // The setup commit can be superseded while dependency sync is in
        // flight. Resolve startup from the current durable pattern pointer so
        // a stale caller can never instantiate its old candidate while
        // recording a newer identity as current.
        await resultCell.sync();
        await this.start(resultCell);
      }
    }

    // A concurrent source update can supersede this caller after its setup
    // commit but before its post-commit dependency sync settles. Return a view
    // typed by the pattern that is actually durable now, not by this caller's
    // stale candidate.
    let currentRef = getPatternIdentityRef(resultCell);
    while (currentRef !== undefined) {
      const loadedRef = currentRef;
      const currentPattern = await this.runtime.patternManager
        .loadPatternByIdentity(
          loadedRef.identity,
          loadedRef.symbol,
          resultCell.space,
        );
      currentRef = getPatternIdentityRef(resultCell);
      if (
        currentRef !== undefined &&
        patternIdentityKey(currentRef) !== patternIdentityKey(loadedRef)
      ) {
        continue;
      }
      if (
        currentRef === undefined || currentPattern?.resultSchema === undefined
      ) {
        return resultCell;
      }
      return resultCell.asSchema(currentPattern.resultSchema);
    }
    return pattern?.resultSchema !== undefined
      ? resultCell.asSchema(pattern.resultSchema)
      : resultCell;
  }

  private getDocKey(cell: Cell<any>): `${MemorySpace}/${CellScope}/${URI}` {
    const { space, id, scope } = cell.getAsNormalizedFullLink();
    return `${space}/${scope}/${id}`;
  }

  // The scheduler observation identity (pieceId + owning space) for a piece's
  // result cell. Pattern readers subscribe with this so the timing shapers can
  // group and rate-cap a pattern's wakes; without it, cell-flip shaping (plan B)
  // silently does not apply to the piece. It is derived purely from the result
  // cell, so it is available even when scheduler state is not rehydrated.
  private schedulerObservationIdentity(resultCell: Cell<any>) {
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
    return { pieceId: `${scope}:${id}`, ownerSpace: space };
  }

  private schedulerRehydrationOptions(
    resultCell: Cell<any>,
    snapshotsByActionId?: ReadonlyMap<
      string,
      readonly PersistedSchedulerObservationSnapshot[]
    >,
    awaitSync?: boolean,
  ): SchedulerRehydrationSubscriptionOptions {
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
    const observationIdentity = this.schedulerObservationIdentity(resultCell);
    if (!getPersistentSchedulerStateConfig()) {
      // Persistent scheduler state is off: actions always re-run on resume.
      // When resuming from a synced state, hold the initial run until the space
      // is synced so re-derivations read confirmed-loaded inputs.
      return {
        observationIdentity,
        ...(awaitSync ? { awaitSyncBeforeInitialRun: { space } } : {}),
      };
    }
    // Per-doc restore: a piece started with resume intent (awaitSync) but no
    // explicitly threaded snapshots — a sub-pattern node or a per-element
    // child run — looks up its own bucket from the boot's space-wide listing,
    // keyed by the doc it derives. See per-doc-rehydration.md §3.2.
    const pieceId = `${scope}:${id}`;
    const snapshots = snapshotsByActionId ??
      (awaitSync
        ? this.resumeSnapshotsBySpace.get(space)?.get(pieceId)
        : undefined);
    const provider = this.runtime.storageManager.open(space);
    const addressesCurrentAtOrBelow = provider
      .areSchedulerAddressesCurrentAtOrBelow?.bind(provider);
    const hasPendingWriteOverlapping = provider
      .schedulerHasPendingWriteOverlapping?.bind(provider);
    return {
      observationIdentity,
      rehydrateFromStorage: {
        space,
        pieceId,
        processGeneration: 0,
        ...(awaitSync ? { awaitSync: true } : {}),
        ...(snapshots !== undefined ? { snapshotsByActionId: snapshots } : {}),
        ...(addressesCurrentAtOrBelow !== undefined
          ? { addressesCurrentAtOrBelow }
          : {}),
        ...(hasPendingWriteOverlapping !== undefined
          ? { hasPendingWriteOverlapping }
          : {}),
      },
      // Resume intent also arms the synced-hold: any action that does not
      // rehydrate from a snapshot (miss, fingerprint mismatch, or an
      // always-run coordinator) holds its initial run until the space syncs
      // instead of racing the data — restoring flag-off parity for children.
      ...(awaitSync ? { awaitSyncBeforeInitialRun: { space } } : {}),
    };
  }

  private async loadSchedulerRehydrationSnapshots(
    resultCell: Cell<any>,
    lifecycleEpoch: number,
  ): Promise<
    | ReadonlyMap<string, readonly PersistedSchedulerObservationSnapshot[]>
    | undefined
  > {
    if (!getPersistentSchedulerStateConfig()) {
      return undefined;
    }
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
    const byPiece = await this.loadResumeSnapshotsForSpace(
      space,
      lifecycleEpoch,
    );
    return byPiece?.get(`${scope}:${id}`);
  }

  // One space-wide snapshot listing per resumed boot, bucketed per piece doc.
  // Concurrent resumes of the same space share one in-flight listing; a later
  // resume refreshes (replaces) the cached buckets. Descendant registrations
  // read the cache synchronously via schedulerRehydrationOptions, so the
  // resume phase stays "load once, then register" (spec §9.2) for the whole
  // piece tree — no per-child async lookups.
  private loadResumeSnapshotsForSpace(
    space: MemorySpace,
    lifecycleEpoch: number,
  ): Promise<
    | ReadonlyMap<
      string,
      ReadonlyMap<string, readonly PersistedSchedulerObservationSnapshot[]>
    >
    | undefined
  > {
    const inFlight = this.resumeSnapshotLoads.get(space);
    if (inFlight) return inFlight;

    const provider = this.runtime.storageManager.open(space);
    const listSnapshots = provider.listSchedulerActionSnapshots;
    if (!listSnapshots) {
      return Promise.resolve(undefined);
    }

    const load = (async () => {
      const byPiece = new Map<
        string,
        Map<string, PersistedSchedulerObservationSnapshot[]>
      >();
      // A transient listing failure must degrade to "resume fresh" rather
      // than hard-failing start(): returning undefined runs the boot without
      // rehydrating persisted observations.
      try {
        let cursor: SchedulerActionSnapshotCursor | undefined;
        let listingServerSeq: number | undefined;
        do {
          if (lifecycleEpoch !== this.lifecycleEpoch) return undefined;
          const page = await listSnapshots.call(provider, {
            ownerSpace: space,
            processGeneration: 0,
            ...(cursor ? { cursor } : {}),
          });
          if (listingServerSeq === undefined) {
            listingServerSeq = page.serverSeq;
          } else if (page.serverSeq !== listingServerSeq) {
            throw new Error(
              `scheduler snapshot listing changed epoch (${listingServerSeq} -> ${page.serverSeq})`,
            );
          }
          for (const snapshot of page.snapshots) {
            if (!isSchedulerActionObservation(snapshot.observation)) continue;
            const { pieceId, actionId } = snapshot.observation;
            let byAction = byPiece.get(pieceId);
            if (!byAction) {
              byAction = new Map();
              byPiece.set(pieceId, byAction);
            }
            const candidates = byAction.get(actionId) ?? [];
            candidates.push({
              executionContextKey: snapshot.executionContextKey,
              observation: snapshot.observation,
              ...(snapshot.directDirtySeq !== undefined
                ? { directDirtySeq: snapshot.directDirtySeq }
                : {}),
              ...(snapshot.staleSeq !== undefined
                ? { staleSeq: snapshot.staleSeq }
                : {}),
              ...(snapshot.unknownReason !== undefined
                ? { unknownReason: snapshot.unknownReason }
                : {}),
            });
            byAction.set(actionId, candidates);
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        // Close the list/register gap: catch this replica up through at least
        // the listing epoch before any synchronous snapshot apply. Tracked
        // inputs and outputs can then be checked against their observation seq
        // without missing a write that landed during pagination.
        await provider.synced();
        if (lifecycleEpoch !== this.lifecycleEpoch) return undefined;
      } catch (error) {
        logger.warn(
          "Failed to list scheduler rehydration snapshots; resuming fresh",
          error,
        );
        return undefined;
      }
      return byPiece;
    })();

    this.resumeSnapshotLoads.set(space, load);
    load.then((byPiece) => {
      if (lifecycleEpoch !== this.lifecycleEpoch) return;
      // Failure degrades the WHOLE boot to resume-fresh: drop any stale cache
      // so descendants do not rehydrate from a previous boot's listing.
      if (byPiece) this.resumeSnapshotsBySpace.set(space, byPiece);
      else this.resumeSnapshotsBySpace.delete(space);
    }).finally(() => {
      if (this.resumeSnapshotLoads.get(space) === load) {
        this.resumeSnapshotLoads.delete(space);
      }
    });
    return load;
  }

  private async syncCellsForRunningPattern(
    resultCell: Cell<any>,
    pattern: Module | Pattern,
    inputs?: any,
  ): Promise<boolean> {
    const syncStart = performance.now();
    try {
      return await this.syncCellsForRunningPatternInner(
        resultCell,
        pattern,
        inputs,
      );
    } finally {
      // Resume-boot decomposition: this is the dependency pre-sync a fresh
      // runtime pays before wiring a stored piece back up. Recorded under the
      // runner timing stats (they record even when the logger is disabled) so
      // load summaries can attribute slow storage-resume boots.
      logger.time(syncStart, "start", "syncCellsForRunningPattern");
    }
  }

  private async syncCellsForRunningPatternInner(
    resultCell: Cell<any>,
    pattern: Module | Pattern,
    inputs?: any,
  ): Promise<boolean> {
    const seen = new Set<Cell<any>>();
    const promises = new Set<Promise<any>>();

    const syncAllMentionedCells = (value: any) => {
      if (seen.has(value)) return;
      seen.add(value);

      const link = parseLink(value, resultCell);

      if (link) {
        promises.add(this.runtime.getCellFromLink(link).sync());
      } else if (isRecord(value)) {
        for (const key in value) syncAllMentionedCells(value[key]);
      }
    };

    syncAllMentionedCells(inputs);
    await Promise.all(promises);

    await resultCell.sync();

    // We could support this by replicating what happens in runner, but since
    // we're calling this again when returning false, this is good enough for now.
    if (isModule(pattern)) return false;

    const cells: Cell<any>[] = [];
    // Argument documents (node inputs + the pattern's own argument meta doc)
    // whose VALUES may hold links to documents nothing in this tree owns —
    // scanned after the main sync wave (see below).
    const argumentCells: Cell<any>[] = [];

    // Sync all the inputs and outputs of the pattern nodes. Bindings are
    // unwrapped (bound to the argument/result documents) first, so named-cell
    // and partialCause aliases resolve to the documents they actually denote;
    // findAllWriteRedirectCells itself only walks sigil links. Without the
    // argument meta link the bindings cannot be bound, so the node walk is
    // skipped — the pre-sync is best-effort, and binding against a substitute
    // document would pre-sync the wrong cells (CT-1897). Skipping wholesale is
    // right here because node inputs nearly always alias the argument doc;
    // collectResumeOwnedCells instead passes the possibly-missing link through
    // and skips per-node, since sub-pattern outputs rarely alias it.
    const argumentMetaLink = getMetaLink(resultCell, "argument");
    if (argumentMetaLink === undefined) {
      // Instrumentation for how often the meta link is missing here (fresh
      // first runs are expected to hit this; resumes should not).
      logger.warn("resume-pre-sync", () => [
        "argument meta link missing; skipping node pre-sync",
        {
          resultCell: resultCell.getAsNormalizedFullLink().id,
          nodes: pattern.nodes.length,
        },
      ]);
    } else {
      for (const node of pattern.nodes) {
        let inputs: NormalizedFullLink[];
        let outputs: NormalizedFullLink[];
        try {
          inputs = findAllWriteRedirectCells(
            unwrapOneLevelAndBindtoDoc(
              this.runtime.cfc,
              node.inputs,
              argumentMetaLink,
              resultCell,
              { derivedInternalCells: pattern.derivedInternalCells },
            ),
            resultCell,
          );
          outputs = findAllWriteRedirectCells(
            unwrapOneLevelAndBindtoDoc(
              this.runtime.cfc,
              node.outputs,
              argumentMetaLink,
              resultCell,
              { derivedInternalCells: pattern.derivedInternalCells },
            ),
            resultCell,
          );
        } catch (error) {
          // A node whose bindings cannot be bound contributes nothing rather
          // than breaking the pre-sync walk; log it so a resume that silently
          // skips a node's pre-sync is diagnosable.
          logger.warn("resume-pre-sync", () => [
            "skipping a node whose bindings did not unwrap",
            error,
          ]);
          continue;
        }

        // TODO(seefeld): This ignores schemas provided by modules, so it might
        // still fetch a lot.
        [...inputs, ...outputs].forEach((link) => {
          cells.push(this.runtime.getCellFromLink(link));
        });
        inputs.forEach((link) => {
          argumentCells.push(this.runtime.getCellFromLink(link));
        });
      }
      argumentCells.push(this.runtime.getCellFromLink(argumentMetaLink));
    }

    // Sync the owned (derived internal) cells of this pattern and every nested
    // sub-pattern, to any depth, before instantiating. The setup re-derivation
    // and the sub-patterns' argument writes read these owned cells by value
    // (e.g. a child bound to the parent's list). On a cold-cache resume an
    // unsynced owned cell reads as absent and its read enters the instantiation
    // commit's conflict set, so when the durable value streams in the whole
    // batched instantiation commit loses and reverts — stranding the optimistic
    // writes that the resumed actions then depend on. Pulling them here keeps
    // that commit read-mostly.
    // Resolving each sub-pattern node's output redirect chain needs a
    // transaction (resolveLink reads link metadata). The walk only reads, so the
    // transaction is discarded afterward.
    const resolveTx = this.runtime.edit();
    this.collectResumeOwnedCells(
      pattern,
      resultCell,
      cells,
      new Set(),
      resolveTx,
    );
    resolveTx.abort("collectResumeOwnedCells: read-only resolution");

    // Sync all the previously computed results.
    if (pattern.resultSchema !== undefined) {
      cells.push(resultCell.asSchema(pattern.resultSchema));
    }

    // If the result has a UI and it wasn't already included in the result
    // schema, sync it as well. This prevents the UI from flashing, because it's
    // first locally computed, then conflicts on write and only then properly
    // received from the server.
    if (
      isRecord(pattern.result) &&
      pattern.result[UI] &&
      (!isRecord(pattern.resultSchema) ||
        !pattern.resultSchema.properties?.[UI])
    ) {
      cells.push(resultCell.key(UI).asSchema(rendererVDOMSchema));
    }

    // Per-cell spans: `n` in the timing stats is the number of cells this
    // resume pre-synced, total/max its round-trip cost (spans overlap, so the
    // wall cost is bounded by the enclosing syncCellsForRunningPattern span).
    await Promise.all(cells.map((c) => {
      const cellSyncStart = performance.now();
      return Promise.resolve(c.sync()).finally(() =>
        logger.time(cellSyncStart, "start", "resumeCellSync")
      );
    }));

    // Second wave: argument LINK TARGETS. An argument document synced above
    // may hold a link to a document nothing in this pattern tree owns (the
    // profile picker's `defaultProfile` container links to a per-user doc
    // from another lineage). A resumed computed's first run reads THROUGH
    // those links; v2 commits first runs, so a cold target enters the commit
    // basis at seq 0 — a guaranteed ConflictError against the durable server
    // state (the home-rehydration reload-churn regression; v1's populate
    // pass subscribed such targets in aborted transactions before any
    // commit). Two levels deep — argument value → container doc → target doc
    // is the measured chain (defaultProfile → container → per-user profile
    // doc); deeper or wider walks were measured to add loads without
    // removing further conflicts. Deduped, values only, schema-less doc
    // syncs; an unloadable target is skipped rather than failing the resume.
    const seenTargets = new Set<string>();
    let frontier: Cell<any>[] = argumentCells;
    for (let depth = 0; depth < 2 && frontier.length > 0; depth++) {
      const targets: Cell<any>[] = [];
      const targetPromises: Promise<any>[] = [];
      const collectLinkTargets = (value: any, base: Cell<any>) => {
        const link = parseLink(value, base);
        if (link) {
          const key = `${link.space}\0${link.id}\0${link.scope ?? "space"}`;
          if (seenTargets.has(key)) return;
          seenTargets.add(key);
          const target = this.runtime.getCellFromLink(link);
          targets.push(target);
          const targetSyncStart = performance.now();
          targetPromises.push(
            Promise.resolve(target.sync())
              .catch((error) => {
                logger.warn("resume-argument-link-targets", () => [
                  "argument link target sync failed; resuming without it",
                  error,
                ]);
              })
              .finally(() =>
                logger.time(
                  targetSyncStart,
                  "start",
                  "resumeArgumentLinkTargetSync",
                )
              ),
          );
        } else if (isRecord(value)) {
          for (const key in value) collectLinkTargets(value[key], base);
        }
      };
      for (const cell of frontier) {
        try {
          collectLinkTargets(cell.getRawUntyped(), cell);
        } catch (error) {
          // A shape the raw read cannot resolve contributes nothing rather
          // than breaking the resume; log so a skipped target is diagnosable.
          logger.warn("resume-argument-link-targets", () => [
            "skipping a document whose raw value did not resolve",
            error,
          ]);
        }
      }
      await Promise.all(targetPromises);
      frontier = targets;
    }

    return true;
  }

  // Walk the pattern tree — this pattern and every nested sub-pattern — and
  // collect each one's owned (derived internal) cells into `out`, so the resume
  // pre-sync pulls them before instantiation reads them. A sub-pattern node's
  // result cell is the cell reserved by the node's resolved output spot, the
  // same `resultFor` identity instantiatePatternNode mints; deriving owned cells
  // from it matches what the child's setup will use. The `seen` set keys on the
  // result cell to bound the walk against a cyclic reference. This only pulls
  // cells, so a node shape it cannot resolve contributes nothing rather than
  // misbehaving.
  private collectResumeOwnedCells(
    pattern: Pattern,
    resultCell: Cell<any>,
    out: Cell<any>[],
    seen: Set<string>,
    tx: IExtendedStorageTransaction,
  ): void {
    const link = resultCell.getAsNormalizedFullLink();
    const key = `${link.space}\0${link.id}\0${link.scope ?? "space"}`;
    if (seen.has(key)) return;
    seen.add(key);

    for (const descriptor of pattern.derivedInternalCells ?? []) {
      out.push(getDerivedInternalCell(resultCell, descriptor));
    }

    // May be undefined: this walk runs before setup writes the meta on fresh
    // first runs, and child result cells are not synced yet on a cold-cache
    // resume. That is fine for binding — unwrapOneLevelAndBindtoDoc only needs
    // the argument link when an output actually aliases the argument doc, and
    // throws otherwise. Substituting a different document instead would derive
    // the wrong `resultFor` identity and pre-sync the wrong owned-cell subtree
    // (CT-1897).
    const argumentLink = getMetaLink(resultCell, "argument");

    for (const node of pattern.nodes) {
      const module = node.module;
      if (module.type !== "pattern" || !isPattern(module.implementation)) {
        continue;
      }
      const childPattern = module.implementation;
      const targetSpace = module.targetSpace ?? resultCell.space;
      const childScope = patternDefaultScope(childPattern) ??
        module.defaultScope;
      // Resolve the node's reserved output spot the way instantiatePatternNode
      // does: unwrap one level (so a deferred-alias output is decremented and
      // followed) and follow the write-redirect chain to its resolved end (a
      // pattern node reserves one result cell). The minting path keys the child
      // result cell on the fully resolved redirect, so deriving from the same
      // resolved spot yields the same `resultFor` identity the child's setup
      // mints; the unresolved head of a multi-hop binding would be a different
      // cell, pre-syncing the wrong owned-cell subtree.
      let spotLink: NormalizedFullLink | undefined;
      try {
        const unwrappedOutputs = unwrapOneLevelAndBindtoDoc(
          this.runtime.cfc,
          node.outputs,
          argumentLink,
          resultCell,
        );
        spotLink = firstResolvedOutputRedirect(
          this.runtime,
          tx,
          unwrappedOutputs,
          resultCell,
        );
      } catch (error) {
        // A node whose outputs cannot be bound (e.g. they alias the argument
        // doc while the argument link is unavailable) or resolved contributes
        // nothing rather than breaking the resume walk; log it so a resume
        // that silently skips its owned-cell pre-sync is diagnosable.
        logger.warn("resume-owned-cells", () => [
          "skipping a sub-pattern node whose outputs did not bind or resolve",
          error,
        ]);
        continue;
      }
      if (spotLink === undefined) continue;
      let childResultCell = this.runtime.getCell(
        targetSpace,
        {
          resultFor: {
            space: spotLink.space,
            id: spotLink.id,
            path: [...spotLink.path],
          },
        },
        childPattern.resultSchema,
      );
      if (childScope !== undefined && childScope !== "space") {
        const childLink = childResultCell.getAsNormalizedFullLink();
        childResultCell = this.runtime.getCellFromLink({
          ...childLink,
          scope: childScope,
        });
      }
      this.collectResumeOwnedCells(
        childPattern,
        childResultCell,
        out,
        seen,
        tx,
      );
    }
  }

  /**
   * Stop a pattern. This will cancel the pattern and all its children.
   *
   * TODO: This isn't a good strategy, as other instances might depend on behavior
   * provided here, even if the user might no longer care about e.g. the UI here.
   * A better strategy would be to schedule based on effects and unregister the
   * effects driving execution, e.g. the UI.
   *
   * @param resultCell - The result doc or cell to stop.
   */
  stop<T>(resultCell: Cell<T>): void {
    const key = this.getDocKey(resultCell);
    if ((this.activeStartAttemptsByDoc.get(key)?.size ?? 0) > 0) {
      this.startGenerationByDoc.set(
        key,
        (this.startGenerationByDoc.get(key) ?? 0) + 1,
      );
    } else {
      // No asynchronous continuation can observe this generation. Avoid
      // retaining one entry per stopped piece for the runtime's lifetime.
      this.startGenerationByDoc.delete(key);
    }
    // An unresolved link start does not know its target yet, so it cannot be
    // indexed under `key`. Snapshot this stop onto every currently active
    // attempt that has not discovered the doc. If one later resolves to `key`,
    // it observes the tombstone and terminates. The tombstone lives only on the
    // active token and is released when that start settles.
    for (const attempt of this.activeStartAttempts) {
      if (!attempt.generationsByDoc.has(key)) {
        attempt.preResolutionStopKeys.add(key);
      }
    }
    const cancel = this.cancels.get(key);
    try {
      cancel?.();
    } finally {
      this.cancels.delete(key);
      this.locallyCommittedHandlerResultStarts.delete(key);
      if (cancel !== undefined) {
        this.allCancels.delete(cancel);
        // Only a piece that was actually running is safe to restart from its
        // already-assembled local cells. Stopping an unresolved/storage-only
        // target must not bypass dependency sync and snapshot rehydration on a
        // later explicit start.
        const stoppedIdentity = getPatternIdentityRef(resultCell);
        if (stoppedIdentity !== undefined) {
          this.locallyStoppedResults.set(
            key,
            patternIdentityKey(stoppedIdentity),
          );
        } else {
          this.locallyStoppedResults.delete(key);
        }
      }
    }
  }

  private trackStartAttempt(attempt: StartAttempt, key: string): void {
    if (attempt.generationsByDoc.has(key)) return;
    attempt.generationsByDoc.set(
      key,
      this.startGenerationByDoc.get(key) ?? 0,
    );
    let active = this.activeStartAttemptsByDoc.get(key);
    if (active === undefined) {
      active = new Set();
      this.activeStartAttemptsByDoc.set(key, active);
    }
    active.add(attempt);
  }

  private finishStartAttempt(attempt: StartAttempt): void {
    this.activeStartAttempts.delete(attempt);
    for (const key of attempt.generationsByDoc.keys()) {
      const active = this.activeStartAttemptsByDoc.get(key);
      if (!active?.delete(attempt)) continue;
      if (active.size === 0) {
        this.activeStartAttemptsByDoc.delete(key);
        this.startGenerationByDoc.delete(key);
      }
    }
    attempt.generationsByDoc.clear();
    attempt.preResolutionStopKeys.clear();
  }

  private isStartAttemptCurrent(attempt: StartAttempt): boolean {
    if (attempt.lifecycleEpoch !== this.lifecycleEpoch) return false;
    for (const [key, generation] of attempt.generationsByDoc) {
      if (attempt.preResolutionStopKeys.has(key)) return false;
      if ((this.startGenerationByDoc.get(key) ?? 0) !== generation) {
        return false;
      }
    }
    return true;
  }

  stopAll(): void {
    // Invalidate every asynchronous start continuation before canceling live
    // registrations. In-flight snapshot listings may still resolve after
    // storage teardown, but they can neither publish a cache nor call
    // startCore under the new epoch.
    this.lifecycleEpoch++;
    this.resumeSnapshotsBySpace.clear();
    this.resumeSnapshotLoads.clear();
    // Cancel all tracked operations
    for (const cancel of this.allCancels) {
      try {
        cancel();
      } catch (error) {
        console.warn("Error canceling operation:", error);
      }
    }
    this.allCancels.clear();
    this.cancels.clear();
    // Clear the result pattern cache as well, since the actions have been
    // canceled
    this.resultPatternCache.clear();
    this.locallyPreparedResults.clear();
    this.locallyStoppedResults.clear();
    this.locallyCommittedHandlerResultStarts.clear();
    this.startGenerationByDoc.clear();
    this.activeStartAttemptsByDoc.clear();
    for (const attempt of this.activeStartAttempts) {
      attempt.generationsByDoc.clear();
      attempt.preResolutionStopKeys.clear();
    }
    this.activeStartAttempts.clear();
  }

  private instantiateNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
    moduleRefName?: string,
  ) {
    if (isModule(module)) {
      switch (module.type) {
        case "ref": {
          const refName = module.implementation as string;
          const resolved = this.runtime.moduleRegistry.getModule(refName);
          // `.asScope(scope)` records its scope on the *ref* module (the node's
          // module), but resolving the ref swaps in the registry's module — so
          // carry the declared default scope across, or it is silently dropped
          // and the node falls back to "space".
          this.instantiateNode(
            tx,
            module.defaultScope !== undefined
              ? { ...resolved, defaultScope: module.defaultScope }
              : resolved,
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
            schedulerRehydration,
            refName,
          );
          break;
        }
        case "javascript":
          this.instantiateJavaScriptNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
            schedulerRehydration,
          );
          break;
        case "raw":
          this.instantiateRawNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
            schedulerRehydration,
            moduleRefName,
          );
          break;
        case "passthrough":
          this.instantiatePassthroughNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
          );
          break;
        case "pattern":
          this.instantiatePatternNode(
            tx,
            module,
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
            schedulerRehydration,
          );
          break;
        default:
          throw new Error(`Unknown module type: ${module.type}`);
      }
    } else if (isWriteRedirectLink(module) || isAliasBinding(module)) {
      // TODO(seefeld): Implement, a dynamic node
    } else {
      throw new Error(`Unknown module: ${toCompactDebugString(module)}`);
    }
  }

  private bindNodeIO(
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    pattern: Pattern,
  ): BoundNodeIO {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    const outputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    return {
      inputs,
      outputs,
      reads: findAllWriteRedirectCells(inputs, resultCell),
      writes: findAllWriteRedirectCells(outputs, resultCell),
    };
  }

  private collectStaticRedirectWriteTargets(
    tx: IExtendedStorageTransaction,
    outputCells: readonly NormalizedFullLink[],
  ): NormalizedFullLink[] {
    return this.collectStaticRedirectWriteTargetsWithCompleteness(
      tx,
      outputCells,
    ).targets;
  }

  private collectStaticRedirectWriteTargetsWithCompleteness(
    tx: IExtendedStorageTransaction,
    outputCells: readonly NormalizedFullLink[],
  ): { targets: NormalizedFullLink[]; complete: boolean } {
    // Write redirects are the static writable-output form: resolving them here
    // lets pull-mode indexing treat the resolved target like a normal declared
    // write. Dynamic writable-input writes use materializer envelopes instead.
    if (!outputCells.some((link) => link.overwrite === "redirect")) {
      return { targets: [], complete: true };
    }

    // Redirect-target resolution is op-wiring machinery (machineryRead):
    // its reads must not consume `*`-path membership templates.
    return tx.runWithAmbientReadMeta(machineryRead, () => {
      const targets: NormalizedFullLink[] = [];
      let complete = true;
      for (const output of outputCells) {
        if (output.overwrite !== "redirect") continue;
        try {
          const { overwrite: _overwrite, ...target } = resolveLink(
            this.runtime,
            tx,
            output,
            "writeRedirect",
          );
          targets.push(target);
        } catch (error) {
          complete = false;
          // Some setup paths have not fully materialized metadata redirects
          // yet. Leave those to runtime dependency collection after the action
          // has run, but keep debug context for unexpected resolution failures.
          logger.debug("static-redirect-write-target", () => [
            "Unable to resolve static redirect write target",
            { output, error },
          ]);
        }
      }
      return { targets: dedupeNormalizedLinks(targets), complete };
    });
  }

  private collectStaticReadTargetsWithCompleteness(
    tx: IExtendedStorageTransaction,
    inputCells: readonly NormalizedFullLink[],
  ): { targets: NormalizedFullLink[]; complete: boolean } {
    // Declared inputs can point through their argument-slot redirect and then
    // through an ordinary link to the effective source cell. Resolve the full
    // static chain so the completeness certificate covers the same target the
    // action transaction will record at runtime.
    return tx.runWithAmbientReadMeta(machineryRead, () => {
      const targets: NormalizedFullLink[] = [];
      let complete = true;
      for (const input of inputCells) {
        try {
          const { overwrite: _overwrite, ...target } = resolveLink(
            this.runtime,
            tx,
            input,
            "value",
          );
          targets.push(target);
        } catch (error) {
          complete = false;
          logger.debug("static-read-target", () => [
            "Unable to resolve static read target",
            { input, error },
          ]);
        }
      }
      return { targets: dedupeNormalizedLinks(targets), complete };
    });
  }

  private populateDeclaredSchedulerReads(
    reads: readonly NormalizedFullLink[],
    depTx: IExtendedStorageTransaction,
  ): void {
    depTx.runWithAmbientReadMeta(schedulerDependencyRead, () => {
      this.#populateDeclaredSchedulerReadsInner(reads, depTx);
    });
  }

  #populateDeclaredSchedulerReadsInner(
    reads: readonly NormalizedFullLink[],
    depTx: IExtendedStorageTransaction,
  ): void {
    // For event preflight, writable-input links are narrower than traversing
    // captured argument objects and avoid treating broad closures as demand.
    for (const read of reads) {
      let target = read;
      if (read.overwrite === "redirect") {
        try {
          const { overwrite: _overwrite, ...resolved } = resolveLink(
            this.runtime,
            depTx,
            read,
            "writeRedirect",
          );
          target = {
            ...resolved,
            schema: resolved.schema ?? read.schema,
          };
        } catch (error) {
          logger.debug("scheduler-read-redirect", () => [
            "Unable to resolve scheduler read redirect",
            { read, error },
          ]);
        }
      }
      this.runtime.getCellFromLink(target, target.schema, depTx)?.get();
    }
  }

  private populateHandlerEventSchedulerReads(
    argumentSchema: JSONSchema | undefined,
    resultCell: Cell<any>,
    event: unknown,
    depTx: IExtendedStorageTransaction,
  ): void {
    if (!isRecord(argumentSchema) || !isRecord(argumentSchema.properties)) {
      return;
    }
    const eventSchema = argumentSchema.properties.$event;
    if (eventSchema === undefined) {
      return;
    }

    const eventDependencySchema: JSONSchema = {
      type: "object",
      properties: { $event: eventSchema as JSONSchema },
      ...(argumentSchema.$defs !== undefined &&
        { $defs: argumentSchema.$defs }),
      ...(argumentSchema.definitions !== undefined &&
        { definitions: argumentSchema.definitions }),
    };
    const inputsCell = this.runtime.getImmutableCell(
      resultCell.space,
      { $event: event },
      undefined,
      depTx,
    );
    inputsCell.asSchema(eventDependencySchema).get({
      traverseCells: true,
    });
  }

  private collectWritableCellArgumentLinks(
    argumentSchema: JSONSchema | undefined,
    value: unknown,
    resultCell: Cell<any>,
    writeInputPaths?: readonly (readonly string[])[],
  ): NormalizedFullLink[] {
    const links: NormalizedFullLink[] = [];
    const seen = new WeakMap<object, Set<string>>();

    const pathsOverlap = (
      left: readonly string[],
      right: readonly string[],
    ): boolean => {
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      return shorter.every((segment, index) => longer[index] === segment);
    };
    const shouldCollectPath = (path: readonly string[]): boolean =>
      !writeInputPaths || writeInputPaths.length === 0 ||
      writeInputPaths.some((writePath) => pathsOverlap(path, writePath));

    const visit = (
      schema: unknown,
      currentValue: unknown,
      path: readonly string[],
    ): void => {
      if (!isRecord(schema)) return;
      const pathKey = JSON.stringify(path);
      const seenPaths = seen.get(schema);
      if (seenPaths?.has(pathKey)) return;
      if (seenPaths) {
        seenPaths.add(pathKey);
      } else {
        seen.set(schema, new Set([pathKey]));
      }

      const asCell = schema.asCell;
      if (
        Array.isArray(asCell) &&
        (asCell.includes("cell") || asCell.includes("writeonly"))
      ) {
        if (shouldCollectPath(path)) {
          links.push(...findAllWriteRedirectCells(currentValue, resultCell));
        }
        return;
      }

      // Keyword descent via the shared walk (a keyword missed here means
      // asCell markers escaping write tracking — the prefixItems gap,
      // CT-1895). The value-position keywords align value and path — a
      // named property or undeclared-key (`additionalProperties`) at its
      // key, a tuple slot at its index, `items` elements past the slots at
      // theirs — falling back to the conservative same-value/same-path
      // visit when value and schema misalign. Combinator branches and
      // `not` genuinely describe the same position: same value, same path.
      // `not` is included deliberately: a nested `not` (not-of-not)
      // re-selects values that DO match the inner subschema, so skipping it
      // could let an asCell marker escape tracking; over-collection is this
      // walker's safe direction (mirrors joinSchema's `not` union).
      //
      // TODO(danfuzz): The properties/additionalProperties cases descend
      // live `FabricValue` action inputs with no `FabricSpecialObject`
      // guard, decomposing `FabricPrimitive` values and walking
      // `FabricInstance` values by internal slots.
      forEachSubschema(schema as JSONSchema, (child, keyword, key, index) => {
        switch (keyword) {
          case "properties":
            if (isRecord(currentValue)) {
              visit(child, currentValue[key!], [...path, key!]);
            }
            return;
          case "prefixItems":
            visit(
              child,
              Array.isArray(currentValue) ? currentValue[index!] : currentValue,
              [...path, String(index!)],
            );
            return;
          case "items":
            if (Array.isArray(currentValue)) {
              // `items` covers the elements past the tuple slots (2020-12).
              const start = Array.isArray(schema.prefixItems)
                ? schema.prefixItems.length
                : 0;
              for (let i = start; i < currentValue.length; i++) {
                visit(child, currentValue[i], [...path, String(i)]);
              }
            } else {
              visit(child, currentValue, path);
            }
            return;
          case "additionalProperties":
            if (isRecord(currentValue) && !Array.isArray(currentValue)) {
              // Covers only the keys `properties` does not declare.
              const declaredKeys = isRecord(schema.properties)
                ? new Set(Object.keys(schema.properties))
                : undefined;
              for (const [k, v] of Object.entries(currentValue)) {
                if (declaredKeys?.has(k)) continue;
                visit(child, v, [...path, k]);
              }
            } else {
              visit(child, currentValue, path);
            }
            return;
          default:
            visit(child, currentValue, path);
            return;
        }
      });
    };

    visit(argumentSchema, value, []);
    return dedupeNormalizedLinks(links);
  }

  private moduleHasOpaqueResult(module: Module): boolean {
    const resultSchema = module.resultSchema;
    return isRecord(resultSchema) &&
      Array.isArray(resultSchema.asCell) &&
      resultSchema.asCell.includes("opaque");
  }

  private collectArgumentSchedulerReadLinks(
    argumentSchema: JSONSchema | undefined,
    value: unknown,
    resultCell: Cell<any>,
  ): NormalizedFullLink[] {
    const links: NormalizedFullLink[] = [];
    const seen = new WeakMap<object, Set<unknown>>();
    const rootSchema = argumentSchema;

    const schemaWithRootDefinitions = (
      schema: JSONSchema | undefined,
    ): JSONSchema | undefined => {
      if (!isRecord(schema) || !isRecord(rootSchema)) {
        return schema;
      }
      return {
        ...schema,
        ...(schema.$defs === undefined && rootSchema.$defs !== undefined &&
          { $defs: rootSchema.$defs }),
        ...(schema.definitions === undefined &&
          rootSchema.definitions !== undefined &&
          { definitions: rootSchema.definitions }),
      };
    };

    const visit = (schema: unknown, currentValue: unknown): void => {
      // Sigil-only, deliberately NOT paired with `isAliasBinding`: the value
      // is post-unwrap, where the only `$alias` records left belong to
      // embedded Pattern values (their `defer` bookkeeping resolves them at
      // that pattern's own instantiation) — parsing one here would read it at
      // the wrong nesting level.
      if (isWriteRedirectLink(currentValue)) {
        const link = parseLink(currentValue, resultCell);
        links.push({
          ...link,
          schema: link.schema ?? schemaWithRootDefinitions(
            schema as JSONSchema | undefined,
          ),
        });
        return;
      }
      if (isCellLink(currentValue)) {
        return;
      }
      if (!isRecord(schema)) return;
      const seenValues = seen.get(schema) ?? new Set<unknown>();
      if (seenValues.has(currentValue)) return;
      seenValues.add(currentValue);
      seen.set(schema, seenValues);

      // TODO(danfuzz): This descends live `FabricValue` action inputs via
      // `Object.entries` (guards only `isWriteRedirectLink`/`isCellLink`, not
      // `FabricSpecialObject`), so `FabricPrimitive`/`FabricInstance` values are
      // mishandled.
      if (isRecord(schema.properties) && isRecord(currentValue)) {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
          visit(propertySchema, currentValue[key]);
        }
      }

      if (Array.isArray(currentValue)) {
        // A tuple slot covers its exact index; `items` covers the indices
        // past the slots (2020-12). prefixItems-only schemas previously
        // skipped elements entirely.
        const prefixItems = Array.isArray(schema.prefixItems)
          ? schema.prefixItems
          : undefined;
        for (let index = 0; index < currentValue.length; index++) {
          const slotSchema =
            prefixItems !== undefined && index < prefixItems.length
              ? prefixItems[index]
              : schema.items;
          if (slotSchema !== undefined) {
            visit(slotSchema, currentValue[index]);
          }
        }
      }
      if (
        schema.additionalProperties !== undefined &&
        isRecord(currentValue)
      ) {
        const declaredKeys = isRecord(schema.properties)
          ? new Set(Object.keys(schema.properties))
          : undefined;
        for (const [key, propertyValue] of Object.entries(currentValue)) {
          if (declaredKeys?.has(key)) continue;
          visit(schema.additionalProperties, propertyValue);
        }
      }
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        const branches = schema[key];
        if (Array.isArray(branches)) {
          for (const branch of branches) visit(branch, currentValue);
        }
      }
    };

    visit(argumentSchema, value);
    return dedupeNormalizedLinks(links);
  }

  private resolveJavaScriptFunction(
    module: Module,
  ): ResolvedJavaScriptModule {
    // Resolution order (docs/specs/content-addressed-action-identity.md):
    // 1. content-addressed `$implRef` — resolve the registered builder
    //    artifact by `{ identity, symbol }` from the in-memory indexes (only
    //    trust-gated artifacts are indexed, so whatever resolves is
    //    builder-made — host pseudo-modules included) and run its
    //    implementation;
    // 2. the module's LIVE implementation, when it carries trust-gated
    //    identity facts — module-eval provenance (process-global,
    //    content-derived), or an entry ref THIS runtime's engine resolves to
    //    the same function (host pseudo-modules are registry-scoped: a host
    //    trust grant in another runtime of the same process proves nothing
    //    here). This is the in-memory instantiation path: a trusted module
    //    that never round-tripped through JSON has no `$implRef` property,
    //    but its function IS the artifact (pre-E5 this resolved through the
    //    legacy ref index — same function, different lookup);
    // 3. the stringified-source fallback (SES-sandboxed, CFC-unverified) —
    //    test-built / never-verified modules. A forged fn carries neither
    //    provenance nor an entry ref, so it always lands here.
    const liveEntryRef = typeof module.implementation === "function"
      ? getArtifactEntryRef(module.implementation)
      : undefined;
    const liveTrusted = typeof module.implementation === "function" &&
        (getVerifiedProvenance(module.implementation) !== undefined ||
          (liveEntryRef !== undefined &&
            this.runtime.harness.getVerifiedImplementation?.(
                liveEntryRef.identity,
                liveEntryRef.symbol,
              ) === module.implementation))
      ? module.implementation as (...args: any[]) => any
      : undefined;
    const fn: (...args: any[]) => any = this.resolveByImplRef(module) ??
      liveTrusted ??
      this.getFallbackJavaScriptImplementation(module);

    const namedFn = fn as {
      src?: string;
      name?: string;
      sourceLocationSample?: Record<string, unknown>;
    };
    const name = namedFn.src || fn.name;
    if (name && namedFn.sourceLocationSample) {
      sourceLocationLogger.flag("sample", name, true, {
        name,
        ...namedFn.sourceLocationSample,
      });
    }

    return { fn, name };
  }

  /**
   * Resolve a module's implementation through its content-addressed
   * `$implRef` (the defining module's content identity + the registered
   * artifact's export/`__cfReg` symbol). Returns undefined on a miss (no ref,
   * never registered, or rolled out of the bounded index) — callers fall back
   * to the legacy ref or the stringified source.
   */
  private resolveByImplRef(
    module: Module,
  ): ((...args: any[]) => any) | undefined {
    const ref = (module as { $implRef?: { identity: string; symbol: string } })
      .$implRef;
    if (
      !ref || typeof ref.identity !== "string" ||
      typeof ref.symbol !== "string"
    ) {
      return undefined;
    }
    const artifact = this.runtime.patternManager.artifactFromIdentitySync(
      ref.identity,
      ref.symbol,
    );
    if (artifact) {
      const implementation =
        (artifact as { implementation?: unknown }).implementation ?? artifact;
      if (typeof implementation === "function") {
        return implementation as (...args: any[]) => any;
      }
    }
    // Eviction insurance: the artifact index is FIFO-bounded and can roll a
    // running pattern's module out mid-session, and a post-flip graph has no
    // legacy ref (and no body when the writer proved resolvability). The
    // engine's content-addressed implementation index is strong for the
    // session, so the `$implRef` keeps resolving.
    return this.runtime.harness.getVerifiedImplementation?.(
      ref.identity,
      ref.symbol,
    ) as ((...args: any[]) => any) | undefined;
  }

  /**
   * Attach a stable, content-addressed implementation identity
   * (`cf:module/<identity>:<symbol>`) to an action, derived from its module
   * implementation's verified provenance — NOT from the source location. This
   * keeps action identity / fingerprints independent of `.src` and its (broken)
   * source-map resolution: the discriminator is the hoisted `__cfReg`/export
   * `symbol`, not `:line:col`. No-op for implementations with no verified
   * provenance (host / dynamic / test builders); the scheduler then resolves
   * `getVerifiedProvenance` live or falls to a generated id.
   * See docs/specs/content-addressed-action-identity.md.
   */
  private applyImplementationHash(
    action: Action,
    implementation: unknown,
  ): void {
    const provenance = typeof implementation === "function"
      ? getVerifiedProvenance(implementation)
      : undefined;
    if (provenance?.identity) {
      (action as { implementationHash?: string }).implementationHash =
        provenance.symbol
          ? `cf:module/${provenance.identity}:${provenance.symbol}`
          : `cf:module/${provenance.identity}`;
    }
  }

  /**
   * If the final target of the link chain is a stream, return the first link
   * as `streamLink`. When the inputs carry a `$event` key — i.e. the node was
   * authored as a handler — but the chain does not end in a stream marker,
   * return what it resolved to instead (`eventTarget`), so the caller can
   * report why the node cannot be instantiated as a handler.
   *
   * @param inputs
   * @param base
   * @param tx
   * @returns
   */
  private resolveJavaScriptStreamLink(
    inputs: FabricValue,
    base: NormalizedFullLink,
    tx: IExtendedStorageTransaction,
  ): {
    streamLink?: NormalizedFullLink;
    eventTarget?: { link?: NormalizedFullLink; value: FabricValue };
  } {
    if (!isRecord(inputs) || !("$event" in inputs)) return {};

    // Sigil-only: `$event` is builder-generated and always unwraps to a sigil
    // link; a residual `$alias` here could only be an embedded pattern's
    // binding, which must not be followed at this level.
    let value: FabricValue = inputs.$event as FabricValue;
    let lastLink: NormalizedFullLink | undefined;
    while (isWriteRedirectLink(value)) {
      lastLink = resolveLink(
        this.runtime,
        tx,
        parseLink(value, base),
        "writeRedirect",
      );
      value = tx.readValueOrThrow(lastLink);
    }

    return isStreamValue(value)
      ? { streamLink: parseLink(inputs.$event, base) }
      : { eventTarget: { link: lastLink, value } };
  }

  private createPatternFrame(
    cause: unknown,
    pattern: Pattern,
    resultCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    inHandler: boolean,
    implementationIdentity?: ImplementationIdentity,
  ): Frame {
    return pushFrameFromCause(cause, {
      unsafe_binding: {
        pattern,
        materialize: (path: readonly PropertyKey[]) =>
          resultCell.getAsQueryResult(path, tx),
        space: resultCell.space,
        tx,
      },
      inHandler,
      frameKind: inHandler ? "handler" : "lift",
      // Freeze the handler's ambient clock to the dispatching event's instant
      // (see Frame.eventTime / sandboxDateNow). A handler invoked directly rather
      // than through event dispatch (a test, an internal call) has no dispatched
      // time, so capture the clock once here; it stays frozen for that run.
      ...(inHandler ? { eventTime: tx.dispatchedEventTime ?? Date.now() } : {}),
      runtime: this.runtime,
      space: resultCell.space,
      tx,
      ...(implementationIdentity ? { implementationIdentity } : {}),
    });
  }

  private readJavaScriptArgument(
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
    options: { bindTxToSchema?: boolean; writableProxy?: boolean } = {},
  ): { argument: any; isValidArgument: boolean } {
    const argument = module.argumentSchema !== undefined
      ? options.bindTxToSchema
        ? inputsCell.asSchema(module.argumentSchema).withTx(tx).get()
        : inputsCell.asSchema(module.argumentSchema).get()
      : inputsCell.getAsQueryResult([], tx, options.writableProxy);

    return {
      argument,
      isValidArgument: module.argumentSchema === false ||
        argument !== undefined,
    };
  }

  private serializeQueryResult(
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): string {
    try {
      return JSON.stringify(inputsCell.getAsQueryResult([], tx));
    } catch (_error) {
      return "(Can't serialize to JSON)";
    }
  }

  private getJavaScriptInputState(
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): { schema: Module["argumentSchema"]; raw: unknown; queryResult: string } {
    return {
      schema: module.argumentSchema,
      raw: inputsCell.getRaw(),
      queryResult: this.serializeQueryResult(inputsCell, tx),
    };
  }

  private updateInvalidInputFlag(
    name: string | undefined,
    isValidArgument: boolean,
    module: Module,
    inputsCell: Cell<any>,
    tx: IExtendedStorageTransaction,
  ): void {
    if (!name) return;

    if (!isValidArgument) {
      logger.flag(
        "action invalid input",
        `action:${name}`,
        true,
        this.getJavaScriptInputState(module, inputsCell, tx),
      );
      return;
    }

    logger.flag(
      "action invalid input",
      `action:${name}`,
      false,
    );
  }

  /**
   * Opt `tx` into multi-space writes for a cross-space child, accumulating the
   * commit order so every child space committed in this transaction is ordered
   * before `parentSpace`. Without accumulation, a second cross-space child would
   * replace the order with `[child2, parent]`, dropping `child1` to after the
   * parent (orderedCommitSpaces appends unlisted written spaces), which would
   * make the parent's link to `child1` durable before `child1`'s target.
   */
  // Public so the pattern builder (builder/pattern.ts
  // `optIntoInSpaceMultiSpaceCommit`) can opt a transaction into a multi-space
  // commit the moment a handler's `.inSpace(...)` target resolves — before the
  // cross-space write executes (e.g. appending to the home `profiles` list,
  // whose elements live in their own spaces).
  enableCrossSpaceChildCommit(
    tx: IExtendedStorageTransaction,
    childSpace: MemorySpace,
    parentSpace: MemorySpace,
  ): void {
    let childSpaces = this.crossSpaceChildSpaces.get(tx);
    if (childSpaces === undefined) {
      childSpaces = [];
      this.crossSpaceChildSpaces.set(tx, childSpaces);
    }
    if (childSpace !== parentSpace && !childSpaces.includes(childSpace)) {
      childSpaces.push(childSpace);
    }
    // All accumulated child spaces first, parent last.
    tx.enableMultiSpaceWrites?.([...childSpaces, parentSpace]);
  }

  private handleJavaScriptHandlerResult(
    tx: IExtendedStorageTransaction,
    result: any,
    resultHasReactives: boolean,
    frame: Frame,
    patternResultCell: Cell<any>,
    addCancel: AddCancel,
    cause: Record<string, any>,
  ): any {
    const receiptCell = this.runtime.getCell(
      patternResultCell.space,
      { resultFor: cause },
      undefined,
      tx,
    );
    const receiptsEnabled =
      this.runtime.experimental.commitPreconditions === true;
    if (!resultHasReactives && frame.reactives.size === 0) {
      if (receiptsEnabled) {
        // Receipt-only handling (spec scheduler-v2 §7.6): nothing was
        // launched, but the result cell is still created — its create is the
        // exactly-once witness for this event id.
        receiptCell.withTx(tx).setRaw({});
        tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
      }
      return result;
    }

    const receiptKey = this.getDocKey(receiptCell);
    if (
      receiptsEnabled &&
      this.locallyCommittedHandlerResultStarts.has(receiptKey) &&
      this.cancels.has(receiptKey) &&
      receiptCell.getRaw({ meta: ignoreReadForScheduling }) !== undefined
    ) {
      // Local sequential-redelivery fast path. The winner's result wrapper is
      // already durably committed and still live in this runner, so do not run
      // the newly-built result pattern into that shared cell: doing so can
      // stage a changed inSpace child before the duplicate loses its receipt.
      // The server-side create-only precondition remains authoritative and
      // still rejects every parent write in this duplicate transaction. This
      // local observation is only containment, not a system-wide receipt proof.
      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    // navigateTo result patterns must start after the handler's transaction
    // commits so the navigation target is durable. Every other handler result
    // pattern runs into the canonical result/receipt cell in the handler's
    // space. Individual inSpace child nodes route themselves to their target
    // space in instantiatePatternNode, which also establishes child-before-
    // parent commit order and replicates the child's pattern artifacts.
    const deferForNavigate = this.handlerResultPatternHasNavigateTo(
      resultPattern,
    );

    if (deferForNavigate && result === undefined) {
      // navigateTo results are commit-gated (startAfterSuccessfulCommit);
      // the receipt precondition rides the deferred start's own create.
      const cancelDeferredStart = this.runPatternAfterSuccessfulCommit(
        tx,
        receiptCell,
        resultPattern,
        undefined,
        true,
        true,
      );
      addCancel(cancelDeferredStart);
      this.runtime.scheduler.lineage.recordPieceStop(
        tx,
        cancelDeferredStart,
      );
      return result;
    }

    let installedCancel: Cancel | undefined;
    let cancelDeferredStart: Cancel | undefined;
    const resultCell = deferForNavigate
      ? (() => {
        const setup = this.setupDeferredHandlerResultPattern(
          tx,
          resultPattern,
          patternResultCell.space,
          cause,
          true,
        );
        cancelDeferredStart = setup.cancelDeferredStart;
        return setup.resultCell;
      })()
      : (() => {
        const run = this.runWithStartOwnership(
          tx,
          resultPattern,
          undefined,
          receiptCell,
        );
        installedCancel = run.installedCancel;
        cancelDeferredStart = run.cancelDeferredStart;
        return run.resultCell;
      })();

    if (!deferForNavigate) {
      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
    }

    if (deferForNavigate) {
      if (cancelDeferredStart !== undefined) {
        // The start itself is commit-gated, but the parent piece owns it from
        // scheduling onward: cancellation before commit tombstones the start;
        // cancellation after installation stops only this attempt's child.
        addCancel(cancelDeferredStart);
        this.runtime.scheduler.lineage.recordPieceStop(
          tx,
          cancelDeferredStart,
        );
      }
    } else if (
      installedCancel !== undefined || cancelDeferredStart !== undefined
    ) {
      // Both lifetime cancellation and failure compensation belong only to the
      // attempt that owns this local start (immediate or commit-gated). A
      // receipt-losing duplicate reuses the deterministic wrapper and must not
      // stop the winner.
      let cancelled = false;
      const cancelOwnedStart = cancelDeferredStart ?? (() => {
        if (cancelled) return;
        cancelled = true;
        const key = this.getDocKey(resultCell);
        if (this.cancels.get(key) !== installedCancel) return;
        this.stop(resultCell);
      });
      addCancel(cancelOwnedStart);
      // Spec scheduler-v2 §7.6 rule 2: the launch is speculative; if this
      // handler's transaction ultimately fails, stop the piece (data writes
      // roll back with the transaction; registrations do not).
      this.runtime.scheduler.lineage.recordPieceStop(
        tx,
        cancelOwnedStart,
      );
      if (receiptsEnabled) {
        tx.addCommitCallback((_committedTx, commitResult) => {
          if (!commitResult.error && this.cancels.has(receiptKey)) {
            this.locallyCommittedHandlerResultStarts.add(receiptKey);
          }
        });
      }
    }

    return result;
  }

  /**
   * Resolves any `PatternFactory.inSpace("name")` targets that the just-finished
   * handler/action referenced but whose space DID was not yet cached, then
   * throws {@link RetryImmediately} so the scheduler re-runs the handler/action.
   * On the re-run the names resolve synchronously from the runtime cache (see
   * the pattern builder's resolveInSpaceTargetSpace), so the child results are
   * routed into the correct spaces from the start — no link rewriting required.
   */
  private async resolvePendingSpaceNamesAndRetry(
    frame: Frame,
  ): Promise<never> {
    const names = [...(frame.pendingSpaceNames ?? [])];
    await Promise.all(
      names.map((name) => this.runtime.resolveSpaceName(name)),
    );
    throw new RetryImmediately(
      `Resolving in-space target spaces: ${names.join(", ")}`,
    );
  }

  private handlerResultPatternHasNavigateTo(
    pattern: Pattern,
  ): boolean {
    return pattern.nodes.some(({ module }) =>
      module.type === "ref" && module.implementation === "navigateTo"
    );
  }

  private setupDeferredHandlerResultPattern(
    tx: IExtendedStorageTransaction,
    resultPattern: Pattern,
    resultSpace: MemorySpace,
    cause: Record<string, any>,
    markCreateOnlyResult = false,
  ): DeferredStartResult<any> {
    const resultCell = this.runtime.getCell(
      resultSpace,
      { resultFor: cause },
      undefined,
      tx,
    );
    const resultSetup = this.setupInternal(
      tx,
      resultPattern,
      undefined,
      resultCell,
    );
    // The receipt mark must ride the transaction that creates the result
    // cell's head — setupInternal just wrote it into the handler tx. Marking
    // the deferred start tx instead would see the already-committed head and
    // reject the FIRST delivery as receipt-exists, while redeliveries (whose
    // own handler tx re-creates the cell) would go unguarded.
    if (markCreateOnlyResult) {
      tx.markCreateOnly?.(resultCell.getAsNormalizedFullLink());
    }
    const cancelDeferredStart = resultSetup.needsStart
      ? this.startAfterSuccessfulCommit(
        tx,
        resultCell,
        resultSetup.pattern,
        {},
        this.patternNeedsOneShotPull(resultSetup.pattern),
      )
      : undefined;
    return { resultCell, cancelDeferredStart };
  }

  private patternNeedsOneShotPull(pattern?: Pattern): boolean {
    if (!pattern) {
      return false;
    }
    return pattern.nodes.some(({ module }) => {
      if (module.type !== "ref" || typeof module.implementation !== "string") {
        return false;
      }
      return EAGER_RESULT_BUILTIN_REFS.has(module.implementation);
    });
  }

  private pullCellOnceAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
  ): void {
    const resultLink = resultCell.getAsNormalizedFullLink();
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        return;
      }
      this.pullCellOnceInPullMode(this.runtime.getCellFromLink<T>(resultLink));
    });
  }

  private pullCellOnceInPullMode<T = any>(cell: Cell<T>): void {
    void cell.pull().catch((error) => {
      logger.error(
        "runner-start",
        "Transient result pull failed after commit",
        error,
      );
    });
  }

  private writeJavaScriptActionResult(
    tx: IExtendedStorageTransaction,
    resultSchema: JSONSchema | undefined,
    result: any,
    resultHasReactives: boolean,
    frame: Frame,
    resultCell: Cell<any>,
    outputs: FabricValue,
    addCancel: AddCancel,
    _resultFor: { inputs: FabricValue; outputs: FabricValue; fn: string },
    previousResultCellRef: JavaScriptActionResultCells,
    narrowestReadScope?: CellScope,
  ): any {
    if (!resultHasReactives && frame.reactives.size === 0) {
      recordOutputSchemaPolicyInputs(
        tx,
        this.runtime,
        resultCell,
        outputs,
        resultSchema,
      );
      sendValueToBinding(
        tx,
        resultCell,
        getMetaLink(resultCell, "argument")!,
        outputs,
        result,
        {
          narrowestReadScope,
        },
      );
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    const effectiveOutputScope = narrowestScope([
      schemaCellScope(resultSchema),
      schemaCellScope(resultPattern.resultSchema),
      narrowestReadScope,
    ]);
    // See if the resultCell was already in this effective output scope
    const previousScopedResultCell = previousResultCellRef.byScope.get(
      effectiveOutputScope,
    );
    if (previousScopedResultCell === undefined) {
      const baseResultCell = this.runtime.getCell(
        resultCell.space,
        _resultFor,
        undefined,
        tx,
      );
      const newResultCell = effectiveOutputScope === "space"
        ? baseResultCell
        : createCell(
          this.runtime,
          {
            ...baseResultCell.getAsNormalizedFullLink(),
            scope: effectiveOutputScope,
          },
          tx,
        );
      previousResultCellRef.byScope.set(effectiveOutputScope, newResultCell);
      resultCell = newResultCell;
    } else {
      resultCell = previousScopedResultCell;
    }

    const resultPatternAsString = JSON.stringify(resultPattern);
    const cacheKey = this.getDocKey(resultCell);
    const previousResultPatternAsString = this.resultPatternCache.get(cacheKey);
    const patternUnchanged =
      previousResultPatternAsString === resultPatternAsString;

    if (!patternUnchanged) {
      this.resultPatternCache.set(cacheKey, resultPatternAsString);

      const childSetupTx = new TransactionWrapper(tx, {
        nonReactive: true,
      });
      this.run(
        childSetupTx,
        resultPattern,
        undefined,
        resultCell,
      );
      addCancel(() => this.stop(resultCell));

      tx.addCommitCallback((_committedTx, result) => {
        if (result.error) {
          this.stop(resultCell);
        }
      });
      this.pullCellOnceAfterSuccessfulCommit(tx, resultCell);
    }

    const effectiveResultSchema = resultSchema ?? resultPattern.resultSchema ??
      resultCell.schema;
    recordOutputSchemaPolicyInputs(
      tx,
      this.runtime,
      resultCell,
      outputs,
      effectiveResultSchema,
    );
    sendValueToBinding(
      tx,
      resultCell,
      getMetaLink(resultCell, "argument")!,
      outputs,
      resultCell.getAsLink(),
      { narrowestReadScope: effectiveOutputScope },
    );
    return result;
  }

  private instantiateJavaScriptHandlerNode(
    {
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      reads,
      writes,
      streamLink,
    }: JavaScriptNodeContext & { streamLink: NormalizedFullLink },
  ): void {
    const handler = (tx: IExtendedStorageTransaction, event: any) => {
      if (event?.preventDefault) event.preventDefault();

      const eventInputs = {
        ...(inputs as Record<string, any>),
        $event: event,
      };
      // Spec scheduler-v2 §7.6 / decision 13: the handler's result cell — and
      // every id minted in this frame — derives from the durable event id, so
      // retries of the same event reuse the same ids and duplicate handlings
      // collide on the receipt. The fallback covers non-dispatch invocations
      // (tests calling the handler directly).
      const cause = {
        ...(inputs as Record<string, any>),
        $event: tx.dispatchedEventId ?? crypto.randomUUID(),
      };
      const policyFacingIdentity = resolvePolicyFacingImplementationIdentity(
        module,
        { implementation: fn },
      );
      const frame = this.createPatternFrame(
        cause,
        pattern,
        resultCell,
        tx,
        true,
        policyFacingIdentity,
      );
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      let popFrameAfterReturn = true;
      try {
        const inputsCell = this.runtime.getImmutableCell(
          resultCell.space,
          eventInputs,
          undefined,
          tx,
        );
        logger.timeStart("stream", "readInputs");
        const { argument, isValidArgument } = (() => {
          try {
            return this.readJavaScriptArgument(
              module,
              inputsCell,
              tx,
              {
                writableProxy:
                  (module as { writableProxy?: boolean }).writableProxy,
              },
            );
          } finally {
            logger.timeEnd("stream", "readInputs");
          }
        })();

        this.updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
          tx,
        );

        if (!isValidArgument) {
          const inputState = this.getJavaScriptInputState(
            module,
            inputsCell,
            tx,
          );
          logger.error(
            "stream",
            () => [
              "action argument is undefined (potential schema mismatch) -- not running",
              {
                schema: inputState.schema,
                raw: inputState.raw,
                asQueryResult: inputState.queryResult,
              },
            ],
          );
        }

        let result: any = undefined;
        if (isValidArgument) {
          logger.timeStart("stream", "invokeJavaScriptImplementation");
          try {
            result = this.invokeJavaScriptImplementation(
              module,
              fn,
              argument,
            );
            if (result instanceof Promise) {
              result = result.finally(() =>
                logger.timeEnd("stream", "invokeJavaScriptImplementation")
              );
            } else {
              logger.timeEnd("stream", "invokeJavaScriptImplementation");
            }
          } catch (error) {
            logger.timeEnd("stream", "invokeJavaScriptImplementation");
            throw error;
          }
        }
        const postRun = (result: any) => {
          logger.timeStart("stream", "postRun");
          try {
            if (frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0) {
              return this.resolvePendingSpaceNamesAndRetry(frame);
            }
            const normalized = normalizeSandboxResult(result, name);
            return this.handleJavaScriptHandlerResult(
              tx,
              normalized.value,
              normalized.hasReactive,
              frame,
              resultCell,
              addCancel,
              cause,
            );
          } finally {
            logger.timeEnd("stream", "postRun");
          }
        };

        const postRunResult = result instanceof Promise
          ? result.then(postRun)
          : postRun(result);
        if (postRunResult instanceof Promise) {
          popFrameAfterReturn = false;
          return postRunResult.finally(() => popFrame(frame));
        }
        return postRunResult;
      } catch (error) {
        // The handler body may throw while materializing a not-yet-resolved
        // inSpace("name") child (e.g. set into a cell). If so, resolve the
        // pending names and retry instead of surfacing the error.
        if (
          !(error instanceof RetryImmediately) &&
          frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0
        ) {
          popFrameAfterReturn = false;
          return this.resolvePendingSpaceNamesAndRetry(frame)
            .finally(() => popFrame(frame));
        }
        (error as Error & { frame?: Frame }).frame = frame;
        throw error;
      } finally {
        if (popFrameAfterReturn) popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(handler, `handler:${name}`, { setSrc: true });
    }

    // Ensure the handler's input docs are locally available before the body
    // runs: materialize the argument the same way the handler will (asCell
    // fields surface as Cells WITHOUT reading their backing docs), then await
    // sync() on each collected Cell. The scheduler awaits this before
    // dispatching the event. Without it, a synchronous in-handler read of an
    // asCell input (e.g. SqliteDb.exec reading the handle doc) races the
    // doc-carrying storage response on a cold replica — piece-start sync
    // (syncCellsForRunningPattern) covers node binding docs, not the docs
    // behind link VALUES like a builtin's result handle. Steady-state this is
    // ~free: covered selectors resolve without a server round trip.
    const presyncInputs = module.argumentSchema !== undefined
      ? async (event: any): Promise<void> => {
        const eventInputs = {
          ...(inputs as Record<string, any>),
          $event: event,
        };
        const inputsCell = this.runtime.getImmutableCell(
          resultCell.space,
          eventInputs,
          undefined,
        );
        const argument = inputsCell.asSchema(module.argumentSchema!).get();
        const promises: Promise<unknown>[] = [];
        const seen = new Set<unknown>();
        const collect = (value: unknown, depth: number): void => {
          if (depth > 16) return;
          if (isCell(value)) {
            promises.push(value.sync());
            return;
          }
          // NOTE: materialized records all carry the back-to-cell symbol, so
          // there is no cheap way to tell a lazy query-result proxy from an
          // annotated plain object — descend both. Property access on a proxy
          // is an ambient local read (it may kick off, but never await, a
          // sync); guard each access so one lazy read failing doesn't abort
          // the rest of the presync.
          if (!isRecord(value)) return;
          if (seen.has(value)) return;
          seen.add(value);
          for (const key of Object.keys(value)) {
            try {
              collect((value as Record<string, unknown>)[key], depth + 1);
            } catch {
              // A lazy read through a not-yet-synced link may throw; skip.
            }
          }
        };
        collect(argument, 0);
        await Promise.all(promises);
      }
      : undefined;

    // Tag the handler with its owning pattern instance so the delivery shaper
    // can group a pattern's input across its several streams into one shaping
    // window (per-pattern coalescing, W3). The result cell is stable per
    // instance, so all of one instance's handlers share this id.
    const instanceLink = resultCell.getAsNormalizedFullLink();
    const wrappedHandler = Object.assign(handler, {
      reads,
      writes,
      module,
      pattern,
      schedulerObservationIdentity: {
        pieceId: `${instanceLink.scope ?? "space"}:${instanceLink.id}`,
        ownerSpace: instanceLink.space,
      },
      ...(presyncInputs !== undefined && { presyncInputs }),
    });

    const schedulerReads = this.collectArgumentSchedulerReadLinks(
      module.argumentSchema,
      inputs,
      resultCell,
    );
    const declaredSchedulerReads = schedulerReads.length > 0
      ? schedulerReads
      : reads;
    const populateDependencies = reads.length > 0
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        this.populateDeclaredSchedulerReads(declaredSchedulerReads, depTx);
        this.populateHandlerEventSchedulerReads(
          module.argumentSchema,
          resultCell,
          event,
          depTx,
        );
      }
      : module.argumentSchema
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        const eventInputs = {
          ...(inputs as Record<string, any>),
          $event: event,
        };
        const inputsCell = this.runtime.getImmutableCell(
          resultCell.space,
          eventInputs,
          undefined,
          depTx,
        );
        inputsCell.asSchema(module.argumentSchema!).get({
          traverseCells: true,
        });
      }
      : undefined;

    addCancel(
      this.runtime.scheduler.addEventHandler(
        wrappedHandler,
        streamLink,
        populateDependencies,
      ),
    );
  }

  private instantiateJavaScriptActionNode(
    {
      tx,
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      inputs,
      outputs,
      reads,
      writes,
      schedulerRehydration,
    }: JavaScriptNodeContext,
  ): void {
    if (isRecord(inputs) && "$event" in inputs) {
      throw new Error(
        "Handler used as lift, because $stream: true was overwritten",
      );
    }

    const inputsCell = this.runtime.getImmutableCell(
      resultCell.space,
      inputs,
      undefined,
      tx,
    );
    const previousResultCellRef: JavaScriptActionResultCells = {
      byScope: new Map(),
    };
    let previouslyInvalidArgument = false;
    const fnSource = fn.toString();

    const action: Action & {
      ignoredSchedulingWrites?: NormalizedFullLink[];
    } = (tx: IExtendedStorageTransaction) => {
      action.ignoredSchedulingWrites = [];
      const resultFor = { inputs, outputs, fn: fnSource };
      const policyFacingIdentity = resolvePolicyFacingImplementationIdentity(
        module,
        { implementation: fn },
      );
      const frame = this.createPatternFrame(
        resultFor,
        pattern,
        resultCell,
        tx,
        false,
        policyFacingIdentity,
      );
      (action as Action & { lastFrame?: Frame }).lastFrame = frame;
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      const handleErrorOutput = (error: unknown) => {
        // RetryImmediately is an internal control-flow signal: re-throw it
        // untouched so the scheduler re-runs the action instead of writing an
        // error result into the binding.
        if (error instanceof RetryImmediately) throw error;
        if (
          error !== null &&
          (typeof error === "object" || typeof error === "function")
        ) {
          (error as Error & { frame?: Frame }).frame = frame;
        }
        try {
          sendValueToBinding(
            tx,
            resultCell,
            getMetaLink(resultCell, "argument")!,
            outputs,
            undefined,
          );
        } catch (bindingError) {
          logger.error(
            "runner",
            "Failed to write undefined to binding on error",
            bindingError,
          );
        }
        throw error;
      };

      let popFrameAfterReturn = true;
      try {
        logger.timeStart("action", "readInputs");
        tx.resetNarrowestReadScope();
        const { argument, isValidArgument } = (() => {
          try {
            return this.readJavaScriptArgument(
              module,
              inputsCell,
              tx,
              { bindTxToSchema: true },
            );
          } finally {
            logger.timeEnd("action", "readInputs");
          }
        })();

        this.updateInvalidInputFlag(
          name,
          isValidArgument,
          module,
          inputsCell,
          tx,
        );

        if (!isValidArgument || previouslyInvalidArgument) {
          const inputState = this.getJavaScriptInputState(
            module,
            inputsCell,
            tx,
          );
          logger.info(
            "action",
            () => [
              isValidArgument
                ? "action argument is valid now -- running"
                : "action argument is undefined (potential schema mismatch) -- not running",
              {
                schema: inputState.schema,
                raw: inputState.raw,
                asQueryResult: inputState.queryResult,
              },
            ],
          );
          previouslyInvalidArgument = !isValidArgument;
        }

        let result: any = undefined;
        if (isValidArgument) {
          logger.timeStart("action", "invokeJavaScriptImplementation");
          try {
            result = this.invokeJavaScriptImplementation(
              module,
              fn,
              argument,
            );
            if (result instanceof Promise) {
              result = result.finally(() =>
                logger.timeEnd("action", "invokeJavaScriptImplementation")
              );
            } else {
              logger.timeEnd("action", "invokeJavaScriptImplementation");
            }
          } catch (error) {
            logger.timeEnd("action", "invokeJavaScriptImplementation");
            throw error;
          }
        }
        const postRun = (result: any) => {
          logger.timeStart("action", "postRun");
          try {
            if (frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0) {
              return this.resolvePendingSpaceNamesAndRetry(frame);
            }
            const normalized = normalizeSandboxResult(result, name);
            return this.writeJavaScriptActionResult(
              tx,
              module.resultSchema,
              normalized.value,
              normalized.hasReactive,
              frame,
              resultCell,
              outputs,
              addCancel,
              resultFor,
              previousResultCellRef,
              tx.getNarrowestReadScope(),
            );
          } finally {
            logger.timeEnd("action", "postRun");
          }
        };

        const postRunResult = result instanceof Promise
          ? result.then(postRun).catch(handleErrorOutput)
          : postRun(result);
        if (postRunResult instanceof Promise) {
          popFrameAfterReturn = false;
          return postRunResult.finally(() => popFrame(frame));
        }
        return postRunResult;
      } catch (error) {
        // The action body may throw while materializing a not-yet-resolved
        // inSpace("name") child. If so, resolve the pending names and retry
        // instead of surfacing the error.
        if (
          !(error instanceof RetryImmediately) &&
          frame.pendingSpaceNames && frame.pendingSpaceNames.size > 0
        ) {
          popFrameAfterReturn = false;
          return this.resolvePendingSpaceNamesAndRetry(frame)
            .finally(() => popFrame(frame));
        }
        handleErrorOutput(error);
      } finally {
        if (popFrameAfterReturn) popFrame(frame);
      }
    };

    // Identity stamping is UNCONDITIONAL — the single identity channel (the
    // scheduler reads only these stamps; there is no fallback derivation).
    // The debug NAME below depends on `name` (fn.src / fn.name — absent for
    // anonymous arrows when the eager source annotation is off), but identity
    // must not: gating the stamps on `name` silently re-opened the per-symbol
    // multi-instance collision (N instances of one lift sharing one id, so one
    // actionStats entry and one durable observation) whenever annotation was
    // off — the production default.
    //
    // Use the RESOLVED implementation `fn` (`resolveByImplRef(module) ?? …`),
    // not `module.implementation`: an `$implRef`-resolved module (reloaded from
    // a serialized graph) carries the ref, not the live function, so reading
    // provenance off `module.implementation` would drop the content-addressed
    // scheduler identity on reload.
    this.applyImplementationHash(action, fn);
    const instanceKey = schedulerActionInstanceKey({
      process: resultCell.getAsNormalizedFullLink(),
      reads,
      writes,
    });
    (action as { schedulerInstanceKey?: string }).schedulerInstanceKey =
      instanceKey;
    if (name) {
      setRunnableName(
        action,
        schedulerJavaScriptActionName(name, instanceKey),
        { setSrc: true },
      );
    }

    // Writable arguments alone do not make an output-producing action a
    // materializer: pure UI computations frequently read Writable cells. The
    // transformer marks callbacks that actually write through captured cells;
    // the opaque-result fallback covers older generated side-write modules
    // that do not carry that metadata.
    const materializerWriteEnvelopes = module.materializerWriteEnvelopes ??
      (module.materializerWriteInputPaths !== undefined
        ? this.collectWritableCellArgumentLinks(
          module.argumentSchema,
          inputs,
          resultCell,
          module.materializerWriteInputPaths,
        )
        : this.moduleHasOpaqueResult(module)
        ? this.collectWritableCellArgumentLinks(
          module.argumentSchema,
          inputs,
          resultCell,
        )
        : []);
    const hasMaterializerWriteEnvelopes = materializerWriteEnvelopes.length > 0;
    const redirectWriteTargets = (!hasMaterializerWriteEnvelopes ||
        module.completeSchedulerScopeSummary === true)
      ? this.collectStaticRedirectWriteTargetsWithCompleteness(tx, writes)
      : { targets: [], complete: true };
    const redirectReadTargets = module.completeSchedulerScopeSummary === true
      ? this.collectStaticReadTargetsWithCompleteness(tx, reads)
      : { targets: [], complete: true };
    const staticRedirectWriteTargets = hasMaterializerWriteEnvelopes
      ? []
      : redirectWriteTargets.targets;
    const schedulingWrites = dedupeNormalizedLinks([
      ...writes,
      ...staticRedirectWriteTargets,
    ]);
    const structuralMetaLinks = module.completeSchedulerScopeSummary === true
      ? (["pattern", "argument", "result"] as const)
        .map((field) => getMetaLink(resultCell, field))
        .filter((link): link is NormalizedFullLink => link !== undefined)
      : [];
    const internalMetaLink = module.completeSchedulerScopeSummary === true
      ? getMetaCell(resultCell, "internal", tx)
        .getAsNormalizedFullLink()
      : undefined;
    const derivedInternalLinks = module.completeSchedulerScopeSummary === true
      ? (pattern.derivedInternalCells ?? []).map((descriptor) =>
        getDerivedInternalCellLink(resultCell, descriptor)
      )
      : [];
    const wrappedAction = Object.assign(action, {
      reads,
      writes: schedulingWrites,
      ...(hasMaterializerWriteEnvelopes ? { materializerWriteEnvelopes } : {}),
      ...(module.completeSchedulerScopeSummary === true &&
          redirectWriteTargets.complete && redirectReadTargets.complete
        ? {
          completeSchedulerScopeSummary: {
            complete: true as const,
            piece: resultCell.getAsNormalizedFullLink(),
            // The callback's declared reads are only part of the action's
            // structurally fixed read surface. Reads follow static redirects;
            // the runner also materializes the immutable argument container
            // and reads direct output cells while diffing/writing their values.
            // Include those framework reads in the trusted certificate so a
            // complete space-only lift is not mistaken for a contradiction.
            reads: dedupeNormalizedLinks([
              ...reads,
              ...redirectReadTargets.targets,
              inputsCell.getAsNormalizedFullLink(),
              resultCell.getAsNormalizedFullLink(),
              ...structuralMetaLinks,
              ...(internalMetaLink ? [internalMetaLink] : []),
              ...derivedInternalLinks,
              ...schedulingWrites,
            ]),
            writes: dedupeNormalizedLinks([
              ...schedulingWrites,
              ...redirectWriteTargets.targets,
            ]),
            materializerWriteEnvelopes,
            directOutputs: writes,
          },
        }
        : {}),
      module,
      pattern,
    });

    addCancel(
      this.runtime.scheduler.subscribe(wrappedAction, {
        ...schedulerRehydration,
      }),
    );
  }

  private instantiateJavaScriptNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    // Binding resolution is op-wiring machinery: the write-redirect walk
    // reads alias shells and plumbing containers' child paths, and those
    // reads must not consume `*`-path membership templates (machineryRead;
    // template-population §6 — the SC-8 machinery-read boundary).
    const io = tx.runWithAmbientReadMeta(
      machineryRead,
      () =>
        this.bindNodeIO(
          inputBindings,
          outputBindings,
          resultCell,
          pattern,
        ),
    );
    const { fn, name } = this.resolveJavaScriptFunction(module);
    const context: JavaScriptNodeContext = {
      tx,
      module,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      schedulerRehydration,
      ...io,
    };

    const { streamLink, eventTarget } = this.resolveJavaScriptStreamLink(
      io.inputs,
      resultCell.getAsNormalizedFullLink(),
      tx,
    );
    if (streamLink) {
      this.instantiateJavaScriptHandlerNode({ ...context, streamLink });
      return;
    }
    if (eventTarget) {
      // The node was authored as a handler ($event input), but its stream
      // marker did not resolve. Report what actually happened instead of
      // misclassifying the node as a lift.
      throw new Error(
        describeHandlerStreamFailure(name, eventTarget, resultCell),
      );
    }

    this.instantiateJavaScriptActionNode(context);
  }

  private getFallbackJavaScriptImplementation(
    module: Module,
  ): (...args: any[]) => any {
    const implRef =
      (module as { $implRef?: { identity: string; symbol: string } }).$implRef;
    if (implRef) {
      // The module carries a content-addressed `$implRef` — it was expected to
      // resolve through the verified registry — yet resolution fell through to
      // here. The action will run
      // SES-recompiled and CFC-unverified (`writeAuthorizedBy` sees
      // `unsupported`), so leave a breadcrumb for enforcement-mode debugging.
      logger.debug("verified-fallback-downgrade", () => [
        "Verified function resolution missed; running SES-recompiled," +
        " CFC-unverified fallback",
        { $implRef: implRef },
      ]);
    }
    if (typeof module.implementation === "function") {
      return this.runtime.harness.getInvocation(
        Function.prototype.toString.call(module.implementation),
      ) as (...args: any[]) => any;
    }
    if (typeof module.implementation === "string") {
      return this.runtime.harness.getInvocation(module.implementation) as (
        ...args: any[]
      ) => any;
    }
    throw new Error(
      "JavaScript module is missing an executable implementation",
    );
  }

  private invokeJavaScriptImplementation(
    module: Module,
    fn: (...args: any[]) => any,
    argument: unknown,
  ): unknown {
    const invoke = () => {
      if (module.wrapper === "handler") {
        const event = isRecord(argument) && "$event" in argument
          ? argument.$event
          : undefined;
        const context = isRecord(argument) && "$ctx" in argument
          ? argument.$ctx
          : undefined;
        return fn(event, context);
      }

      return fn(argument);
    };

    // Builder artifacts cannot be minted inside a running action (identity
    // E5): they would have no content-addressed identity, no provenance, and
    // — closure-bearing — no serializable body, so nothing could ever
    // rehydrate them. The transformer hoists every authored builder call to
    // module scope; the window makes a mint that slipped through fail loudly
    // at creation time (see builder/action-context.ts) instead of producing
    // an unrehydratable value. The window rides AsyncLocalStorage, so an
    // async action's continuations stay covered past its awaits.
    return runInActionExecution(invoke);
  }

  /**
   * CT-1623: for the list builtins (`map`/`filter`/`flatMap`), annotate the `op`
   * input with its content-addressed `{ identity, symbol }` entry ref (when
   * known) so the builtin can resolve the live canonical pattern by identity
   * instead of deserializing the embedded graph. Mutates `inputBindings` in
   * place: `op` becomes `{ $patternRef }`.
   *
   * Only the `op` key is rewritten — it is the sole pattern-valued input the
   * builtins rehydrate (`resolveOpPattern`). Rewriting other inputs (e.g. a
   * pattern captured in `params`) would leave an unresolved `$patternRef` object
   * that nothing reads back.
   *
   * The sentinel carries NO embedded fallback graph (identity E4): the artifact
   * index is session-lifetime, and the op's module evaluated in this session by
   * construction (the sentinel is stamped from its live artifact right here),
   * so the builtin's sync resolution cannot miss short of a bug — and a bug
   * should be loud, not silently served a stale graph. `inputBindings` here is
   * the freshly bound (mutable, unfrozen) copy produced by
   * `unwrapOneLevelAndBindtoDoc`; its pattern values carry their derivation
   * link (`noteDerivedCopy`), so `getArtifactEntryRef` can resolve the ref
   * (assigned post-eval by `registerEvaluatedModules`).
   *
   * An op with NO known ref but a LIVE trusted original is a KEYLESS pattern
   * — hand-built through the in-process builder DSL, or evaluated through the
   * bare non-registering `Engine.compileAndEvaluateModules` — whose serialized
   * copy carries a derivation link to its pristine in-memory pattern. It is
   * minted its content-hash session identity right here (the same pointer
   * `entryRefForPattern` mints for a keyless ROOT pattern), so it rides a
   * `$patternRef` to that pristine artifact. Leaving it embedded instead
   * would send it through the immutable-cell JSON round-trip, which corrupts
   * a nested sub-pattern's output-alias `defer` levels (CT-1812 — the
   * CT-1811 corruption, reachable ref-lessly). The trust gate stays intact:
   * minting BRANDS, so only a value whose original is already a trusted
   * builder pattern is minted.
   *
   * An op with no ref AND no live original — a plain deserialized graph,
   * i.e. a STORED no-entry-ref pattern value (the live keyless writer path
   * pinned by stored-pattern-rehydration.test.ts) — is left embedded: there
   * is no pristine artifact in existence to point at, and re-rooting the
   * graph bind-free is exactly the defer surgery CT-1812 records as the
   * residual there. Such an op takes the builtin's legacy graph path.
   */
  private substituteOpPatternRefs(
    moduleRefName: string | undefined,
    inputBindings: FabricValue,
  ): void {
    if (
      moduleRefName !== "map" && moduleRefName !== "filter" &&
      moduleRefName !== "flatMap"
    ) {
      return;
    }
    if (!isRecord(inputBindings)) return;
    const op = (inputBindings as Record<string, unknown>).op;
    if (!isRecord(op)) return;
    let ref = this.runtime.patternManager.getArtifactEntryRef(
      op as unknown as object,
    );
    if (!ref) {
      const original = resolveOriginal(op as unknown as object);
      if (isTrustedBuilderArtifact(original) && isPattern(original)) {
        ref = this.runtime.patternManager.ensureKeylessPatternIdentity(
          original as unknown as Pattern,
        );
      }
    }
    if (ref) {
      (inputBindings as Record<string, unknown>).op = {
        $patternRef: { identity: ref.identity, symbol: ref.symbol },
      };
    }
  }

  private instantiateRawNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
    moduleRefName?: string,
  ) {
    if (typeof module.implementation !== "function") {
      throw new Error(
        `Raw module is not a function, got: ${module.implementation}`,
      );
    }

    const builtinIdentity = resolveBuiltinImplementationIdentity(module);
    if (builtinIdentity) {
      tx.setCfcImplementationIdentity(builtinIdentity);
    }
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const mappedInputBindings = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );

    // CT-1623: for the list builtins, replace a pattern-valued input (the `op`)
    // with a compact `{ $patternRef }` sentinel when its content-addressed entry
    // ref is known. This is the post-eval moment where the in-memory op object
    // (linked to its original via `noteDerivedCopy`, preserved through binding)
    // carries its `{ identity, symbol }`; the sentinel then survives the immutable-cell
    // JSON round-trip, so the builtin resolves the live canonical pattern by
    // identity instead of deserializing the embedded graph.
    this.substituteOpPatternRefs(moduleRefName, mappedInputBindings);

    // Opaque forwarded references (argument keys the module's schema marks
    // `asCell: ["opaque"]`, e.g. ifElse's `ifTrue`/`ifFalse` branches) are
    // never value-read by the builtin, so they must not become declared reads
    // that pull their (possibly unselected) writer. Drop those top-level keys
    // when building inputCells only; outputCells and other callers keep the
    // full surface.
    const opaqueInputKeys = opaqueArgumentKeys(module.argumentSchema);
    const inputCells = findAllWriteRedirectCells(
      mappedInputBindings,
      resultCell,
      opaqueInputKeys.size > 0
        ? { skipTopLevelKeys: opaqueInputKeys }
        : undefined,
    );
    // outputCells tracks the static write surface for dependency ordering and
    // event preflight.
    const outputCells = findAllWriteRedirectCells(
      mappedOutputBindings,
      resultCell,
    );

    const inputsCell = this.runtime.getImmutableCell(
      resultCell.space,
      mappedInputBindings,
      undefined,
      tx,
    );

    // CT-1623: the output spot this node writes through is reserved for this
    // node, so its fully-resolved coordinates are a stable, position-derived,
    // program-independent identity. Builtins that mint a result container
    // (map/flatmap/filter) key it on this instead of the serialized op /
    // inputs cell (both of which drag in the session-varying `program`).
    const resolvedOutputSpot = firstResolvedOutputRedirect(
      this.runtime,
      tx,
      mappedOutputBindings,
      resultCell,
    );

    // The output spot's *declared* scope is not inherently on the resolved link
    // (`.asScope("user")` lands on `module.defaultScope`, and a `PerUser<>`
    // annotation on `module.resultSchema.scope`), so fold both in here and hand
    // the builtin a fully-normalized output link carrying that scope + schema.
    // Scope-aware builtins (sqliteDatabase) mint their result container at this
    // scope; the rest ignore the extra argument.
    const outputBinding = resolvedOutputSpot
      ? {
        ...resolvedOutputSpot,
        scope: schemaCellScope(module.resultSchema) ??
          module.defaultScope ?? resolvedOutputSpot.scope,
      }
      : undefined;

    const builtinFrame = builtinIdentity
      ? pushFrameFromCause(undefined, {
        runtime: this.runtime,
        tx,
        space: resultCell.space,
        implementationIdentity: builtinIdentity,
      })
      : undefined;
    let builtinResult: RawBuiltinReturnType;
    try {
      builtinResult = module.implementation(
        inputsCell,
        (tx: IExtendedStorageTransaction, result: any) => {
          const outputBindingSchema = schemaForRawBuiltinRootOutputBinding(
            tx,
            this.runtime,
            resultCell,
            mappedOutputBindings,
          );
          recordRawBuiltinBindingSchemaPolicyInputs(
            tx,
            this.runtime,
            resultCell,
            mappedOutputBindings,
          );
          recordRawBuiltinResultSchemaPolicyInput(
            tx,
            result,
          );
          sendValueToBinding(
            tx,
            resultCell,
            argumentCellLink!,
            mappedOutputBindings,
            resultForRawBuiltinOutputBinding(
              result,
              outputBindingSchema,
              builtinIdentity,
            ),
            { preserveLinkOutput: true },
          );
        },
        addCancel,
        {
          inputs: inputsCell,
          parents: resultCell.entityId,
          ...(resolvedOutputSpot
            ? {
              outputSpot: {
                space: resolvedOutputSpot.space,
                id: resolvedOutputSpot.id,
                path: [...resolvedOutputSpot.path],
              },
            }
            : {}),
        },
        resultCell,
        this.runtime,
        outputBinding,
        // The resumed-from-synced-state flag is passed out-of-band (a behavioral
        // param, like `outputBinding`) instead of folded into the identity
        // `cause` above. It is transient (present only on resume), so hashing it
        // into the result-cell id would diverge a fresh runtime from a resumed
        // one for the same logical node — the root of the cross-runtime write
        // storm. Container-minting builtins (map/filter/flatMap) read it to
        // defer their per-element sub-pattern runs until sync completes too.
        defersInitialRunUntilSynced(schedulerRehydration),
      );
    } finally {
      popFrame(builtinFrame);
    }

    // Handle both legacy (just Action) and new (RawBuiltinResult) return formats
    const builtinAction = isRawBuiltinResult(builtinResult)
      ? builtinResult.action
      : builtinResult;
    const builtinIsEffect = isRawBuiltinResult(builtinResult)
      ? builtinResult.isEffect
      : undefined;
    const builtinDebounce = isRawBuiltinResult(builtinResult)
      ? builtinResult.debounce
      : undefined;
    const builtinNoDebounce = isRawBuiltinResult(builtinResult)
      ? builtinResult.noDebounce
      : undefined;
    const builtinThrottle = isRawBuiltinResult(builtinResult)
      ? builtinResult.throttle
      : undefined;
    const builtinDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.dependencies
      : undefined;
    const useDeclaredReadsAsDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.useDeclaredReadsAsDependencies
      : false;
    const builtinResumeMode = isRawBuiltinResult(builtinResult)
      ? builtinResult.resumeMode
      : undefined;

    // Name the raw action for debugging - use implementation name or fallback to "raw"
    const impl = module.implementation as ((...args: unknown[]) => Action) & {
      src?: string;
      name?: string;
    };
    const rawTargetName = sanitizeDebugLabel(
      moduleRefName,
    ) ??
      sanitizeDebugLabel(
        (module as { debugName?: string }).debugName,
      ) ??
      sanitizeDebugLabel(impl.src) ??
      sanitizeDebugLabel(impl.name) ??
      "anonymous";
    const rawInstanceKey = schedulerActionInstanceKey({
      reads: inputCells,
      writes: outputCells,
    });
    const rawName = schedulerRawActionName(rawTargetName, rawInstanceKey);

    const action: Action = (tx: IExtendedStorageTransaction) => {
      logger.timeStart("raw", "run", rawTargetName);
      try {
        const result = builtinAction(tx);
        if (result instanceof Promise) {
          return result.finally(() =>
            logger.timeEnd("raw", "run", rawTargetName)
          );
        }
        logger.timeEnd("raw", "run", rawTargetName);
        return result;
      } catch (error) {
        logger.timeEnd("raw", "run", rawTargetName);
        throw error;
      }
    };
    setRunnableName(action, rawName, { setSrc: true });
    this.applyImplementationHash(action, impl);
    (action as { schedulerInstanceKey?: string }).schedulerInstanceKey =
      rawInstanceKey;

    // Annotate raw actions with their pattern/module/write metadata so
    // scheduler registration can derive static surfaces and ordering hints.
    const staticRedirectWriteTargets = module.materializerWriteEnvelopes
      ? []
      : this.collectStaticRedirectWriteTargets(tx, outputCells);
    const schedulingWrites = dedupeNormalizedLinks([
      ...outputCells,
      ...staticRedirectWriteTargets,
    ]);
    Object.assign(action, builtinAction, {
      reads: inputCells,
      writes: schedulingWrites,
      ...(module.materializerWriteEnvelopes
        ? { materializerWriteEnvelopes: module.materializerWriteEnvelopes }
        : {}),
      module,
      pattern,
    });

    // isEffect can come from module options or from the builtin result
    const isEffect = module.isEffect ?? builtinIsEffect;
    const debounce = module.debounce ?? builtinDebounce;
    const noDebounce = module.noDebounce ?? builtinNoDebounce;
    const throttle = module.throttle ?? builtinThrottle;

    const schedulerDependencies = builtinDependencies ??
      (useDeclaredReadsAsDependencies
        ? {
          reads: inputCells.map(toMemorySpaceAddress),
          shallowReads: [],
          writes: [],
        }
        : undefined);
    const schedulerOptions = {
      isEffect,
      debounce,
      noDebounce,
      throttle,
      ...(builtinResumeMode !== undefined
        ? { resumeMode: builtinResumeMode }
        : {}),
      ...schedulerRehydration,
    };

    addCancel(
      schedulerDependencies
        ? this.runtime.scheduler.subscribe(
          action,
          schedulerDependencies,
          schedulerOptions,
        )
        : this.runtime.scheduler.subscribe(action, schedulerOptions),
    );
  }

  private instantiatePassthroughNode(
    tx: IExtendedStorageTransaction,
    _module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    _addCancel: AddCancel,
    pattern: Pattern,
  ) {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    const outputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );

    sendValueToBinding(
      tx,
      resultCell,
      argumentCellLink,
      outputs,
      inputs,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
  }

  private instantiatePatternNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions = {},
  ) {
    const parentResultCell = resultCell;
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    if (!isPattern(module.implementation)) throw new Error(`Invalid pattern`);
    const patternImpl = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      module.implementation,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      resultCell,
      {
        targetSchema: patternImpl.argumentSchema,
        derivedInternalCells: pattern.derivedInternalCells,
        // The links serialized into the sub-piece's argument doc must keep the
        // containing pattern's declared slot scopes; the authored schema is
        // the only place those declarations still exist (the meta link
        // carries a sanitized schema). See foldDeclaredScopeIntoLinkSchema.
        sourceSchemas: { argument: pattern.argumentSchema },
      },
    );
    const outputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      resultCell,
      { derivedInternalCells: pattern.derivedInternalCells },
    );

    // If output bindings is a link to a non-redirect cell,
    // use that instead of creating a new cell.
    let sendToBindings: boolean;
    let childResultCell: Cell<any>;
    if (isSigilLink(outputs) && !isWriteRedirectLink(outputs)) {
      childResultCell = this.runtime.getCellFromLink(
        parseLink(outputs, resultCell),
        patternImpl.resultSchema,
        tx,
      );
      sendToBindings = false;
    } else {
      const resultScope = patternDefaultScope(patternImpl) ??
        module.defaultScope;
      const targetSpace = module.targetSpace ?? resultCell.space;
      // CT-1623: identify the result cell by the (fully resolved) output spot
      // reserved for this node — a stable, position-derived, program-independent
      // identity — rather than hashing the pattern object (which drags in the
      // session-varying `program` and forces `materializeRuntimeProgram`). We
      // still mint a NEW cell and point the binding at it (`sendToBindings`
      // below); we only borrow the resolved output link's coordinates as the
      // cause. A pattern node always writes through a write redirect, so the
      // absence of one is a bug (the legacy non-redirect variants are removed).
      //
      // Bind the output bindings first (as `instantiateRawNode` does), so the
      // `argument`/`internal`/`result` pseudo-cell aliases resolve to their
      // DISTINCT concrete cells. Resolving the raw bindings would let pseudo
      // cells at the same path (e.g. `internal.x` vs `result.x`) collapse onto
      // the base result cell and collide on one shared child cell.
      // `bindPatterns: false` — output bindings never carry sub-patterns to
      // instantiate, so skip that work; we only need the pseudo-cell aliases
      // resolved to their concrete links.
      const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
        this.runtime.cfc,
        outputBindings,
        argumentCellLink,
        resultCell,
      );
      const outputRedirect = firstResolvedOutputRedirect(
        this.runtime,
        tx,
        mappedOutputBindings,
        resultCell,
      );
      if (!outputRedirect) {
        throw new Error(
          "instantiatePatternNode: result cell requires a write-redirect " +
            "output binding to anchor a reload-stable identity",
        );
      }
      const baseResultCell = this.runtime.getCell(
        targetSpace,
        {
          resultFor: {
            space: outputRedirect.space,
            id: outputRedirect.id,
            path: [...outputRedirect.path],
          },
        },
        patternImpl.resultSchema,
        tx,
      );

      childResultCell = baseResultCell;
      if (resultScope !== undefined && resultScope !== "space") {
        let resultCellLink = baseResultCell.getAsNormalizedFullLink();
        resultCellLink = { ...resultCellLink, scope: resultScope };
        // The result cell's scope isn't "space", so we may have just created
        // this cell. If so, create the corresponding argument/internal cells.
        childResultCell = createCell(this.runtime, resultCellLink, tx);
      }
      sendToBindings = true;
    }

    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`instantiate-pattern-node/${sourceKey}`, () => [
      `[PATTERN-NODE] source=${sourceKey}`,
      `result=${childResultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternImpl)}`,
      `sendToBindings=${sendToBindings}`,
    ]);

    if (childResultCell.space !== parentResultCell.space) {
      // Cross-space child pattern: run it inline in a multi-space transaction
      // (child space committed first) rather than re-instantiating it in a
      // deferred second transaction, which would lose its verified-function
      // identity. The journal allows the cross-space write once opted in.
      this.enableCrossSpaceChildCommit(
        tx,
        childResultCell.space,
        parentResultCell.space,
      );
      // CT-1687: a fresh runtime navigating to the child piece loads its
      // pattern artifacts from `resultCell.space` (the child's own space),
      // where neither the meta nor the compiled closure exist yet. Replicate
      // them there (fire-and-forget) so the child is independently loadable.
      this.runtime.patternManager.replicatePatternToSpace(
        patternImpl,
        childResultCell.space,
        parentResultCell.space,
      );
    }
    this.run(tx, patternImpl, inputs, childResultCell, {
      awaitSyncBeforeInitialRun: defersInitialRunUntilSynced(
        schedulerRehydration,
      ),
    });

    if (sendToBindings) {
      sendValueToBinding(
        tx,
        parentResultCell,
        argumentCellLink,
        outputs,
        childResultCell.getAsLink(),
        { derivedInternalCells: pattern.derivedInternalCells },
      );
    }

    // TODO(seefeld): Make sure to not cancel after a pattern is elevated to a
    // piece, e.g. via navigateTo. Nothing is cancelling right now, so leaving
    // this as TODO.
    addCancel(() => this.stop(childResultCell));
  }
}

function getTxDebugActionId(
  tx?: IExtendedStorageTransaction,
): string | undefined {
  return tx ? (tx.tx as { debugActionId?: string }).debugActionId : undefined;
}

/**
 * Explain why a node authored as a handler ($event input) could not be
 * instantiated as one. The historical error here ("$stream: true was
 * overwritten") was misleading: the by-far most common cause is that the
 * marker read returned undefined because nothing was ever written at the
 * derived location — e.g. piece state persisted before the internal-cell
 * manifest format (#3911) keeps its markers elsewhere — not that anything
 * overwrote it.
 */
function describeHandlerStreamFailure(
  name: string | undefined,
  eventTarget: { link?: NormalizedFullLink; value: FabricValue },
  resultCell: Cell<any>,
): string {
  const prefix = `Handler used as lift: ${
    name ? `node "${name}"` : "node"
  }'s $event input`;

  if (eventTarget.link === undefined) {
    return `${prefix} is not a stream reference (got: ${
      toCompactDebugString(eventTarget.value, 80)
    })`;
  }

  const where = `${eventTarget.link.id}${
    eventTarget.link.path.length > 0
      ? ` at path [${eventTarget.link.path.join(", ")}]`
      : ""
  }`;

  if (eventTarget.value === undefined) {
    let hint = "";
    try {
      const internalMeta = resultCell.getMetaRaw("internal", {
        meta: ignoreReadForScheduling,
      });
      if (internalMeta !== undefined && !Array.isArray(internalMeta)) {
        hint = " This piece's internal metadata is a single-cell link " +
          "(pre-manifest format), so its persisted state predates the " +
          "current runtime's internal-cell layout; recreate the piece to " +
          "repair it.";
      }
    } catch {
      // Diagnostic only — never mask the primary error.
    }
    return `${prefix} resolves to ${where}, which reads undefined — the ` +
      `{ "$stream": true } marker was never written there.${hint}`;
  }

  return `${prefix} resolves to ${where}, whose value is not a stream ` +
    `marker — { "$stream": true } was overwritten (found: ${
      toCompactDebugString(eventTarget.value, 80)
    })`;
}

/**
 * Read the content-addressed `{ identity, symbol }` pattern reference — the ONLY
 * pattern pointer — from a result cell's `patternIdentity` meta. Returns
 * undefined for a cell that carries no such pointer (a keyless hand-built
 * pattern run in-session, or a legacy result cell predating the migration; the
 * latter is unrecoverable by the sanctioned data-wipe decision).
 */
export function getPatternIdentityRef(
  resultCell: Cell<unknown>,
): { identity: string; symbol: string } | undefined {
  const raw = resultCell.getMetaRaw("patternIdentity", {
    meta: ignoreReadForScheduling,
  });
  return asPatternIdentityRef(raw);
}

/**
 * Read a piece's `patternSource` provenance — the source it tracks for updates
 * (a toolshed pattern path today; a `cf:` fabric ref in a later phase).
 * Undefined for pieces created before provenance stamping, or hand-built ones.
 */
export function getPatternSource(
  resultCell: Cell<unknown>,
): string | undefined {
  const raw = resultCell.getMetaRaw("patternSource", {
    meta: ignoreReadForScheduling,
  });
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Stamp a piece's `patternSource` provenance. Meta writes are transactional, so
 * a transaction is required (mirrors the `patternIdentity` write).
 */
export function setPatternSource(
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  url: string,
): void {
  resultCell.withTx(tx).setMetaRaw("patternSource", url);
}

/** Read an explicitly supplied repository locator for a piece's source. */
export function getPatternRepository(
  resultCell: Cell<unknown>,
): string | undefined {
  const raw = resultCell.getMetaRaw("patternRepository", {
    meta: ignoreReadForScheduling,
  });
  return typeof raw === "string" ? raw : undefined;
}

/** Stamp an explicitly supplied repository locator with pattern setup. */
export function setPatternRepository(
  resultCell: Cell<unknown>,
  tx: IExtendedStorageTransaction,
  repository: string,
): void {
  resultCell.withTx(tx).setMetaRaw("patternRepository", repository);
}

/** Narrow a raw meta value to a `{ identity, symbol }` pattern ref, or undefined. */
export function asPatternIdentityRef(
  raw: unknown,
): { identity: string; symbol: string } | undefined {
  if (
    isRecord(raw) && typeof raw.identity === "string" &&
    typeof raw.symbol === "string"
  ) {
    return { identity: raw.identity, symbol: raw.symbol };
  }
  return undefined;
}

/**
 * A stable string key for a `{ identity, symbol }` pattern ref, for "same
 * pattern between runs" comparisons (name preservation, reuse-running-setup).
 */
export function patternIdentityKey(
  ref: { identity: string; symbol: string },
): string {
  return `${ref.identity}\0${ref.symbol}`;
}
