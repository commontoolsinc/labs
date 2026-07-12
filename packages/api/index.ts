/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public pattern API.
 *
 * Workspace code should import these types via `@commonfabric/builder`.
 */

import type { Cfc, CurrentPrincipal, WriteAuthorizedBy } from "./cfc.ts";

// ============================================================================
// Fabric Value Types
// ============================================================================
//
// Pattern-visible declarations for the fabric value type system. Canonical
// implementations live in data-model submodule files (interface.ts,
// fabric-primitives/FabricHash.ts, fabric-primitives/FabricEpochNsec.ts, etc.)
// — these inline declarations mirror the public surface so the pattern compiler
// can resolve them without relative imports.
//
// SYNC NOTE: These declarations must stay in sync with the canonical
// definitions in the submodule files. If they drift, pattern type-checking
// will diverge from runtime behavior.
//
// Every concrete FabricPrimitive subclass must have an instanceof-capable
// declaration here (interface + constructor + declare-const with `new`).

/**
 * Common base class for `FabricInstance` and `FabricPrimitive`. Enables a
 * single `instanceof` check for any fabric-system value type.
 */
// deno-lint-ignore no-empty-interface
export interface FabricSpecialObject {}

export interface FabricSpecialObjectConstructor {
  prototype: FabricSpecialObject;
}

export declare const FabricSpecialObject:
  & FabricSpecialObjectConstructor
  & (abstract new (...args: any) => FabricSpecialObject);

/**
 * Abstract base class for values that participate in the fabric protocol.
 */
export interface FabricInstance extends FabricSpecialObject {
  shallowClone(frozen: boolean): FabricInstance;
}

export interface FabricInstanceConstructor {
  prototype: FabricInstance;
}

export declare const FabricInstance:
  & FabricInstanceConstructor
  & (abstract new (...args: any) => FabricInstance);

/** Abstract base class for fabric primitive types. */
export interface FabricPrimitive extends FabricSpecialObject {}

export interface FabricPrimitiveConstructor {
  prototype: FabricPrimitive;
}

export declare const FabricPrimitive:
  & FabricPrimitiveConstructor
  & (abstract new (...args: any) => FabricPrimitive);

/**
 * Temporal type representing nanoseconds from the POSIX Epoch.
 * Wraps a `bigint` value.
 */
export interface FabricEpochNsec extends FabricPrimitive {
  readonly value: bigint;
}

export interface FabricEpochNsecConstructor {
  new (value: bigint): FabricEpochNsec;
  prototype: FabricEpochNsec;
}

export declare const FabricEpochNsec: FabricEpochNsecConstructor;

/**
 * Temporal type representing days from the POSIX Epoch.
 * Wraps a `bigint` value.
 */
export interface FabricEpochDays extends FabricPrimitive {
  readonly value: bigint;
}

export interface FabricEpochDaysConstructor {
  new (value: bigint): FabricEpochDays;
  prototype: FabricEpochDays;
}

export declare const FabricEpochDays: FabricEpochDaysConstructor;

/**
 * A content-addressed identifier: a hash digest paired with an algorithm tag.
 * Extends `FabricPrimitive` -- treated like a primitive in the fabric type
 * system (always frozen, passes through conversion unchanged).
 */
export interface FabricHash extends FabricPrimitive {
  readonly tag: string;
  readonly bytes: Uint8Array;
  readonly length: number;
  readonly hashString: string;
  toString(): string;
}

export interface FabricHashConstructor {
  new (hash: Uint8Array, tag: string): FabricHash;
  prototype: FabricHash;
}

export declare const FabricHash: FabricHashConstructor;

/**
 * The modern, object-shaped form of a link reference, wrapping the link's
 * addressing payload (a `FabricPlainObject`: its addressing fields plus an optional
 * `schema`). Extends `FabricInstance` (not `FabricPrimitive`): the payload is an
 * outgoing reference (it may carry an arbitrary-`FabricValue` `schema`), so a
 * link is a small object graph, not a leaf.
 */
export interface FabricLink extends FabricInstance {
  readonly payload: FabricPlainObject;
}

export interface FabricLinkConstructor {
  new (payload: FabricPlainObject): FabricLink;
  prototype: FabricLink;
}

export declare const FabricLink: FabricLinkConstructor;

/**
 * An immutable, frozen sequence of bytes. Extends `FabricPrimitive` --
 * treated like a primitive in the fabric type system (always frozen, passes
 * through conversion unchanged). Read the bytes with `slice()` or
 * `copyInto()`.
 */
export interface FabricBytes extends FabricPrimitive {
  readonly length: number;
  slice(start?: number, end?: number): Uint8Array;
  copyInto(target: Uint8Array, offset?: number, length?: number): number;
}

export interface FabricBytesConstructor {
  new (bytes: Uint8Array): FabricBytes;
  prototype: FabricBytes;
}

export declare const FabricBytes: FabricBytesConstructor;

/**
 * Type-only brand for the narrow callable arm of `FabricValue`. Runtime
 * admission is owned by the data-model factory protocol.
 */
declare const FABRIC_FACTORY_TYPE: unique symbol;

/** A branded pattern, module, or handler factory callable. */
export interface FabricFactory<
  Args extends unknown[] = [never],
  Result = unknown,
> {
  (...args: Args): Result;
  readonly [FABRIC_FACTORY_TYPE]: true;
}

/**
 * The full set of values that the fabric storage layer can represent.
 */
export type FabricValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | FabricFactory
  | FabricSpecialObject
  | FabricArray
  | FabricPlainObject
  | undefined;

/** An array of fabric values. */
export interface FabricArray extends ArrayLike<FabricValue> {}

/** An object/record of fabric values. */
export interface FabricPlainObject extends Record<string, FabricValue> {}

// ============================================================================
// Runtime Constants
// ============================================================================

// Runtime constants - defined by @commonfabric/runner/src/builder/types.ts
// These are ambient declarations since the actual values are provided by the runtime environment
export declare const ID: unique symbol;
export declare const ID_FIELD: unique symbol;

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over patterns.
export declare const TYPE: "$TYPE";
export declare const NAME: "$NAME";
export declare const UI: "$UI";
// UI variants (CT-1321): optional sibling renderings addressed alongside [UI].
export declare const TILE_UI: "$TILE_UI";
export declare const CHIP_UI: "$CHIP_UI";
export declare const FS: "$FS";

/**
 * The size/representation spectrum a piece can be rendered at (CT-1321):
 * `full` = the standalone [UI]; `chip` = inline; `tile` = gallery/grid card.
 */
export type UIVariantKind = "full" | "chip" | "tile";

/**
 * Render a piece at a UI variant, for render paths that aren't already
 * `<cf-render>` JSX (CT-1321 Phase B / CT-1766). Returns a `cf-render` VNode
 * bound to the piece — equivalent to `<cf-render variant={kind} $cell={piece} />`.
 * cf-render resolves the exported variant key ([CHIP_UI] / [TILE_UI] / [UI]) when
 * present and otherwise fails over to the per-variant platform default, including
 * link resolution and click-to-navigate.
 */
export type UIVariantFunction = (
  piece: FactoryInput<unknown>,
  kind?: UIVariantKind,
) => VNode;

// Symbol for accessing self-reference in patterns
export declare const SELF: unique symbol;
export type SELF = typeof SELF;

// ============================================================================
// Cell Brand System
// ============================================================================

/**
 * Brand symbol for identifying different cell types at compile-time.
 * Each cell variant has a unique combination of capability flags.
 */
export declare const CELL_BRAND: unique symbol;

/**
 * Symbol for phantom property that enables type inference from AnyBrandedCell.
 * This property doesn't exist at runtime - it's purely for TypeScript's benefit:
 * without a concrete property mentioning T, `AnyBrandedCell<infer U>` cannot
 * infer U (T would be a phantom parameter and inference produces `unknown`).
 */
export declare const CELL_INNER_TYPE: unique symbol;

/**
 * Minimal cell type with just the brand, no methods.
 * Used for type-level operations like unwrapping nested cells without
 * creating circular dependencies.
 */
export type CellKind =
  | "cell"
  | "opaque"
  | "stream"
  | "comparable"
  | "readonly"
  | "writeonly"
  | "sqlite";

export type CellScope = "space" | "user" | "session";
export type SchemaScope = CellScope | "any";
export type LinkScope = "inherit" | CellScope;

export type AsCellEntry =
  | CellKind
  | {
    readonly kind: CellKind;
    readonly scope?: SchemaScope;
  };

export declare const SCOPE_BRAND: unique symbol;
export type Scoped<T, Scope extends SchemaScope> = T & {
  readonly [SCOPE_BRAND]?: Scope;
};
export type PerSpace<T> = Scoped<T, "space">;
export type PerUser<T> = Scoped<T, "user">;
export type PerSession<T> = Scoped<T, "session">;
export type PerAny<T> = Scoped<T, "any">;

type ScopedConstructorResult<
  Scope extends CellScope,
  T,
> = Scope extends "space" ? PerSpace<T>
  : Scope extends "user" ? PerUser<T>
  : Scope extends "session" ? PerSession<T>
  : never;

// `string` acts as `any`, e.g. when wanting to match any kind of cell
// The [CELL_INNER_TYPE] property is a phantom property that enables TypeScript
// to infer T when using `AnyBrandedCell<infer U>`. Without it, T is a phantom
// type parameter and TypeScript produces `unknown` when trying to infer it.
// The property must be non-optional so that plain types like `string[]` don't
// accidentally match AnyBrandedCell.
export type AnyBrandedCell<T, Kind extends string = string> = {
  [CELL_BRAND]: Kind;
  readonly [CELL_INNER_TYPE]: T;
};

export type BrandedCell<T, Kind extends CellKind> = AnyBrandedCell<T, Kind>;

// ============================================================================
// Cell Capability Interfaces
// ============================================================================

// To constrain methods that only exists on objects
export type IsThisObject =
  | IsThisArray
  | AnyBrandedCell<JSONObject>
  | AnyBrandedCell<Record<string, unknown>>;

export type IsThisArray =
  | AnyBrandedCell<JSONArray>
  | AnyBrandedCell<Array<unknown>>
  | AnyBrandedCell<Array<any>>
  | AnyBrandedCell<unknown>
  | AnyBrandedCell<any>;

// To constrain methods that only exist on number cells
export type IsThisNumber =
  | AnyBrandedCell<number>
  | AnyBrandedCell<unknown>
  | AnyBrandedCell<any>;

/*
 * IAnyCell is an interface that is used by all calls and to which the runner
 * attaches the internal methods..
 */
// deno-lint-ignore no-empty-interface
export interface IAnyCell<T> {}

/**
 * Readable cells provide a view onto stored data.
 *
 * **Frozenness contract:** `get()` and `sample()`
 * return a JS Proxy over the stored value. Writes through the proxy are
 * rejected with a "read-only" runtime error. The underlying stored
 * data is additionally a deep-frozen `FabricValue` tree, so callers that
 * escape the proxy (e.g. via `getRaw()`) see frozen data without an
 * extra clone.
 *
 * Note: `Object.isFrozen(proxy)` reports `false` regardless of the
 * underlying state — that's a property of how JS Proxy reports
 * extensibility, not a statement about mutability.
 */
export interface IReadable<T> {
  /**
   * Read the cell's current value as a Proxy view. See the
   * {@link IReadable} interface docs for the frozenness contract.
   */
  get(options?: { traverseCells?: boolean }): Readonly<StripDefaultBrand<T>>;
  /**
   * Read the cell's current value without creating a reactive dependency.
   * Unlike `get()`, calling `sample()` inside a lift won't cause the lift
   * to re-run when this cell's value changes. The same frozenness
   * contract from {@link IReadable} applies.
   */
  sample(): Readonly<StripDefaultBrand<T>>;
}

export type MetaLinkField =
  | "pattern"
  | "argument"
  | "params"
  | "result";

/**
 * The `pattern` field links a result cell to its pattern
 * The `argument` field links a result cell to its argument cell
 * The `params` field links a result cell to compiler-owned closure params
 * The `internal` field contains a manifest with links to derived internal cells.
 * The `schema` field stores the schema for a result cell
 * The `result` field lets a result cell link to its parent result cell,
 * and also lets the argument and derived internal cells link back to the result cell.
 *
 * `cfc` is deliberately NOT a MetaField: the `["cfc"]` document field holds
 * raw label metadata (Caveat.source and other principal identities), which
 * must not ride the raw meta seam (inv-12 Stage 0 / SC-14 / SC-25). The cfc
 * code reads the field directly through its own verifier seams; display
 * consumers get the redacted view via getCfcLabel.
 */
export type MetaField =
  | MetaLinkField
  | "patternIdentity" // content-addressed {identity, symbol} pattern reference
  | "patternSource" // provenance: the source a piece tracks for updates (a
  // toolshed pattern path, or later a `cf:` fabric ref)
  | "patternRepository" // optional caller-supplied repository locator
  | "displacedPattern" // {identity, symbol, displacedAt}: the prior pattern
  // reference recorded when system-pattern auto-update replaces an unloadable
  // sourceless root — the recovery pointer for a displaced custom program
  | "internal"
  | "schema"
  | "slug";

export interface IMetaCell {
  getMetaRaw(metaField: MetaField, options?: unknown): FabricValue;
  setMetaRaw(metaField: MetaField, value: FabricValue): void;
}

/**
 * Writable cells can update their value.
 *
 * **Frozenness contract:** Values passed into `set()`, `update()`, and `push()`
 * flow through a write-boundary normalization step that shallowly freezes any
 * plain unfrozen Object/Array levels it visits. Inputs that are already
 * deep-frozen valid `FabricValue` trees are accepted identity-preservingly with
 * no further cloning.
 */
