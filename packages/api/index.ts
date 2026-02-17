/**
 * Public interface for the builder package. This module exports only the types
 * and functions that are part of the public recipe API.
 *
 * Workspace code should import these types via `@commontools/builder`.
 */

// Runtime constants - defined by @commontools/runner/src/builder/types.ts
// These are ambient declarations since the actual values are provided by the runtime environment
export declare const ID: unique symbol;
export declare const ID_FIELD: unique symbol;

// Should be Symbol("UI") or so, but this makes repeat() use these when
// iterating over recipes.
export declare const TYPE: "$TYPE";
export declare const NAME: "$NAME";
export declare const UI: "$UI";

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
 * This property doesn't exist at runtime - it's purely for TypeScript's benefit.
 * See packages/api/STRIPCELL_TYPE_INFERENCE_FIX.md for details.
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
  | "writeonly";

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

/*
 * IAnyCell is an interface that is used by all calls and to which the runner
 * attaches the internal methods..
 */
// deno-lint-ignore no-empty-interface
export interface IAnyCell<T> {
}

/**
 * Readable cells can retrieve their current value.
 */
export interface IReadable<T> {
  get(options?: { traverseCells?: boolean }): Readonly<T>;
  /**
   * Read the cell's current value without creating a reactive dependency.
   * Unlike `get()`, calling `sample()` inside a lift won't cause the lift
   * to re-run when this cell's value changes.
   */
  sample(): Readonly<T>;
}

/**
 * Writable cells can update their value.
 */
export interface IWritable<T, C extends AnyBrandedCell<any>> {
  set(value: T | AnyCellWrapping<T>): C;
  update<V extends (Partial<T> | AnyCellWrapping<Partial<T>>)>(
    this: IsThisObject,
    values: V extends object ? AnyCellWrapping<V> : never,
  ): C;
  push(
    this: IsThisArray,
    ...value: T extends (infer U)[] ? (U | AnyCellWrapping<U>)[] : never
  ): void;
  remove(
    this: IsThisArray,
    ref: T extends (infer U)[] ? (U | AnyBrandedCell<U>) : never,
  ): void;
  removeAll(
    this: IsThisArray,
    ref: T extends (infer U)[] ? (U | AnyBrandedCell<U>) : never,
  ): void;
}

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
 *
 * Note: And for now it always returns an OpaqueRef<>, until we clean this up.
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
   * @param cause - The cause to associate with this cell
   * @returns This cell for method chaining
   */
  for(cause: unknown): C;
}

/**
 * Cells that can be resolved back to a Cell.
 * Only available on full Cell<T>, not on OpaqueCell or Stream.
 * Note: Schema-typed overload available via "commontools/schema"
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
  equals(other: AnyCell<any> | object): boolean;
  equalLinks(other: AnyCell<any> | object): boolean;
}

/**
 * Cells that allow deriving new cells from existing cells. Currently just
 * .map(), but this will eventually include all Array, String and Number
 * methods.
 */
export interface IDerivable<T> {
  map<S>(
    this: IsThisObject,
    fn: (
      element: T extends Array<infer U> ? OpaqueRef<U> : OpaqueRef<T>,
      index: OpaqueRef<number>,
      array: OpaqueRef<T>,
    ) => Opaque<S>,
  ): OpaqueRef<S[]>;
  mapWithPattern<S>(
    this: IsThisObject,
    op: RecipeFactory<T extends Array<infer U> ? U : T, S>,
    params: Record<string, any>,
  ): OpaqueRef<S[]>;
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
   * Create a cell with a cause.
   *
   * Can be chained with .of() or .set():
   *
   * const foo = Cell.for(cause).set(value); // sets cell to latest value
   * const bar = Cell.for(cause).of(value); // sets cell to initial value
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
   * Compare two cells or values for equality after resolving, i.e. after
   * following all links in case we have cells pointing to other cells.
   * @param a - First cell or value to compare
   * @param b - Second cell or value to compare
   * @returns true if the values are equal
   */
  equals(a: AnyCell<any> | object, b: AnyCell<any> | object): boolean;

