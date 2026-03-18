/**
 * Predicate for narrowing a `Record` type, with string, symbol, or number (arrays) keys.
 * @param value - The value to check
 * @returns True if the value is a record object
 */
export function isRecord(
  value: unknown,
): value is Record<string | number | symbol, unknown> {
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