export interface IWritable<T, C extends AnyBrandedCell<any>> {
  /**
   * Set the cell's value. See the {@link IWritable} interface docs for
   * the frozenness contract on the input.
   */
  set(value: T | AnyCellWrapping<T>): C;
  /**
   * Merge a partial object value into the cell. Implemented as a
   * per-key `set()`, so the same frozenness contract applies. See
   * {@link IWritable}.
   */
  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    this: IsThisObject,
    values: V extends object ? AnyCellWrapping<V> : never,
  ): C;
  /**
   * Append one or more values to an array cell. See the
   * {@link IWritable} interface docs for the frozenness contract on the
   * inputs.
   */
  push(
    this: IsThisArray,
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void;
  /**
   * Add one or more values to an array cell as a set: each value is appended
   * only if no existing element equals it. Mergeable — concurrent adds of
   * distinct elements merge and a repeated add is a no-op against durable state.
   */
  addUnique(
    this: IsThisArray,
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void;
  /**
   * Add `by` (default 1, may be negative) to a number cell. Mergeable —
   * concurrent increments sum against durable state rather than clobber.
   */
  increment(this: IsThisNumber, by?: number): void;
  remove(
    this: IsThisArray,
    ref: T extends (infer U)[] ? (U | AnyBrandedCell<U>) : never,
  ): void;
  /**
   * Remove every element equal to `ref` by stored value (a cell matches by its
   * link). Mergeable — resolved against durable state, so concurrent removes of
   * distinct entries merge instead of clobbering via a whole-array rewrite.
   */
  removeByValue(
    this: IsThisArray,
    ref: T extends (infer U)[] ? (U | AnyBrandedCell<U>) : never,
  ): void;
  removeAll(
    this: IsThisArray,
    ref: T extends (infer U)[] ? (U | AnyBrandedCell<U>) : never,
  ): void;
}

/**
 * How the pattern transformer classifies a mergeable write: an
 * `array-identity-writer` takes element arguments whose identity is tracked
 * (`push` / `addUnique` / `removeByValue`); a `scalar-writer` does not
 * (`increment`).
 */
export type MergeableOpMethodKind = "scalar-writer" | "array-identity-writer";

/**
 * One mergeable Cell mutation method: the {@link IWritable} method name, the
 * patch-op tag its write records, and its transformer classification.
 */
export interface MergeableOpMethod {
  readonly method: string;
  readonly wireOp: string;
  readonly kind: MergeableOpMethodKind;
}

/**
 * The canonical list of mergeable Cell mutation methods — the {@link IWritable}
 * methods whose write is carried to the store as a merge-aware patch operation
 * (resolved against durable state) rather than a whole-value diff, so concurrent
 * edits of one collection combine instead of clobbering.
 *
 * This is the single registration point for that set. The runtime op registry
 * (`runner storage/mergeable-ops.ts`, keyed by `wireOp`) and the pattern
 * transformer's method classification both derive from it, so adding a mergeable
 * op is one entry here plus its behavior descriptor — the transformer picks up
 * the new method with no edit, and a consistency test cross-checks the wire tags.
 */
export const MERGEABLE_OP_METHODS: readonly MergeableOpMethod[] = [
  { method: "push", wireOp: "append", kind: "array-identity-writer" },
  { method: "addUnique", wireOp: "add-unique", kind: "array-identity-writer" },
  {
    method: "removeByValue",
    wireOp: "remove-by-value",
    kind: "array-identity-writer",
  },
  { method: "increment", wireOp: "increment", kind: "scalar-writer" },
];

/**
 * Streamable cells can send events.
 */
export interface IStreamable<T> {
  send(
    ...args: T extends void ? [] | [AnyCellWrapping<T>] : [AnyCellWrapping<T>]
  ): void;
}

// Lightweight HKT, so we can pass cell types to IKeyable<>.
export interface HKT {
  _A: unknown;
  type: unknown;
}
export type Apply<F extends HKT, A> = (F & { _A: A })["type"];

/**
 * A key-addressable, **covariant** view over a structured value `T`.
 *
 * `IKeyableCell` exposes a single method, {@link IKeyableCell.key}, which selects a
 * property from the (possibly branded) value `T` and returns it wrapped in a
 * user-provided type constructor `Wrap` (default: `Cell<…>`). The interface is
 * declared `out T` (covariant) and is designed so that calling `key` preserves
 * both type inference and variance soundness.
 *
 * @template T
 * The underlying (possibly branded) value type. `T` is treated **covariantly**:
 * `IKeyableCell<Sub>` is assignable to `IKeyableCell<Super>` when `Sub` is
 * assignable to `Super`.
 *
 * @template Wrap extends HKT
 * A lightweight higher-kinded “wrapper” that determines the return container for
 * selected fields. For example, `AsCell` wraps as `Cell<A>`, while other wrappers
 * can project to `ReadonlyCell<A>`, `Stream<A>`, etc. Defaults to `AsCell`.
 *
 * @template Any
 * The “fallback” return type used when the provided key does not match a known
 * key (or is widened to `any`). This should usually be `Apply<Wrap, any>`.
 *
 * @remarks
 * ### Variance & soundness
 * The `key` signature is crafted to remain **covariant in `T`**. Internally,
 * it guards the instantiation `K = any` with `unknown extends K ? … : …`, so
 * the return type becomes `Any` (independent of `T`) in that case. For real keys
 * (`K extends keyof UnwrapCell<T>`), the return type is precise and fully inferred.
 *
 * ### Branded / nested cells
 * If a selected property is itself a branded cell (e.g., `BrandedCell<U>`),
 * the return value is a wrapped branded cell, i.e. `Wrap<BrandedCell<U>>`.
 *
 * ### Key inference
 * Passing a string/number/symbol that is a literal and a member of
 * `keyof UnwrapCell<T>` yields precise field types; non-literal or unknown keys
 * fall back to `Any` (e.g., `Cell<any>`).
 *
 * @example
 * // Basic usage with the default wrapper (Cell)
 * declare const userCell: IKeyableCell<{ id: string; profile: { name: string } }>;
 * const idCell = userCell.key("id");         // Cell<string>
 * const profileCell = userCell.key("profile"); // Cell<{ name: string }>
 *
 * // Unknown key falls back to Any (default: Cell<any>)
 * const whatever = userCell.key(Symbol());   // Cell<any>
 *
 * @example
 * // Using a custom wrapper, e.g., ReadonlyCell<A>
 * interface AsReadonlyCell extends HKT { type: ReadonlyCell<this["_A"]> }
 * type ReadonlyUserCell = IKeyableCell<{ id: string }, AsReadonlyCell, Apply<AsReadonlyCell, any>>;
 * declare const ro: ReadonlyUserCell;
 * const idRO = ro.key("id"); // ReadonlyCell<string>
 *
 * @example
 * // Covariance works:
 * declare const sub: IKeyableCell<{ a: string }>;
 * const superCell: IKeyableCell<unknown> = sub; // OK (out T)
 */
export interface IKeyable<out T, Wrap extends HKT> {
  /**
   * Navigate to nested properties by one or more keys.
   *
   * @example
   * cell.key("user")                      // Cell<User>
   * cell.key("user", "profile")           // Cell<Profile>
   * cell.key("user", "profile", "name")   // Cell<string>
   */
  // Overloads to avoid recursive type evaluation which causes stack overflow
  // Zero keys
  key(this: IsThisObject): Apply<Wrap, T>;
  // One key
  key<K1 extends keyof T>(this: IsThisObject, k1: K1): Apply<Wrap, T[K1]>;
  // Two keys
  key<K1 extends keyof T, K2 extends keyof T[K1]>(
    this: IsThisObject,
    k1: K1,
    k2: K2,
  ): Apply<Wrap, T[K1][K2]>;
  // Three keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
  >(this: IsThisObject, k1: K1, k2: K2, k3: K3): Apply<Wrap, T[K1][K2][K3]>;
  // Four keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
  ): Apply<Wrap, T[K1][K2][K3][K4]>;
  // Five keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5]>;
  // Six keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
    K6 extends keyof T[K1][K2][K3][K4][K5],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5][K6]>;
  // Seven keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
    K6 extends keyof T[K1][K2][K3][K4][K5],
    K7 extends keyof T[K1][K2][K3][K4][K5][K6],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5][K6][K7]>;
  // Eight keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
    K6 extends keyof T[K1][K2][K3][K4][K5],
    K7 extends keyof T[K1][K2][K3][K4][K5][K6],
    K8 extends keyof T[K1][K2][K3][K4][K5][K6][K7],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5][K6][K7][K8]>;
  // Nine keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
    K6 extends keyof T[K1][K2][K3][K4][K5],
    K7 extends keyof T[K1][K2][K3][K4][K5][K6],
    K8 extends keyof T[K1][K2][K3][K4][K5][K6][K7],
    K9 extends keyof T[K1][K2][K3][K4][K5][K6][K7][K8],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
    k9: K9,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5][K6][K7][K8][K9]>;
  // Ten keys
  key<
    K1 extends keyof T,
    K2 extends keyof T[K1],
    K3 extends keyof T[K1][K2],
    K4 extends keyof T[K1][K2][K3],
    K5 extends keyof T[K1][K2][K3][K4],
    K6 extends keyof T[K1][K2][K3][K4][K5],
    K7 extends keyof T[K1][K2][K3][K4][K5][K6],
    K8 extends keyof T[K1][K2][K3][K4][K5][K6][K7],
    K9 extends keyof T[K1][K2][K3][K4][K5][K6][K7][K8],
    K10 extends keyof T[K1][K2][K3][K4][K5][K6][K7][K8][K9],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
    k9: K9,
    k10: K10,
  ): Apply<Wrap, T[K1][K2][K3][K4][K5][K6][K7][K8][K9][K10]>;
  // Fallback for 11+ keys or unknown keys
  key(...keys: PropertyKey[]): Apply<Wrap, any>;
  /**
   * A cell for the entity deterministically derived from this array and `idKey`
   * — the entity a keyed element is identified by. The same `idKey` always
   * resolves to the same entity (a content-only derivation), so a handler can
   * read/edit one keyed element and manage its membership with addUnique /
   * removeByValue, without reading the whole array.
   */
  elementById(
    this: IsThisArray,
    idKey: string,
  ): Apply<Wrap, T extends (infer U)[] ? U : unknown>;
}

/**
 * Helper to wrap a type, but preserve Cell/Stream types as-is to avoid double-wrapping.
 * Uses non-distributive conditionals to handle union types correctly.
 */
export type WrapOrPreserve<T, Wrap extends HKT> = [T] extends [Cell<any>] ? T
  : [T] extends [Stream<any>] ? T
  : [T] extends [ComparableCell<any>] ? T
  : [T] extends [ReadonlyCell<any>] ? T
  : [T] extends [WriteonlyCell<any>] ? T
  : [T] extends [OpaqueCell<any>] ? T
  : Apply<Wrap, T>;

/**
 * Result type for key() - chains multiple key lookups.
 * Supports single key: cell.key("a") or multiple: cell.key("a", "b", "c")
 * When the final value is already a Cell/Stream type, returns it as-is.
 */
export type KeyResultType<
  T,
  Keys extends readonly PropertyKey[],
  Wrap extends HKT,
> = Keys extends readonly [] ? WrapOrPreserve<T, Wrap>
  : Keys extends readonly [
    infer First extends PropertyKey,
    ...infer Rest extends readonly PropertyKey[],
  ] ? [unknown] extends [First] ? Apply<Wrap, any> // variance guard
    : [0] extends [1 & T] ? Apply<Wrap, any> // keep any as-is
    : First extends keyof T ? KeyResultType<T[First], Rest, Wrap>
    : Apply<Wrap, any> // unknown key fallback
  : Apply<Wrap, any>;

/**
 * Result type for key() on OpaqueCell - chains multiple key lookups.
 */
export type KeyResultTypeOpaque<
  T,
  Keys extends readonly PropertyKey[],
> = Keys extends readonly [] ? OpaqueCell<T>
  : Keys extends readonly [
    infer First extends PropertyKey,
    ...infer Rest extends readonly PropertyKey[],
  ] ? [unknown] extends [First] ? OpaqueCell<any>
    : [0] extends [1 & T] ? OpaqueCell<any>
    : First extends keyof UnwrapCell<T>
      ? KeyResultTypeOpaque<UnwrapCell<T>[First], Rest>
    : OpaqueCell<any>
  : OpaqueCell<any>;

/**
 * Cells that support key() for property access - OpaqueCell variant.
 * OpaqueCell is "sticky" and always returns OpaqueCell<>.
 */