  /**
   * Compare two cells or values for equality by comparing their underlying
   * links. No resolving.
   *
   * @param a - First cell or value to compare
   * @param b - Second cell or value to compare
   * @returns true if the values are equal
   */
  equalLinks(a: AnyCell<any> | object, b: AnyCell<any> | object): boolean;
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
// OpaqueRef - Proxy-based variant of OpaqueCell
// ============================================================================

/**
 * OpaqueRef is a variant of OpaqueCell with recursive proxy behavior.
 * Each key access returns another OpaqueRef, allowing chained property access.
 * This is temporary until AST transformation handles .key() automatically.
 *
 * OpaqueRef<Cell<T>> unwraps to Cell<T>.
 */
export type OpaqueRef<T> =
  // Already a branded cell? Return as-is
  [T] extends [AnyBrandedCell<any>] ? T
    // Branded cell | undefined? Strip undefined to avoid brand collision
    // in the OpaqueCell<T> & OpaqueRefInner<T> intersection below.
    // The proxy never returns undefined at runtime, so this is safe.
    : [NonNullable<T>] extends [AnyBrandedCell<any>]
      ? [NonNullable<T>] extends [never] ? OpaqueCell<T> & OpaqueRefInner<T>
      : NonNullable<T>
    // Everything else: wrap in OpaqueCell + map inner properties
    :
      & OpaqueCell<T>
      & OpaqueRefInner<T>;

// Helper type for OpaqueRef's inner property/array mapping
// Handles nullable types by extracting the non-null part for mapping
type OpaqueRefInner<T> = [T] extends
  [ArrayBuffer | ArrayBufferView | URL | Date] ? T
  : [T] extends [Array<infer U>] ? Array<OpaqueRef<U>>
  : [T] extends [AnyBrandedCell<any>] ? T
  : [T] extends [object] ? { [K in keyof T]: OpaqueRef<T[K]> }
  // For nullable types (T | null | undefined), extract and map the non-null part
  : [NonNullable<T>] extends [never] ? T
  // Handle nullable branded cells (e.g., (OpaqueRef<X> | undefined) from .find() on proxy arrays)
  // Use NonNullable<T> instead of T to avoid leaking null/undefined into the
  // OpaqueCell<T> & OpaqueRefInner<T> intersection, where TypeScript's
  // intersection simplification would erase them (object & undefined = never).
  : [NonNullable<T>] extends [AnyBrandedCell<any>] ? NonNullable<T>
  : [NonNullable<T>] extends [Array<infer U>] ? Array<OpaqueRef<U>>
  : [NonNullable<T>] extends [object]
    ? { [K in keyof NonNullable<T>]: OpaqueRef<NonNullable<T>[K]> }
  : T;

// ============================================================================
// CellLike and Opaque - Utility types for accepting cells
// ============================================================================

/**
 * CellLike is a cell (AnyCell) whose nested values are Opaque.
 * The top level must be AnyCell, but nested values can be plain or wrapped.
 *
 * Note: This is primarily used for type constraints that require a cell.
 */
export type CellLike<T> = AnyBrandedCell<MaybeCellWrapped<T>> & {
  [CELL_LIKE]?: unknown;
};
type MaybeCellWrapped<T> =
  | T
  | AnyBrandedCell<T>
  | (T extends Array<infer U> ? Array<MaybeCellWrapped<U>>
    : T extends object ? { [K in keyof T]: MaybeCellWrapped<T[K]> }
    : never);
export declare const CELL_LIKE: unique symbol;

/**
 * Helper type to transform Cell<T> to Opaque<T> in pattern/lift/handler inputs.
 * Preserves Stream<T> since Streams are callable interfaces (.send()), not data containers.
 *
 * Implementation is non-distributive by default to preserve union types like RenderNode
 * that intentionally contain AnyBrandedCell as a data variant. However, for optional cell
 * properties like `title?: Writable<string>` (which expand to `Writable<string> | undefined`),
 * we extract the cell parts, strip them, and recombine with the non-cell parts.
 *
 * See packages/api/STRIPCELL_TYPE_INFERENCE_FIX.md for details.
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
 * Opaque accepts T or any cell wrapping T, recursively at any nesting level.
 * Used in APIs that accept inputs from developers - can be static values
 * or wrapped in cells (OpaqueRef, Cell, etc).
 *
 * Conceptually: T | AnyCell<T> at any nesting level, but we use OpaqueRef
 * for backward compatibility since it has the recursive proxy behavior that
 * allows property access (e.g., Opaque<{foo: string}> includes {foo: Opaque<string>}).
 *
 * Special cases for JSX:
 * - Opaque<VNode> also accepts JSXElement
 * - Opaque<UIRenderable> also accepts JSXElement (for .map() callbacks returning JSX)
 */
export type Opaque<T> =
  | T
  // We have to list them explicitly so Typescript can unwrap them. Doesn't seem
  // to work if we just say AnyBrandedCell<T>
  | OpaqueRef<T>
  | AnyCell<T>
  | AnyBrandedCell<T>
  | OpaqueCell<T>
  | Cell<T>
  | Stream<T>
  | ComparableCell<T>
  | ReadonlyCell<T>
  | WriteonlyCell<T>
  // Special case: When T is VNode or UIRenderable (even with null/undefined),
  // also accept JSXElement. Use NonNullable to handle VNode | undefined.
  // Combined into single check to reduce type instantiation overhead.
  | ([NonNullable<T>] extends [VNode | UIRenderable] ? JSXElement : never)
  | (T extends Array<infer U> ? Array<Opaque<U>>
    : T extends object ? { [K in keyof T]: Opaque<T[K]> }
    : T);

/**
 * Helper type to extract the innermost Cell type from any number of OpaqueRef wrappers.
 * UnwrapOpaqueRefLayers<Cell<T>> = Cell<T>
 * UnwrapOpaqueRefLayers<OpaqueRef<Cell<T>>> = Cell<T>
 * UnwrapOpaqueRefLayers<OpaqueRef<OpaqueRef<Cell<T>>>> = Cell<T>
 *
 * Support for nested OpaqueRef layers is limited to 4 levels.
 */
type UnwrapOpaqueRefLayers4<T> = T extends OpaqueRef<infer U>
  ? UnwrapOpaqueRefLayers3<U>
  : T;

type UnwrapOpaqueRefLayers3<T> = T extends OpaqueRef<infer U>
  ? UnwrapOpaqueRefLayers2<U>
  : T;

type UnwrapOpaqueRefLayers2<T> = T extends OpaqueRef<infer U>
  ? UnwrapOpaqueRefLayers1<U>
  : T;

type UnwrapOpaqueRefLayers1<T> = T extends OpaqueRef<infer U> ? U
  : T;

/**
 * Matches any non-opaque Cell type (Cell, Stream, ComparableCell, etc.) that may be
 * wrapped in any number of OpaqueRef layers. Excludes OpaqueCell and AnyCell (since OpaqueCell extends AnyCell).
 */
type AnyCellWrappedInOpaqueRef<T> = UnwrapOpaqueRefLayers4<T> extends
  BrandedCell<any, "cell"> ? UnwrapOpaqueRefLayers4<T>
  : never;

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
export interface Recipe {
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
}
export interface Module {
  type: "ref" | "javascript" | "recipe" | "raw" | "isolated" | "passthrough";
}

export type toJSON = {
  toJSON(): unknown;
};

export type Handler<T = any, R = any> = Module & {
  with: (inputs: Opaque<StripCell<T>>) => Stream<R>;
};

export type NodeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & (Module | Handler | Recipe)
  & toJSON;

export type RecipeFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Recipe
  & toJSON;

export type ModuleFactory<T, R> =
  & ((inputs: Opaque<T>) => OpaqueRef<R>)
  & Module
  & toJSON;

export type HandlerFactory<T, R> =
  & ((inputs: Opaque<StripCell<T>>) => Stream<R>)
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

// Valid values for the "type" property of a JSONSchema
export type JSONSchemaTypes =
  | "object"
  | "array"
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "null";

// See https://json-schema.org/draft/2020-12/json-schema-core
// See https://json-schema.org/draft/2020-12/json-schema-validation
// There is a lot of potential validation that is not handled, but this object
// is defined to support them, so that generated schemas will still be usable.
// TODO(@ubik2) When specifying a JSONSchema, you can often use a boolean
// This is particularly useful for specifying the schema of a property.
// That will require reworking some things, so for now, I'm not doing it
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
  readonly items?: Readonly<JSONSchema>;
  readonly contains?: JSONSchema; // not validated
  // Subschema for object
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly patternProperties?: Readonly<Record<string, JSONSchema>>; // not validated
  readonly additionalProperties?: JSONSchema;
  readonly propertyNames?: JSONSchema; // not validated

