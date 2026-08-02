/**
 * Type predicates over the general shape of a value.
 *
 * The predicates here come in two kinds, and the difference is visible at the
 * call site. One kind tests an exact `typeof` class -- `isString()`,
 * `isNumber()`, `isFunction()` -- and says everything there is to say about the
 * value, so its `false` branch is exactly as trustworthy as its `true` branch.
 *
 * The other kind is *structural*: `isPlainObject()` and `isPlainContainer()`
 * here, and `isInertArray()`, `isArrayWithOnlyIndexProperties()`, and
 * `isInertPlainObject()` in the sibling `arrays` and `objects` modules. Each of
 * those checks strictly more than the type it narrows to can express, and
 * deliberately so: each narrows to the weakest type that stays true however the
 * value is treated afterwards, never to the property it actually checks. A
 * prototype can be reassigned and a property redefined, so "is `Object`-rooted"
 * or "is inert" describes an instant rather than a type, and a narrowed type
 * that claimed it would go on claiming it after it stopped being so.
 *
 * A structural predicate is therefore *one-directional*: its `false` branch
 * means "not established", not "the negation holds". TypeScript cannot be told
 * this, because narrowing a `false` branch is subtraction and the language has
 * no negated types. Left to itself it would subtract the narrowed type from the
 * declared one, so a caller already holding a type at least as specific as what
 * the predicate narrows to would find the `false` branch reduced to `never` --
 * a value the check rejected, for a reason the type system never recorded.
 *
 * Each structural predicate heads this off with a pair of overloads. A caller
 * who already knows the broad shape gets a plain `boolean`, keeping both
 * branches intact along with whatever element or property types it came in
 * with; a caller holding `unknown` or `object`, who has no such type to lose,
 * gets the narrowing. The first overload is also what keeps a `readonly`
 * declaration from being silently widened, since narrowing intersects and would
 * otherwise hand back a mutable view of a frozen value.
 */

/**
 * Predicate for narrowing a mutable string-keyed record type.
 * @param value - The value to check
 * @returns True if the value is a record object
 */
export function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A record whose string keys can be read but not assigned through this type. */
export type ReadonlyRecord = Readonly<Record<string, unknown>>;

/**
 * Predicate for narrowing a read-only record type, including frozen values.
 * @param value - The value to check
 * @returns True if the value is a record object
 */
export function isReadonlyRecord(value: unknown): value is ReadonlyRecord {
  return typeof value === "object" && value !== null;
}

/**
 * Predicate for narrowing a `function` type.
 * @param value - The value to check
 * @returns True if the value is a function
 */
export function isFunction(
  value: unknown,
): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

/**
 * Check whether the value is a non-`null`, non-plain, non-array `object`.
 * @param value - The value to check
 * @returns True if the value is an instance
 */
export function isInstance(value: unknown): boolean {
  if (!isObject(value)) return false;

  const proto = Object.getPrototypeOf(value);

  return (proto !== null) && (proto !== Object.prototype);
}

/**
 * Check whether a value is a non-array/non-null `object` type.
 * @param value - The value to check
 * @returns True if the value is an object (not array or null)
 */
export function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrowing for a non-array/non-null `object` type.
 * @param value - The value to check
 * @returns if the value is an object (not array or null) or throws if it is not
 */
export function assertIsObject(value: unknown): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "Assertion that value is a non-array/non-null object failed",
    );
  }
}

/**
 * Predicate for narrowing a `number` type.
 * @param value - The value to check
 * @returns True if the value is a number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/**
 * Check whether a value is a finite number type
 * @param value - The value to check
 * @returns True if the value is a finite number
 */
export function isFiniteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Check whether a value is a plain object: prototype `Object.prototype` or
 * `null`, with no constraint on its properties.
 *
 * This is the shape question -- "may I read this by property name?" -- and is
 * deliberately looser than what the data model admits as a record. For that,
 * see `isInertPlainObject()`, which requires a direct `Object` instance whose
 * every own property is an enumerable string-keyed data property. A
 * null-prototype object answers `true` here and `false` there, and both
 * answers are right for their own question.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; see the module header for what that means and why.
 * In particular, a `false` result says the value is not `Object`-rooted right
 * now, which is not the same as any statement about its type.
 *
 * @param value - The value to check
 * @returns True if the value is a plain object
 */
