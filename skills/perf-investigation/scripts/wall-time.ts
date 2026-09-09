#!/usr/bin/env -S deno run --allow-read

/**
 * Where a run's elapsed time went, and how much of it nothing accounts for.
 *
 * Every measure is an elapsed start-to-end duration, so summing them — which is
 * what `aggregate-measures.ts` does — gives cumulative elapsed span time. That
 * is a useful figure and it is not CPU: it already contains whatever a span
 * waited through, and a nested span counts the same interval again inside its
 * parent. CPU attribution comes from a sampling profile, not from these.
 *
 * Wall time asks the question summing cannot: how much of a span's elapsed time
 * is accounted for by anything at all?
 *
 * The answer is coverage: the UNION of the intervals beneath a span, against
 * that span's own duration. What is left over is time the span was open and
 * nothing instrumented was running. That is the shape of waiting — for a
 * server, for a timer, for a lock, or for work nobody has wrapped yet — and it
 * is invisible to every view that sums.
 *
 *   deno run --allow-read wall-time.ts measures.json
 *   deno run --allow-read wall-time.ts measures.json --min=20
 *   deno run --allow-read wall-time.ts measures.json --key=runTestPattern/compile
 *
 * A gap is not automatically a problem, and the tool cannot tell you which kind
 * you have: unwrapped compute and a blocking round trip look identical from
 * here. What it can do is say where to look, and how much is at stake.
 */

import { buildForest, loadMeasures, type Span } from "./measure-forest.ts";

/**
 * The length of what a set of intervals covers between them.
 *
 * Never their sum. Two spans that ran concurrently cover the wider of the two,
 * not both added together, and summing is what makes a naive wall-time report
 * claim more time than the run contains.
 */
export function unionLength(
  intervals: readonly { start: number; end: number }[],
): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  let total = 0;
  let start = sorted[0].start;
  let end = sorted[0].end;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start > end) {
      total += end - start;
      start = sorted[i].start;
      end = sorted[i].end;
    } else if (sorted[i].end > end) end = sorted[i].end;
  }
  return total + (end - start);
}

/** Index every span's children once, for walking down. */
export function childrenOf(spans: readonly Span[]): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (let i = 0; i < spans.length; i++) {
    const parent = spans[i].parent;
    if (parent === -1) continue;
    const list = children.get(parent);
    if (list) list.push(i);
    else children.set(parent, [i]);
  }
  return children;
}

/**
 * What a span's children cover between them — which is what its whole subtree
 * covers.
 *
 * `buildForest` only makes a span a parent when it contains the child, so each
 * child already covers everything beneath it and the grandchildren add nothing
 * to the union. Walking the subtree would recompute that for every span and
 * make this quadratic on exactly the deep captures it exists to read.
 */
export function coveredBy(
  spans: readonly Span[],
  children: Map<number, number[]>,
  index: number,
): number {
  const kids = children.get(index);
  return kids === undefined ? 0 : unionLength(kids.map((i) => spans[i]));
}

/**
 * The stretches inside a span during which nothing beneath it was running.
 *
 * A span with no children has none. Its whole duration is time something was
 * running — itself — and reporting that as waiting would make every leaf in the
 * capture look like the thing to investigate.
 */
export function gapsIn(
  spans: readonly Span[],
  children: Map<number, number[]>,
  index: number,
): { start: number; end: number }[] {
  const inner = children.get(index);
  if (inner === undefined || inner.length === 0) return [];
  const sorted = inner.map((i) => spans[i]).sort((a, b) => a.start - b.start);
  const gaps: { start: number; end: number }[] = [];
  let cursor = spans[index].start;
  for (const child of sorted) {
    if (child.start > cursor) gaps.push({ start: cursor, end: child.start });
    if (child.end > cursor) cursor = child.end;
  }
  if (spans[index].end > cursor) {
    gaps.push({ start: cursor, end: spans[index].end });
  }
  return gaps;
}

