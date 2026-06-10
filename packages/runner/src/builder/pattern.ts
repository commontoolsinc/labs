import { isRecord } from "@commonfabric/utils/types";
import {
  type CellScope,
  type Frame,
  type ICell,
  isOpaqueRef,
  type JSONSchema,
  type Module,
  type Node,
  type NodeRef,
  type Opaque,
  type OpaqueCell,
  type OpaqueRef,
  type Pattern,
  type PatternFactory,
  type RequireDefaults,
  type SchemaWithoutCell,
  SELF,
  type toJSON,
  type UnsafeBinding,
} from "./types.ts";
import { opaqueRef } from "./opaque-ref.ts";
import { brandTrustedPattern, noteDerivedCopy } from "./pattern-metadata.ts";
import {
  applyArgumentIfcToResult,
  applyInputIfcToOutput,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  moduleToJSON,
  patternToJSON,
  toJSONWithLegacyAliases,
} from "./json-utils.ts";
import { setValueAtPath } from "../path-utils.ts";
import { traverseValue } from "./traverse-utils.ts";
import { sanitizeSchemaForLinks } from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell, setCellUnlinkedSpace } from "../cell.ts";
import { createRef } from "../create-ref.ts";
import { toURI } from "../uri-utils.ts";
import { closureCaptureErrorMessage } from "./closure-capture-diagnostic.ts";
import { Runtime } from "../runtime.ts";
import type { ImplementationIdentity } from "../cfc/types.ts";
import {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { hardenVerifiedFunction } from "../sandbox/function-hardening.ts";

/** Declare a pattern
 *
 * @param fn A function that creates the pattern graph
 * @param argumentSchema An optional JSONSchema for the pattern inputs
 * @param resultSchema An optional JSONSchema for the pattern outputs
 *
 * @returns A pattern node factory that also serializes as pattern.
 */

// Function-only overloads (most common)
export function pattern<T>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<any> },
  ) => any,
): PatternFactory<T, ReturnType<typeof fn>>;
export function pattern<T, R>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
): PatternFactory<T, R>;
// Function + schemas overloads
export function pattern<S extends JSONSchema>(
  fn: (
    input: OpaqueRef<SchemaWithoutCell<S>> & {
      [SELF]: OpaqueRef<any>;
    },
  ) => any,
  argumentSchema: S,
): PatternFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;
export function pattern<S extends JSONSchema, R>(
  fn: (
    input: OpaqueRef<SchemaWithoutCell<S>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
  argumentSchema: S,
): PatternFactory<SchemaWithoutCell<S>, R>;
export function pattern<S extends JSONSchema, RS extends JSONSchema>(
  fn: (
    input: OpaqueRef<SchemaWithoutCell<S>> & {
      [SELF]: OpaqueRef<SchemaWithoutCell<RS>>;
    },
  ) => Opaque<SchemaWithoutCell<RS>>,
  argumentSchema: S,
  resultSchema: RS,
): PatternFactory<SchemaWithoutCell<S>, SchemaWithoutCell<RS>>;
// Explicit T with optional schemas (e.g. pattern<{ x: number }>(fn, schema))
export function pattern<T>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<any> },
  ) => any,
  argumentSchema: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, ReturnType<typeof fn>>;
export function pattern<T, R>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
  argumentSchema: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R>;