export interface IKeyableOpaque<T> {
  /**
   * Navigate to nested properties by one or more keys.
   */
  // Overloads to avoid recursive type evaluation which causes stack overflow
  key(this: IsThisObject): OpaqueCell<T>;
  key<K1 extends keyof UnwrapCell<T>>(
    this: IsThisObject,
    k1: K1,
  ): OpaqueCell<UnwrapCell<T>[K1]>;
  key<K1 extends keyof UnwrapCell<T>, K2 extends keyof UnwrapCell<T>[K1]>(
    this: IsThisObject,
    k1: K1,
    k2: K2,
  ): OpaqueCell<UnwrapCell<T>[K1][K2]>;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
  >(this: IsThisObject, k1: K1, k2: K2, k3: K3): OpaqueCell<
    UnwrapCell<T>[K1][K2][K3]
  >;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
  >(this: IsThisObject, k1: K1, k2: K2, k3: K3, k4: K4): OpaqueCell<
    UnwrapCell<T>[K1][K2][K3][K4]
  >;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
  >(this: IsThisObject, k1: K1, k2: K2, k3: K3, k4: K4, k5: K5): OpaqueCell<
    UnwrapCell<T>[K1][K2][K3][K4][K5]
  >;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
    K6 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
  ): OpaqueCell<UnwrapCell<T>[K1][K2][K3][K4][K5][K6]>;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
    K6 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5],
    K7 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
  ): OpaqueCell<UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7]>;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
    K6 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5],
    K7 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6],
    K8 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
  ): OpaqueCell<UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8]>;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
    K6 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5],
    K7 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6],
    K8 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7],
    K9 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
    k9: K9,
  ): OpaqueCell<UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8][K9]>;
  key<
    K1 extends keyof UnwrapCell<T>,
    K2 extends keyof UnwrapCell<T>[K1],
    K3 extends keyof UnwrapCell<T>[K1][K2],
    K4 extends keyof UnwrapCell<T>[K1][K2][K3],
    K5 extends keyof UnwrapCell<T>[K1][K2][K3][K4],
    K6 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5],
    K7 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6],
    K8 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7],
    K9 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8],
    K10 extends keyof UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8][K9],
  >(
    this: IsThisObject,
    k1: K1,
    k2: K2,
    k3: K3,
    k4: K4,
    k5: K5,
    k6: K6,
    k7: K7,
    k8: K8,
    k9: K9,
    k10: K10,
  ): OpaqueCell<UnwrapCell<T>[K1][K2][K3][K4][K5][K6][K7][K8][K9][K10]>;
  key(...keys: PropertyKey[]): OpaqueCell<any>;
}

/**
 * Cells that can be created with a cause.
 */
export interface ICreatable<C extends AnyBrandedCell<any>> {
  /**
   * Set a cause for this cell. Used to create a link when the cell doesn't have
   * one yet.
   *
   * Record causes may not use the top-level key `$generated` — it is
   * reserved for system-generated causes and setting one throws.
   * @param cause - The cause to associate with this cell
   * @returns This cell for method chaining
   */
  for(cause: unknown): C;
}

/**
 * Cells that can be resolved back to a Cell.
 * Only available on full Cell<T>, not on OpaqueCell or Stream.
 * Note: Schema-typed overload available via "commonfabric/schema"
 */
export interface IResolvable<T, C extends AnyBrandedCell<T>> {
  resolveAsCell(): C;
  getArgumentCell<U>(schema?: JSONSchema): Cell<U> | undefined;
}

/**
 * Comparable cells have equals() method.
 * Available on comparable and readable cells.
 */
export interface IEquatable {
  equals(other: AnyCell<any> | object | undefined): boolean;
  equalLinks(other: AnyCell<any> | object | undefined): boolean;
}

/**
 * Cells that allow deriving new cells from existing cells via array methods:
 * direct helpers mirror supported Array methods and return Reactive results.
 * The WithPattern variants accept pre-defined patterns for per-element
 * operations.
 */
export interface IDerivable<T> {
  map<S>(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<S>,
  ): Reactive<S[]>;
  mapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): Reactive<S[]>;
  reduce<S>(
    this: IsThisObject,
    fn: (
      accumulator: S,
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => S,
    initialValue: S,
  ): Reactive<S>;
  findIndex(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? U : T,
      index: number,
      array: (T extends Array<infer U> ? U : T)[],
    ) => boolean,
  ): Reactive<number>;
  filter(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<boolean>,
  ): Reactive<(T extends Array<infer U> ? U : T)[]>;
  filterWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): Reactive<(T extends Array<infer U> ? U : T)[]>;
  flatMap<S>(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? Reactive<U> : Reactive<T>,
      index: Reactive<number>,
      array: Reactive<T>,
    ) => FactoryInput<S[]>,
  ): Reactive<S[]>;
  flatMapWithPattern<S>(
    this: IsThisObject,
    op: PatternFactory<T extends Array<infer U> ? U : T, S[]>,
    params: Record<string, any>,
  ): Reactive<S[]>;
}

export interface IOpaquable<T> {
  /** deprecated */
  setSchema(schema: JSONSchema): void;
}

// ============================================================================
// Cell Constructor Interfaces
// ============================================================================

/**
 * Generic constructor interface for cell types with static methods.
 */
export interface CellTypeConstructor<
  Wrap extends HKT,
> {
  /**
   * Create a cell with an initial/default value. In a reactive context, this
   * value will only be set on first call.
   *
   * AST transformation adds `.for("foo")` in `const foo = new Cell(value)`.
   *
   * Internally it just merges the value into the schema as a default value.
   *
   * @param value - The initial/default value to set on the cell
   * @param schema - Optional JSON schema for the cell
   * @returns A new cell
   */
  new <T>(value?: T, schema?: JSONSchema): Apply<Wrap, T>;

  /**
   * Create a cell with a cause.
   *
   * Can be chained with `new ...(...)` or .set():
   *
   * const foo = Cell.for(cause).set(value); // sets cell to latest value
   *
   * @param cause - The cause to associate with this cell
   * @returns A new cell
   */
  for<T>(cause: unknown): Apply<Wrap, T>;

  /**
   * Create a cell with an initial/default value. In a reactive context, this
   * value will only be set on first call.
   *
   * Can be chained with .for() to set a cause and initial value.
   * E.g. `const foo = Cell.for(cause).of(value)`.
   *
   * AST transformation adds `.for("foo")` in `const foo = Cell.of(value)`.
   *
   * Internally it just merges the value into the schema as a default value.
   *
   * @param value - The initial/default value to set on the cell
   * @param schema - Optional JSON schema for the cell
   * @returns A new cell
   */
  of<T>(value?: T, schema?: JSONSchema): Apply<Wrap, T>;

  /**
   * Scoped constructor view for space-shared cells.
   */
  perSpace: ScopedCellTypeConstructor<Wrap, "space">;

  /**
   * Scoped constructor view for per-user cells.
   */
  perUser: ScopedCellTypeConstructor<Wrap, "user">;

  /**
   * Scoped constructor view for per-session cells.
   */
  perSession: ScopedCellTypeConstructor<Wrap, "session">;

  /**
   * Compare two cells or values for equality after resolving, i.e. after
   * following all links in case we have cells pointing to other cells.
   * @param a - First cell or value to compare
   * @param b - Second cell or value to compare
   * @returns true if the values are equal
   */
  equals(
    a: AnyCell<any> | object | undefined,
    b: AnyCell<any> | object | undefined,
  ): boolean;

  /**
   * Compare two cells or values for equality by comparing their underlying
   * links. No resolving.
   *
   * @param a - First cell or value to compare
   * @param b - Second cell or value to compare
   * @returns true if the values are equal
   */
  equalLinks(
    a: AnyCell<any> | object | undefined,
    b: AnyCell<any> | object | undefined,
  ): boolean;
}

export interface ScopedCellTypeConstructor<
  Wrap extends HKT,
  Scope extends CellScope,
> {
  /**
   * Create a scoped cell with an initial/default value.
   */
  new <T>(
    value?: T,
    schema?: JSONSchema,
  ): ScopedConstructorResult<Scope, Apply<Wrap, T>>;

  /**
   * Create a scoped cell with an initial/default value.
   */
  of<T>(
    value?: T,
    schema?: JSONSchema,
  ): ScopedConstructorResult<Scope, Apply<Wrap, T>>;

  /**
   * Create a scoped cell with a cause.
   */
  for<T>(cause: unknown): ScopedConstructorResult<Scope, Apply<Wrap, T>>;
}

// ============================================================================
// Cell Type Definitions
// ============================================================================

/**
 * Base type for all cell variants that has methods. Internal API augments this
 * interface with internal only API. Uses a second symbol brand to distinguish
 * from core cell brand without any methods.
 */
export interface AnyCell<T = unknown> extends AnyBrandedCell<T>, IAnyCell<T> {
}

/**
 * Opaque cell reference - only supports keying and derivation, not direct I/O.
 * Has .key(), .map(), .mapWithPattern()
 * Does NOT have .get()/.set()/.send()/.equals()/.resolveAsCell()
 */
export interface AsOpaqueCell extends HKT {
  type: OpaqueCell<this["_A"]>;
}

export interface IOpaqueCell<T>
  extends
    IAnyCell<T>,
    ICreatable<AnyBrandedCell<T>>,
    IKeyableOpaque<T>,
    IDerivable<T>,
    IOpaquable<T> {}

export interface OpaqueCell<T>
  extends BrandedCell<T, "opaque">, IOpaqueCell<T> {}

export declare const OpaqueCell: CellTypeConstructor<AsOpaqueCell>;

/**
 * Full cell with read, write capabilities.
 * Has .get(), .set(), .update(), .push(), .equals(), .key(), .resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface AsCell extends HKT {
  type: Cell<this["_A"]>;
}

export interface ICell<T>
  extends
    IAnyCell<T>,
    ICreatable<Cell<T>>,
    IReadable<T>,
    IWritable<T, Cell<T>>,
    IStreamable<T>,
    IEquatable,
    IKeyable<T, AsCell>,
    IDerivable<T>,
    IMetaCell,
    IResolvable<T, Cell<T>> {}

export interface Cell<T = unknown> extends BrandedCell<T, "cell">, ICell<T> {}

export declare const Cell: CellTypeConstructor<AsCell>;

/**
 * Writable<T> is an alias for Cell<T> that better expresses the semantic meaning.
 * In patterns, requesting data as Writable<T> means "I need write access" -
 * all data in patterns is reactive by default, whether wrapped or not.
 */
export type Writable<T = unknown> = Cell<T>;
export declare const Writable: CellTypeConstructor<AsCell>;

/**
 * Stream-only cell - can only send events, not read or write.
 * Has .send() only
 * Does NOT have .key()/.equals()/.get()/.set()/.resolveAsCell()
 *
 * Note: This is an interface (not a type) to allow module augmentation by the runtime.
 */
export interface AsStream extends HKT {
  type: Stream<this["_A"]>;
}

export interface Stream<T>
  extends
    BrandedCell<T, "stream">,
    IAnyCell<T>,
    ICreatable<Stream<T>>,
    IStreamable<T> {}

export declare const Stream: CellTypeConstructor<AsStream>;

/**
 * Comparable-only cell - just for equality checks and keying.
 * Has .equals(), .key()
 * Does NOT have .resolveAsCell()/.get()/.set()/.send()
 */
export interface AsComparableCell extends HKT {
  type: ComparableCell<this["_A"]>;
}

export interface ComparableCell<T>
  extends
    BrandedCell<T, "comparable">,
    IAnyCell<T>,
    ICreatable<ComparableCell<T>>,
    IEquatable,
    IKeyable<T, AsComparableCell> {}

export declare const ComparableCell: CellTypeConstructor<AsComparableCell>;

/**
 * Read-only cell variant.
 * Has .get(), .equals(), .key()
 * Does NOT have .resolveAsCell()/.set()/.send()
 */
export interface AsReadonlyCell extends HKT {
  type: ReadonlyCell<this["_A"]>;
}

export interface ReadonlyCell<T>
  extends
    BrandedCell<T, "readonly">,
    IAnyCell<T>,
    ICreatable<ReadonlyCell<T>>,
    IReadable<T>,
    IEquatable,
    IKeyable<T, AsReadonlyCell> {}

export declare const ReadonlyCell: CellTypeConstructor<AsReadonlyCell>;

/**
 * Write-only cell variant.
 * Has .set(), .update(), .push(), .key()
 * Does NOT have .resolveAsCell()/.get()/.equals()/.send()
 */
export interface AsWriteonlyCell extends HKT {
  type: WriteonlyCell<this["_A"]>;
}

export interface WriteonlyCell<T>
  extends
    BrandedCell<T, "writeonly">,
    IAnyCell<T>,
    ICreatable<WriteonlyCell<T>>,
    IWritable<T, WriteonlyCell<T>>,
    IKeyable<T, AsWriteonlyCell> {}

export declare const WriteonlyCell: CellTypeConstructor<AsWriteonlyCell>;

// ============================================================================
// Reactive - annotation for reactively-tracked values
// ============================================================================

/**
 * Reactive<T> marks a value as reactively tracked by the pattern runtime.
 * It is purely an annotation: at the type level it IS `T` (an identity
 * alias), and the transformers detect the spelling to classify reactive
 * positions before erasure. There is no runtime wrapper behind it.
 */
export type Reactive<T> = T;

// ============================================================================
// CellLike and FactoryInput - Utility types for accepting cells
// ============================================================================

/**
 * CellLike is a cell (AnyCell) whose nested values are valid factory inputs.
 * The top level must be AnyCell, but nested values can be plain or wrapped.
 *
 * Note: This is primarily used for type constraints that require a cell.
 */
type CellWrappedValue<T> = AnyBrandedCell<CellWrappedData<T>> & {
  [CELL_LIKE]?: unknown;
};
export type CellLike<T> = CellWrappedValue<T> | T;
type CellWrappedData<T> =
  | T
  | AnyBrandedCell<T>
  | (T extends Array<infer U> ? Array<FactoryInput<U>>
    : T extends object ? { [K in keyof T]: FactoryInput<T[K]> }
    : never);
export declare const CELL_LIKE: unique symbol;

/**
 * Helper type to transform Cell<T> to FactoryInput<T> in pattern/lift/handler inputs.
 * Preserves Stream<T> since Streams are callable interfaces (.send()), not data containers.
 *
 * INPUT-POSITION ONLY: stripping is an acceptance tool — used inside
 * `FactoryInput<StripCell<T>>` so callers can pass the data shape with or without
 * cell wrappers. It must NOT be applied to factory result types: result-type
 * brands are exported capabilities, and transformer-inferred result schemas
 * derive `asCell`/`asStream` from them (see the boundary principle on
 * PatternFunction).
 *
 * Implementation is non-distributive by default to preserve union types like RenderNode
 * that intentionally contain AnyBrandedCell as a data variant. However, for optional cell
 * properties like `title?: Writable<string>` (which expand to `Writable<string> | undefined`),
 * we extract the cell parts, strip them, and recombine with the non-cell parts.
 */
