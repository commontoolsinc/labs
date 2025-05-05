// Predicate for narrowing a `Record` type, with string,
// symbol, or number (arrays) keys.
export function isRecord(
  value: unknown,
): value is Record<string | number | symbol, unknown> {
  return typeof value === "object" && value !== null;
}

// Predicate for narrowing a non-array/non-null `object` type.
export function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Predicate for narrowing a `number` type.
export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

// Predicate for narrowing a `string` type.
export function isString(value: unknown): value is string {
  return typeof value === "string";
}

// Helper type to recursively remove `readonly` properties from type `T`.
export type Mutable<T> = T extends ReadonlyArray<infer U> ? Mutable<U>[]
  : T extends object ? ({ -readonly [P in keyof T]: Mutable<T[P]> })
  : T;
