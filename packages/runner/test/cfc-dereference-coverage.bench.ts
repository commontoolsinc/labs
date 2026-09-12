/**
 * Benchmarks for the dereference-coverage query at CFC commit preparation.
 *
 * `forEachFlowObservation` asks, once per read activity in a transaction,
 * whether a recorded dereference covers that read. It runs on every reactive
 * action commit, so the query's cost is multiplied by both how many reads a
 * transaction journals and how many traces it recorded. On the unified-inbox
 * pattern that reached 249 sources for one document against hundreds of reads,
 * and the linear form of this query was 31% of the runtime worker's non-idle
 * CPU — the largest single frame in opening an already-loaded thread.
 *
 * What these guard is the shape of the curve rather than one number: the index
 * costs the query path's length, so its figures stay flat as the source count
 * rises while the scan's climb with it. A regression that reintroduced a
 * per-source pass would show as `sources=256` drifting toward the scan's line
 * while `sources=16` stayed put.
 *
 * The crossover is real and worth keeping in view: at small source counts the
 * index is SLOWER, because building it is a fixed cost the scan does not pay.
 * Where that crossover sits moves with the machine — on a quiet one it is
 * under 64 sources, on a loaded one it has been seen above it — so these
 * benchmarks are read as two lines whose slopes differ, not as absolute
 * figures. The index pays for itself by the transaction's read count rather
 * than by its trace count, since it is built once per
 * `forEachFlowObservation` call and consulted once per read, so a transaction
 * with many traces and only a handful of reads is the shape that would not
 * benefit. The `build` group keeps that end of the trade visible.
 *
 * The wildcard group is the index's worst case and the reason it declines it.
 * A `"*"` in the QUERY follows every child at that depth, which made the
 * frontier as wide as the set and measured 730x slower than the scan before
 * `hasPrefixOf` learned to hand those queries to the scan instead. This group
 * is what keeps that fallback honest: the two lines should stay level.
 *
 * The `benchmarks.yml` workflow runs this file on main and publishes the
 * results in its `bench-results` artifact, which the team ops dashboard charts
 * on its /bench page.
 */

import { PathPrefixIndex } from "../src/cfc/path-prefix-index.ts";

/** The predicate the index replaces, kept here to bench the two side by side. */
const isPrefix = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

/**
 * Trace sources shaped like the ones a rendered list produces: a common root,
 * a per-element branch, and a leaf under it. The last few carry a `"*"`, which
 * is the segment both sides have to treat as matching anything.
 */
function sources(count: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const wild = i % 32 === 31;
    out.push([
      "value",
      "threads",
      String(i),
      wild ? "*" : "msgs",
      String(i % 7),
    ]);
  }
  return out;
}

/**
 * Read paths in the proportion a commit journals them: most miss every source
 * outright, some land under one, and a few are shorter than any source and so
 * can only miss. A query set that always hit would flatter the index, whose
 * advantage is partly in failing fast.
 */
function queries(count: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    const kind = i % 4;
    if (kind === 0) {
      out.push(["value", "threads", String(i), "msgs", String(i % 7), "body"]);
    } else if (kind === 1) {
      out.push(["value", "sources", String(i), "rows"]);
    } else if (kind === 2) {
      out.push(["value", "threads", String(i)]);
    } else {
      out.push(["value", "threads", String(i), "title", "text"]);
    }
  }
  return out;
}

const QUERIES = queries(64);

// ────────────────────────────────────────────────────────────────────────
// Dereference coverage
//
// One group per source-set size, so the dashboard charts the index and the
// scan against each other at that size rather than across sizes.
// ────────────────────────────────────────────────────────────────────────

function indexOf(set: readonly string[][]): PathPrefixIndex {
  const index = new PathPrefixIndex();
  for (const source of set) index.add(source);
  return index;
}

for (const count of [16, 64, 256]) {
  const set = sources(count);
  const index = indexOf(set);

  Deno.bench({
    name: `index, sources=${count}`,
    group: `dereference coverage sources=${count}`,
    baseline: true,
    fn: () => {
      let hits = 0;
      for (const path of QUERIES) if (index.hasPrefixOf(path)) hits++;
      if (hits < 0) throw new Error("unreachable");
    },
  });

  Deno.bench({
    name: `linear scan, sources=${count}`,
    group: `dereference coverage sources=${count}`,
    fn: () => {
      let hits = 0;
      for (const path of QUERIES) {
        if (set.some((source) => isPrefix(source, path))) hits++;
      }
      if (hits < 0) throw new Error("unreachable");
    },
  });
}

// ────────────────────────────────────────────────────────────────────────
// Wildcard queries
//
// A `"*"` in the QUERY follows every child at that depth, which is the one
// shape that can widen the index's frontier toward the source count. These
// queries are all wildcard at the branching segment — the worst case, not a
// representative one — so the pair says whether the index still holds its
// advantage where it is least suited.
// ────────────────────────────────────────────────────────────────────────

const WILD_QUERIES = Array.from(
  { length: 64 },
  (_, i) => ["value", "threads", "*", "msgs", String(i % 7)],
);

for (const count of [256]) {
  const set = sources(count);
  const index = indexOf(set);

  Deno.bench({
    name: `index, wildcard query, sources=${count}`,
    group: `dereference coverage wildcard sources=${count}`,
    baseline: true,
    fn: () => {
      let hits = 0;
      for (const path of WILD_QUERIES) if (index.hasPrefixOf(path)) hits++;
      if (hits < 0) throw new Error("unreachable");
    },
  });

  Deno.bench({
    name: `linear scan, wildcard query, sources=${count}`,
    group: `dereference coverage wildcard sources=${count}`,
    fn: () => {
      let hits = 0;
      for (const path of WILD_QUERIES) {
        if (set.some((source) => isPrefix(source, path))) hits++;
      }
      if (hits < 0) throw new Error("unreachable");
    },
  });
}

// ────────────────────────────────────────────────────────────────────────
// Building the index
//
// The index is built once per `forEachFlowObservation` call and consulted once
// per read, so a build cost that grew faster than the queries it serves would
// undo the change at small transaction sizes.
// ────────────────────────────────────────────────────────────────────────

for (const count of [16, 256]) {
  const set = sources(count);
  Deno.bench({
    name: `build, sources=${count}`,
    group: "dereference coverage build",
    fn: () => {
      const index = new PathPrefixIndex();
      for (const source of set) index.add(source);
      if (!index.hasPrefixOf(["value", "threads", "0", "msgs", "0"])) {
        throw new Error("unreachable");
      }
    },
  });
}
