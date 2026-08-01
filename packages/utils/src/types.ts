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
 * @param value - The value to check
 * @returns True if the value is a plain object
 */
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
 * @param value - The value to check
 * @returns True if the value is a plain object or an array
 */
export function isPlainContainer(
  value: unknown,
): value is Record<string, unknown> | unknown[] {
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
 * Returns the host-unsafe own property name the given object carries, if any.
 *
 * This asks about the JavaScript host, not about the data model. A property
 * name is data like any other, and a runtime that does not route property
 * assignment through a prototype chain -- which is most of them -- has no
 * unsafe names at all. What makes these two names unusable *here* is that
 * name-driven copying (`target[key] = value`), which is how records are
 * rebuilt at every boundary, does not create the property: it reaches
 * `Object.prototype`'s `__proto__` accessor instead, mutating the copy's
 * prototype and dropping the value. So a record carrying one cannot survive
 * a copy in this host, whatever the model says about it.
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
