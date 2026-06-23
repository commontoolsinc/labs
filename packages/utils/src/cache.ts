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

/**
 * A memo keyed by a pair of garbage-collectable keys, `(outer, inner)`, with a
 * `WeakMap` at each level. An entry is reclaimed as soon as either key becomes
 * unreachable, so the cache never keeps its keys (or the values hanging off
 * them) alive.
 *
 * The canonical use is memoizing a pure function of `(ts.TypeChecker, ts.Type)`
 * or `(ts.TypeChecker, ts.Expression)` across a compile. Keying by the checker
 * first means a key minted by one checker is never read against another, and
 * lets a whole program's entries fall away once its checker is gone — while the
 * inner `WeakMap` collects individual types/nodes as they themselves die.
 * Several hot transformer/schema-generation paths share this shape; this is its
 * one implementation.
 */
export class TwoLevelWeakCache<
  Outer extends object,
  Inner extends object,
  V,
> {
  readonly #buckets = new WeakMap<Outer, WeakMap<Inner, V>>();

  /**
   * The inner cache for `outer`, created on first access. Use this when a
   * single logical entry is read or written from several branches and a single
   * `getOrCompute` call doesn't fit; operate on the returned map's
   * `has`/`get`/`set` directly. Both levels stay weak.
   */
  innerFor(outer: Outer): WeakMap<Inner, V> {
    let bucket = this.#buckets.get(outer);
    if (bucket === undefined) {
      bucket = new WeakMap<Inner, V>();
      this.#buckets.set(outer, bucket);
    }
    return bucket;
  }

  /**
   * Return the cached value for `(outer, inner)`, computing it with `compute`
   * on the first miss. A stored `undefined` is a real cached result and is not
   * recomputed — the `has` check distinguishes "cached undefined" from "absent".
   */
  getOrCompute(outer: Outer, inner: Inner, compute: () => V): V {
    const bucket = this.innerFor(outer);
    if (bucket.has(inner)) {
      return bucket.get(inner) as V;
    }
    const value = compute();
    bucket.set(inner, value);
    return value;
  }
}
