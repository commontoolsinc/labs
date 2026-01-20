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
