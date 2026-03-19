import { isProxy } from "nodeUtilTypes";
import {
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
} from "./types.ts";

const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const INTERNAL_SYMBOL_KEYS = new Set([
  CT_CAPTURE_IDS,
  CT_IMPLEMENTATION_REF,
  CT_ITEM_ID,
  CT_WRAPPER_KIND,
]);

export class VerifiedPlainMap<K, V> {
  #entries: Array<readonly [K, V]>;
  #lookup: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#entries = [...entries].map(([key, value]) => [key, value] as const);
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
    for (const [key, value] of this.#entries) {
      yield [key, value];
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

Object.freeze(VerifiedPlainMap.prototype);

export class VerifiedPlainSet<T> {
  #values: T[];
  #lookup: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = [...values];
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
      yield [value, value];
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

Object.freeze(VerifiedPlainSet.prototype);

export function assertPlainData(value: unknown): void {
  walkPlainData(value, new Set());
}

export function normalizeVerifiedPlainData<T>(value: T): T {
  return normalizePlainData(value, new Map(), new Set());
}

export function freezeVerifiedPlainData<T>(value: T): T {
  const normalized = normalizeVerifiedPlainData(value);
  return deepFreeze(normalized);
}

function walkPlainData(value: unknown, seen: Set<unknown>): void {
  if (
    value === null || value === undefined || typeof value === "boolean" ||
    typeof value === "number" || typeof value === "string" ||
    typeof value === "bigint"
  ) {
    return;
  }

  if (typeof value === "function" || typeof value === "symbol") {
    throw new Error("Unsupported plain-data value");
  }

  if (typeof value !== "object") {
    throw new Error("Unsupported plain-data primitive");
  }

  if (isProxy(value)) {
    throw new Error("Proxy values are not allowed in verified plain data");
  }

  if (seen.has(value)) {
    throw new Error("Cycles are not allowed in verified plain data");
  }
  seen.add(value);

  assertAllowedSymbolKeys(value);

  if (Array.isArray(value)) {
    validatePlainArrayStructure(value);
    for (let index = 0; index < value.length; index++) {
      const descriptor = getOwnDescriptorOrThrow(value, String(index));
      if (!("value" in descriptor)) {
        throw new Error("Accessors are not allowed in verified plain data");
      }
      walkPlainData(descriptor.value, seen);
    }
    seen.delete(value);
    return;
  }

  if (isVerifiedPlainRegExp(value)) {
    validatePlainRegExp(value);
    seen.delete(value);
    return;
  }

  if (isVerifiedPlainMap(value)) {
    validateCollectionOwnProperties(value);
    for (const [key, entry] of value.entries()) {
      walkPlainData(key, seen);
      walkPlainData(entry, seen);
    }
    seen.delete(value);
    return;
  }

  if (isVerifiedPlainSet(value)) {
    validateCollectionOwnProperties(value);
    for (const entry of value.values()) {
      walkPlainData(entry, seen);
    }
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Only plain object records are allowed");
  }

  validatePlainObjectKeys(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const descriptor = getOwnDescriptorOrThrow(value, key);
    if (!("value" in descriptor)) {
      throw new Error("Accessors are not allowed in verified plain data");
    }
    walkPlainData(descriptor.value, seen);
  }

  seen.delete(value);
}

function validatePlainArrayStructure(value: unknown[]): void {
  const ownKeys = Object.getOwnPropertyNames(value);
  for (const key of ownKeys) {
    if (key === "length") {
      continue;
    }
    if (!isCanonicalArrayIndexKey(key)) {
      throw new Error(
        "Arrays may not have extra own properties in verified plain data",
      );
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw new Error("Sparse arrays are not allowed in verified plain data");
    }
  }
}

function isVerifiedPlainRegExp(value: object): value is RegExp {
  return Object.getPrototypeOf(value) === RegExp.prototype;
}

function validatePlainRegExp(value: RegExp): void {
  if (value.global || value.sticky) {
    throw new Error(
      "Stateful RegExp values are not allowed in verified plain data",
    );
  }

  const ownKeys = Object.getOwnPropertyNames(value);
  for (const key of ownKeys) {
    if (key !== "lastIndex") {
      throw new Error("RegExp values may not have extra own properties");
    }
  }

  const descriptor = getOwnDescriptorOrThrow(value, "lastIndex");
  if (!("value" in descriptor)) {
    throw new Error("Accessors are not allowed in verified plain data");
  }
  if (descriptor.value !== 0) {
    throw new Error("RegExp lastIndex must be zero in verified plain data");
  }
}

function isVerifiedPlainMap(
  value: object,
): value is Map<unknown, unknown> | VerifiedPlainMap<unknown, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Map.prototype ||
    prototype === VerifiedPlainMap.prototype;
}

function isVerifiedPlainSet(
  value: object,
): value is Set<unknown> | VerifiedPlainSet<unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Set.prototype ||
    prototype === VerifiedPlainSet.prototype;
}

function validateCollectionOwnProperties(value: object): void {
  const ownKeys = Object.getOwnPropertyNames(value);
  if (ownKeys.length > 0) {
    throw new Error("Map and Set values may not have extra own properties");
  }
}

function validatePlainObjectKeys(value: object): void {
  for (const key of Object.getOwnPropertyNames(value)) {
    if (RESERVED_KEYS.has(key)) {
      throw new Error(
        `Reserved key '${key}' is not allowed in verified plain data`,
      );
    }
  }
}

function normalizePlainData<T>(
  value: T,
  copies: Map<unknown, unknown>,
  seen: Set<unknown>,
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

  if (isProxy(value)) {
    throw new Error("Proxy values are not allowed in verified plain data");
  }

  if (value instanceof VerifiedPlainMap || value instanceof VerifiedPlainSet) {
    return value;
  }

  if (isVerifiedDataCarrier(value)) {
    return value;
  }

  const existing = copies.get(value);
  if (existing) {
    return existing as T;
  }

  if (seen.has(value)) {
    throw new Error("Cycles are not allowed in verified plain data");
  }
  seen.add(value);

  assertAllowedSymbolKeys(value);

  try {
    if (Array.isArray(value)) {
      validatePlainArrayStructure(value);
      copies.set(value, value);
      for (let index = 0; index < value.length; index++) {
        const descriptor = getOwnDescriptorOrThrow(value, String(index));
        if (!("value" in descriptor)) {
          throw new Error("Accessors are not allowed in verified plain data");
        }
        const normalized = normalizePlainData(descriptor.value, copies, seen);
        if (normalized !== descriptor.value) {
          Object.defineProperty(value, String(index), {
            ...descriptor,
            value: normalized,
          });
        }
      }
      return value;
    }

    if (isVerifiedPlainRegExp(value)) {
      validatePlainRegExp(value);
      copies.set(value, value);
      return value as T;
    }

    if (isVerifiedPlainMap(value)) {
      validateCollectionOwnProperties(value);
      const normalized = new VerifiedPlainMap(
        Array.from(value.entries(), ([key, entry]) =>
          [
            normalizePlainData(key, copies, seen),
            normalizePlainData(entry, copies, seen),
          ] as const),
      );
      copies.set(value, normalized);
      return normalized as T;
    }

    if (isVerifiedPlainSet(value)) {
      validateCollectionOwnProperties(value);
      const normalized = new VerifiedPlainSet(
        Array.from(
          value.values(),
          (entry) => normalizePlainData(entry, copies, seen),
        ),
      );
      copies.set(value, normalized);
      return normalized as T;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Only plain object records are allowed");
    }

    validatePlainObjectKeys(value);
    copies.set(value, value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = getOwnDescriptorOrThrow(value, key);
      if (!("value" in descriptor)) {
        throw new Error("Accessors are not allowed in verified plain data");
      }
      const normalized = normalizePlainData(descriptor.value, copies, seen);
      if (normalized !== descriptor.value) {
        Object.defineProperty(value, key, {
          ...descriptor,
          value: normalized,
        });
      }
    }
    return value;
  } finally {
    seen.delete(value);
  }
}

function isVerifiedDataCarrier(value: object): boolean {
  const symbols = Object.getOwnPropertySymbols(value);
  if (!symbols.includes(CT_WRAPPER_KIND)) {
    return false;
  }
  return (value as Record<PropertyKey, unknown>)[CT_WRAPPER_KIND] === "data";
}

function assertAllowedSymbolKeys(value: object): void {
  const symbolKeys = Object.getOwnPropertySymbols(value);
  if (symbolKeys.some((symbol) => !INTERNAL_SYMBOL_KEYS.has(symbol))) {
    throw new Error("Symbol keys are not allowed in verified plain data");
  }
}

function isCanonicalArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) {
    return false;
  }
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index <= 0xFFFFFFFE &&
    String(index) === key;
}

function getOwnDescriptorOrThrow(
  value: object,
  key: string,
): PropertyDescriptor {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw new Error(`Missing descriptor for '${key}'`);
    }
    return descriptor;
  } catch (error) {
    throw new Error(
      `Descriptor introspection failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  if (value instanceof VerifiedPlainMap) {
    for (const [key, entry] of value.entries()) {
      deepFreeze(key);
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }

  if (value instanceof VerifiedPlainSet) {
    for (const entry of value.values()) {
      deepFreeze(entry);
    }
    return Object.freeze(value);
  }

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      continue;
    }
    deepFreeze(descriptor.value);
  }

  return Object.freeze(value);
}
