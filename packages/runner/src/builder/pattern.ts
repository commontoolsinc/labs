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
import { isCell, setCellInSpaceAnnotation } from "../cell.ts";
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
        const { frame, nodes } = value.export();
        if (isOpaqueRef(value) && frame !== getTopFrame()) {
          throw new Error(
            "Cannot access cell via closure - reactive dependencies must be explicit parameters\n" +
              "help: use computed() for automatic extraction, or pass cells as parameters to lift()",
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
    paths.set(selfRefCell, ["resultRef"]);
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
        if (defaultSpace !== undefined) {
          setCellInSpaceAnnotation(outputs, defaultSpace);
        }
        const targetSpace = resolveSynchronousTargetSpace(defaultSpace);
        if (targetSpace !== undefined) {
          module.targetSpace = targetSpace;
        }
        const node: NodeRef = {
          module,
          inputs,
          outputs,
          frame: getTopFrame(),
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

function resolveSynchronousTargetSpace(
  space: unknown,
): MemorySpace | undefined {
  if (typeof space === "string" && /^did:[^:]+:.+/.test(space)) {
    return space as MemorySpace;
  }
  if (isCell(space)) {
    return space.getAsNormalizedFullLink().space;
  }
  return undefined;
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
