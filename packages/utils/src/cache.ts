export interface CacheOptions {
  capacity?: number;
}

export interface Cache<K, V> {
  readonly size: number;
  has(key: K): boolean;
  get(key: K): V | undefined;
  put(key: K, value: V): void;
  delete(key: K): boolean;
  clear(): void;
}

export class LRUCacheNaive<K, V> implements Cache<K, V> {
  #map = new Map<K, V>();
  #capacity: number;

  constructor(options: CacheOptions = {}) {
    this.#capacity = Math.max(options.capacity ?? 1000, 1);
  }

  get size(): number {
    return this.#map.size;
  }

  has(key: K): boolean {
    return this.#map.has(key);
  }

  get(key: K): V | undefined {
    const value = this.#map.get(key);
    if (value !== undefined) {
      this.#map.delete(key);
      this.#map.set(key, value);
    }
    return value;
  }

  put(key: K, value: V): void {
    if (this.#map.has(key)) {
      this.#map.delete(key);
      this.#map.set(key, value);
      return;
    }
    if (this.#map.size >= this.#capacity) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey !== undefined) {
        this.#map.delete(oldestKey);
      }
    }
    this.#map.set(key, value);
  }

  delete(key: K): boolean {
    return this.#map.delete(key);
  }

  clear(): void {
    this.#map.clear();
  }
}

interface LRUNode<K, V> {
  key: K;
  value: V;
  prev: LRUNode<K, V> | null;
  next: LRUNode<K, V> | null;
}

export class LRUCache<K, V> implements Cache<K, V> {
  #map = new Map<K, LRUNode<K, V>>();
  #head: LRUNode<K, V> | null = null;
  #tail: LRUNode<K, V> | null = null;
  #capacity: number;

  constructor(options: CacheOptions = {}) {
    this.#capacity = Math.max(options.capacity ?? 1000, 1);
  }

  get size(): number {
    return this.#map.size;
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
    const existingNode = this.#map.get(key);
    if (existingNode !== undefined) {
      existingNode.value = value;
      this.#moveToTail(existingNode);
      return;
    }

    if (this.#map.size >= this.#capacity) {
      this.#evictHead();
    }

    const node: LRUNode<K, V> = { key, value, prev: null, next: null };
    this.#map.set(key, node);
    this.#addToTail(node);
  }

  delete(key: K): boolean {
    const node = this.#map.get(key);
    if (node === undefined) {
      return false;
    }
    this.#map.delete(key);
    this.#removeNode(node);
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#head = null;
    this.#tail = null;
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
  }
}

export interface WeightedCacheOptions {
  /** Maximum total weight retained before least-recently-used eviction. */
  maxWeight: number;
}

interface WeightedLRUNode<K, V> {
  key: K;
  value: V;
  weight: number;
  prev: WeightedLRUNode<K, V> | null;
  next: WeightedLRUNode<K, V> | null;
}

/**
 * LRU cache bounded by total entry *weight* rather than entry count.
 *
 * Motivation (CT-1840): an entry-count LRU is blind to what the entries
 * cost. When entries vary from bytes to megabytes (e.g. parsed `data:` URIs,
 * where the key IS the content), a count bound either cycles under many
 * small entries — destroying identity stability for every identity-keyed
 * cache downstream — or blows memory under a few huge ones. A weight bound
 * (callers typically pass byte sizes) keeps retention proportional to
 * actual memory.
 *
 * Entries heavier than `maxWeight` are NOT stored: admitting one would evict
 * the entire cache for a single entry that can never be joined by another.
 * Callers needing identity stability for such values should layer a
 * `WeakRef` intern over this cache.
 */
export class WeightedLRUCache<K, V> {
  #map = new Map<K, WeightedLRUNode<K, V>>();
  #head: WeightedLRUNode<K, V> | null = null;
  #tail: WeightedLRUNode<K, V> | null = null;
  #maxWeight: number;
  #totalWeight = 0;

  constructor(options: WeightedCacheOptions) {
    this.#maxWeight = Math.max(options.maxWeight, 1);
  }

  get size(): number {
    return this.#map.size;
  }

  get totalWeight(): number {
    return this.#totalWeight;
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

  /**
   * Inserts or refreshes an entry. `weight` must be a non-negative finite
   * number; entries heavier than `maxWeight` are silently not stored (and an
   * existing entry under that key is removed, since the caller has declared
   * the value's current cost exceeds the whole budget).
   */
  put(key: K, value: V, weight: number): void {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(`WeightedLRUCache: invalid weight ${weight}`);
    }

    const existing = this.#map.get(key);
    if (existing !== undefined) {
      this.#map.delete(key);
      this.#removeNode(existing);
      this.#totalWeight -= existing.weight;
    }

    if (weight > this.#maxWeight) {
      return;
    }

    const node: WeightedLRUNode<K, V> = {
      key,
      value,
      weight,
      prev: null,
      next: null,
    };
    this.#map.set(key, node);
    this.#addToTail(node);
    this.#totalWeight += weight;

    while (this.#totalWeight > this.#maxWeight && this.#head !== null) {
      this.#evictHead();
    }
  }

  delete(key: K): boolean {
    const node = this.#map.get(key);
    if (node === undefined) {
      return false;
    }
    this.#map.delete(key);
    this.#removeNode(node);
    this.#totalWeight -= node.weight;
    return true;
  }

  clear(): void {
    this.#map.clear();
    this.#head = null;
    this.#tail = null;
    this.#totalWeight = 0;
  }

  #removeNode(node: WeightedLRUNode<K, V>): void {
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

  #addToTail(node: WeightedLRUNode<K, V>): void {
    if (this.#tail === null) {
      this.#head = node;
      this.#tail = node;
    } else {
      node.prev = this.#tail;
      this.#tail.next = node;
      this.#tail = node;
    }
  }

  #moveToTail(node: WeightedLRUNode<K, V>): void {
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
    this.#totalWeight -= node.weight;
  }
}
