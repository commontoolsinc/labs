import { isRecord } from "@commonfabric/utils/types";
import { BaseFabricPrimitive } from "@commonfabric/data-model/fabric-primitives";
import {
  emptySchemaObject,
  schemaForValueType,
  schemaWithProperties,
} from "@commonfabric/data-model/schema-utils";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { type LegacyAlias } from "../sigil-types.ts";
import {
  type FactoryInput,
  isPattern,
  type JSONSchema,
  type JSONValue,
  type Module,
  type Pattern,
  type Reactive,
  type toJSON,
} from "./types.ts";
import { getTopFrame } from "./pattern.ts";
import {
  getArtifactEntryRef,
  getPatternProgram,
  noteDerivedCopy,
} from "./pattern-metadata.ts";
import { getVerifiedProvenance } from "../harness/verified-provenance.ts";
import { Runtime } from "../runtime.ts";
import { isCellLink, isLegacyAlias, parseLink } from "../link-utils.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import { isCell } from "../cell.ts";

export type CellAliasResolver = (
  cell: Reactive<any>,
  path: readonly PropertyKey[],
  ignoreSelfAliases: boolean,
) => LegacyAlias | null | undefined;

export function toJSONWithLegacyAliases(
  value: FactoryInput<any>,
  resolveCellAlias?: CellAliasResolver,
  ignoreSelfAliases: boolean = false,
  path: readonly PropertyKey[] = [],
  seen?: WeakMap<object, number>,
): JSONValue | undefined {
  // Turn strongly typed builder values into legacy JSON structures while
  // preserving alias metadata for consumers that still rely on it.

  // Convert regular cells and results from Cell.get() to opaque refs
  if (isCellResultForDereferencing(value)) value = getCellOrThrow(value);

  if (isCell(value)) {
    const { external, frame } = value.export();

    // If this is an external reference, just copy the reference as is.
    if (external) return external as JSONValue;

    // Verify that opaque refs are not in a parent frame
    if (frame !== getTopFrame()) {
      throw new Error(
        `Cell with parent cell not found in current frame. Likely a closure that should have been transformed.`,
      );
    }

    // Otherwise it's an internal reference. Ask the pattern builder how this
    // cell should be represented in the serialized pattern.
    const alias = resolveCellAlias?.(
      value as Reactive<any>,
      path,
      ignoreSelfAliases,
    );
    if (alias === null) return undefined;
    if (alias !== undefined) return alias as unknown as JSONValue;
    throw new Error(`Cell not found in pattern aliases`);
  }

  // If we encounter a link, it's from a nested pattern.
  if (isLegacyAlias(value)) {
    const alias = (value as LegacyAlias).$alias;
    // If this was a shadow ref, i.e. a nested pattern, see whether we're now at
    // the level that it should be resolved to the actual cell.
    if (alias.partialCause !== undefined) {
      return {
        $alias: {
          partialCause: alias.partialCause,
          defer: (alias.defer ?? 0) + 1,
          path: alias.path,
          ...(alias.scope !== undefined && { scope: alias.scope }),
          ...(alias.schema !== undefined && { schema: alias.schema }),
        },
      } satisfies LegacyAlias;
    } else if (!("cell" in alias) || typeof (alias.cell) === "string") {
      // If we encounter an existing alias and it isn't an absolute reference
      // with a cell id, then increase the nesting level.
      return {
        $alias: {
          defer: (alias.defer ?? 0) + 1,
          path: alias.path,
          ...(alias.scope !== undefined && { scope: alias.scope }),
          ...(alias.schema !== undefined && { schema: alias.schema }),
          ...(alias.cell !== undefined && { cell: alias.cell }),
        },
      } satisfies LegacyAlias;
    } else {
      throw new Error(`Invalid alias cell`);
    }
  }

  // If this is an array, process each element recursively.
  if (Array.isArray(value)) {
    return (value as FactoryInput<any>).map((v: FactoryInput<any>, i: number) =>
      toJSONWithLegacyAliases(v, resolveCellAlias, ignoreSelfAliases, [
        ...path,
        i,
      ], seen)
    );
  }

  // A `FabricPrimitive` is an atomic value whose state lives in private fields
  // (zero enumerable own-props). The `for...in` copy branch below would flatten
  // it to `{}`, so return it unchanged here — after the cell / alias / array
  // handling above, which must still win for those forms.
  if (value instanceof BaseFabricPrimitive) {
    return value as unknown as JSONValue;
  }

  // If this is an object or a pattern, process each key recursively.
  if (isRecord(value) || isPattern(value)) {
    // Guard against circular object references (e.g. schema objects with
    // shared identity between $defs and sibling properties).
    if (!seen) seen = new WeakMap();
    const depth = seen.get(value as object) ?? 0;
    if (depth > 0) return {}; // Actually circular
    seen.set(value as object, depth + 1);

    // If this is a pattern, serialize it through the INTERNAL graph
    // serializer (its toJSON under the internal-serialization context): this
    // function builds the in-memory node representation, so embedded
    // sub-pattern graphs must stay bare — no boundary `$patternRef`.
    const valueToProcess = (isPattern(value) &&
        typeof (value as unknown as toJSON).toJSON === "function")
      ? serializePatternGraph(value as unknown as Pattern) as Record<
        string,
        any
      >
      : (value as Record<string, any>);

    const result: any = {};
    // TODO(danfuzz): A `FabricPrimitive` is now returned atomically above, but
    // the other special-object type, `FabricInstance` (a container), still
    // reaches this `for...in` copy and is walked by its internal slots (zero
    // enumerable own-props) instead of its codec contents. Unlike a primitive it
    // *does* need descending into — but by its actual contents, which this walk
    // won't do correctly. This site will need attention once FabricInstances see
    // real use.
    for (const key in valueToProcess as any) {
      const jsonValue = toJSONWithLegacyAliases(
        valueToProcess[key],
        resolveCellAlias,
        ignoreSelfAliases,
        [...path, key],
        seen,
      );
      if (jsonValue !== undefined) {
        result[key] = jsonValue;
      }
    }

    // Restore depth so shared references can be re-serialized
    seen.set(value as object, depth);

    // Register the copy's derivation link so trust and the content-addressed
    // entry ref carry to the serialized copy (side table; symbol keys would be
    // dropped by JSON anyway).
    if (isPattern(value)) noteDerivedCopy(result, value);

    return result;
  }

  return value;
}

