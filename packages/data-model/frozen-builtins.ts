/**
 * Effectively immutable wrappers for built-in collection types (`Map`, `Set`).
 *
 * These wrappers preserve the public collection surface and `instanceof`
 * behavior, but they intentionally do not carry native `Map` / `Set` internal
 * slots. Their data lives in module-private backing stores keyed by the wrapper
 * instance. That makes intrinsic mutators like `Map.prototype.set.call(...)`
 * and `Set.prototype.add.call(...)` fail with an incompatible receiver instead
 * of mutating hidden internal state on a frozen object.
 */

type MapBacking<K, V> = Map<K, V>;
type SetBacking<T> = Set<T>;
type MapBuilder<K, V> = {
  readonly wrapper: FrozenMap<K, V>;
  set(key: K, value: V): void;
  finish(): FrozenMap<K, V>;
};
type SetBuilder<T> = {
  readonly wrapper: FrozenSet<T>;
  add(value: T): void;
  finish(): FrozenSet<T>;
};

const MAP_BACKING = new WeakMap<object, MapBacking<unknown, unknown>>();
const SET_BACKING = new WeakMap<object, SetBacking<unknown>>();
const INTERNAL_MAP_BUILDER = Symbol("FrozenMapBuilder");
const INTERNAL_SET_BUILDER = Symbol("FrozenSetBuilder");

function throwFrozenMutation(typeName: string): never {
  throw new TypeError(`Cannot mutate a ${typeName}`);
}

function throwFinalizedBuilderMutation(typeName: string): never {
  throw new TypeError(`Cannot mutate a finalized ${typeName} builder`);
}

function getMapBacking<K, V>(value: object): MapBacking<K, V> {
  const backing = MAP_BACKING.get(value);
  if (!backing) {
    throw new TypeError("Incompatible FrozenMap receiver");
  }
  return backing as MapBacking<K, V>;
}

function getSetBacking<T>(value: object): SetBacking<T> {
  const backing = SET_BACKING.get(value);
  if (!backing) {
    throw new TypeError("Incompatible FrozenSet receiver");
  }
  return backing as SetBacking<T>;
}

function forEachSetLikeValue<T>(
  setLike: ReadonlySetLike<T>,
  callback: (value: T) => void,
): void {
  const iterator = setLike.keys();
  while (true) {
    const next = iterator.next();
    if (next.done) {
      return;
    }
    callback(next.value);
  }
}

export class FrozenMap<K, V> implements Map<K, V> {
  constructor(
    entries?: Iterable<readonly [K, V]> | null,
    builderToken?: symbol,
  ) {
    MAP_BACKING.set(this, new Map(entries ?? undefined));
    if (builderToken !== INTERNAL_MAP_BUILDER) {
      Object.freeze(this);
    }
  }

  static createBuilder<K, V>(): MapBuilder<K, V> {
    const wrapper = new FrozenMap<K, V>(undefined, INTERNAL_MAP_BUILDER);
    let finalized = false;

    const assertOpen = (): void => {
      if (finalized) {
        throwFinalizedBuilderMutation("FrozenMap");
      }
    };

    return {
      wrapper,
      set(key: K, value: V): void {
        assertOpen();
        getMapBacking<K, V>(wrapper).set(key, value);
      },
      finish(): FrozenMap<K, V> {
        finalized = true;
        Object.freeze(wrapper);
        return wrapper;
      },
    };
  }

  get size(): number {
    return getMapBacking<K, V>(this).size;
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }

  get(key: K): V | undefined {
    return getMapBacking<K, V>(this).get(key);
  }

  has(key: K): boolean {
    return getMapBacking<K, V>(this).has(key);
  }

  entries(): ReturnType<Map<K, V>["entries"]> {
    return getMapBacking<K, V>(this).entries();
  }

  keys(): ReturnType<Map<K, V>["keys"]> {
    return getMapBacking<K, V>(this).keys();
  }

  values(): ReturnType<Map<K, V>["values"]> {
    return getMapBacking<K, V>(this).values();
  }