export type StripCell<T> =
  // Handle optional cell properties: "SomeCell | undefined" pattern
  // Strip the cell part, preserve undefined only if it was present
  [T] extends [AnyBrandedCell<any> | undefined]
    ? StripCellInner<Exclude<T, undefined>> | Extract<T, undefined>
    // Non-distributive for everything else (preserves unions like RenderNode)
    : StripCellInner<T>;

type StripCellInner<T> = [T] extends [Stream<any>] ? T // Preserve Stream<T> - it's a callable interface
  : [T] extends [AnyBrandedCell<infer U>] ? StripCell<U>
  : [T] extends [ArrayBuffer | ArrayBufferView | URL | Date] ? T
  : [T] extends [Array<infer U>] ? StripCell<U>[]
  // deno-lint-ignore ban-types
  : [T] extends [Function] ? T // Preserve function types
  : [T] extends [object] ? { [K in keyof T]: StripCell<T[K]> }
  : T;

/**
 * Input accepted when invoking a Common Fabric factory or helper.
 *
 * FactoryInput accepts T or any cell wrapping T, recursively at any nesting
 * level. It also accepts cells whose stored data contains reactive values.
 * Used in APIs that accept inputs from developers: values can be static,
 * reactive, wrapped in cells, or cells containing reactive values.
 *
 * Special cases for JSX:
 * - FactoryInput<VNode> also accepts JSXElement
 * - FactoryInput<UIRenderable> also accepts JSXElement (for .map() callbacks returning JSX)
 */
export type FactoryInput<T> =
  | T
  // We have to list them explicitly so Typescript can unwrap them. Doesn't seem
  // to work if we just say AnyBrandedCell<T>
  | AnyCell<T>
  | AnyBrandedCell<T>
  | OpaqueCell<T>
  | Cell<T>
  | Stream<T>
  | ComparableCell<T>
  | ReadonlyCell<T>
  | WriteonlyCell<T>
  | CellWrappedValue<T>
  // Special case: When T is VNode or UIRenderable (even with null/undefined),
  // also accept JSXElement. Use NonNullable to handle VNode | undefined.
  // Combined into single check to reduce type instantiation overhead.
  | ([NonNullable<T>] extends [VNode | UIRenderable] ? JSXElement : never)
  | (T extends Array<infer U> ? Array<FactoryInput<U>>
    : T extends object ? { [K in keyof T]: FactoryInput<T[K]> }
    : T);

/**
 * Matches any non-opaque Cell type (Cell, Stream, ComparableCell, etc.) that may be
 * wrapped in any number of Reactive layers. Excludes OpaqueCell and AnyCell (since OpaqueCell extends AnyCell).
 */
/**
 * Recursively unwraps AnyBrandedCell types at any nesting level.
 * UnwrapCell<AnyBrandedCell<AnyBrandedCell<string>>> = string
 * UnwrapCell<AnyBrandedCell<{ a: AnyBrandedCell<number> }>> = { a: AnyBrandedCell<number> }
 *
 * Special cases:
 * - UnwrapCell<any> = any
 * - UnwrapCell<unknown> = unknown (preserves unknown)
 */
export type UnwrapCell<T> =
  // Preserve any
  0 extends (1 & T) ? T
    // Unwrap AnyBrandedCell
    : T extends AnyBrandedCell<infer S> ? UnwrapCell<S>
    // Otherwise return as-is
    : T;

/**
 * AnyCellWrapping is used for write operations (.set(), .push(), .update()). It
 * is a type utility that allows any part of type T to be wrapped in AnyCell<>,
 * and allow any part of T that is currently wrapped in AnyCell<> to be used
 * unwrapped. This is designed for use with cell method parameters, allowing
 * flexibility in how values are passed. The ID and ID_FIELD metadata symbols
 * allows controlling id generation and can only be passed to write operations.
 */
export type AnyCellWrapping<T> =
  // Handle existing AnyBrandedCell<> types, allowing unwrapping
  T extends AnyBrandedCell<infer U>
    ? AnyCellWrapping<U> | AnyBrandedCell<AnyCellWrapping<U>>
    // Handle arrays
    : T extends Array<infer U>
      ? Array<AnyCellWrapping<U>> | AnyBrandedCell<Array<AnyCellWrapping<U>>>
    // Handle objects (excluding null)
    : T extends object ?
        | { [K in keyof T]: AnyCellWrapping<T[K]> }
          & { [ID]?: AnyCellWrapping<JSONValue>; [ID_FIELD]?: string }
        | AnyBrandedCell<{ [K in keyof T]: AnyCellWrapping<T[K]> }>
    // Handle primitives
    : T | AnyBrandedCell<T>;

// Factory types

// TODO(seefeld): Subset of internal type, just enough to make it
// differentiated. But this isn't part of the public API, so we need to find a
// different way to handle this.
export interface Pattern {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  defaultScope?: CellScope;
}
export interface Module {
  type: "ref" | "javascript" | "pattern" | "raw" | "isolated" | "passthrough";
  defaultScope?: CellScope;
}

export type toJSON = {
  toJSON(): unknown;
};

export type Handler<T = any, R = any> = Module & {
  with: (inputs: FactoryInput<StripCell<T>>) => Stream<R>;
};

export type NodeFactory<T, R> =
  & ((inputs: FactoryInput<T>) => Reactive<R>)
  & FabricFactory<[FactoryInput<T>], Reactive<R>>
  & (Module | Handler | Pattern)
  & toJSON
  & {
    asScope(scope: CellScope): NodeFactory<T, R>;
  };

export type PatternFactory<T, R> =
  & ((inputs: FactoryInput<T>) => Reactive<R>)
  & FabricFactory<[FactoryInput<T>], Reactive<R>>
  & Pattern
  & toJSON
  & {
    asScope(scope: CellScope): PatternFactory<T, R>;
    inSpace(space?: string | AnyCell<unknown>): PatternFactory<T, R>;
  };

export type ModuleFactory<T, R> =
  & ((inputs: FactoryInput<T>) => Reactive<R>)
  & FabricFactory<[FactoryInput<T>], Reactive<R>>
  & Module
  & toJSON
  & {
    asScope(scope: CellScope): ModuleFactory<T, R>;
  };

export type HandlerFactory<T, R> =
  & ((inputs: FactoryInput<StripCell<T>>) => Stream<R>)
  & FabricFactory<[FactoryInput<StripCell<T>>], Stream<R>>
  & Handler<T, R>
  & toJSON;

// JSON types

export type JSONValue =
  | null
  | boolean
  | number
  | string
  | JSONArray
  | JSONObject & IDFields;

export interface JSONArray extends ArrayLike<JSONValue> {}

export interface JSONObject extends Record<string, JSONValue> {}

// Annotations when writing data that help determine the entity id. They are
// removed before sending to storage.
export interface IDFields {
  [ID]?: unknown;
  [ID_FIELD]?: unknown;
}

/**
 * Recursively adds `readonly` to all properties of `T`.
 *
 * Mirrors the definition in `@commonfabric/utils/types` but is duplicated here
 * so that `@commonfabric/api` remains dependency-free.
 */
type Immutable<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<Immutable<U>>
  : T extends object ? ({ readonly [P in keyof T]: Immutable<T[P]> })
  : T;

/**
 * Deeply-readonly version of `JSONValue`. Used in `JSONSchemaObj` for fields
 * like `default`, `const`, `enum`, and `examples` whose values must not be
 * mutated after construction.
 */
export type ImmutableJSONValue = Immutable<JSONValue>;

// Valid values for the "type" property of a JSONSchema
export type JSONSchemaTypes =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null"
  | "undefined" // undefined is a non-standard addition
  | "unknown"; // unknown is a non-standard addition

// We can use a more complex asCell specifier to handle things like
// `Cell<Cell<T>>` with `{ asCell: ["cell", "cell"] }`.
// We can also do an `{ asCell: ["stream"] }` or `{ asCell: ["opaque"] }`.
// While this is currently tightly coupled to the CellKind type, we can restrict it
// to a subset
export type AsCellType = AsCellEntry;

/**
 * Serializable schema document nested inside factory metadata.
 *
 * Keeping this boundary JSON-shaped avoids recursively expanding three more
 * complete `JSONSchemaObj` branches in every schema consumer. Concrete schema
 * literals retain their exact type for `Schema<T>` inference, while runtime
 * validation still checks that each document is a JSON Schema.
 */
export type EmbeddedFactorySchema =
  | boolean
  | (Readonly<Record<string, JSONValue>> & IDFields);

/**
 * Describes the public call contract carried by a first-class factory value.
 *
 * A factory schema has one type meaning but two runtime exposures: eager
 * pattern construction receives a symbolic binding, while scheduled lift and
 * handler callbacks receive a runner-materialized callable.
 */
export interface PatternFactorySchema
  extends Readonly<Record<string, JSONValue>> {
  readonly kind: "pattern";
  readonly argumentSchema: EmbeddedFactorySchema;
  readonly resultSchema: EmbeddedFactorySchema;
}

export interface ModuleFactorySchema
  extends Readonly<Record<string, JSONValue>> {
  readonly kind: "module";
  readonly argumentSchema: EmbeddedFactorySchema;
  readonly resultSchema: EmbeddedFactorySchema;
}

export interface HandlerFactorySchema
  extends Readonly<Record<string, JSONValue>> {
  readonly kind: "handler";
  readonly contextSchema: EmbeddedFactorySchema;
  readonly eventSchema: EmbeddedFactorySchema;
}

export type AsFactoryType =
  | PatternFactorySchema
  | ModuleFactorySchema
  | HandlerFactorySchema;

// See https://json-schema.org/draft/2020-12/json-schema-core
// See https://json-schema.org/draft/2020-12/json-schema-validation
// There is a lot of potential validation that is not handled, but this object
// is defined to support them, so that generated schemas will still be usable.
export type JSONSchema = JSONSchemaObj | boolean;

export type JSONSchemaObj = {
  readonly $id?: string;
  readonly $ref?: string;
  readonly $defs?: Readonly<Record<string, JSONSchema>>;
  /** @deprecated Use `$defs` for 2019-09/Draft 8 or later */
  readonly definitions?: Readonly<Record<string, JSONSchema>>;

  // Subschema logic
  readonly allOf?: readonly (JSONSchema)[]; // not validated
  readonly anyOf?: readonly (JSONSchema)[]; // not always validated
  readonly oneOf?: readonly (JSONSchema)[]; // not always validated
  readonly not?: JSONSchema;
  // Subschema conditionally - none applied
  readonly if?: JSONSchema;
  readonly then?: JSONSchema;
  readonly else?: JSONSchema;
  readonly dependentSchemas?: Readonly<Record<string, JSONSchema>>;
  // Subschema for array
  readonly prefixItems?: readonly (JSONSchema)[]; // not always validated
  readonly items?: JSONSchema;
  readonly contains?: JSONSchema; // not validated
  // Subschema for object
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly patternProperties?: Readonly<Record<string, JSONSchema>>; // not validated
  readonly additionalProperties?: JSONSchema;
  readonly propertyNames?: JSONSchema; // not validated

  // Validation for any
  readonly type?: JSONSchemaTypes | readonly JSONSchemaTypes[];
  readonly enum?: readonly ImmutableJSONValue[]; // not validated
  readonly const?: ImmutableJSONValue; // not validated
  // Validation for numeric - none applied
  readonly multipleOf?: number;
  readonly maximum?: number;
  readonly exclusiveMaximum?: number;
  readonly minimum?: number;
  readonly exclusiveMinimum?: number;
  // Validation for string - none applied
  readonly maxLength?: number;
  readonly minLength?: number;
  readonly pattern?: string;
  // Validation for array  - none applied
  readonly maxItems?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly maxContains?: number;
  readonly minContains?: number;
  // Validation for object
  readonly maxProperties?: number; // not validated
  readonly minProperties?: number; // not validated
  readonly required?: readonly string[];
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>; // not validated

  // Format annotations
  readonly format?: string; // not validated

  // Contents - none applied
  readonly contentEncoding?: string;
  readonly contentMediaType?: string;
  readonly contentSchema?: JSONSchema;

  // Meta-Data
  readonly title?: string;
  readonly description?: string;
  readonly default?: ImmutableJSONValue;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly ImmutableJSONValue[];
  readonly $schema?: string;
  readonly $comment?: string;

  // Common Fabric extensions
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
  readonly scope?: SchemaScope;
  // Discovery hashtags from the doc comment (lowercased, without the leading
  // `#`). Populated by the schema generator; mirrors the description text.
  readonly tags?: readonly string[];
  // makes it so that your handler gets a Cell object for that property. So you can call .set()/.update()/.push()/etc on it.
  readonly asCell?: readonly AsCellType[];
  // Describes a first-class pattern, module, or handler factory callable.
  readonly asFactory?: AsFactoryType;
  // temporarily used to assign labels like "confidential"
  readonly ifc?: {
    readonly confidentiality?: readonly ImmutableJSONValue[];
    readonly integrity?: readonly ImmutableJSONValue[];
    readonly addIntegrity?: readonly ImmutableJSONValue[];
    readonly requiredIntegrity?: readonly ImmutableJSONValue[];
    readonly maxConfidentiality?: readonly ImmutableJSONValue[];
    readonly ownerPrincipal?: string | CurrentPrincipal;
    readonly writeAuthorizedBy?:
      | readonly string[]
      | {
        readonly __ctWriterIdentityOf?: {
          readonly bundleId?: string;
          readonly file?: string;
          readonly path?: readonly string[];
        };
      };
    readonly exactCopyOf?: readonly string[];
    // §8.3 projection claim (the lowered form of `Projection` /
    // `ProjectionOf` / `ProjectionPath`): this value is the field at JSON
    // pointer `path` inside the structured value at logical path `from`.
    readonly projection?: {
      readonly from: string;
      readonly path: string;
    };
    // Observation class of the declared label (Epic C, C5): which read
    // observations consume it. Absent or invalid = covering (consumed by
    // every content read class — over-taint, fail-safe).
    readonly observes?: "value" | "shape" | "enumerate" | "followRef";
    readonly uiContract?: {
      readonly helper?: "UiAction" | "UiPromptSlot" | "UiDisclosure";
      readonly action?: string;
      readonly surface?: string;
      readonly role?: string;
      readonly kind?: string;
      readonly trustedPattern?: string;
      readonly requiredEventIntegrity?: readonly string[];
    };
  };
};