/**
 * Creates a schema based on an `example` piece of data. The result is always an
 * interned schema. Note that interned schemas are necessarily frozen.
 *
 * **Note:** Though the intention is to treat `undefined` as an acceptable
 * value, this function doesn't in fact represent it as a proper schema.
 */
export function createJsonSchema(
  example: any,
  addDefaults: boolean = false,
  runtime?: Runtime,
): JSONSchema {
  const state = {
    addDefaults,
    runtime,
    seen: new Map<string, JSONSchema>(),
  };

  return analyzeType(example, state);
}

type AnalyzeTypeState = {
  addDefaults: boolean;
  runtime: Runtime | undefined;
  seen: Map<string, JSONSchema>;
};

/**
 * Helper for `createJsonSchema()` which analyzes a value, calling itself
 * recursively on subcomponents of the value (if any). The return value is
 * always an interned schema.
 */
function analyzeType(value: any, state: AnalyzeTypeState): JSONSchema {
  if (isCellLink(value)) {
    const seen = state.seen;
    const link = parseLink(value);
    const linkAsStr = JSON.stringify(link);

    const found = seen.get(linkAsStr);
    if (found !== undefined) {
      return found;
    }

    const cell = state.runtime?.getCellFromLink(link);
    if (!cell) {
      // Shouldn't happen: We have a cell link but its link doesn't correspond
      // to a cell.

      // TODO(danfuzz): I think the `TODO(seefeld)` below reflects the old state
      // of `createJsonSchema()` which was defined to return a
      // `JSONSchemaObjMutable` (which had to be an `object`) and not a
      // `JSONSchema` (which includes `boolean`), and not some other problem
      // with returning `true`. That said, maybe it's more appropriate to
      // `throw` in this case? Figure out what's what, and take action as
      // appropriate.

      // TODO(seefeld): Should be `true`.
      return emptySchemaObject();
    }

    let schema = cell.schema;
    if (schema === undefined) {
      // The `seen.set()` here provides a safe default which prevents the call
      // to `analyzeType()` (immediately below) from ending up recursing back
      // into this block (i.e., runaway recursion). Typically, `analyzeType()`
      // promptly overwrites the backstop.
      // TODO(seefeld): This should create `$ref: "#/.."`.
      seen.set(linkAsStr, emptySchemaObject());
      schema = analyzeType(cell.getRaw(), state);
    } else {
      // This needs to be interned for deduping during array analysis. (See
      // comments below.)
      schema = internSchema(schema);
    }
    seen.set(linkAsStr, schema);
    return schema;
  }

  // Adds the `default` when appropriate and does the necessary final result
  // processing. The result needs to be interned for deduping during array
  // analysis. (See comment below.)
  const finishResult = (schema: JSONSchema, addDefault = true): JSONSchema => {
    const result = (addDefault && state.addDefaults)
      ? schemaWithProperties(schema, { default: value })
      : schema;
    return internSchema(result);
  };

  const basicSchema = schemaForValueType(value);
  if (basicSchema === undefined) {
    // TODO(danfuzz): I think it's safe to return `true` here. (See longer
    // related comment above.)

    // Unrecognized type. Treat it as "any."
    return finishResult(emptySchemaObject());
  }

  switch (basicSchema.type) {
    case "array": {
      // The call here deduplicates the individual array element schemas using
      // object-identity-based uniquing. In order for it to work, all of the
      // schemas have to be interned. See comments above on the `internSchema()`
      // use sites that enable this.
      const items = itemsSchemaFromArray(value, state);
      const result = schemaWithProperties(basicSchema, { items });
      return finishResult(result);
    }

    case "object": {
      const entries: [string, JSONSchema][] = Object.entries(value).map(
        ([key, subValue]) => {
          return [key, analyzeType(subValue, state)];
        },
      );
      const properties = Object.fromEntries(entries);
      const result = schemaWithProperties(basicSchema, { properties });
      // `addDefault = false` because sub-properties will get defaults, if
      // any.
      return finishResult(result, false);
    }

    default: {
      return finishResult(basicSchema);
    }
  }
}

