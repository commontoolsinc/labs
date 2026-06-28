import { BuiltInLLMDialogState } from "@commonfabric/api";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { createNodeFactory, lift } from "./module.ts";
import type {
  JSONSchema,
  NodeFactory,
  Opaque,
  OpaqueRef,
  PatternFactory,
  Schema,
} from "./types.ts";
import type { Cell as CellType } from "./types.ts";
import type {
  BuiltInCompileAndRunParams,
  BuiltInCompileAndRunState,
  BuiltInGenerateObjectParams,
  BuiltInGenerateTextParams,
  BuiltInGenerateTextState,
  BuiltInLLMGenerateObjectState,
  BuiltInLLMParams,
  BuiltInLLMState,
  FetchOptions,
  PatternToolFunction,
  PatternToolResult,
  SqliteDatabaseFunction,
  SqliteQueryFunction,
  UIVariantKind,
  VNode,
  WishParams,
  WishState,
} from "commonfabric";
import { h } from "@commonfabric/html";
import { isRecord } from "@commonfabric/utils/types";
import { isCell } from "../cell.ts";
import { sqliteQueryNodeFactory } from "../builtins/sqlite/query-node.ts";
import { LLMDialogResultSchema } from "../builtins/llm-schemas.ts";
import { recordVerifiedProvenance } from "../harness/verified-provenance.ts";

const WISH_ARGUMENT_SCHEMA = internSchema({
  type: "object",
  properties: {
    query: { type: "string" },
    path: { type: "array", items: { type: "string" } },
    schema: { type: "object" },
    context: {
      type: "object",
      additionalProperties: {
        anyOf: [
          { type: "unknown", asCell: ["cell"] },
          { type: "unknown", asCell: ["opaque"] },
        ],
      },
    },
    scope: { type: "array", items: { type: "string" } },
  },
});

/**
 * Signature detection for ifElse/when/unless backward compatibility.
 *
 * These functions support two call signatures:
 * - Legacy (no schemas): ifElse(condition, ifTrue, ifFalse)
 * - With schemas: ifElse(condSchema, trueSchema, falseSchema, resultSchema, condition, ifTrue, ifFalse)
 *
 * We CANNOT use `arg !== undefined` to detect which signature was used because
 * `undefined` is a valid VALUE in either signature. For example:
 *   ifElse(pending, undefined, { result })  // Legacy: undefined is the ifTrue value
 *
 * When transformed with schema injection, this becomes:
 *   ifElse(schema1, schema2, schema3, schema4, pending, undefined, { result })
 *
 * If we checked `ifTrue !== undefined`, we'd incorrectly detect the legacy signature
 * and pass schemas as values, causing the runtime to hang.
 *
 * Instead, we use arguments.length which correctly distinguishes the signatures.
 *
 * If these signatures ever change, update the constants below and the corresponding tests.
 */
export const SIGNATURE_ARGS = {
  ifElse: { legacy: 3, withSchemas: 7 },
  when: { legacy: 2, withSchemas: 5 },
  unless: { legacy: 2, withSchemas: 5 },
} as const;

/** Returns true if ifElse was called with schema arguments prepended */
export function ifElseHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.ifElse.withSchemas;
}

/** Returns true if when was called with schema arguments prepended */
export function whenHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.when.withSchemas;
}

/** Returns true if unless was called with schema arguments prepended */
export function unlessHasSchemas(argsLength: number): boolean {
  return argsLength >= SIGNATURE_ARGS.unless.withSchemas;
}

