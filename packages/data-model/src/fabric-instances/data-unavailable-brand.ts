/** Runtime surface needed to recognize the canonical DataUnavailable class. */
export interface DataUnavailableRuntimeClass {
  readonly [Symbol.hasInstance]: (value: unknown) => boolean;
}

const DATA_UNAVAILABLE_CLASS_KEY = Symbol.for(
  "common.fabric.DataUnavailable.constructor",
);
const DATA_UNAVAILABLE_CLASS_HOST = globalThis as unknown as Record<
  PropertyKey,
  unknown
>;

/** Returns the DataUnavailable constructor shared by split bundle copies. */
export function getCanonicalDataUnavailableClass<
  T extends DataUnavailableRuntimeClass,
>(): T | undefined {
  if (!Object.hasOwn(DATA_UNAVAILABLE_CLASS_HOST, DATA_UNAVAILABLE_CLASS_KEY)) {
    return undefined;
  }
  const existing = DATA_UNAVAILABLE_CLASS_HOST[DATA_UNAVAILABLE_CLASS_KEY];
  if (typeof existing !== "function") {
    throw new TypeError("Invalid global DataUnavailable constructor");
  }
  return existing as unknown as T;
}

/** Installs the first DataUnavailable constructor as the canonical copy. */
export function installCanonicalDataUnavailableClass(
  constructor: DataUnavailableRuntimeClass,
): void {
  if (getCanonicalDataUnavailableClass()) return;
  Object.defineProperty(
    DATA_UNAVAILABLE_CLASS_HOST,
    DATA_UNAVAILABLE_CLASS_KEY,
    {
      value: constructor,
      configurable: false,
      enumerable: false,
      writable: false,
    },
  );
}

/** Recognizes the canonical private brand without relying on base identity. */
export function isCanonicalDataUnavailable(value: unknown): boolean {
  const constructor = getCanonicalDataUnavailableClass();
  return constructor?.[Symbol.hasInstance](value) ?? false;
}
