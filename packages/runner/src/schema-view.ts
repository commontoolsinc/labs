/**
 * The schema-observing lazy view.
 *
 * Where `validateAndTransform` builds everything a schema selects in one pass,
 * a view resolves each path as the reader touches it, narrowing the schema by
 * that step. What the reader never asks for is never built, never link-resolved
 * and never registered as a reactive dependency.
 *
 * A view is reached only from a transaction marked with `markLazyMaterialize`;
 * `validateAndTransform` reads that mark and branches here after its own link
 * resolution, `asCell` dispatch and schema combination have run, so a view and
 * an eager read agree on which link and which schema they are looking at.
 *
 * ## What a view checks, and when
 *
 * At the container it is built over: the value's type against the schema's, and
 * the presence of the schema's `required` keys. Both come off the container read
 * a view takes anyway, so neither descends.
 *
 * Everything below that is checked where the reader touches it. A subtree the
 * reader never reads is never validated — the deliberate cost of not
 * materializing what nobody wants.
 *
 * A mismatch the reader does touch surfaces at the nearest enclosing property,
 * which is where an eager read decides the same question. Under a `required`
 * property it becomes a {@link SchemaMismatchError}; under an optional one it
 * reads as `undefined`, because an eager read leaves a property whose traversal
 * fails out of the object rather than voiding it. Either way the read that
 * failed is registered first, so whatever depends on it runs again when the
 * missing data arrives.
 *
 * The root is the exception: a mismatch there yields `undefined`, which is what
 * an eager read yields for the same data, so the runner's existing
 * "argument did not resolve" gate handles it unchanged.
 */

import type {
  JSONSchema,
  JSONSchemaObj,
  JSONSchemaTypes,
} from "@commonfabric/api";
import { FabricPrimitive } from "@commonfabric/data-model/fabric-value";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";
import { isRecord } from "@commonfabric/utils/types";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { ContextualFlowControl } from "./cfc.ts";
import {
  type CfcLabelView,
  rebaseCfcLabelView,
} from "./cfc/label-view-state.ts";
import { type Cell, createCell } from "./cell.ts";
import { toCell } from "./back-to-cell.ts";
import { type NormalizedFullLink } from "./link-utils.ts";
import { type Runtime } from "./runtime.ts";
import { type IExtendedStorageTransaction } from "./storage/interface.ts";
import {
  canBranchMatch,
  mergeAnyOfBranchSchemas,
  opaqueLeafMissesRequired,
  schemaTypeMatchesValueType,
} from "./traverse.ts";
import { schemaTypeOfFabricPrimitive } from "@commonfabric/data-model/fabric-primitives";
import { processDefaultValue, validateAndTransform } from "./schema.ts";
import { getLogger } from "@commonfabric/utils/logger";

const logger = getLogger("schema-view", { enabled: false, level: "warn" });

/**
 * Thrown when a reader touches data the schema does not describe.
 *
 * The runner treats one of these as an argument that did not resolve rather
 * than as a fault: the run could not proceed on the data available, which is a
 * non-event, not a failure.
 */
export class SchemaMismatchError extends Error {
  override readonly name = "SchemaMismatchError";
  readonly link: NormalizedFullLink;
  readonly reason: string;

  constructor(link: NormalizedFullLink, reason: string) {
    super(
      `Schema mismatch at ${link.id}/${link.path.join("/")}: ${reason}`,
    );
    this.link = link;
    this.reason = reason;
  }
}

export function isSchemaMismatchError(
  error: unknown,
): error is SchemaMismatchError {
  return error instanceof SchemaMismatchError;
}

// `schemaAtPath` reports a property the schema does not select by handing back
// one of these instead of a subschema, so a view can tell "not selected" from
// "selected as anything". An eager read drops such a property; so does a view.
const EXCLUDED_EMPTY: JSONSchema = Object.freeze({
  $comment: "emptyProperties",
});
const EXCLUDED_MISSING: JSONSchema = Object.freeze({
  $comment: "missingProperty",
});

const isExcluded = (schema: JSONSchema): boolean =>
  isRecord(schema) &&
  (schema.$comment === "emptyProperties" ||
    schema.$comment === "missingProperty");

