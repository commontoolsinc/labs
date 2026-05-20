import {
  fabricFromNativeValue,
  type FabricValue,
} from "@commonfabric/data-model/fabric-value";
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
  findAllWriteRedirectCells,
  unsafe_noteParentOnPatterns,
  unwrapOneLevelAndBindtoDoc,
} from "./pattern-binding.ts";
import { resolveLink } from "./link-resolution.ts";
import {
  createSigilLinkFromParsedLink,
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
  markReadAsPotentialWrite,
} from "./scheduler.ts";
import { internalVerifierRead } from "./storage/reactivity-log.ts";
import { FunctionCache } from "./function-cache.ts";
import { isRawBuiltinResult, type RawBuiltinReturnType } from "./module.ts";
import "./builtins/index.ts";
import { isCellResult } from "./query-result-proxy.ts";
import { isCellScope, narrowestScope } from "./scope.ts";
import {
  cellAwareDeepCopy,
  describePatternOrModule,
  extractDefaultValues,
  getSigilLink,
  mergeObjects,
  sanitizeDebugLabel,
  setRunnableName,
  validateAndCheckOpaqueRefs,
} from "./runner-utils.ts";
import {
  resolveBuiltinImplementationIdentity,
  resolvePolicyFacingImplementationIdentity,
} from "./cfc/implementation-identity.ts";
import {
  CFC_STRUCTURAL_PROVENANCE_SETUP_PROJECTION,
  type ImplementationIdentity,
} from "./cfc/types.ts";
import { setVerifiedFunctionRegistrar } from "./sandbox/function-hardening.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { setResultCell } from "./result-utils.ts";
export {
  cellAwareDeepCopy,
  extractDefaultValues,
  mergeObjects,
  validateAndCheckOpaqueRefs,
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
  "fetchData",
  "fetchProgram",
  "generateObject",
  "generateText",
  "llm",
  "llmDialog",
  "navigateTo",
  "streamData",
]);

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
  verifiedLoadId: string | undefined;
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
  verifiedLoadId: string | undefined;
};

type JavaScriptActionResultCells = {
  byScope: Map<CellScope, Cell<any>>;
};