/**
 * Recursively removes `readonly` from all properties of `T`.
 *
 * Copy of `Mutable` from `@commonfabric/utils/types`. These two definitions
 * should be unified; see that module for the canonical version.
 */
type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({
      -readonly [P in keyof T]: P extends "asFactory" ? T[P] : Mutable<T[P]>;
    })
  : T;

/**
 * A deep-mutable variant of `JSONSchemaObj`. Recursively strips `readonly`
 * from all properties, making the schema safe to build up incrementally.
 */
export type JSONSchemaObjMutable = Mutable<JSONSchemaObj>;

/**
 * A `JSONSchemaObjMutable` or a boolean. JSON Schema allows `true` (accept any
 * value) and `false` (reject all values) as valid schemas.
 */
export type JSONSchemaMutable = JSONSchemaObjMutable | boolean;

export type * from "./cfc.ts";
export { CFC_CANONICAL_ALIAS_NAMES } from "./cfc.ts";

export type TrustedActionWriteWithIntegrity<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]],
> = Cfc<
  WriteAuthorizedBy<T, Binding>,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

export type TrustedActionWrite<
  T,
  Binding,
  Action extends string,
  Pattern extends string,
> = TrustedActionWriteWithIntegrity<T, Binding, Action, Pattern, [Pattern]>;

export type TrustedActionUiContract<
  T,
  Action extends string,
  Pattern extends string,
  Integrity extends readonly [string, ...string[]] = [Pattern],
> = Cfc<
  T,
  {
    uiContract: {
      helper: "UiAction";
      action: Action;
      trustedPattern: Pattern;
      requiredEventIntegrity: Integrity;
    };
  }
>;

/**
 * Selects a sub-path within a document, optionally paired with a schema
 * that describes the value at that path. Used by the storage/sync layer
 * to track which slices of a document are being observed.
 */
export type SchemaPathSelector = {
  path: readonly string[];
  schema?: JSONSchema;
};

// LLM types matching Vercel AI SDK structure
export type BuiltInLLMTextPart = {
  type: "text";
  text: string;
};

export type BuiltInLLMImagePart = {
  type: "image";
  image: string | Uint8Array | ArrayBuffer | URL;
};

export type BuiltInLLMToolCallPart = {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  input: Record<string, any>;
};

export type BuiltInLLMToolResultPart = {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  output: { type: "text"; value: string } | { type: "json"; value: any };
};

export type BuiltInLLMContentPart =
  | BuiltInLLMTextPart
  | BuiltInLLMImagePart
  | BuiltInLLMToolCallPart
  | BuiltInLLMToolResultPart;

export type BuiltInLLMContent = string | BuiltInLLMContentPart[];

export type BuiltInLLMMessage = {
  role: "user" | "assistant" | "system" | "tool";
  content: BuiltInLLMContent;
};

// Image types from UI components
export interface ImageData {
  id: string;
  name: string;
  url: string;
  data: string;
  timestamp: number;
  width?: number;
  height?: number;
  size: number;
  type: string;
  exif?: {
    // Core metadata
    dateTime?: string;
    make?: string;
    model?: string;
    orientation?: number;
    // Location
    gpsLatitude?: number;
    gpsLongitude?: number;
    gpsAltitude?: number;
    // Camera settings
    fNumber?: number;
    exposureTime?: string;
    iso?: number;
    focalLength?: number;
    // Dimensions
    pixelXDimension?: number;
    pixelYDimension?: number;
    // Software
    software?: string;
    // Raw EXIF tags
    raw?: Record<string, any>;
  };
}

export type BuiltInLLMTool =
  & { description?: string }
  & (
    | {
      pattern: Pattern;
      handler?: never;
      extraParams?: Record<string, any>;
      useResultSchemaForObservation?: boolean;
    }
    | { handler: Stream<any> | Reactive<any>; pattern?: never }
  );

/**
 * A web source surfaced by a native search/grounding tool (e.g.
 * `google_search`). Populated on the result state when grounding is requested.
 */
export interface BuiltInLLMGroundingSource {
  url?: string;
  title?: string;
  snippet?: string;
}

// Built-in types
export interface BuiltInLLMParams {
  messages?: BuiltInLLMMessage[];
  model?: string;
  system?: string;
  stop?: string;
  maxTokens?: number;
  builtinTools?: boolean;
  observationMaxConfidentiality?: readonly ImmutableJSONValue[];
  /**
   * Specifies the mode of operation for the LLM.
   * - `"json"`: Indicates that the LLM should process and return data in JSON format.
   * This parameter is optional and defaults to undefined, which may result in standard behavior.
   */
  mode?: "json";
  /**
   * Tools that can be called by the LLM during generation.
   * Each tool has a description, input schema, and handler function that runs client-side.
   */
  tools?: Record<string, BuiltInLLMTool>;
  /**
   * Enable Google Search grounding (shorthand for the `google_search` native
   * model tool). Source URLs are surfaced on the state's `groundingSources`.
   */
  search?: boolean;
  /** Raw native model tool ids to request, e.g. `["google_search"]`. */
  nativeModelToolIds?: readonly string[];
  /**
   * Context cells to make available to the LLM.
   * These cells appear in the system prompt with their schemas and current values.
   */
  context?: Record<string, AnyCell<any>>;
  /**
   * When provided, injects a `presentResult` built-in tool that the LLM can call
   * to present a structured result matching this schema. The result is stored on the
   * dialog state's `result` field. Can be called multiple times (overwrites previous).
   */
  resultSchema?: JSONSchema;
  /**
   * Optional named queue to route async operations through.
   */
  queue?: string;
}

export interface BuiltInLLMState {
  pending: boolean;
  result?: BuiltInLLMContent;
  partial?: string;
  error?: string;
  cancelGeneration: Stream<void>;
  /** Web sources from native search grounding, when `search`/`google_search` was requested. */
  groundingSources?: readonly BuiltInLLMGroundingSource[];
}

export interface BuiltInLLMGenerateObjectState<T> {
  pending: boolean;
  result?: T;
  messages?: BuiltInLLMMessage[];
  partial?: string;
  error?: string;
  cancelGeneration: Stream<void>;
  // NOTE: `generateObject` accepts `search`/`nativeModelToolIds` (grounding can
  // improve the structured result), but does NOT surface `groundingSources` —
  // its JSON-mode path returns only the object, not the grounded response. Use
  // `generateText` when you need the source URLs.
}

export interface BuiltInLLMDialogState {
  pending: boolean;
  result?: any;
  error?: string;
  cancelGeneration: Stream<void>;
  addMessage: Stream<BuiltInLLMMessage>;
  pinCell: Stream<{ path: string; name: string }>;
  unpinAllCells: Stream<void>;
  flattenedTools: Record<string, any>;
  pinnedCells: Array<{ path: string; name: string }>;
}

export type BuiltInGenerateObjectParams =
  | {
    model?: string;
    prompt: BuiltInLLMContent;
    messages?: never;
    context?: Record<string, any>;
    schema?: JSONSchema;
    system?: string;
    cache?: boolean;
    maxTokens?: number;
    observationMaxConfidentiality?: readonly ImmutableJSONValue[];
    schemaSanitizePromptInjection?: boolean;
    metadata?: Record<string, string | undefined | object>;
    tools?: Record<string, BuiltInLLMTool>;
    /**
     * Enable Google Search grounding (shorthand for the `google_search`
     * native model tool). Real, current web results inform the answer, and
     * the source URLs are surfaced on the result state's `groundingSources`
     * (generateText / llm only — generateObject does not surface them).
     */
    search?: boolean;
    /**
     * Raw native model tool ids to request (e.g. `["google_search"]`).
     * `search: true` is the friendly shorthand for `["google_search"]`.
     */
    nativeModelToolIds?: readonly string[];
    queue?: string;
  }
  | {
    model?: string;
    prompt?: never;
    messages: BuiltInLLMMessage[];
    context?: Record<string, any>;
    schema?: JSONSchema;
    system?: string;
    cache?: boolean;
    maxTokens?: number;
    observationMaxConfidentiality?: readonly ImmutableJSONValue[];
    schemaSanitizePromptInjection?: boolean;
    metadata?: Record<string, string | undefined | object>;
    tools?: Record<string, BuiltInLLMTool>;
    /**
     * Enable Google Search grounding (shorthand for the `google_search`
     * native model tool). Real, current web results inform the answer, and
     * the source URLs are surfaced on the result state's `groundingSources`
     * (generateText / llm only — generateObject does not surface them).
     */
    search?: boolean;
    /**
     * Raw native model tool ids to request (e.g. `["google_search"]`).
     * `search: true` is the friendly shorthand for `["google_search"]`.
     */
    nativeModelToolIds?: readonly string[];
    queue?: string;
  };

export type BuiltInGenerateTextParams =
  | {
    prompt: BuiltInLLMContent;
    messages?: never;
    context?: Record<string, any>;
    system?: string;
    model?: string;
    maxTokens?: number;
    tools?: Record<string, BuiltInLLMTool>;
    /**
     * Enable Google Search grounding (shorthand for the `google_search`
     * native model tool). Real, current web results inform the answer, and
     * the source URLs are surfaced on the result state's `groundingSources`
     * (generateText / llm only — generateObject does not surface them).
     */
    search?: boolean;
    /**
     * Raw native model tool ids to request (e.g. `["google_search"]`).
     * `search: true` is the friendly shorthand for `["google_search"]`.
     */
    nativeModelToolIds?: readonly string[];
    queue?: string;
  }
  | {
    prompt?: never;
    messages: BuiltInLLMMessage[];
    context?: Record<string, any>;
    system?: string;
    model?: string;
    maxTokens?: number;
    tools?: Record<string, BuiltInLLMTool>;
    /**
     * Enable Google Search grounding (shorthand for the `google_search`
     * native model tool). Real, current web results inform the answer, and
     * the source URLs are surfaced on the result state's `groundingSources`
     * (generateText / llm only — generateObject does not surface them).
     */
    search?: boolean;
    /**
     * Raw native model tool ids to request (e.g. `["google_search"]`).
     * `search: true` is the friendly shorthand for `["google_search"]`.
     */
    nativeModelToolIds?: readonly string[];
    queue?: string;
  };

export interface BuiltInGenerateTextState {
  pending: boolean;
  result?: string;
  error?: string;
  partial?: string;
  requestHash?: string;
  /** Web sources from native search grounding, when `search`/`google_search` was requested. */
  groundingSources?: readonly BuiltInLLMGroundingSource[];
}

export interface BuiltInCompileAndRunParams<T> {
  files: Array<{ name: string; contents: string }>;
  main: string;
  input?: T;
}

export interface BuiltInCompileAndRunState<T> {
  pending: boolean;
  result?: T;
  error?: any;
  errors?: Array<{
    line: number;
    column: number;
    message: string;
    type: string;
    file?: string;
  }>;
}

// Function type definitions
//
// Boundary principle for factory types: factories ACCEPT the stripped data
// shape — `FactoryInput<StripCell<T>>` means "this data shape, wrapped however
// you like" (liberal in what we accept). Factories RETURN exactly what the body
// returned: `R` unstripped (faithful in what we produce). Cell/Stream brands in
// a result type are exported capabilities, preserved end-to-end — the brand in
// the type becomes `asCell`/`asStream` in the generated result schema, which
// the runtime rematerializes as a live Cell/Stream for consumers. Stripping a
// result type would not just misreport that; transformer-inferred schemas are
// derived from these types, so it would silently downgrade live cells to dead
// values. (`SELF` and the consumer-facing factory result deliberately use the
// same unstripped `R`.)
export interface PatternFunction {
  // Function-only overload: T and R inferred from function
  <T, R>(
    fn: (
      input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
    ) => FactoryInput<R>,
  ): PatternFactory<StripCell<T>, R>;

  // Function-only overload: T explicit, R inferred
  <T>(
    fn: (
      input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<any> },
    ) => any,
  ): PatternFactory<StripCell<T>, ReturnType<typeof fn>>;

  // Function + schema overload: T explicit, R inferred
  <T>(
    fn: (
      input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<any> },
    ) => any,
    argumentSchema: JSONSchema,
    resultSchema?: JSONSchema,
  ): PatternFactory<StripCell<T>, ReturnType<typeof fn>>;

  // Function + schema overload: T and R explicit
  <T, R>(
    fn: (
      input: Reactive<RequireDefaults<T>> & { [SELF]: Reactive<R> },
    ) => FactoryInput<R>,
    argumentSchema: JSONSchema,
    resultSchema?: JSONSchema,
  ): PatternFactory<StripCell<T>, R>;
}

/**
 * Result of patternTool() - an LLM tool definition with a pattern and optional pre-filled params.
 * This is the actual runtime return type, not a cast.
 */
export interface PatternToolResult<E = Record<PropertyKey, never>> {
  pattern: Pattern;
  extraParams: E;
  useResultSchemaForObservation?: boolean;
}