  // Validation for any
  readonly type?: JSONSchemaTypes | readonly JSONSchemaTypes[];
  readonly enum?: readonly Readonly<JSONValue>[]; // not validated
  readonly const?: Readonly<JSONValue>; // not validated
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
  readonly default?: Readonly<JSONValue>;
  readonly readOnly?: boolean;
  readonly writeOnly?: boolean;
  readonly examples?: readonly Readonly<JSONValue>[];
  readonly $schema?: string;
  readonly $comment?: string;

  // Common Tools extensions
  readonly [ID]?: unknown;
  readonly [ID_FIELD]?: unknown;
  // makes it so that your handler gets a Cell object for that property. So you can call .set()/.update()/.push()/etc on it.
  readonly asCell?: boolean;
  // marks values that are OpaqueRef - tracked reactive references
  readonly asOpaque?: boolean;
  // streams are what handler returns. if you pass that to another handler/lift and declare it as asSteam, you can call .send on it
  readonly asStream?: boolean;
  // temporarily used to assign labels like "confidential"
  readonly ifc?: { classification?: string[]; integrity?: string[] };
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
    | { pattern: Recipe; handler?: never; extraParams?: Record<string, any> }
    | { handler: Stream<any> | OpaqueRef<any>; pattern?: never }
  );

