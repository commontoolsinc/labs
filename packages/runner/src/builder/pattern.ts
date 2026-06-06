import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import {
  type CellScope,
  type Frame,
  type ICell,
  isOpaqueRef,
  JSONObject,
  type JSONSchema,
  type JSONValue,
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
import { brandTrustedPattern } from "./pattern-metadata.ts";
import {
  applyArgumentIfcToResult,
  applyInputIfcToOutput,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  type CellAliasResolver,
  moduleToJSON,
  patternToJSON,
  toJSONWithLegacyAliases,
} from "./json-utils.ts";
import { setValueAtPath } from "../path-utils.ts";
import { traverseValue } from "./traverse-utils.ts";
import {
  getDerivedInternalCellManifestKey,
  getStableInternalPathSegment,
  sanitizeSchemaForLinks,
} from "../link-utils.ts";
import { type LegacyAlias } from "../sigil-types.ts";
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

  // Walk through the value. We'll convert any cell results back into cells as
  // we go. Our traverseValue doesn't descend into cells, but we'll recurse on
  // the cell's nodes ourselves. We'll also add any cells we see to allCells,
  // and any nodes to allNodes.
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

  const rootAliases = new Map<unknown, "argument" | "result">();
  const setRootAlias = (
    cell: ICell<unknown> | OpaqueCell<any>,
    alias: "argument" | "result",
  ) => {
    const { cell: root } = cell.export();
    rootAliases.set(cell, alias);
    rootAliases.set(root, alias);
  };

  const inputCell = isCell(inputs) ? inputs : getCellOrThrow(inputs);
  setRootAlias(inputCell, "argument");

  // Add alias for self-reference if used in outputs.
  const selfRefCell = getCellOrThrow(selfRef);
  if (allCells.has(selfRefCell)) {
    setRootAlias(selfRefCell, "result");
  }

  const assignedInternalPartialCauses = new Map<OpaqueCell<any>, JSONValue>();
  let anonymousPartialCauseCount = 0;
  const nextAnonymousPartialCause = (isStream: boolean): JSONObject => {
    const generated = { $generated: anonymousPartialCauseCount++ };
    return isStream ? { ...generated, $kind: "stream" } : generated;
  };
  const hasUsedInternalPartialCause = (partialCause: JSONValue): boolean =>
    Array.from(assignedInternalPartialCauses.values()).some((used) =>
      deepEqual(used, partialCause)
    );
  allCells.forEach((cell) => {
    const { cell: top, path, value, name, external } = cell.export();
    if (
      external || path.length > 0 || rootAliases.has(cell) ||
      rootAliases.has(top) || assignedInternalPartialCauses.has(top)
    ) {
      return;
    }

    const isStream = isRecord(value) && value.$stream === true;
    let partialCause = name === undefined
      ? nextAnonymousPartialCause(isStream)
      : name as JSONValue;
    while (hasUsedInternalPartialCause(partialCause)) {
      const generated = nextAnonymousPartialCause(isStream);
      partialCause = name === undefined
        ? generated
        : { name: name as JSONValue, ...generated };
    }
    assignedInternalPartialCauses.set(top, partialCause);
  });

  const cellReferenceForCell = (
    cell: ICell<unknown> | OpaqueCell<any> | OpaqueRef<any>,
  ): LegacyAlias["$alias"] | undefined => {
    const { cell: top, path, external, scope, schema } = cell.export();
    // If we have an external id, don't bother with all this
    if (external) return undefined;

    // See if we're one of the special cells (result or argument)
    const rootAlias = rootAliases.get(cell) ?? rootAliases.get(top);
    if (rootAlias !== undefined) {
      return {
        cell: rootAlias,
        path,
        ...(scope !== undefined && { scope }),
        ...(schema !== undefined && { schema }),
      };
    }

    // Otherwise, we should be an internal call, and should have partialCause
    const partialCause = assignedInternalPartialCauses.get(top) ??
      assignedInternalPartialCauses.get(cell as OpaqueCell<any>);
    if (partialCause !== undefined) {
      return {
        path,
        partialCause,
        ...(scope !== undefined && { scope }),
        ...(schema !== undefined && { schema }),
      };
    }
  };

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
    const { cell: top, external } = cell.export();
    if (!external && assignedInternalPartialCauses.has(top)) {
      allCellsAndInternalRoots.add(top);
    }
  });
  const derivedInternalCells: Pattern["derivedInternalCells"] = [];
  const derivedInternalPartialCausesByRoot = new Map<
    OpaqueCell<any>,
    JSONValue
  >();
  allCellsAndInternalRoots.forEach((cell) => {
    // Only process roots of extra cells:
    if (cell === (inputs as unknown)) return;
    const { cell: top, path, value, schema, external } = cell.export();
    if (path.length > 0 || external) return;

    const cellReference = cellReferenceForCell(cell);
    if (cellReference === undefined) return;
    if (
      cellReference.partialCause !== undefined &&
      cellReference.path.length === 0
    ) {
      const partialCause = cellReference.partialCause!;
      derivedInternalPartialCausesByRoot.set(top, partialCause);
      derivedInternalCells.push({
        partialCause,
        ...(schema !== undefined && { schema }),
        ...(value !== undefined && { initial: value as JSONValue }),
      });
    }
    if (value !== undefined) {
      const initialPath = (typeof cellReference.cell === "string")
        ? [cellReference.cell, ...cellReference.path]
        : [
          "internal",
          getDerivedInternalCellManifestKey({
            partialCause: cellReference.partialCause!,
          }),
          ...cellReference.path,
        ];
      setValueAtPath(initial, initialPath, value);
    }
    if (schema !== undefined && cellReference.partialCause !== undefined) {
      setSchemaAtPath(
        internalSchema,
        [getDerivedInternalCellManifestKey({
          partialCause: cellReference.partialCause!,
        })],
        schema,
      );
      hasInternalSchema = true;
    }
  });
  const resolveCellAlias: CellAliasResolver = (
    cell, // opaque cell that we found
    serializationPath, // path where we encountered the cell
    ignoreSelfAliases,
  ) => {
    const { cell: top } = cell.export();
    const cellReference = cellReferenceForCell(cell);
    if (cellReference === undefined) return undefined;
    if (cellReference.cell !== undefined) {
      // make up a fake path that looks like cell type followed by the path
      // this can only match argument and result aliases, since internal
      // aliases link directly to their target cell.
      const cellPath = [cellReference.cell, ...cellReference.path];
      if (
        ignoreSelfAliases &&
        serializationPath.length === cellPath.length &&
        serializationPath.every((part, index) => part === cellPath[index])
      ) {
        // this is a reference to the cell itself, so we shouldn't alias it or
        // we'll have an infinite loop. Instead, we'll convert the alias to
        // undefined, effectively removing it.
        return null;
      }
    }

    const sanitizedSchema = cellReference.schema !== undefined
      ? sanitizeSchemaForLinks(cellReference.schema, { keepStreams: true })
      : undefined;
    const partialCause = derivedInternalPartialCausesByRoot.get(top);
    if (partialCause !== undefined) {
      if (!deepEqual(partialCause, cellReference.partialCause)) {
        throw new Error(
          `Inconsistent partial cause for cell. This is a bug in the pattern serializer, please report it.\n` +
            `Cell path: ${cell.export().path.join(".")}\n` +
            `Existing partial cause: ${JSON.stringify(partialCause)}\n` +
            `New partial cause: ${JSON.stringify(cellReference.partialCause)}`,
        );
      }
      return {
        $alias: {
          ...cellReference,
          ...(sanitizedSchema !== undefined && { schema: sanitizedSchema }),
        },
      };
    } else if (
      cellReference.cell === "argument" || cellReference.cell === "result"
    ) {
      return {
        $alias: {
          ...cellReference,
          ...(sanitizedSchema !== undefined && { schema: sanitizedSchema }),
        },
      };
    }
  };
  // Creates a query (i.e. aliases) into the cells for the result
  const result = toJSONWithLegacyAliases(
    outputs ?? {},
    resolveCellAlias,
    true,
  )!;

  const argumentSchema: JSONSchema = argumentSchemaArg ?? true;

  const resultSchema =
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) || {};

  const serializedNodes = Array.from(allNodes).map((node) => {
    const module = toJSONWithLegacyAliases(
      node.module,
      resolveCellAlias,
      false,
    ) as unknown as Module;
    const inputs = toJSONWithLegacyAliases(
      node.inputs,
      resolveCellAlias,
      false,
    )!;
    const outputs = toJSONWithLegacyAliases(
      node.outputs,
      resolveCellAlias,
      false,
    )!;
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
    ...(derivedInternalCells.length > 0 ? { derivedInternalCells } : {}),
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

    factory.asScope = (scope: CellScope) =>
      makePatternFactory(scope, defaultSpace);
    factory.inSpace = (space?: string | unknown) =>
      makePatternFactory(defaultScope, space ?? "");
    // Provenance brand: only the trusted builder stamps a pattern. Trust-granting
    // sites check `isTrustedPattern` so a `__cf_data`-forged pattern-shaped
    // object cannot acquire program / verified-load-id metadata.
    brandTrustedPattern(factory);
    return factory;
  };

  const patternFactory = makePatternFactory();

  return patternFactory;
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
    return space as MemorySpace;
  }
  if (isCell(space)) {
    return space.getAsNormalizedFullLink().space;
  }
  const runtime = frame?.runtime;
  if (!runtime) return undefined;
  const name = typeof space === "string" && space.length > 0
    ? space
    : anonymousSpaceName(frame!);
  const resolved = runtime.resolveSpaceNameSync(name);
  if (resolved !== undefined) return resolved;
  (frame!.pendingSpaceNames ??= new Set<string>()).add(name);
  return undefined;
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
