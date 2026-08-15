/**
 * Realm-crossing codec performance benchmarks, encoding and decoding.
 *
 * Run with:
 *
 *     deno bench --no-check bench/codec-realm.bench.ts
 *
 * The subjects come from `fixtures/codec-fixtures.ts`, the same ones
 * `codec-json.bench.ts` measures, so the two tables line up subject for
 * subject: a row here and the row named for the same subject there differ by
 * the format and nothing else. Names carry a `realm-` prefix so that a run
 * covering both files keeps them apart.
 *
 * Two series carry most of what this format is for. `pass-through` holds only
 * values structured cloning takes directly, so encoding returns the tree by
 * identity and the walk is the whole cost; `json-pass-through` holds only what
 * JSON also takes directly. The gap between those two rows, read against the
 * same two rows in the JSON table, is what a second format buys.
 *
 * **A payload carrying bytes decodes exactly once.** `decode()` cedes its
 * input, and `FabricBytes` takes over the `ArrayBuffer` it arrived in, which
 * detaches it -- so a second decode of the same tree throws. That is by
 * design, the tree across a real boundary being the receiver's own clone, and
 * it decides the shape of the decode direction here:
 *
 * * Subjects that survive repeated decoding take the plain `fn()` form.
 * * The omnibus subjects hold a `FabricBytes`, so each iteration encodes a
 *   fresh tree outside `b.start()` / `b.end()` and measures only the decode.
 *   Deno honors that bracketing when an iteration averages at least 10µs and
 *   warns when it does not; these are far above it, but that is a fact about
 *   this machine rather than about the subjects, so read the warnings.
 * * `single-bytes` is too small for bracketing to be honored, so it appears as
 *   a `round-trip` row instead -- named for what it measures rather than
 *   reported as a decode that is really an encode and a decode.
 */

import { fabricFromRealmValue, realmFromFabricValue } from "../src/codecs.ts";
import type { FabricValue } from "../src/interface.ts";
import {
  ARRAYS,
  groupKey,
  JSON_PASS_THROUGH_OMNIBUSES,
  OBJECTS,
  OMNIBUSES,
  REALM_PASS_THROUGH_OMNIBUSES,
  SINGLES,
  SPARSE,
} from "./fixtures/codec-fixtures.ts";

/** Subjects whose encoded form holds a byte buffer, so decodes only once. */
const SINGLE_SHOT = new Set(["bytes"]);

/** Encoded forms, for the decode direction of every repeat-safe subject. */
const SINGLES_REALM = SINGLES
  .filter(([name]) => !SINGLE_SHOT.has(name))
  .map(([n, v]) => [n, realmFromFabricValue(v)] as const);
const ARRAYS_REALM = ARRAYS.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const SPARSE_REALM = SPARSE.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const OBJECTS_REALM = OBJECTS.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const JSON_PASS_THROUGH_REALM = JSON_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);
const REALM_PASS_THROUGH_REALM = REALM_PASS_THROUGH_OMNIBUSES.map(([n, v]) =>
  [n, realmFromFabricValue(v)] as const
);

/** Prefixes a group key, so a run over both formats keeps the rows apart. */
function realmKey(prefix: string, size: number): string {
  return `realm-${groupKey(prefix, size)}`;
}

// Warm up, over the codec paths as much as the container walks.
for (let i = 0; i < 50; i++) {
  for (const [name, value] of SINGLES) {
    const encoded = realmFromFabricValue(value);
    if (!SINGLE_SHOT.has(name)) {
      fabricFromRealmValue(encoded);
    }
  }
  fabricFromRealmValue(realmFromFabricValue(ARRAYS[2]![1]));
  fabricFromRealmValue(realmFromFabricValue(OBJECTS[2]![1]));
}

//
// Single values, one group per codec path
//

for (const [name, value] of SINGLES) {
  Deno.bench({
    name: `encode realm-single-${name}`,
    group: `realm-single-${name}`,
    baseline: true,
    fn() {
      realmFromFabricValue(value);
    },
  });
}

for (const [name, encoded] of SINGLES_REALM) {
  Deno.bench({
    name: `decode realm-single-${name}`,
    group: `realm-single-${name}`,
    fn() {
      fabricFromRealmValue(encoded);
    },
  });
}

// The one subject whose encoded form cannot be decoded twice, measured as the
// round trip it has to be rather than reported as a decode.
for (const [name, value] of SINGLES) {
  if (!SINGLE_SHOT.has(name)) {
    continue;
  }

  Deno.bench({
    name: `round-trip realm-single-${name}`,
    group: `realm-single-${name}`,
    fn() {
      fabricFromRealmValue(realmFromFabricValue(value));
    },
  });
}

//
// Containers by magnitude: arrays of zeroes, sparse arrays, plain objects
//

const SERIES: readonly (readonly [
  string,
  readonly (readonly [number, FabricValue])[],
  readonly (readonly [number, unknown])[],
])[] = [
  ["array", ARRAYS, ARRAYS_REALM],
  ["sparse", SPARSE, SPARSE_REALM],
  ["object", OBJECTS, OBJECTS_REALM],
  ["json-pass-through", JSON_PASS_THROUGH_OMNIBUSES, JSON_PASS_THROUGH_REALM],
  ["pass-through", REALM_PASS_THROUGH_OMNIBUSES, REALM_PASS_THROUGH_REALM],
];

for (const [prefix, subjects, encodedForms] of SERIES) {
  for (const [size, value] of subjects) {
    Deno.bench({
      name: `encode ${realmKey(prefix, size)}`,
      group: realmKey(prefix, size),
      baseline: true,
      fn() {
        realmFromFabricValue(value);
      },
    });
  }

  for (const [size, encoded] of encodedForms) {
    Deno.bench({
      name: `decode ${realmKey(prefix, size)}`,
      group: realmKey(prefix, size),
      fn() {
        fabricFromRealmValue(encoded as never);
      },
    });
  }
}

//
// Omnibus trees. These hold a `FabricBytes`, so the decode direction builds a
// fresh tree per iteration and excludes it from the measurement.
//

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `encode ${realmKey("omnibus", leaves)}`,
    group: realmKey("omnibus", leaves),
    baseline: true,
    fn() {
      realmFromFabricValue(value);
    },
  });
}

for (const [leaves, value] of OMNIBUSES) {
  Deno.bench({
    name: `decode ${realmKey("omnibus", leaves)}`,
    group: realmKey("omnibus", leaves),
    fn(b) {
      const encoded = realmFromFabricValue(value);

      b.start();
      fabricFromRealmValue(encoded);
      b.end();
    },
  });
}