/**
 * Helper for `analyzeType()` which derives an `items` schema property from an
 * array value. The result is always an interned schema.
 */
function itemsSchemaFromArray(
  value: JSONValue[],
  state: AnalyzeTypeState,
): JSONSchema {
  // No need for any fanciness for empty or single-element arrays.
  switch (value.length) {
    case 0: {
      // TODO(danfuzz): I think it's safe to return `true` here. (See longer
      // related comment above.)
      // TODO(seefeld): should be `true` in this case.
      return emptySchemaObject();
    }
    case 1: {
      return analyzeType(value[0], state);
    }
  }

  // This `Set` constructor call achieves schema uniquing, exactly because all
  // the `schemas` are guaranteed to be interned. That is if `schema1 !==
  // schema2` (not the same actual object), then we know that they also aren't
  // equivalent (same-content objects).
  const schemas = value.map((v) => analyzeType(v, state));
  const uniqueSchemas = [...new Set(schemas)];
  return (uniqueSchemas.length === 1)
    ? uniqueSchemas[0]
    : internSchema({ anyOf: uniqueSchemas });
}

export function moduleToJSON(module: Module) {
  const frame = getTopFrame();
  // Destructure-and-drop the runtime-only methods that handler modules
  // attach for the in-builder ergonomics (`mod.with(...)`/`mod.bind(...)`).
  // They are not part of the serialized contract; left in, they would surface
  // as `Cannot store function per se`, so they are destructured out here.
  const {
    implementation: _implementation,
    toJSON: _toJSON,
    with: _with,
    bind: _bind,
    ...rest
  } = module as Module & {
    toJSON: () => any;
    with?: unknown;
    bind?: unknown;
  };
  let implementation = module.implementation;

  // CT-1230 WORKAROUND: Preserve pattern structure when serializing pattern modules.
  //
  // Problem: When a subpattern is passed to .map(), the pattern's implementation
  // was being stringified (e.g., "(inputs2) => { ... }") instead of preserving
  // the actual pattern structure. This caused "Invalid pattern" errors at runtime
  // because isPattern() check failed on the string.
  //
  // Why this helps: Using toJSONWithLegacyAliases ensures nested $alias bindings
  // get their nesting level incremented properly. Without this, aliases could be
  // bound to a specific doc too early, causing handlers to point at stale docs
  // when the pattern is later executed in a different context.
  //
  // We don't fully understand why the original code stringified pattern functions,
  // but this defensive change ensures patterns passed as values (like to map())
  // retain their structure and alias metadata.
  if (
    module.type === "pattern" && implementation && isPattern(implementation)
  ) {
    implementation = toJSONWithLegacyAliases(
      implementation as unknown as FactoryInput<any>,
    ) as unknown as Pattern;
    return {
      ...rest,
      implementation,
    };
  }

  if (typeof implementation === "function") {
    // Content-addressed reference: when the implementation function has
    // module-scope provenance (recorded by the module indexing during a
    // verified evaluation — `toJSON` runs at cell-write time,
    // post-evaluation), serialize its `{ identity, symbol }` so a rehydrated
    // module resolves by identity. Host-trusted functions carry the same
    // shape through their minted pseudo-module entry ref (identity E5,
    // design §5) — closure-bearing, so by-identity resolution is their only
    // rehydration. Everything else (test-built, never verified) keeps its
    // stringified body below for the SES fallback.
    const provenance = module.type === "javascript"
      ? getVerifiedProvenance(implementation)
      : undefined;
    // The entry-ref fallback (host pseudo-modules) is REGISTRY-scoped, unlike
    // provenance (process-global, content-derived): emit it only when the
    // serializing frame's OWN engine resolves the ref to this very function —
    // a host trust grant in another runtime of the same process proves
    // nothing here (Codex/cubic P1 on the E5 PR).
    const entryRefCandidate =
      provenance?.symbol === undefined && module.type === "javascript"
        ? getArtifactEntryRef(implementation)
        : undefined;
    const entryRefValue = entryRefCandidate !== undefined &&
        frame?.runtime?.harness?.getVerifiedImplementation?.(
            entryRefCandidate.identity,
            entryRefCandidate.symbol,
          ) === implementation
      ? entryRefCandidate
      : undefined;
    const implRefValue = (provenance?.symbol
      ? { identity: provenance.identity, symbol: provenance.symbol }
      : undefined) ?? entryRefValue;
    const implRef = implRefValue ? { $implRef: implRefValue } : {};
    const preview = (implementation as { preview?: string }).preview ??
      implementation.toString().slice(0, 200);
    const location = (implementation as { src?: string }).src;
    // Omit the stringified body only when the implementation is resolvable on
    // load BY THE RUNTIME THAT WILL READ IT: its engine's content-addressed
    // implementation index admits the `$implRef`. Provenance is
    // process-global, so a `$implRef` being PRESENT does not by itself prove
    // the reading runtime can resolve it: a pattern compiled by a standalone
    // Engine and registered on another runtime carries `$implRef`, but that
    // runtime's engine never verified-evaluated the module, so it must keep
    // the stringified body as the fallback or reload throws. The engine index
    // — unlike the bounded artifact index — never evicts within a session.
    const implRefResolvable = implRefValue !== undefined &&
      typeof frame?.runtime?.harness?.getVerifiedImplementation?.(
          implRefValue.identity,
          implRefValue.symbol,
        ) === "function";
    return {
      ...rest,
      ...implRef,
      ...(module.type === "javascript" && !implRefResolvable
        ? {
          implementation: Function.prototype.toString.call(implementation),
        }
        : {}),
      ...(preview ? { preview } : {}),
      ...(location ? { location } : {}),
    };
  }

  return {
    ...rest,
    ...(implementation !== undefined ? { implementation } : {}),
  };
}