// Implementation signature
export function pattern<T, R>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R> {
  hardenVerifiedFunction(fn);

  // The pattern graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts OpaqueRef<>) and/or default
  // values.
  const frame = pushFrame();

  const inputs = opaqueRef<RequireDefaults<T>>(
    undefined,
    argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = opaqueRef<R>(
    undefined,
    resultSchema as JSONSchema | undefined,
  );

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  let result;
  try {
    const outputs = fn!(
      inputs as OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
    );

    applyInputIfcToOutput(inputs, outputs);

    result = factoryFromPattern<T, R>(
      argumentSchema,
      resultSchema,
      inputs,
      outputs,
    );
  } finally {
    popFrame(frame);
  }
  return result;
}

// Same as above, but assumes the caller manages the frame
export function patternFromFrame<T, R>(
  fn: (
    input: OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
  ) => Opaque<R>,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R> {
  const inputs = opaqueRef<RequireDefaults<T>>(
    undefined,
    argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = opaqueRef<R>(undefined, resultSchema);

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  const outputs = fn(
    inputs as OpaqueRef<RequireDefaults<T>> & { [SELF]: OpaqueRef<R> },
  );
  return factoryFromPattern<T, R>(
    argumentSchema,
    resultSchema,
    inputs,
    outputs,
  );
}

function factoryFromPattern<T, R>(
  argumentSchemaArg: JSONSchema | undefined,
  resultSchemaArg: JSONSchema | undefined,
  inputs: OpaqueRef<RequireDefaults<T>>,
  outputs: Opaque<R>,
): PatternFactory<T, R> {
  // Capture selfRef before collectCellsAndNodes transforms inputs from OpaqueRef to Cell
  // (collectCellsAndNodes replaces OpaqueRef proxies with their underlying Cells,
  // and SELF access only works through the OpaqueRef proxy)
  const selfRef = (inputs as unknown as { [SELF]: OpaqueRef<any> })[SELF];

  // Traverse the value, collect all mentioned nodes and cells
  const allCells = new Set<ICell<unknown>>();
  const allNodes = new Set<NodeRef>();

  const collectCellsAndNodes = (value: Opaque<unknown>) =>
    traverseValue(value, (value) => {
      if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
      if (isCell(value) && !allCells.has(value)) {
        const { frame, nodes, path, scope, name } = value.export();
        if (isOpaqueRef(value) && frame !== getTopFrame()) {
          throw new Error(
            closureCaptureErrorMessage({
              capturedCell: { path, scope, name },
            }),
          );
        }
        allCells.add(value);
        nodes.forEach((node: NodeRef) => {
          if (!allNodes.has(node)) {
            allNodes.add(node);
            node.inputs = collectCellsAndNodes(node.inputs);
            node.outputs = collectCellsAndNodes(node.outputs);
          }
        });
      }
      return value;
    });
  inputs = collectCellsAndNodes(inputs);
  outputs = collectCellsAndNodes(outputs);

  applyInputIfcToOutput(inputs, outputs);

  // Fill in reasonable names for all cells, where possible:

  const usedNames = new Set<string>();
  allCells.forEach((cell) => {
    const existingName = getStableInternalPathSegment(cell.export().name);
    if (typeof existingName === "string") usedNames.add(existingName);
  });

  // First from results
  if (isRecord(outputs) && !isCell(outputs)) {
    Object.entries(outputs).forEach(([key, value]: [string, unknown]) => {
      if (isCell(value)) {
        const exported = value.export();
        if (
          !exported.path.length &&
          !exported.name &&
          !usedNames.has(key)
        ) {
          value.for(key, true); // allowIfSet=true to not override existing causes
          usedNames.add(key);
        }
      }
    });
  }

  // Then from assignments in nodes
  allCells.forEach((cell) => {
    if (cell.export().path.length) return;
    cell.export().nodes.forEach((node: NodeRef) => {
      if (isRecord(node.inputs)) {
        Object.entries(node.inputs).forEach(([key, input]) => {
          if (
            isOpaqueRef(input) && input.export().cell === cell &&
            !cell.export().name && !usedNames.has(key)
          ) {
            cell.for(key, true); // allowIfSet=true to not override existing causes
            usedNames.add(key);
          }
        });
      }
    });
  });

  // Also collect otherwise disconnected cells and nodes, e.g. those that are
  // assigned to cells via .set or .push and aren't otherwise connected.
  getTopFrame()?.opaqueRefs.forEach((ref) => collectCellsAndNodes(ref));

  // Then assign paths on the pattern cell for all cells. For now we just assign
  // incremental counters, since we don't have access to the original variable
  // names. Later we might do something more clever by analyzing the code (we'll
  // want that anyway for extracting schemas from TypeScript).
  const paths = new Map<OpaqueRef<any>, PropertyKey[]>();

  // Add the inputs default path
  paths.set(inputs, ["argument"]);

  // Add path for self-reference if used in outputs
  // Note: selfRef is an OpaqueRef, but allCells contains Cells (after getCellOrThrow conversion)
  // So we need to get the underlying cell for comparison
  const selfRefCell = getCellOrThrow(selfRef);
  if (allCells.has(selfRefCell)) {
    paths.set(selfRefCell, ["result"]);
  }

  // Add paths for all the internal cells
  // TODO(seefeld): Infer more stable identifiers
  let count = 0;
  const usedInternalPathSegments = new Set<string>();
  allCells.forEach((cell) => {
    if (paths.has(cell)) return;
    const { cell: top, path, value, name, external } = cell.export();
    if (!external) {
      if (!paths.has(top)) {
        const stableName = getStableInternalPathSegment(name);
        // HACK(seefeld): For unnamed cells, we've run into an issue when the
        // order changes that a stream might clobber a previously used
        // non-stream, which means the default value won't be assigned and the
        // cell won't be treated as stream. So we'll namespace those separately.
        const streamMarker = isRecord(value) && value.$stream === true
          ? "stream"
          : "";
        // These paths that start with internal will be converted to cell: "internal", path: rest
        let internalPathSegment = stableName ??
          `__#${count++}${streamMarker}`;
        let internalPathKey = String(internalPathSegment);
        while (usedInternalPathSegments.has(internalPathKey)) {
          internalPathSegment =
            `${internalPathKey}__#${count++}${streamMarker}`;
          internalPathKey = String(internalPathSegment);
        }
        usedInternalPathSegments.add(internalPathKey);
        paths.set(top, ["internal", internalPathSegment]);
      }
      if (path.length) paths.set(cell, [...paths.get(top)!, ...path]);
    }
  });

  // Creates a query (i.e. aliases) into the cells for the result
  const result = toJSONWithLegacyAliases(outputs ?? {}, paths, true)!;

  // Set initial values for all cells, add non-inputs defaults
  const initial: any = {};
  const internalSchema: Record<string, any> = {
    type: "object",
    properties: {},
  };
  let hasInternalSchema = false;
  const allCellsAndInternalRoots = new Set<ICell<unknown> | OpaqueRef<any>>(
    allCells,
  );
  allCells.forEach((cell) => {
    const { cell: top } = cell.export();
    if (paths.has(top)) allCellsAndInternalRoots.add(top);
  });
  allCellsAndInternalRoots.forEach((cell) => {
    // Only process roots of extra cells:
    if (cell === (inputs as unknown)) return;
    const { path, value, schema, external } = cell.export();
    if (path.length > 0 || external) return;

    const cellPath = paths.get(cell)!;
    if (value !== undefined) setValueAtPath(initial, cellPath, value);
    if (schema !== undefined && cellPath[0] === "internal") {
      setSchemaAtPath(internalSchema, cellPath.slice(1), schema);
      hasInternalSchema = true;
    }
  });

  const argumentSchema: JSONSchema = argumentSchemaArg ?? true;

  const resultSchema =
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) || {};

  const serializedNodes = Array.from(allNodes).map((node) => {
    const module = toJSONWithLegacyAliases(
      node.module,
      paths,
    ) as unknown as Module;
    const inputs = toJSONWithLegacyAliases(node.inputs, paths)!;
    const outputs = toJSONWithLegacyAliases(node.outputs, paths)!;
    return { module, inputs, outputs } satisfies Node;
  });

  const pattern: Pattern & toJSON = {
    argumentSchema: sanitizeSchemaForLinks(argumentSchema, {
      keepStreams: true,
      keepAsCell: true,
    }),
    resultSchema: sanitizeSchemaForLinks(resultSchema, { keepStreams: true }),
    ...(hasInternalSchema
      ? {
        internalSchema: sanitizeSchemaForLinks(
          internalSchema as JSONSchema,
          { keepStreams: true, keepAsCell: true },
        ),
      }
      : {}),
    initial,
    result,
    nodes: serializedNodes,
    // Important that this refers to patternFactory, as .program will be set on
    // pattern afterwards (see factory.ts:exportsCallback)
    toJSON: () => patternToJSON(patternFactory),
  };

  const makePatternFactory = (
    defaultScope?: CellScope,
    defaultSpace?: string | unknown,
  ): PatternFactory<T, R> => {
    const factory = Object.assign(
      (inputs: Opaque<T>): OpaqueRef<R> => {
        const module: Module & toJSON = {
          type: "pattern",
          implementation: factory,
          ...(factory.defaultScope !== undefined
            ? { defaultScope: factory.defaultScope }
            : {}),
          toJSON: () => moduleToJSON(module),
        };

        const outputs = opaqueRef<R>();
        const frame = getTopFrame();
        if (defaultSpace !== undefined) {
          const targetSpace = resolveInSpaceTargetSpace(defaultSpace, frame);
          if (targetSpace !== undefined) {
            setCellUnlinkedSpace(outputs, targetSpace);
            module.targetSpace = targetSpace;
          }
        }
        const node: NodeRef = {
          module,
          inputs,
          outputs,
          frame,
        };

        connectInputAndOutputs(node);
        (outputs as OpaqueCell<R>).connect(node);

        return outputs;
      },
      {
        ...pattern,
        ...(defaultScope !== undefined ? { defaultScope } : {}),
        toJSON: () => patternToJSON(factory),
      } as Pattern & toJSON,
    ) as PatternFactory<T, R>;

    // `asScope` / `inSpace` mint fresh factory objects; record them as
    // derivation copies so identity facts resolve through to the root factory
    // — in particular the content-addressed artifact entry ref, which is what
    // lets an `inSpace(...)` child piece carry `patternIdentity` meta and have
    // its closures replicated into its own space (CT-1687).
    factory.asScope = (scope: CellScope) => {
      const derived = makePatternFactory(scope, defaultSpace);
      noteDerivedCopy(derived, factory);
      return derived;
    };
    factory.inSpace = (space?: string | unknown) => {
      const derived = makePatternFactory(defaultScope, space ?? "");
      noteDerivedCopy(derived, factory);
      return derived;
    };
    // Provenance brand: only the trusted builder stamps a pattern. Trust-granting
    // sites check `isTrustedPattern` so a `__cf_data`-forged pattern-shaped
    // object cannot acquire program / verified-load-id metadata.
    brandTrustedPattern(factory);
    return factory;
  };

  const patternFactory = makePatternFactory();

  return patternFactory;
}

function getStableInternalPathSegment(cause: unknown): PropertyKey | undefined {
  if (
    typeof cause === "string" ||
    typeof cause === "number" ||
    typeof cause === "symbol"
  ) {
    return cause;
  }

  if (isRecord(cause) && "stream" in cause) {
    return `stream:${formatStableCauseSegment(cause.stream)}`;
  }

  if (cause !== undefined) {
    return formatStableCauseSegment(cause);
  }

  return undefined;
}

/**
 * Resolves a `PatternFactory.inSpace(...)` target to a concrete space DID at
 * graph-construction time.
 *
 * - A DID string or a cell resolves synchronously.
 * - A named string (or the anonymous case below) is resolved from the runtime's
 *   space-name cache. On a cache miss the name is recorded on the frame as
 *   pending and `undefined` is returned; the runner resolves pending names after
 *   the run and re-runs the handler/action (RetryImmediately), at which point
 *   the cache hits and the target resolves synchronously.
 * - The anonymous case (`inSpace()` / empty string) derives a stable per-call
 *   name by hashing the frame's cause together with a per-frame counter, so each
 *   call site gets its own deterministic space that survives re-runs — mirroring
 *   how cell ids are derived from causes.
 */
function resolveInSpaceTargetSpace(
  space: unknown,
  frame: Frame | undefined,
): MemorySpace | undefined {
  if (typeof space === "string" && /^did:[^:]+:.+/.test(space)) {
    return optIntoInSpaceMultiSpaceCommit(frame, space as MemorySpace);
  }
  if (isCell(space)) {
    return optIntoInSpaceMultiSpaceCommit(
      frame,
      space.getAsNormalizedFullLink().space,
    );
  }
  const runtime = frame?.runtime;
  if (!runtime) return undefined;
  const name = typeof space === "string" && space.length > 0
    ? space
    : anonymousSpaceName(frame!);
  const resolved = runtime.resolveSpaceNameSync(name);
  if (resolved !== undefined) {
    return optIntoInSpaceMultiSpaceCommit(frame, resolved);
  }
  (frame!.pendingSpaceNames ??= new Set<string>()).add(name);
  return undefined;
}

/**
 * Using `.inSpace(...)` is the opt-in for cross-space writes: a handler/action
 * that materializes a child in another space must be allowed to commit that
 * child's space alongside the space it's writing into (e.g. appending a profile
 * link to the home `profiles` list, where each profile lives in its own space).
 *
 * We enable the multi-space commit the moment the target space resolves — during
 * the handler body, before the cross-space write executes — so the write
 * isolation guard doesn't reject it. We opt in even when the space DID is already
 * cached (the post-retry success run), and accumulate every distinct child space
 * (ordered before the parent) so an array that already holds cross-space links
 * can grow by another element.
 */
function optIntoInSpaceMultiSpaceCommit(
  frame: Frame | undefined,
  targetSpace: MemorySpace,
): MemorySpace {
  const tx = frame?.tx;
  const parentSpace = frame?.space;
  if (tx && parentSpace && targetSpace !== parentSpace) {
    frame?.runtime?.runner.enableCrossSpaceChildCommit(
      tx,
      targetSpace,
      parentSpace,
    );
  }
  return targetSpace;
}

/**
 * Derives a stable, unique name for an anonymous `inSpace()` call from the
 * frame's cause and a per-frame counter, so repeated calls in one run get
 * distinct spaces while re-runs of the same call site stay deterministic.
 *
 * Determinism caveat: the per-frame counter is position-based, so a handler
 * must call `inSpace()` the same number of times (and in the same order) on
 * every run for a given logical child to keep mapping to the same space. A
 * handler that conditionally varies its anonymous `inSpace()` call count across
 * reactive re-runs would remap a child to a different space and orphan its prior
 * data. Deterministic handler bodies (the norm) are unaffected; name your spaces
 * with `inSpace("name")` if call counts may vary.
 */
function anonymousSpaceName(frame: Frame): string {
  const ordinal = frame.inSpaceCounter ?? 0;
  frame.inSpaceCounter = ordinal + 1;
  return toURI(createRef({ inSpace: ordinal }, frame.cause));
}

function formatStableCauseSegment(cause: unknown): string {
  if (typeof cause === "string") return cause;
  if (
    typeof cause === "number" ||
    typeof cause === "boolean" ||
    cause === null
  ) {
    return String(cause);
  }

  try {
    return JSON.stringify(cause) ?? String(cause);
  } catch {
    return String(cause);
  }
}

const frames: Frame[] = [];

export function pushFrame(frame: Partial<Frame> = {}): Frame {
  const parent = getTopFrame();

  const result = {
    parent,
    opaqueRefs: new Set(),
    generatedIdCounter: 0,
    ...(parent?.verifiedLoadId && { verifiedLoadId: parent.verifiedLoadId }),
    ...(parent?.implementationIdentity && {
      implementationIdentity: parent.implementationIdentity,
    }),
    ...(parent?.runtime && { runtime: parent.runtime }),
    ...(parent?.tx && { tx: parent.tx }),
    ...(parent?.space && { space: parent.space }),
    ...(parent?.sourceLocationContext && {
      sourceLocationContext: parent.sourceLocationContext,
    }),
    ...frame,
  };

  frames.push(result);
  return result;
}

export function pushFrameFromCause(
  cause: any,
  props: {
    unsafe_binding?: UnsafeBinding;
    inHandler?: boolean;
    verifiedLoadId?: string;
    implementationIdentity?: ImplementationIdentity;
    runtime?: Runtime;
    tx?: IExtendedStorageTransaction;
    space?: MemorySpace;
  },
): Frame {
  const parent = getTopFrame();
  const { unsafe_binding, inHandler, runtime, tx, space, verifiedLoadId } =
    props;

  // If no runtime provided, try to inherit from parent (may be undefined during construction)
  const frameRuntime = runtime ?? parent?.runtime;
  const frameTx = tx ?? unsafe_binding?.tx ?? parent?.tx;
  const frameSpace = space ?? unsafe_binding?.space ?? parent?.space;

  const frame = {
    parent,
    cause,
    generatedIdCounter: 0,
    opaqueRefs: new Set(),
    ...(parent?.verifiedLoadId && { verifiedLoadId: parent.verifiedLoadId }),
    ...(parent?.implementationIdentity && {
      implementationIdentity: parent.implementationIdentity,
    }),
    ...(verifiedLoadId && { verifiedLoadId }),
    ...(props.implementationIdentity && {
      implementationIdentity: props.implementationIdentity,
    }),
    ...(frameRuntime && { runtime: frameRuntime }),
    ...(frameSpace && { space: frameSpace }),
    ...(frameTx && { tx: frameTx }),
    ...(parent?.sourceLocationContext && {
      sourceLocationContext: parent.sourceLocationContext,
    }),
    ...(inHandler && { inHandler: true }),
    ...(unsafe_binding ? { unsafe_binding } : {}),
  };
  frames.push(frame);
  return frame;
}

export function popFrame(frame?: Frame): void {
  if (!frame) {
    frames.pop();
    return;
  }

  // If frame is at top, pop normally
  if (getTopFrame() === frame) {
    frames.pop();
    return;
  }

  // Frame not at top - this can happen during navigation when a new runtime
  // is created before the old one finishes disposing. Find and remove it.
  const index = frames.indexOf(frame);
  if (index !== -1) {
    frames.splice(index, 1);
  }
  // If frame not found, it was already removed - that's fine
}

export function getTopFrame(): Frame | undefined {
  return frames.length ? frames[frames.length - 1] : undefined;
}

const setSchemaAtPath = (
  schema: Record<string, any>,
  path: readonly PropertyKey[],
  value: JSONSchema,
): void => {
  if (path.length !== 1) {
    throw new Error(
      `Internal cell schemas must be leaf paths, got ${path.length} segments`,
    );
  }
  if (typeof path[0] === "symbol") {
    throw new Error("Internal cell schema paths cannot use symbol keys");
  }
  if (schema.$ref !== undefined) {
    throw new Error("Cannot add internal cell schemas to a $ref schema");
  }
  if (schema.type !== undefined && schema.type !== "object") {
    throw new Error("Internal cell schema root must be an object schema");
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    throw new Error("Internal cell schema properties must be an object");
  }

  schema.type ??= "object";
  schema.properties ??= {};
  const segment = String(path[0]);
  if (segment in schema.properties) {
    throw new Error(`Duplicate internal cell schema path: ${segment}`);
  }
  schema.properties[segment] = value;
};

/** The full type of the `pattern` function including all overloads. */
export type PatternBuilder = typeof pattern;