export const compileAndRun = createNodeFactory({
  type: "ref",
  implementation: "compileAndRun",
}) as <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export const llm = createNodeFactory({
  type: "ref",
  implementation: "llm",
}) as (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState>;

export const llmDialog = createNodeFactory({
  type: "ref",
  implementation: "llmDialog",
  resultSchema: LLMDialogResultSchema,
  propagateInputIfc: false,
}) as (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMDialogState>;

export const generateObject = createNodeFactory({
  type: "ref",
  implementation: "generateObject",
}) as <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

export const generateText = createNodeFactory({
  type: "ref",
  implementation: "generateText",
}) as (
  params: Opaque<BuiltInGenerateTextParams>,
) => OpaqueRef<BuiltInGenerateTextState>;

export const fetchData = createNodeFactory({
  type: "ref",
  implementation: "fetchData",
}) as <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error?: unknown }>;

export const fetchProgram = createNodeFactory({
  type: "ref",
  implementation: "fetchProgram",
}) as (
  params: Opaque<{ url: string }>,
) => OpaqueRef<{
  pending: boolean;
  result: {
    files: Array<{ name: string; contents: string }>;
    main: string;
  } | undefined;
  error?: unknown;
}>;

export const streamData = createNodeFactory({
  type: "ref",
  implementation: "streamData",
}) as <T>(
  params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error?: unknown }>;

export const sqliteDatabase = createNodeFactory({
  type: "ref",
  implementation: "sqliteDatabase",
}) as SqliteDatabaseFunction;

// Shares the single `sqliteQuery` node factory with `db.query` (cell.ts) — see
// builtins/sqlite/query-node.ts — so both construct the same node.
export const sqliteQuery =
  sqliteQueryNodeFactory as unknown as SqliteQueryFunction;

// ifElse with optional schema arguments (backward compatible)
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function ifElse<T = unknown, U = unknown, V = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  ifTrueSchemaOrIfTrue: JSONSchema | Opaque<U>,
  ifFalseSchemaOrIfFalse: JSONSchema | Opaque<V>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  ifTrue?: Opaque<U>,
  ifFalse?: Opaque<V>,
): OpaqueRef<U | V> {
  ifElseFactory ||= createNodeFactory({
    type: "ref",
    implementation: "ifElse",
  });

  if (ifElseHasSchemas(arguments.length)) {
    return ifElseFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      ifTrueSchema: ifTrueSchemaOrIfTrue as JSONSchema,
      ifFalseSchema: ifFalseSchemaOrIfFalse as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      ifTrue,
      ifFalse,
    }) as OpaqueRef<U | V>;
  }

  // Legacy signature: ifElse(cond, ifTrue, ifFalse)
  return ifElseFactory({
    condition: conditionSchemaOrCondition,
    ifTrue: ifTrueSchemaOrIfTrue,
    ifFalse: ifFalseSchemaOrIfFalse,
  }) as OpaqueRef<U | V>;
}

let ifElseFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    ifTrueSchema?: JSONSchema;
    ifFalseSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    ifTrue: unknown;
    ifFalse: unknown;
  }, any>
  | undefined;

// when(condition, value) - returns value if condition is truthy, else condition
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function when<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  valueSchemaOrValue: JSONSchema | Opaque<U>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  value?: Opaque<U>,
): OpaqueRef<T | U> {
  whenFactory ||= createNodeFactory({
    type: "ref",
    implementation: "when",
  });

  if (whenHasSchemas(arguments.length)) {
    return whenFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      valueSchema: valueSchemaOrValue as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      value,
    }) as OpaqueRef<T | U>;
  }

  // Legacy signature: when(cond, value)
  return whenFactory({
    condition: conditionSchemaOrCondition,
    value: valueSchemaOrValue,
  }) as OpaqueRef<T | U>;
}

let whenFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    valueSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    value: unknown;
  }, any>
  | undefined;

// unless(condition, fallback) - returns condition if truthy, else fallback
// See SIGNATURE_ARGS documentation above for why we use arguments.length
export function unless<T = unknown, U = unknown>(
  conditionSchemaOrCondition: JSONSchema | Opaque<T>,
  fallbackSchemaOrFallback: JSONSchema | Opaque<U>,
  resultSchemaOrCondition?: JSONSchema | Opaque<T>,
  condition?: Opaque<T>,
  fallback?: Opaque<U>,
): OpaqueRef<T | U> {
  unlessFactory ||= createNodeFactory({
    type: "ref",
    implementation: "unless",
  });

  if (unlessHasSchemas(arguments.length)) {
    return unlessFactory({
      conditionSchema: conditionSchemaOrCondition as JSONSchema,
      fallbackSchema: fallbackSchemaOrFallback as JSONSchema,
      resultSchema: resultSchemaOrCondition as JSONSchema,
      condition,
      fallback,
    }) as OpaqueRef<T | U>;
  }

  // Legacy signature: unless(cond, fallback)
  return unlessFactory({
    condition: conditionSchemaOrCondition,
    fallback: fallbackSchemaOrFallback,
  }) as OpaqueRef<T | U>;
}