// Ambient context: true while serializing the runtime-INTERNAL graph
// representation (builder-time node serialization via
// `toJSONWithLegacyAliases`, and through it the `$opFallback` eviction
// fallback graphs). The JSON boundary (`Pattern.toJSON()`, fired by
// JSON.stringify and by cell writes via native-conversion's HasToJSON) adds
// the content-addressed `$patternRef` on top of the graph; internal
// serialization must NOT, or in-memory `Pattern.nodes` would grow refs for
// any sub-pattern whose module is already indexed (e.g. builder calls inside
// a running action referencing an imported, already-evaluated pattern) and
// the eviction fallback would silently become a ref (design §7's $opFallback
// trap). Synchronous push/pop — serialization never awaits.
let internalGraphSerialization = false;

/**
 * Serialize a pattern's full node-graph — the runtime-internal representation
 * (design §7: the graph is internal; the boundary speaks refs-first). Used by
 * `toJSONWithLegacyAliases` (builder-time node serialization, which the
 * `$opFallback` graphs descend from) and debug tooling.
 *
 * Calls the pattern's own `toJSON` rather than `patternToJSON` directly:
 * factory `toJSON` closures deliberately serialize the ROOT factory (which
 * carries `.program`, set after construction — see builder/pattern.ts), so
 * the indirection is load-bearing.
 */