function flag(name: string): string | undefined {
  const hit = Deno.args.find((arg) => arg.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

if (import.meta.main) {
  const path = Deno.args.find((arg) => !arg.startsWith("--"));
  const focus = flag("key");
  const minMs = Number(flag("min") ?? "5");

  const spans = buildForest(await loadMeasures(path));
  const children = childrenOf(spans);

  const measurable: number[] = [];
  const leaves: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    if (focus !== undefined && spans[i].key !== focus) continue;
    if (children.has(i)) measurable.push(i);
    else leaves.push(i);
  }

  if (measurable.length === 0 && leaves.length === 0) {
    console.error(
      focus === undefined
        ? "This capture holds no spans."
        : `No span named ${focus} is in this capture.`,
    );
    Deno.exit(1);
  }

  const rows = measurable
    .map((index) => {
      const wall = spans[index].end - spans[index].start;
      const covered = coveredBy(spans, children, index);
      return { index, wall, covered, gap: wall - covered };
    })
    .filter((row) => row.gap >= minMs)
    .sort((a, b) => b.gap - a.gap);

  console.log(
    `${spans.length} spans; ${children.size} have children and can be ` +
      `accounted for.\n`,
  );
  if (rows.length === 0) {
    console.log(`No span is unaccounted for by ${minMs}ms or more.`);
  } else {
    console.log("     wall    covered       gap   gap%  key");
    for (const row of rows.slice(0, 20)) {
      console.log(
        `${row.wall.toFixed(0).padStart(9)} ${
          row.covered.toFixed(0).padStart(10)
        } ${row.gap.toFixed(0).padStart(9)} ${
          ((row.gap / row.wall) * 100).toFixed(0).padStart(5)
        }%  ${spans[row.index].key}`,
      );
    }
  }

  // What ended immediately before each stretch. A gap that always follows the
  // same span is a handoff to something nobody wrapped — often the thing being
  // waited for.
  const byEnd = spans.map((_, i) => i).sort((a, b) =>
    spans[a].end - spans[b].end
  );
  const ends = byEnd.map((i) => spans[i].end);
  const endedBefore = (time: number): string => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ends[mid] <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? "(nothing)" : spans[byEnd[lo - 1]].key;
  };

  const stretches: { ms: number; inside: string; after: string }[] = [];
  for (const index of measurable) {
    for (const gap of gapsIn(spans, children, index)) {
      const ms = gap.end - gap.start;
      if (ms < minMs) continue;
      stretches.push({
        ms,
        inside: spans[index].key,
        after: endedBefore(gap.start),
      });
    }
  }
  stretches.sort((a, b) => b.ms - a.ms);

  // A leaf has no gap to compute — nothing is nested inside it — but that does
  // not make it busy. A span wrapping a single request, timer, or lock emits no
  // children and is pure waiting, which is exactly what this view hunts, so
  // suppressing leaves would hide the clearest case of all.
  if (leaves.length > 0) {
    const longest = leaves
      .map((i) => ({ i, ms: spans[i].end - spans[i].start }))
      .filter((row) => row.ms >= minMs)
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 10);
    if (longest.length > 0) {
      console.log(
        "\nlongest spans with nothing nested inside them:",
      );
      console.log("       ms  key");
      for (const row of longest) {
        console.log(
          `${row.ms.toFixed(0).padStart(9)}  ${spans[row.i].key}`,
        );
      }
      console.log(
        "\nNothing here distinguishes one that computed for that long from " +
          "one that\nwaited. A span wrapping a request looks identical to a " +
          "tight loop; what\nseparates them is a span inside it.",
      );
    }
  }

  if (stretches.length > 0) {
    console.log("\nlongest stretches with nothing instrumented running:");
    console.log("       ms  inside                          after");
    for (const stretch of stretches.slice(0, 15)) {
      console.log(
        `${stretch.ms.toFixed(0).padStart(9)}  ${
          stretch.inside.slice(0, 30).padEnd(30)
        }  ${stretch.after.slice(0, 36)}`,
      );
    }
    console.log(
      "\nA stretch that keeps following the same span is the one to chase: " +
        "that\nspan handed off to something nobody wrapped. Whether it is a " +
        "round trip\nor uninstrumented compute is the next question, and this " +
        "view cannot\nanswer it — wrapping what follows is what does.",
    );
  }
}
