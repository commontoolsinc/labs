/**
 * JSON codec performance benchmarks, encoding and decoding.
 *
 * Run with:
 *
 *     deno bench --no-check bench/codec-json.bench.ts
 *
 * Each group pairs the two directions over one subject, so the encode/decode
 * ratio for that subject reads off a single block. Group keys are zero-padded
 * to six digits, so that the largest container sorts after the smallest rather
 * than between `1` and `10`. A name repeats its group because `--filter`
 * matches names and not groups, and a subject one cannot select is a subject
 * one cannot iterate on.
 *
 * The containers hold nothing but the number `0`. That is deliberate: it makes
 * the per-element cost as close to nil as the format allows, so what the size
 * series measures is the walker and the container handling rather than any
 * one codec. The single-value group covers the codecs themselves, one subject
 * each, and the omnibus groups cover what a mixed tree costs when escaping,
 * holes, and several codecs all appear at once.
 *
 * Every subject is built before any measurement, and no case has setup to
 * exclude, so these take the plain `fn()` form rather than bracketing with
 * `b.start()` / `b.end()`. Deno ignores that bracketing below 10µs an
 * iteration anyway, which most of these are.
 */

import { fabricFromJsonValue, jsonFromFabricValue } from "../src/codecs.ts";
import type { FabricValue } from "../src/interface.ts";
import { FabricBytes } from "../src/fabric-primitives/FabricBytes.ts";
import { FabricEpochNsec } from "../src/fabric-primitives/FabricEpochNsec.ts";
import { FabricRegExp } from "../src/fabric-primitives/FabricRegExp.ts";
import { FabricError } from "../src/fabric-instances/FabricError.ts";

//
// Subjects
//

/** Container sizes: the empty case, then five orders of magnitude. */
const SIZES = [0, 1, 10, 100, 1000, 10000, 100000] as const;

/**
 * Sizes for the sparse series. Below ten there is nothing for a gap pattern to
 * do: the generator always fills index zero, so a one-element array comes out
 * dense, and an empty one has nothing to be sparse about.
 */
const SPARSE_SIZES = SIZES.filter((size) => size >= 10);

/**
 * One subject per interesting path through the codec system: the
 * self-representing cases, the four JavaScript types JSON cannot carry, a
 * terminal and a nonterminal fabric codec, and both structural escapes.
 *
 * The two escapes are here rather than only inside the omnibus because that is
 * where a path's own cost is legible. A `/`-prefixed key alone does not settle
 * which applies: an object whose values are all plain data is quote-safe and
 * gets `/quote`, where one carrying anything that itself encodes to a tagged
 * form gets `/object` and has its entries decoded one by one.
 */
const SINGLES: readonly (readonly [string, FabricValue])[] = [
  ["null", null],
  ["number", 914],
  ["string", "a modest string"],
  ["bigint", 9_007_199_254_740_993n],
  ["special-number", Number.NaN],
  ["symbol", Symbol.for("bench.symbol")],
  ["undefined", undefined],
  ["bytes", new FabricBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))],
  ["epoch-nsec", new FabricEpochNsec(1_700_000_000_000_000_000n)],
  ["regexp", new FabricRegExp(/wildcard.*match/gi)],
  ["error", FabricError.fromNativeError(new Error("bench"))],
  [
    "quote-escape",
    Object.freeze({
      id: 914,
      label: "plain throughout, so quote-safe",
      enabled: true,
      "/looks-tagged": "escaped by `/quote`",
    }),
  ],
  [
    "object-escape",
    Object.freeze({
      id: 914,
      label: "carries a tagged value, so not quote-safe",
      when: new FabricEpochNsec(1_700_000_000_000_000_000n),
      "/looks-tagged": "escaped by `/object`",
    }),
  ],
];

/** Builds an array of `size` zeroes. */
function makeArray(size: number): FabricValue {
  return Object.freeze(new Array(size).fill(0));
}

/**
 * Builds a sparse array of `size` logical elements, with gaps that widen as
 * the array goes on.
 *
 * Runs of a single hole would be the easy shape to generate and the least
 * informative one: a run of any length costs exactly one wire entry, so
 * alternating present and absent would measure one run length over and over
 * and never exercise a large count. Widening the gaps covers the range
 * instead, from ten missing indices up to runs of thousands. (Not from one:
 * the first gap is already ten wide, `Math.max((1 * 3) - 10, 10)` having
 * floored it there. A run of a single hole is exercised by the omnibus.)
 *
 * A consequence worth expecting rather than being surprised by: gaps that
 * widen geometrically leave a count of present elements that grows with the
 * logarithm of `size`, so the decode side of this series is nearly flat across
 * the magnitudes while the encode side still scales with the index range it
 * walks. The flat column is the result to expect. Large sparse arrays ceasing
 * to decode quickly would mean a `/hole` run had stopped costing one entry,
 * which is the property this series exists to hold.
 */
function makeSparseArray(size: number): FabricValue {
  const result = new Array(size);
  let holeCount = 1;

  for (let at = 0; at < size; at += holeCount + 1) {
    result[at] = 0;
    holeCount = Math.max((holeCount * 3) - 10, 10);
  }

  return Object.freeze(result);
}

/** Builds a plain object of `size` distinct keys, every value zero. */
function makeObject(size: number): FabricValue {
  const result: Record<string, FabricValue> = {};
  for (let i = 0; i < size; i++) {
    result[`k${i}`] = 0;
  }
  return Object.freeze(result);
}