/**
 * The type name a schema's `type` keyword would use for this value.
 *
 * A `FabricPrimitive` answers with its own concrete name (`FabricBytes` and the
 * rest), which is what a schema selecting one declares; `schemaTypeMatchesValueType`
 * still lets an `object` schema accept it through its subtype rule.
 */
const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof FabricPrimitive) {
    return schemaTypeOfFabricPrimitive(value);
  }
  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "boolean":
      return "boolean";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "string":
      return "string";
    default:
      return "object";
  }
};

const typeAccepts = (declared: unknown, actual: string): boolean => {
  const types = Array.isArray(declared) ? declared : [declared];
  return types.some((type) =>
    type === "unknown" ||
    // The same matcher eager traversal uses, so a `FabricBytes` value is
    // accepted both by its own type name and by an `object` schema, and a
    // "number" schema accepts an integer while "integer" refuses a fraction.
    schemaTypeMatchesValueType(
      type as JSONSchemaTypes,
      actual as JSONSchemaTypes,
    )
  );
};

/**
 * Collapse a union onto a branch that declares `asCell`, when one does.
 *
 * An optional handle — `Cell<T> | undefined` — generates as a union whose one
 * branch carries the marker and whose other is the absent case. `hasAsCell`
 * answers for a union only when EVERY branch declares one, so that shape reads
 * as "not a cell" and the reader gets a plain value where the pattern declared
 * a handle. An eager read survives it by evaluating every branch and picking
 * the cell among the results (`mergeMatches`); collapsing to the branch is the
 * same answer, decided on the schema instead.
 */
const preferAsCellBranch = (schema: JSONSchema): JSONSchema => {
  if (!isRecord(schema)) return schema;
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches)) return schema;
  const resolved = branches.map((branch) => resolveBranch(branch, schema));
  if (
    resolved.some((branch) =>
      ContextualFlowControl.getAsCellValues(branch).length > 0
    )
  ) {
    const chosen = resolved.find((branch) =>
      ContextualFlowControl.getAsCellValues(branch).length > 0
    )!;
    return isRecord(chosen) && isRecord(schema.$defs)
      ? { ...chosen as JSONSchemaObj, $defs: schema.$defs }
      : chosen;
  }
  return schema;
};

/** A branch with its `$ref` resolved against the union's own `$defs`. */
const resolveBranch = (
  branch: JSONSchema,
  parent: JSONSchemaObj,
): JSONSchema => {
  if (!isRecord(branch) || !("$ref" in branch) || !isRecord(parent.$defs)) {
    return branch;
  }
  try {
    const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(
      branch as JSONSchemaObj,
      { $defs: parent.$defs } as JSONSchemaObj,
    );
    return isRecord(resolved) ? resolved : branch;
  } catch (error) {
    // An unresolvable ref stays as it was, so matching keeps the branch: a
    // schema this runtime cannot read is not evidence that the data fails it,
    // and narrowing the branch away would refuse a read the eager path serves.
    // It is worth saying out loud, though — an unresolvable ref means a schema
    // document that did not replicate.
    logger.warn(
      "schema-view",
      () => ["unresolvable $ref in a union branch", branch, error],
    );
    return branch;
  }
};

/**
 * Narrow a union against the value in front of it.
 *
 * `canBranchMatch` is a shallow prefilter — type plus required-key presence,
 * no descent — so this stays a decision about the container already read. One
 * surviving branch narrows to it; several merge the way an eager read merges
 * them; none is a mismatch.
 */