// Built-in types
export interface BuiltInLLMParams {
  messages?: BuiltInLLMMessage[];
  model?: string;
  system?: string;
  stop?: string;
  maxTokens?: number;
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
   * Context cells to make available to the LLM.
   * These cells appear in the system prompt with their schemas and current values.
   */
  context?: Record<string, AnyCell<any>>;
}

export interface BuiltInLLMState {
  pending: boolean;
  result?: BuiltInLLMContent;
  partial?: string;
  error?: unknown;
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMGenerateObjectState<T> {
  pending: boolean;
  result?: T;
  partial?: string;
  error?: unknown;
  messages?: BuiltInLLMMessage[];
  cancelGeneration: Stream<void>;
}

export interface BuiltInLLMDialogState {
  pending: boolean;
  error?: unknown;
  cancelGeneration: Stream<void>;
  addMessage: Stream<BuiltInLLMMessage>;
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
    metadata?: Record<string, string | undefined | object>;
    tools?: Record<string, BuiltInLLMTool>;
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
    metadata?: Record<string, string | undefined | object>;
    tools?: Record<string, BuiltInLLMTool>;
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
  }
  | {
    prompt?: never;
    messages: BuiltInLLMMessage[];
    context?: Record<string, any>;
    system?: string;
    model?: string;
    maxTokens?: number;
    tools?: Record<string, BuiltInLLMTool>;
  };

export interface BuiltInGenerateTextState {
  pending: boolean;
  result?: string;
  error?: unknown;
  partial?: string;
  requestHash?: string;
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
export interface PatternFunction {
  // Primary overload: T and R inferred from function
  <T, R>(
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;

  // Single type param overload: T explicit, R inferred
  // SELF is typed as `never` - using it will produce a type error
  // Use pattern<T, R>() with both type params for typed SELF access
  <T>(
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: never }) => any,
  ): RecipeFactory<StripCell<T>, any>;
}

/** @deprecated Use pattern() instead */
export interface RecipeFunction {
  // Function-only overload
  <T, R>(
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;

  <T>(
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<any> }) => any,
  ): RecipeFactory<StripCell<T>, StripCell<ReturnType<typeof fn>>>;

  <T>(
    argumentSchema: string | JSONSchema,
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<any> }) => any,
  ): RecipeFactory<StripCell<T>, StripCell<ReturnType<typeof fn>>>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    fn: (
      input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> },
    ) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;

  <T, R>(
    argumentSchema: string | JSONSchema,
    resultSchema: JSONSchema,
    fn: (
      input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> },
    ) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;
}

/**
 * Result of patternTool() - an LLM tool definition with a pattern and optional pre-filled params.
 * This is the actual runtime return type, not a cast.
 */
export interface PatternToolResult<E = Record<PropertyKey, never>> {
  pattern: Recipe;
  extraParams: E;
}

export type PatternToolFunction = <
  T,
  E extends object = Record<PropertyKey, never>,
>(
  fnOrRecipe: ((input: OpaqueRef<Required<T>>) => any) | RecipeFactory<T, any>,
  // Validate that E (after stripping cells) is a subset of T
  extraParams?: StripCell<E> extends Partial<T> ? Opaque<E> : never,
) => PatternToolResult<E>;

export interface LiftFunction {
  <T, R>(
    implementation: (input: T) => R,
  ): ModuleFactory<StripCell<T>, StripCell<R>>;

  <T>(
    implementation: (input: T) => any,
  ): ModuleFactory<StripCell<T>, StripCell<ReturnType<typeof implementation>>>;

  <T extends (...args: any[]) => any>(
    implementation: T,
  ): ModuleFactory<StripCell<Parameters<T>[0]>, StripCell<ReturnType<T>>>;

