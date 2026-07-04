import { isRecord } from "@commonfabric/utils/types";
import { deepEqual } from "@commonfabric/utils/deep-equal";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";
import {
  type CellScope,
  type FactoryInput,
  type Frame,
  type ICell,
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
import { brandTrustedPattern, noteDerivedCopy } from "./pattern-metadata.ts";
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
import { traverseValue } from "./traverse-utils.ts";
import {
  getStableInternalPathSegment,
  KeepAsCell,
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

  let result;
  try {
    const outputs = fn!(
      inputs as Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
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
    input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  ) => FactoryInput<R>,
  argumentSchema?: JSONSchema,
  resultSchema?: JSONSchema,
): PatternFactory<T, R> {
  const inputs = reactive<RequireDefaults<T>>(
    undefined,
    argumentSchema as JSONSchema | undefined,
  );

  // Create self reference - will be mapped to resultRef path during serialization
  const selfRef = reactive<R>(undefined, resultSchema);

  // Attach SELF to the underlying cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  const outputs = fn(
    inputs as Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
  );
  return factoryFromPattern<T, R>(
    argumentSchema,
    resultSchema,
    inputs,
    outputs,
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
): PatternFactory<T, R> {
  // Capture selfRef before collectCellsAndNodes transforms inputs from Reactive to Cell
  // (collectCellsAndNodes replaces Reactive proxies with their underlying Cells,
  // and SELF access only works through the Reactive proxy)
  const selfRef = (inputs as unknown as { [SELF]: Reactive<unknown> })[SELF];

  // Traverse the value, collect all mentioned nodes and cells
  const allCells = new Set<ICell<unknown>>();
  const allNodes = new Set<NodeRef>();

  // Walk through the value. We'll convert any cell results back into cells as
  // we go. Our traverseValue doesn't descend into cells, but we'll recurse on
  // the cell's nodes ourselves. We'll also add any cells we see to allCells,
  // and any nodes to allNodes.
  const collectCellsAndNodes = <T>(value: T): T =>
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
  ): "argument" | "result" | undefined => {
    const rootCell = cell.export().cell;
    return rootCell === inputRootCell
      ? "argument"
      : rootCell === selfRefRootCell
      ? "result"
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
  ): LegacyAlias["$alias"] | undefined => {
    const { cell: top, path, external, scope, schema } = cell.export();
    // If we have an external id, don't bother with all this
    if (external) return undefined;

    const commonAliasProps = {
      path,
      ...(scope !== undefined && { scope }),
      ...(schema !== undefined && { schema }),
    };
    // See if we're one of the special cells (result or argument)
    const cellName = cellNameForCell(cell);
    if (cellName !== undefined) {
      return { cell: cellName, ...commonAliasProps };
    }
    // Otherwise, we should be an internal call, and should have partialCause
    const partialCause = assignedInternalPartialCauses.get(top);
    if (partialCause !== undefined) {
      return { partialCause, ...commonAliasProps };
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
      const descriptorSchema = schemaWithDefault(schema, value);
      derivedInternalPartialCausesByRoot.set(top, partialCause);
      derivedInternalCells.push({
        partialCause,
        ...(descriptorSchema !== undefined && { schema: descriptorSchema }),
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
    applyArgumentIfcToResult(argumentSchema, resultSchemaArg) ?? {};

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
    argumentSchema: sanitizeSchemaForLinks(argumentSchema, KeepAsCell.All),
    resultSchema: sanitizeSchemaForLinks(resultSchema, KeepAsCell.OnlyStream),
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
      (inputs: FactoryInput<T>): Reactive<R> => {
        const module: Module & toJSON = {
          type: "pattern",
          implementation: factory,
          ...(factory.defaultScope !== undefined
            ? { defaultScope: factory.defaultScope }
            : {}),
          toJSON: () => moduleToJSON(module),
        };

        const outputs = reactive<R>();
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
    implementationIdentity?: ImplementationIdentity;
    runtime?: Runtime;
    tx?: IExtendedStorageTransaction;
    space?: MemorySpace;
  },
): Frame {
  const parent = getTopFrame();
  const { unsafe_binding, inHandler, runtime, tx, space } = props;

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