/**
 * Builds a mixed tree of roughly `leaves` leaf values: nested containers, a
 * sample of each codec, a rare array hole, and a rare `/`-prefixed key. This
 * is the shape a real payload has, where the size series above deliberately
 * has none of it.
 *
 * About one item in a hundred carries a `/`-prefixed key, which in a real
 * payload rounds to none at all; giving one to every item would measure the
 * escaping path rather than a tree that happens to contain it.
 *
 * Those rare items come in both flavors, because a `/`-prefixed key alone does
 * not settle which escaping applies. An object whose values are all plain data
 * is quote-safe and gets `/quote`; one carrying anything that itself encodes
 * to a tagged form is not, and gets `/object` with its entries decoded
 * individually. Two different paths through the walker, so both appear here --
 * and at these frequencies both appear even in the smallest tree below.
 */
function makeOmnibus(leaves: number): FabricValue {
  const items: FabricValue[] = [];
  for (let i = 0; i < leaves; i++) {
    const flavor = i % 200;

    if (flavor === 0) {
      // Plain data throughout, so this one escapes as `/quote`.
      items.push(Object.freeze({
        id: i,
        label: `item_${i}`,
        enabled: (i % 2) === 0,
        ratio: i / 7,
        nested: Object.freeze({ depth: 1, tags: Object.freeze(["a", "b"]) }),
        "/looks-tagged": "escaped by `/quote`",
      }));
      continue;
    }

    const item: Record<string, FabricValue> = {
      id: i,
      label: `item_${i}`,
      enabled: (i % 2) === 0,
      ratio: i / 7,
      missing: undefined,
      big: BigInt(i) * 1_000_000_007n,
      when: new FabricEpochNsec(BigInt(i) * 1_000_000n),
      pattern: new FabricRegExp(/x/g),
      blob: new FabricBytes(new Uint8Array([i & 0xff, (i >> 8) & 0xff])),
      nested: Object.freeze({
        depth: 1,
        // Sparse for about one item in a hundred. A hole is at least as rare
        // in a real payload as a reserved key is, so making every item carry
        // one would weight this toward a shape that does not occur.
        items: Object.freeze(
          (i % 100) === 2 ? [i, , i + 2] : [i, i + 1, i + 2],
        ),
      }),
    };

    if (flavor === 1) {
      // Carries tagged values, so this one escapes as `/object`.
      item["/looks-tagged"] = "escaped by `/object`";
    }

    items.push(Object.freeze(item));
  }

  return Object.freeze({
    kind: "omnibus",
    generated: new FabricEpochNsec(1_700_000_000_000_000_000n),
    items: Object.freeze(items),
  });
}

//
// Pre-built subjects, so that a benchmark measures only the call under test.
//

const ARRAYS = SIZES.map((size) => [size, makeArray(size)] as const);
const SPARSE = SPARSE_SIZES.map(
  (size) => [size, makeSparseArray(size)] as const,
);
const OBJECTS = SIZES.map((size) => [size, makeObject(size)] as const);
const OMNIBUSES = [10, 100, 1000].map((n) => [n, makeOmnibus(n)] as const);

/** Encoded forms, for the decode direction. */
const SINGLES_JSON = SINGLES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const ARRAYS_JSON = ARRAYS.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const SPARSE_JSON = SPARSE.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const OBJECTS_JSON = OBJECTS.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);
const OMNIBUSES_JSON = OMNIBUSES.map(([n, v]) =>
  [n, jsonFromFabricValue(v)] as const
);

/** Zero-pads a size, so that group keys sort by magnitude. */
function groupKey(prefix: string, size: number): string {
  return `${prefix}-${String(size).padStart(6, "0")}`;
}

// Warm up. Deno warms each benchmark on its own, so this is belt-and-braces
// -- but it covers the codec paths rather than only the container walks,
// since the single-value groups are measured first and are the shortest.
for (let i = 0; i < 50; i++) {
  for (const [, value] of SINGLES) {
    fabricFromJsonValue(jsonFromFabricValue(value));
  }
  fabricFromJsonValue(jsonFromFabricValue(ARRAYS[2]![1]));
  fabricFromJsonValue(jsonFromFabricValue(OBJECTS[2]![1]));
}

//
// Single values, one group per codec path
//

for (const [name, value] of SINGLES) {
  Deno.bench({
    name: `encode single-${name}`,
    group: `single-${name}`,
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [name, json] of SINGLES_JSON) {
  Deno.bench({
    name: `decode single-${name}`,
    group: `single-${name}`,
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Arrays of zeroes, by magnitude
//

for (const [size, value] of ARRAYS) {
  Deno.bench({
    name: `encode ${groupKey("array", size)}`,
    group: groupKey("array", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of ARRAYS_JSON) {
  Deno.bench({
    name: `decode ${groupKey("array", size)}`,
    group: groupKey("array", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Sparse arrays, by magnitude
//

for (const [size, value] of SPARSE) {
  Deno.bench({
    name: `encode ${groupKey("sparse", size)}`,
    group: groupKey("sparse", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of SPARSE_JSON) {
  Deno.bench({
    name: `decode ${groupKey("sparse", size)}`,
    group: groupKey("sparse", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Plain objects of zeroes, by magnitude
//

for (const [size, value] of OBJECTS) {
  Deno.bench({
    name: `encode ${groupKey("object", size)}`,
    group: groupKey("object", size),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [size, json] of OBJECTS_JSON) {
  Deno.bench({
    name: `decode ${groupKey("object", size)}`,
    group: groupKey("object", size),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}

//
// Omnibus trees
//

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `encode ${groupKey("omnibus", leaves)}`,
    group: groupKey("omnibus", leaves),
    baseline: true,
    fn() {
      jsonFromFabricValue(value);
    },
  });
}

for (const [leaves, json] of OMNIBUSES_JSON) {
  Deno.bench({
    name: `decode ${groupKey("omnibus", leaves)}`,
    group: groupKey("omnibus", leaves),
    fn() {
      fabricFromJsonValue(json);
    },
  });
}