let unlessFactory:
  | NodeFactory<{
    conditionSchema?: JSONSchema;
    fallbackSchema?: JSONSchema;
    resultSchema?: JSONSchema;
    condition: unknown;
    fallback: unknown;
  }, any>
  | undefined;

/**
 * uiVariant(piece, kind) — render a piece at a UI variant (`full` | `chip` |
 * `tile`) from render paths that aren't already `<cf-render>` JSX (CT-1321
 * Phase B / CT-1766).
 *
 * Returns a `cf-render` VNode bound to the piece, i.e. it is exactly equivalent
 * to writing `<cf-render variant={kind} $cell={piece} />`. cf-render owns the
 * actual rendering: it resolves the piece link to its root cell, renders the
 * exported variant key ([CHIP_UI] / [TILE_UI] / [UI]) when the piece exports
 * one, and otherwise fails over to the per-variant platform default (chip →
 * cf-cell-link; tile → the full [UI] scaled, clipped, click-to-navigate; full
 * is the universal floor). This helper is the blessed way to reach that failover
 * from inline code that previously indexed a variant key directly (e.g.
 * `piece[TILE_UI]`), which yields `undefined` and renders nothing when absent.
 */
export function uiVariant(
  piece: Opaque<unknown>,
  kind: UIVariantKind = "full",
): VNode {
  return h("cf-render", { variant: kind, $cell: piece });
}

export const navigateTo = createNodeFactory({
  type: "ref",
  implementation: "navigateTo",
}) as (cell: OpaqueRef<unknown>) => OpaqueRef<boolean>;

export function wish<T = unknown>(
  target: Opaque<WishParams>,
): OpaqueRef<WishState<T>>;
export function wish<T = unknown>(
  target: Opaque<WishParams>,
  schema: JSONSchema,
): OpaqueRef<WishState<T>>;
export function wish<T = unknown>(
  target: Opaque<WishParams>,
  schema?: JSONSchema,
): OpaqueRef<WishState<T>> {
  let param;
  let resultSchema;

  if (schema !== undefined && isRecord(target) && !isCell(target)) {
    param = {
      schema,
      ...target, // Pass in after, so schema here overrides any schema in target
    };
    resultSchema = !isCell(param.schema)
      ? param.schema as JSONSchema | undefined
      : schema;
  } else {
    param = target;
    resultSchema = schema;
  }
  return createNodeFactory({
    type: "ref",
    implementation: "wish",
    argumentSchema: WISH_ARGUMENT_SCHEMA,
    resultSchema,
  })(param);
}

