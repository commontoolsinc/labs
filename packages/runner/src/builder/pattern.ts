import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import { addRequiredSchemaPaths } from "@commonfabric/data-model/schema-utils";
import {
  isAdmittedFabricFactory,
  registerFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  type CellScope,
  type DerivedInternalCellDescriptor,
  type FactoryInput,
  type Frame,
  type ICell,
  isModule,
  type InternalPatternFactory,
  isReactive,
  JSONObject,
  type JSONSchema,
  type JSONValue,
  type Module,
  type Node,
  type NodeRef,
  type OpaqueCell,
  type Pattern,
  type PatternFactory,
  type Reactive,
  type RequireDefaults,
  type Schema,
  type SchemaWithoutCell,
  SELF,
  type toJSON,
  type UnsafeBinding,
} from "./types.ts";
import { reactive } from "./reactive.ts";
import {
  bindFactoryRootToken,
  brandTrustedPattern,
  type FrameworkProvidedPath,
  getDurableArtifactRefForRootToken,
  noteDerivedCopy,
  registerFactoryStateDeriver,
  setFrameworkProvidedPaths,
} from "./pattern-metadata.ts";
import {
  applyArgumentIfcToResult,
  applyInputIfcToOutput,
  connectInputAndOutputs,
} from "./node-utils.ts";
import {
  type CellAliasResolver,
  patternToJSON,
  serializePatternGraph,
  toJSONWithAliasBindings,
} from "./json-utils.ts";
import { traverseValue } from "./traverse-utils.ts";
import {
  REPLAYABLE_BUILTIN_REFS,
  SUBPATTERN_ARGUMENT_BUILTIN_REFS,
} from "./builtin-replayability.ts";
import {
  getStableInternalPathSegment,
  KeepAsCell,
  sanitizeSchemaForLinks,
} from "../link-utils.ts";
import { type AliasBinding } from "../sigil-types.ts";
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
import { assertValidPatternParams } from "./factory-params.ts";

type CompilerPatternCallback = (...args: any[]) => unknown;

// Compiler-only capability: transformed callbacks receive their private
// closure schema through this side table. Keeping the association off the
// function object makes the metadata non-forgeable by serialized values and
// lets the helper return the original callback without changing pattern()'s
// public arity.
const patternParamsSchemas = new WeakMap<CompilerPatternCallback, JSONSchema>();
const callbackFrameworkProvidedPaths = new WeakMap<
  CompilerPatternCallback,
  readonly FrameworkProvidedPath[]
>();

export function withPatternParamsSchema<T extends CompilerPatternCallback>(
  callback: T,
  schema: JSONSchema,
): T {
  patternParamsSchemas.set(callback, schema);
  return callback;
}

function readPatternParamsSchema(
  callback: CompilerPatternCallback,
): JSONSchema | undefined {
  const hasParamsSlot = patternParamsSchemas.has(callback);
  if (!hasParamsSlot && callback.length > 1) {
    throw new Error(
      "Pattern second callback parameter requires compiler metadata",
    );
  }
  return hasParamsSlot ? patternParamsSchemas.get(callback)! : undefined;
}

/**
 * Pattern invocation outputs are a view over the child pattern's result doc.
 * The authored result schema remains the factory's public contract, but its
 * `scope` keywords cannot be applied to that view: returned cells are stored as
 * links, and re-applying the declared scope to the containing result path would
 * address a new scoped slot instead of following the returned link.
 *
 * Keep all other contract metadata, including stream wrappers and nested
 * factory contracts. `asFactory` is copied as an atomic contract because scope
 * declarations inside its argument/result schemas describe the future factory
 * invocation rather than this result view.
 */
function scopeSilentResultViewSchema(schema: JSONSchema): JSONSchema {
  if (schema === true || schema === false) return schema;
  const seen = new WeakMap<object, JSONSchema>();
  const schemaMaps = [
    "$defs",
    "definitions",
    "properties",
    "patternProperties",
    "dependentSchemas",
  ] as const;
  const schemaArrays = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
  const schemaValues = [
    "additionalProperties",
    "unevaluatedProperties",
    "unevaluatedItems",
    "propertyNames",
    "items",
    "contains",
    "not",
    "if",
    "then",
    "else",
    "contentSchema",
  ] as const;

  const visit = (current: JSONSchema): JSONSchema => {
    if (current === true || current === false) return current;
    const cached = seen.get(current);
    if (cached !== undefined) return cached;

    const { scope: _scope, ...result } = current;
    seen.set(current, result);
    const currentRecord = current as Record<string, unknown>;
    const resultRecord = result as Record<string, unknown>;

    for (const key of schemaMaps) {
      const map = currentRecord[key];
      if (!isRecord(map)) continue;
      resultRecord[key] = Object.fromEntries(
        Object.entries(map).map(([name, nested]) => [
          name,
          visit(nested as JSONSchema),
        ]),
      );
    }
    for (const key of schemaArrays) {
      const entries = currentRecord[key];
      if (!Array.isArray(entries)) continue;
      resultRecord[key] = entries.map((entry) => visit(entry as JSONSchema));
    }
    for (const key of schemaValues) {
      const nested = currentRecord[key];
      if (nested === undefined || Array.isArray(nested)) continue;
      if (typeof nested === "boolean" || isRecord(nested)) {
        resultRecord[key] = visit(nested as JSONSchema);
      }
    }
    if (Array.isArray(current.asCell)) {
      result.asCell = current.asCell.map((entry) => {
        if (!isRecord(entry)) return entry;
        const { scope: _scope, ...scopeSilentEntry } = entry;
        return scopeSilentEntry;
      });
    }

    return result;
  };

  return visit(schema);
}

