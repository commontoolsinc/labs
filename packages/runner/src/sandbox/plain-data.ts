import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
} from "./types.ts";

type Hardener = <T>(value: T) => T;

export class VerifiedPlainMap<K, V> {
  #entries: ReadonlyArray<readonly [K, V]>;
  #lookup: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = deepHarden(
      Array.from(entries, ([key, value]) => [key, value] as const),
    );
    this.#lookup = new Map(this.#entries as Iterable<[K, V]>);
  }

  get size(): number {
    return this.#entries.length;
  }

  get(key: K): V | undefined {
    return this.#lookup.get(key);
  }

  has(key: K): boolean {
    return this.#lookup.has(key);
  }

  *entries(): IterableIterator<[K, V]> {
    for (const entry of this.#entries) {
      yield entry as [K, V];
    }
  }

  *keys(): IterableIterator<K> {
    for (const [key] of this.#entries) {
      yield key;
    }
  }

  *values(): IterableIterator<V> {
    for (const [, value] of this.#entries) {
      yield value;
    }
  }

  forEach(
    callbackfn: (value: V, key: K, map: VerifiedPlainMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.entries();
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

export class VerifiedPlainSet<T> {
  #values: ReadonlyArray<T>;
  #lookup: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = deepHarden([...values]);
    this.#lookup = new Set(this.#values);
  }

  get size(): number {
    return this.#values.length;
  }

  has(value: T): boolean {
    return this.#lookup.has(value);
  }

  *entries(): IterableIterator<[T, T]> {
    for (const value of this.#values) {
      yield deepHarden([value, value] as const) as [T, T];
    }
  }

  keys(): IterableIterator<T> {
    return this.values();
  }

  *values(): IterableIterator<T> {
    for (const value of this.#values) {
      yield value;
    }
  }

  forEach(
    callbackfn: (value: T, key: T, set: VerifiedPlainSet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.values();
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }
}

deepHarden(VerifiedPlainMap.prototype);
deepHarden(VerifiedPlainSet.prototype);

export function assertPlainData(value: unknown): void {
  normalizeVerifiedPlainData(value);
}

export function normalizeVerifiedPlainData<T>(value: T): T {
  return toStaticData(value, new Map(), new Set());
}

export function freezeVerifiedPlainData<T>(value: T): T {
  return deepHarden(normalizeVerifiedPlainData(value));
}

function toStaticData<T>(
  value: T,
  copies: Map<unknown, unknown>,
  active: Set<unknown>,
): T {
  if (
    value === null || value === undefined || typeof value === "boolean" ||
    typeof value === "number" || typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return value;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error("Unsupported plain-data value");
  }

  if (typeof value !== "object") {
    throw new Error("Unsupported plain-data primitive");
  }

  if (
    value instanceof VerifiedPlainMap || value instanceof VerifiedPlainSet ||
    isVerifiedDataCarrier(value)
  ) {
    return value;
  }

  if (active.has(value)) {
    throw new Error("Cycles are not allowed in verified plain data");
  }

  const existing = copies.get(value);
  if (existing) {
    return existing as T;
  }
  active.add(value);

  try {
    if (Array.isArray(value)) {
      const copy = new Array(value.length);
      copies.set(value, copy);
      for (let index = 0; index < value.length; index++) {
        copy[index] = toStaticData(value[index], copies, active);
      }
      return copy as T;
    }

    if (value instanceof RegExp) {
      validatePlainRegExp(value);
      const copy = new RegExp(value.source, value.flags);
      copies.set(value, copy);
      return copy as T;
    }

    if (value instanceof Map) {
      const copy = new VerifiedPlainMap(
        Array.from(value.entries(), ([key, entry]) =>
          [
            toStaticData(key, copies, active),
            toStaticData(entry, copies, active),
          ] as const),
      );
      copies.set(value, copy);
      return copy as T;
    }

    if (value instanceof Set) {
      const copy = new VerifiedPlainSet(
        Array.from(
          value.values(),
          (entry) => toStaticData(entry, copies, active),
        ),
      );
      copies.set(value, copy);
      return copy as T;
    }

    if (
      value instanceof Promise || value instanceof WeakMap ||
      value instanceof WeakSet || value instanceof Date
    ) {
      throw new Error("Unsupported host object in verified plain data");
    }

    const copy: Record<string, unknown> = {};
    copies.set(value, copy);
    for (const [key, entry] of Object.entries(value)) {
      defineSanitizedProperty(copy, key, toStaticData(entry, copies, active));
    }
    return copy as T;
  } finally {
    active.delete(value);
  }
}

function validatePlainRegExp(value: RegExp): void {
  if (value.global || value.sticky) {
    throw new Error(
      "Stateful RegExp values are not allowed in verified plain data",
    );
  }
}

function isVerifiedDataCarrier(value: object): boolean {
  const symbols = Object.getOwnPropertySymbols(value);
  if (!symbols.includes(CT_WRAPPER_KIND)) {
    return false;
  }
  return (value as Record<PropertyKey, unknown>)[CT_WRAPPER_KIND] === "data";
}

function defineSanitizedProperty(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function deepHarden<T>(value: T): T {
  const hardener = getHardener();
  if (hardener) {
    return hardener(value);
  }
  return deepFreezeFallback(value, new Set());
}

function getHardener(): Hardener | undefined {
  return (globalThis as typeof globalThis & { harden?: Hardener }).harden;
}

function deepFreezeFallback<T>(value: T, seen: Set<unknown>): T {
  if (
    value === null || value === undefined ||
    (typeof value !== "object" && typeof value !== "function") ||
    Object.isFrozen(value)
  ) {
    return value;
  }

  if (seen.has(value)) {
    return value;
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, key);
    if (!descriptor) {
      continue;
    }
    if ("value" in descriptor) {
      deepFreezeFallback(descriptor.value, seen);
    }
    if (descriptor.get) {
      deepFreezeFallback(descriptor.get, seen);
    }
    if (descriptor.set) {
      deepFreezeFallback(descriptor.set, seen);
    }
  }

  return Object.freeze(value);
}

void CT_WRAPPER_KIND;
void CT_ITEM_ID;
void CT_IMPLEMENTATION_REF;
void CT_CAPTURE_IDS;
