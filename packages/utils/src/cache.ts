export interface CacheOptions {
  capacity?: number;
}

export interface WeightedCacheOptions<K, V> extends CacheOptions {
  /**
   * Cost of one entry, in whatever unit `maxWeight` is expressed in. Supply
   * both to bound a cache whose entries vary in size — an entry count alone
   * bounds how many things a cache holds, not how much memory they take.
   */
  weigh?: (key: K, value: V) => number;
  maxWeight?: number;
}

/**
 * A Map that drops its oldest key once it holds `limit` of them. Insertion
 * order is the eviction order, and re-setting a key refreshes its place, so
 * what goes first is whatever has gone longest without being written.
 *
 * The point of the Map-shaped surface is that an unbounded `Map` field becomes
 * bounded by changing only its declaration. Reach for this where the entries
 * are hints — a value whose loss costs a slower path, never a wrong answer —
 * and where the keys keep arriving: one per instance of something the program
 * creates and discards, rather than one per fixed thing it knows about.
 */
export class BoundedKeyMap<K, V> implements ReadonlyMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #limit: number;

  constructor(limit: number) {
    this.#limit = Math.max(limit, 1);
  }

  get size(): number {
    return this.#entries.size;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  get(key: K): V | undefined {
    return this.#entries.get(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    // Keys come out in insertion order, so this drops the oldest first, and
    // stops as soon as the new entry has somewhere to go.
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size < this.#limit) break;
      this.#entries.delete(oldest);
    }
    this.#entries.set(key, value);
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  // The read side is the standard ReadonlyMap surface, so a consumer that only
  // reads takes `ReadonlyMap` and accepts either this or a plain Map. Every
  // traversal runs oldest first, which is the order entries are dropped in.

  entries(): MapIterator<[K, V]> {
    return this.#entries.entries();
  }

  keys(): MapIterator<K> {
    return this.#entries.keys();
  }

  values(): MapIterator<V> {
    return this.#entries.values();
  }

  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#entries) {
      callback.call(thisArg, value, key, this);
    }
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#entries.entries();
  }
}

interface LRUNode<K, V> {
  key: K;
  value: V;
  weight: number;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

export class LRUCache<K, V> {
  #map = new Map<K, LRUNode<K, V>>();
  #head: LRUNode<K, V> | null = null;
  #tail: LRUNode<K, V> | null = null;
  #capacity: number;
  // Declared as an explicit `| undefined` rather than an optional field, so
  // assigning the caller's optional `weigh` stays legal for the packages that
  // compile with exactOptionalPropertyTypes.
  #weigh: ((key: K, value: V) => number) | undefined;
  #maxWeight: number;
  #weight = 0;

  constructor(options: WeightedCacheOptions<K, V> = {}) {
    this.#capacity = Math.max(options.capacity ?? 1000, 1);
    this.#weigh = options.weigh;
    this.#maxWeight = options.maxWeight ?? Infinity;
  }

  get size(): number {
    return this.#map.size;
  }

  /** Total weight of the entries currently held, per the `weigh` option. */
  get weight(): number {
    return this.#weight;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  get(key: K): V | undefined {
    const node = this.#map.get(key);
    if (node === undefined) {
      return undefined;
    }
    this.#moveToTail(node);
    return node.value;
  }

  put(key: K, value: V): void {
    const weight = this.#weigh?.(key, value) ?? 0;
    const existingNode = this.#map.get(key);
    if (existingNode !== undefined) {
      this.#weight += weight - existingNode.weight;
      existingNode.value = value;
      existingNode.weight = weight;
      this.#moveToTail(existingNode);
      this.#evictToFit();
      return;
    }

    if (this.#map.size >= this.#capacity) {
      this.#evictHead();
    }

    const node: LRUNode<K, V> = { key, value, weight, prev: null, next: null };
    this.#map.set(key, node);
    this.#addToTail(node);
    this.#weight += weight;
    this.#evictToFit();
  }

  delete(key: K): boolean {
    const node = this.#map.get(key);
    if (node === undefined) {
      return false;
    }
    this.#map.delete(key);
    this.#removeNode(node);
    this.#weight -= node.weight;
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#head = null;
    this.#tail = null;
    this.#weight = 0;
  }

  // Evict from the least-recently-used end until the weight budget is met.
  // The most recent entry stays even when it alone exceeds the budget, so a
  // single oversized value cannot leave the cache empty on every put.
  #evictToFit(): void {
    while (this.#weight > this.#maxWeight && this.#map.size > 1) {
      this.#evictHead();
    }
  }

  #removeNode(node: LRUNode<K, V>): void {
    if (node.prev !== null) {
      node.prev.next = node.next;
    } else {
      this.#head = node.next;
    }
    if (node.next !== null) {
      node.next.prev = node.prev;
    } else {
      this.#tail = node.prev;
    }
    node.prev = null;
    node.next = null;
  }

  #addToTail(node: LRUNode<K, V>): void {
    if (this.#tail === null) {
      this.#head = node;
      this.#tail = node;
    } else {
      node.prev = this.#tail;
      this.#tail.next = node;
      this.#tail = node;
    }
  }

  #moveToTail(node: LRUNode<K, V>): void {
    if (node === this.#tail) {
      return;
    }
    this.#removeNode(node);
    this.#addToTail(node);
  }

  #evictHead(): void {
    if (this.#head === null) {
      return;
    }
    const node = this.#head;
    this.#map.delete(node.key);
    this.#removeNode(node);
    this.#weight -= node.weight;
  }
}