export function withFrameworkProvidedPaths<
  T extends CompilerPatternCallback,
>(
  callback: T,
  paths: readonly FrameworkProvidedPath[],
): T {
  callbackFrameworkProvidedPaths.set(callback, normalizeFrameworkPaths(paths));
  return callback;
}

export function readFrameworkProvidedPaths(
  callback: unknown,
): readonly FrameworkProvidedPath[] {
  return typeof callback === "function"
    ? callbackFrameworkProvidedPaths.get(
      callback as CompilerPatternCallback,
    ) ?? []
    : [];
}

function normalizeFrameworkPaths(
  paths: readonly FrameworkProvidedPath[],
): readonly FrameworkProvidedPath[] {
  const normalized: string[][] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    if (!Array.isArray(path) || path.length === 0) {
      throw new TypeError("FrameworkProvided paths must be non-empty arrays");
    }
    const copy = path.map((segment) => {
      if (
        typeof segment !== "string" || segment.length === 0 ||
        segment === "*" || segment === "[]" ||
        segment === "__proto__" || segment === "prototype" ||
        segment === "constructor"
      ) {
        throw new TypeError("Invalid FrameworkProvided path segment");
      }
      return segment;
    });
    const key = JSON.stringify(copy);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(copy);
  }
  normalized.sort((left, right) =>
    utf8Compare(JSON.stringify(left), JSON.stringify(right))
  );
  return normalized;
}

function addFrameworkPathsToSchema(
  schema: JSONSchema,
  paths: readonly FrameworkProvidedPath[],
): JSONSchema {
  return addRequiredSchemaPaths(schema, normalizeFrameworkPaths(paths));
}

