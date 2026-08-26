#!/usr/bin/env -S deno run --allow-read

/**
 * Ask who called a key, using the containment forest in `measure-forest.ts`.
 *
 * `aggregate-measures.ts` answers "where did the time go" by rolling spans up
 * along their own key paths. This answers the question that follows it: a key
 * that runs hundreds of thousands of times is recorded against itself no matter
 * who asked, so its own row cannot say which caller is responsible.
 *
 *   # who calls tx/read, innermost caller first
 *   deno run --allow-read attribute-measures.ts measures.json --key=tx/read
 *
 *   # of those, the ones that go through traverse: what is above it, and how
 *   # many reads each traverse issues
 *   deno run --allow-read attribute-measures.ts measures.json --key=tx/read --via=traverse
 *
 *   # and who calls the heavy ones specifically — usually not the same answer
 *   deno run --allow-read attribute-measures.ts measures.json --key=tx/read --via=traverse --heavy=1000
 *
 *   # which occurrences a key's spans were, where the emitter named them
 *   deno run --allow-read attribute-measures.ts measures.json --key=scheduler/run/action --detail
 *
 *   # the most common full call chains
 *   deno run --allow-read attribute-measures.ts measures.json --key=tx/read --chains
 *
 *   # where to add the next span, for the ones nothing encloses
 *   deno run --allow-read attribute-measures.ts measures.json --key=traverse --roots
 *   #   ...ignoring a key so frequent it is always the nearest thing to end
 *   deno run --allow-read attribute-measures.ts measures.json --key=traverse --roots --ignore=tx/read
 *
 * Read the `--via` table for the ratio rather than the totals. A caller with
 * few parent spans and many children each is a width problem — one call doing
 * too much — and is fixed differently from a caller with many parent spans
 * doing a little each, which is a frequency problem.
 */
import {
  ancestors,
  buildForest,
  callerOf,
  collapseRepeats,
  detailOf,
  keyOf,
  loadMeasures,
  type MeasureEntry,
} from "./measure-forest.ts";