const narrowForValue = (
  schema: JSONSchema | undefined,
  value: FabricValue,
): JSONSchema | undefined => {
  if (!isRecord(schema)) return schema;
  const rawBranches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(rawBranches) || rawBranches.length === 0) return schema;
  // Resolve `$ref` branches against this schema's own `$defs` first. A branch
  // written as a bare `$ref` carries no `type`, no `required` and no `asCell`,
  // so matching it decides nothing: every branch survives, the union never
  // narrows, and whatever the branches declared — including a property the
  // pattern declared as a `Cell` — is unreachable. `canBranchMatch` resolves a
  // ref on its own but has no `$defs` to resolve it against, which is where the
  // "Unresolved $ref in schema" warnings come from.
  const branches = rawBranches.map((branch) => resolveBranch(branch, schema));
  const matching = branches.filter((branch) => canBranchMatch(branch, value));
  if (matching.length === 0) return false;
  const withDefs = (branch: JSONSchema): JSONSchema =>
    isRecord(branch) && isRecord(schema.$defs)
      ? { ...branch as JSONSchemaObj, $defs: schema.$defs }
      : branch;
  if (matching.length === 1) return withDefs(matching[0]);
  // Prefer a branch that declares `asCell`. An eager read evaluates every
  // matching branch and picks the cell among the results (`mergeMatches`);
  // merging the SCHEMAS instead leaves the marker off the merged top level, so
  // a property the pattern declared as a `Cell` — `authorProfile: ProfileCell`
  // on a message union — comes back as a plain value and `.get()` is not a
  // function. Preferring the branch keeps the two reads agreeing.
  const asCellBranch = matching.find((branch) =>
    ContextualFlowControl.getAsCellValues(branch).length > 0
  );
  if (asCellBranch !== undefined) return withDefs(asCellBranch);
  return mergeAnyOfBranchSchemas(matching as JSONSchema[], schema) ?? schema;
};

const requiredKeys = (schema: JSONSchema | undefined): readonly string[] =>
  isRecord(schema) && Array.isArray(schema.required)
    ? schema.required as string[]
    : [];

const childSchema = (
  schema: JSONSchema | undefined,
  key: string,
): JSONSchema => {
  if (schema === undefined) return true;
  const narrowed = ContextualFlowControl.schemaAtPath(
    schema,
    [key],
    undefined,
    EXCLUDED_EMPTY,
    EXCLUDED_MISSING,
  );
  if (narrowed !== false || !isRecord(schema)) {
    return preferAsCellBranch(narrowed);
  }
  // `schemaAtPath` decides which children exist from the schema's `type`, so a
  // schema that declares `properties` or `items` and omits `type` narrows to
  // `false` — no child selected. An eager read reaches those children, and the
  // subschema is right there, so read it directly rather than refuse. Losing it
  // costs more than a refusal: the child's `asCell` marker goes with it, and
  // the reader gets a plain view where the pattern declared a `Cell`.
  if (isRecord(schema.properties) && Object.hasOwn(schema.properties, key)) {
    return (schema.properties as Record<string, JSONSchema>)[key];
  }
  if (isArrayIndexPropertyName(key) && schema.items !== undefined) {
    return schema.items as JSONSchema;
  }
  return false;
};

const declaredDefault = (schema: JSONSchema): FabricValue | undefined => {
  if (!isRecord(schema)) return undefined;
  const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
  return isRecord(resolved)
    ? resolved.default as FabricValue | undefined
    : undefined;
};

/**
 * The default that stands in for a value which is not there.
 *
 * Only one the schema declares at its own top level, which is the rule an eager
 * read applies: a default sitting inside a branch of a union is reached by
 * evaluating that branch against a value, and an absent value gets no branch
 * evaluated. Reading one out anyway would answer where an eager read leaves the
 * value absent.
 */
const defaultForAbsentValue = (
  schema: JSONSchema | undefined,
): FabricValue | undefined =>
  isRecord(schema) ? declaredDefault(schema) : undefined;

/**
 * Build a view over `value` at `link`, or report that the data does not match.
 *
 * `link.schema` is the effective schema the caller has already combined from
 * the reader's shape and the link's own. `value` is the container read at that
 * link, which the caller has already taken.
 *
 * At the root a mismatch is `undefined` — the answer an eager read gives for
 * the same data. Below it, a mismatch throws.
 */