export class Runner {
  readonly cancels = new Map<`${MemorySpace}/${URI}`, Cancel>();
  private allCancels = new Set<Cancel>();
  private functionCache = new FunctionCache();
  private locallyPreparedResults = new Set<`${MemorySpace}/${URI}`>();
  // Map whose key is the result cell's full key, and whose values are the
  // patterns as strings
  private resultPatternCache = new Map<
    `${MemorySpace}/${CellScope}/${URI}`,
    string
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
    previousPatternId: URI | undefined,
  ):
    | {
      pattern: Pattern;
      patternId: URI;
      resolvedPatternOrModule: Pattern | Module;
    }
    | undefined {
    let resolvedPatternOrModule = patternOrModule;
    let patternId = patternOrModule ? undefined : previousPatternId;

    if (!resolvedPatternOrModule && patternId) {
      resolvedPatternOrModule = this.runtime.patternManager.patternById(
        patternId,
      );
      if (!resolvedPatternOrModule) {
        throw new Error(`Unknown pattern: ${patternId}`);
      }
    } else if (!resolvedPatternOrModule) {
      return undefined;
    }

    const pattern = isModule(resolvedPatternOrModule)
      ? this.moduleToPattern(resolvedPatternOrModule)
      : resolvedPatternOrModule;
    patternId ??= this.runtime.patternManager.registerPattern(pattern);

    return { pattern, patternId, resolvedPatternOrModule };
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
    patternId: string,
    previousPatternId: string | undefined,
  ): SetupResult<R> | undefined {
    const key = this.getDocKey(resultCell);
    if (!this.cancels.has(key)) return undefined;

    if (argument === undefined && patternId === previousPatternId) {
      return { resultCell, needsStart: false };
    }

    if (previousPatternId === patternId) {
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
    const internalCellLink = getMetaLink(resultCell, "internal")!;
    const resultCellLink = resultCell.getAsNormalizedFullLink();
    let result = unwrapOneLevelAndBindtoDoc<R, any>(
      this.runtime.cfc,
      pattern.result as R,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
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
    if (!deepEqual(result, previousResult)) {
      recordSetupProjectionPolicyInputs(
        tx,
        this.runtime,
        resultCell,
        pattern.resultSchema,
        result,
      );
      writableResultCell.setRawUntyped(
        fabricFromNativeValue(result, false),
      );
    }
  }

  /**
   * When this function is first called, the resultCell may not have its
   * internal, argument, and pattern cells set up, so do that here.
   */
  private applySetupState<T, R>(
    tx: IExtendedStorageTransaction,
    pattern: Pattern,
    patternId: URI,
    previousPatternId: string | undefined,
    argument: T,
    resultCell: Cell<R>,
  ): void {
    const defaults = extractDefaultValues(pattern.argumentSchema) as Partial<T>;
    const internalLink = getMetaLink(resultCell, "internal");
    let argumentLink = getMetaLink(resultCell, "argument");
    const internalCell = getMetaCell(
      resultCell,
      "internal",
      tx,
      pattern.internalSchema,
    );
    const previousInternal = internalCell.getRawUntyped({
      meta: ignoreReadForScheduling,
      frozen: false,
    });
    const internal = Object.assign(
      {},
      cellAwareDeepCopy(
        (defaults as unknown as { internal: FabricValue })?.internal,
      ),
      cellAwareDeepCopy(
        isRecord(pattern.initial) && isRecord(pattern.initial.internal)
          ? pattern.initial.internal
          : {},
      ),
      isRecord(previousInternal) ? previousInternal : {},
    ) as FabricValue;
    internalCell.setRawUntyped(fabricFromNativeValue(internal, false));
    if (internalLink === undefined) {
      setResultCell(internalCell, resultCell.asSchema(pattern.resultSchema));
      const newInternalCellLink = internalCell.getAsWriteRedirectLink({
        base: resultCell,
        includeSchema: true,
      });
      resultCell.withTx(tx).setMetaRaw(
        "internal",
        newInternalCellLink,
      );
    }

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

    // Set the pattern in the resultCell as well
    resultCell.withTx(tx).setMetaRaw("pattern", getSigilLink(patternId));

    this.updateResultProjection(tx, pattern, resultCell.withTx(tx), {
      preserveName: previousPatternId === patternId,
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

    const previousPatternId = getPatternId(resultCell.withTx(tx));
    const resolvedPattern = this.resolveSetupPattern(
      patternOrModule,
      previousPatternId,
    );

    if (!resolvedPattern) {
      console.warn(
        "No pattern provided and no pattern found in result metadata. Not running.",
      );
      this.locallyPreparedResults.delete(this.getDocKey(resultCell));
      return { resultCell, needsStart: false };
    }

    const { pattern, patternId, resolvedPatternOrModule } = resolvedPattern;
    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`setup-internal/${sourceKey}`, () => [
      `[SETUP] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(resolvedPatternOrModule)}`,
      `previousPatternId=${previousPatternId ?? "none"}`,
      `nextPatternId=${patternId}`,
    ]);

    this.runtime.patternManager.savePattern({
      patternId,
      space: resultCell.space,
    }, tx);

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
      patternId,
      previousPatternId,
    );
    if (runningSetup) {
      return runningSetup;
    }

    this.applySetupState(
      tx,
      pattern,
      patternId,
      previousPatternId,
      argument,
      resultCell,
    );

    this.discoverAndCacheFunctions(pattern, new Set());

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
    return {
      argumentSchema: module.argumentSchema ?? {},
      resultSchema: module.resultSchema ?? {},
      result: { $alias: { cell: "internal", path: [] } },
      nodes: [
        {
          module,
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: { $alias: { cell: "internal", path: [] } },
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
    } = {},
  ): void {
    const { tx, givenPattern, doNotUpdateOnPatternChange } = options;
    const key = this.getDocKey(resultCell);
    this.locallyPreparedResults.delete(key);

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

    // Track pattern ID and node cancellation
    let currentPatternId: URI | undefined;
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
      this.discoverAndCacheFunctions(pattern, new Set());
      const actualTx = useTx ?? this.runtime.edit();
      const shouldCommit = !useTx;
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
          );
        }
      } finally {
        if (shouldCommit) {
          this.runtime.prepareTxForCommit(actualTx);
          actualTx.commit();
        }
      }
    };

    // Helper to set up the pattern watcher
    const setupPatternWatcher = () => {
      addCancel(
        resultCell.sinkMeta("pattern", (newPatternValue) => {
          const newPatternLink = parseLink(newPatternValue, resultCell);
          const newPatternId = newPatternLink?.id;
          if (newPatternId === currentPatternId) return; // No change
          if (!newPatternId) return;

          // Pattern changed
          const previousPatternId = currentPatternId;
          currentPatternId = newPatternId;

          const resolved = this.runtime.patternManager.patternById(
            newPatternId,
          );
          if (!resolved) {
            // Async load for pattern change after initial start.
            // Errors are logged here since there's no caller to propagate to.
            this.runtime.patternManager
              .loadPattern(newPatternId, resultCell.space)
              .then((loaded) => {
                if (currentPatternId !== newPatternId) return;

                logger.info("pattern changed", {
                  from: {
                    id: previousPatternId,
                    pattern: this.runtime.patternManager.patternById(
                      previousPatternId!,
                    ),
                  },
                  to: { id: newPatternId, pattern: loaded },
                });

                // Cancel previous nodes (after we're sure it's a valid one)
                cancelNodes?.();

                instantiatePattern(loaded);
              })
              .catch((err) => {
                logger.error(
                  "pattern-load-error",
                  `Failed to load pattern ${newPatternId}`,
                  err,
                );
              });
          } else {
            cancelNodes?.();
            instantiatePattern(resolved);
          }
        }),
      );
    };

    const resultCellForRead = tx ? resultCell.withTx(tx) : resultCell;
    const initialPatternId = getPatternId(resultCellForRead);

    if (!initialPatternId) {
      cleanup();
      throw new Error("Cannot start: no pattern ID (pattern)");
    }

    // Determine initial pattern
    if (givenPattern) {
      currentPatternId = initialPatternId;
      if (
        this.runtime.patternManager.registerPattern(givenPattern) !==
          currentPatternId
      ) {
        cleanup();
        throw new Error("Pattern ID mismatch");
      }
      instantiatePattern(givenPattern, tx);
      if (!doNotUpdateOnPatternChange) {
        setupPatternWatcher();
      }
      return;
    }

    // Try sync lookup
    const initialResolved = this.runtime.patternManager.patternById(
      initialPatternId,
    );
    if (!initialResolved) {
      cleanup();
      throw new Error(`Unknown pattern: ${initialPatternId}`);
    }

    // Sync path - instantiate immediately
    currentPatternId = initialPatternId;
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

    // Step 2: Already started? Return success
    if (this.cancels.has(key)) return Promise.resolve(true);

    // Step 3: Not synced yet? Sync and retry
    // Once getRaw() has a value, all properties including source are synced.
    if (rootCell.getRaw() === undefined) {
      return Promise.resolve(rootCell.sync()).then(() => {
        if (rootCell.getRaw() === undefined) {
          return Promise.reject(new Error("No data at cell"));
        } else {
          return this.doStart(rootCell, seenCells);
        }
      });
    }

    // Step 4: Check whether the pattern is available, otherwise load it
    const patternId = getPatternId(rootCell);
    if (!patternId) {
      return Promise.reject(
        new Error(`Cannot start: no pattern ID (pattern)`),
      );
    }
    return this.startAvailablePattern(
      rootCell,
      patternId,
      wasSyncedAtEntry,
      wasPreparedLocally,
      seenCells,
    );
  }

  private startAvailablePattern<T = any>(
    rootCell: Cell<T>,
    patternId: URI,
    wasSyncedAtEntry: boolean,
    wasPreparedLocally: boolean,
    seenCells: Set<Cell>,
  ): Promise<boolean> {
    const pattern = this.runtime.patternManager.patternById(patternId);
    if (!pattern) {
      return this.runtime.patternManager.loadPattern(
        patternId,
        rootCell.space,
      )
        .then((loaded) => {
          if (loaded) {
            return this.doStart(rootCell, seenCells);
          } else {
            return Promise.reject(
              new Error(`Could not load pattern ${patternId}`),
            );
          }
        });
    }

    const resolvedPattern = this.resolveToPattern(pattern);

    // Fast path for pieces prepared in the current runtime via setup()/run().
    // Those writes are already present locally, so we should preserve the
    // historical synchronous start() behavior even if an earlier read flipped
    // the cell's generic `synced` flag. The dependency sync below is
    // specifically for resumed pieces that came from storage.
    if (!wasSyncedAtEntry || wasPreparedLocally) {
      try {
        this.startCore(rootCell, {
          givenPattern: resolvedPattern,
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
        try {
          this.startCore(rootCell, {
            givenPattern: resolvedPattern,
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
    options: { doNotUpdateOnPatternChange?: boolean } = {},
  ): void {
    const key = this.getDocKey(resultCell);
    if (this.cancels.has(key)) return;

    this.startCore(resultCell, {
      tx,
      givenPattern,
      doNotUpdateOnPatternChange: options.doNotUpdateOnPatternChange,
    });
  }

  private startAfterSuccessfulCommit<T = any>(
    tx: IExtendedStorageTransaction,
    resultCell: Cell<T>,
    givenPattern?: Pattern,
    options: { doNotUpdateOnPatternChange?: boolean } = {},
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
    options?: { doNotUpdateOnPatternChange?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    tx: IExtendedStorageTransaction | undefined,
    pattern: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options?: { doNotUpdateOnPatternChange?: boolean },
  ): Cell<R>;
  run<T, R = any>(
    providedTx: IExtendedStorageTransaction,
    patternOrModule: Pattern | Module | undefined,
    argument: T,
    resultCell: Cell<R>,
    options: { doNotUpdateOnPatternChange?: boolean } = {},
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
        const maybePromise = this.runtime.getCellFromLink(link).sync();
        if (maybePromise instanceof Promise) promises.add(maybePromise);
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
    this.locallyPreparedResults.delete(key);
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
  }

  /**
   * Discover and cache JavaScript functions from a pattern.
   * This recursively traverses the pattern structure to find all JavaScript modules
   * with string implementations and evaluates them for caching.
   *
   * @param pattern The pattern to discover functions from
   */
  private discoverAndCacheFunctions(
    pattern: Pattern,
    seen: Set<object>,
  ): void {
    if (seen.has(pattern)) return;
    seen.add(pattern);

    for (const node of pattern.nodes) {
      this.discoverAndCacheFunctionsFromModule(node.module, seen);

      // Also check inputs for nested patterns (e.g., in map operations)
      this.discoverAndCacheFunctionsFromValue(node.inputs, seen);
    }
  }

  /**
   * Discover and cache functions from a module.
   *
   * @param module The module to process
   */
  private discoverAndCacheFunctionsFromModule(
    module: Module,
    seen: Set<object>,
  ): void {
    if (seen.has(module)) return;
    seen.add(module);

    if (!isModule(module)) return;

    switch (module.type) {
      case "javascript":
        // Only prewarm the cache from functions that were already registered
        // by the SES verification/evaluation pipeline. Host callbacks must not
        // enter the execution cache directly.
        if (module.implementationRef && !this.functionCache.has(module)) {
          const executable = this.runtime.harness.getExecutableFunction(
            module.implementationRef,
          );
          if (executable) {
            this.functionCache.set(module, executable);
          }
        }
        break;

      case "pattern":
        // Recursively discover functions in nested patterns
        if (isPattern(module.implementation)) {
          this.discoverAndCacheFunctions(module.implementation, seen);
        }
        break;

      case "ref":
        // Resolve reference and process the referenced module
        try {
          const referencedModule = this.runtime.moduleRegistry.getModule(
            module.implementation as string,
          );
          this.discoverAndCacheFunctionsFromModule(referencedModule, seen);
        } catch (error) {
          console.warn(
            `Failed to resolve module reference for implementation "${module.implementation}":`,
            error,
          );
        }
        break;
    }
  }

  /**
   * Discover and cache functions from a value that might contain patterns.
   * This handles cases where patterns are passed as inputs (e.g., to map operations).
   *
   * @param value The value to search for patterns
   */
  private discoverAndCacheFunctionsFromValue(
    value: FabricValue,
    seen: Set<object>,
  ): void {
    if (isPattern(value)) {
      this.discoverAndCacheFunctions(value, seen);
      return;
    }

    if (isModule(value)) {
      this.discoverAndCacheFunctionsFromModule(value, seen);
      return;
    }

    if (
      !isRecord(value) || isCell(value) || isCellResult(value)
    ) {
      return;
    }

    if (seen.has(value)) return;
    seen.add(value);

    // Recursively search in objects and arrays
    if (Array.isArray(value)) {
      for (const item of value as FabricValue[]) {
        this.discoverAndCacheFunctionsFromValue(item, seen);
      }
      return;
    }

    for (const key in value as Record<string, any>) {
      this.discoverAndCacheFunctionsFromValue(
        value[key] as FabricValue,
        seen,
      );
    }
  }

  private instantiateNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    pattern: Pattern,
    moduleRefName?: string,
  ) {
    if (isModule(module)) {
      switch (module.type) {
        case "ref": {
          const refName = module.implementation as string;
          this.instantiateNode(
            tx,
            this.runtime.moduleRegistry.getModule(
              refName,
            ),
            inputBindings,
            outputBindings,
            resultCell,
            addCancel,
            pattern,
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
  ): BoundNodeIO {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const internalCellLink = getMetaLink(resultCell, "internal")!;
    const resultCellLink = resultCell.getAsNormalizedFullLink();
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );
    const outputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );
    return {
      inputs,
      outputs,
      reads: findAllWriteRedirectCells(inputs, baseCell),
      writes: findAllWriteRedirectCells(outputs, baseCell),
    };
  }

  private resolveJavaScriptFunction(
    module: Module,
    pattern: Pattern,
  ): ResolvedJavaScriptModule {
    let fn: (...args: any[]) => any;
    const patternId = this.runtime.patternManager.getPatternId(pattern);
    const verifiedLoadId = module.implementationRef
      ? this.runtime.harness.getVerifiedLoadId?.(
        module.implementationRef,
        patternId,
      )
      : undefined;

    if (module.implementationRef) {
      const cached = this.functionCache.get(module);
      if (cached) {
        fn = cached;
      } else {
        const executable = this.runtime.harness.getExecutableFunction(
          module.implementationRef,
          patternId,
        );
        fn = executable
          ? executable as (...args: any[]) => any
          : this.getFallbackJavaScriptImplementation(module);
        this.functionCache.set(module, fn);
      }
    } else {
      const cached = this.functionCache.get(module);
      if (cached) {
        fn = cached;
      } else {
        fn = this.getFallbackJavaScriptImplementation(module);
        this.functionCache.set(module, fn);
      }
    }

    const namedFn = fn as {
      src?: string;
      name?: string;
      sourceLocationSample?: Record<string, unknown>;
    };
    const name = namedFn.src || fn.name || module.implementationRef;
    if (name && namedFn.sourceLocationSample) {
      sourceLocationLogger.flag("sample", name, true, {
        name,
        ...namedFn.sourceLocationSample,
      });
    }

    return { fn, name, verifiedLoadId };
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
    verifiedLoadId?: string,
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
      ...(verifiedLoadId ? { verifiedLoadId } : {}),
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

  private handleJavaScriptHandlerResult(
    tx: IExtendedStorageTransaction,
    result: any,
    name: string | undefined,
    frame: Frame,
    processCell: Cell<any>,
    addCancel: AddCancel,
    cause: Record<string, any>,
  ): any {
    if (
      !validateAndCheckOpaqueRefs(result, name) &&
      frame.opaqueRefs.size === 0
    ) {
      return result;
    }

    const resultPattern = patternFromFrame(() => result);
    const resultCell = this.handlerResultPatternMustStartAfterCommit(
        resultPattern,
      )
      ? this.setupDeferredHandlerResultPattern(
        tx,
        resultPattern,
        processCell,
        cause,
      )
      : this.run(
        tx,
        resultPattern,
        undefined,
        this.runtime.getCell(
          processCell.space,
          { resultFor: cause },
          undefined,
          tx,
        ),
      );

    if (!this.runtime.scheduler.isPullModeEnabled()) {
      const rawResult = tx.readValueOrThrow(
        resultCell.getAsNormalizedFullLink(),
        {
          meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
        },
      );
      const resultRedirects = findAllWriteRedirectCells(rawResult, processCell);
      const readResultAction: Action = (tx) =>
        resultRedirects.forEach((link) => tx.readValueOrThrow(link));

      if (name) {
        setRunnableName(readResultAction, `readResult:${name}`, {
          setSrc: true,
        });
      }

      const cancel = this.runtime.scheduler.subscribe(
        readResultAction,
        readResultAction,
        { isEffect: true },
      );
      tx.addCommitCallback((_committedTx, result) => {
        if (result.error) {
          cancel();
          this.stop(resultCell);
        }
      });
      addCancel(() => {
        cancel();
        this.stop(resultCell);
      });
    } else {
      addCancel(() => this.stop(resultCell));
    }

    return result;
  }

  private handlerResultPatternMustStartAfterCommit(pattern: Pattern): boolean {
    return pattern.nodes.some(({ module }) =>
      module.type === "ref" && module.implementation === "navigateTo"
    );
  }

  private setupDeferredHandlerResultPattern(
    tx: IExtendedStorageTransaction,
    resultPattern: Pattern,
    processCell: Cell<any>,
    cause: Record<string, any>,
  ): Cell<any> {
    const resultCell = this.runtime.getCell(
      processCell.space,
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
    if (!this.runtime.scheduler.isPullModeEnabled() || !pattern) {
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
    if (!this.runtime.scheduler.isPullModeEnabled()) {
      return;
    }
    const resultLink = resultCell.getAsNormalizedFullLink();
    tx.addCommitCallback((_committedTx, result) => {
      if (result.error) {
        return;
      }
      this.pullCellOnceInPullMode(this.runtime.getCellFromLink<T>(resultLink));
    });
  }

  private pullCellOnceInPullMode<T = any>(cell: Cell<T>): void {
    if (!this.runtime.scheduler.isPullModeEnabled()) {
      return;
    }
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
      !validateAndCheckOpaqueRefs(result, name) &&
      frame.opaqueRefs.size === 0
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
        getMetaLink(resultCell, "internal")!,
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
      getMetaLink(resultCell, "internal")!,
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
      verifiedLoadId,
      streamLink,
    }: JavaScriptNodeContext & { streamLink: NormalizedFullLink },
  ): void {
    const handler = (tx: IExtendedStorageTransaction, event: any) => {
      if (event?.preventDefault) event.preventDefault();

      const eventInputs = {
        ...(inputs as Record<string, any>),
        $event: event,
      };
      const cause = {
        ...(inputs as Record<string, any>),
        $event: crypto.randomUUID(),
      };
      const policyFacingIdentity = resolvePolicyFacingImplementationIdentity(
        module,
        {
          verifiedLoadId,
          harness: this.runtime.harness,
          implementation: fn,
        },
      );
      const frame = this.createPatternFrame(
        cause,
        pattern,
        resultCell,
        tx,
        true,
        verifiedLoadId,
        policyFacingIdentity,
      );
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

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
              verifiedLoadId,
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

        return result instanceof Promise
          ? result.then(postRun)
          : postRun(result);
      } catch (error) {
        (error as Error & { frame?: Frame }).frame = frame;
        throw error;
      } finally {
        popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(handler, `handler:${name}`, { setSrc: true });
    }

    const wrappedHandler = Object.assign(handler, {
      reads,
      writes,
      module,
      pattern,
    });

    const populateDependencies = module.argumentSchema
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
      verifiedLoadId,
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
        {
          verifiedLoadId,
          harness: this.runtime.harness,
          implementation: fn,
        },
      );
      const frame = this.createPatternFrame(
        resultFor,
        pattern,
        patternResultCell,
        tx,
        false,
        verifiedLoadId,
        policyFacingIdentity,
      );
      (action as Action & { lastFrame?: Frame }).lastFrame = frame;
      if (policyFacingIdentity) {
        tx.setCfcImplementationIdentity(policyFacingIdentity);
      }

      const resultCell = patternResultCell;

      const handleErrorOutput = (error: unknown) => {
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
            getMetaLink(resultCell, "internal")!,
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
              verifiedLoadId,
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

        return result instanceof Promise
          ? result.then(postRun).catch(handleErrorOutput)
          : postRun(result);
      } catch (error) {
        handleErrorOutput(error);
      } finally {
        popFrame(frame);
      }
    };

    if (name) {
      setRunnableName(action, `action:${name}`, { setSrc: true });
    }

    const wrappedAction = Object.assign(action, {
      reads,
      writes,
      module,
      pattern,
    });

    const populateDependencies = (depTx: IExtendedStorageTransaction) => {
      logger.timeStart("action", "populateDependencies");
      try {
        if (module.argumentSchema !== undefined) {
          const inputsCell = this.runtime.getImmutableCell(
            processCell.space,
            inputs,
            undefined,
            depTx,
          );
          inputsCell.asSchema(module.argumentSchema!).get({
            traverseCells: true,
          });
        } else {
          for (const read of reads) {
            this.runtime.getCellFromLink(read, undefined, depTx)?.get();
          }
        }

        for (const output of writes) {
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsPotentialWrite,
          });
        }
      } finally {
        logger.timeEnd("action", "populateDependencies");
      }
    };

    addCancel(
      this.runtime.scheduler.subscribe(wrappedAction, populateDependencies),
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
  ) {
    const io = this.bindNodeIO(
      inputBindings,
      outputBindings,
      resultCell,
      processCell,
    );
    const { fn, name, verifiedLoadId } = this.resolveJavaScriptFunction(
      module,
      pattern,
    );
    const context: JavaScriptNodeContext = {
      tx,
      module,
      processCell,
      resultCell,
      addCancel,
      pattern,
      fn,
      name,
      verifiedLoadId,
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
    verifiedLoadId?: string,
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

    if (!verifiedLoadId || !this.runtime.harness.registerVerifiedFunction) {
      return invoke();
    }

    const restoreVerifiedFunctionRegistrar = setVerifiedFunctionRegistrar(
      (implementationRef, implementation) => {
        this.runtime.harness.registerVerifiedFunction!(
          verifiedLoadId,
          implementationRef,
          implementation as (input: any) => void,
        );
      },
    );
    try {
      return invoke();
    } finally {
      restoreVerifiedFunctionRegistrar();
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
    const internalCellLink = getMetaLink(resultCell, "internal")!;
    const resultCellLink = resultCell.getAsNormalizedFullLink();
    // CT-1230: Pass bindPatterns: false to prevent premature alias binding in pattern
    // arguments. When a subpattern is passed to map(), its aliases should not be
    // bound to the current doc yet - they need to remain unbound until the pattern
    // is actually instantiated for each mapped item.
    const mappedInputBindings = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
      { bindPatterns: false },
    );
    const mappedOutputBindings = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      outputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );

    // For `map` and future other node types that take closures, we need to
    // note the parent pattern on the closure patterns.
    unsafe_noteParentOnPatterns(pattern, mappedInputBindings);

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
            internalCellLink!,
            mappedOutputBindings,
            resultForRawBuiltinOutputBinding(
              result,
              outputBindingSchema,
              builtinIdentity,
            ),
          );
        },
        addCancel,
        { inputs: inputsCell, parents: processCell.entityId },
        processCell,
        this.runtime,
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
    const rawName = `raw:${rawTargetName}`;

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

    // Seed raw actions with their pattern/module/write metadata so pull-mode
    // scheduling can discover pending computations before their first run.
    Object.assign(action, builtinAction, {
      reads: inputCells,
      writes: outputCells,
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
        // Always capture write dependencies by marking outputs as potential writes
        for (const output of outputCells) {
          // Reading with markReadAsPotentialWrite registers this as a write dependency
          this.runtime.getCellFromLink(output, undefined, depTx)?.getRaw({
            meta: markReadAsPotentialWrite,
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
    _pattern: Pattern,
  ) {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const internalCellLink = getMetaLink(resultCell, "internal")!;
    const resultCellLink = resultCell.getAsNormalizedFullLink();
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );

    sendValueToBinding(
      tx,
      resultCell,
      argumentCellLink,
      internalCellLink,
      outputBindings,
      inputs,
    );
  }

  private instantiatePatternNode(
    tx: IExtendedStorageTransaction,
    module: Module,
    inputBindings: FabricValue,
    outputBindings: FabricValue,
    resultCell: Cell<any>,
    addCancel: AddCancel,
    _pattern: Pattern,
  ) {
    const argumentCellLink = getMetaLink(resultCell, "argument")!;
    const internalCellLink = getMetaLink(resultCell, "internal")!;
    const resultCellLink = resultCell.getAsNormalizedFullLink();
    if (!isPattern(module.implementation)) throw new Error(`Invalid pattern`);
    const patternImpl = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      module.implementation,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );
    const inputs = unwrapOneLevelAndBindtoDoc(
      this.runtime.cfc,
      inputBindings,
      argumentCellLink,
      internalCellLink,
      resultCellLink,
    );

    // If output bindings is a link to a non-redirect cell,
    // use that instead of creating a new cell.
    let sendToBindings: boolean;
    if (isSigilLink(outputBindings) && !isWriteRedirectLink(outputBindings)) {
      resultCell = this.runtime.getCellFromLink(
        parseLink(outputBindings, resultCell),
        patternImpl.resultSchema,
        tx,
      );
      sendToBindings = false;
    } else {
      const baseResultCell = this.runtime.getCell(
        resultCell.space,
        {
          pattern: module.implementation,
          inputBindings,
          outputBindings,
        },
        patternImpl.resultSchema,
        tx,
      );
      const resultScope = patternDefaultScope(patternImpl) ??
        module.defaultScope;
      resultCell = baseResultCell;
      if (resultScope !== undefined && resultScope !== "space") {
        let resultCellLink = baseResultCell.getAsNormalizedFullLink();
        resultCellLink = { ...resultCellLink, scope: resultScope };
        // The result cell's scope isn't "space", so we may have just created
        // this cell. If so, create the corresponding argument/internal cells.
        resultCell = createCell(this.runtime, resultCellLink, tx);
      }
      sendToBindings = true;
    }

    const sourceKey = getTxDebugActionId(tx) ?? "none";
    triggerFlowLogger.debug(`instantiate-pattern-node/${sourceKey}`, () => [
      `[PATTERN-NODE] source=${sourceKey}`,
      `result=${resultCell.getAsNormalizedFullLink().id}`,
      `pattern=${describePatternOrModule(patternImpl)}`,
      `sendToBindings=${sendToBindings}`,
    ]);

    this.run(tx, patternImpl, inputs, resultCell);

    if (sendToBindings) {
      sendValueToBinding(
        tx,
        resultCell,
        argumentCellLink,
        internalCellLink,
        outputBindings,
        resultCell.getAsLink(),
      );
    }

    // TODO(seefeld): Make sure to not cancel after a pattern is elevated to a
    // piece, e.g. via navigateTo. Nothing is cancelling right now, so leaving
    // this as TODO.
    addCancel(() => this.stop(resultCell));
  }
}

function getTxDebugActionId(
  tx?: IExtendedStorageTransaction,
): string | undefined {
  return tx ? (tx.tx as { debugActionId?: string }).debugActionId : undefined;
}

/**
 * Extract the pattern id from the result cell's link to the pattern.
 *
 * @param resultCell
 * @returns pattern id
 */
function getPatternId(resultCell: Cell<unknown>): URI | undefined {
  return getMetaLink(resultCell, "pattern")?.id;
}