  forEach(
    callbackfn: (value: V, key: K, map: Map<K, V>) => void,
    thisArg?: unknown,
  ): void {
    getMapBacking<K, V>(this).forEach((value, key) => {
      callbackfn.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): ReturnType<Map<K, V>[typeof Symbol.iterator]> {
    return this.entries();
  }

  set(_key: K, _value: V): this {
    throwFrozenMutation("FrozenMap");
  }

  getOrInsert(_key: K, _defaultValue: V): V {
    throwFrozenMutation("FrozenMap");
  }

  getOrInsertComputed(_key: K, _callback: (key: K) => V): V {
    throwFrozenMutation("FrozenMap");
  }

  delete(_key: K): boolean {
    throwFrozenMutation("FrozenMap");
  }

  clear(): void {
    throwFrozenMutation("FrozenMap");
  }
}

Object.setPrototypeOf(FrozenMap.prototype, Map.prototype);
Object.setPrototypeOf(FrozenMap, Map);

export class FrozenSet<T> implements Set<T> {
  constructor(values?: Iterable<T> | null, builderToken?: symbol) {
    SET_BACKING.set(this, new Set(values ?? undefined));
    if (builderToken !== INTERNAL_SET_BUILDER) {
      Object.freeze(this);
    }
  }

  static createBuilder<T>(): SetBuilder<T> {
    const wrapper = new FrozenSet<T>(undefined, INTERNAL_SET_BUILDER);
    let finalized = false;

    const assertOpen = (): void => {
      if (finalized) {
        throwFinalizedBuilderMutation("FrozenSet");
      }
    };

    return {
      wrapper,
      add(value: T): void {
        assertOpen();
        getSetBacking<T>(wrapper).add(value);
      },
      finish(): FrozenSet<T> {
        finalized = true;
        Object.freeze(wrapper);
        return wrapper;
      },
    };
  }

  get size(): number {
    return getSetBacking<T>(this).size;
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }

  has(value: T): boolean {
    return getSetBacking<T>(this).has(value);
  }

  entries(): ReturnType<Set<T>["entries"]> {
    return getSetBacking<T>(this).entries();
  }

  keys(): ReturnType<Set<T>["keys"]> {
    return getSetBacking<T>(this).keys();
  }

  values(): ReturnType<Set<T>["values"]> {
    return getSetBacking<T>(this).values();
  }

  forEach(
    callbackfn: (value: T, key: T, set: Set<T>) => void,
    thisArg?: unknown,
  ): void {
    getSetBacking<T>(this).forEach((value) => {
      callbackfn.call(thisArg, value, value, this as Set<T>);
    });
  }

  [Symbol.iterator](): ReturnType<Set<T>[typeof Symbol.iterator]> {
    return this.values();
  }

  union<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.values());
    forEachSetLikeValue(other, (value) => {
      result.add(value);
    });
    return result;
  }

  intersection<U>(other: ReadonlySetLike<U>): Set<T & U> {
    const result = new Set<T & U>();
    for (const value of this.values()) {
      if (other.has(value as unknown as U)) {
        result.add(value as T & U);
      }
    }
    return result;
  }

  difference<U>(other: ReadonlySetLike<U>): Set<T> {
    const result = new Set<T>();
    for (const value of this.values()) {
      if (!other.has(value as unknown as U)) {
        result.add(value);
      }
    }
    return result;
  }

  symmetricDifference<U>(other: ReadonlySetLike<U>): Set<T | U> {
    const result = new Set<T | U>(this.values());
    forEachSetLikeValue(other, (value) => {
      if (result.has(value)) {
        result.delete(value);
      } else {
        result.add(value);
      }
    });
    return result;
  }

  isSubsetOf(other: Parameters<Set<T>["isSubsetOf"]>[0]): boolean {
    for (const value of this.values()) {
      if (!other.has(value)) {
        return false;
      }
    }
    return true;
  }

  isSupersetOf(other: Parameters<Set<T>["isSupersetOf"]>[0]): boolean {
    let result = true;
    forEachSetLikeValue(other, (value) => {
      if (!this.has(value as T)) {
        result = false;
      }
    });
    return result;
  }

  isDisjointFrom(other: Parameters<Set<T>["isDisjointFrom"]>[0]): boolean {
    let result = true;
    forEachSetLikeValue(other, (value) => {
      if (this.has(value as T)) {
        result = false;
      }
    });
    return result;
  }

  add(_value: T): this {
    throwFrozenMutation("FrozenSet");
  }

  delete(_value: T): boolean {
    throwFrozenMutation("FrozenSet");
  }

  clear(): void {
    throwFrozenMutation("FrozenSet");
  }
}

Object.setPrototypeOf(FrozenSet.prototype, Set.prototype);
Object.setPrototypeOf(FrozenSet, Set);