export function materializeSchemaView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: FabricValue,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
  isRoot: boolean,
): unknown {
  const mismatch = (reason: string): undefined => {
    // Register the read that failed before doing anything else. A refusal has
    // to leave behind the dependency that re-triggers the reader when the data
    // it wanted arrives; `noteSchemaRefusal` records the error, not the read.
    // Recursive, because what failed is a value the reader asked for.
    tx.readValueOrThrow(link);
    if (isRoot) return undefined;
    const refusal = new SchemaMismatchError(link, reason);
    // Record as well as throw: a reader can catch this and carry on, and the
    // run still has to be disposed of as an argument that did not resolve.
    tx.noteSchemaRefusal(refusal);
    throw refusal;
  };

  // A value that is not there takes the schema's declared default, which an
  // eager read applies before it decides whether the type matches. Decided
  // ahead of the narrowing verdict below: an absent value matches no branch of a
  // union, so narrowing would refuse where the schema says what to read instead.
  if (value === undefined) {
    const fallback = defaultForAbsentValue(link.schema);
    if (fallback !== undefined) {
      // Register the read the default is standing in for. The value was taken
      // without telling the scheduler, so without this the reader holds no
      // dependency on the path it just found empty and never runs again when it
      // fills — a computed that has not produced yet would read as its default
      // forever. Recursive: anything arriving at or below this path changes the
      // answer.
      tx.readValueOrThrow(link);
      return processDefaultValue(
        runtime,
        tx,
        link,
        fallback,
        synced,
        cfcLabelView,
      );
    }
  }

  const schema = narrowForValue(link.schema, value);
  if (schema === false) {
    return mismatch("no branch of the schema matches this value");
  }

  if (ContextualFlowControl.getAsCellValues(schema).length > 0) {
    // `validateAndTransform` dispatches `asCell` before handing over, but only
    // on what it can see at the top of the schema. Narrowing a union against
    // the value can surface a branch that declares one, and the reader is owed
    // the same handle either route would have produced.
    //
    // Hand it back rather than minting one here. Minting a handle is where the
    // consumed `asCell` marker is unwrapped off the handle's own schema and
    // where the follow-scope cap is applied — a read THROUGH the handle is
    // exactly the hop that cap bounds — and that belongs in one place. Passing
    // the narrowed schema back means the dispatch sees the marker it could not
    // see before and takes that path; it returns the handle without arriving
    // here again, so this does not recur.
    return validateAndTransform(
      runtime,
      tx,
      { link: { ...link, schema }, cfcLabelView },
      [],
      { synced, mismatchThrows: !isRoot, viewChild: true },
    );
  }

  const actualType = jsonTypeOf(value);
  if (isRecord(schema) && schema.type !== undefined) {
    if (!typeAccepts(schema.type, actualType)) {
      return mismatch(
        `expected ${JSON.stringify(schema.type)}, found ${actualType}`,
      );
    }
  }

  // An opaque leaf still owes the schema's `required` keys. A `FabricPrimitive`
  // answers them through class accessors — `FabricBytes.length` satisfies
  // `required: ["length"]` — so the check is prototype-chain membership with
  // the brand exemption, which is what an eager read applies before letting one
  // through.
  if (value instanceof FabricPrimitive && isRecord(schema)) {
    if (opaqueLeafMissesRequired(schema, value)) {
      return mismatch("opaque leaf is missing a required property");
    }
  }

  // A primitive, and a `FabricPrimitive` with it, is a leaf: the type check
  // above is the whole of what a schema says about it.
  if (!isRecord(value) || value instanceof FabricPrimitive) {
    // The caller read this document without telling the scheduler — the eager
    // traverser registers its own reads as it walks, and so does a view. Same
    // granularity it uses: non-recursive, which a write at this path still
    // invalidates, and which keeps a view's read set comparable to an eager
    // one's when both are measured against a declared scope envelope.
    tx.readValueOrThrow(link, { nonRecursive: true });
    return value;
  }

  // A container's shape is what the view observed to build itself; what is
  // inside it is registered when the reader touches it. Non-recursive, so a
  // write below this path does not re-trigger a reader that never looked.
  tx.readValueOrThrow(link, { nonRecursive: true });

  const viewLink: NormalizedFullLink = { ...link, schema };

  if (Array.isArray(value)) {
    return createArrayView(
      runtime,
      tx,
      viewLink,
      value,
      cfcLabelView,
      synced,
    );
  }

  for (const key of requiredKeys(schema)) {
    if (Object.hasOwn(value, key)) continue;
    // A declared default stands in for an absent required key, exactly as it
    // does for an eager read.
    if (declaredDefault(childSchema(schema, key)) !== undefined) continue;
    return mismatch(`missing required property ${JSON.stringify(key)}`);
  }

  return createObjectView(runtime, tx, viewLink, value, cfcLabelView, synced);
}