  <T, R>(
    argumentSchema?: JSONSchema,
    resultSchema?: JSONSchema,
    implementation?: (input: T) => R,
  ): ModuleFactory<StripCell<T>, StripCell<R>>;
}

// Helper type to make non-Cell and non-Stream properties readonly in handler state
export type HandlerState<T> = T extends Cell<any> ? T
  : T extends Stream<any> ? T
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
 * This is to handler as computed is to lift/derive:
 * - User writes: action((e) => count.set(e.data))
 * - Transformer rewrites to: handler((e, { count }) => count.set(e.data))({ count })
 *
 * The transformer extracts closures and makes them explicit, just like how
 * computed(() => expr) becomes derive({}, () => expr) with closure extraction.
 */
export type ActionFunction = {
  // Overload 1: Zero-parameter callback returns Stream<void>
  (fn: () => void): Stream<void>;
  // Overload 2: Parameterized callback returns Stream<T>
  <T>(fn: (event: T) => void): Stream<T>;
};

/**
 * DeriveFunction creates a reactive computation that transforms input values.
 *
 * Special overload ordering is critical for correct type inference:
 *
 * 1. Boolean literal overload: Widens `OpaqueRef<true> | OpaqueRef<false>` to `boolean`
 *    - Required because TypeScript infers boolean cells as a union of literal types
 *    - Without this, the callback would get `true | false` instead of `boolean`
 * 2. Cell preservation overload: Keeps Cell types wrapped consistently
 *    - Prevents unwrapping of Cell<T> to T, maintaining consistent behavior
 *    - Whether Cell is passed directly or nested in objects, it stays wrapped
 *    - Example: derive(cell<number>(), (c) => ...) gives c: Cell<number>, not number
 * 3. Generic overload: Handles all other cases, unwrapping Opaque types
 *
 * Note: Schema-based overload is available when importing from "commontools/schema"
 *
 * @deprecated Use compute() instead
 */
export interface DeriveFunction {
  // Overload 1: Boolean literal union -> boolean
  // Fixes: cell<boolean>() returns OpaqueRef<true> | OpaqueRef<false>
  // Without this, callback gets (input: true | false) instead of (input: boolean)
  <In extends boolean, Out>(
    input: OpaqueRef<true> | OpaqueRef<false>,
    f: (input: In) => Out,
  ): OpaqueRef<Out>;

  // Overload 2: Preserve Cell types - unwrap OpaqueRef layers but keep Cell
  // Ensures consistent behavior: Cell<T> stays Cell<T> whether passed directly or in objects
  // Handles: Cell<T>, OpaqueRef<Cell<T>>, OpaqueRef<OpaqueRef<Cell<T>>>, etc.
  <In, Out>(
    input: AnyCellWrappedInOpaqueRef<In>,
    f: (input: In) => Out,
  ): OpaqueRef<Out>;

  // Overload 3: Generic fallback - unwraps all Opaque types
  <In, Out>(
    input: Opaque<In>,
    f: (input: In) => Out,
  ): OpaqueRef<Out>;
}

export type ComputedFunction = <T>(fn: () => T) => OpaqueRef<T>;

export type StrFunction = (
  strings: TemplateStringsArray,
  ...values: any[]
) => OpaqueRef<string>;

export type IfElseFunction = <T = any, U = any, V = any>(
  condition: Opaque<T>,
  ifTrue: Opaque<U>,
  ifFalse: Opaque<V>,
) => OpaqueRef<U | V>;

export type WhenFunction = <T = any, U = any>(
  condition: Opaque<T>,
  value: Opaque<U>,
) => OpaqueRef<T | U>;

export type UnlessFunction = <T = any, U = any>(
  condition: Opaque<T>,
  fallback: Opaque<U>,
) => OpaqueRef<T | U>;

/** @deprecated Use generateText() or generateObject() instead */
export type LLMFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMState>;

export type LLMDialogFunction = (
  params: Opaque<BuiltInLLMParams>,
) => OpaqueRef<BuiltInLLMDialogState>;

export type GenerateObjectFunction = <T = any>(
  params: Opaque<BuiltInGenerateObjectParams>,
) => OpaqueRef<BuiltInLLMGenerateObjectState<T>>;

export type GenerateTextFunction = (
  params: Opaque<BuiltInGenerateTextParams>,
) => OpaqueRef<BuiltInGenerateTextState>;

