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
 * rises while the scan's climb with it. Measured on one machine at 64 queries:
 * the index holds at 8.0µs for 64 sources and 8.4µs for 256, while the scan
 * goes 4.9µs, 18.2µs, 75.9µs across 16, 64 and 256. A regression that
 * reintroduced a per-source pass would show as `sources=256` drifting toward
 * the scan's line while `sources=16` stayed put.
 *
 * The crossover is real and worth keeping in view: at 16 sources the index is
 * about a tenth SLOWER than the scan, because building it is a fixed cost the
 * scan does not pay. It pays for itself by the transaction's read count rather
 * than by its trace count — the index is built once per
 * `forEachFlowObservation` call and consulted once per read — so a transaction
 * with many traces and only a handful of reads is the shape that would not
 * benefit. The `build` group is here to keep that end of the trade visible.
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

for (const count of [16, 64, 256]) {
  const set = sources(count);
  const index = new PathPrefixIndex();
  for (const source of set) index.add(source);

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