// Marker branding a tool-input field as framework-provided: the runtime fills
// it (e.g. the bash tool's `sandboxId`), and `patternTool` rejects any attempt
// to pre-fill it through extraParams. Compile-time only; at runtime a
// `FrameworkProvided<T>` value is just a `T`. The brand is a symbol-keyed
// property, so schema generation emits the inner type's schema unchanged.
//
// Shaped as `(T & brand) | T` (like Default<>): the bare `| T` arm keeps the
// type nameable in emitted declarations, while the branded arm is what
// FrameworkProvidedKeys<> detects.
export declare const FRAMEWORK_PROVIDED_MARKER: unique symbol;
type FrameworkProvidedMarker = { readonly [FRAMEWORK_PROVIDED_MARKER]: true };
export type FrameworkProvided<T> = (T & FrameworkProvidedMarker) | T;

// Distributes over the union members of V (naked param) so it sees the brand in
// the `(T & brand) | T` shape: `true` for the branded arm, `false` for the bare
// one, hence `boolean` for the whole union. `any` is excluded — `any extends X`
// is `boolean`, which would otherwise flag every loosely-typed field.
type _HasFrameworkBrand<V> = IsAny<V> extends true ? false
  : V extends FrameworkProvidedMarker ? true
  : false;

// The keys of T whose value is `FrameworkProvided<...>` — the fields an author
// must not pre-fill. `NonNullable` lets it see the brand through an optional
// `field?: FrameworkProvided<...>`.
type FrameworkProvidedKeys<T> = {
  [K in keyof T]-?: true extends _HasFrameworkBrand<NonNullable<T[K]>> ? K
    : never;
}[keyof T];

export type PatternToolFunction = <
  T,
  E extends object = Record<PropertyKey, never>,
>(
  // CT-1655: the first argument must be an explicit `pattern(...)`. Passing a
  // bare callback (and letting the runtime wrap it / a transformer auto-capture
  // its closure) is no longer supported — wrap it yourself:
  // `patternTool(pattern(fn), extraParams?)`.
  pattern: PatternFactory<T, any>,
  // Reject pre-filling a framework-provided field (e.g. the bash tool's
  // `sandboxId`); otherwise validate that E (after stripping cells) is a subset
  // of T.
  extraParams?: [keyof E & FrameworkProvidedKeys<T>] extends [never]
    ? (StripCell<E> extends Partial<T> ? FactoryInput<E> : never)
    : never,
) => PatternToolResult<E>;

// Public (schema-light) surface, matching PatternFunction's index.ts shape: the
// callback is the only argument and the types come from the callback itself. The
// schema-bearing, type-materializing overloads (where the callback's input type
// is derived FROM the supplied JSONSchema) live in `commonfabric/schema`
// (api/schema.ts) so that schema and type can never contradict each other — the
// same split pattern already used for pattern()/handler(). Transformer-emitted
// `__cfHelpers.lift(...)` is untyped (`__cfHelpers: any`), so it does not depend
// on these overloads; only authored `lift(...)` calls resolve against them.
export interface LiftFunction {
  <T, R>(
    implementation: (input: T) => R,
  ): ModuleFactory<StripCell<T>, R>;

  <T>(
    implementation: (input: T) => any,
  ): ModuleFactory<StripCell<T>, ReturnType<typeof implementation>>;

  <T extends (...args: any[]) => any>(
    implementation: T,
  ): ModuleFactory<StripCell<Parameters<T>[0]>, ReturnType<T>>;
}

// Helper type to make non-Cell and non-Stream properties readonly in handler state.
// Cell/Stream/SqliteDb are passed through whole (they are handle interfaces with
// methods — `.get()/.set()`, `.send()`, `.exec()/.query()` — not data containers
// to map over).
export type HandlerState<T> = T extends Cell<any> ? T
  : T extends Stream<any> ? T
  : T extends SqliteDb<any> ? T
  : T extends FabricFactory<any, any> ? T
  : T extends Array<infer U> ? ReadonlyArray<HandlerState<U>>
  : T extends object ? { readonly [K in keyof T]: HandlerState<T[K]> }
  : T;

export interface HandlerFunction {
  // With inferred types
  <E, T>(
    eventSchema: JSONSchema,
    stateSchema: JSONSchema,
    handler: (event: E, props: HandlerState<T>) => any,
  ): HandlerFactory<T, E>;

  // Without schemas
  <E, T>(
    handler: (event: E, props: T) => any,
    options: { proxy: true },
  ): HandlerFactory<T, E>;

  <E, T>(
    handler: (event: E, props: HandlerState<T>) => any,
  ): HandlerFactory<T, E>;
}

/**
 * ActionFunction creates a handler that doesn't use the state parameter.
 *
 * This is to handler as computed is to lift:
 * - User writes: action((e) => count.set(e.data))
 * - Transformer rewrites to: handler((e, { count }) => count.set(e.data))({ count })
 *
 * The transformer extracts closures and makes them explicit, just like how
 * computed(() => expr) becomes a lift-applied computation with closure
 * extraction.
 */
export type ActionFunction = {
  // Overload 1: Zero-parameter callback returns Stream<void>
  (fn: () => void): Stream<void>;
  // Overload 2: Parameterized callback returns Stream<T>
  <T>(fn: (event: T) => void): Stream<T>;
};

export type ComputedFunction = <T>(fn: () => T) => Reactive<T>;

/**
 * One operand recorded while an `assert` body ran: the operand's authored
 * source text, and its value rendered with `toCompactDebugString`.
 */
export type AssertPart = {
  src: string;
  rendered: string;
};

/**
 * The value an `assert(...)` assertion carries.
 *
 * `ok` is the assertion's result. When it is false, `parts` holds the operands
 * of the top-level operator (or the arguments of a call) recorded during the
 * evaluation that produced that result, and `source` is the authored text of
 * the whole assertion. The pattern test runner renders them on failure.
 *
 * It is one record on both paths rather than `true | AssertPart[]`, because a
 * union return infers as `unknown`, and a field whose schema is
 * `{ type: "unknown" }` reads back as `undefined`.
 */
export type AssertRecord = {
  ok: boolean;
  source: string;
  parts: AssertPart[];
};

/**
 * assert: a `computed` for pattern-test assertions that reports its operands.
 *
 * `assert(() => a + b <= c)` evaluates like `computed(() => a + b <= c)`, but
 * the transformer rewrites the body to record each operand as it is computed,
 * so a failure can name `a + b` and `c` and their values instead of reporting
 * only `false`. Use it in a test pattern's `tests` array:
 *
 *     { assertion: assert(() => list.items.length === 3) }
 */
export type AssertFunction = (fn: () => boolean) => Reactive<AssertRecord>;

/**
 * Records one operand of an `assert` body and returns it unchanged, so that
 * wrapping an operand does not change evaluation order or semantics. The
 * assert-diagnostics transformer emits the calls; authored code does not call
 * it directly.
 */
export type AssertCaptureFunction = <T>(
  parts: AssertPart[],
  src: string,
  value: T,
) => T;

export type StrFunction = (
  strings: TemplateStringsArray,
  ...values: any[]
) => Reactive<string>;

export type IfElseFunction = <T = any, U = any, V = any>(
  condition: FactoryInput<T>,
  ifTrue: FactoryInput<U>,
  ifFalse: FactoryInput<V>,
) => Reactive<U | V>;

export type WhenFunction = <T = any, U = any>(
  condition: FactoryInput<T>,
  value: FactoryInput<U>,
) => Reactive<T | U>;

export type UnlessFunction = <T = any, U = any>(
  condition: FactoryInput<T>,
  fallback: FactoryInput<U>,
) => Reactive<T | U>;

/** @deprecated Use generateText() or generateObject() instead */
export type LLMFunction = (
  params: FactoryInput<BuiltInLLMParams>,
) => Reactive<BuiltInLLMState>;

export type LLMDialogFunction = (
  params: FactoryInput<BuiltInLLMParams>,
) => Reactive<BuiltInLLMDialogState>;

export type GenerateObjectFunction = <T = any>(
  params: FactoryInput<BuiltInGenerateObjectParams>,
) => Reactive<BuiltInLLMGenerateObjectState<T>>;

export type GenerateTextFunction = (
  params: FactoryInput<BuiltInGenerateTextParams>,
) => Reactive<BuiltInGenerateTextState>;

export type FetchOptions = {
  body?: JSONValue;
  headers?: Record<string, string>;
  mutexTimeoutMs?: number;
  cache?:
    | "default"
    | "no-store"
    | "reload"
    | "no-cache"
    | "force-cache"
    | "only-if-cached";
  method?: "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "OPTIONS" | "HEAD";
  redirect?: "follow" | "error" | "manual";
};
/** Result shape of fetchBinary: the raw response bytes plus the media type. */
export type FetchBinaryResult = {
  /** Response body as a byte buffer; read it with `slice()` / `copyInto()`. */
  bytes: FabricBytes;
  /** Media type from the Content-Type response header, e.g. "image/png". */
  mediaType: string;
};

/**
 * Fetch a URL and expose the response body as binary data.
 *
 * `result` holds the body as `{ bytes, mediaType }` where `bytes` is a
 * `FabricBytes` byte buffer. `pending` is true while the request is in
 * flight; failures land on `error`.
 */
export type FetchBinaryFunction = (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{ pending: boolean; result: FetchBinaryResult; error?: any }>;

/**
 * Fetch a URL and expose the response body as text.
 *
 * `result` holds the body decoded as UTF-8. `pending` is true while the
 * request is in flight; failures land on `error`.
 */
export type FetchTextFunction = (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{ pending: boolean; result: string; error?: any }>;

/**
 * Fetch a URL and expose the response body as parsed JSON.
 *
 * An explicit type argument is required (`fetchJson<T>({ url })`); calling
 * fetchJson without one is a compile error — use fetchJsonUnchecked for JSON
 * whose shape isn't declared as a type. The compiler derives a JSON schema
 * from `T` and injects it as the `schema` parameter; the response is verified
 * against that schema at fetch time, and a verification failure lands on
 * `error` with `result` left undefined. Verification follows standard JSON
 * Schema semantics: object properties not named in the schema are allowed
 * unless the schema declares `additionalProperties` itself. A schema passed
 * explicitly takes precedence over the derived one.
 */
export type FetchJsonFunction = <T>(
  params: FactoryInput<{
    url: string;
    schema?: JSONSchema;
    options?: FetchOptions;
    result?: T;
  }>,
) => Reactive<{ pending: boolean; result: T; error?: any }>;

/**
 * Fetch a URL and expose the response body as parsed JSON, without any
 * schema verification.
 *
 * The escape hatch for responses whose shape isn't declared as a type: the
 * parsed body is returned as `any` and never verified. Prefer fetchJson with
 * an explicit type argument where a type exists.
 */
export type FetchJsonUncheckedFunction = (
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
  }>,
) => Reactive<{ pending: boolean; result: any; error?: any }>;

export type FetchProgramFunction = (
  params: FactoryInput<{ url: string }>,
) => Reactive<{
  pending: boolean;
  result: {
    files: Array<{ name: string; contents: string }>;
    main: string;
  } | undefined;
  error?: any;
}>;

export type StreamDataFunction = <T>(
  params: FactoryInput<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => Reactive<{ pending: boolean; result: T; error?: any }>;

export type CompileAndRunFunction = <T = any, S = any>(
  params: FactoryInput<BuiltInCompileAndRunParams<T>>,
) => Reactive<BuiltInCompileAndRunState<S>>;

// --- SQLite builtins (docs/specs/sqlite-builtin) ---

declare const __sqliteDb: unique symbol;
/**
 * Database handle. Empty to pattern code; a cell reference to the runtime
 * via the `toCell` back-pointer. Patterns only ever *forward* it (to sqliteQuery
 * / sqliteExecute / reactOn), never read it.
 */
export type SqliteDatabase = { readonly [__sqliteDb]: true };

/** Imperative write on a SqliteDb handle: records a SQLite write onto the
 *  current transaction so it commits atomically with surrounding cell writes
 *  (see docs/specs/sqlite-builtin/plans/sqlitedb-cell-type-exploration.md). */
export interface ISqliteExecutable {
  exec(
    sql: string,
    params?: ReadonlyArray<unknown> | Record<string, unknown>,
  ): void;
}

/** Reactive read on a SqliteDb handle: builds a `sqliteQuery` node. `<Row>` is
 *  lowered by the transformer to an injected result schema. */
export interface ISqliteQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    options?: {
      params?: ReadonlyArray<unknown> | Record<string, unknown>;
      reactOn?: unknown;
      /** CFC Phase 3: declared output ceiling (see SqliteQueryParams). */
      maxConfidentiality?: ReadonlyArray<unknown>;
      /** `"fail"` (default) | `"skip"` when a row exceeds the ceiling. */
      onExceed?: "fail" | "skip";
      /** CFC Phase 3.b: filter rows to those the acting reader may read (a
       *  declared existence release). Requires the table to opt in via
       *  `table(…, { allowReadClearance: true })`; never for aggregates. The
       *  count of withheld rows is reported as `withheld`. */
      readClearance?: boolean;
    },
  ): Reactive<
    { pending: boolean; result?: Row[]; error?: any; withheld?: number }
  >;
}

/**
 * SqliteDb is a cell variant (kind `"sqlite"`) — a DB handle cell exposing ONLY
 * the SQLite method surface (`.exec`/`.query`), not the general value-cell
 * read/write API. In particular it deliberately does **not** extend
 * `IReadable<T>`: `.get()`/`.sample()` are meaningless on an opaque DB handle
 * (the handle ref is an internal detail; pattern code reads rows via `.query`),
 * so omitting them keeps `db.get()` from type-checking. The handle is also not
 * writable (you can't `.set()` a DB handle). The runtime still reads the raw
 * handle internally via `getRaw()` to fold writes onto the transaction.
 */
