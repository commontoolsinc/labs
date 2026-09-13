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
 * The index pays for itself by the transaction's read count rather than by its
 * trace count — it is built once per `forEachFlowObservation` call and
 * consulted once per read — so a transaction with many traces and only a
 * handful of reads is the shape that would not benefit. The `build` group keeps
 * that end of the trade visible.
 *
 * The wildcard group is what the index declines. A `"*"` on either side turns
 * the walk into a search, so a wildcard query, or a set holding one wildcard
 * source, takes the scan; this group is both at once and guards that declining
 * costs no more than never having indexed.
 *
 * The `benchmarks.yml` workflow runs this file on main and publishes the
 * results in its `bench-results` artifact, which the team ops dashboard charts
 * on its /bench page.
 */

import { isPrefix, PathPrefixIndex } from "../src/cfc/path-prefix-index.ts";

/**
 * Trace sources shaped like the ones a rendered list produces: a common root,
 * a per-element branch, and a leaf under it.
 *
 * Concrete, because that is what a dereference trace records — its source is a
 * real link's address (`cfcAddressFromLink`). The `"*"` segment belongs to
 * label-map ENTRY paths, which is why `isPrefix` handles it and why the
 * wildcard groups below construct it deliberately rather than finding it here.
 */
function sources(count: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < count; i++) {
    out.push(["value", "threads", String(i), "msgs", String(i % 7)]);
  }
  return out;
}

/** The same set with a wildcard source, which the index declines outright. */
function wildcardSources(count: number): string[][] {
  const out = sources(count);
  out[out.length - 1] = ["value", "threads", "*", "msgs", "0"];
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
// A `"*"` on either side turns the walk into a search, so the index declines
// both: a wildcard query, and a set holding a wildcard source. This group is
// both at once — the shape the index is worst suited to — and what it guards is
// that declining costs no more than never having indexed at all.
// ────────────────────────────────────────────────────────────────────────

const WILD_QUERIES = Array.from(
  { length: 64 },
  (_, i) => ["value", "threads", "*", "msgs", String(i % 7)],
);

for (const count of [256]) {
  const set = wildcardSources(count);
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
