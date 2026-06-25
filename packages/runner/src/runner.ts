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
  isOpaqueRef,
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
import {
  isRawBuiltinResult,
  raw,
  type RawBuiltinReturnType,
} from "./module.ts";
import "./builtins/index.ts";
import { isCellScope, narrowestScope } from "./scope.ts";
import {
  describePatternOrModule,
  extractDefaultValues,
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
import { runInActionExecution } from "./builder/action-context.ts";
import { getVerifiedProvenance } from "./harness/verified-provenance.ts";
import { getArtifactEntryRef } from "./builder/pattern-metadata.ts";
import { diffAndUpdate } from "./data-updating.ts";
import { setResultCell } from "./result-utils.ts";
import { SigilLink } from "./sigil-types.ts";
import {
  argumentPathNeedsCellContext,
  type ExtractResult,
  extractRog,
  extractRogBaseDefer,
  hasArgumentWritebackMarker,
  type ImplRefResolver,
  outputInternalName,
  resolveLeafImpls,
  schemaNeedsCellContext,
} from "./reactive-interpreter/extract.ts";
import {
  evalRog,
  NotInterpretedHere,
} from "./reactive-interpreter/interpret.ts";
import { collectionInterpreter } from "./reactive-interpreter/collection-interpreter.ts";
import { buildElementEvaluator } from "./reactive-interpreter/element-evaluator.ts";
import type { Op, OpId, Rog, ValueRef } from "./reactive-interpreter/rog.ts";
import { partition } from "./reactive-interpreter/partition.ts";
import { internSchema } from "@commonfabric/data-model/schema-hash";
export {
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
};

// Options shared by run()/startWithTx()/startAfterSuccessfulCommit().
type RunnerRunOptions = {
  doNotUpdateOnPatternChange?: boolean;
  // Resumed-from-synced-state: hold each action's initial rehydration/run until
  // the space has finished syncing, so consumers don't race the data.
  awaitSyncBeforeInitialRun?: boolean;
  // The pattern is a LAUNCHED CHILD (handler `this.run` receipt / navigateTo
  // target / build-time `instantiatePatternNode`): the reactive interpreter must
  // fall back to legacy for it (its result cell is consumed by a launcher
  // contract the collapsed `$ri-result` alias does not preserve). Only consulted
  // when the experimental interpreter flag is on; otherwise inert.
  launchedChild?: boolean;
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

/** Reason a pattern fell back from the interpreter to the legacy path. */
export type InterpreterFallbackReason =
  | "ineligible_opkind"
  | "unrecognized_alias"
  | "unresolved_leaf"
  | "eval_threw"
  // A collection op (map) carried a `scope` alias in its list input or element
  // graph. The first-cut collection interpreter is unscoped-only, so any scope
  // falls back. Distinct from `ineligible_opkind` so the oracle's negative axis
  // can assert scoped collections fall back for THIS reason.
  | "scoped"
  // Cross-space / scope routing: the pattern node carries `module.targetSpace`
  // (`.inSpace(...)`) or a non-default `module.defaultScope` (`.asScope(...)`).
  // Cross-space child materialization / scoped child result cells are real
  // reactive child instantiation outside the pure-compute subset → legacy.
  | "cross_space"
  // A node's OUTPUT aliases the ARGUMENT cell — a write-BACK side effect the
  // synthetic node cannot emit (see extract.ts ARGUMENT_WRITEBACK_MARKER).
  | "argument_writeback"
  // The pattern is a LAUNCHED CHILD (handler `this.run` receipt / navigateTo
  // target / build-time `instantiatePatternNode`) whose result cell is consumed
  // by a launcher contract (firstResolvedOutputRedirect / receipt / navigable
  // link) the single `$ri-result` alias does not preserve → legacy.
  | "launched_child";

/** Census of reactive-interpreter dispatch outcomes (see Runner field). */
export interface InterpreterCensus {
  interpreted_ok: number;
  fallback_by_reason: Record<InterpreterFallbackReason, number>;
}

/** True iff `m` is an inline Pattern (carries a `nodes` array) — the in-memory
 * element-pattern shape the collection interpreter consumes (vs a serialized
 * `$patternRef`). */
function isPatternLike(m: unknown): m is { nodes: unknown[] } {
  return !!m && typeof m === "object" &&
    Array.isArray((m as { nodes?: unknown }).nodes);
}

/** Deep scan an evaluated value tree (the dry-run result / per-op values) for a
 * LIVE REACTIVE HANDLE the synthetic interpreter node cannot faithfully emit: a
 * Pattern instantiation, a Cell/OpaqueRef, or a Promise (async leaf). A lift that
 * returns ONE such value is caught by the scalar gates; one that returns an
 * ARRAY or OBJECT *of* such values (e.g. `entries.map(() => childPattern(...))`,
 * the launched-child-via-lift shape) is NOT — the handle hides one level down.
 * Recurse through arrays and plain objects so the gate defers those too (legacy
 * does the real reactive child instantiation; the interpreter would inline the
 * raw handle and materialize `undefined`). Stops descending at a recognized
 * handle (it is the reject signal — no need to look inside it) and never recurses
 * into a non-plain value, so it cannot loop on a Cell's internal graph. */
function containsReactiveHandle(value: unknown, depth = 0): boolean {
  if (value === null || typeof value !== "object") {
    // A thenable can be a function or an object; check both at the leaf.
    return typeof (value as { then?: unknown } | null | undefined)?.then ===
      "function";
  }
  const obj = value as Record<string, unknown>;
  if (
    isPattern(value) || isCell(value) || isOpaqueRef(value) ||
    typeof obj.then === "function"
  ) {
    return true;
  }
  // Bound the recursion: evaluated value trees are shallow (result shapes), and a
  // deep guard keeps a pathological structure from blowing the stack.
  if (depth > 8) return false;
  if (Array.isArray(value)) {
    return (value as unknown[]).some((el) =>
      containsReactiveHandle(el, depth + 1)
    );
  }
  // Only recurse into PLAIN objects (own enumerable values). A class instance
  // that slipped the handle checks above is treated as opaque (not descended).
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const el of Object.values(obj)) {
    if (containsReactiveHandle(el, depth + 1)) return true;
  }
  return false;
}

/** Recursively scan a serialized value tree for ANY `scope` key carrying a
 * NON-DEFAULT value (anything other than `"space"` / `"inherit"`), whether it
 * sits on an alias payload (`$alias.scope`) or on an embedded schema
 * (`$alias.schema.scope`, where a PerUser/PerSession argument records its
 * narrowing). The fresh builder attaches the DEFAULT `scope: "space"` (the
 * ambient frame) to ordinary aliases, which the interpreter resolves correctly;
 * a `scope: "user" | "session"` narrowing ANYWHERE in the list-input / element
 * graph is the unmodeled indirection the unscoped-only first cut rejects. (An
 * earlier, alias-only check let a user-scoped list — whose narrowing lives on
 * `$alias.schema.scope`, not `$alias.scope` — SLIP THROUGH and interpret to an
 * empty result, a real mis-eval; this scans schemas too.) */
function hasNonDefaultScope(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((v) => hasNonDefaultScope(v));
  const obj = value as Record<string, unknown>;
  const scope = obj.scope;
  if (typeof scope === "string" && scope !== "space" && scope !== "inherit") {
    return true;
  }
  for (const v of Object.values(obj)) {
    if (hasNonDefaultScope(v)) return true;
  }
  return false;
}

/** Enumerate every {@link ValueRef} an op reads — flat `inputs` plus the
 * structural detail refs (collection `listInput`, pattern `argument`, control
 * `pred`/`branches`, construct template leaves). Used to find a segment's
 * argument reads in ANY op position (predicate, branch, list input, template
 * field), not just the flat `inputs`. PURE. */
function argRefsOfOpFull(op: Op): ValueRef[] {
  const refs: ValueRef[] = [...op.inputs];
  const d = op.detail;
  if (d.kind === "collection") refs.push(d.listInput);
  if (d.kind === "pattern") refs.push(d.argument);
  if (d.kind === "control") refs.push(d.pred, ...d.branches);
  if (d.kind === "construct") {
    refs.push(
      ...(d.template.shape === "object"
        ? Object.values(d.template.fields)
        : d.template.items),
    );
  }
  return refs;
}

/** A prefix-tree of the argument PATHS a segment reads (07 §4.8 per-segment read
 * narrowing). `whole` at a node means a segment reads that node ENTIRELY (a bare
 * `argument.option` with no further key) — its full sub-schema is kept; otherwise
 * only the `children` paths are kept. */
interface ArgPathTree {
  whole: boolean;
  children: Map<string, ArgPathTree>;
}

function newArgPathTree(): ArgPathTree {
  return { whole: false, children: new Map() };
}

/** Insert one argument read path into the tree. An EMPTY path marks the whole
 * argument read (the segment depends on everything → no narrowing). */
function insertArgPath(tree: ArgPathTree, path: readonly string[]): void {
  if (path.length === 0) {
    tree.whole = true;
    return;
  }
  let node = tree;
  for (const step of path) {
    if (node.whole) return; // an ancestor is read whole — finer paths subsumed
    let child = node.children.get(step);
    if (!child) node.children.set(step, child = newArgPathTree());
    node = child;
  }
  node.whole = true; // the terminal path component is read as a value
}

/** Project an argument JSON schema down to ONLY the paths in `tree` (07 §4.8
 * per-segment read narrowing). Reading the WHOLE argument schema makes a segment
 * re-run on (and deep-traverse) every field — for a wide sub-pattern that floods
 * the scheduler read-set and provokes stale-read conflicts on shared docs. This
 * builds a minimal schema covering only the property paths the segment's ops
 * actually navigate, so the segment's tracked read-set matches legacy's
 * fine-grained per-computed subscription. Each kept LEAF (a `whole` node) carries
 * its sub-schema VERBATIM (so `asCell`/`asStream` annotations + nested defaults
 * survive); an intermediate object node is rebuilt with only its read children.
 * A non-object schema, or a path that cannot be followed structurally (an open
 * record / array / combinator), keeps the sub-schema verbatim (sound: cannot
 * narrow further). PURE — read-only projection. */
function narrowArgumentSchemaByTree(
  schema: JSONSchema | undefined,
  tree: ArgPathTree,
): JSONSchema {
  if (tree.whole) return (schema ?? true) as JSONSchema;
  if (
    !schema || typeof schema !== "object" || Array.isArray(schema) ||
    tree.children.size === 0
  ) {
    return (schema ?? true) as JSONSchema;
  }
  const obj = schema as Record<string, unknown>;
  const props = obj.properties as Record<string, unknown> | undefined;
  // Only an OBJECT schema with declared properties can be narrowed by key. Any
  // other shape (open record, array index, combinator) keeps the full sub-schema
  // for the read children (cannot prove a tighter projection structurally).
  if (!props || typeof props !== "object") return schema;
  const narrowedProps: Record<string, unknown> = {};
  const keptKeys = new Set<string>();
  for (const [key, childTree] of tree.children) {
    if (Object.hasOwn(props, key)) {
      narrowedProps[key] = narrowArgumentSchemaByTree(
        props[key] as JSONSchema,
        childTree,
      );
      keptKeys.add(key);
    }
  }
  const out: Record<string, unknown> = {
    type: "object",
    properties: narrowedProps,
  };
  if (Array.isArray(obj.required)) {
    const req = (obj.required as string[]).filter((k) => keptKeys.has(k));
    if (req.length > 0) out.required = req;
  }
  return internSchema(out) as JSONSchema;
}

/** True iff ANY node in the pattern carries cross-space / non-default-scope
 * routing on its module: `module.targetSpace` (`.inSpace(...)` DID / named / cell
 * / anonymous routing) or `module.defaultScope` not in {undefined, "space"}
 * (`.asScope("user"|"session")`). Such a node mints its child result cell in
 * another space or at a narrower scope — real reactive child materialization the
 * inlining interpreter does not perform — so the whole pattern falls back to
 * legacy. The extractor drops `targetSpace`/`defaultScope` entirely, so this is
 * read directly off the raw module objects, not the ROG. */
function patternHasCrossSpaceOrScopeRouting(pattern: Pattern): boolean {
  for (const node of pattern.nodes ?? []) {
    const module = node.module as
      | { targetSpace?: unknown; defaultScope?: unknown }
      | undefined;
    if (!module) continue;
    if (module.targetSpace !== undefined) return true;
    const ds = module.defaultScope;
    if (ds !== undefined && ds !== "space" && ds !== "inherit") return true;
  }
  return false;
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

  /**
   * Reactive-interpreter dispatch census (only mutated when the
   * `experimentalInterpreter` flag is on). Tallies how the corpus actually maps:
   * `interpreted_ok` counts patterns instantiated through the interpreter, and
   * each `fallback_by_reason` bucket counts the precise reason a pattern fell
   * back to the legacy path. A flag-on suite run reveals real coverage. Cheap
   * and off-path when the flag is off (the dispatch branch is never entered).
   */
  private readonly interpreterCensus: InterpreterCensus = {
    interpreted_ok: 0,
    fallback_by_reason: {
      ineligible_opkind: 0,
      unrecognized_alias: 0,
      unresolved_leaf: 0,
      eval_threw: 0,
      scoped: 0,
      cross_space: 0,
      argument_writeback: 0,
      launched_child: 0,
    },
  };

  /**
   * PROBE MEMO ACROSS INSTANTIATIONS (D-PROBE-MEMOIZE). The eligibility dry-run
   * executes user leaf bodies once; the closure-local memo (in
   * `buildInterpreterPattern`) reuses that for the FIRST real run of THAT
   * instance. But a pattern can be RE-INSTANTIATED (stop→start, reload, pattern
   * watcher) — a fresh `buildInterpreterPattern` would re-probe and re-execute the
   * leaf bodies a second time, doubling user-observable run counts even though the
   * action is then rehydrated clean and never re-runs (the "uses persisted
   * observations when a runner restarts a clean piece" failure). We therefore
   * cache the probe's per-op values keyed on the LIVE pattern object (a WeakMap,
   * so it never retains a pattern past its session) and reuse them when the
   * argument snapshot is unchanged — so a side-effecting leaf executes exactly
   * ONCE across the whole pattern lifetime, mirroring legacy. Cleared on dispose
   * with the runner. A miss (different pattern object / changed argument) re-probes
   * fresh, so this never serves stale values. */
  private readonly interpreterProbeMemo = new WeakMap<
    Pattern,
    { argument: unknown; dry: ReturnType<typeof evalRog> }
  >();

  /** Read-only snapshot of the reactive-interpreter dispatch census. */
  getInterpreterCensus(): InterpreterCensus {
    return {
      interpreted_ok: this.interpreterCensus.interpreted_ok,
      fallback_by_reason: { ...this.interpreterCensus.fallback_by_reason },
    };
  }

  constructor(readonly runtime: Runtime) {
    this.runtime.storageManager.subscribe(this.createStorageSubscription());
    // Reactive-interpreter collection dispatch: register the `map` collection
    // interpreter builtin ONLY when the experimental flag is on. Flag-off ⇒ the
    // ref is never registered, so the collection branch can never resolve it and
    // behavior is byte-unchanged.
    if (this.runtime.experimental.experimentalInterpreter) {
      this.runtime.moduleRegistry.addModuleByRef(
        "$ri-collection-map",
        raw(collectionInterpreter("map")) as unknown as Module,
      );
    }
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
      } else {
        manifest.push(existingManifest[manifestMatch]);
      }

      const currentValue = derivedCell.getRawUntyped({
        meta: ignoreReadForScheduling,
      });
      const schemaDefault = isRecord(descriptor.schema)
        ? descriptor.schema.default as JSONValue | undefined
        : undefined;
      if (currentValue === undefined && schemaDefault !== undefined) {
        if (manifestMatch !== -1) {
          // The manifest already references this cell (a previous run
          // materialized it), yet it reads undefined here — on a cold cache
          // this usually means the doc just isn't loaded, and writing the
          // default would clobber persisted state (CT-1666 class of bug).
          logger.warn("internal-default-over-manifest", () => [
            `materializeDerivedInternalCells: applying schema default over`,
            `undefined for existing manifest entry`,
            `partialCause=${JSON.stringify(descriptor.partialCause)}`,
            `cell=${derivedCell.getAsNormalizedFullLink().id}`,
            `result=${resultCell.getAsNormalizedFullLink().id}`,
          ]);
        }
        derivedCell.setRawUntyped(fabricFromNativeValue(schemaDefault));
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
      // Launched-child signal (see RunnerRunOptions.launchedChild): forces the
      // reactive interpreter to fall back to legacy for this pattern.
      launchedChild?: boolean;
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
      // Reactive-interpreter dispatch (default OFF). When the flag is off this
      // branch is never entered, so there is ZERO behavior change. When on, an
      // *eligible* pattern is rewritten to a single interpreter node and then
      // instantiated through the SAME legacy node loop below (so it inherits all
      // binding / scheduling / reactivity machinery). The rewrite (probe) is
      // PURE: it never writes to a tx, so on `NotInterpretedHere` we simply use
      // the original pattern and fall through with no side effect — the hard
      // no-partial-materialize invariant.
      let effectivePattern = pattern;
      let viaInterpreter = false;
      if (this.runtime.experimental.experimentalInterpreter) {
        try {
          effectivePattern = this.buildInterpreterPattern(
            pattern,
            resultCell,
            options.launchedChild === true,
            useTx,
          );
          viaInterpreter = true;
        } catch (e) {
          if (!(e instanceof NotInterpretedHere)) throw e;
          effectivePattern = pattern; // legacy fallback, nothing materialized
        }
      }

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
        // The synthetic interpreter pattern PRESERVES the original pattern's
        // result tree + derivedInternalCells (faithful emission), so this
        // re-materialize + re-project is identical to what `applySetupState`
        // already did for the run()/setup path (idempotent). It is still
        // load-bearing for the pattern-WATCHER path: a pattern change routes
        // through here WITHOUT re-running setup, so the new pattern's result tree
        // / internal manifest must be re-materialized + re-projected onto the
        // result cell, inside the same tx, before wiring the interpreter node.
        // This is the only interpreter write and it happens after the pure probe
        // in `buildInterpreterPattern` has already succeeded.
        if (viaInterpreter) {
          const baseCell = resultCell.withTx(actualTx);
          const previousInternal = baseCell.getMetaRaw("internal", {
            meta: ignoreReadForScheduling,
          });
          const internalManifest = this.materializeDerivedInternalCells(
            actualTx,
            effectivePattern,
            baseCell,
            previousInternal,
          );
          baseCell.setMetaRaw("internal", internalManifest);
          this.updateResultProjection(actualTx, effectivePattern, baseCell, {
            preserveName: true,
          });
        }
        for (const node of effectivePattern.nodes) {
          const baseCell = resultCell.withTx(actualTx);
          this.instantiateNode(
            actualTx,
            node.module,
            node.inputs,
            node.outputs,
            baseCell,
            addNodeCancel,
            effectivePattern,
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
      return Promise.resolve(rootCell.sync()).then(() => {
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
      launchedChild: options.launchedChild,
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
        // Launched child (navigateTo / handler-result deferred pattern): its
        // result cell is consumed by a launcher contract the interpreter's
        // collapsed result alias does not preserve → force legacy.
        this.run(startTx, pattern, inputs, committedResultCell, {
          launchedChild: true,
        });
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
    if (!getPersistentSchedulerStateConfig()) {
      return {};
    }
    const { space, id, scope } = resultCell.getAsNormalizedFullLink();
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

  /**
   * Resolve a serialized leaf's `$implRef` to a live callable, backed by the
   * runtime's verified-implementation index. Used by `resolveLeafImpls` when a
   * leaf's `module.implementation` is no longer a live function (a graph read
   * back from a cell keeps only its content-addressed ref). Mirrors
   * `resolveByImplRef`'s harness fallback, normalized to a plain function.
   */
  private readonly interpreterImplRefResolver: ImplRefResolver = (
    identity,
    symbol,
  ) => {
    const artifact = this.runtime.patternManager.artifactFromIdentitySync(
      identity,
      symbol,
    );
    const fromArtifact = artifact &&
        typeof (artifact as { implementation?: unknown }).implementation ===
          "function"
      ? (artifact as { implementation: (input: unknown) => unknown })
        .implementation
      : typeof artifact === "function"
      ? (artifact as (input: unknown) => unknown)
      : undefined;
    if (fromArtifact) return fromArtifact;
    const verified = this.runtime.harness.getVerifiedImplementation?.(
      identity,
      symbol,
    );
    return typeof verified === "function"
      ? (verified as (input: unknown) => unknown)
      : undefined;
  };

  /**
   * SECURITY trust gate for a LIVE leaf impl, passed to `resolveLeafImpls`. An
   * untrusted in-memory callback must NOT run as a raw host closure inside the
   * interpreter — it would bypass the SES sandbox legacy routes it through
   * (`getFallbackJavaScriptImplementation`, recompiled from `fn.toString()` so
   * captured closures are stripped and `Proxy` is absent). Mirrors the
   * `liveTrusted` test in `resolveJavaScriptFunction`: a live function is trusted
   * iff it carries verified module-eval provenance, OR it has an entry ref THIS
   * runtime's harness resolves back to the same function. An untrusted leaf is
   * reported as unresolved → `unresolved_leaf` fallback → legacy SES path.
   */
  private readonly interpreterLiveLeafTrustCheck = (
    impl: (input: unknown) => unknown,
  ): boolean => {
    if (getVerifiedProvenance(impl) !== undefined) return true;
    const entryRef = getArtifactEntryRef(impl);
    return entryRef !== undefined &&
      this.runtime.harness.getVerifiedImplementation?.(
          entryRef.identity,
          entryRef.symbol,
        ) === impl;
  };

  /**
   * Reactive-interpreter eligibility probe + rewrite (PURE — no tx writes).
   *
   * Extracts the pattern to a ROG, checks it is fully covered and uses only the
   * non-collection vocabulary this step interprets ({leaf, access, construct,
   * control}), resolves every leaf impl, and DRY-RUNS `evalRog` on a snapshot of
   * the current argument. If any check fails it bumps the census and throws
   * `NotInterpretedHere` so the caller falls back to the legacy path with NO
   * side effect (the hard no-partial-materialize invariant: nothing here writes
   * to a tx — the only interpreter write happens in the caller, after this
   * returns successfully).
   *
   * On success it returns a synthetic single-node Pattern: one `raw` interpreter
   * node (argument → ROG eval → result) writing into one `$ri-result` derived
   * cell, with the result aliased to it. Instantiated through the same legacy
   * node loop, so it inherits reactivity (the argument read is tracked, so the
   * node re-runs on input change) and result materialization for free.
   */
  private buildInterpreterPattern(
    pattern: Pattern,
    resultCell: Cell<any>,
    /** True when this pattern is being instantiated as a LAUNCHED CHILD (handler
     * `this.run` receipt / navigateTo target / build-time `instantiatePatternNode`).
     * Its result cell is consumed by a launcher contract (firstResolvedOutput
     * Redirect / receipt / navigable link) the single `$ri-result` alias does not
     * preserve, so always fall back to legacy. */
    launchedChild = false,
    /** The in-flight setup transaction, if the caller has one. The argument is
     * written into this tx during setup and is NOT yet visible to a tx-less read,
     * so the collection scope probe reads the RAW argument THROUGH this tx to see
     * per-element link scopes. Read-only — the probe never writes. */
    setupTx?: IExtendedStorageTransaction,
  ): Pattern {
    const riLabel = (): string => {
      const t = (s: JSONSchema | undefined) =>
        (s as { title?: string } | undefined)?.title;
      return t(pattern.resultSchema) ?? t(pattern.argumentSchema) ??
        `nodes=${pattern.nodes?.length ?? 0}`;
    };
    const RI_DISPATCH_DEBUG = Deno.env.get("RI_DISPATCH_DEBUG") === "1";
    const bumpAndThrow = (reason: InterpreterFallbackReason): never => {
      this.interpreterCensus.fallback_by_reason[reason]++;
      if (RI_DISPATCH_DEBUG) {
        console.error(`RI_DISPATCH fallback ${reason} [${riLabel()}]`);
      }
      throw new NotInterpretedHere(reason);
    };

    // --- 0. LAUNCHED-CHILD gate (cluster: launched child result-cell contract).
    // A handler-launched / navigateTo-target / build-time child pattern's result
    // cell is consumed by a launcher contract (receipt resolution, navigateTo
    // dereference, firstResolvedOutputRedirect) that the collapsed single
    // `$ri-result` alias does not honor. Always fall back. Sound (legacy green).
    if (launchedChild) bumpAndThrow("launched_child");

    // --- 0b. CROSS-SPACE / SCOPE ROUTING gate (cluster: .inSpace / .asScope /
    // module.targetSpace / module.defaultScope). A child pattern node routed to
    // another space (`module.targetSpace`) or carrying a non-default
    // `module.defaultScope` (`.asScope("user"|"session")`) is real reactive
    // cross-space / scoped child materialization the inlining synthetic node
    // cannot reproduce — it would inline the child into a `$ri-result` cell in
    // the PARENT space at the default scope. Scan every node (build-time pattern
    // nodes AND handler-result inSpace patterns route through this method). Always
    // sound (legacy routes through instantiatePatternNode / replicatePatternToSpace).
    if (patternHasCrossSpaceOrScopeRouting(pattern)) {
      bumpAndThrow("cross_space");
    }

    // --- 1. Extract + coverage (pure structural classification) ------------
    const extracted: ExtractResult = extractRog(
      pattern as unknown as Parameters<typeof extractRog>[0],
    );
    // --- 1b. COLLECTION branch (single top-level `map`) --------------------
    // Placed BEFORE the unrecognizedAliases check because `extractRog` recurses
    // into the inline element pattern sharing ONE `unrecognized` set, and the
    // element's serialized aliases legitimately carry `defer:1` (nested-pattern
    // serialization) — which pollutes the OUTER report. For a collection, the
    // element internals are NOT the outer interpreter's concern: they are
    // validated independently by `buildElementEvaluator` (which re-extracts the
    // element pattern fresh, at depth 0, where its aliases are clean). So the
    // collection probe validates only the OUTER surfaces (list-input alias +
    // result shape) and must run before the element-internal `defer` aliases
    // would (spuriously) trip the scalar `unrecognized_alias` gate.
    //
    // The probe is PURE — no tx writes — and on a matching, fully-resolvable
    // single `map` it returns a synthetic node dispatching to the registered
    // `$ri-collection-map` builtin. On ANY miss it either returns null (when
    // there is no collection op at all → fall through to the scalar gates
    // unchanged) or fails closed via `bumpAndThrow` (when there IS a collection
    // op but it is not the eligible single-map shape).
    const collectionPattern = this.tryBuildCollectionInterpreterPattern(
      pattern,
      extracted,
      bumpAndThrow,
      resultCell,
      setupTx,
    );
    if (collectionPattern) {
      this.interpreterCensus.interpreted_ok++;
      if (RI_DISPATCH_DEBUG) {
        console.error(`RI_DISPATCH ok collection [${riLabel()}]`);
      }
      return collectionPattern;
    }

    // §4.7: a nested sub-pattern whose CLOSURE carries a boundary (collection /
    // effect / deeper nest) is kept as a VERBATIM `pattern` boundary by the
    // partition and the child re-dispatches independently (see the PATTERN gate
    // below). When that is the shape, a NESTED-frame unrecognized alias is NOT the
    // outer pattern's concern — it is validated when the child re-dispatches. A
    // PURE nested closure, by contrast, is INLINED into a segment, so a nested-
    // frame unrecognized alias there WOULD be silently mis-evaluated and MUST
    // still fall back. So relax to the TOP-FRAME report ONLY for the partitioned
    // (boundary-closure) shape; otherwise use the full whole-recursion report.
    const byKindForUa = extracted.coverage.byKind;
    const nestedClosureHasBoundaryForUa = (byKindForUa.pattern ?? 0) > 0 &&
      ((byKindForUa.collection ?? 0) > 0 || (byKindForUa.effect ?? 0) > 0 ||
        (byKindForUa.pattern ?? 0) > 1 || extracted.coverage.nested > 1);
    // Scalar path: the element-internal defer pollution does not apply (there is
    // no collection op), so a non-empty unrecognized report is a real outer
    // alias problem → fall back. The dedicated argument-writeback marker maps to
    // its own `argument_writeback` reason (a node whose output aliases the
    // argument cell — a write-back side effect the synthetic node cannot emit).
    const uaForGate = this.runtime.experimental.experimentalInterpreter &&
        nestedClosureHasBoundaryForUa
      ? extracted.coverage.topFrameUnrecognizedAliases
      : extracted.coverage.unrecognizedAliases;
    if (uaForGate.length > 0) {
      bumpAndThrow(
        hasArgumentWritebackMarker(uaForGate)
          ? "argument_writeback"
          : "unrecognized_alias",
      );
    }

    // Set when the nested-pattern closure carries a boundary so the single-node
    // INLINE path declines cleanly (the partition handles it under recursion);
    // see the §4.7 recursion comment in the PATTERN gate below.
    let nestedInlineIneligible = false;
    // --- PATTERN gate (mirror the collection gate; MUTUALLY LOAD-BEARING with
    // the extraction recursion, R1). A top-level INLINED nested pattern (the
    // `pattern` op) is now eligible — BUT only when it is a PURE computation
    // (its sub-ROG is leaf/access/construct/control only), in-memory, top-level,
    // and unscoped. The coverage counters (`byKind`/`nested`) account for the
    // recursed-into sub-graph that `rog.ops` is BLIND to (each `build` returns a
    // fresh ops[] the recursion discards from the parent ops list). A gate on
    // `rog.ops` alone would silently MIS-EVALUATE a nested pattern whose sub-ROG
    // contains a collection/effect/deeper-nest — so we gate on the COVERAGE.
    if ((extracted.coverage.byKind.pattern ?? 0) > 0) {
      const byKind = extracted.coverage.byKind;
      // §4.7 NESTED-PATTERN RECURSION. A top-level inlined nested `pattern` op
      // whose CLOSURE contains a boundary (a `collection` / `effect` / a deeper
      // nested pattern) is NOT eligible for the single-node INLINE path (that path
      // inlines the whole sub-ROG into one segment, which only models a PURE
      // closure). But it IS a valid PARTITION case: the `pattern` op is kept as a
      // VERBATIM legacy boundary node, and the inlined CHILD pattern re-dispatches
      // through `buildInterpreterPattern` at runtime (instantiatePatternNode →
      // this.run → instantiatePattern → buildInterpreterPattern), so the child's
      // OWN pure regions / collections / nested patterns interpret RECURSIVELY at
      // the runtime level — the sound §4.7 recursion mechanism (07 §4.7; the
      // per-element CHILD re-dispatch, NOT a bespoke per-element `b.inner` emit).
      // The surrounding pure region of THIS pattern (the result projection, any
      // sibling computeds) interprets as segments. So instead of bumping
      // `ineligible_opkind` for a collection/effect/deeper-nest closure, FALL
      // THROUGH to the partition path below (gated to the experimental flag — the
      // partition path is the interpreter; flag-off never reaches here). The
      // partition keeps the `pattern` op as a boundary (allowed in
      // `tryBuildPartitionedInterpreterPattern`); if it cannot find a pure region
      // to interpret it returns null and the downstream gates supply the
      // fail-closed reason, so the verdict is deferred, never lost.
      const recurseNested = this.runtime.experimental.experimentalInterpreter;
      // The nested-pattern closure carries a boundary (collection / effect / a
      // DEEPER nested pattern): the single-node INLINE path cannot model it (it
      // would inline a collection/effect into one segment, which `evalRog` cannot
      // evaluate — it throws / records errors → `eval_threw`). Whether or not we
      // recurse, the single-node inline path must DECLINE such a closure. Under
      // recursion we DEFER it to the partition (which keeps the `pattern` op as a
      // verbatim boundary + re-dispatches the child); without recursion we fall
      // back to legacy right here. This flag (consumed by the single-node gate
      // below) keeps the inline dry-run from ever seeing a non-inlinable closure.
      const nestedClosureHasBoundary = (byKind.collection ?? 0) > 0 ||
        (byKind.effect ?? 0) > 0 || (byKind.pattern ?? 0) > 1 ||
        extracted.coverage.nested > 1;
      if (!recurseNested) {
        // Sub-ROG must be PURE: no collection / effect anywhere in the closure.
        if ((byKind.collection ?? 0) > 0) bumpAndThrow("ineligible_opkind");
        if ((byKind.effect ?? 0) > 0) bumpAndThrow("ineligible_opkind");
        // Exactly the single OUTER pattern op — >1 means a DEEPER nest (a nested
        // pattern inside the nested pattern) which this first cut does not model.
        if ((byKind.pattern ?? 0) > 1) bumpAndThrow("ineligible_opkind");
        // The extractor recurses into the inline sub-pattern exactly once; >1 is a
        // deeper / multiple nested graph beyond the single top-level inline.
        if (extracted.coverage.nested > 1) bumpAndThrow("ineligible_opkind");
      }
      nestedInlineIneligible = nestedClosureHasBoundary;
      // A serialized $patternRef element (no in-memory `.nodes`) is recorded as
      // an unrecognized alias / leaves `inlined` undefined; either way it falls
      // back. Unrecognized aliases anywhere → fall back. (Kept under recursion: a
      // truly unrecognized alias is never partitionable — fail closed.)
      if (extracted.coverage.unrecognizedAliases.length > 0) {
        bumpAndThrow("unrecognized_alias");
      }
      // Any non-default (PerUser/PerSession) scope in the pattern node's bound
      // argument or the sub-pattern graph → out of scope for this cut.
      const patternNode = (pattern.nodes ?? []).find((n) =>
        (n.module as { type?: string } | undefined)?.type === "pattern"
      );
      if (patternNode && hasNonDefaultScope(patternNode.inputs)) {
        bumpAndThrow("scoped");
      }
      if (
        patternNode &&
        hasNonDefaultScope(
          (patternNode.module as { implementation?: unknown } | undefined)
            ?.implementation,
        )
      ) {
        bumpAndThrow("scoped");
      }
    }

    // --- COALESCING SPIKE: partition into segment + boundary nodes ----------
    // The upstream gates above (launched-child, cross-space, collection,
    // unrecognized-alias, pattern-coverage) have already run, so their cases fall
    // back exactly as today. We attempt the partition HERE — BEFORE the
    // single-node ELIGIBLE_KINDS path below, which rejects any `effect` op
    // outright (the all-or-nothing gate the spike is wired to bypass). The
    // partition keeps a pattern's PURE regions as interpreted segments while its
    // handlers/effects stay as legacy boundary nodes. It is gated to effect-only,
    // no-fanout, no-bnd→bnd, no-write-back-cycle (see the helper); anything else
    // returns null → we fall through to the existing single-node logic unchanged.
    //
    // Leaf impls are resolved here so the partition can build its segment evals;
    // we reuse the resolved set on the single-node fall-through below (no
    // double-resolution). A non-empty unresolved set means a serialized/untrusted
    // leaf boundary → `unresolved_leaf` fallback, exactly as the single-node path.
    const { leafImpls, unresolvedLeafOps } = resolveLeafImpls(
      pattern as unknown as Parameters<typeof resolveLeafImpls>[0],
      extracted.rog,
      this.interpreterImplRefResolver,
      this.interpreterLiveLeafTrustCheck,
    );
    const unresolvedLeafSet = new Set<OpId>(unresolvedLeafOps);

    // A pattern has a partitionable BOUNDARY when it carries an `effect`
    // (handler / I/O builtin), a `collection` op (a `map`/`filter`/`flatMap`),
    // OR an UNRESOLVED leaf (a context-requiring lift — `asCell`/`asStream`
    // input, `Cell.for`, or a pattern-returning factory). In ALL three cases the
    // original legacy node is kept verbatim as a boundary while the pattern's
    // PURE regions interpret as segments. This is the lever that engages the
    // launched-child-via-lift / context-leaf clusters' PURE regions AND the
    // collection cluster: the array op / context-requiring / child-launching lift
    // stays a LEGACY node (it runs in the SES sandbox / iterates its element
    // render / launches its children exactly as today — sound), and only the
    // surrounding pure compute (str / scalar lifts / computed) is interpreted.
    // The single TOP-LEVEL pure `map` is already handled earlier by
    // `tryBuildCollectionInterpreterPattern` (which returns FIRST), so the
    // `hasCollectionOp` entry here only fires for a `map`/`filter`/`flatMap`
    // sitting ALONGSIDE other compute (or feeding a non-trivial result) — the
    // `ineligible_opkind` collection cluster. A fully-pure scalar pattern has no
    // boundary, so the simpler single-node path below handles it.
    const hasEffectOp = extracted.rog.ops.some((op) => op.kind === "effect");
    const hasCollectionOp = extracted.rog.ops.some((op) =>
      op.kind === "collection"
    );
    // §4.7: a top-level `pattern` op is a partition BOUNDARY too — kept verbatim
    // so the inlined child re-dispatches through the interpreter recursively. Only
    // the experimental flag reaches here (the partition path IS the interpreter),
    // so the flag-off legacy path is untouched.
    const hasPatternOp = extracted.rog.ops.some((op) => op.kind === "pattern");
    const hasUnresolvedLeafBoundary = unresolvedLeafSet.size > 0;
    if (
      hasEffectOp || hasUnresolvedLeafBoundary || hasCollectionOp ||
      hasPatternOp
    ) {
      const internedArgForPartition = internSchema(
        (pattern.argumentSchema ?? {}) as JSONSchema,
      );
      const partitioned = this.tryBuildPartitionedInterpreterPattern(
        pattern,
        extracted,
        leafImpls,
        extracted.internalToOp,
        bumpAndThrow,
        resultCell,
        internedArgForPartition,
        unresolvedLeafSet,
        setupTx,
      );
      if (partitioned) {
        this.interpreterCensus.interpreted_ok++;
        if (RI_DISPATCH_DEBUG) {
          console.error(`RI_DISPATCH ok partition [${riLabel()}]`);
        }
        return partitioned;
      }
    }

    // §4.7: the nested-pattern closure carries a boundary (collection / effect /
    // deeper nest) so the single-node INLINE path cannot model it (it would inline
    // a non-pure closure into one segment — `evalRog` throws / records errors →
    // `eval_threw`). The partition above already had its chance (and declined, or
    // there was no separable pure region around the `pattern` op). Fall back
    // CLEANLY with the same `ineligible_opkind` reason the pre-recursion coverage
    // gate used, so the single-node dry-run never sees a non-inlinable closure.
    if (nestedInlineIneligible) bumpAndThrow("ineligible_opkind");

    // The partition could not interpret a pure region around the unresolved
    // leaf (no usable segment, fan-out, a boundary→boundary read-through, etc.),
    // so the WHOLE pattern falls back to legacy exactly as before. A serialized /
    // untrusted leaf, or a context-requiring leaf with no separable pure region,
    // lands here. Sound (legacy is green).
    if (unresolvedLeafSet.size > 0) bumpAndThrow("unresolved_leaf");

    // This step interprets the non-collection vocabulary plus a TOP-LEVEL,
    // in-memory, PURE-computation INLINED nested pattern. `leaf` (opaque
    // sandboxed JS) plus the interpreted kinds access/construct/control are
    // eligible; an inlined `pattern` op is eligible AFTER passing the coverage
    // gate above (which guarantees its sub-ROG is pure and unscoped).
    // collection/effect remain out of scope → fall back. The result construct
    // synthesized by extraction (id < 0) is a `construct`, so it is eligible.
    const ELIGIBLE_KINDS = new Set([
      "leaf",
      "access",
      "construct",
      "control",
      "pattern",
    ]);
    for (const op of extracted.rog.ops) {
      if (!ELIGIBLE_KINDS.has(op.kind)) bumpAndThrow("ineligible_opkind");
      // A `pattern` op that did NOT inline (serialized $patternRef, no `.nodes`)
      // fails closed: the evaluator would throw NotInterpretedHere at eval time,
      // but we reject it up front for a precise reason so it never reaches the
      // dry-run probe. (Defense-in-depth; `inlined === undefined` ⇒ legacy.)
      if (
        op.kind === "pattern" && op.detail.kind === "pattern" &&
        !op.detail.inlined
      ) {
        bumpAndThrow("ineligible_opkind");
      }
    }

    // --- STRUCTURAL eligibility gates over the extracted ROG ----------------
    // These are read off the ROG topology (no body execution) and each ONLY
    // causes fallback (legacy is green), so they are always sound.
    {
      // Enumerate every ValueRef an op reads (flat inputs + structural detail
      // refs + construct-template leaves), and the result ref.
      const refsOfOp = (op: Op): ValueRef[] => {
        const refs: ValueRef[] = [...op.inputs];
        const d = op.detail;
        if (d.kind === "collection") refs.push(d.listInput);
        if (d.kind === "pattern") refs.push(d.argument);
        if (d.kind === "control") refs.push(d.pred, ...d.branches);
        if (d.kind === "construct") {
          refs.push(
            ...(d.template.shape === "object"
              ? Object.values(d.template.fields)
              : d.template.items),
          );
        }
        return refs;
      };
      const allRefs: ValueRef[] = [extracted.rog.result];
      for (const op of extracted.rog.ops) allRefs.push(...refsOfOp(op));

      // GATE (dangling internal — cluster: raw Pattern with derivedInternalCells
      // defaults). An `internal` ref whose name is absent from `internalToOp` is
      // produced by NO node (a derivedInternalCells-only / dangling cell the
      // evaluator resolves to `undefined`, never consulting the declared default
      // — and legacy's raw-runner toJSON normalization never runs). Fall back.
      for (const ref of allRefs) {
        if (
          ref.kind === "internal" &&
          !extracted.internalToOp.has(ref.name)
        ) {
          bumpAndThrow("unrecognized_alias");
        }
      }

      // NOTE: we deliberately do NOT broadly fall back on any non-empty
      // `pattern.derivedInternalCells`. The AUTHORED result internal cell (e.g.
      // `{partialCause:"doubled"}` wired to a node output) is the NORMAL eligible
      // shape — falling it back would erase real interpreter coverage. The
      // toJSON-normalize cluster (a derivedInternalCells-only DANGLING cell
      // produced by no node) is already caught by the dangling-internal gate
      // above (its name is absent from `internalToOp`).

      // GATE (output-less / side-effect-only leaf — cluster: side-effect-only
      // leaves admitted). A leaf op whose output never flows into the result
      // closure (e.g. `() => { startCount++ }`) has no faithful single-eval
      // interpreter semantics: the probe would double-execute its side effect and
      // the emission carries nothing. Reject BEFORE any leaf body runs. Compute
      // the op ids reachable from the result via the ref graph; a leaf not in the
      // reachable set is output-less.
      const byId = new Map<OpId, Op>();
      for (const op of extracted.rog.ops) byId.set(op.id, op);
      const reachable = new Set<OpId>();
      const stack: ValueRef[] = [extracted.rog.result];
      while (stack.length > 0) {
        const ref = stack.pop()!;
        // Resolve a ref to a producing op id: `opOut` directly, or an `internal`
        // ref via `internalToOp` (the builder names a node's output internal cell
        // and the result references it by NAME, not as a positional `opOut`).
        let opId: OpId | undefined;
        if (ref.kind === "opOut") opId = ref.op;
        else if (ref.kind === "internal") {
          opId = extracted.internalToOp.get(ref.name);
        }
        if (opId === undefined || reachable.has(opId)) continue;
        reachable.add(opId);
        const producer = byId.get(opId);
        if (producer) stack.push(...refsOfOp(producer));
      }
      for (const op of extracted.rog.ops) {
        if (op.kind === "leaf" && !reachable.has(op.id)) {
          bumpAndThrow("ineligible_opkind");
        }
      }

      // GATE (static-construct-over-argument result — cluster: static-construct
      // read synchronously / as schema-lineage). A pattern with NO compute op
      // (no leaf/control/collection/pattern — only the extraction-synthesized
      // access/construct ops) re-shapes the argument into a static link tree.
      // Legacy materializes that tree SYNCHRONOUSLY at setup (a non-async read
      // resolves immediately and `.asSchema({asCell})` surfaces the argument's
      // schema lineage as a Cell); the interpreter's `$ri-result` value is only
      // produced when the synthetic node runs under the scheduler (async) and
      // navigates the argument to a plain value, dropping the alias→Cell lineage.
      // Fall back so legacy's synchronous static materialization is preserved.
      const hasComputeOp = extracted.rog.ops.some((op) =>
        op.kind === "leaf" || op.kind === "control" ||
        op.kind === "collection" || op.kind === "pattern"
      );
      if (!hasComputeOp) bumpAndThrow("ineligible_opkind");
    }

    // GATE (per-node input / result / element schema scope narrowing — cluster:
    // per-node input/schema scope narrowing dropped). For a pure-compute pattern
    // whose narrowing scope arrives via a user/session-scoped INPUT LINK
    // (per-node `inputs` binding) or a non-default `scope` in the argument /
    // result schema, legacy mints a space-scoped internal cell linking to a
    // narrower-scoped output cell (scope-policy narrowestCellScope/scopedCell).
    // The single-`$ri-result` emission produces an inlined value with no scoped
    // output-cell chain, so a downstream `.getRaw()` is not the expected scoped
    // link chain (parseLink/getCellFromLink throws or `.scope` is undefined).
    // Fall back whenever a non-default scope appears on any per-node input
    // binding or in the argument / result schema. Reuses the scoped-fallback
    // machinery; always sound (legacy is green).
    if (
      hasNonDefaultScope(pattern.argumentSchema) ||
      hasNonDefaultScope(pattern.resultSchema) ||
      (pattern.nodes ?? []).some((n) =>
        hasNonDefaultScope(n.inputs) ||
        // The narrowing can live on a NODE's own module schema — an opaque JS
        // action whose `resultSchema` (or `argumentSchema`) carries `scope`
        // participates in the effective output scope. Scan those too.
        hasNonDefaultScope(
          (n.module as { argumentSchema?: unknown } | undefined)
            ?.argumentSchema,
        ) ||
        hasNonDefaultScope(
          (n.module as { resultSchema?: unknown } | undefined)?.resultSchema,
        )
      )
    ) {
      bumpAndThrow("scoped");
    }
    // RUNTIME input-link scope (same cluster): the narrowing often arrives via the
    // bound argument DATA (a user/session-scoped input cell), not statically on a
    // schema or node binding. Inspect the RAW argument tree (links preserved,
    // through the in-flight setup tx so a not-yet-committed write is visible) for
    // any non-default scope and fall back. Targeted — fires ONLY when a scope is
    // actually present, so it does not over-reject unscoped patterns. Sound
    // (legacy mints the narrower-scoped output-cell chain the interpreter cannot).
    if (hasNonDefaultScope(this.readRawArgumentSnapshot(resultCell, setupTx))) {
      bumpAndThrow("scoped");
    }

    // NOTE: the context-requiring-lift gate (a leaf whose argument schema carries
    // `asCell`/`asStream` — it expects a live Cell/Stream handle and calls Cell
    // methods on its input, which the interpreter cannot supply) is applied inside
    // `resolveLeafImpls` below (it recurses into nested-pattern leaves too) and is
    // GATED on the trust check being supplied, so the partition probe's
    // trust-checkless `resolveLeafImpls` — which counts unresolved leaves as
    // boundaries — is unaffected. Complemented by the dry-run `dry.errors` net.

    // --- 2. Leaf impls already resolved above (hoisted for the coalescing
    // spike's partition attempt); reused here for the single-node path. The
    // `unresolved_leaf` fallback already fired above if any leaf was unresolved.
    const { rog, internalToOp } = extracted;

    // --- 3. Dry-run probe on a snapshot of the current argument ------------
    // Pure: reads the argument value WITHOUT a scheduling tx (untracked) and
    // never writes. Crucially we read TX-LESS (not through `setupTx`): reading
    // through the in-flight tx would make the dry-run exercise leaf bodies against
    // the REAL argument, which (a) double-executes side-effecting leaves and
    // breaks pull-laziness, and (b) makes a throwing leaf throw at probe time
    // (falling back patterns that should interpret with per-node error isolation).
    // The tx-less read yields `undefined` for a not-yet-committed argument, a
    // valid eligible-vocabulary probe input. If the evaluator throws, fall back.
    //
    // NOTE on the demand-gated / lazy handler-written result pattern cluster
    // (patterns-handlers): that pattern carries a handler node (classified
    // `effect` → `ineligible_opkind`) and its lazily-written result is a launched
    // child (handler `this.run` → `launched_child`), so it ALREADY falls back via
    // those gates. We deliberately do NOT gate on `argSnapshot === undefined`:
    // a legitimately eligible pure-compute pattern whose argument is not yet
    // materialized also reads `undefined`, and rejecting on that would wrongly
    // fall back real coverage (prod-wire / extract-interpret oracle patterns).
    // RE-INSTANTIATION REUSE (D-PROBE-MEMOIZE across instantiations). The probe
    // reads the argument TX-LESS so a not-yet-committed argument is `undefined`
    // and the undefined-argument run-gate SKIPS leaf bodies — this is what keeps a
    // lift lazy until pulled (the "should not run lifts until something pulls"
    // invariant) on the FIRST instantiation, where the argument lives only in the
    // in-flight setup tx. But on a RE-INSTANTIATION (stop→start, reload, pattern
    // watcher) the argument is already COMMITTED, so a tx-less read now returns the
    // materialized value and the probe would EXECUTE the leaf bodies a second time
    // — doubling user-observable run counts even though the rehydrated-clean action
    // never re-runs (the "uses persisted observations when a runner restarts a
    // clean piece" failure). The eligibility VERDICT is a property of the live
    // pattern object (structural gates already cover argument-dependent shapes like
    // conditional Pattern-returning lifts), so once a pattern has been probed we
    // REUSE that probe rather than re-running its leaf bodies. We carry the
    // probe's ORIGINAL argument snapshot through, so the closure memo's
    // `deepEqual` guard below still forces a FRESH evaluation in the first real run
    // whenever the actual (committed) argument differs from what the probe saw —
    // serving correct values, never stale ones. Keyed on the live Pattern object
    // (a WeakMap), so it never retains a pattern past its session.
    let argSnapshot: unknown;
    let dry: ReturnType<typeof evalRog> | undefined;
    const cachedProbe = this.interpreterProbeMemo.get(pattern);
    if (cachedProbe) {
      argSnapshot = cachedProbe.argument;
      dry = cachedProbe.dry;
    } else {
      argSnapshot = this.readArgumentSnapshot(resultCell);
      try {
        // PROBE MODE (probe:true): the eligibility dry-run reaches its verdict
        // STRUCTURALLY and never invokes a leaf body. This keeps the probe LAZY
        // even on a RE-INSTANTIATION whose argument is already committed (a
        // pattern-watcher re-instantiating a child pattern): a body-executing
        // probe would spuriously re-run a side-effecting lift (doubling
        // `runCount`), diverging from legacy which never runs a lift body during
        // instantiation. The body runs exactly once in the FIRST real node action
        // below. Structural gates (resolveLeafImpls' pattern/context detectors,
        // the launched-child / cross-space / scope gates) carry the verdict; the
        // first-real-run error/Promise/Cell nets backstop the value-shape cases.
        dry = evalRog(rog, {
          argument: argSnapshot,
          leafImpls,
          internalToOp,
          probe: true,
        });
      } catch {
        bumpAndThrow("eval_threw");
      }
      this.interpreterProbeMemo.set(pattern, {
        argument: argSnapshot,
        dry: dry!,
      });
    }
    // SAFETY NET (context-requiring lifts, run-gate divergences, etc.): the
    // per-op isolation in `evalRog` swallows a leaf's runtime TypeError into
    // `errors[]` and returns successfully, so a thrown probe alone does not catch
    // a leaf that called a Cell method (`.get()`/`.sample()`) on a plain value,
    // or any other leaf-body failure. Treat ANY recorded dry-run error as a
    // fallback signal — legacy faithfully models these (schema-aware Cell
    // materialization, per-node error reporting). Always sound: legacy is green.
    if (dry!.errors.length > 0) bumpAndThrow("eval_threw");
    // R6: an async leaf returns a Promise the interpreter cannot store (legacy
    // awaits async leaves) — fall back. R5: a `derive`/`lift` returning a Pattern
    // needs a real reactive child instantiation the interpreter does not do —
    // fall back. Both surface in this dry-run: an async lift returns a Promise on
    // every call, and a pattern-returning derive returns a Pattern. Conservative:
    // any Promise/Pattern anywhere in the evaluated values → fall back to legacy.
    const dryValues = [dry!.result, ...dry!.opValues.values()];
    const isThenable = (v: unknown): boolean =>
      typeof (v as { then?: unknown } | null | undefined)?.then === "function";
    if (dryValues.some(isThenable)) bumpAndThrow("eval_threw");
    if (dryValues.some(isPattern)) bumpAndThrow("ineligible_opkind");
    // GATE (pattern-returning / OpaqueRef-returning / Cell-valued lifts): a lift
    // whose body returns a pattern instantiation (a `CellImpl`) or another
    // lift/derive application (an `OpaqueRef` proxy) needs the real reactive
    // child instantiation legacy performs — the synthetic node would yield the
    // raw Cell/OpaqueRef into `$ri-result` and materialize `undefined`. The
    // `isPattern` guard above misses these (a `CellImpl`/`OpaqueRef` lacks the
    // argumentSchema+resultSchema+nodes shape). Broaden to any Cell or OpaqueRef
    // value anywhere in the evaluated set. Always sound (legacy is green).
    if (dryValues.some((v) => isCell(v) || isOpaqueRef(v))) {
      bumpAndThrow("ineligible_opkind");
    }
    // GATE (lift returning a CONTAINER of reactive handles, e.g.
    // `entries.map(() => childPattern(...))` — the launched-child-via-lift shape):
    // the scalar `isPattern`/`isCell`/`isOpaqueRef` guards above miss a handle
    // nested one level down inside an array/object. Deep-scan the evaluated values
    // so an array/object of Patterns/Cells/OpaqueRefs/Promises also falls back.
    // Always sound (legacy does the real reactive child instantiation).
    if (dryValues.some((v) => containsReactiveHandle(v))) {
      bumpAndThrow("ineligible_opkind");
    }
    // GATE (mid-handler lift whose result is a write-REDIRECT link consumed
    // cross-node, patterns-misc): a leaf output that is itself a write-redirect
    // link (legacy `$alias` or a sigil link with `overwrite:"redirect"`) is a
    // cross-node binding the synthetic node does not honor — fall back. Detect
    // the redirect-link result shape structurally on the evaluated values.
    if (dryValues.some((v) => isWriteRedirectLink(v))) {
      bumpAndThrow("ineligible_opkind");
    }

    // --- 4. Build the synthetic single-node interpreter pattern ------------
    const resultSchema = pattern.resultSchema ?? {};
    const argumentSchema = pattern.argumentSchema ?? {};
    const internedArg = internSchema(argumentSchema as JSONSchema);

    // FAITHFUL RESULT-TOPOLOGY EMISSION (D-EMISSION-SCOPE: conservative — only
    // PURE multi-output computes reach here; arg-cell write-backs / cross-space /
    // scope-narrowing already fell back via the gates above). The synthetic
    // pattern PRESERVES the ORIGINAL pattern's result tree and derivedInternal
    // cells unchanged — so top-level structural keys (e.g. [NAME]), pass-through
    // argument/internal aliases (which keep their bidirectional write-back), and
    // the authored internal-cell schema defaults all re-materialize through the
    // SAME setup projection / materialize path legacy uses. We replace ONLY the
    // N compute nodes with ONE synthetic raw node that evaluates the whole ROG and
    // writes each per-field output into its DECLARED internal cell (via the node's
    // own per-field `outputs` binding), rather than collapsing the whole tree into
    // a single `$ri-result` alias (which dropped NAME, per-field routing, and the
    // authored derivedInternalCells, and leaked the full resultSchema onto the
    // alias link). Because we route through `sendValueToBinding` with the original
    // per-field output aliases, the per-path CFC content-labels are preserved.

    // Build the synthetic node's `outputs` binding from the ORIGINAL nodes: each
    // node writes its value into an internal cell named by its output alias
    // (`outputInternalName`). We union those into one object keyed by internal
    // name, mapping each to the op that produces it. A node whose output is NOT a
    // recognizable internal alias has no faithful per-field emission — fall back
    // (defense-in-depth: argument-writeback / malformed outputs already fell back
    // via the coverage gates, so this is unreachable on a probe-passing pattern).
    const syntheticOutputs: Record<string, JSONValue> = {};
    const outputNameToOpId = new Map<string, OpId>();
    for (const node of pattern.nodes ?? []) {
      const outName = outputInternalName(node.outputs);
      if (outName === null) bumpAndThrow("unrecognized_alias");
      const opId = internalToOp.get(outName!);
      if (opId === undefined) bumpAndThrow("unrecognized_alias");
      // Two nodes targeting the same internal cell would race on one output slot
      // — not a faithful single-node emission. Fall back. (Builder output is 1:1.)
      if (Object.hasOwn(syntheticOutputs, outName!)) {
        bumpAndThrow("unrecognized_alias");
      }
      syntheticOutputs[outName!] = node.outputs as JSONValue;
      outputNameToOpId.set(outName!, opId!);
    }

    // Assemble the per-field send value from the ROG's per-op values: each
    // declared output internal cell `name` gets `opValues.get(producingOp)`,
    // keyed identically to `syntheticOutputs` so `sendValueToBinding` routes each
    // field to its cell. The result tree's static literals (NAME, pass-through
    // argument aliases) are NOT in this object — they are projected once and never
    // overwritten by the node (mirroring legacy, where the node writes only its
    // own output cell).
    const buildSendValue = (
      opValues: Map<OpId, unknown>,
    ): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [name, opId] of outputNameToOpId) {
        out[name] = opValues.get(opId);
      }
      return out;
    };

    // PROBE LAZINESS (D-PROBE-MEMOIZE, simplified). The eligibility dry-run above
    // runs in PROBE MODE (`probe:true`) and never invokes a leaf body — its
    // verdict is purely STRUCTURAL. So there is NO probe-side body execution to
    // dedup: the first real node action below simply evaluates the ROG fresh,
    // running each leaf body exactly ONCE. This is what keeps a side-effecting
    // lift lazy on a RE-INSTANTIATION (the pattern-watcher re-instantiating a
    // child pattern whose argument is already committed) — the earlier
    // body-executing probe spuriously re-ran such a lift (doubling `runCount`),
    // diverging from legacy which never runs a lift body during instantiation.
    // (Historically a closure-memo handed the probe's already-computed per-op
    // values to the first run to avoid a SECOND execution; with a lazy probe that
    // reuse is both unnecessary and unsound — the probe's leaf op values are all
    // `undefined` — so it is removed.)

    // Capture the ORIGINAL pattern + result cell for the per-pattern error frame
    // (the synthetic raw node otherwise runs without an `unsafe_binding` to the
    // result cell, so a throwing leaf's error carries no pieceId/patternId/space).
    const sourcePattern = pattern;
    const sourceResultCell = resultCell;

    const interpreterImpl = (
      inputsCell: Cell<unknown>,
      sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
      _addCancel: AddCancel,
      _cause: unknown,
      _parentCell: Cell<unknown>,
      runtime: Runtime,
      _outputBinding?: NormalizedFullLink,
    ): Action => {
      return (tx: IExtendedStorageTransaction) => {
        // Read the argument THROUGH the tx so the read is tracked: the node then
        // re-runs reactively whenever the argument changes (parity with legacy).
        const argument = inputsCell.asSchema(internedArg).withTx(tx).get();
        // Evaluate the ROG fresh (bodies run exactly once per node action). The
        // eligibility probe ran in PROBE MODE and skipped every leaf body, so
        // there is no prior execution to reuse and no double-execution risk.
        const { opValues, errors } = evalRog(rog, {
          argument,
          leafImpls,
          internalToOp,
        });
        // Route each per-field output value into its declared internal cell. The
        // node's `outputs` binding is the union of the original nodes' output
        // aliases; `sendValueToBinding` walks it in parallel with this value.
        sendResult(tx, buildSendValue(opValues));
        if (errors.length === 0) return;
        // The result is now written (a throwing leaf's field is `undefined`).
        // Fire scheduler.onError for each throwing leaf WITHOUT failing the node,
        // matching legacy's per-node error reporting (each legacy computed that
        // throws fires onError; here the ops were collapsed into one node). Wrap
        // the reporting in the pattern frame (unsafe_binding → result cell) so
        // handleSchedulerError can recover pieceId/patternId/space from the error
        // — the frameless raw node otherwise yields no metadata (R4 attached a
        // frame, but it lacked the result-cell binding the metadata extraction
        // dereferences). Mirrors `createPatternFrame` on the legacy javascript
        // path. The frame is used ONLY to recover error metadata (we pop it
        // immediately after reporting), so it needs no `cause` for id minting —
        // matching the `pushFrameFromCause(undefined, …)` builtin-frame pattern.
        const frame = this.createPatternFrame(
          undefined,
          sourcePattern,
          sourceResultCell,
          tx,
          false,
        );
        try {
          for (const { error } of errors) {
            if (
              error && typeof error === "object" &&
              !(error as { frame?: unknown }).frame
            ) {
              (error as Error & { frame?: Frame }).frame = frame;
            }
            runtime.scheduler.reportError(error as Error);
          }
        } finally {
          popFrame(frame);
        }
      };
    };

    // Probe succeeded: this pattern WILL be instantiated through the interpreter.
    this.interpreterCensus.interpreted_ok++;
    if (RI_DISPATCH_DEBUG) {
      console.error(`RI_DISPATCH ok single-node [${riLabel()}]`);
    }

    return {
      argumentSchema: argumentSchema as JSONSchema,
      resultSchema: resultSchema as JSONSchema,
      // PRESERVE the authored internal-cell manifest (schema defaults + per-field
      // schemas) — NOT a single `$ri-result` cell carrying the full resultSchema.
      ...(pattern.derivedInternalCells !== undefined
        ? { derivedInternalCells: pattern.derivedInternalCells }
        : {}),
      // PRESERVE the authored result tree (NAME, pass-through argument/internal
      // aliases). The synthetic node writes only the internal-cell outputs.
      result: pattern.result,
      nodes: [
        {
          module: {
            type: "raw",
            implementation: interpreterImpl as (...args: any[]) => any,
            resultSchema: internSchema(resultSchema as JSONSchema),
          } as Module,
          inputs: { $alias: { cell: "argument", path: [] } },
          outputs: syntheticOutputs as JSONValue,
        },
      ],
    } satisfies Pattern;
  }

  /**
   * COALESCING SPIKE (coalescing track, step 3 — partition into dispatch).
   *
   * Wires the (previously unused) `partition` into the interpreter dispatch so a
   * pattern's PURE regions are interpreted (one segment node per maximal pure
   * region) while its HANDLERS/EFFECTS stay as legacy boundary nodes. The mix of
   * segment + boundary nodes is emitted into ONE synthetic Pattern that flows
   * through the SAME legacy `instantiateNode` loop, so segments inherit
   * reactivity/scheduling and boundaries instantiate exactly as legacy.
   *
   * This is the seam that makes the interpreter ENGAGE on real (handler-bearing)
   * patterns rather than only on whole-pure ones. It is DELIBERATELY narrow: the
   * gates below are scope CUTS for the spike (effect-only boundaries, no fan-out,
   * no boundary→boundary read-through, no handler write-back cycle). Anything
   * outside that envelope returns `null` → the caller continues to the existing
   * single-node path unchanged. NEVER widens fallback — it only ADDS a path.
   *
   * Returns the synthetic mixed Pattern on success, or `null` to fall through to
   * the existing single-node logic (no census mutation here; the caller bumps
   * `interpreted_ok` on a non-null return).
   */
  private tryBuildPartitionedInterpreterPattern(
    pattern: Pattern,
    extracted: ExtractResult,
    leafImpls: Map<OpId, (input: unknown) => unknown>,
    internalToOp: Map<string, OpId>,
    // The spike falls back by RETURNING NULL (not throwing), so the caller's
    // `bumpAndThrow` is part of the spec signature but unused here; kept for
    // parity with the single-node path's parameter shape.
    _bumpAndThrow: (reason: InterpreterFallbackReason) => never,
    resultCell: Cell<any>,
    internedArg: JSONSchema,
    /** Leaf op ids that did NOT resolve (`resolveLeafImpls`): a context-requiring
     * lift (`asCell`/`asStream` input, `Cell.for`), a pattern-returning factory
     * (launched-child-via-lift), or a serialized/untrusted leaf. Each becomes an
     * `unresolved-leaf` boundary kept VERBATIM as a legacy node — the surrounding
     * pure region still interprets. Empty set ⇒ effect-only partition (the
     * original spike behavior). */
    unresolvedLeafOps: ReadonlySet<OpId> = new Set<OpId>(),
    /** The in-flight setup transaction, if the caller has one — so the scoped-
     * collection guard can read the RAW bound argument THROUGH it to see per-
     * element link scopes that are not yet committed. Read-only. */
    setupTx?: IExtendedStorageTransaction,
  ): Pattern | null {
    // (a) Partition the extracted ROG structurally. No `resolveInner` (the spike
    // does not recurse into collection/pattern boundaries — those are gated out
    // below). An unresolved leaf is a BOUNDARY (kept verbatim as a legacy node);
    // `unresolvedLeafOps` carries the set the caller resolved so the partition
    // can cut the pure region around it instead of falling the whole pattern back.
    const PART_DBG = Deno.env.get("RI_PART_DEBUG2") === "1";
    const partDbg = (why: string) => {
      if (PART_DBG) {
        console.error(
          `RI_PART2 decline ${why} [nodes=${pattern.nodes?.length ?? 0}]`,
        );
      }
    };
    const part = partition({
      rog: extracted.rog,
      internalToOp,
      unresolvedLeafOps,
    });
    if (!part.partitionable) {
      partDbg("not-partitionable:" + (part.reason ?? ""));
      return null;
    }
    if (PART_DBG) {
      const kinds = part.boundaries.map((b) => b.kind).join(",");
      console.error(
        `RI_PART2 boundaries=[${kinds}] segs=${part.segments.length} ` +
          `[nodes=${pattern.nodes?.length ?? 0}]`,
      );
    }

    // (b) SPIKE GATES — deliberate scope cuts (NOT green-dodging). Any miss →
    // null → caller falls through to the single-node path.

    // Boundaries this partition can KEEP VERBATIM as legacy nodes: `effect`
    // (handlers / I/O builtins), `unresolved-leaf` (a context-requiring or
    // child-launching lift), and `collection` (a `map`/`filter`/`flatMap`). All
    // three pass through `(d)` as the original node, so the legacy node runs /
    // launches / iterates its element render exactly as today while the pure
    // segments around it interpret. For a `collection` boundary the original
    // `map` node's `inputs.list` alias already references whatever internal cell /
    // argument a segment now writes, and its `outputs` alias names the map's
    // result internal cell a downstream segment seeds from (registered in
    // `internalToOp` like any node). The element render stays inside the legacy
    // node verbatim (LEVEL-1: no `resolveInner` recursion below, so the per-
    // element CFC labelling and consolidated VNode doc are unchanged). A
    // A `pattern` boundary (§4.7) is kept VERBATIM as the legacy nested-pattern
    // node; the inlined child re-dispatches through `buildInterpreterPattern` at
    // runtime (instantiatePatternNode → this.run → instantiatePattern), so the
    // child's own pure regions / collections / nested patterns interpret
    // RECURSIVELY — no per-element `b.inner` emission is needed (the runtime child
    // re-dispatch IS the recursion). The surrounding pure region of THIS pattern
    // interprets as segments. All four boundary kinds now pass through (d) as a
    // legacy node.
    if (
      part.boundaries.some((b) =>
        b.kind !== "effect" && b.kind !== "unresolved-leaf" &&
        b.kind !== "collection" && b.kind !== "pattern"
      )
    ) {
      partDbg("boundary-kind-unknown");
      return null;
    }

    // SCOPED COLLECTION (D-EMISSION-SCOPE — conservative fallback boundary).
    // A `collection` boundary whose list / per-element result is narrowed to a
    // non-default (session/user) scope is PERMANENT legacy fallback: legacy
    // mints a narrower-scoped per-element result cell (R-SCOPE /
    // narrowestCellScope), and a downstream `.getRaw()` expects that scoped
    // output-cell chain. The interpreter's segment emission materializes the
    // surrounding pure region (the list lift, the `ifElse`/VNode constructs)
    // into derived-internal cells at the DEFAULT (space) scope, so the map's
    // list — and the per-element/branch result links the partition projects —
    // carry the wrong scope label (`space` instead of `session`, or `undefined`
    // instead of `space`). The narrowing may not sit STATICALLY on a list-input
    // alias schema (the `tryLowerCollectionBoundaryNode` static gate) — it
    // arrives via the bound argument DATA (a session/user-scoped input cell
    // feeding the list lift). When the partition carries any `collection`
    // boundary AND the raw bound argument tree carries a non-default scope, fall
    // back the WHOLE partition to legacy (whose per-node materialization emits
    // the correct scope labels). Reuses the same `hasNonDefaultScope` helper +
    // raw-argument snapshot the single-node collection path uses; gated to the
    // collection-boundary case so non-collection scoped partitions are
    // unaffected and engagement only drops the few session-scoped collection
    // patterns to full legacy (monotonic for everything else).
    if (
      part.boundaries.some((b) => b.kind === "collection") &&
      hasNonDefaultScope(this.readRawArgumentSnapshot(resultCell, setupTx))
    ) {
      partDbg("scoped-collection");
      return null;
    }

    // `asCell`/`asStream` ARGUMENT read BY A SEGMENT: when the pattern argument
    // schema marks an input as a live Cell/Stream handle (`Cell<…>` / `Stream<…>`
    // arg, e.g. `ifElse(enabledCell, …)`), the segment's deep-resolved `$arg`
    // surfaces that field as a HANDLE object, not the unwrapped value — so a
    // segment `control` predicate / `leaf` input reading it mis-evaluates (a
    // truthy handle always takes the true branch). Legacy reads through the live
    // cell and gets the unwrapped value.
    //
    // §4.7 REFINEMENT (was: coarse whole-pattern `schemaNeedsCellContext`): the
    // hazard requires a SEGMENT to actually NAVIGATE INTO a handle-typed argument
    // path. A pattern whose `asCell`/`asStream` fields are handed only to HANDLER
    // / effect boundaries (e.g. lunch-poll's PollOptionCard, whose `castVote` …
    // `Stream`s and `homePageRefresh` … `Cell`s are passed to handlers, never
    // read by a pure segment) is SOUND to coalesce: no segment ever surfaces a
    // handle. Gate per-SEGMENT — enumerate every `argument`-kind ValueRef the
    // segment ops read and fall back ONLY if one navigates into an
    // `asCell`/`asStream` schema node (`argumentPathNeedsCellContext`). This
    // un-traps the deeply-nested handler/effect-bearing element sub-patterns the
    // coarse gate previously fell back wholesale (07 §4.7) while keeping the
    // genuine "segment reads a Cell-typed arg" case fallback. Sound — a segment
    // reading only plain argument paths deep-resolves to plain values exactly as
    // the whole-pattern interpreter already does.
    const hasUnresolvedLeafBoundary = part.boundaries.some((b) =>
      b.kind === "unresolved-leaf"
    );
    const argSchema = pattern.argumentSchema;
    if (hasUnresolvedLeafBoundary && schemaNeedsCellContext(argSchema)) {
      const segByIdLocal = new Map<OpId, Op>();
      for (const op of extracted.rog.ops) segByIdLocal.set(op.id, op);
      // A handle arg read is only HAZARDOUS when the consuming segment op
      // INTERPRETS the value: a `leaf` body calls `.get()`/`.key()` on what it
      // expects to be a plain value (it gets a handle → wrong), and a `control`
      // op's predicate/branch coerces a handle as truthy (always-true → wrong).
      // A `construct` / `access` op merely RE-PROJECTS the handle structurally
      // into its output (a VNode prop, a handler-input object) — exactly as
      // legacy's binding layer wires the live cell into that downstream
      // structure. `asSchema(internedArg).get()` already surfaces the handle for
      // an `asCell`/`asStream` field (the annotation rides `internedArg`), so the
      // construct re-emits the SAME live handle legacy would, and a downstream
      // handler reads it through. So gate ONLY on a `leaf`/`control` op reading a
      // handle arg path; a `construct`/`access` handle pass-through is sound and
      // is exactly the lunch-poll PollOptionCard case the coarse gate trapped
      // (its handle reads are all VNode/handler-input CONSTRUCTS — 07 §4.7/§4.8).
      const HANDLE_HAZARD_KINDS = new Set(["leaf", "control"]);
      const handleArgPaths: string[] = [];
      let segmentReadsHandleArg = false;
      for (const seg of part.segments) {
        for (const id of seg.opIds) {
          const op = segByIdLocal.get(id);
          if (!op) continue;
          if (!HANDLE_HAZARD_KINDS.has(op.kind)) continue;
          for (const ref of argRefsOfOpFull(op)) {
            if (
              ref.kind === "argument" &&
              argumentPathNeedsCellContext(argSchema, ref.path)
            ) {
              segmentReadsHandleArg = true;
              if (PART_DBG) {
                handleArgPaths.push(
                  `${op.kind}#${op.id}:${ref.path.join(".")}`,
                );
              }
            }
          }
        }
      }
      if (segmentReadsHandleArg) {
        partDbg("segment-reads-handle-arg:" + handleArgPaths.join("|"));
        return null;
      }
    }

    // (Cross-segment `opOut` externals are MATERIALIZED via synthetic `$ri-op-<id>`
    // cells in step (c) below — not gated out.)

    // FAN-OUT (R-SEAM-1, §4.4) is ENGAGED, not deferred. A segment op consumed by
    // >1 boundary is the ONE-value/N-readers shape, NOT true distinct-output fan-
    // out: the producer is marked consumed ONCE (`partition.ts` `consumedOpIdx`,
    // regardless of reader count) and materialized into its single declared output
    // cell; each boundary then reads THAT SAME cell through its UNCHANGED verbatim
    // input alias (kept in step (d), `boundaryNodes.push(bNode)`). No multi-output
    // / container-of-links emission (§4.4(a)/(b)) is required — that would only be
    // needed if a single segment had to emit DISTINCT docs to distinct boundaries,
    // which cannot arise here (a consumed pure op is one scalar/list value behind
    // one declared/synthetic cell; N boundaries alias that one cell). Witnessed by
    // counter-render-tree `safeStep` (one lift → increment + decrement handlers),
    // menu-planner `daysView`/`recipesView`, and form-wizard `stepsView`.
    if (
      Deno.env.get("RI_PART_DEBUG") === "1" && part.fanoutSegmentIds.length > 0
    ) {
      console.error("RI_PART fanout engaged:", part.fanoutSegmentIds);
    }

    // Boundary→boundary edge: the §4.5 CFC read-through hazard is specifically an
    // **effect→effect** hop (`generateText(fetchData(x))`) — an `effect`'s LABELED
    // builtin output (a `$ctx` side-effect write carrying e.g. `LlmDerived`) flows
    // into another `effect`'s input with no interpreter segment journaling the read,
    // so the consumer-input doc can be written WITHOUT the producer's intrinsic
    // label. That hazard requires the PRODUCER boundary to be an `effect` (a labeled
    // builtin). When the producer is an `unresolved-leaf` (a context-requiring lift)
    // or a `collection` (a mapped container of links), its output is a NORMAL
    // dataflow value, NOT a `$ctx` side-effect write — there is no intrinsic builtin
    // label to drop, and BOTH boundaries are kept VERBATIM as legacy nodes (step
    // (d) below), so the consumer reads the producer's output cell through its
    // ORIGINAL input alias exactly as legacy does (the interpreter never sits in
    // this hop — it only replaces the surrounding PURE nodes with segments; this
    // edge stays entirely within the preserved legacy subgraph, which labels and
    // wires it itself). This is the SAME producer-kind discrimination the F4 write-
    // back gate already makes below (it fires only for `effect` producers, treating
    // unresolved-leaf/collection outputs as sound dataflow). So defer ONLY when an
    // `effect` produces the hop; engage the non-effect producer cases — e.g.
    // budget-planner / support-ticket-triage, where a context-requiring lift
    // (`unresolved-leaf`) feeds a handler (`effect`).
    const effectBoundaryIds = new Set(
      part.boundaries.filter((b) => b.kind === "effect").map((b) => b.id),
    );
    if (
      part.edges.some((e) =>
        e.kind === "bnd->bnd" && effectBoundaryIds.has(e.from)
      )
    ) {
      partDbg("effect-bnd-bnd");
      return null;
    }

    // A boundary with no segment to interpret is just the whole-legacy pattern —
    // nothing gained. Require at least one segment so the interpreter ENGAGES.
    if (part.segments.length === 0) {
      partDbg("no-segments");
      return null;
    }

    // F4 (coarse write-back-cycle gate): a handler whose ORIGINAL node writes a
    // cell that ANY segment reads as an input would create a write-back cycle
    // (the segment feeds the handler, the handler feeds the segment) that would
    // deadlock the single-pass segment eval. Structural over-approximation: we
    // compare each boundary's original-node OUTPUT internal-cell name against the
    // set of internal-cell names any segment reads. Any overlap → fall through.
    //
    // ONLY `effect` boundaries: a handler's output is a SIDE-EFFECT write (via
    // `$ctx`) NOT a tracked dataflow output, so a segment reading it back is a
    // genuine cycle. An `unresolved-leaf` boundary's output is a NORMAL dataflow
    // output (the lift's value), so a downstream segment reading it is a sound
    // `bnd→seg` edge — exactly the case we now engage (e.g. a `detail` segment
    // reading a context-requiring `summary` lift's `.trend`). A `collection`
    // boundary's output is likewise a NORMAL dataflow output (the mapped
    // container of links), never a `$ctx` side-effect, so a downstream segment
    // reading it back is a sound `bnd→seg` edge too — NOT a cycle. Excluding both
    // `unresolved-leaf` and `collection` boundaries here is what lets their pure
    // region interpret.
    const segmentReadNames = new Set<string>();
    for (const seg of part.segments) {
      for (const ref of seg.inputs) {
        if (ref.kind === "internal") segmentReadNames.add(ref.name);
      }
    }
    // op id → op (for the I/O-vs-handler effect-sink discrimination below).
    const opById = new Map<OpId, Op>();
    for (const op of extracted.rog.ops) opById.set(op.id, op);
    // Does this partition carry any HANDLER-SINK effect (a `cf.handler`
    // event-stream node that writes back to SHARED parent state)? That is the
    // structural fingerprint of a per-element ROW that, under CONCURRENT
    // multi-user load, contends on the hot aggregate doc when its coalesced
    // segments read the shared list and commit independently (07 §4.8). An I/O
    // effect whose output a segment reads is otherwise a clean `bnd→seg` dataflow
    // win — see the per-boundary gate below.
    const hasHandlerSinkEffect = part.boundaries.some((b) => {
      if (b.kind !== "effect") return false;
      const op = opById.get(b.opId);
      return op?.detail.kind === "effect" && op.detail.sink === "handler";
    });
    for (const b of part.boundaries) {
      if (b.kind !== "effect") continue;
      // §4.7: the single-pass-deadlock cycle concern is specific to a HANDLER sink
      // (an event-stream / `$ctx` side-effect write a segment could feed back
      // into). An I/O-builtin effect (`fetchData`/`generateText`/`llm`/
      // `sqliteQuery`/`wish`/…) produces a TRACKED DATAFLOW result cell — a
      // downstream segment reading it is a sound `bnd→seg` edge (the segment
      // journals the read, so the builtin's intrinsic label flows through it
      // exactly as legacy's computed does), NOT a cycle. The `io` sink is
      // classified (extract.ts) so this discrimination is available.
      //
      // ENGAGE the I/O→segment dataflow edge — but ONLY when the partition has NO
      // handler-sink effect. A pattern that combines an I/O builtin with a
      // downstream display computed and NO event-stream write-back (e.g.
      // CT-1334's `fetchData` + computed-projection sub-pattern) coalesces the
      // post-fetch pure region cleanly (sound, verified output-equivalent, +1
      // integration scenario). A pattern that ALSO carries handler sinks is a
      // per-element interactive ROW (lunch-poll's PollOptionCard: `fetchData`/
      // `generateText` alongside `castVote`/`removeOption`/… handlers): under
      // CONCURRENT multi-user load its coalesced segments multiply the stale-
      // confirmed-read surface on the hot shared poll doc → a cross-session
      // conflict ratchet (measured 4–10× commit-conflicts / 2–6× wall-clock vs
      // flat OFF↔ON when the I/O edge stays a boundary). That contention is the
      // §4.8 doc-fragmentation + per-element read-isolation hazard, a SEPARATE
      // increment (consolidated VNode docs + element-scoped segment writes). Until
      // then a handler-bearing partition keeps the I/O edge a BOUNDARY (the cycle
      // gate fires), so its per-element row stays sound legacy — the surrounding
      // pure region still interprets. (`RI_F4_IO_COALESCE=1` forces the engage for
      // measurement of the deferred case.)
      const op = opById.get(b.opId);
      const sink = op?.detail.kind === "effect" ? op.detail.sink : "handler";
      const coalesceIo = Deno.env.get("RI_F4_IO_OFF") === "1"
        ? false
        : (!hasHandlerSinkEffect ||
          Deno.env.get("RI_F4_IO_COALESCE") === "1");
      if (sink === "io" && coalesceIo) continue;
      const bNode = pattern.nodes?.[b.opId];
      if (!bNode) continue;
      const outName = outputInternalName(bNode.outputs);
      if (outName !== null && segmentReadNames.has(outName)) {
        partDbg("f4-writeback-cycle:" + outName);
        return null;
      }
    }

    // NOTE on launched-child-via-lift (`entries.map(() => childPattern(...))`)
    // and context-requiring lifts (`asCell`/`asStream` input, `Cell.for`): a leaf
    // whose body instantiates a pattern factory, or needs a live Cell handle /
    // builder frame, cannot be INTERPRETED (it needs a reactive runtime frame the
    // synthetic segment node lacks). It is caught STRUCTURALLY and BODY-FREE
    // upstream by `liveLeafCanInstantiatePattern` / `schemaNeedsCellContext` /
    // `liveLeafNeedsBuilderContext` (extract.ts) and reported as an UNRESOLVED
    // leaf. Such a leaf is now kept as an `unresolved-leaf` BOUNDARY (the original
    // legacy node, verbatim, in `(d)`) — it launches its children / reads its live
    // cell exactly as legacy does, while the pure region around it interprets. We
    // must NOT run leaf bodies here to detect it: a non-probe eval would
    // re-execute pure lifts and double their observable run counts — the laziness
    // invariant the single-node `probe:true` path preserves.

    // (c) Build one raw interpreter node per segment. `byId` indexes the
    // extracted ROG's ops by id so a segment's sub-op-set is a real op list.
    const byId = new Map<OpId, Op>();
    for (const op of extracted.rog.ops) byId.set(op.id, op);

    // Each declared output internal-cell name → its producing op id, reused from
    // the single-node emission convention (a node writes its value into the
    // internal cell its `outputs` alias names). The result tree / projection is
    // preserved verbatim, so segments route per-field via the original aliases.
    const outputNameToOpId = new Map<string, OpId>();
    const nodeOutputsByName = new Map<string, JSONValue>();
    for (const node of pattern.nodes ?? []) {
      const outName = outputInternalName(node.outputs);
      if (outName === null) continue; // boundary/handler outputs handled below
      const opId = internalToOp.get(outName);
      if (opId === undefined) continue;
      outputNameToOpId.set(outName, opId);
      nodeOutputsByName.set(outName, node.outputs as JSONValue);
    }

    const argumentSchema = (pattern.argumentSchema ?? {}) as JSONSchema;
    const resultSchema = (pattern.resultSchema ?? {}) as JSONSchema;

    // PRODUCER-LESS internal cells a segment may read: a `cell(…)` declared in
    // the pattern body and written ONLY by a handler boundary (e.g. an `updates`
    // counter), plus any `derivedInternalCells` default. No op produces them, so
    // `internalToOp` has no entry — yet they are REAL cells the segment must read
    // (schema-defaulted, or handler-written). We collect each such name (the
    // `outputInternalName`-normalized key the ROG's `internal` refs use) with its
    // ORIGINAL `partialCause` payload + declared schema from `derivedInternalCells`,
    // falling back to a boundary's raw input alias. The segment node re-aliases by
    // the original `partialCause` (a STRING — or a `{$generated:N}` object — never
    // the normalized string key, which the binding layer cannot resolve).
    const internalCellAliasByName = new Map<
      string,
      { partialCause: JSONValue; schema: JSONValue | undefined }
    >();
    for (const dic of pattern.derivedInternalCells ?? []) {
      const name = outputInternalName({ $alias: dic });
      if (name !== null && !internalCellAliasByName.has(name)) {
        internalCellAliasByName.set(name, {
          partialCause: (dic as { partialCause: JSONValue }).partialCause,
          schema: (dic as { schema?: JSONValue }).schema,
        });
      }
    }
    // Recover any handler-input internal alias not in the manifest (defense-in-
    // depth — the manifest is normally exhaustive).
    const collectAliases = (v: unknown): void => {
      if (!v || typeof v !== "object") return;
      const alias = (v as { $alias?: Record<string, unknown> }).$alias;
      if (alias && typeof alias === "object") {
        const name = outputInternalName({ $alias: alias });
        if (name !== null && !internalCellAliasByName.has(name)) {
          internalCellAliasByName.set(name, {
            partialCause: alias.partialCause as JSONValue,
            schema: alias.schema as JSONValue,
          });
        }
        return;
      }
      if (Array.isArray(v)) { for (const el of v) collectAliases(el); }
      else for (const el of Object.values(v)) collectAliases(el);
    };
    for (const b of part.boundaries) {
      collectAliases(pattern.nodes?.[b.opId]?.inputs);
    }
    // OP-BACKED external sources: a segment that reads an upstream PRODUCER's
    // output (another segment's materialized output, or an `unresolved-leaf`
    // boundary's dataflow output — e.g. a context-requiring `summary` lift) needs
    // an `$in[name]` alias to that producer's OUTPUT cell. The producer node's own
    // `outputs` `$alias` carries the correct `partialCause` + schema (the manifest
    // / boundary-input scan above only covers derived-internal + handler-INPUT
    // cells, never these producer outputs). Register each so `aliasFor` resolves
    // by the real `partialCause`, never the unresolvable normalized string key.
    for (const [name, outputs] of nodeOutputsByName) {
      if (internalCellAliasByName.has(name)) continue;
      const alias =
        (outputs as { $alias?: Record<string, unknown> } | undefined)?.$alias;
      if (alias && typeof alias === "object") {
        internalCellAliasByName.set(name, {
          partialCause: alias.partialCause as JSONValue,
          schema: alias.schema as JSONValue | undefined,
        });
      }
    }

    // CROSS-SEGMENT `opOut` materialization. A pure op consumed by a DIFFERENT
    // segment via a raw `opOut` ref (an intermediate / SYNTHETIC construct — a
    // structured leaf-input or result projection, id < 0 — with no declared
    // internal-cell name) must round-trip through a cell so the consumer can seed
    // it. This shape arises when an `unresolved-leaf` boundary pushes its
    // downstream pure ops into a LATER layer, splitting them from upstream pure
    // constructs that feed them by `opOut`. We mint a SYNTHETIC derived internal
    // cell `$ri-op-<id>` for each such op: the PRODUCER segment writes its value,
    // the CONSUMER segment seeds from it (schemaless — the value is pure JSON
    // computed by a pure op, so it round-trips verbatim). The synthetic cells are
    // appended to `derivedInternalCells` so the manifest materializes them; they
    // are NOT in the result tree, so projection is unaffected. (The effect-only
    // spike never needed this — effect outputs always materialize a named cell.)
    const segOfOp = new Map<OpId, number>(); // op id → owning segment index
    part.segments.forEach((s, i) => {
      for (const id of s.opIds) segOfOp.set(id, i);
    });
    const crossSegOpName = new Map<OpId, string>(); // op id → `$ri-op-<id>`
    for (let si = 0; si < part.segments.length; si++) {
      const seg = part.segments[si];
      for (const ref of seg.inputs) {
        if (ref.kind !== "opOut") continue;
        if (seg.opIds.includes(ref.op)) continue; // intra-segment
        const producerSeg = segOfOp.get(ref.op);
        // The producer must be a SEGMENT op (a boundary output is a named cell,
        // handled by the internal-ref path; a producer in no segment is a bug).
        if (producerSeg === undefined || producerSeg === si) {
          partDbg("cross-seg-opout-producer:" + ref.op);
          return null;
        }
        if (!crossSegOpName.has(ref.op)) {
          const name = "$ri-op-" + ref.op;
          crossSegOpName.set(ref.op, name);
          // Register a schemaless alias so `aliasFor(name)` resolves by the
          // synthetic partialCause (never the unresolvable normalized key).
          internalCellAliasByName.set(name, {
            partialCause: name,
            schema: undefined,
          });
        }
      }
    }
    // Synthetic derived-internal-cell descriptors for the manifest. Shape matches
    // `pattern.derivedInternalCells` ({ partialCause, schema? }) — schemaless, as
    // the routed value is arbitrary pure JSON from an intermediate op.
    const syntheticDerivedCells = [...crossSegOpName.values()].map((name) => ({
      partialCause: name,
    }));

    // Alias a (named-internal OR synthetic `$ri-op-<id>`) cell by its ORIGINAL
    // `partialCause` (a string / `{$generated:N}` object — never the normalized
    // string key, which the binding layer cannot resolve), carrying its declared
    // schema so a default surfaces rather than `undefined`. Used for BOTH a
    // segment's external `$in` reads and its synthetic cross-segment outputs (so
    // the producer's write and the consumer's read resolve to the SAME cell).
    const aliasFor = (name: string): JSONValue => {
      const meta = internalCellAliasByName.get(name);
      const partialCause = meta?.partialCause ?? name;
      const schema = meta?.schema;
      return {
        $alias: schema !== undefined
          ? { partialCause, path: [], schema }
          : { partialCause, path: [] },
      } as unknown as JSONValue;
    };

    const segmentNodes: Pattern["nodes"] = [];
    for (const seg of part.segments) {
      // The segment's own op set (real ops only; a malformed id → fall through).
      const segOps: Op[] = [];
      for (const id of seg.opIds) {
        const op = byId.get(id);
        if (!op) {
          partDbg("seg-op-missing:" + id);
          return null;
        }
        segOps.push(op);
      }
      const segOpIds = new Set<OpId>(seg.opIds);

      // EXTERNAL `internal` reads: a name in this segment's inputs whose producer
      // op is NOT in this segment. Two sub-cases, both wired into the node
      // `inputs` so the segment-eval SEEDS them (argument/const refs need no
      // wiring — the evaluator resolves them directly):
      //   (1) OP-BACKED externals — an upstream boundary output or an earlier
      //       segment's materialized output; seeded by OP ID.
      //   (2) CELL-ONLY externals — a producer-LESS internal cell (a `cell(…)`
      //       written only by a handler, or a `derivedInternalCells` default);
      //       seeded by NAME, read from the live cell (schema-defaulted).
      const externalNames: string[] = []; // op-backed (seed by op id by name)
      const cellOnlyNames: string[] = []; // producer-less (seed by name)
      // Cross-segment `opOut` externals: synthetic-cell name → producing op id,
      // seeded by op id (the consumer's `internal`→opId map has no entry for a
      // synthetic op, so the impl seeds these explicitly by their op id).
      const crossSegExt: Array<{ name: string; opId: OpId }> = [];
      const seenExt = new Set<string>();
      for (const ref of seg.inputs) {
        if (ref.kind === "opOut") {
          if (segOpIds.has(ref.op)) continue; // produced WITHIN the segment
          const name = crossSegOpName.get(ref.op);
          if (name === undefined) {
            partDbg("cross-seg-unmaterialized:" + ref.op);
            return null; // not materialized ⇒ fall back
          }
          if (seenExt.has(name)) continue;
          seenExt.add(name);
          crossSegExt.push({ name, opId: ref.op });
          continue;
        }
        if (ref.kind !== "internal") continue;
        if (seenExt.has(ref.name)) continue;
        const producerOp = internalToOp.get(ref.name);
        if (producerOp === undefined) {
          // Producer-less: only wire it if it is a REAL internal cell (in the
          // manifest or referenced by a boundary input alias). An internal name
          // backed by neither is genuinely dangling — leave it unwired (the
          // dangling-internal gate already fell such patterns back on the
          // single-node path; here it resolves to undefined, same as before).
          if (!internalCellAliasByName.has(ref.name)) continue;
          seenExt.add(ref.name);
          cellOnlyNames.push(ref.name);
          continue;
        }
        if (segOpIds.has(producerOp)) continue; // produced WITHIN the segment
        seenExt.add(ref.name);
        externalNames.push(ref.name);
      }

      // This segment's OUTPUT names = the declared output internal cells whose
      // producing op lives in this segment. Each is routed to its original
      // per-field output alias via `sendValueToBinding` (CFC labels preserved).
      const segOutputNames: string[] = [];
      const segOutputsBinding: Record<string, JSONValue> = {};
      for (const [name, opId] of outputNameToOpId) {
        if (!segOpIds.has(opId)) continue;
        segOutputNames.push(name);
        segOutputsBinding[name] = nodeOutputsByName.get(name)!;
      }
      // CROSS-SEGMENT `opOut` outputs this segment PRODUCES: each synthetic
      // `$ri-op-<id>` cell whose op lives in this segment. Written by op id (the
      // impl maps the synthetic name → op id via `crossSegOutputNameToOpId`),
      // aliased by its synthetic partialCause so a later segment can seed it.
      const crossSegOutputNameToOpId = new Map<string, OpId>();
      for (const [opId, name] of crossSegOpName) {
        if (!segOpIds.has(opId)) continue;
        segOutputNames.push(name);
        segOutputsBinding[name] = aliasFor(name);
        crossSegOutputNameToOpId.set(name, opId);
      }
      // A segment that materializes nothing downstream-consumers read is dead
      // weight (it would write an empty value object). Skip emitting it; its op
      // values are recomputed by any consumer segment that seeds from it. (In the
      // spike, a segment with no declared output but a boundary consumer cannot
      // arise without fan-out/bnd edges already gated; defensively skip.)
      if (segOutputNames.length === 0) continue;

      // The sub-Rog this segment evaluates: its own ops + the parent argument
      // schema. `result` is unused by the segment impl (it reads opValues
      // directly), so any ref is fine; reuse the parent result ref.
      const segRog: Rog = {
        argumentSchema,
        resultSchema,
        result: extracted.rog.result,
        ops: segOps,
      };

      // The node `inputs` binding: `$arg` aliases the argument cell; `$in` is an
      // object keyed by the segment's normalized internal-cell NAME, each value
      // an alias to that cell by its ORIGINAL `partialCause` (a string, or a
      // `{$generated:N}` object — never the normalized string key, which the
      // binding layer cannot resolve). Each alias carries the cell's declared
      // SCHEMA so a schema DEFAULT (e.g. a handler-written `cell(0)` not yet
      // touched) surfaces as the default value rather than `undefined` — matching
      // what legacy reads through the cell.
      const inBinding: Record<string, JSONValue> = {};
      for (const name of externalNames) inBinding[name] = aliasFor(name);
      for (const name of cellOnlyNames) inBinding[name] = aliasFor(name);
      for (const { name } of crossSegExt) inBinding[name] = aliasFor(name);
      const inputsBinding = {
        $arg: { $alias: { cell: "argument", path: [] } },
        $in: inBinding,
      } as unknown as JSONValue;

      // The impl seeds op values by op id. Named-internal externals key on
      // `internalToOp`; synthetic cross-segment externals carry their own op id.
      // Outputs likewise: named-internal outputs key on `outputNameToOpId`,
      // synthetic outputs on `crossSegOutputNameToOpId`. Merge both maps so the
      // impl resolves every output/external name → op id uniformly.
      const segOutputNameToOpId = new Map<string, OpId>(outputNameToOpId);
      for (const [name, opId] of crossSegOutputNameToOpId) {
        segOutputNameToOpId.set(name, opId);
      }
      const crossSegSeed = new Map<string, OpId>();
      for (const { name, opId } of crossSegExt) crossSegSeed.set(name, opId);

      // PER-SEGMENT ARGUMENT READ NARROWING (07 §4.8 over-subscription fix). The
      // segment impl deep-reads `$arg` under a schema to track its argument
      // dependencies. Reading the WHOLE argument schema makes EVERY segment
      // re-run whenever ANY argument field changes — for a wide sub-pattern (e.g.
      // lunch-poll's PollOptionCard with `option`/`votes`/`me`/… and ~28
      // segments) that is a re-run storm that floods the scheduler and provokes
      // cross-session write contention (conflict ratchet). Legacy's per-computed
      // nodes each subscribe ONLY to their own inputs; mirror that by narrowing
      // each segment's `$arg` schema to the TOP-LEVEL argument properties its ops
      // actually read. A segment that reads the argument ROOT directly (a bare
      // `argument` ref with an empty path — e.g. spreads the whole arg) keeps the
      // full schema (sound: it genuinely depends on everything). The narrowed
      // schema PRESERVES each kept property's sub-schema verbatim (including any
      // `asCell`/`asStream` annotation), so the construct handle pass-through is
      // unchanged. Off the eligibility path — pure schema projection.
      const segArgTree = newArgPathTree();
      for (const op of segOps) {
        for (const ref of argRefsOfOpFull(op)) {
          if (ref.kind !== "argument") continue;
          insertArgPath(segArgTree, ref.path.map(String));
        }
      }
      const segInternedArg = segArgTree.whole
        ? internedArg
        : narrowArgumentSchemaByTree(argumentSchema, segArgTree);

      const segImpl = this.buildSegmentInterpreterImpl(
        segRog,
        leafImpls,
        internalToOp,
        externalNames,
        cellOnlyNames,
        segOutputNames,
        segOutputNameToOpId,
        segInternedArg,
        crossSegSeed,
      );

      segmentNodes.push({
        module: {
          type: "raw",
          implementation: segImpl as (...args: any[]) => any,
          resultSchema: internSchema(resultSchema),
        } as Module,
        inputs: inputsBinding,
        outputs: segOutputsBinding as JSONValue,
      });
    }

    // No segment actually materialized an output ⇒ nothing for the interpreter
    // to do; let the legacy single-node path (or full legacy) handle it.
    if (segmentNodes.length === 0) {
      partDbg("no-segment-nodes-emitted");
      return null;
    }

    // (d) Emit boundary nodes. Effect / unresolved-leaf boundaries are kept
    // VERBATIM as the original legacy node (their input aliases already reference
    // the internal cells segments now write). A `collection` boundary whose
    // element render is a PURE, eligible `map` (LEVEL-2) is lowered to the
    // registered `$ri-collection-map` builtin so its per-element render
    // INTERPRETS via the collection path — the surrounding pure region (segments)
    // and the per-element op both run through the interpreter. An ineligible
    // collection boundary (filter/flatMap, scoped, nested pattern/effect element,
    // serialized/unresolved element leaf) is kept VERBATIM as the legacy map node
    // (LEVEL-1) so its element render runs exactly as today — sound, green.
    const boundaryNodes: Pattern["nodes"] = [];
    for (const b of part.boundaries) {
      const bNode = pattern.nodes?.[b.opId];
      if (!bNode) return null; // boundary op id not a real node ⇒ fall through
      if (b.kind === "collection") {
        const lowered = this.tryLowerCollectionBoundaryNode(bNode);
        boundaryNodes.push(lowered ?? bNode);
        continue;
      }
      boundaryNodes.push(bNode);
    }

    // (e) Assemble the synthetic mixed Pattern. The result tree +
    // derivedInternalCells are preserved verbatim so projection/materialization
    // is identical to legacy; only the COMPUTE nodes are replaced by segments,
    // while boundaries pass through unchanged. The synthetic `$ri-op-<id>`
    // cross-segment cells are APPENDED to the manifest (they carry NO result-tree
    // projection, so the output is identical to legacy — they exist only to route
    // a value between two segments).
    const mergedDerivedCells = [
      ...(pattern.derivedInternalCells ?? []),
      ...syntheticDerivedCells,
    ];
    return {
      argumentSchema,
      resultSchema,
      ...(mergedDerivedCells.length > 0
        ? {
          derivedInternalCells:
            mergedDerivedCells as Pattern["derivedInternalCells"],
        }
        : {}),
      result: pattern.result,
      nodes: [...segmentNodes, ...boundaryNodes],
    } satisfies Pattern;
  }

  /**
   * Build a SEGMENT interpreter impl (coalescing spike). Mirrors the single-node
   * `interpreterImpl`, but: (1) reads the argument from the `$arg` slot and each
   * external internal cell from the `$in[name]` slot of the node input cell, (2)
   * SEEDS those external values into `evalRog` — OP-BACKED externals by op id
   * (`seed`), and producer-LESS internal cells (handler-written `cell(…)` /
   * `derivedInternalCells` defaults) by NAME (`seedByName`) — so the segment's
   * `internal` refs to producers it does NOT own resolve, and (3) writes ONLY
   * this segment's own output names. Errors are NOT routed here (the spike keeps
   * the error-frame machinery on the single-node path); a throwing leaf isolates
   * to `undefined` exactly as `evalRog` already does.
   */
  private buildSegmentInterpreterImpl(
    segRog: Rog,
    leafImpls: Map<OpId, (input: unknown) => unknown>,
    internalToOp: Map<string, OpId>,
    externalNames: string[],
    cellOnlyNames: string[],
    segOutputNames: string[],
    outputNameToOpId: Map<string, OpId>,
    internedArg: JSONSchema,
    /** Synthetic cross-segment `$ri-op-<id>` externals: `$in[name]` → producing
     * op id. Seeded by op id (these have no `internalToOp` entry). */
    crossSegSeed: Map<string, OpId> = new Map<string, OpId>(),
  ): (
    inputsCell: Cell<unknown>,
    sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    addCancel: AddCancel,
    cause: unknown,
    parentCell: Cell<unknown>,
    runtime: Runtime,
    outputBinding?: NormalizedFullLink,
  ) => Action {
    return (
      inputsCell: Cell<unknown>,
      sendResult: (tx: IExtendedStorageTransaction, result: unknown) => void,
    ): Action => {
      return (tx: IExtendedStorageTransaction) => {
        // Read `$arg` (the argument) and each external `$in[name]` THROUGH the tx
        // so every read is tracked (the segment re-runs reactively when its
        // argument OR any upstream boundary/segment output it reads changes).
        // The `$arg` read is SCHEMA-DRIVEN (the argument schema) — identical to
        // the single-node impl's `inputsCell.asSchema(internedArg)` — so the
        // tracked read-set covers the deep argument paths the segment depends on
        // (a shallow top-object read would miss a nested-field writeback, e.g. a
        // handler boundary mutating `argument.counter.value`, and the segment
        // would never re-derive).
        const cellTx = inputsCell.withTx(tx);
        const argument = cellTx.key("$arg").asSchema(internedArg).get();
        const inObj = (cellTx.key("$in").get() ?? {}) as Record<
          string,
          unknown
        >;

        // Seed the external op values so `internal` refs to producers OUTSIDE the
        // segment resolve to the upstream-written value.
        const seed = new Map<OpId, unknown>();
        for (const name of externalNames) {
          const opId = internalToOp.get(name);
          if (opId !== undefined) seed.set(opId, inObj[name]);
        }
        // Seed synthetic cross-segment `opOut` externals by their producing op id
        // (an intermediate construct's value routed through a `$ri-op-<id>` cell).
        for (const [name, opId] of crossSegSeed) seed.set(opId, inObj[name]);
        // Seed producer-LESS internal cells by name (handler-written `cell(…)` /
        // `derivedInternalCells` defaults) — these have no op id to key on.
        const seedByName = new Map<string, unknown>();
        for (const name of cellOnlyNames) seedByName.set(name, inObj[name]);

        const { opValues } = evalRog(segRog, {
          argument,
          leafImpls,
          internalToOp,
          seed,
          seedByName,
        });

        // Write each of THIS segment's output names from its producing op value.
        const out: Record<string, unknown> = {};
        for (const name of segOutputNames) {
          const opId = outputNameToOpId.get(name);
          if (opId !== undefined) out[name] = opValues.get(opId);
        }
        sendResult(tx, out);
      };
    };
  }

  /**
   * LEVEL-2 collection-boundary lowering (§4.7 per-element recursion, first cut).
   * Given the ORIGINAL `map` node of a `collection` partition boundary, decide
   * whether its per-element render is a PURE, eligible `map` that the registered
   * `$ri-collection-map` builtin can interpret per element. If so, return a
   * replacement node dispatching to that builtin (reusing the original node's
   * `inputs.{list,op}` and `outputs` verbatim, so the projection / item schema /
   * declared scope are inherited for free). If NOT — `filter`/`flatMap` (the
   * builtin only implements `map`), a non-default scope on the list or element
   * graph, a serialized / non-inline element pattern, an element graph carrying a
   * nested `pattern`/`effect`/`collection` op, or an element leaf the verified-
   * impl resolver cannot bind — return `null` so the caller keeps the LEGACY map
   * node VERBATIM (LEVEL-1, sound, green).
   *
   * Soundness mirrors `tryBuildCollectionInterpreterPattern` but scoped to ONE
   * element pattern: the per-element evaluator re-extracts the element graph at
   * depth 0 (`buildElementEvaluator`) and reports any unresolved leaf; a fresh
   * `extractRog` over the element pattern supplies its `coverage.byKind` /
   * `coverage.nested` so a nested pattern/effect/collection element (which the
   * single-node `$ri-collection-map` path would silently mis-evaluate) is
   * declined. Pure — no tx writes, no leaf-body execution (the evaluator only
   * RESOLVES leaf impls; it runs them per element later, inside the builtin).
   */
  private tryLowerCollectionBoundaryNode(
    mapNode: NonNullable<Pattern["nodes"]>[number],
  ): NonNullable<Pattern["nodes"]>[number] | null {
    const DBG = Deno.env.get("RI_LOWER_DEBUG") === "1";
    const dbg = (why: string) => {
      if (DBG) console.error("RI_LOWER decline:", why);
    };
    const module = mapNode.module as
      | { type?: string; implementation?: unknown }
      | undefined;
    // Only a `map` ref node is lowerable: `filter`/`flatMap` are not implemented
    // by the `$ri-collection-map` builtin (the boundary stays a verbatim legacy
    // node). A non-ref / non-map module (already-lowered, or a different builtin)
    // is likewise kept verbatim.
    if (module?.type !== "ref" || module.implementation !== "map") {
      dbg("not-map-ref:" + JSON.stringify(module?.implementation));
      return null;
    }

    const mapNodeInputs = mapNode.inputs as Record<string, unknown> | undefined;
    if (!mapNodeInputs) {
      dbg("no-inputs");
      return null;
    }
    const elementPattern = mapNodeInputs.op;
    // A serialized `$patternRef` element (not an inline pattern) is out of scope
    // for the in-memory-element first cut → keep verbatim (LEVEL-1).
    if (!isPatternLike(elementPattern)) {
      dbg("element-not-inline");
      return null;
    }

    // Unscoped-only: a PerUser/PerSession narrowing on the list input or the
    // element graph is the unmodeled indirection the unscoped `$ri-collection-map`
    // builtin cannot reproduce → keep verbatim (legacy narrows per element).
    if (
      hasNonDefaultScope(mapNodeInputs.list) ||
      hasNonDefaultScope(elementPattern)
    ) {
      dbg("scoped");
      return null;
    }

    // Element graph must be PURE: re-extract it as its OWN root and consult its
    // coverage. A nested `pattern`/`effect`/`collection` element op would
    // mis-evaluate through the single-node per-element path (it iterates the
    // element render as DATA, not as a launched child / I/O effect / nested map)
    // → keep verbatim. (`extractRog`'s element coverage is computed fresh here, so
    // it reflects ONLY this element graph, independent of the parent pattern.) The
    // element's argument aliases are serialized RELATIVE to the parent map frame
    // (`defer === 1`), so pass the inferred base defer — exactly as the element
    // evaluator does — or the coverage scan would flag those local argument reads
    // as unrecognized deferred aliases and spuriously decline a pure element.
    const elementBaseDefer = extractRogBaseDefer(
      elementPattern as unknown as Parameters<typeof extractRog>[0],
    );
    const elementExtract = extractRog(
      elementPattern as unknown as Parameters<typeof extractRog>[0],
      elementBaseDefer,
    );
    const elByKind = elementExtract.coverage.byKind;
    if ((elByKind.pattern ?? 0) > 0) {
      dbg("element-has-pattern");
      return null;
    }
    if ((elByKind.effect ?? 0) > 0) {
      dbg("element-has-effect");
      return null;
    }
    if ((elByKind.collection ?? 0) > 0) {
      dbg("element-has-collection");
      return null;
    }
    // Any unrecognized alias / writeback marker in the element graph makes the
    // per-element evaluation unsound → keep verbatim.
    if (elementExtract.coverage.unrecognizedAliases.length > 0) {
      dbg(
        "element-unrecognized:" +
          JSON.stringify(elementExtract.coverage.unrecognizedAliases),
      );
      return null;
    }

    // The per-element evaluator must fully resolve (no unresolved leaf op): a
    // context-requiring / untrusted element leaf cannot be interpreted as data →
    // keep verbatim (the legacy node runs it in the SES sandbox / with a live
    // frame).
    const evaluator = buildElementEvaluator(
      elementPattern as Record<string, unknown>,
      this.interpreterImplRefResolver,
      this.interpreterLiveLeafTrustCheck,
      // Resolve the element's argument aliases relative to the parent map frame
      // (`defer === 1`) — matching the runtime `$ri-collection-map` builtin.
      true,
    );
    if (evaluator.unresolvedLeafOps.length > 0) {
      dbg(
        "element-unresolved-leaf:" +
          JSON.stringify(evaluator.unresolvedLeafOps),
      );
      return null;
    }

    // GATE↔RUNTIME PARITY. The eligibility evaluator above resolves the element's
    // leaves from their LIVE in-memory `module.implementation` callables — but the
    // RUNTIME `$ri-collection-map` builtin reads the element pattern back from a
    // cell (`getRaw()`), where the live function is GONE and only a `$implRef`
    // survives. A leaf with a live function but NO content-addressed `$implRef`
    // (e.g. a `str` template, which compiles to a bare `javascript` module) passes
    // the live gate yet CANNOT be recovered at runtime → the builtin would throw
    // `unresolved element leaf ops`. Decline such an element here (keep verbatim,
    // LEVEL-1) so we only lower an element whose leaves survive serialization. A
    // `ref`-module leaf (a registered builtin name) is always recoverable; a
    // function-bearing module must carry a `$implRef` the implRef resolver binds.
    if (!this.elementLeavesSurviveSerialization(elementPattern)) {
      dbg("element-leaf-no-implref");
      return null;
    }

    // Eligible: dispatch this boundary to the `$ri-collection-map` builtin,
    // reusing the original node's `{list, op, …}` inputs and its output binding
    // (which carries the author-declared scope + item schema downstream `.key(i)`
    // consumers need) verbatim. Keeping the original inputs/outputs inherits the
    // exact projection + reactivity for free.
    return {
      module: {
        type: "ref",
        implementation: "$ri-collection-map",
      } as Module,
      inputs: mapNode.inputs,
      outputs: mapNode.outputs,
    };
  }

  /**
   * GATE↔RUNTIME parity check for a collection element pattern (see
   * `tryLowerCollectionBoundaryNode`). True iff EVERY leaf node in the element
   * graph (recursing into any nested inline element/sub pattern) is recoverable
   * from the SERIALIZED form the runtime `$ri-collection-map` builtin reads —
   * i.e. either a `ref`-module leaf (a registered builtin name, always present
   * post-serialization) or a function-bearing module that ALSO carries a
   * `$implRef` the implRef resolver binds. A bare `javascript` leaf with a live
   * `implementation` but NO `$implRef` (e.g. a `str` template) does NOT survive
   * the `getRaw()` round-trip — the live function is dropped and there is no ref
   * to recover it — so the element must stay a verbatim legacy boundary.
   *
   * PURE — read-only structural scan; resolves refs through the same content-
   * addressed resolver the runtime builtin uses (`interpreterImplRefResolver`),
   * never runs a leaf body.
   */
  private elementLeavesSurviveSerialization(
    elementPattern: unknown,
  ): boolean {
    const nodes = (elementPattern as { nodes?: unknown[] }).nodes;
    if (!Array.isArray(nodes)) return true; // no nodes ⇒ pure projection
    for (const node of nodes) {
      const module = (node as { module?: Record<string, unknown> }).module;
      if (!module || typeof module !== "object") continue;
      const type = module.type as string | undefined;
      // A `ref`-module leaf names a registered builtin — always recoverable.
      if (type === "ref") continue;
      // A nested inline element/sub pattern: recurse (its own leaves must survive
      // too). A `javascript`/`raw` module carrying an inline Pattern object as its
      // `implementation` is such a nest.
      const impl = module.implementation;
      if (isPatternLike(impl)) {
        if (!this.elementLeavesSurviveSerialization(impl)) return false;
        continue;
      }
      // A function-bearing leaf must carry a `$implRef` the resolver can bind, or
      // the serialized runtime form is unresolvable.
      if (typeof impl === "function" || typeof impl === "string") {
        const ref = module.$implRef as
          | { identity: string; symbol: string }
          | undefined;
        const resolved = ref
          ? this.interpreterImplRefResolver(ref.identity, ref.symbol)
          : undefined;
        if (typeof resolved !== "function") return false;
      }
    }
    return true;
  }

  /**
   * COLLECTION eligibility probe (PURE — no tx writes) for exactly ONE top-level
   * `map`. Returns a synthetic single-node Pattern dispatching to the registered
   * `$ri-collection-map` builtin when the pattern is the eligible single-map
   * shape (the WHOLE pattern is the map — per-element interpreted). Returns
   * `null` when there is NO collection op at all (scalar path) OR there IS a
   * collection op but it is NOT the eligible single-map shape (a `map` alongside
   * other compute, a `filter`/`flatMap`, a multi-collection pattern, a non-
   * trivial result projection, a scoped/context element). In the NOT-eligible
   * case the caller falls through to the PARTITION path
   * (`tryBuildPartitionedInterpreterPattern`), where the collection op is kept
   * VERBATIM as a legacy boundary node (its per-element render, scope, and leaves
   * run exactly as legacy — green) while the SURROUNDING pure regions interpret
   * as segments. If the partition also cannot engage, the downstream
   * `ELIGIBLE_KINDS` / `unresolved_leaf` gates throw the final fail-closed reason
   * (`ineligible_opkind` / `unresolved_leaf`) — so the fail-closed verdict is
   * never lost, only DEFERRED to give the partition a chance first.
   *
   * Highest-risk soundness point: this consults `coverage.byKind` / `coverage`
   * `.nested`, NOT just `rog.ops`. `extractRog` recurses into the element pattern
   * with a FRESH per-recursion ops array THAT IS DISCARDED, so element-internal
   * pattern/effect/nested-collection ops NEVER appear in `rog.ops`. A naive
   * "loop rog.ops" gate would ADMIT a map whose element contains a nested
   * pattern/effect and SILENTLY MIS-EVALUATE via the single-node `$ri-collection-
   * map` path. We therefore decline the single-node path for any element graph
   * carrying a `pattern`/`effect` op, any collection beyond the outer map, or
   * more than one nested recursion (`coverage.nested > 1`) — those fall through
   * to the partition (legacy map node) instead, which is sound.
   */
  private tryBuildCollectionInterpreterPattern(
    pattern: Pattern,
    extracted: ExtractResult,
    bumpAndThrow: (reason: InterpreterFallbackReason) => never,
    resultCell: Cell<any>,
    setupTx?: IExtendedStorageTransaction,
  ): Pattern | null {
    // --- Shape: exactly one non-structural op, and it is a `map` -----------
    // Structural ops are the extraction-synthesized result/input constructs
    // (`construct`) and `access`; the meaningful op must be the single map.
    const nonStructural = extracted.rog.ops.filter(
      (op) => op.kind !== "construct" && op.kind !== "access",
    );
    const collectionOps = extracted.rog.ops.filter(
      (op) => op.kind === "collection",
    );
    if (collectionOps.length === 0) return null; // no collection → scalar path
    // From here on there IS a collection op. The single-node `$ri-collection-map`
    // path requires the eligible single-bare-map shape; any miss `return null` so
    // the caller continues to the PARTITION path (where the map is a verbatim
    // legacy boundary and the surrounding pure region interprets). The downstream
    // `ELIGIBLE_KINDS` / `unresolved_leaf` gates supply the final fail-closed
    // reason if the partition also declines — so the verdict is deferred, never
    // lost.
    if (collectionOps.length !== 1) return null;
    const mapOp = collectionOps[0];
    if (mapOp.detail.kind !== "collection" || mapOp.detail.op !== "map") {
      // filter / flatMap and any multi-collection shape → partition path.
      return null;
    }

    // The OUTER list input must resolve to a recognized argument/internal link.
    // If extraction could not represent it, it is a `const` placeholder → the
    // single-node path cannot wire it, but the partition keeps the map's ORIGINAL
    // `inputs.list` alias verbatim → defer to the partition.
    if (mapOp.detail.listInput.kind === "const") {
      return null;
    }
    // The map op must be the ONLY non-structural op for the single-node path (no
    // sibling leaves/controls). A map ALONGSIDE other compute is exactly the
    // partition case → defer.
    if (nonStructural.length !== 1 || nonStructural[0] !== mapOp) {
      return null;
    }

    // --- Result must be the bare map op, or a trivial one-field construct ---
    // wrapping it (e.g. `{ mapped: <map> }`) for the single-node path. A result
    // that reads more than the single map output is a downstream-segment shape →
    // defer to the partition.
    if (
      !this.resultIsBareOrTrivialWrap(
        extracted.rog,
        mapOp.id,
        extracted.internalToOp,
      )
    ) {
      return null;
    }

    // --- CRITICAL element-internal gate: coverage.byKind / coverage.nested --
    // (see method doc). `coverage` accounts for the element graph that
    // `rog.ops` discards. The single-node `$ri-collection-map` path INTERPRETS
    // the element per-element, so a pattern/effect/nested-collection element graph
    // would mis-evaluate — decline the single-node path and defer to the partition
    // (legacy map node renders the element verbatim — sound).
    const byKind = extracted.coverage.byKind;
    if ((byKind.pattern ?? 0) > 0) return null;
    if ((byKind.effect ?? 0) > 0) return null;
    // Any collection op beyond the single outer map (a nested collection inside
    // the element) → defer to the partition.
    if ((byKind.collection ?? 0) > 1) return null;
    // The extractor recurses into the element pattern exactly once for a single
    // inline map; >1 means a nested collection element graph the single-node path
    // does not model → defer.
    if (extracted.coverage.nested > 1) return null;

    // --- Locate the raw map node (to reuse its `{list, op}` inputs verbatim) -
    const mapNode = this.findRawMapNode(pattern);
    if (!mapNode) bumpAndThrow("ineligible_opkind");
    const mapNodeInputs = mapNode.inputs as Record<string, unknown>;
    const elementPattern = mapNodeInputs.op;
    if (!isPatternLike(elementPattern)) {
      // A serialized `$patternRef` element (not an inline pattern) is out of
      // scope for the in-memory-element first cut → fall back.
      bumpAndThrow("ineligible_opkind");
    }

    // --- Unscoped-only: reject any non-default scope in list/element graph --
    // The fresh builder attaches the DEFAULT `scope: "space"` (the ambient
    // frame) to ordinary aliases; that is fine. A PerUser/PerSession narrowing
    // (`scope: "user" | "session"`) is the unmodeled indirection this first cut
    // rejects → a distinct `scoped` reason for the oracle's negative axis.
    if (
      hasNonDefaultScope(mapNodeInputs.list) ||
      hasNonDefaultScope(elementPattern)
    ) {
      bumpAndThrow("scoped");
    }
    // RUNTIME element-link scope (cluster: collection per-element result cells
    // not scope-narrowed). The narrowing may not sit STATICALLY on the list-input
    // alias schema — it can arrive via the bound argument DATA (an element link
    // carrying `scope:"user"|"session"`). The per-element evaluator mints each
    // result cell at the parent space (unscoped), so a narrowed element link
    // would not be reproduced. Inspect the RAW argument tree (links preserved)
    // for any non-default scope and fall back. Sound (legacy narrows per element).
    if (
      hasNonDefaultScope(this.readRawArgumentSnapshot(resultCell, setupTx))
    ) {
      bumpAndThrow("scoped");
    }

    // --- Element evaluator must fully resolve (no unresolved leaf ops) ------
    const evaluator = buildElementEvaluator(
      elementPattern as Record<string, unknown>,
      this.interpreterImplRefResolver,
      this.interpreterLiveLeafTrustCheck,
    );
    if (evaluator.unresolvedLeafOps.length > 0) {
      bumpAndThrow("unresolved_leaf");
    }

    // --- Build the synthetic single-node collection pattern ----------------
    // Reuse the ORIGINAL map node's `{list, op, params}` inputs and its output
    // binding (which carries the author-declared scope + item schema downstream
    // `.key(i)` consumers need) verbatim, swapping only the module ref to the
    // registered `$ri-collection-map` builtin. Keeping the original result tree
    // and output binding inherits the exact projection + reactivity for free.
    return {
      argumentSchema: pattern.argumentSchema as JSONSchema,
      resultSchema: pattern.resultSchema as JSONSchema,
      ...(pattern.derivedInternalCells !== undefined
        ? { derivedInternalCells: pattern.derivedInternalCells }
        : {}),
      result: pattern.result,
      nodes: [
        {
          module: {
            type: "ref",
            implementation: "$ri-collection-map",
          } as Module,
          inputs: mapNode.inputs,
          outputs: mapNode.outputs,
        },
      ],
    } satisfies Pattern;
  }

  /**
   * True iff the ROG result is the bare map op's output, or a single-field
   * object/array construct wrapping ONLY that map op's output (peeling a trivial
   * one-field wrapper). Any result that references more than the single map op
   * output is rejected by the caller.
   */
  private resultIsBareOrTrivialWrap(
    rog: Rog,
    mapOpId: OpId,
    internalToOp: Map<string, OpId>,
  ): boolean {
    // A ValueRef "is the bare map output" if it is either an `opOut` of the map
    // op, or an `internal` ref whose name maps (via `internalToOp`) to the map
    // op id (the builder names the map node's output internal cell and the
    // result references it by name, NOT as a positional opOut), with no path.
    const isBareMapOut = (ref: ValueRef): boolean => {
      if (ref.kind === "opOut") {
        return ref.op === mapOpId && ref.path.length === 0;
      }
      if (ref.kind === "internal") {
        return internalToOp.get(ref.name) === mapOpId && ref.path.length === 0;
      }
      return false;
    };

    const result = rog.result;
    // Bare: result is the map op output directly.
    if (isBareMapOut(result)) return true;
    // Trivial wrap: result is a synthesized construct (id < 0) with exactly one
    // field, whose value is the bare map op output.
    if (result.kind === "opOut" && result.op < 0) {
      const wrap = rog.ops.find((op) => op.id === result.op);
      if (!wrap || wrap.detail.kind !== "construct") return false;
      const tmpl = wrap.detail.template;
      const refs = tmpl.shape === "object"
        ? Object.values(tmpl.fields)
        : tmpl.items;
      if (refs.length !== 1) return false;
      return isBareMapOut(refs[0]);
    }
    return false;
  }

  /** Find the single raw `map` ref node in a pattern (the node the collection
   * branch rewrites). Returns undefined if not present (e.g. already lowered or
   * not a top-level map). */
  private findRawMapNode(
    pattern: Pattern,
  ): Pattern["nodes"][number] | undefined {
    for (const node of pattern.nodes) {
      const module = node.module as { type?: string; implementation?: unknown };
      if (module?.type === "ref" && module.implementation === "map") {
        return node;
      }
    }
    return undefined;
  }

  /**
   * Read a snapshot of the result cell's argument value for the interpreter's
   * pure dry-run probe. Untracked (no scheduling tx) and read-only — it must
   * never write, since the probe runs before the fallback decision. Returns
   * `undefined` if the argument cell is not resolvable yet (the probe then runs
   * evalRog against `undefined`, which is a valid input for the eligible
   * vocabulary).
   */
  private readArgumentSnapshot(
    resultCell: Cell<any>,
    tx?: IExtendedStorageTransaction,
  ): unknown {
    const argumentLink = getMetaLink(resultCell, "argument");
    if (!argumentLink) return undefined;
    try {
      let cell = this.runtime.getCellFromLink(argumentLink);
      if (tx) cell = cell.withTx(tx);
      return cell.get();
    } catch {
      return undefined;
    }
  }

  /**
   * Read the RAW argument tree (links preserved, NOT deep-resolved), so the
   * collection probe can inspect the SCOPE carried on per-element input links.
   * `.get()` (used by `readArgumentSnapshot`) navigates links to plain values and
   * loses scope; `getRaw()` keeps the sigil links whose `scope` records a
   * user/session narrowing. Untracked, read-only, fail-soft (returns undefined on
   * any error). Used only to detect a non-default element-link scope the unscoped
   * collection interpreter cannot reproduce.
   */
  private readRawArgumentSnapshot(
    resultCell: Cell<any>,
    tx?: IExtendedStorageTransaction,
  ): unknown {
    const argumentLink = getMetaLink(resultCell, "argument");
    if (!argumentLink) return undefined;
    try {
      // Resolve the argument link to its VALUE node (following the redirect) and
      // read raw so per-element link scopes survive. Read through the in-flight
      // setup tx when provided so a not-yet-committed argument write is visible.
      let cell = this.runtime.getCellFromLink(argumentLink);
      if (tx) cell = cell.withTx(tx);
      return cell.getRaw(
        { lastNode: "value" } as Parameters<typeof cell.getRaw>[0],
      );
    } catch {
      return undefined;
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
      !validateAndCheckOpaqueRefs(result, name) &&
      frame.opaqueRefs.size === 0
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
      // Handler-launched child pattern (receipt-anchored): its result cell is
      // consumed by the receipt / launch contract the interpreter's collapsed
      // result alias does not preserve → force legacy.
      : this.run(tx, resultPattern, undefined, receiptCell, {
        launchedChild: true,
      });

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
        // Launched child (deferred navigateTo / handler result pattern) → legacy.
        { launchedChild: true },
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
      // Action/computed-result child pattern: its result cell is consumed by
      // the launcher contract the interpreter's collapsed result alias does not
      // preserve → force legacy.
      this.run(
        childSetupTx,
        resultPattern,
        undefined,
        resultCell,
        { launchedChild: true },
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
            const maybePromise = value.sync();
            if (maybePromise instanceof Promise) promises.push(maybePromise);
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
    this.substituteOpPatternRefs(moduleRefName, mappedInputBindings);

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
            { preserveLinkOutput: true },
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
          // Propagate the resumed-from-synced-state flag so container-minting
          // builtins (map/filter/flatmap) defer their per-element sub-pattern
          // runs until sync completes too.
          ...(schedulerRehydration.rehydrateFromStorage?.awaitSync
            ? { awaitSync: true }
            : {}),
        },
        processCell,
        this.runtime,
        outputBinding,
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
      awaitSyncBeforeInitialRun: schedulerRehydration.rehydrateFromStorage
        ?.awaitSync,
      // NOTE: a build-time nested pattern node is NOT one of the launched-child
      // contracts (handler `this.run` receipt / navigateTo target). It is a
      // regular child the interpreter may still cover (collection / inlined
      // nested-pattern coverage), so we do NOT set `launchedChild` here. The
      // cross-space variant is independently gated by
      // `patternHasCrossSpaceOrScopeRouting` (which reads the child's own
      // `module.targetSpace` / `module.defaultScope`).
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
