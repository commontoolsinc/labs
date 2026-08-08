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
 * materializing what nobody wants. A reader that does touch data the schema no
 * longer describes gets a {@link SchemaMismatchError}, and the read that failed
 * is registered before it throws, so whatever depends on this read runs again
 * when the missing data arrives.
 *
 * The root is the exception: a mismatch there yields `undefined`, which is what
 * an eager read yields for the same data, so the runner's existing
 * "argument did not resolve" gate handles it unchanged.
 */

import type { JSONSchema, JSONSchemaObj } from "@commonfabric/api";
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
import { canBranchMatch, mergeAnyOfBranchSchemas } from "./traverse.ts";
import { processDefaultValue, validateAndTransform } from "./schema.ts";

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

/** The JSON type name a schema's `type` keyword would use for this value. */
const jsonTypeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof FabricPrimitive) return "object";
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
    type === actual ||
    type === "unknown" ||
    // A schema saying "number" accepts an integer; one saying "integer" does
    // not accept a fractional number.
    (type === "number" && actual === "integer")
  );
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
  const branches = schema.anyOf ?? schema.oneOf;
  if (!Array.isArray(branches) || branches.length === 0) return schema;
  const matching = branches.filter((branch) => canBranchMatch(branch, value));
  if (matching.length === 0) return false;
  if (matching.length === 1) {
    return isRecord(matching[0]) && isRecord(schema.$defs)
      ? { ...matching[0] as JSONSchemaObj, $defs: schema.$defs }
      : matching[0];
  }
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
  return ContextualFlowControl.schemaAtPath(
    schema,
    [key],
    undefined,
    EXCLUDED_EMPTY,
    EXCLUDED_MISSING,
  );
};

const declaredDefault = (schema: JSONSchema): FabricValue | undefined => {
  if (!isRecord(schema)) return undefined;
  const resolved = ContextualFlowControl.resolveSchemaRefs(schema);
  return isRecord(resolved)
    ? resolved.default as FabricValue | undefined
    : undefined;
};

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
    if (isRoot) return undefined;
    const refusal = new SchemaMismatchError(link, reason);
    // Record before throwing: a reader can catch this and carry on, and the
    // run still has to be disposed of as an argument that did not resolve.
    tx.noteSchemaRefusal(refusal);
    throw refusal;
  };

  const schema = narrowForValue(link.schema, value);
  if (schema === false) {
    return mismatch("no branch of the schema matches this value");
  }

  const actualType = jsonTypeOf(value);
  if (isRecord(schema) && schema.type !== undefined) {
    if (!typeAccepts(schema.type, actualType)) {
      return mismatch(
        `expected ${JSON.stringify(schema.type)}, found ${actualType}`,
      );
    }
  }

  // A primitive, and a `FabricPrimitive` with it, is a leaf: the type check
  // above is the whole of what a schema says about it.
  if (!isRecord(value) || value instanceof FabricPrimitive) {
    // The caller read this document without telling the scheduler — the eager
    // traverser registers its own reads as it walks, and so does a view. A leaf
    // is a value the reader materializes, so the read is recursive: change the
    // value and whatever read it runs again.
    tx.readValueOrThrow(link);
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
    { synced, mismatchThrows: true },
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
  const child = (key: string): unknown => {
    const narrowed = childSchema(schema, key);
    if (isExcluded(narrowed)) return undefined;
    if (!Object.hasOwn(value, key)) {
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
    return readChild(runtime, tx, link, key, narrowed, cfcLabelView, synced);
  };

  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => {
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
