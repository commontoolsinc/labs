import { Cache, CacheOptions, LRUCache, LRUCacheNaive } from "./cache.ts";

const CACHE_SIZE = 1000;
const OPERATIONS = 10000;

function createCache<K, V>(
  Ctor: new (options: CacheOptions) => Cache<K, V>,
): Cache<K, V> {
  return new Ctor({ capacity: CACHE_SIZE });
}

function fillCache(cache: Cache<number, number>, count: number): void {
  for (let i = 0; i < count; i++) {
    cache.put(i, i);
  }
}

Deno.bench({
  name: "LRUCache (linked list) - sequential put",
  fn() {
    const cache = createCache<number, number>(LRUCache);
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i, i);
    }
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - sequential put",
  fn() {
    const cache = createCache<number, number>(LRUCacheNaive);
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i, i);
    }
  },
});

Deno.bench({
  name: "LRUCache (linked list) - sequential get (hit)",
  group: "get-hit",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i % CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - sequential get (hit)",
  group: "get-hit",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i % CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - sequential get (miss)",
  group: "get-miss",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i + CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - sequential get (miss)",
  group: "get-miss",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.get(i + CACHE_SIZE);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - mixed put/get with eviction",
  group: "mixed-eviction",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      if (i % 2 === 0) {
        cache.put(i + CACHE_SIZE, i);
      } else {
        cache.get(i % CACHE_SIZE);
      }
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - mixed put/get with eviction",
  group: "mixed-eviction",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      if (i % 2 === 0) {
        cache.put(i + CACHE_SIZE, i);
      } else {
        cache.get(i % CACHE_SIZE);
      }
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - update existing keys",
  group: "update",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i % CACHE_SIZE, i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - update existing keys",
  group: "update",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < OPERATIONS; i++) {
      cache.put(i % CACHE_SIZE, i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - delete",
  group: "delete",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < CACHE_SIZE; i++) {
      cache.delete(i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - delete",
  group: "delete",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    b.start();
    for (let i = 0; i < CACHE_SIZE; i++) {
      cache.delete(i);
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCache (linked list) - random access pattern",
  group: "random",
  baseline: true,
  fn(b) {
    const cache = createCache<number, number>(LRUCache);
    fillCache(cache, CACHE_SIZE);
    const keys = Array.from(
      { length: OPERATIONS },
      () => Math.floor(Math.random() * CACHE_SIZE * 2),
    );
    b.start();
    for (const key of keys) {
      if (cache.has(key)) {
        cache.get(key);
      } else {
        cache.put(key, key);
      }
    }
    b.end();
  },
});

Deno.bench({
  name: "LRUCacheNaive (map) - random access pattern",
  group: "random",
  fn(b) {
    const cache = createCache<number, number>(LRUCacheNaive);
    fillCache(cache, CACHE_SIZE);
    const keys = Array.from(
      { length: OPERATIONS },
      () => Math.floor(Math.random() * CACHE_SIZE * 2),
    );
    b.start();
    for (const key of keys) {
      if (cache.has(key)) {
        cache.get(key);
      } else {
        cache.put(key, key);
      }
    }
    b.end();
  },
});
