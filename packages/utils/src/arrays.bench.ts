/**
 * `isArrayWithOnlyIndexProperties()` Performance Benchmarks
 *
 * This predicate is called once per array node by the fabric membership,
 * cloning, and conversion walks, so its cost is paid per container rather than
 * once per operation. Two properties are worth tracking over time:
 *
 * 1. **Absolute cost against array length.** Asking an array for its own keys
 *    scales with `length`, not with how many elements are actually present:
 *    measured on V8, a two-element array costs about 1 µs at `length` 1000 and
 *    about 700 µs at `length` 1e6. A sparse array is therefore priced by its
 *    extent, which is worth knowing before treating sparseness as free.
 *
 * 2. **The plain/proxied split.** These two go in opposite directions, so a
 *    single number is misleading. `Reflect.ownKeys()` does not get the
 *    EnumCache fast path that `Object.keys()` gets on an ordinary array, which
 *    costs it there. On a `Proxy` it wins instead: `Object.keys()` fires an
 *    `ownKeys` trap plus a `getOwnPropertyDescriptor` trap per key to filter
 *    for enumerability, where `Reflect.ownKeys()` fires exactly one trap. The
 *    runtime proxies heavily, so the proxied figure is not a curiosity.
 *
 * Engines retune as usage shifts, so treat a large move here as news about the
 * engine rather than as noise.
 */

import { isArrayWithOnlyIndexProperties } from "@commonfabric/utils/arrays";

/** Sizes spanning "typical container" to "large collection". */
const SIZES = [3, 100, 1000] as const;

for (const size of SIZES) {
  const array: unknown[] = Array.from({ length: size }, (_, i) => i);
  // A pass-through proxy, the shape a cell projection presents.
  const asProxy = new Proxy(array, {});

  Deno.bench({
    name: `plain array (${size})`,
    group: `size ${size}`,
    baseline: true,
    fn() {
      isArrayWithOnlyIndexProperties(array);
    },
  });

  Deno.bench({
    name: `proxied array (${size})`,
    group: `size ${size}`,
    fn() {
      isArrayWithOnlyIndexProperties(asProxy);
    },
  });
}

/** Sparse, to track the cost of extent as distinct from element count. */
const sparse: unknown[] = [];
sparse.length = 100_000;
sparse[0] = "first";
sparse[99_999] = "last";

/** The same two elements in a small extent, as the comparison that isolates it. */
const compact: unknown[] = ["first", "last"];

/** Rejected for a named property, which short-circuits on the last key. */
const named = [1, 2, 3] as unknown[] & { foo?: string };
named.foo = "bar";

Deno.bench({
  name: "compact array (2 elements, length 2)",
  group: "shapes",
  baseline: true,
  fn() {
    isArrayWithOnlyIndexProperties(compact);
  },
});

Deno.bench({
  name: "sparse array (2 elements, length 100k)",
  group: "shapes",
  fn() {
    isArrayWithOnlyIndexProperties(sparse);
  },
});

Deno.bench({
  name: "rejected: array with a named property",
  group: "shapes",
  fn() {
    isArrayWithOnlyIndexProperties(named);
  },
});