function flag(name: string): string | undefined {
  const hit = Deno.args.find((arg) => arg.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const path = Deno.args.find((arg) => !arg.startsWith("--"));
const target = flag("key");
const via = flag("via");
const heavy = Number(flag("heavy") ?? "0");
const wantChains = Deno.args.includes("--chains");
const wantDetail = Deno.args.includes("--detail");
const wantRoots = Deno.args.includes("--roots");
const ignored = new Set((flag("ignore") ?? "").split(",").filter(Boolean));

if (!target) {
  console.error(
    "Pass the key to attribute, e.g. --key=tx/read. " +
      "A measures file is read from the first argument, or from stdin.",
  );
  Deno.exit(1);
}

const entries = await loadMeasures(path);
const spans = buildForest(entries);
const hits: number[] = [];
for (let i = 0; i < spans.length; i++) {
  if (spans[i].key === target) hits.push(i);
}

if (hits.length === 0) {
  console.error(
    `No spans named ${target}. Keys are logger paths, e.g. cell/get.`,
  );
  Deno.exit(1);
}

const totalMs = hits.reduce(
  (sum, i) => sum + (spans[i].end - spans[i].start),
  0,
);
console.log(`${target}: ${hits.length} spans, ${totalMs.toFixed(0)}ms total`);

const ROOT = "(root — no instrumented span above)";

if (wantDetail) {
  // Read from the entries rather than the forest: a detail names an occurrence
  // and the forest keeps only what containment needs, which is the key.
  const byDetail = new Map<string, { n: number; ms: number }>();
  let unnamed = 0;
  for (const entry of entries as MeasureEntry[]) {
    if (keyOf(entry.name) !== target) continue;
    const detail = detailOf(entry.name);
    if (detail === undefined) {
      unnamed++;
      continue;
    }
    const row = byDetail.get(detail) ?? { n: 0, ms: 0 };
    row.n++;
    row.ms += entry.duration;
    byDetail.set(detail, row);
  }
  if (byDetail.size === 0) {
    console.log(
      `\nNo span of ${target} carries a detail. Only some keys name their ` +
        `occurrences — \`scheduler/run/action\` names the action that ran.`,
    );
  } else {
    console.log(`\n  spans       ms   ms each  which occurrence`);
    for (
      const [detail, row] of [...byDetail].sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 25)
    ) {
      console.log(
        `${String(row.n).padStart(7)} ${row.ms.toFixed(0).padStart(8)} ${
          (row.ms / row.n).toFixed(2).padStart(9)
        }  ${detail}`,
      );
    }
    if (unnamed > 0) console.log(`\n${unnamed} span(s) carried no detail.`);
  }
} else if (wantRoots) {
  // A root is an honest answer — the span ran outside every instrumented
  // region — but it is not a useful one on its own. These two views turn it
  // into a place to put the next span, from data already in hand.
  const roots = hits.filter((i) => callerOf(spans, i) === undefined);
  console.log(
    `\n${roots.length} of ${hits.length} ${target} spans have no ` +
      `instrumented caller.`,
  );
  if (roots.length === 0) {
    console.log("Nothing to locate: every span already sits inside a span.");
  } else {
    // The harness phases are transparent to attribution on purpose, but for a
    // span nothing else encloses they are the only thing that locates it.
    const byAny = new Map<string, number>();
    for (const i of roots) {
      const parent = spans[i].parent;
      byAny.set(
        parent === -1 ? "(nothing at all)" : spans[parent].key,
        (byAny.get(parent === -1 ? "(nothing at all)" : spans[parent].key) ??
          0) + 1,
      );
    }
    console.log("\nwhat encloses them once nothing is treated as transparent:");
    for (
      const [key, n] of [...byAny].sort((a, b) => b[1] - a[1]).slice(0, 12)
    ) {
      console.log(`  ${String(n).padStart(7)}  ${key}`);
    }

    // What finished immediately before. A shared predecessor across many roots
    // is a caller nobody wrapped: it ran, returned, and the work followed it.
    const ends = spans.map((_, i) => i).sort((a, b) =>
      spans[a].end - spans[b].end
    );
    const endTimes = ends.map((i) => spans[i].end);
    const before = new Map<string, number>();
    for (const i of roots) {
      const t = spans[i].start;
      let lo = 0, hi = endTimes.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (endTimes[mid] <= t) lo = mid + 1;
        else hi = mid;
      }
      let label = "(nothing before)";
      for (let j = lo - 1; j >= 0; j--) {
        const candidate = spans[ends[j]];
        // Top level in the same sense the root count uses — no *instrumented*
        // caller — rather than no parent at all. A span whose only parent is a
        // transparent harness phase is top level for this purpose, and reading
        // the raw parent here would have discarded exactly the handoffs worth
        // finding, since a rootless target usually sits inside such a phase.
        if (candidate.key === target || ignored.has(candidate.key)) continue;
        if (callerOf(spans, ends[j]) !== undefined) continue;
        label = candidate.key;
        break;
      }
      before.set(label, (before.get(label) ?? 0) + 1);
    }
    console.log(
      `\nwhat finished most recently before each began` +
        `${
          ignored.size === 0
            ? " (ignoring nothing)"
            : ` (ignoring ${[...ignored].join(", ")})`
        }:`,
    );
    for (
      const [key, n] of [...before].sort((a, b) => b[1] - a[1]).slice(0, 12)
    ) {
      console.log(`  ${String(n).padStart(7)}  ${key}`);
    }
    // No attempt to flag which name is noise: a key that dominates because it
    // is emitted constantly and one that dominates because it really is the
    // handoff look identical from here, and guessing wrong would point an
    // investigation at the wrong place with a confident-sounding label.
    console.log(
      "\nA name concentrated in both views is where a span would attribute " +
        "the\nmost, and the two disagreeing is worth more than either alone: " +
        "one says\nwhen in the run, the other says what handed off to it.",
    );
    console.log(
      "\nA key emitted constantly is always the nearest thing to have ended, " +
        "so it\ncrowds this column without handing off to anything. Pass " +
        "--ignore=a,b to\ndrop such a key and see what is behind it.",
    );
  }
} else if (wantChains) {
  const chains = new Map<string, number>();
  for (const i of hits) {
    // Aggregate on the whole chain; truncating first would merge callers that
    // differ only above the cut and report them as one.
    const chain = collapseRepeats(ancestors(spans, i));
    const sig = chain.length ? chain.join("  <  ") : ROOT;
    chains.set(sig, (chains.get(sig) ?? 0) + 1);
  }
  console.log("\nmost common chains (innermost first):");
  for (
    const [chain, n] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 15)
  ) {
    // Truncate for the eye only, after the counting is done.
    const parts = chain.split("  <  ");
    // Name the outermost link as well as the count, so two chains that were
    // counted separately do not print as the same row.
    const shown = parts.length > 5
      ? `${parts.slice(0, 5).join("  <  ")}  <  …(+${
        parts.length - 5
      }, outermost ${parts[parts.length - 1]})`
      : chain;
    console.log(`  ${String(n).padStart(8)}  ${shown}`);
  }
} else if (via) {
  // Every `via` span, with how many target spans it directly contains and what
  // called it. The ratio is the point; the totals only say where to look.
  const perParent = new Map<number, number>();
  for (const i of hits) {
    // The nearest enclosing `via`, not the immediate parent: an instrumented
    // span sitting between the two is common, and counting only direct
    // children would report zero for a call that plainly runs inside it.
    for (let p = spans[i].parent; p !== -1; p = spans[p].parent) {
      if (spans[p].key === via) {
        perParent.set(p, (perParent.get(p) ?? 0) + 1);
        break;
      }
    }
  }
  const byCaller = new Map<
    string,
    { parents: number; children: number; ms: number; max: number }
  >();
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].key !== via) continue;
    const caller = callerOf(spans, i) ?? ROOT;
    const children = perParent.get(i) ?? 0;
    const row = byCaller.get(caller) ??
      { parents: 0, children: 0, ms: 0, max: 0 };
    row.parents++;
    row.children += children;
    row.ms += spans[i].end - spans[i].start;
    if (children > row.max) row.max = children;
    byCaller.set(caller, row);
  }
  // How lopsided the distribution is. A handful of parents holding most of the
  // children is the single most useful thing this can say: it means the fix is
  // aimed at those instances rather than at the call site in general.
  const counts = [...perParent.values()].sort((a, b) => b - a);
  const viaTotal = spans.filter((sp) => sp.key === via).length;
  const childTotal = counts.reduce((a, b) => a + b, 0);
  if (childTotal > 0) {
    const buckets: [string, number, number][] = [
      ["1000+", 1000, Infinity],
      ["300-999", 300, 1000],
      ["100-299", 100, 300],
      ["10-99", 10, 100],
      ["1-9", 1, 10],
    ];
    console.log(`\nhow ${target} is spread across ${via} spans:`);
    console.log(`  ${target} each      ${via}     ${target}    share`);
    let covered = 0;
    for (const [label, lo, hi] of buckets) {
      const inB = counts.filter((c) => c >= lo && c < hi);
      if (inB.length === 0) continue;
      const sum = inB.reduce((a, b) => a + b, 0);
      covered += inB.length;
      console.log(
        `  ${label.padEnd(12)} ${String(inB.length).padStart(9)} ${
          String(sum).padStart(9)
        } ${((sum / childTotal * 100).toFixed(1) + "%").padStart(8)}`,
      );
    }
    const idle = viaTotal - covered;
    if (idle > 0) {
      console.log(
        `  ${"none".padEnd(12)} ${String(idle).padStart(9)} ${
          "0".padStart(9)
        } ${"0.0%".padStart(8)}`,
      );
    }
  }

  console.log(`\nvia ${via} — one row per caller of ${via}:`);
  console.log(
    `  ${via}    ${target}   per ${via}    max      ms  caller`,
  );
  for (
    const [caller, row] of [...byCaller].sort((a, b) =>
      b[1].children - a[1].children
    ).slice(0, 15)
  ) {
    const per = row.parents === 0 ? 0 : row.children / row.parents;
    console.log(
      `${String(row.parents).padStart(9)} ${String(row.children).padStart(9)} ${
        per.toFixed(1).padStart(11)
      } ${String(row.max).padStart(6)} ${
        row.ms.toFixed(0).padStart(7)
      }  ${caller}`,
    );
  }
  if (heavy > 0) {
    // The callers of the heavy instances specifically, which are usually not
    // the callers of the call site in general.
    const chains = new Map<string, { n: number; children: number }>();
    for (const [parent, children] of perParent) {
      if (children < heavy) continue;
      const chain = collapseRepeats(ancestors(spans, parent)).slice(0, 4);
      const sig = chain.length ? chain.join("  <  ") : ROOT;
      const row = chains.get(sig) ?? { n: 0, children: 0 };
      row.n++;
      row.children += children;
      chains.set(sig, row);
    }
    console.log(
      `\ncallers of ${via} spans with ${heavy}+ ${target} ` +
        `(${[...chains.values()].reduce((a, b) => a + b.n, 0)} of them):`,
    );
    for (
      const [sig, row] of [...chains].sort((a, b) =>
        b[1].children - a[1].children
      )
    ) {
      console.log(
        `  ${String(row.n).padStart(5)} ${via}  ${
          String(row.children).padStart(8)
        } ${target}   ${sig}`,
      );
    }
  }
} else {
  const byCaller = new Map<string, { n: number; ms: number }>();
  for (const i of hits) {
    const caller = callerOf(spans, i) ?? ROOT;
    const row = byCaller.get(caller) ?? { n: 0, ms: 0 };
    row.n++;
    row.ms += spans[i].end - spans[i].start;
    byCaller.set(caller, row);
  }
  console.log("\n  spans       ms   share  innermost instrumented caller");
  for (
    const [caller, row] of [...byCaller].sort((a, b) => b[1].n - a[1].n).slice(
      0,
      20,
    )
  ) {
    const share = ((row.n / hits.length) * 100).toFixed(1);
    console.log(
      `${String(row.n).padStart(7)} ${row.ms.toFixed(0).padStart(8)} ${
        (share + "%").padStart(7)
      }  ${caller}`,
    );
  }
  const rootShare = byCaller.get(ROOT);
  if (rootShare) {
    console.log(
      `\nA large root share is a statement about the instrumentation rather ` +
        `than\nthe code: those spans ran outside every wrapped region.`,
    );
  }
}
