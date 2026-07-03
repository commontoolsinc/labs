import {
  fabricFromNativeValue,
  type FabricValue,
  nativeFromFabricValue,
} from "@commonfabric/data-model/fabric-value";
import { getPersistentSchedulerStateConfig } from "@commonfabric/memory/v2";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  toCompactDebugString,
  toIndentedDebugString,
} from "@commonfabric/data-model/value-debug";
import { getLogger } from "@commonfabric/utils/logger";
import { isRecord } from "@commonfabric/utils/types";
import { rendererVDOMSchema } from "./schemas.ts";
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
import { RetryImmediately } from "./scheduler/retry-immediately.ts";
import {
  findAllWriteRedirectCells,
  unwrapOneLevelAndBindtoDoc,
} from "./pattern-binding.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  areNormalizedLinksSame,
  createSigilLinkFromParsedLink,
  getDerivedInternalCell,
  getMetaCell,
  getMetaLink,
  isCellLink,
  isSigilLink,
  isWriteRedirectLink,
  type NormalizedFullLink,
  parseLink,
} from "./link-utils.ts";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { sendValueToBinding } from "./pattern-binding.ts";
import { type AddCancel, type Cancel, useCancelGroup } from "./cancel.ts";
import type { Runtime } from "./runtime.ts";
import type {
  IExtendedStorageTransaction,
  IStorageSubscription,
  MemorySpace,
  URI,
} from "./storage/interface.ts";
import { TransactionWrapper } from "./storage/extended-storage-transaction.ts";
import {
  ignoreReadForScheduling,
  markReadAsAttemptedWrite,
} from "./scheduler.ts";
import { schedulerDependencyRead } from "./storage/reactivity-log.ts";
import { isRawBuiltinResult, type RawBuiltinReturnType } from "./module.ts";
import "./builtins/index.ts";
import { isCellScope, narrowestScope } from "./scope.ts";
import {
  describePatternOrModule,
  extractDefaultValues,
  mergeObjects,
  sanitizeDebugLabel,
  setRunnableName,
  validateAndCheckReactives,
} from "./runner-utils.ts";
import {
  resolveBuiltinImplementationIdentity,
  resolvePolicyFacingImplementationIdentity,
} from "./cfc/implementation-identity.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type ImplementationIdentity,
} from "./cfc/types.ts";
import { runInActionExecution } from "./builder/action-context.ts";
import { getVerifiedProvenance } from "./harness/verified-provenance.ts";
import { getArtifactEntryRef } from "./builder/pattern-metadata.ts";
import { planInterpreterDispatch } from "./reactive-interpreter/dispatch.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { setResultCell } from "./result-utils.ts";
import { SigilLink } from "./sigil-types.ts";
export {
  extractDefaultValues,
  mergeObjects,
  validateAndCheckReactives,
} from "./runner-utils.ts";

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
  link: SigilLink;
};

function schedulerRawActionName(
  rawTargetName: string,
  inputCells: readonly NormalizedFullLink[],
  outputCells: readonly NormalizedFullLink[],
): string {
  const identity = hashOf({
    type: "raw-node",
    name: rawTargetName,
    inputs: inputCells.map(schedulerActionLinkIdentity),
    outputs: outputCells.map(schedulerActionLinkIdentity),
  }).hashString.slice(0, 12);
  return `raw:${rawTargetName}:${identity}`;
}

function schedulerJavaScriptActionName(
  actionName: string,
  processCell: Cell<unknown>,
  reads: readonly NormalizedFullLink[],
  writes: readonly NormalizedFullLink[],
): string {
  const identity = hashOf({
    type: "javascript-node",
    name: actionName,
    process: schedulerActionLinkIdentity(
      processCell.getAsNormalizedFullLink(),
    ),
    reads: reads.map(schedulerActionLinkIdentity),
    writes: writes.map(schedulerActionLinkIdentity),
  }).hashString.slice(0, 12);
  return `action:${actionName}:${identity}`;
}

function schedulerActionLinkIdentity(link: NormalizedFullLink) {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    path: link.path,
  };
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

  if (isWriteRedirectLink(outputBinding)) {
    const bindingLink = parseLink(outputBinding, resultCell);
    const link = resolveLink(
      runtime,
      tx,
      bindingLink,
      "writeRedirect",
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
  processCell: Cell<any>,
  outputBinding: unknown,
): void => {
  if (isWriteRedirectLink(outputBinding)) {
    const bindingLink = parseLink(outputBinding, processCell);
    const link = resolveLink(
      runtime,
      tx,
      bindingLink,
      "writeRedirect",
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
        processCell,
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
        processCell,
        child,
      );
    }
  }
};