export interface ISqliteDb<T = SqliteDatabase>
  extends IAnyCell<T>, ISqliteExecutable, ISqliteQueryable {}

export interface SqliteDb<T = SqliteDatabase>
  extends BrandedCell<T, "sqlite">, ISqliteDb<T> {}

/** A map of table name -> one-row JSON Schema (see `table()`). */
export type SqliteTableSchemas = Record<string, JSONSchema>;

/** Non-default database source. Cell-derived (default) needs no source; on-disk
 *  databases are injected as a pattern input, not selected here. */
export type SqliteDatabaseSource = {
  vm: Reactive<unknown>;
  path: string;
};

export type SqliteDatabaseFunction = {
  (
    options?: { tables?: SqliteTableSchemas },
    source?: SqliteDatabaseSource,
  ): Reactive<SqliteDb>;
  /** Bind the db (and so its on-disk file) to a scope. The transformer lowers
   *  `const db: PerUser<SqliteDb> = sqliteDatabase(...)` to `.asScope("user")`;
   *  call it explicitly for the same effect. */
  asScope(scope: CellScope): SqliteDatabaseFunction;
};

export type SqliteQueryParams = {
  db: FactoryInput<SqliteDatabase | SqliteDb>;
  sql: string;
  params?: ReadonlyArray<unknown> | Record<string, unknown>;
  reactOn?: unknown;
  /** CFC Phase 3: the declared output ceiling — the maximum confidentiality
   *  the RESULT may carry (a consumer contract, not reader clearance).
   *  Placeholder atoms `{__ctCurrentPrincipal: true}` (the acting user) and
   *  `{__ctDbOwner: true}` (the db's owner) resolve at prepare time. The
   *  typed alternative is `MaxConfidentiality<Row, …>` on the Row schema —
   *  declare the ceiling once, not both ways. */
  maxConfidentiality?: ReadonlyArray<unknown>;
  /** What to do when a row's label exceeds the ceiling: `"fail"` (default —
   *  refuse the whole query) or `"skip"` (drop the offending rows; a declared
   *  existence release, row-returning queries only — never aggregates). */
  onExceed?: "fail" | "skip";
  /** CFC Phase 3.b read-time clearance: when `true`, filter rows to those the
   *  acting reader may read (a declared existence release under §8.17/inv-14).
   *  Requires the touched rule-bearing table to opt in via
   *  `table(…, { allowReadClearance: true })`; never for aggregates. The number
   *  of withheld rows is reported back as `withheld`. */
  readClearance?: boolean;
};
export type SqliteQueryFunction = <Row = Record<string, unknown>>(
  params: FactoryInput<SqliteQueryParams>,
) => Reactive<
  { pending: boolean; result?: Row[]; error?: any; withheld?: number }
>;

// Writes are the imperative SqliteDb.exec method (see ISqliteExecutable), which
// folds a `sqlite` op into the caller's commit (atomic with cell writes). There
// is no standalone reactive sqliteExecute builder.

/** Column spec for `table()`: a shorthand SQL type string or a column schema. */
export type SqliteColumnSpec = string | JSONSchema;

/** A reference to a declared column, handed to a row-label rule as `f.<col>`
 *  (CFC Phase 3; see `@commonfabric/memory/sqlite/row-label`). */
export type SqliteRowFieldRef = { readonly field: string };

/** A per-row CFC label rule: a pure declarative projection over the row's
 *  columns, built from the closed helper set (match/principal/all/whenMatches/
 *  dbOwner/endorsedBy/…). Validated and serialized at `table()` time;
 *  evaluated identically at the write gate, server commit, and read. */
export type SqliteRowLabelRule = (
  f: Record<string, SqliteRowFieldRef>,
) => { confidentiality?: unknown; integrity?: unknown };

export type SqliteTableFunction = (
  columns: Record<string, SqliteColumnSpec>,
  rule?: SqliteRowLabelRule,
  /** CFC Phase 3.b: `{ allowReadClearance: true }` opts the table into
   *  read-time clearance (reader-filtered `db.query({ readClearance: true })`).
   *  Needs a `rule` — throws at `table()` time without one. */
  opts?: { allowReadClearance?: boolean },
) => JSONSchema;

/**
 * The SQLite helper namespace: one import for the table/label vocabulary —
 * `const { table, all, principal, match, dbOwner } = cfSqlite`. The row-label
 * helpers (CFC Phase 3) build the declarative per-row rule passed to
 * `table(columns, rule)`; each returns a serialized AST node. `any(...)`
 * (one authored OR-clause) errors at `table()` time until the clause-aware
 * label profile lands. There is deliberately no bare `when`: the builder's
 * control-flow `when` lowering matches by name, so the gate is the fused
 * `whenMatches`.
 */
export interface CfSqliteHelpers {
  table: SqliteTableFunction;
  cfLink: SqliteCfLinkFunction;
  /** Regex (forced global) over a column ⟹ ordered match list (split+clean). */
  match(
    field: SqliteRowFieldRef,
    re: RegExp,
    opts?: { group?: number; min?: number },
  ): unknown;
  /** `did:<protocol>:<v>` per extracted value (protocol-implied normalization). */
  principal(protocol: string, of: unknown): unknown;
  /** Conjunctive clauses — every term an independent requirement. */
  all(...terms: unknown[]): unknown;
  /** ONE authored OR-clause (reserved: errors until OR-clause support). */
  any(...terms: unknown[]): unknown;
  /** Integrity meet (set ∩). Integrity-only. */
  intersect(...terms: unknown[]): unknown;
  /** Include `then` only when the regex tests true against the column. */
  whenMatches(field: SqliteRowFieldRef, re: RegExp, then: unknown): unknown;
  /** The db's owner (fixed, from the db ref — never the acting reader). */
  dbOwner(): unknown;
  endorsedBy(p: unknown): unknown;
  authoredBy(p: unknown): unknown;
  /** A literal atom (escape hatch). */
  constant(atom: unknown): unknown;
}
export type SqliteCfLinkFunction = <_T = unknown>() => JSONSchema;

export type WishTag = `/${string}` | `#${string}`;

export type DID = `did:${string}:${string}`;

export type WishParams = {
  query: WishTag | string;
  path?: string[];
  context?: Record<string, any>;
  schema?: JSONSchema;
  /**
   * Search scope for hashtag queries: "~" = favorites (home), "." = mentionables (current space),
   * "profile" = current user's profile elements.
   * Default (undefined) = favorites only for backward compatibility.
   */
  scope?: (DID | "~" | "." | "profile")[];
  /**
   * When true, skip the suggestion/picker UI pattern (suggestion.tsx).
   * Multiple candidates are returned as-is without disambiguation.
   * Use this for programmatic discovery where no user interaction is needed.
   */
  headless?: boolean;
};

export type WishState<T> = {
  // A failed wish should have result of undefined and candidates of []
  result: T | undefined;
  candidates: T[];
  error?: any;
  [UI]?: VNode;
};

export type NavigateToFunction = (cell: Reactive<any>) => Reactive<boolean>;
export interface WishFunction {
  <T = unknown>(
    target: FactoryInput<WishParams>,
  ): Reactive<WishState<T> & UIRenderable>;
}

/**
 * The bounded label-introspection query (CFC spec §4.6.4.1, inv-12 Stage 2):
 * equality tests only, over atom `type`, caveat `kind`, `source`, and the
 * resource/policy/origin fields. The family-qualified predicates test their
 * own atom family only — `resourceClass` reads `Resource.class`,
 * `policyName` reads the `Policy`/`Context` ref `name`, `originUri` reads
 * `Origin.uri`, and `caveatKind` reads the `kind` discriminator of `Caveat`
 * atoms and the type-less kind-shaped claim atoms — so an unrelated atom
 * that merely has a same-named field is not a match. An absent field (or a
 * family miss) on a candidate atom is no match. All six fields are supported
 * even where the runtime currently mints no atoms carrying them.
 */
export type ConfLabelQuery = {
  atomType?: string;
  caveatKind?: string;
  source?: unknown;
  resourceClass?: string;
  policyName?: string;
  originUri?: string;
};

/**
 * One projected confidentiality atom, addressed by its position in the label
 * STORED at the target path: `clauseIndex` across the per-component clause
 * lists in stored order, `alternativeIndex` inside an `anyOf` clause (0 for a
 * bare atom), `atomIndex` within the alternative (always 0 in this runtime —
 * an alternative is one atom; the field keeps the §4.6.4.1 profile shape).
 * `atom` is the stored form verbatim — a committed `{digestOf: ...}` field
 * stays committed.
 */
export type LabelAtomProjection = {
  targetPath: string;
  clauseIndex: number;
  alternativeIndex: number;
  atomIndex: number;
  atom: unknown;
};

/**
 * Introspection outcome (spec §4.6.4.1). `notAvailable` is one normalized
 * constant covering unobservable targets, missing metadata,
 * matching-but-unreadable atoms, and results whose consumed metadata labels
 * cannot ride the transaction (flow labels not persisting) — callers cannot
 * distinguish the arms. `ok` with empty `atoms` means the miss was
 * established from metadata the caller was authorized to observe.
 */
export type InspectConfLabelResult =
  | { status: "ok"; atoms: LabelAtomProjection[] }
  | { status: "notAvailable" };

/**
 * `inspectConfLabel(target, targetPath, query)` — bounded first-layer
 * introspection of the confidentiality label stored at `target`'s payload
 * path (inv-12 Stage 2; CFC spec §4.6.4.1). `targetPath` is the
 * application-facing payload pointer (`"/body"` addresses the label stored
 * at the `/value/body` envelope entry; `""` is the payload root). The result
 * is a runtime-labeled value: the metadata observations consumed to answer
 * the query join the result's label through the normal flow derivation, so
 * protected results require the deployment to persist flow labels
 * (`cfcFlowLabels: "persist"`) — otherwise they degrade to `notAvailable`
 * (fail closed; never an unlabeled copy of protected label metadata).
 */
export type InspectConfLabelFunction = (
  target: Reactive<any>,
  targetPath: FactoryInput<string>,
  query: FactoryInput<ConfLabelQuery>,
) => Reactive<InspectConfLabelResult>;

export type CreateNodeFactoryFunction = <T = any, R = any>(
  moduleSpec: Module,
) => ModuleFactory<T, R>;

// Symbol used to brand Default<T,V> types so RequireDefaults<T> can detect them.
// This is a compile-time-only brand; at runtime Default<> is just T.
export declare const DEFAULT_MARKER: unique symbol;

type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };

// True only for the empty tuple `[]` (a length-0 tuple), false for general
// arrays like `string[]` (whose `length` is the wide `number`) and non-empty
// tuples. Used by Default<> to special-case `Default<[]>` (see below).
type IsEmptyTuple<T> = T extends readonly unknown[]
  ? number extends T["length"] ? false
  : T["length"] extends 0 ? true
  : false
  : false;

// Default type for specifying default values in type definitions.
// The DEFAULT_MARKER brand enables RequireDefaults<T> to detect which fields
// have runtime-provided defaults and make them non-optional in pattern bodies.
// Detection uses conditional type inference (not keyof) for performance.
// Nullish-only defaults need a standalone marker because `null & Brand` and
// `undefined & Brand` collapse to `never`.
//
// The brand PAYLOAD carries V — the default VALUE's type — not T (matching
// DeepDefault<V>). This is load-bearing for schema generation: the alias body
// never otherwise mentions V, so once the checker resolves the alias away
// (which it does through every capture/projection/instantiation path), the
// payload is the ONLY place the default value survives at the type level.
// Schema generation reads it back from expanded types (see the brand-payload
// fallback in schema-generator's union formatter); detection everywhere else
// is payload-agnostic (`{ readonly [DEFAULT_MARKER]: any }`), so the payload
// choice affects nothing but recoverability. Carrying T instead silently
// dropped `"default"` from every schema built off a checker type.
//
// Empty-tuple special case (CT-1640): for `Default<[]>` we keep ONLY the branded
// arm and drop the bare `| T` arm. Without this, `Default<[]>` would contribute a
// bare `[]` (i.e. `never[]`) member; in the documented `T[] | Default<[]>` shape
// that bare member survives `.get()`'s brand-stripping, leaving `T[] | never[]`,
// and TypeScript intersects parameter-position element types across the union so
// `.includes(x)`/`.indexOf(x)` collapse their parameter to `never`. Dropping the
// bare arm lets the sibling `T[]` member supply the value type while the brand is
// still present for RequireDefaults<> detection. (The lone `Default<[]>` form —
// no sibling array — is not used in practice; the docs always pair it as
// `T[] | Default<[]>`.)
//
// Why ONLY the empty tuple, and not all tuples: a non-empty literal-tuple default
// in a union (e.g. `string[] | Default<["seed"]>`) also narrows parameter-position
// methods — but to the literal element type, which is a legible error, not the
// confusing `never`. More importantly, the empty tuple is the unique tuple that
// can never be a legitimate *standalone* field type, so dropping its plain arm is
// unconditionally safe. Generalizing to all tuples would collapse a standalone
// tuple default like `Default<[string, number], ["a", 0]>` to `never` (the lone
// branded arm strips away), breaking that contract. Authors who want an array
// field with an empty-ish/seed default and a precise element type should use the
// two-arg form `Default<string[], []>` (T = the array, not the tuple).
export type Default<T, V extends T = T> = IsEmptyTuple<T> extends true
  ? T & DefaultMarker<V>
  :
    | ([T] extends [null | undefined] ? DefaultMarker<V>
      : T & DefaultMarker<V>)
    | T;

/**
 * Marker for partial, recursive object defaults in `T | DeepDefault<V>` schema
 * declarations. It is stripped from pattern body types by RequireDefaults<T>;
 * schema generation reads `V` from the AST and applies it as object/property
 * defaults.
 */