// Example:
// str`Hello, ${name}!`
//
// TODO(seefeld): This should be a built-in module
export function str(
  strings: TemplateStringsArray,
  ...values: unknown[]
): OpaqueRef<string> {
  const interpolatedString = ({
    strings,
    values,
  }: {
    strings: TemplateStringsArray;
    values: unknown[];
  }) =>
    strings.reduce(
      (result, str, i) => result + str + (i < values.length ? values[i] : ""),
      "",
    );

  // PROVENANCE STAMP (reactive-interpreter str-resolution fix). `str` is pure
  // framework code (no cell context, no I/O, no pattern instantiation — it reads
  // `strings`/`values` from its lift INPUT and returns the concatenation), so
  // trusting its body to run as a raw host closure inside the interpreter is
  // sound. The interpreter's live-leaf trust gate
  // (`interpreterLiveLeafTrustCheck`, runner.ts) admits a leaf only when
  // `getVerifiedProvenance(impl) !== undefined`. This anonymous in-body closure
  // is neither exported nor `__cfReg`-registered, so module indexing never
  // stamps it — every `str` node fell back to `unresolved-leaf`, EVEN in a
  // launched child whose parent was `unsafeTrustPattern`'d (the trust walk
  // reaches the parent factory, never the child's str closures). Stamping the
  // closure at construction makes it provenance-trusted in EVERY context
  // (parent, launched child, reload) without a new trust-gate surface.
  //
  // We stamp the per-call closure (NOT a hoisted shared one) on purpose: a
  // shared frozen closure would be re-wrapped into a fresh, UN-stamped function
  // by `createNodeFactory`'s `prepareInspectableImplementation` on every call
  // after the first (it clones non-extensible inputs), defeating the stamp. The
  // freshly-minted closure here is extensible, so it passes through unchanged and
  // carries the stamp into the module. The stamp is SYMBOL-LESS: a symbol would
  // make `moduleToJSON` (json-utils.ts) emit an `$implRef` that no
  // executable-registry entry resolves, forcing the stringified-body SES fallback
  // to be dropped and breaking the serialized (getRaw) leaf path. Symbol-less
  // provenance passes the `!== undefined` trust gate while keeping
  // `provenance.symbol === undefined`, so serialization keeps the SES-fallback
  // body exactly as today.
  recordVerifiedProvenance(interpolatedString, { identity: "cf:builtin/str" });

  return lift(interpolatedString)({ strings, values });
}

/**
 * Create a cell with a given schema and name.
 *
 * @param schema - Optional, The schema of the cell.
 * @param name - Optional, a name for the cell. If provided, the cell id will be
 *   derived from the current context and that name, otherwise it'll be derived
 *   by the order of invocation, which is less stable.
 * @param value - Optional, the initial value of the cell.
 */
declare function createCell<T>(
  schema?: JSONSchema,
  name?: string,
  value?: T,
): CellType<T>;
declare function createCell<S extends JSONSchema = JSONSchema>(
  schema: S,
  name?: string,
  value?: Schema<S>,
): CellType<Schema<S>>;

export type { createCell };

/**
 * Helper function for creating LLM tool definitions from patterns with optional
 * pre-filled parameters. Returns an object suitable for use as an LLM tool, with
 * proper TypeScript typing that reflects only the non-pre-filled parameters.
 *
 * The first argument must be a `pattern(...)` (CT-1655). A module-scoped reactive
 * value the pattern's callback reads is captured by the pattern automatically (as
 * a module-scope closure); per-instance values are pre-filled via `extraParams`.
 *
 * @param pattern - An already-created PatternFactory (wrap callbacks in pattern())
 * @param extraParams - Optional object of parameter values to pre-fill
 * @returns An object with `pattern` and `extraParams` properties, typed to show only remaining params
 *
 * @example
 * ```ts
 * import { pattern, patternTool } from "commonfabric";
 *
 * const grepTool = patternTool(
 *   pattern(({ query, content }: { query: string; content: string }) => {
 *     return content.split("\n").filter((c) => c.includes(query));
 *   }),
 *   { content },
 * );
 *
 * // With a pattern declared elsewhere:
 * const grepTool2 = patternTool(myGrepPattern, { content });
 *
 * // Result type: PatternToolResult<{ content: string }>
 * // which has { pattern: Pattern, extraParams: { content: string } }
 * ```
 */
export const patternTool = (<
  T,
  E extends Partial<T> = Record<PropertyKey, never>,
>(
  // CT-1655: must already be a pattern. Authors wrap callbacks explicitly —
  // `patternTool(pattern(fn), extraParams?)` — so the unit is addressable and
  // hoistable; the runtime no longer coerces a bare function into a pattern.
  pattern: PatternFactory<T, any>,
  extraParams?: Opaque<E>,
): PatternToolResult<E> => {
  return {
    pattern,
    extraParams: (extraParams ?? {}) as E,
  };
}) as PatternToolFunction;