export type FetchOptions = {
  body?: JSONValue;
  headers?: Record<string, string>;
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
export type FetchDataFunction = <T>(
  params: Opaque<{
    url: string;
    mode?: "json" | "text";
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error?: any }>;

export type FetchProgramFunction = (
  params: Opaque<{ url: string }>,
) => OpaqueRef<{
  pending: boolean;
  result: {
    files: Array<{ name: string; contents: string }>;
    main: string;
  } | undefined;
  error?: any;
}>;

export type StreamDataFunction = <T>(
  params: Opaque<{
    url: string;
    options?: FetchOptions;
    result?: T;
  }>,
) => OpaqueRef<{ pending: boolean; result: T; error?: any }>;

export type CompileAndRunFunction = <T = any, S = any>(
  params: Opaque<BuiltInCompileAndRunParams<T>>,
) => OpaqueRef<BuiltInCompileAndRunState<S>>;

export type WishTag = `/${string}` | `#${string}`;

export type DID = `did:${string}:${string}`;

export type WishParams = {
  query: WishTag | string;
  path?: string[];
  context?: Record<string, any>;
  schema?: JSONSchema;
  /**
   * Search scope for hashtag queries: "~" = favorites (home), "." = mentionables (current space).
   * Default (undefined) = favorites only for backward compatibility.
   */
  scope?: (DID | "~" | ".")[];
};

export type WishState<T> = {
  // A failed wish should have result of undefined and candidates of []
  result: T | undefined;
  candidates: T[];
  error?: any;
  [UI]?: VNode;
};

export type NavigateToFunction = (cell: OpaqueRef<any>) => OpaqueRef<boolean>;
export interface WishFunction {
  <T = unknown>(target: Opaque<WishParams>): OpaqueRef<WishState<T>>;
}

export type CreateNodeFactoryFunction = <T = any, R = any>(
  moduleSpec: Module,
) => ModuleFactory<T, R>;

// Default type for specifying default values in type definitions
export type Default<T, V extends T = T> = T;

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

// Recipe environment types
export interface RecipeEnvironment {
  readonly apiUrl: URL;
}

export type GetRecipeEnvironmentFunction = () => RecipeEnvironment;

/**
 * Compare two cells or values for equality after resolving, i.e. after
 * following all links in case we have cells pointing to other cells.
 * This is a standalone export of the equals function from Cell/Writable.
 */
export type EqualsFunction = (
  a: AnyCell<any> | object,
  b: AnyCell<any> | object,
) => boolean;

// Re-export all function types as values for destructuring imports
// These will be implemented by the factory
export declare const pattern: PatternFunction;
/** @deprecated Use pattern() instead */
export declare const recipe: RecipeFunction;
export declare const patternTool: PatternToolFunction;
export declare const lift: LiftFunction;
export declare const handler: HandlerFunction;
export declare const action: ActionFunction;
/** @deprecated Use compute() instead */
export declare const derive: DeriveFunction;
export declare const computed: ComputedFunction;
export declare const str: StrFunction;
export declare const ifElse: IfElseFunction;
export declare const when: WhenFunction;
export declare const unless: UnlessFunction;
/** @deprecated Use generateText() or generateObject() instead */
export declare const llm: LLMFunction;
export declare const llmDialog: LLMDialogFunction;
export declare const generateObject: GenerateObjectFunction;
export declare const generateText: GenerateTextFunction;
export declare const fetchData: FetchDataFunction;
export declare const fetchProgram: FetchProgramFunction;
export declare const streamData: StreamDataFunction;
export declare const compileAndRun: CompileAndRunFunction;
export declare const navigateTo: NavigateToFunction;
export declare const wish: WishFunction;
export declare const createNodeFactory: CreateNodeFactoryFunction;
/** @deprecated Use Cell.of(defaultValue?) instead */
export declare const cell: CellTypeConstructor<AsCell>["of"];
export declare const equals: EqualsFunction;
export declare const byRef: ByRefFunction;
export declare const getRecipeEnvironment: GetRecipeEnvironmentFunction;

/**
 * Get the entity ID from a cell or value.
 * Returns { "/": "id-string" } format if the value has an entity ID, undefined otherwise.
 * Useful for extracting IDs from newly created charms for linking.
 */
export type GetEntityIdFunction = (value: any) => { "/": string } | undefined;
export declare const getEntityId: GetEntityIdFunction;

export declare const schema: SchemaFunction;
export declare const toSchema: ToSchemaFunction;

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
  | OpaqueRef<UIRenderable>;

/** A "virtual view node", e.g. a virtual DOM element */
export type VNode = {
  type: "vnode";
  name: string;
  props: Props;
  children?: RenderNode;
  [UI]?: VNode;
};