export type DeepDefault<V> = DefaultMarker<V>;

/** Detect if T is `any` (used to avoid false positives in brand detection). */
type IsAny<T> = 0 extends 1 & T ? true : false;

/** Returns true if T is exactly the `boolean` type (i.e. `true | false`), and false for `true`, `false`, or any other type. */
type IsBoolean<T> = [T] extends [boolean] ? [boolean] extends [T] ? true : false
  : false;

/**
 * Inner helper for HasDefaultBrand. Distributes over union members of T —
 * returning `true` for the branded member, `false` for the plain member,
 * and therefore `boolean` when T is the full `Default<X, V>` union.
 *
 * IMPORTANT: uses `T extends { readonly [DEFAULT_MARKER]: any }` (T is the naked
 * type parameter on the LEFT of extends) so TypeScript distributes over union
 * members. The previous form `typeof DEFAULT_MARKER extends keyof T` was
 * non-distributive — for union T, `keyof T` is the intersection of member keys,
 * which drops DEFAULT_MARKER (it only appears in the branded member).
 */
type _HasDefaultBrand<T> = T extends { readonly [DEFAULT_MARKER]: any } ? true
  : false;

/** Returns true if T carries the DEFAULT_MARKER brand (i.e. is `Default<T, V>`), false otherwise. */
type HasDefaultBrand<T> = IsAny<T> extends true ? false
  : IsBoolean<_HasDefaultBrand<T>> extends true ? true
  : _HasDefaultBrand<T>;

/**
 * Detect whether a type T is (or wraps) a Default<>-branded value.
 * Handles both direct Default<T,V> and Cell-wrapped Default<T,V>.
 */
type IsDefaultField<T> = IsAny<T> extends true ? false
  : HasDefaultBrand<NonNullable<T>> extends true ? true
  : NonNullable<T> extends AnyBrandedCell<infer U>
    ? IsAny<U> extends true ? false
    : HasDefaultBrand<U> extends true ? true
    : false
  : false;

/** Removes the DEFAULT_MARKER branded member from a `Default<T, V>` union, leaving plain `T`. */
export type StripDefaultBrand<T> = Exclude<
  T,
  { readonly [DEFAULT_MARKER]: any }
>;

type RemoveRedundantUnionMembers<T, All = T> = T extends any
  ? [Exclude<All, T>] extends [never] ? T
  : T extends Exclude<All, T> ? never
  : T
  : never;

type StripDefaultUnion<T> = RemoveRedundantUnionMembers<StripDefaultBrand<T>>;

/**
 * Cell-aware default stripping for pattern input normalization. The public
 * StripDefaultBrand<T> intentionally stays shallow because it is used by cell
 * interfaces in variance-sensitive positions.
 */
type StripDefaultField<T> = IsAny<T> extends true ? T
  : StripDefaultFieldInner<StripDefaultUnion<T>>;

type StripDefaultFieldInner<T> = T extends Cell<infer U>
  ? Cell<StripDefaultUnion<U>>
  : T extends OpaqueCell<infer U> ? OpaqueCell<StripDefaultUnion<U>>
  : T extends Stream<infer U> ? Stream<StripDefaultUnion<U>>
  : T extends ComparableCell<infer U> ? ComparableCell<StripDefaultUnion<U>>
  : T extends ReadonlyCell<infer U> ? ReadonlyCell<StripDefaultUnion<U>>
  : T extends WriteonlyCell<infer U> ? WriteonlyCell<StripDefaultUnion<U>>
  : T extends AnyCell<infer U> ? AnyCell<StripDefaultUnion<U>>
  : T extends AnyBrandedCell<infer U, infer Kind>
    ? AnyBrandedCell<StripDefaultUnion<U>, Kind>
  : T;

/**
 * Maps a type T so that any fields carrying the DEFAULT_MARKER brand become required
 * (removing `?`) and have their brand stripped, while all other fields are left
 * unchanged — including preservation of their optional modifier `?`.
 *
 * Implementation note: uses an intersection of two mapped types:
 * 1. A homomorphic map (so TypeScript can infer `T` from the result) that strips
 *    Default brands and preserves the original optional modifier for every key.
 * 2. A `-?` refinement that makes only the Default-branded keys required.
 * TypeScript infers `T` from the homomorphic first part; the second part is then
 * evaluated with the resolved `T` to enforce requiredness on Default fields.
 */
export type RequireDefaults<T> =
  // Homomorphic: strip Default brands, preserve `?` for every key (TypeScript can infer T from this)
  // Use `true extends IsDefaultField<T[K]>` (reversed) rather than `IsDefaultField<T[K]> extends true`
  // because IsDefaultField can return `boolean` (= `true | false`) when T[K] is a union like
  // `Default<X,V> | undefined`. In a non-distributive conditional context, `boolean extends true`
  // is `false`, but `true extends boolean` is `true` — correctly triggering the true branch.
  & {
    [K in keyof T]: true extends IsDefaultField<T[K]> ? StripDefaultField<T[K]>
      : T[K];
  }
  // Refinement: remove `?` from keys that carry the Default brand.
  // Use Exclude<T[K], undefined> to strip the `| undefined` that TypeScript
  // adds for optional fields (T[K] of `a?: X` includes `X | undefined`).
  // Without this, the required field's value type would still include
  // `| undefined`, which propagates through Reactive and makes the field
  // possibly-undefined in the pattern body despite being required.
  & {
    [K in keyof T as true extends IsDefaultField<T[K]> ? K : never]-?:
      StripDefaultField<Exclude<T[K], undefined>>;
  };

// Internal-only way to instantiate internal modules
export type ByRefFunction = <T, R>(ref: string) => ModuleFactory<T, R>;

// Internal-only helper to create VDOM nodes
export type HFunction = {
  // Overload for string element names - returns VNode
  (
    name: string,
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
  ): VNode;
  // Overload for function components - returns whatever the component returns
  <R extends JSXElement>(
    name: (props: any) => R,
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
  ): R;
  // Union overload for when type is not narrowed (used by jsx-runtime)
  (
    name: string | ((props: any) => JSXElement),
    props: { [key: string]: any } | null,
    ...children: RenderNode[]
  ): JSXElement;
  fragment({ children }: { children: RenderNode[] }): VNode;
};

// No-op alternative to `as const as JSONSchema`
export type SchemaFunction = <T extends JSONSchema>(schema: T) => T;

// toSchema is a compile-time transformer that converts TypeScript types to JSONSchema
// The actual implementation is done by the TypeScript transformer
export type ToSchemaFunction = <T>(options?: Partial<JSONSchema>) => JSONSchema;
/** Internal compiler-emitted helper for top-level data materialization. */
export type CfDataFunction = <T>(value: T) => T;

// Pattern environment types
export interface PatternEnvironment {
  readonly apiUrl: URL;
}

export type GetPatternEnvironmentFunction = () => PatternEnvironment;
export type ToCompactDebugStringFunction = (
  value: unknown,
  maxLength?: number,
) => string;
export type ToIndentedDebugStringFunction = (value: unknown) => string;

/**
 * Compare two cells or values for equality after resolving, i.e. after
 * following all links in case we have cells pointing to other cells.
 * This is a standalone export of the equals function from Cell/Writable.
 */
export type EqualsFunction = (
  a: AnyCell<any> | object | undefined,
  b: AnyCell<any> | object | undefined,
) => boolean;

/**
 * Multi-user pattern test descriptor (`cf test`). Export it as the test
 * file's default export to run each participant pattern in its own isolated
 * runtime (own identity) against one shared space. The optional `setup`
 * pattern instantiates shared state once; each participant pattern receives
 * its result as the `setup` input. Participants coordinate through
 * `{ label: "name" }` / `{ await: "name" }` entries in their `tests` arrays.
 * Use `{ pattern, user: "other" }` to run a second session of an existing
 * user's identity.
 */
export interface MultiUserTestDescriptor {
  setup?: (...args: never[]) => unknown;
  participants: Record<
    string,
    | ((...args: never[]) => unknown)
    | { pattern: (...args: never[]) => unknown; user?: string }
  >;
}

// Re-export all function types as values for destructuring imports
// These will be implemented by the factory
export declare const pattern: PatternFunction;
export declare const patternTool: PatternToolFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const action: ActionFunction;
export declare const computed: ComputedFunction;
export declare const assert: AssertFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const when: WhenFunction;
export declare const unless: UnlessFunction;
export declare const uiVariant: UIVariantFunction;
/** @deprecated Use generateText() or generateObject() instead */
export declare const llm: LLMFunction;
export declare const llmDialog: LLMDialogFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const generateText: GenerateTextFunction;
export declare const fetchBinary: FetchBinaryFunction;
export declare const fetchText: FetchTextFunction;
export declare const fetchJson: FetchJsonFunction;
export declare const fetchJsonUnchecked: FetchJsonUncheckedFunction;
export declare const fetchProgram: FetchProgramFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const sqliteDatabase: SqliteDatabaseFunction;
export declare const sqliteQuery: SqliteQueryFunction;
export declare const table: SqliteTableFunction;
export declare const cfLink: SqliteCfLinkFunction;
export declare const cfSqlite: CfSqliteHelpers;
export declare const navigateTo: NavigateToFunction;
export declare const inspectConfLabel: InspectConfLabelFunction;
export declare const wish: WishFunction;
/**
 * Tag a multi-user test descriptor for `cf test` (identity at runtime; a
 * call expression keeps the descriptor's pattern factories out of the
 * plain-data hardening that module-level data literals receive).
 */
export declare const multiUserTest: <T extends MultiUserTestDescriptor>(
  descriptor: T,
) => T;
export declare const createNodeFactory: CreateNodeFactoryFunction;
/** @deprecated Use Cell.of(defaultValue?) instead */
export declare const cell: CellTypeConstructor<AsCell>["of"];
export declare const equals: EqualsFunction;
export declare const byRef: ByRefFunction;
export function getPatternEnvironment(): PatternEnvironment {
  const location = globalThis.location;
  const apiUrl = location
    ? new URL(new URL(location.href).origin)
    : new URL("http://localhost:8000");
  return Object.freeze({ apiUrl });
}
export declare const toCompactDebugString: ToCompactDebugStringFunction;
export declare const toIndentedDebugString: ToIndentedDebugStringFunction;

export interface UiActionProps {
  readonly as?: string;
  readonly action: string;
  readonly children?: RenderNode;
}

export interface UiPromptSlotProps {
  readonly as?: string;
  readonly surface: string;
  readonly role: string;
  readonly children?: RenderNode;
}

export interface UiDisclosureProps {
  readonly as?: string;
  readonly kind: string;
  readonly children?: RenderNode;
}

export declare function UiAction(props: UiActionProps): JSXElement;
export declare function UiPromptSlot(props: UiPromptSlotProps): JSXElement;
export declare function UiDisclosure(props: UiDisclosureProps): JSXElement;

/**
 * Get the entity ID from a cell or value, or undefined if it has none. The
 * concrete reference form is dispatched on the "modern cell representation"
 * flag: a `{ "/": "id-string" }` object with the flag off, a `FabricHash` with
 * it on. Useful for extracting IDs from newly created pieces for linking.
 */
export type GetEntityIdFunction = (
  value: any,
) => { "/": string } | FabricHash | undefined;
export declare const getEntityId: GetEntityIdFunction;

/**
 * Convert an entity-id reference — as produced by {@link getEntityId} or a
 * cell's `entityId` — to its tagged-hash string, in whichever form the active
 * cell representation uses (a `{ "/": "id-string" }` object or a `FabricHash`).
 */
export type EntityRefToStringFunction = (
  value: { "/": string } | FabricHash,
) => string;
export declare const entityRefToString: EntityRefToStringFunction;

export declare const schema: SchemaFunction;
export declare const toSchema: ToSchemaFunction;
export declare const __cf_data: CfDataFunction;
export declare const __cfHelpers: any;
export declare namespace __cfHelpers {
  export type JSONSchema = JSONSchemaObj | boolean;
}

/**
 * Dynamic properties. Can either be string type (static) or a Mustache
 * variable (dynamic).
 */
export type Props = {
  [key: string]:
    | string
    | number
    | boolean
    | object
    | Array<any>
    | null
    | undefined
    | Cell<any>
    | Stream<any>;
};

/** A child in a view can be one of a few things */
export type RenderNode =
  | InnerRenderNode
  | JSXElement
  | AnyBrandedCell<
    InnerRenderNode | UIRenderable | JSXElement | null | undefined
  >
  | Array<RenderNode>;

type InnerRenderNode =
  | VNode
  | string
  | number
  | boolean
  | undefined
  | null;

/** An object that can be rendered via its [UI] property */
export type UIRenderable = {
  [UI]: VNode;
};

/**
 * JSX element type - the result of a JSX expression.
 * Can be a VNode, or a cell containing something with a [UI] property.
 */
export type JSXElement =
  | VNode
  | AnyBrandedCell<UIRenderable>
  | Reactive<UIRenderable>;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props | undefined;
  children?: RenderNode | undefined;
  [UI]?: VNode;
};

/**
 * Filesystem projection for a pattern result. Used with the [FS] symbol.
 *
 * - `type: "text/markdown"` — render as `index.md` with YAML frontmatter +
 *   markdown body. Primitive frontmatter fields go into YAML; complex values
 *   (arrays of entities, nested objects) become sibling directories.
 * - `type: "application/json"` — render as `index.json` with `content`.
 * - Plain object (no `type` field) — shorthand: the object itself becomes the
 *   content of `index.json`.
 */
export type FsProjection =
  | {
    type: "text/markdown";
    frontmatter?: Record<string, unknown>;
    content: string;
  }
  | {
    type: "application/json";
    content: Record<string, unknown>;
  }
  | { type?: undefined; [key: string]: unknown };