/** The keys a reader sees: the data's own keys the schema selects, plus any
 * declared property that is absent but carries a default. */
const visibleKeys = (
  schema: JSONSchema | undefined,
  value: Record<string, FabricValue>,
): string[] => {
  const keys = Object.keys(value).filter((key) =>
    !isExcluded(childSchema(schema, key))
  );
  if (isRecord(schema) && isRecord(schema.properties)) {
    for (const key of Object.keys(schema.properties)) {
      if (Object.hasOwn(value, key)) continue;
      if (declaredDefault(childSchema(schema, key)) === undefined) continue;
      keys.push(key);
    }
  }
  return keys;
};

const readChild = (
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  key: string,
  schema: JSONSchema,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
): unknown => {
  const childLink: NormalizedFullLink = {
    ...link,
    path: [...link.path, key],
    schema,
  };
  // Back through the front door: link resolution, `asCell` dispatch and schema
  // combination all belong there, and a marked transaction lands back here for
  // whatever the child turns out to be. `mismatchThrows` is what makes a
  // mismatch below the root a refusal rather than an `undefined` the reader
  // cannot tell from an absent value.
  return validateAndTransform(
    runtime,
    tx,
    { link: childLink, cfcLabelView: rebaseCfcLabelView(cfcLabelView, [key]) },
    [],
    { synced, mismatchThrows: true, viewChild: true },
  );
};

const refuseMutation = (what: string): never => {
  throw new Error(
    `Cannot ${what} a schema view; it is a read, not a value you own. ` +
      "Snapshot it first, or write through the cell.",
  );
};

function createObjectView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: Record<string, FabricValue>,
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
): unknown {
  const schema = link.schema;
  const required = new Set(requiredKeys(schema));
  const child = (key: string): unknown => {
    const narrowed = childSchema(schema, key);
    if (isExcluded(narrowed)) return undefined;
    if (!Object.hasOwn(value, key)) {
      // Register the read even though there is nothing there. An absent key is
      // usually a computed that has not produced yet, and the reader has to run
      // again when it does — a container read alone does not carry that, since
      // the value arrives at the child's own path. This is the same obligation
      // a refusal carries, for the case that is not a refusal: the schema does
      // not require this key, so reading it is an ordinary miss, not a mismatch.
      tx.readValueOrThrow({ ...link, path: [...link.path, key] });
      const fallback = declaredDefault(narrowed);
      if (fallback === undefined) return undefined;
      return processDefaultValue(
        runtime,
        tx,
        { ...link, path: [...link.path, key], schema: narrowed },
        fallback,
        synced,
        rebaseCfcLabelView(cfcLabelView, [key]),
      );
    }
    if (required.has(key)) {
      return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
    }
    // A property the schema does not require reads as `undefined` when the data
    // underneath does not match it. That is what an eager read leaves behind: a
    // property whose traversal fails is left out of the object, and only a
    // `required` one takes the object down with it. Refusing here instead would
    // stop a reader the eager path runs — a field waiting on a computed that has
    // not produced is the ordinary case, not a fault.
    try {
      return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
    } catch (error) {
      if (!isSchemaMismatchError(error)) throw error;
      // The view asked for this read and the view is answering for it, so the
      // refusal never reaches the reader and must not survive on the
      // transaction. The read it registered does survive, which is what brings
      // the reader back when the data arrives.
      tx.clearSchemaRefusal(error);
      return undefined;
    }
  };

  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
      // See the same guard in `query-result-proxy.ts`: promise adoption probes
      // `then`, and a view that refuses the probe cannot be returned from a
      // lift at all.
      if (prop === "then" && tx.status().status !== "ready") return undefined;
      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return (): Cell<unknown> =>
            createCell(runtime, link, tx, synced, undefined, cfcLabelView);
        }
        return Reflect.get(value, prop);
      }
      return child(prop);
    },
    ownKeys: () => visibleKeys(schema, value),
    getOwnPropertyDescriptor: (_target, prop) => {
      if (typeof prop === "symbol") return undefined;
      if (!visibleKeys(schema, value).includes(prop)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: child(prop),
      };
    },
    has: (_target, prop) =>
      typeof prop === "symbol"
        ? prop in value
        : visibleKeys(schema, value).includes(prop),
    set: () => refuseMutation("assign to"),
    deleteProperty: () => refuseMutation("delete from"),
    defineProperty: () => refuseMutation("define properties on"),
    preventExtensions: () => refuseMutation("freeze or seal"),
  });
}

