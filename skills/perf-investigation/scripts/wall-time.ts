#!/usr/bin/env -S deno run --allow-read
/**
 * Where a run's elapsed time went, as opposed to where its CPU went.
 *
 * `aggregate-measures.ts` sums spans, which is the right arithmetic for CPU and
 * the wrong one for wall time: concurrent spans overlap, so a parent's elapsed
 * time is not the total of its children's, and adding them up can exceed the
 * run itself. Wall time asks a different question — how much of a span's
 * elapsed time is accounted for by anything at all?
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

export function descendants(
  children: Map<number, number[]>,
  index: number,
): number[] {
  const out: number[] = [];
  const stack = [...(children.get(index) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    out.push(next);
    const kids = children.get(next);
    if (kids) stack.push(...kids);
  }
  return out;
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
  const inner = descendants(children, index);
  if (inner.length === 0) return [];
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
  for (const index of children.keys()) {
    if (focus === undefined || spans[index].key === focus) {
      measurable.push(index);
    }
  }

  if (measurable.length === 0) {
    console.error(
      focus === undefined
        ? "No span in this capture has children, so nothing can be accounted for."
        : `No span named ${focus} has children. Only a span with children has a` +
          ` gap: a leaf's whole duration is itself.`,
    );
    Deno.exit(1);
  }

  const rows = measurable
    .map((index) => {
      const wall = spans[index].end - spans[index].start;
      const covered = unionLength(
        descendants(children, index).map((i) => spans[i]),
      );
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