const schemaForRawBuiltinRootOutputBinding = (
  tx: IExtendedStorageTransaction,
  runtime: Runtime,
  processCell: Cell<any>,
  outputBinding: unknown,
): JSONSchema | undefined => {
  if (!isWriteRedirectLink(outputBinding)) {
    return undefined;
  }
  const bindingLink = parseLink(outputBinding, processCell);
  const link = resolveLink(
    runtime,
    tx,
    bindingLink,
    "writeRedirect",
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
  if (isWriteRedirectLink(binding)) {
    return resolveLink(
      runtime,
      tx,
      parseLink(binding, baseCell),
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

  if (isWriteRedirectLink(projection)) {
    const target = resultCell.getAsNormalizedFullLink();
    const source = parseLink(projection, resultCell);
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
  processCell: Cell<any>;
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
    awaitSync?: boolean;
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
  private locallyPreparedResults = new Set<
    `${MemorySpace}/${CellScope}/${URI}`
  >();
  private locallyStoppedResults = new Set<
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
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>>;
  setup<T, R = any>(
    providedTx: IExtendedStorageTransaction | undefined,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): Promise<Cell<R>> {
    if (providedTx) {
      this.setupInternal(providedTx, patternOrModule, argument, resultCell);
      return Promise.resolve(resultCell);
    } else {
      // Ignore retry/commit errors after retrying for now, as outside the tx,
      // we'll see the latest true value; it just lost the race against someone
      // else changing the pattern or argument. Correct action is anyhow similar
      // to what would have happened if the write succeeded and was immediately
      // overwritten. Still surface real callback failures from setupInternal so
      // callers don't silently continue after a broken setup.
      return this.runtime.editWithRetry((tx) => {
        this.setupInternal(tx, patternOrModule, argument, resultCell);
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
    if (real) return real;
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
      this.updateArgument(
        tx,
        argumentLink,
        argument,
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
        deepEqual(existingDescriptor.partialCause, descriptor.partialCause)
      );
      if (manifestMatch === -1) {
        // this cell isn't in our manifest yet. Create it, and add it to the manifest
        const derivedSigilLink = derivedCell.getAsWriteRedirectLink({
          base: resultCell,
          includeSchema: true,
        });
        manifest.push({
          partialCause: descriptor.partialCause,
          link: derivedSigilLink,
        });
        setResultCell(derivedCell, resultCell.asSchema(pattern.resultSchema));

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
      } else {
        manifest.push(existingManifest[manifestMatch]);
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

    let nextArgument = argument;
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
      nextArgument = mergeObjects<T>(argument, defaults);
      //newArgumentCell.set(nextArgument);

      newArgumentCell = newArgumentCell.asSchema(pattern.argumentSchema);
      const newArgumentSigilLink = newArgumentCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      });
      resultCell.withTx(tx).setMetaRaw("argument", newArgumentSigilLink);

      argumentLink = newArgumentCell.getAsNormalizedFullLink();
      if (argumentLink === undefined) {
        throw new Error("Invalid argument link in updateArgument");
      }
    }
    if (nextArgument !== undefined) {
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

    const key = this.getDocKey(resultCell);
    this.locallyPreparedResults.add(key);
    tx.addCommitCallback((_tx, result) => {
      if (result.error) {
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
  start<T = any>(resultCell: Cell<T>): Promise<boolean> {
    return this.doStart(resultCell);
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
   * @param options.allowAsyncLoad - Whether to allow async pattern loading
   * @returns Promise for async mode, void for sync mode
   */
  private startCore<T = any>(
    resultCell: Cell<T>,
    options: {
      tx?: IExtendedStorageTransaction;
      givenPattern?: Pattern;
      doNotUpdateOnPatternChange?: boolean;
      rehydrateSchedulerFromStorage?: boolean;
      // Resumed-from-synced-state: hold each action's initial rehydration/run
      // until the space has finished syncing, so consumers don't race the data.
      awaitSyncBeforeInitialRun?: boolean;
    } = {},
  ): void {
    const { tx, givenPattern, doNotUpdateOnPatternChange } = options;
    const key = this.getDocKey(resultCell);
    this.locallyStoppedResults.delete(key);

    // Create cancel group early, before wiring pattern/node sinks.
    const [cancel, addCancel] = useCancelGroup();
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

    // Helper to instantiate nodes for a pattern
    const instantiatePattern = (
      pattern: Pattern,
      useTx?: IExtendedStorageTransaction,
    ) => {
      // Create new cancel group for nodes
      const [nodeCancel, addNodeCancel] = useCancelGroup();
      cancelNodes = nodeCancel;
      addCancel(nodeCancel);

      // Instantiate nodes
      const actualTx = useTx ?? this.runtime.edit();
      const shouldCommit = !useTx;
      const schedulerRehydration = options.rehydrateSchedulerFromStorage ===
          false
        ? {}
        : this.schedulerRehydrationOptions(
          resultCell,
          options.awaitSyncBeforeInitialRun,
        );
      try {
        // Reactive Interpreter v2 (flag-gated, fail-closed): when the pattern
        // carries a complete builder-born ROG and the partition admits it,
        // instantiate the interpreter's synthetic node plan instead of the
        // per-node legacy loop. Any fallback reason → legacy, side-effect-free
        // (planning is pure; nothing is written before the decision).
        const interpreterPlan =
          this.runtime.experimental.experimentalInterpreter
            ? planInterpreterDispatch(pattern, {
              // The exact liveTrusted test from resolveJavaScriptFunction: a
              // live fn is trusted iff it carries module-eval provenance or an
              // entry ref THIS runtime's engine resolves back to the same
              // function. Untrusted → legacy (its SES fallback sandboxes it).
              leafTrust: (fn) =>
                getVerifiedProvenance(fn) !== undefined ||
                (() => {
                  const ref = getArtifactEntryRef(fn);
                  return ref !== undefined &&
                    this.runtime.harness.getVerifiedImplementation?.(
                        ref.identity,
                        ref.symbol,
                      ) === fn;
                })(),
              actionFrame: (frameTx, cause) =>
                this.createPatternFrame(
                  cause,
                  pattern,
                  resultCell,
                  frameTx,
                  false,
                ),
            })
            : undefined;
        const nodesToInstantiate = interpreterPlan?.kind === "interpret"
          ? interpreterPlan.nodes
          : pattern.nodes;
        for (const node of nodesToInstantiate) {
          const baseCell = resultCell.withTx(actualTx);
          this.instantiateNode(
            actualTx,
            node.module,
            node.inputs as FabricValue,
            node.outputs as FabricValue,
            baseCell,
            addNodeCancel,
            pattern,
            schedulerRehydration,
          );
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
      addCancel(
        resultCell.sinkMeta("patternIdentity", (newValue) => {
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
            cancelNodes?.();
            instantiatePattern(this.resolveToPattern(live));
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
              if (currentPatternKey !== newKey) return;
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
              cancelNodes?.();
              instantiatePattern(this.resolveToPattern(loaded));
            })
            .catch((err) => {
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
      instantiatePattern(givenPattern, tx);
      if (!doNotUpdateOnPatternChange) {
        setupPatternWatcher();
      }
      return;
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

    return;
  }

  /**
   * Internal start implementation with cascade of checks.
   * Each check: if it fails and needs async work, return a promise that
   * resolves the missing piece and retries.
   */
  private doStart<T = any>(
    resultCell: Cell<T>,
    seenCells: Set<Cell> = new Set(),
  ): Promise<boolean> {
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
    const wasPreparedLocally = this.locallyPreparedResults.has(key);
    const wasStoppedLocally = this.locallyStoppedResults.has(key);

    // Step 2: Already started? Return success
    if (this.cancels.has(key)) return Promise.resolve(true);

    // Step 3: Not synced yet? Sync and retry
    // Once getRaw() has a value, all properties including source are synced.
    if (rootCell.getRaw() === undefined) {
      return rootCell.sync().then(() => {
        if (rootCell.getRaw() === undefined) {
          return Promise.reject(new Error("No data at cell"));
        } else {
          return this.doStart(rootCell, seenCells);
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
        return this.doStart(nextCell, seenCells);
      }

      return Promise.reject(
        new Error(`Cannot start: no pattern identity`),
      );
    }
    return this.startAvailablePattern(
      rootCell,
      identityRef,
      wasSyncedAtEntry,
      wasPreparedLocally,
      wasStoppedLocally,
      seenCells,
    );
  }

  private startAvailablePattern<T = any>(
    rootCell: Cell<T>,
    identityRef: { identity: string; symbol: string },
    wasSyncedAtEntry: boolean,
    wasPreparedLocally: boolean,
    wasStoppedLocally: boolean,
    seenCells: Set<Cell>,
  ): Promise<boolean> {
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
      return pm
        .loadPatternByIdentity(
          identityRef.identity,
          identityRef.symbol,
          rootCell.space,
        )
        .then((loaded) => {
          if (loaded) {
            return this.doStart(rootCell, seenCells);
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
    // behavior even if an earlier read flipped the cell's generic `synced`
    // flag. The dependency sync below is specifically for resumed pieces that
    // came from storage.
    if (!wasSyncedAtEntry || wasPreparedLocally || wasStoppedLocally) {
      try {
        this.startCore(rootCell, {
          givenPattern: resolvedPattern,
          rehydrateSchedulerFromStorage: !wasStoppedLocally,
        });
      } catch (err) {
        return Promise.reject(err);
      }

      return Promise.resolve(true);
    }

    // Step 5: Sync the cells this running pattern depends on before wiring the
    // scheduler back up in a fresh runtime. Without this, resumed pieces can
    // observe the last persisted result but miss subsequent input updates.
    return this.syncCellsForRunningPattern(rootCell, resolvedPattern)
      .then(() => {
        // we may already be in the midst of starting this, so don't start again
        if (this.cancels.has(this.getDocKey(rootCell))) {
          return true;
        }

        try {
          this.startCore(rootCell, {
            givenPattern: resolvedPattern,
            // This pattern is resumed from a synced state (it just awaited
            // syncCellsForRunningPattern): hold each action's initial run until
            // the space finishes syncing so we don't race the data (e.g. maps
            // reconciling an empty array, then re-running once it streams in).
            awaitSyncBeforeInitialRun: true,
          });
        } catch (err) {
          return Promise.reject(err);
        }

        return true;
      });
  }

  private startWithTx<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
  ): void {
    const key = this.getDocKey(resultCell);
    if (this.cancels.has(key)) return;

    this.startCore(resultCell, {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange: options.doNotUpdateOnPatternChange,
      awaitSyncBeforeInitialRun: options.awaitSyncBeforeInitialRun,
    });
  }

  private startAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: RunnerRunOptions = {},
    pullOnceAfterStart: boolean = false,
  ): void {
    const resultLink = resultCell.getAsNormalizedFullLink();
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        return;
      }

      const startTx = this.runtime.edit();
      const committedResultCell = this.runtime.getCellFromLink<T>(
        resultLink,
        undefined,
        startTx,
      );
      try {
        this.startWithTx(startTx, committedResultCell, givenPattern, options);
        this.runtime.prepareTxForCommit(startTx);
        startTx.commit().then(({ error }) => {
          if (error) {
            this.stop(committedResultCell);
            logger.error(
              "tx-commit-error",
              "Error committing deferred start transaction",
              error,
            );
            return;
          }
          if (pullOnceAfterStart) {
            this.pullCellOnceInPullMode(committedResultCell);
          }
        }).catch((error) => {
          this.stop(committedResultCell);
          logger.error(
            "tx-commit-error",
            "Deferred start transaction commit rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        logger.error("runner-start", "Deferred start failed", error);
        throw error;
      }
    });
  }

  private runPatternAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    pattern: Pattern,
    inputs: FabricValue,
    pullOnceAfterStart = false,
    markCreateOnlyResult = false,
  ): void {
    const resultLink = resultCell.getAsNormalizedFullLink();
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) return;

      const startTx = this.runtime.edit();
      const committedResultCell = this.runtime.getCellFromLink<T>(
        resultLink,
        pattern.resultSchema,
        startTx,
      );
      try {
        this.run(startTx, pattern, inputs, committedResultCell);
        if (markCreateOnlyResult) {
          startTx.markCreateOnly?.(
            committedResultCell.getAsNormalizedFullLink(),
          );
        }
        this.runtime.prepareTxForCommit(startTx);
        startTx.commit().then(({ error }) => {
          if (error) {
            this.stop(committedResultCell);
            logger.error(
              "tx-commit-error",
              "Error committing deferred cross-space pattern transaction",
              error,
            );
            return;
          }
          if (pullOnceAfterStart) {
            this.pullCellOnceInPullMode(committedResultCell);
          }
        }).catch((error) => {
          this.stop(committedResultCell);
          logger.error(
            "tx-commit-error",
            "Deferred cross-space pattern transaction rejected",
            error,
          );
        });
      } catch (error) {
        startTx.abort(error);
        logger.error(
          "runner-start",
          "Deferred cross-space pattern failed",
          error,
        );
        throw error;
      }
    });
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

    if (needsStart) {
      const pullOnceAfterStart = this.patternNeedsOneShotPull(pattern);
      if (
        tx.tx.immediate === true &&
        (tx.tx as { deferRunnerStartUntilCommit?: boolean })
            .deferRunnerStartUntilCommit === true
      ) {
        this.startAfterSuccessfulCommit(
          tx,
          resultCell,
          pattern,
          options,
          pullOnceAfterStart,
        );
      } else {
        this.startWithTx(tx, resultCell, pattern, options);
        if (pullOnceAfterStart) {
          this.pullCellOnceAfterSuccessfulCommit(tx, resultCell);
        }
      }
    }

    if (!providedTx) {
      this.runtime.prepareTxForCommit(tx);
      tx.commit();
    }

    return resultCell;
  }

  async runSynced(
    resultCell: Cell<any>,
    pattern: Pattern | Module,
    inputs?: any,
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
    if (givenTx) {
      // If tx is given, i.e. result cell was part of a tx that is still open,
      // caller manages retries
      setupRes = this.setupInternal(
        givenTx,
        pattern,
        inputs,
        resultCell.withTx(givenTx),
      );
    } else {
      const { error } = await this.runtime.editWithRetry((tx) => {
        setupRes = this.setupInternal(
          tx,
          pattern,
          inputs,
          resultCell.withTx(tx),
        );
      });
      if (error) {
        logger.error("pattern-setup-error", "Error setting up pattern", error);
        setupRes = undefined;
      }
    }

    // If a new pattern was specified, make sure to sync any new cells
    if (pattern || !synced) {
      await this.syncCellsForRunningPattern(resultCell, pattern);
    }

    if (setupRes?.needsStart) {
      const tx = givenTx || this.runtime.edit();
      this.startWithTx(tx, resultCell.withTx(tx), setupRes.pattern);
      if (!givenTx) {
        // Should be unnecessary as the start itself is read-only
        // TODO(seefeld): Enforce this by adding a read-only flag for tx
        this.runtime.prepareTxForCommit(tx);
        await tx.commit().then(({ error }) => {
          if (error) {
            logger.error(
              "tx-commit-error",
              () => [
                "Error committing transaction",
                "\nError:",
                toIndentedDebugString(error),
                error.name === "ConflictError"
                  ? [
                    "\nConflict details:",
                    toIndentedDebugString(error.conflict),
                    "\nTransaction:",
                    toIndentedDebugString(error.transaction),
                  ]
                  : [],
              ],
            );
          }
        });
      }
    }

    return pattern?.resultSchema
      ? resultCell.asSchema(pattern.resultSchema)
      : resultCell;
  }

  private getDocKey(cell: Cell<any>): `${MemorySpace}/${CellScope}/${URI}` {
    const { space, id, scope } = cell.getAsNormalizedFullLink();
    return `${space}/${scope}/${id}`;
  }

  private schedulerRehydrationOptions(
    resultCell: Cell<any>,
    awaitSync?: boolean,
  ): SchedulerRehydrationSubscriptionOptions {
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
    if (!getPersistentSchedulerStateConfig()) {
      // Persistent scheduler state is off: actions always re-run on resume.
      // When resuming from a synced state, hold the initial run until the space
      // is synced so re-derivations read confirmed-loaded inputs.
      return awaitSync ? { awaitSyncBeforeInitialRun: { space } } : {};
    }
    return {
      rehydrateFromStorage: {
        space,
        pieceId: `${scope}:${id}`,
        processGeneration: 0,
        ...(awaitSync ? { awaitSync: true } : {}),
      },
    };
  }

  private async syncCellsForRunningPattern(
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

    // Sync all the inputs and outputs of the pattern nodes.
    for (const node of pattern.nodes) {
      const inputs = findAllWriteRedirectCells(node.inputs, resultCell);
      const outputs = findAllWriteRedirectCells(node.outputs, resultCell);

      // TODO(seefeld): This ignores schemas provided by modules, so it might
      // still fetch a lot.
      [...inputs, ...outputs].forEach((link) => {
        cells.push(this.runtime.getCellFromLink(link));
      });
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

    await Promise.all(cells.map((c) => c.sync()));

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
      const argumentLink = getMetaLink(resultCell, "argument") ??
        resultCell.getAsNormalizedFullLink();
      const unwrappedOutputs = unwrapOneLevelAndBindtoDoc(
        this.runtime.cfc,
        node.outputs,
        argumentLink,
        resultCell,
      );
      let spotLink: NormalizedFullLink | undefined;
      try {
        spotLink = firstResolvedOutputRedirect(
          this.runtime,
          tx,
          unwrappedOutputs,
          resultCell,
        );
      } catch (error) {
        // A node shape that cannot be resolved contributes nothing rather than
        // breaking the resume walk; log it so a resume that silently skips its
        // owned-cell pre-sync is diagnosable.
        logger.warn("resume-owned-cells", () => [
          "skipping a sub-pattern node whose output redirect did not resolve",
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
    this.cancels.get(key)?.();
    this.cancels.delete(key);
    this.locallyStoppedResults.add(key);
  }

  stopAll(): void {
    // Cancel all tracked operations
    for (const cancel of this.allCancels) {
      try {
        cancel();
      } catch (error) {
        console.warn("Error canceling operation:", error);
      }
    }
    this.allCancels.clear();
    // Clear the result pattern cache as well, since the actions have been
    // canceled
    this.resultPatternCache.clear();
    this.locallyPreparedResults.clear();
    this.locallyStoppedResults.clear();
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
    } else if (isWriteRedirectLink(module)) {
      // TODO(seefeld): Implement, a dynamic node
    } else {
      throw new Error(`Unknown module: ${toCompactDebugString(module)}`);
    }
  }

  private bindNodeIO(
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    baseCell: Cell<any>,
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
      reads: findAllWriteRedirectCells(inputs, baseCell),
      writes: findAllWriteRedirectCells(outputs, baseCell),
    };
  }

  private collectStaticRedirectWriteTargets(
    tx: IExtendedStorageTransaction,
    outputCells: readonly NormalizedFullLink[],
  ): NormalizedFullLink[] {
    // Write redirects are the static writable-output form: resolving them here
    // lets pull-mode indexing treat the resolved target like a normal declared
    // write. Dynamic writable-input writes use materializer envelopes instead.
    if (!outputCells.some((link) => link.overwrite === "redirect")) {
      return [];
    }

    const targets: NormalizedFullLink[] = [];
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
        // Some setup paths have not fully materialized metadata redirects
        // yet. Leave those to runtime dependency collection after the action
        // has run, but keep debug context for unexpected resolution failures.
        logger.debug("static-redirect-write-target", () => [
          "Unable to resolve static redirect write target",
          { output, error },
        ]);
      }
    }
    return dedupeNormalizedLinks(targets);
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
    processCell: Cell<any>,
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
      processCell.space,
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
    processCell: Cell<any>,
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
          links.push(...findAllWriteRedirectCells(currentValue, processCell));
        }
        return;
      }

      // TODO(danfuzz): This descends live `FabricValue` action inputs via
      // `Object.entries` with no `FabricSpecialObject` guard, decomposing
      // `FabricPrimitive` values and walking `FabricInstance` values by internal
      // slots.
      if (isRecord(schema.properties) && isRecord(currentValue)) {
        for (const [key, propertySchema] of Object.entries(schema.properties)) {
          visit(propertySchema, currentValue[key], [...path, key]);
        }
      }

      for (const key of ["items", "additionalProperties"] as const) {
        if (schema[key] !== undefined) {
          visit(schema[key], currentValue, path);
        }
      }
      for (const key of ["anyOf", "oneOf", "allOf"] as const) {
        const branches = schema[key];
        if (Array.isArray(branches)) {
          for (const branch of branches) visit(branch, currentValue, path);
        }
      }
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
    processCell: Cell<any>,
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
      if (isWriteRedirectLink(currentValue)) {
        const link = parseLink(currentValue, processCell);
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

      if (Array.isArray(currentValue) && schema.items !== undefined) {
        for (const item of currentValue) visit(schema.items, item);
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
   * Attach a stable, content-addressed implementation identity to an action,
   * derived from its bundle-relative source location. No-op when the harness
   * cannot resolve the location (built-in or unmapped sources); the scheduler
   * then falls back to the raw source location for its implementation
   * fingerprint. See docs/specs/module-loading.md.
   */
  private applyImplementationHash(
    action: Action,
    sourceLocation: string,
  ): void {
    const implementationHash = this.runtime.harness
      .implementationHashForSource?.(sourceLocation);
    if (implementationHash) {
      (action as { implementationHash?: string }).implementationHash =
        implementationHash;
    }
  }

  /**
   * If the final target of the link chain is a stream, return the first link.
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
  ): NormalizedFullLink | undefined {
    if (!isRecord(inputs) || !("$event" in inputs)) return undefined;

    let value: FabricValue = inputs.$event as FabricValue;
    while (isWriteRedirectLink(value)) {
      const maybeStreamLink = resolveLink(
        this.runtime,
        tx,
        parseLink(value, base),
        "writeRedirect",
      );
      value = tx.readValueOrThrow(maybeStreamLink);
    }

    return isStreamValue(value) ? parseLink(inputs.$event, base) : undefined;
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
    name: string | undefined,
    frame: Frame,
    processCell: Cell<any>,
    addCancel: AddCancel,
    cause: Record<string, any>,
  ): any {
    let receiptCell = this.runtime.getCell(
      processCell.space,
      { resultFor: cause },
      undefined,
      tx,
    );
    const receiptsEnabled =
      this.runtime.experimental.commitPreconditions === true;
    if (
      !validateAndCheckReactives(result, name) &&
      frame.reactives.size === 0
    ) {
      if (receiptsEnabled) {
        // Receipt-only handling (spec scheduler-v2 §7.6): nothing was
        // launched, but the result cell is still created — its create is the
        // exactly-once witness for this event id.
        receiptCell.withTx(tx).setRaw({});
        tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
      }
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    const resultSpace = result === undefined
      ? this.handlerResultPatternMaterializationSpace(
        resultPattern,
        processCell.space,
      )
      : processCell.space;
    // navigateTo result patterns must start after the handler's transaction
    // commits so the navigation target is durable. Cross-space children, by
    // contrast, run inline in a multi-space transaction (below) so they keep
    // their verified-function identity instead of being re-instantiated.
    const deferForNavigate = this.handlerResultPatternHasNavigateTo(
      resultPattern,
    );
    const crossSpace = resultSpace !== processCell.space;
    if (crossSpace) {
      receiptCell = this.runtime.getCell(
        resultSpace,
        { resultFor: cause },
        undefined,
        tx,
      );
    }

    // CT-1687: a handler that materializes a child piece in another space
    // (`Factory.inSpace(...)`) leaves a piece that a fresh runtime must load
    // FROM THAT SPACE — where neither the pattern meta nor the compiled
    // closure exist (the handler's bundle artifacts live in the handler's own
    // space). The whole result pattern materializes inside the target space,
    // so the per-node cross-space hook in instantiatePatternNode never sees
    // the transition; replicate here, where the originating space is known.
    for (const { module } of resultPattern.nodes) {
      if (
        module.type === "pattern" &&
        module.targetSpace !== undefined &&
        module.targetSpace !== processCell.space &&
        isPattern(module.implementation)
      ) {
        this.runtime.patternManager.replicatePatternToSpace(
          module.implementation,
          module.targetSpace,
          processCell.space,
        );
      }
    }

    if (deferForNavigate && result === undefined) {
      // navigateTo results are commit-gated (startAfterSuccessfulCommit);
      // the receipt precondition rides the deferred start's own create.
      this.runPatternAfterSuccessfulCommit(
        tx,
        receiptCell,
        resultPattern,
        undefined,
        true,
        true,
      );
      addCancel(() => this.stop(receiptCell));
      return result;
    }

    if (crossSpace && !deferForNavigate) {
      // Commit the child space first so the originating space's link to it is
      // never durable before its target.
      this.enableCrossSpaceChildCommit(tx, resultSpace, processCell.space);
    }

    const resultCell = deferForNavigate
      ? this.setupDeferredHandlerResultPattern(
        tx,
        resultPattern,
        resultSpace,
        cause,
        true,
      )
      : this.run(tx, resultPattern, undefined, receiptCell);

    if (!deferForNavigate) {
      tx.markCreateOnly?.(receiptCell.getAsNormalizedFullLink());
    }

    addCancel(() => this.stop(resultCell));

    if (!deferForNavigate) {
      // Spec scheduler-v2 §7.6 rule 2: the launch is speculative; if this
      // handler's transaction ultimately fails, stop the piece (data writes
      // roll back with the transaction; registrations do not).
      this.runtime.scheduler.lineage.recordPieceStop(
        tx,
        () => this.stop(resultCell),
      );
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

  private handlerResultPatternMaterializationSpace(
    pattern: Pattern,
    fallback: MemorySpace,
  ): MemorySpace {
    const targetSpaces = new Set<MemorySpace>();
    for (const { module } of pattern.nodes) {
      if (module.targetSpace !== undefined) {
        targetSpaces.add(module.targetSpace);
      }
    }
    return targetSpaces.size === 1 ? [...targetSpaces][0] : fallback;
  }

  private setupDeferredHandlerResultPattern(
    tx: IExtendedStorageTransaction,
    resultPattern: Pattern,
    resultSpace: MemorySpace,
    cause: Record<string, any>,
    markCreateOnlyResult = false,
  ): Cell<any> {
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
    if (resultSetup.needsStart) {
      this.startAfterSuccessfulCommit(
        tx,
        resultCell,
        resultSetup.pattern,
        {},
        this.patternNeedsOneShotPull(resultSetup.pattern),
      );
    }
    return resultCell;
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
    name: string | undefined,
    frame: Frame,
    resultCell: Cell<any>,
    outputs: FabricValue,
    addCancel: AddCancel,
    _resultFor: { inputs: FabricValue; outputs: FabricValue; fn: string },
    previousResultCellRef: JavaScriptActionResultCells,
    narrowestReadScope?: CellScope,
  ): any {
    if (
      !validateAndCheckReactives(result, name) &&
      frame.reactives.size === 0
    ) {
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
      processCell,
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
          processCell.space,
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
            return this.handleJavaScriptHandlerResult(
              tx,
              result,
              name,
              frame,
              processCell,
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
          processCell.space,
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

    const wrappedHandler = Object.assign(handler, {
      reads,
      writes,
      module,
      pattern,
      ...(presyncInputs !== undefined && { presyncInputs }),
    });

    const schedulerReads = this.collectArgumentSchedulerReadLinks(
      module.argumentSchema,
      inputs,
      processCell,
    );
    const declaredSchedulerReads = schedulerReads.length > 0
      ? schedulerReads
      : reads;
    const populateDependencies = reads.length > 0
      ? (depTx: IExtendedStorageTransaction, event: any) => {
        this.populateDeclaredSchedulerReads(declaredSchedulerReads, depTx);
        this.populateHandlerEventSchedulerReads(
          module.argumentSchema,
          processCell,
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
          processCell.space,
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
      processCell,
      resultCell: patternResultCell,
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
      patternResultCell.space,
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
        patternResultCell,
        tx,
        false,
        policyFacingIdentity,
      );
      (action as Action & { lastFrame?: Frame }).lastFrame = frame;
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      const resultCell = patternResultCell;

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
            return this.writeJavaScriptActionResult(
              tx,
              module.resultSchema,
              result,
              name,
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

    if (name) {
      setRunnableName(
        action,
        schedulerJavaScriptActionName(name, processCell, reads, writes),
        { setSrc: true },
      );
      this.applyImplementationHash(action, name);
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
          processCell,
          module.materializerWriteInputPaths,
        )
        : this.moduleHasOpaqueResult(module)
        ? this.collectWritableCellArgumentLinks(
          module.argumentSchema,
          inputs,
          processCell,
        )
        : []);
    const hasMaterializerWriteEnvelopes = materializerWriteEnvelopes.length > 0;
    const staticRedirectWriteTargets = hasMaterializerWriteEnvelopes
      ? []
      : this.collectStaticRedirectWriteTargets(tx, writes);
    const schedulingWrites = dedupeNormalizedLinks([
      ...writes,
      ...staticRedirectWriteTargets,
    ]);
    const wrappedAction = Object.assign(action, {
      reads,
      writes: schedulingWrites,
      ...(hasMaterializerWriteEnvelopes ? { materializerWriteEnvelopes } : {}),
      module,
      pattern,
    });

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      logger.timeStart("action", "populateDependencies");
      try {
        if (reads.length > 0) {
          this.populateDeclaredSchedulerReads(reads, depTx);
        } else if (module.argumentSchema !== undefined) {
          const inputsCell = this.runtime.getImmutableCell(
            processCell.space,
            inputs,
            undefined,
            depTx,
          );
          inputsCell.asSchema(module.argumentSchema!).get({
            traverseCells: true,
          });
        }

        for (const output of writes) {
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsAttemptedWrite,
          });
        }
      } finally {
        logger.timeEnd("action", "populateDependencies");
      }
    };

    addCancel(
      this.runtime.scheduler.subscribe(wrappedAction, populateDependencies, {
        ...schedulerRehydration,
      }),
    );
  }

  private instantiateJavaScriptNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    processCell: Cell<any>,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    schedulerRehydration: SchedulerRehydrationSubscriptionOptions,
  ) {
    const io = this.bindNodeIO(
      inputBindings,
      outputBindings,
      resultCell,
      processCell,
      pattern,
    );
    const { fn, name } = this.resolveJavaScriptFunction(module);
    const context: JavaScriptNodeContext = {
      tx,
      module,
      processCell,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      schedulerRehydration,
      ...io,
    };

    const streamLink = this.resolveJavaScriptStreamLink(
      io.inputs,
      processCell.getAsNormalizedFullLink(),
      tx,
    );
    if (streamLink) {
      this.instantiateJavaScriptHandlerNode({ ...context, streamLink });
      return;
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
   * (assigned post-eval by `registerEvaluatedModules`). With no known ref the
   * op is left as the embedded graph.
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
    const ref = this.runtime.patternManager.getArtifactEntryRef(
      op as unknown as object,
    );
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
    processCell: Cell<any>,
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
    // The reactive-interpreter's inline collection nodes are raw modules (no
    // ref name) but must keep the SAME by-identity op protocol — they opt in
    // via `ri2SubstituteOpRefs`.
    this.substituteOpPatternRefs(
      moduleRefName ??
        (module as { ri2SubstituteOpRefs?: string }).ri2SubstituteOpRefs,
      mappedInputBindings,
    );

    const inputCells = findAllWriteRedirectCells(
      mappedInputBindings,
      processCell,
    );
    // outputCells tracks what cells this action writes to. This is needed for
    // pull-based scheduling so collectDirtyDependencies() can find computations
    // that write to cells being read by effects.
    const outputCells = findAllWriteRedirectCells(
      mappedOutputBindings,
      processCell,
    );

    const inputsCell = this.runtime.getImmutableCell(
      processCell.space,
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
      processCell,
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
        space: processCell.space,
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
            processCell,
            mappedOutputBindings,
          );
          recordRawBuiltinBindingSchemaPolicyInputs(
            tx,
            this.runtime,
            processCell,
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
            {
              preserveLinkOutput: true,
              // Opt-in effective-scope threading for the reactive-interpreter
              // segment nodes (legacy javascript actions pass the tx's
              // narrowest read scope; no legacy raw builtin sets this marker,
              // so the default path is byte-identical).
              ...((module as { ri2ThreadNarrowestReadScope?: boolean })
                  .ri2ThreadNarrowestReadScope
                ? { narrowestReadScope: tx.getNarrowestReadScope() }
                : {}),
            },
          );
        },
        addCancel,
        {
          inputs: inputsCell,
          parents: processCell.entityId,
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
        processCell,
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
    const builtinPopulateDependencies = isRawBuiltinResult(builtinResult)
      ? builtinResult.populateDependencies
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
    const rawName = schedulerRawActionName(
      rawTargetName,
      inputCells,
      outputCells,
    );

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
    if (impl.src) {
      this.applyImplementationHash(action, impl.src);
    }

    // Seed raw actions with their pattern/module/write metadata so pull-mode
    // scheduling can discover pending computations before their first run.
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

    // Create populateDependencies callback.
    // If builtin provides custom reads, use that; otherwise read all inputs.
    // Always register output writes so collectDirtyDependencies() can find this
    // computation when an effect needs its outputs.
    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      logger.timeStart("raw", "populateDependencies");
      try {
        // Capture read dependencies - use custom if provided, otherwise read all inputs
        if (builtinPopulateDependencies) {
          if (typeof builtinPopulateDependencies === "function") {
            builtinPopulateDependencies(depTx);
          } else {
            // It's a ReactivityLog - reads are already captured, nothing to do
            for (const read of builtinPopulateDependencies.reads) {
              depTx.readOrThrow(read);
            }
          }
        } else {
          // Default: read all inputs
          for (const input of inputCells) {
            this.runtime.getCellFromLink(input, undefined, depTx)?.get();
          }
        }
        // Always capture write dependencies by marking outputs as attempted writes
        for (const output of outputCells) {
          // Reading with markReadAsAttemptedWrite registers this as a write dependency
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsAttemptedWrite,
          });
        }
      } finally {
        logger.timeEnd("raw", "populateDependencies");
      }
    };

    // isEffect can come from module options or from the builtin result
    const isEffect = module.isEffect ?? builtinIsEffect;
    const debounce = module.debounce ?? builtinDebounce;
    const noDebounce = module.noDebounce ?? builtinNoDebounce;
    const throttle = module.throttle ?? builtinThrottle;

    addCancel(
      this.runtime.scheduler.subscribe(action, populateDependencies, {
        isEffect,
        debounce,
        noDebounce,
        throttle,
        ...schedulerRehydration,
      }),
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