function createArrayView(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  link: NormalizedFullLink,
  value: FabricValue[],
  cfcLabelView: CfcLabelView | undefined,
  synced: boolean,
): unknown {
  const schema = link.schema;
  const element = (index: number): unknown =>
    readChild(
      runtime,
      tx,
      link,
      String(index),
      childSchema(schema, String(index)),
      cfcLabelView,
      synced,
    );

  // A read-only array method runs against element views built on demand. The
  // methods that would reshape the array are absent: a view is a read.
  const materialize = (): unknown[] => {
    const copy = new Array<unknown>(value.length);
    for (let index = 0; index < value.length; index++) {
      if (!(index in value)) continue;
      copy[index] = element(index);
    }
    return copy;
  };

  return new Proxy(new Array(value.length), {
    get: (_target, prop, receiver) => {
      if (prop === "then" && tx.status().status !== "ready") return undefined;
      if (prop === "length") return value.length;
      if (typeof prop === "symbol") {
        if (prop === toCell) {
          return (): Cell<unknown> =>
            createCell(runtime, link, tx, synced, undefined, cfcLabelView);
        }
        if (prop === Symbol.iterator) {
          return function* () {
            for (let index = 0; index < value.length; index++) {
              yield element(index);
            }
          };
        }
        return Reflect.get(value, prop);
      }
      if (isArrayIndexPropertyName(prop)) {
        const index = Number(prop);
        return index in value ? element(index) : undefined;
      }
      const method = Reflect.get(Array.prototype, prop, receiver);
      if (typeof method !== "function") return method;
      if (!READ_ONLY_ARRAY_METHODS.has(prop)) {
        return () => refuseMutation(`call ${prop}() on`);
      }
      return (...args: unknown[]) =>
        (method as (...a: unknown[]) => unknown).apply(materialize(), args);
    },
    ownKeys: () => {
      // Enumeration (`Object.keys`, a spread, `for...in`) has to see the same
      // indices `getOwnPropertyDescriptor` reports as present, or a view reads
      // as an empty array to every consumer that enumerates it.
      const keys = Object.keys(value).filter(isArrayIndexPropertyName);
      keys.push("length");
      return keys;
    },
    getOwnPropertyDescriptor: (target, prop) => {
      if (prop === "length") {
        return Object.getOwnPropertyDescriptor(target, "length");
      }
      if (typeof prop === "symbol" || !isArrayIndexPropertyName(prop)) {
        return undefined;
      }
      const index = Number(prop);
      if (!(index in value)) return undefined;
      return {
        configurable: true,
        enumerable: true,
        writable: false,
        value: element(index),
      };
    },
    has: (_target, prop) =>
      typeof prop === "symbol"
        ? prop in value
        : prop === "length" || prop in value,
    set: () => refuseMutation("assign to"),
    deleteProperty: () => refuseMutation("delete from"),
    defineProperty: () => refuseMutation("define properties on"),
    preventExtensions: () => refuseMutation("freeze or seal"),
  });
}

const READ_ONLY_ARRAY_METHODS = new Set<string>([
  "at",
  "concat",
  "entries",
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flat",
  "flatMap",
  "forEach",
  "includes",
  "indexOf",
  "join",
  "keys",
  "lastIndexOf",
  "map",
  "reduce",
  "reduceRight",
  "slice",
  "some",
  "toLocaleString",
  "toReversed",
  "toSorted",
  "toSpliced",
  "toString",
  "values",
  "with",
]);
