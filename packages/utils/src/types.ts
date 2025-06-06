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
 * Predicate for narrowing a non-array/non-null `object` type.
 * @param value - The value to check
 * @returns True if the value is an object (not array or null)
 */
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Predicate for narrowing a `number` type.
 * @param value - The value to check
 * @returns True if the value is a finite number
 */
export function isNumber(value: unknown): value is number {
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