export function serializePatternGraph(
  pattern: Pattern,
): Record<string, unknown> {
  const previous = internalGraphSerialization;
  internalGraphSerialization = true;
  try {
    const withToJSON = pattern as unknown as Partial<toJSON>;
    return (typeof withToJSON.toJSON === "function"
      ? withToJSON.toJSON()
      : patternToJSON(pattern)) as Record<string, unknown>;
  } finally {
    internalGraphSerialization = previous;
  }
}

export function patternToJSON(pattern: Pattern) {
  // Serialize only the STABLE program identity ({main, mainExport}), never the
  // authored `files`. The `files` array serializes non-canonically (two
  // encodings -> two content ids), so embedding it dragged a session-varying
  // blob into every serialized pattern and thrashed link ids / re-ran actions
  // on reload. {main, mainExport} are deterministic strings, so they reload
  // stably; they are kept because consumers read them (e.g. the CLI
  // `dev --pattern-json` output asserts `program.mainExport`). The full
  // program-with-files is recovered from the `pattern:<identity>` source docs
  // (the single durable source — written by every cold compile);
  // sub-patterns are referenced by {identity, symbol} on the ESM path.
  const program = getPatternProgram(pattern);
  const programIdentity = program
    ? {
      main: program.main,
      ...(program.mainExport !== undefined
        ? { mainExport: program.mainExport }
        : {}),
    }
    : undefined;
  const graph = {
    argumentSchema: pattern.argumentSchema,
    resultSchema: pattern.resultSchema,
    ...(pattern.derivedInternalCells
      ? { derivedInternalCells: pattern.derivedInternalCells }
      : {}),
    result: pattern.result,
    nodes: pattern.nodes,
    ...(programIdentity ? { program: programIdentity } : {}),
  };
  if (internalGraphSerialization) return graph;
  // JSON boundary (cell writes, JSON.stringify): REFS-ONLY (design §7,
  // identity E4). The ref is content-derived, so identical bytes re-emit the
  // identical ref across sessions. Schemas ride along so consumers can read
  // them without resolving (llm-dialog tool schemas). Rehydration goes by
  // identity: the session-lifetime artifact index covers every module
  // evaluated in the reading session (any authored op, by construction), and
  // async readers fall back to the storage-backed `loadPatternByIdentity` —
  // compiled artifacts persist in-space as an expected part of compilation.
  // A pattern with NO entry ref (manually constructed / dynamic) still
  // serializes its full graph: nothing could ever resolve its ref.
  const entryRef = getArtifactEntryRef(pattern);
  return entryRef
    ? {
      $patternRef: { identity: entryRef.identity, symbol: entryRef.symbol },
      argumentSchema: pattern.argumentSchema,
      resultSchema: pattern.resultSchema,
    }
    : graph;
}