export function isPlainObject(value: ReadonlyRecord): boolean;
export function isPlainObject(value: unknown): value is ReadonlyRecord;
export function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Check whether a value is a plain container -- a plain object (per
 * `isPlainObject`) or an `Array`. Useful when the relevant question is
 * "can I do property-name / array-index member access on this?", since
 * plain objects and arrays are the two value shapes that support that
 * uniformly. Non-plain class instances (`Date`, `Map`, `Set`, `Error`,
 * user-defined classes, ...) deliberately do not qualify.
 *
 * This is a structural predicate, so it narrows in one direction only, and is
 * overloaded accordingly; see the module header. Unlike its neighbours it
 * narrows to a *mutable* pair of types, because its callers are the ones that
 * go on to write through the result.
 *
 * @param value - The value to check
 * @returns True if the value is a plain object or an array
 */
export function isPlainContainer(
  value: ReadonlyRecord | readonly unknown[],
): boolean;
export function isPlainContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[];
export function isPlainContainer(value: unknown): boolean {
  return Array.isArray(value) || isPlainObject(value);
}

/**
 * Predicate for narrowing a `string` type.
 * @param value - The value to check
 * @returns True if the value is a string
 */
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Predicate for narrowing a `boolean` type.
 * @param value - The value to check
 * @returns True if the value is a boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

/**
 * Helper type to recursively remove `readonly` properties from type `T`.
 */
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;

/**
 * Helper type to recursively add `readonly` properties to type `T`.
 */
export type Immutable<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<Immutable<U>>
  : T extends object ? ({ readonly [P in keyof T]: Immutable<T[P]> })
  : T;

/** Standard type meaning constructor function, a/k/a "class object." */
export type Constructor<T = unknown> = abstract new (...args: any[]) => T;

const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor"]);

/**
 * Indicates whether `key` must never be copied onto an object from untrusted
 * input, because assigning it can pollute the prototype chain. Use at boundaries
 * where external data enters the system (deserialization, structural copying).
 */
export function isUnsafeObjectKey(key: string): boolean {
  return UNSAFE_OBJECT_KEYS.has(key);
}

/**
 * Returns the reserved own property name the given object carries, if any.
 *
 * This asks about this implementation, not about the data model. A property
 * name is data like any other, and an implementation on a host that does not
 * route property assignment through a prototype chain -- which is most of them
 * -- would reserve no names at all. The two here are refused for two different
 * local reasons, and neither is a limit of the language:
 *
 * * `__proto__` cannot be rebuilt by the copying this system actually does.
 *   Records are reconstructed by assignment (`target[key] = value`) and
 *   `Object.assign()`, and for this name both reach `Object.prototype`'s
 *   accessor instead of creating a property: the value is dropped, and the
 *   copy's prototype is repointed as well when that value is an object or
 *   `null`. Faithful mechanisms do exist -- spread, `Object.fromEntries()`,
 *   `Object.defineProperty()`, and `JSON.parse()` all carry the name -- so
 *   what stands in the way is the copy loops, not JavaScript.
 * * `constructor` copies faithfully. It is reserved because other boundaries
 *   in this implementation already refuse it: the projection to native values
 *   drops it, and `FabricError` throws on it. Accepting it here would mean
 *   admitting a key that a later boundary discards without saying so.
 *
 * Both are therefore removable, by rebuilding the copy loops on a faithful
 * mechanism and revisiting the boundaries that filter these names. Until then
 * the reservation is what keeps a record from being corrupted in transit.
 *
 * The check is two `Object.hasOwn()` calls rather than a key walk, so it costs
 * nothing per property and can sit on a hot validation path.
 *
 * @param value The object to check.
 * @returns The offending property name, or `undefined` if there is none.
 */
export function unsafeObjectKeyIn(value: object): string | undefined {
  for (const key of UNSAFE_OBJECT_KEYS) {
    if (Object.hasOwn(value, key)) {
      return key;
    }
  }

  return undefined;
}
