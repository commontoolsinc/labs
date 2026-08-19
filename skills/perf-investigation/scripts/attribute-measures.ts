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
 *   # the most common full call chains
 *   deno run --allow-read attribute-measures.ts measures.json --key=tx/read --chains
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
  loadMeasures,
} from "./measure-forest.ts";

function flag(name: string): string | undefined {
  const hit = Deno.args.find((arg) => arg.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const path = Deno.args.find((arg) => !arg.startsWith("--"));
const target = flag("key");
const via = flag("via");
const wantChains = Deno.args.includes("--chains");

if (!target) {
  console.error(
    "Pass the key to attribute, e.g. --key=tx/read. " +
      "A measures file is read from the first argument, or from stdin.",
  );
  Deno.exit(1);
}

const spans = buildForest(await loadMeasures(path));
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

if (wantChains) {
  const chains = new Map<string, number>();
  for (const i of hits) {
    const chain = collapseRepeats(ancestors(spans, i)).slice(0, 5);
    const sig = chain.length ? chain.join("  <  ") : ROOT;
    chains.set(sig, (chains.get(sig) ?? 0) + 1);
  }
  console.log("\nmost common chains (innermost first):");
  for (
    const [chain, n] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 15)
  ) {
    console.log(`  ${String(n).padStart(8)}  ${chain}`);
  }
} else if (via) {
  // Every `via` span, with how many target spans it directly contains and what
  // called it. The ratio is the point; the totals only say where to look.
  const perParent = new Map<number, number>();
  for (const i of hits) {
    const parent = spans[i].parent;
    if (parent !== -1 && spans[parent].key === via) {
      perParent.set(parent, (perParent.get(parent) ?? 0) + 1);
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