type PatternParamsRoot = {
  value: Reactive<unknown>;
  schema: JSONSchema;
};

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
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<any> },
  ) => any,
): PatternFactory<T, ReturnType<typeof fn>>;
export function pattern<T, R>(
  fn: (
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
): PatternFactory<T, R>;
// Function + schemas overloads
export function pattern<S extends JSONSchema>(
  fn: (
    input: Reactive<SchemaWithoutCell<S>> & {
      [SELF]: Reactive<any>;
    },
  ) => any,
  argumentSchema: S,
): PatternFactory<SchemaWithoutCell<S>, ReturnType<typeof fn>>;
export function pattern<S extends JSONSchema, R>(
  fn: (
    input: Reactive<SchemaWithoutCell<S>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
  argumentSchema: S,
): PatternFactory<SchemaWithoutCell<S>, R>;
export function pattern<S extends JSONSchema, RS extends JSONSchema>(
  fn: (
    input: Reactive<SchemaWithoutCell<S>> & {
      [SELF]: Reactive<Schema<RS>>;
    },
  ) => FactoryInput<Schema<RS>>,
  argumentSchema: S,
  resultSchema: RS,
): PatternFactory<SchemaWithoutCell<S>, Schema<RS>>;
// Explicit T with optional schemas (e.g. pattern<{ x: number }>(fn, schema))
export function pattern<T>(
  fn: (
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<any> },
  ) => any,
  argumentSchema: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, ReturnType<typeof fn>>;
export function pattern<T, R>(
  fn: (
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
  argumentSchema: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R>;
// Implementation signature
export function pattern<T, R>(
  fn: (
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R> {
  const paramsSchema = readPatternParamsSchema(fn);
  const declaredFrameworkPaths = readFrameworkProvidedPaths(fn);
  hardenVerifiedFunction(fn);

  // The pattern graph is created by calling `fn` which populates for `inputs`
  // and `outputs` with Value<> (which containts Reactive<>) and/or default
  // values.
  const frame = pushFrame();

  const inputs = reactive<RequireDefaults<T>>(
    undefined,
    argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = reactive<R>(
    undefined,
    resultSchema as JSONSchema | undefined,
  );

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  const paramsRoot: PatternParamsRoot | undefined = paramsSchema === undefined
    ? undefined
    : {
      value: reactive<unknown>(undefined, paramsSchema),
      schema: paramsSchema,
    };

  let result;
  try {
    const argument = inputs as Reactive<RequireDefaults<T>> & {
      [SELF]: Reactive<R>;
    };
    const outputs = paramsRoot === undefined
      ? fn!(argument)
      : (fn as unknown as (
        argument: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
        params: Reactive<unknown>,
      ) => FactoryInput<R>)(argument, paramsRoot.value);

    applyInputIfcToOutput(inputs, outputs);

    result = factoryFromPattern<T, R>(
      argumentSchema,
      resultSchema,
      inputs,
      outputs,
      paramsRoot,
      declaredFrameworkPaths,
    );
  } finally {
    popFrame(frame);
  }
  return result;
}

// Same as above, but assumes the caller manages the frame
export function patternFromFrame<T, R>(
  fn: (
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R> {
  const paramsSchema = readPatternParamsSchema(fn);
  const declaredFrameworkPaths = readFrameworkProvidedPaths(fn);
  const inputs = reactive<RequireDefaults<T>>(
    undefined,
    argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = reactive<R>(undefined, resultSchema);

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  const paramsRoot: PatternParamsRoot | undefined = paramsSchema === undefined
    ? undefined
    : {
      value: reactive<unknown>(undefined, paramsSchema),
      schema: paramsSchema,
    };

  const argument = inputs as Reactive<RequireDefaults<T>> & {
    [SELF]: Reactive<R>;
  };
  const outputs = paramsRoot === undefined ? fn(argument) : (fn as unknown as (
    argument: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
    params: Reactive<unknown>,
  ) => FactoryInput<R>)(argument, paramsRoot.value);
  return factoryFromPattern<T, R>(
    argumentSchema,
    resultSchema,
    inputs,
    outputs,
    paramsRoot,
    declaredFrameworkPaths,
  );
}

/**
 * Reject user-supplied causes carrying a top-level `$generated` record key.
 *
 * That key marks the causes the pattern builder mints itself
 * (`{ $generated: N }`, plus `$kind` on streams and `name` on duplicate-name
 * wraps): a user cause like `Cell.for({ $generated: 0 })` would deliberately
 * mimic that namespace, and keeping the namespaces disjoint is what lets the
 * partial-cause assignment in `factoryFromPattern` skip collision checks for
 * generated causes entirely. `$generated` alone suffices — every builder-minted
 * cause carries it, so a cause without it can never hash-equal one (`$kind`
 * and other sigil-looking keys stay usable). Only the top level matters —
 * causes collide as whole records under the canonical value hash, and every
 * builder-minted cause is a flat record, so a `$generated` nested deeper can
 * never equal one.
 *
 * Enforced at the single intake point (`Cell.for`, the only writer of
 * `_causeContainer.cause`) and re-asserted at the assignment site that relies
 * on it.
 */
export function assertNoReservedCauseKeys(cause: unknown): void {
  if (isRecord(cause) && "$generated" in cause) {
    throw new Error(
      `Cannot use cause ${
        toCompactDebugString(cause)
      }: top-level key "$generated" is reserved\n` +
        `help: "$generated" marks system-generated cell causes; rename the key`,
    );
  }
}

function factoryFromPattern<T, R>(
  argumentSchemaArg: JSONSchema | undefined,
  resultSchemaArg: JSONSchema | undefined,
  inputs: Reactive<RequireDefaults<T>>,
  outputs: FactoryInput<R>,
  paramsRoot?: PatternParamsRoot,
  frameworkProvidedPaths: readonly FrameworkProvidedPath[] = [],
): PatternFactory<T, R> {
  // Capture selfRef before collectCellsAndNodes transforms inputs from Reactive to Cell
  // (collectCellsAndNodes replaces Reactive proxies with their underlying Cells,
  // and SELF access only works through the Reactive proxy)
  const selfRef = (inputs as unknown as { [SELF]: Reactive<any> })[SELF];
  const paramsRootCell = paramsRoot === undefined
    ? undefined
    : getCellOrThrow(paramsRoot.value).export().cell;

  // Traverse the value, collect all mentioned nodes and cells
  const allCells = new Set<ICell<unknown>>();
  const allNodes = new Set<NodeRef>();

  // Walk through the value. We'll convert any cell results back into cells as
  // we go. Our traverseValue doesn't descend into cells, but we'll recurse on
  // the cell's nodes ourselves. We'll also add any cells we see to allCells,
  // and any nodes to allNodes.
  const collectCellsAndNodes = (value: FactoryInput<unknown>) =>
    traverseValue(value, (value) => {
      if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);
      if (isCell(value) && !allCells.has(value)) {
        const { frame, nodes, path, scope, name } = value.export();
        if (isReactive(value) && frame !== getTopFrame()) {
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
            if (isReactive(node.module)) {
              node.module = collectCellsAndNodes(
                node.module as FactoryInput<unknown>,
              );
            }
            node.inputs = collectCellsAndNodes(node.inputs);
            node.outputs = collectCellsAndNodes(node.outputs);
          }
        });
      }
      return value;
    });
  inputs = collectCellsAndNodes(inputs);
  if (paramsRoot !== undefined) {
    collectCellsAndNodes(paramsRoot.value);
  }
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
            isReactive(input) && input.export().cell === cell &&
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
  getTopFrame()?.reactives.forEach((ref) => collectCellsAndNodes(ref));

  const inputCell = isCell(inputs) ? inputs : getCellOrThrow(inputs);
  const selfRefCell = getCellOrThrow(selfRef);
  const inputRootCell = inputCell.export().cell;
  const selfRefRootCell = selfRefCell.export().cell;
  const cellNameForCell = (
    cell: ICell<unknown> | OpaqueCell<any> | Reactive<any>,
  ): "argument" | "params" | "result" | undefined => {
    const rootCell = cell.export().cell;
    return rootCell === inputRootCell
      ? "argument"
      : rootCell === selfRefRootCell
      ? "result"
      : rootCell === paramsRootCell
      ? "params"
      : undefined;
  };

  const assignedInternalPartialCauses = new Map<OpaqueCell<any>, JSONValue>();
  // Canonical keys of the NAMED causes already assigned. Only named causes need
  // collision handling: `.for()` rejects reserved keys at intake
  // (`assertNoReservedCauseKeys`), so no user-supplied cause carries
  // `$generated` — which makes every cause minted by
  // `nextAnonymousPartialCause` (per-build-unique counter) and every
  // `{name, $generated}` disambiguation wrap collision-free by construction:
  // no check, no set entry. A candidate name's collision test is an O(1) `Set`
  // lookup on `hashStringOf` — the canonical value hash, which is exactly
  // `deepEqual`'s comparison on the JSON values causes are made of: records
  // hash key-order-insensitively (keys fed in sorted UTF-8 byte order), numbers
  // by their float64 bits with a dedicated `-0` cache entry, and `NaN`
  // canonically — i.e. `Object.is` primitive semantics.
  const assignedNamedCauseKeys = new Set<string>();
  let anonymousPartialCauseCount = 0;
  const nextAnonymousPartialCause = (isStream: boolean): JSONObject => {
    const generated = { $generated: anonymousPartialCauseCount++ };
    return isStream ? { ...generated, $kind: "stream" } : generated;
  };
  allCells.forEach((cell) => {
    const { cell: top, path, value, name, external } = cell.export();
    if (
      external || path.length > 0 || cellNameForCell(cell) !== undefined ||
      assignedInternalPartialCauses.has(top)
    ) {
      return;
    }

    const isStream = isRecord(value) && value.$stream === true;
    let partialCause: JSONValue;
    if (name === undefined) {
      partialCause = nextAnonymousPartialCause(isStream);
    } else {
      // `.for()` already rejected reserved keys; re-assert at the assignment
      // site because the no-collision-check reasoning above relies on it (a
      // future second writer of causes must not silently void it).
      assertNoReservedCauseKeys(name);
      const key = hashStringOf(name as JSONValue);
      if (assignedNamedCauseKeys.has(key)) {
        // Duplicate name: disambiguate with a fresh generated counter. The
        // wrap is unique by construction and unforgeable (user causes can't
        // carry `$generated`), so it needs no re-check and no set entry.
        partialCause = {
          name: name as JSONValue,
          ...nextAnonymousPartialCause(isStream),
        };
      } else {
        assignedNamedCauseKeys.add(key);
        partialCause = name as JSONValue;
      }
    }
    assignedInternalPartialCauses.set(top, partialCause);
  });

  const cellReferenceForCell = (
    cell: ICell<unknown> | OpaqueCell<any> | Reactive<any>,
  ): AliasBinding["$alias"] | undefined => {
    const { cell: top, path, external, scope, schema } = cell.export();
    // If we have an external id, don't bother with all this
    if (external) return undefined;

    const commonAliasProps = {
      path,
      ...(schema !== undefined && { schema }),
    };
    // See if we're one of the special cells (result or argument)
    const cellName = cellNameForCell(cell);
    if (cellName !== undefined) {
      // No scope on named-cell aliases: the argument/result cell's own link
      // provides it at unwrap time.
      return { cell: cellName, ...commonAliasProps };
    }
    // Otherwise, we should be an internal call, and should have partialCause
    const partialCause = assignedInternalPartialCauses.get(top);
    if (partialCause !== undefined) {
      return {
        partialCause,
        ...(scope !== undefined && { scope }),
        ...commonAliasProps,
      };
    }
  };

  const allCellsAndInternalRoots = new Set<ICell<unknown> | Reactive<any>>(
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
    const { cell: top, path, value, schema, scope, external } = cell.export();
    if (top === inputRootCell || top === paramsRootCell) return;
    if (path.length > 0 || external) return;

    const cellReference = cellReferenceForCell(cell);
    if (cellReference === undefined) return;
    if (
      cellReference.partialCause !== undefined &&
      cellReference.path.length === 0
    ) {
      const partialCause = cellReference.partialCause!;
      const descriptorSchema = schemaWithDefault(schema, value);
      derivedInternalPartialCausesByRoot.set(top, partialCause);
      derivedInternalCells.push({
        partialCause,
        ...(descriptorSchema !== undefined && { schema: descriptorSchema }),
        ...(scope !== undefined && { scope }),
      });
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
      // this can only match argument, params, and result aliases, since internal
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
      ? sanitizeSchemaForLinks(cellReference.schema, KeepAsCell.All)
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
      cellReference.cell === "argument" ||
      cellReference.cell === "params" ||
      cellReference.cell === "result"
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
  const result = toJSONWithAliasBindings(
    outputs ?? {},
    resolveCellAlias,
    true,
  )! as unknown as JSONValue;

  // Pattern modules are evaluated under a runtime-carrying builder frame.
  // Read the flag from that runtime so constructing or disposing another
  // Runtime in the same process cannot change this pattern's identity.
  if (getTopFrame()?.runtime?.experimental.computedCellIds === true) {
    assignComputedCellKinds(
      allNodes,
      derivedInternalPartialCausesByRoot,
      derivedInternalCells,
    );
  }

  const argumentSchema: JSONSchema = addFrameworkPathsToSchema(
    argumentSchemaArg ?? true,
    frameworkProvidedPaths,
  );

  const resultSchema =
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) ?? {};

  const serializedNodes = Array.from(allNodes).map((node) => {
    const module = toJSONWithAliasBindings(
      node.module,
      resolveCellAlias,
      false,
      isAdmittedFabricFactory(node.module) ? ["module"] : [],
    ) as unknown as Module;
    const inputsForSerialization = usesLegacyListPatternOp(node.module) &&
        isRecord(node.inputs) && isPattern(node.inputs.op)
      ? {
        ...node.inputs,
        op: serializePatternGraph(node.inputs.op),
      }
      : node.inputs;
    const inputs = toJSONWithAliasBindings(
      inputsForSerialization,
      resolveCellAlias,
      false,
    )! as unknown as JSONValue;
    const outputs = toJSONWithAliasBindings(
      node.outputs,
      resolveCellAlias,
      false,
    )! as unknown as JSONValue;
    // WP1.5's later graph-payload audit widens Node/Pattern fields to admit
    // first-class factories. Keep that static type change separate; the
    // visitor already preserves the callable value at runtime.
    return {
      module,
      inputs,
      outputs,
      ...(node.expectedFactory === undefined
        ? {}
        : { expectedFactory: node.expectedFactory }),
    } satisfies Node;
  });

  const pattern: Pattern & toJSON = {
    argumentSchema: sanitizeSchemaForLinks(argumentSchema, KeepAsCell.All),
    resultSchema: sanitizeSchemaForLinks(resultSchema, KeepAsCell.OnlyStream),
    ...(derivedInternalCells.length > 0 ? { derivedInternalCells } : {}),
    result,
    nodes: serializedNodes,
    // Important that this refers to patternFactory, as .program will be set on
    // pattern afterwards (see factory.ts:exportsCallback)
    toJSON: () => patternToJSON(patternFactory),
  };

  const factoryRootToken = {};

  type PatternFactoryOptions = {
    defaultScope?: CellScope;
    spaceSelector?: unknown;
    paramsSchema?: JSONSchema;
    params?: unknown;
  };

  const makePatternFactory = (
    options: PatternFactoryOptions = {},
  ): PatternFactory<T, R> => {
    const { defaultScope, spaceSelector, paramsSchema, params } = options;
    const factory = Object.assign(
      (inputs: FactoryInput<T>): Reactive<R> => {
        if (
          Object.hasOwn(options, "paramsSchema") &&
          !Object.hasOwn(options, "params")
        ) {
          throw new Error("Bound pattern params require callback binding");
        }
        const outputs = reactive<R>(
          undefined,
          scopeSilentResultViewSchema(resultSchema),
        );
        const frame = getTopFrame();
        let nodeFactory: PatternFactory<T, R> = factory;
        if (spaceSelector !== undefined) {
          const targetSpace = resolveInSpaceTargetSpace(spaceSelector, frame);
          if (targetSpace !== undefined) {
            setCellUnlinkedSpace(outputs, targetSpace);
            // Named and anonymous selectors resolve during graph construction.
            // Pin that resolved DID on this invocation's derived factory so the
            // directly branded node retains the same execution target after
            // serialization; the authored selector remains on the reusable
            // base factory.
            if (
              typeof spaceSelector === "string" &&
              !/^did:[^:]+:.+/.test(spaceSelector)
            ) {
              nodeFactory = makePatternFactory({
                ...options,
                spaceSelector: targetSpace,
              });
              noteDerivedCopy(nodeFactory, factory);
            }
          }
        }
        const node: NodeRef = {
          module: nodeFactory,
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
    ) as InternalPatternFactory<T, R>;

    factory.curry = function (params: unknown): InternalPatternFactory<T, R> {
      if (arguments.length !== 1) {
        throw new TypeError("Pattern curry requires exactly one argument");
      }
      if (Object.hasOwn(options, "params")) {
        throw new TypeError("Pattern factory params are already bound");
      }
      if (!Object.hasOwn(options, "paramsSchema")) {
        throw new TypeError(
          "Pattern factory has no compiler-declared params slot",
        );
      }
      assertValidPatternParams(params, paramsSchema!);
      const derived = makePatternFactory({ ...options, params });
      noteDerivedCopy(derived, factory);
      return derived as InternalPatternFactory<T, R>;
    };

    // `asScope` / `inSpace` mint fresh factory objects; record them as
    // derivation copies so identity facts resolve through to the root factory
    // — in particular the content-addressed artifact entry ref, which is what
    // lets an `inSpace(...)` child piece carry `patternIdentity` meta and have
    // its closures replicated into its own space (CT-1687).
    factory.asScope = (scope: CellScope) => {
      const derived = makePatternFactory({ ...options, defaultScope: scope });
      noteDerivedCopy(derived, factory);
      return derived;
    };
    factory.inSpace = (space?: string | unknown) => {
      const derived = makePatternFactory({
        ...options,
        spaceSelector: space ?? "",
      });
      noteDerivedCopy(derived, factory);
      return derived;
    };
    // Provenance brand: only the trusted builder stamps a pattern. Trust-granting
    // sites check `isTrustedPattern` so a `__cf_data`-forged pattern-shaped
    // object cannot acquire program / verified-load-id metadata.
    brandTrustedPattern(factory);
    setFrameworkProvidedPaths(factory, frameworkProvidedPaths);
    bindFactoryRootToken(factory, factoryRootToken);
    registerFabricFactory(factory, "pattern", () => {
      const ref = getDurableArtifactRefForRootToken(factoryRootToken);
      return {
        kind: "pattern",
        rootToken: factoryRootToken,
        ...(ref === undefined ? {} : { ref }),
        argumentSchema: pattern.argumentSchema,
        resultSchema: pattern.resultSchema,
        ...(Object.hasOwn(options, "paramsSchema") ? { paramsSchema } : {}),
        ...(Object.hasOwn(options, "params") ? { params } : {}),
        ...(defaultScope === undefined ? {} : { defaultScope }),
        ...(Object.hasOwn(options, "spaceSelector") ? { spaceSelector } : {}),
      };
    });
    registerFactoryStateDeriver(factory, (state) => {
      if (state.kind !== "pattern") {
        throw new Error("Pattern factory state deriver received another kind");
      }
      if ("rootToken" in state && state.rootToken !== factoryRootToken) {
        throw new Error("Factory derivation cannot change its root token");
      }
      return makePatternFactory({
        ...(Object.hasOwn(state, "paramsSchema")
          ? { paramsSchema: state.paramsSchema }
          : {}),
        ...(Object.hasOwn(state, "params") ? { params: state.params } : {}),
        ...(Object.hasOwn(state, "defaultScope")
          ? { defaultScope: state.defaultScope }
          : {}),
        ...(Object.hasOwn(state, "spaceSelector")
          ? { spaceSelector: state.spaceSelector }
          : {}),
      });
    });
    return factory;
  };

  const patternFactory = makePatternFactory(
    paramsRoot === undefined ? {} : { paramsSchema: paramsRoot.schema },
  );

  return patternFactory;
}

/**
 * `asCell` kinds that provably cannot write through the handle. Everything
 * else — "cell", "writeonly", "stream", "sqlite", and any kind this code does
 * not recognize — counts as write-capable for classification.
 */
const READ_ONLY_CELL_KINDS: ReadonlySet<string> = new Set([
  "opaque",
  "comparable",
  "readonly",
]);

/**
 * True if this schema position's own `asCell` marker grants a write-capable
 * handle (an entry whose kind is not provably read-only). Positional only —
 * does not look at subschemas.
 */
function asCellGrantsWritableHere(
  schema: Record<string | number | symbol, unknown>,
): boolean {
  if (!Array.isArray(schema.asCell)) return false;
  for (const entry of schema.asCell) {
    const kind = typeof entry === "string"
      ? entry
      : isRecord(entry)
      ? entry.kind
      : undefined;
    if (typeof kind !== "string" || !READ_ONLY_CELL_KINDS.has(kind)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively true if a schema may grant a write-capable cell handle anywhere
 * in its subtree: an `asCell` entry whose kind is not provably read-only, or
 * a `$ref`/`$dynamicRef` — the referenced schema is not inline, so a writable
 * grant could hide behind it. Deliberately over-broad (a value coincidentally
 * containing an `asCell` key inside a `default` also trips it); the failure
 * direction is only a missed optimization. Counting `$ref`s is what makes
 * this a safe "provably handle-free" test for the input-side walk — an
 * inline-only grant scan would fail OPEN on a `$ref` whose target (e.g. under
 * the root `$defs`) grants a handle, and under-collection here means silently
 * dropped user writes.
 */
function schemaMayGrantWritableHandles(schema: unknown): boolean {
  if (Array.isArray(schema)) return schema.some(schemaMayGrantWritableHandles);
  if (!isRecord(schema)) return false;
  if (asCellGrantsWritableHere(schema)) return true;
  if ("$ref" in schema || "$dynamicRef" in schema) return true;
  return Object.values(schema).some(schemaMayGrantWritableHandles);
}

/**
 * Schema keywords that can route a subschema to a value position through a
 * mechanism the aligned walk does not model. Their presence at a position
 * makes the walk fall back to treating the whole value subtree as writably
 * bound (when a grant may exist below). The walk models only `properties`,
 * `additionalProperties`, and `items`; `$defs`/`definitions` are harmless
 * without a `$ref` (which is listed).
 */
const UNMODELED_SCHEMA_KEYWORDS: readonly string[] = [
  "$ref",
  "$dynamicRef",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
  "prefixItems",
  "contains",
  "patternProperties",
  "propertyNames",
  "contentSchema",
];

/**
 * Marks derived internal cells with `kind: "computed"` so their ids are
 * minted kind-tagged and the memory server may apply relaxed (ack-and-drop)
 * conflict semantics to their writes. See
 * `docs/specs/computed-cell-identity.md`.
 *
 * Internals with a writer are computed BY DEFAULT — even when the
 * computation involves writes (capture writes, materializer write paths): a
 * replayable writer deterministically reproduces its writes, so dropping one
 * loses nothing. A cell is tagged iff:
 * - it has at least one writer (a node listing its root under
 *   `node.outputs`) — zero-writer cells are seeded state, never tagged — and
 *   no writer disqualifies (`writerDisqualifies`): handler wrappers,
 *   writable-proxy modules, effects, raw/isolated modules, and builtin refs
 *   not proven replayable by name (see `builtin-replayability.ts`);
 * - its root is never handed WRITABLE into another node
 *   (`collectInputDisqualifiedRoots`): read-only handler captures no longer
 *   disqualify, but `asCell` bindings granting a write-capable handle,
 *   schema-less / writable-proxy handlers, sub-pattern arguments,
 *   op-sub-pattern builtin inputs (map/filter/flatMap), and every input of a
 *   non-replayable node (`llmDialog` writes through its inputs) still do;
 * - it is not a stream.
 *
 * The failure directions are asymmetric by design. SHAPE questions fail open
 * only where write capability is provably absent — writes in schema-carrying
 * handlers flow solely through non-read-only `asCell` handles — and any
 * structural doubt (unmodeled schema keywords, `$ref`s, value/schema
 * mismatch) disqualifies the whole subtree. NAME questions (builtin refs)
 * fail strict: unknown names disqualify. Tagging a computed cell as state
 * costs a missed optimization; tagging state as computed silently drops user
 * writes.
 *
 * ACCEPTED consequence: exposure on the result surface no longer
 * disqualifies. An embedder that writes through an exposed writable handle
 * into a computed cell has that write ack-and-dropped on conflict; the
 * derivation re-establishes the value.
 */
function assignComputedCellKinds(
  allNodes: Set<NodeRef>,
  partialCausesByRoot: Map<OpaqueCell<any>, JSONValue>,
  derivedInternalCells: DerivedInternalCellDescriptor[],
): void {
  const collectCellRoots = (value: unknown): Set<OpaqueCell<any>> => {
    const roots = new Set<OpaqueCell<any>>();
    traverseValue(value as FactoryInput<unknown>, (item) => {
      if (isCellResultForDereferencing(item)) item = getCellOrThrow(item);
      if (isCell(item)) roots.add(item.export().cell);
      return item;
    });
    return roots;
  };

  // A writer that disqualifies its output cells from the computed kind:
  // anything whose writes are not a deterministic replay of its inputs.
  // Handlers never appear as writers (their `outputs` is `{}`), but the
  // checks stay for hand-built nodes. `javascript` computes qualify even
  // with capture writes / `materializerWriteInputPaths` — those writes
  // replay. `pattern` writers qualify (instantiation writes converge on
  // replay; see plan risk 4 — flip to disqualifying if that fails in
  // practice). `passthrough` qualifies: it is a one-shot deterministic copy
  // of its input binding to its outputs (runner.ts,
  // `instantiatePassthroughNode`), with no code that could write elsewhere.
  const writerDisqualifies = (module: NodeRef["module"]): boolean => {
    if (!isModule(module)) return true; // Opaque module value: assume the worst.
    if (module.wrapper === "handler" || module.writableProxy === true) {
      return true;
    }
    if (module.isEffect === true) return true;
    switch (module.type) {
      case "javascript":
      case "pattern":
      case "passthrough":
        return false;
      case "ref":
        // Builtins are string names here (runtime registrations are not
        // visible to the builder); unknown names fail strict.
        return typeof module.implementation !== "string" ||
          !REPLAYABLE_BUILTIN_REFS.has(module.implementation);
      default: // "raw", "isolated", and anything unrecognized: opaque.
        return true;
    }
  };

  // Walks a handler's bound `$ctx` value in parallel with its `$ctx` schema
  // and collects the cell roots the handler could WRITE through: roots
  // covered by a subschema that may grant a non-read-only `asCell` handle.
  // Read-only captures (no possible grant in the covering subschema) collect
  // nothing — in a schema-carrying, non-writableProxy handler, write
  // capability flows only through `asCell` handles, so a plain value binding
  // cannot be written through. Any subtree the walk cannot align (boolean or
  // missing subschema with a possible grant, unmodeled schema keywords,
  // value/schema shape mismatch) conservatively collects ALL roots in that
  // value subtree.
  const collectWritablyBoundRoots = (
    value: unknown,
    schema: unknown,
    out: Set<OpaqueCell<any>>,
    seen: Map<object, Set<object>> = new Map(),
  ): void => {
    // Provably handle-free subschema (no writable `asCell` grant inline and
    // no `$ref` a grant could hide behind): nothing to collect. This is the
    // branch that lets read-only handler captures stay computed.
    if (!schemaMayGrantWritableHandles(schema)) return;
    const collectAll = () =>
      collectCellRoots(value).forEach((root) => out.add(root));
    if (!isRecord(schema) || Array.isArray(schema)) {
      // A grant may exist but the schema is not a plain object (unreachable
      // for booleans, which never grant): fail safe.
      collectAll();
      return;
    }
    if (asCellGrantsWritableHere(schema)) {
      // Writable handle at this very position: everything under it is
      // reachable through the handle.
      collectAll();
      return;
    }
    if (UNMODELED_SCHEMA_KEYWORDS.some((keyword) => keyword in schema)) {
      collectAll();
      return;
    }
    let target = value;
    if (isCellResultForDereferencing(target)) target = getCellOrThrow(target);
    if (isCell(target)) {
      // A cell bound where a deeper grant may exist: the handle the handler
      // obtains deeper in writes INTO this root.
      out.add(target.export().cell);
      return;
    }
    if (target === null || typeof target !== "object") return; // Primitives hold no roots.
    // A shared value can be bound at multiple schema positions with different
    // capabilities. Deduplicate only the same value/schema pair: deduplicating
    // by value alone can let an earlier read-only path suppress a later
    // writable path. The pair guard still terminates actual value/schema
    // cycles.
    const seenSchemas = seen.get(target);
    if (seenSchemas?.has(schema)) return;
    if (seenSchemas) seenSchemas.add(schema);
    else seen.set(target, new Set([schema]));
    if (Array.isArray(target)) {
      const items = schema.items;
      if (items === undefined) {
        collectAll(); // Array value under an object-shaped schema: misaligned.
        return;
      }
      for (const element of target) {
        collectWritablyBoundRoots(element, items, out, seen);
      }
      return;
    }
    if (isRecord(target) && !isReactive(target)) {
      const properties =
        isRecord(schema.properties) && !Array.isArray(schema.properties)
          ? schema.properties
          : undefined;
      for (const [key, child] of Object.entries(target)) {
        const childSchema = properties !== undefined && key in properties
          ? properties[key]
          : schema.additionalProperties;
        if (childSchema !== undefined) {
          collectWritablyBoundRoots(child, childSchema, out, seen);
        }
        // No covering subschema (undeclared property, no
        // additionalProperties): no `asCell` position exists for it, so the
        // handler receives at most a plain, unwritable value — nothing to
        // collect.
      }
      return;
    }
    // Anything else (pattern factories, non-cell reactives, exotic objects):
    // unmodeled — fail safe.
    collectAll();
  };

  // Roots bound into a node's inputs disqualify when the node could write
  // through them.
  const collectInputDisqualifiedRoots = (
    node: NodeRef,
  ): Set<OpaqueCell<any>> => {
    const module = node.module;
    const all = () => collectCellRoots(node.inputs);
    const none = new Set<OpaqueCell<any>>();
    if (!isModule(module)) return all();
    if (module.wrapper === "handler") {
      // Handlers capture their closure under `$ctx` (builder/module.ts binds
      // `{ $ctx, $event }` against an argumentSchema of shape
      // `{ properties: { $event, $ctx } }`, see generateHandlerSchema).
      // Without a schema — or with the legacy writable proxy — every capture
      // is writable.
      if (module.writableProxy === true) return all();
      const schema = module.argumentSchema;
      const properties = isRecord(schema) && !Array.isArray(schema) &&
          isRecord(schema.properties) && !Array.isArray(schema.properties)
        ? schema.properties
        : undefined;
      if (properties === undefined || !isRecord(node.inputs)) return all();
      const roots = new Set<OpaqueCell<any>>();
      for (const [key, bound] of Object.entries(node.inputs)) {
        if (key === "$ctx" && properties[key] !== undefined) {
          collectWritablyBoundRoots(bound, properties[key], roots);
        } else {
          // `$event` is the node's own event stream (never a qualifying
          // root, streams are excluded anyway); any unexpected key means a
          // hand-built node — disqualify everything bound there.
          collectCellRoots(bound).forEach((root) => roots.add(root));
        }
      }
      return roots;
    }
    if (module.writableProxy === true) return all(); // Defensive: only handlers carry it today.
    if (module.isEffect === true) return all();
    switch (module.type) {
      case "javascript":
      case "passthrough":
        // Qualifying computes and the passthrough copy read their inputs;
        // their (replayable) writes are covered on the writer side.
        return none;
      case "pattern":
        // Sub-pattern arguments are writable-by-default aliases and any
        // handler inside the sub-pattern is invisible here.
        return all();
      case "ref": {
        const name = module.implementation;
        if (typeof name !== "string" || !REPLAYABLE_BUILTIN_REFS.has(name)) {
          // Non-replayable/unknown builtins may write through their inputs
          // (llmDialog pushes onto its `messages` input).
          return all();
        }
        // Replayable, but the op sub-pattern argument may contain handlers
        // that write the source elements.
        if (SUBPATTERN_ARGUMENT_BUILTIN_REFS.has(name)) return all();
        return none;
      }
      default: // "raw", "isolated", unrecognized: opaque.
        return all();
    }
  };

  const writersByRoot = new Map<OpaqueCell<any>, NodeRef["module"][]>();
  const disqualified = new Set<OpaqueCell<any>>();
  allNodes.forEach((node) => {
    collectCellRoots(node.outputs).forEach((root) => {
      const writers = writersByRoot.get(root) ?? [];
      writers.push(node.module);
      writersByRoot.set(root, writers);
    });
    collectInputDisqualifiedRoots(node).forEach((root) =>
      disqualified.add(root)
    );
  });

  partialCausesByRoot.forEach((partialCause, root) => {
    const writers = writersByRoot.get(root);
    if (writers === undefined || writers.length === 0) return;
    if (writers.some(writerDisqualifies)) return;
    if (disqualified.has(root)) return;
    const { value } = root.export();
    if (isRecord(value) && value.$stream === true) return;
    const descriptor = derivedInternalCells.find((candidate) =>
      deepEqual(candidate.partialCause, partialCause)
    );
    if (descriptor !== undefined) descriptor.kind = "computed";
  });
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

const frames: Frame[] = [];

export function pushFrame(frame: Partial<Frame> = {}): Frame {
  const parent = getTopFrame();

  const result = {
    parent,
    reactives: new Set(),
    generatedIdCounter: 0,
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
    frameKind?: "lift" | "handler";
    eventTime?: number;
    implementationIdentity?: ImplementationIdentity;
    runtime?: Runtime;
    tx?: IExtendedStorageTransaction;
    space?: MemorySpace;
  },
): Frame {
  const parent = getTopFrame();
  const {
    unsafe_binding,
    inHandler,
    frameKind,
    eventTime,
    runtime,
    tx,
    space,
  } = props;

  // If no runtime provided, try to inherit from parent (may be undefined during construction)
  const frameRuntime = runtime ?? parent?.runtime;
  const frameTx = tx ?? unsafe_binding?.tx ?? parent?.tx;
  const frameSpace = space ?? unsafe_binding?.space ?? parent?.space;

  const frame = {
    parent,
    cause,
    generatedIdCounter: 0,
    reactives: new Set(),
    ...(parent?.implementationIdentity && {
      implementationIdentity: parent.implementationIdentity,
    }),
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
    ...(frameKind && { frameKind }),
    ...(eventTime !== undefined && { eventTime }),
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

/** The full type of the `pattern` function including all overloads. */
export type PatternBuilder = typeof pattern;

function schemaWithDefault(
  schema: JSONSchema | undefined,
  value: unknown,
): JSONSchema | undefined {
  if (value === undefined) return schema;
  if (schema === true || schema === undefined) {
    return { default: value as JSONValue };
  }
  if (schema === false) {
    return { not: true, default: value as JSONValue };
  }
  if (isRecord(schema)) {
    return schema.default === undefined
      ? { ...schema, default: value as JSONValue }
      : schema;
  }
  return schema;
}
