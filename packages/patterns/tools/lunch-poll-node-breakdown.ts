/**
 * lunch-poll NODE-SOURCE breakdown — "where do the thousands of reactive
 * scheduler nodes come from, and where is the interpreter's node-level
 * leverage?"
 *
 * DIAGNOSTIC, not a gate. Companion to `lunch-poll-interpreter-bench.ts` (which
 * answers the docs/nodes/conflicts A/B); this tool answers a finer question:
 * categorize EVERY scheduler node of the 5×5 lunch-poll steady state by its
 * SOURCE, and cross-reference with the interpreter census to rank where node-
 * level leverage actually is (handlers? collections? computeds? sqlite?).
 *
 * It drives the SAME multi-user workload the bench uses (N users join, host adds
 * M options, every user votes for R rounds), settles to steady state, then
 * snapshots `runtime.scheduler.getGraphSnapshot()` for the host runtime AND each
 * per-user runtime. Every node is bucketed by a taxonomy DERIVED FROM the
 * snapshot's node `id` prefix + builtin name (the `module` object is NOT carried
 * across the worker boundary — see the "WHAT IS DERIVABLE" note below), and
 * cross-referenced against the interpreter dispatch census (flag ON).
 *
 * Reproduce (5 options × 5 users × 2 rounds):
 *
 *   deno run -A packages/patterns/tools/lunch-poll-node-breakdown.ts \
 *     --options=5 --users=5 --rounds=2
 *
 * Flags:
 *   --options=<M>   options the host adds (default 5)
 *   --users=<N>     simulated users / runtimes (default 5)
 *   --rounds=<R>    concurrent vote rounds (default 2)
 *   --json          also emit the full result object as JSON
 *
 * WHAT IS DERIVABLE (honest scope): `SchedulerGraphSnapshot` nodes carry `id`,
 * `type` (effect|computation|input|inactive), `preview` (≤200 chars of a
 * javascript node's fn body), `reads`/`writes`, `parentId`/`childCount`,
 * `patternIdentity`. They do NOT carry `module.{type,wrapper,implementation}` —
 * that lives on the live `Action` inside the runner and is dropped by the
 * worker's `sanitizeForTransfer`. So categorization keys on the node `id`, whose
 * prefix is a reliable, runtime-assigned source tag:
 *   - `raw:<builtin>:<hash>`   → a registered builtin ref (map/filter/flatMap,
 *                                ifElse/when/unless, sqliteQuery/…); the
 *                                `<builtin>` segment is the exact ref name, which
 *                                maps 1:1 to `extract.ts`'s OpKind classifier.
 *   - `action:cf:module/…:L:C:` → a `type:"javascript"` leaf (computed/lift/
 *                                derive) — the interpreter-ELIGIBLE pure slice.
 *   - `sink:<space>/of:<id>/…`  → a result/patternIdentity subscription effect.
 *   - `input:<entity>`          → a synthetic source marker the snapshot adds for
 *                                a read-but-never-written entity (a pattern input
 *                                / external doc). NOT a reactive node.
 *   - `pull:…` / type `inactive`→ pull-demand roots / unsubscribed-but-stats.
 * This is fully sufficient for the source taxonomy and the eligibility mapping;
 * the only thing NOT readable per-node is the interpreter's own dry-run verdict
 * (which is per-PATTERN, captured separately via the census).
 */

import {
  type InterpreterCensus,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";

const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const PROGRAM_PATH =
  new URL("../lunch-poll/main.tsx", import.meta.url).pathname;
// A data: URL so the host homepage-enrichment web search resolves empty instead
// of hitting the network (the diagnostics-tool idiom).
const TEST_WEB_SEARCH_URL =
  "data:application/json,%7B%22results%22%3A%5B%5D%7D";
const VOTE_COLORS = ["green", "yellow", "red"] as const;

// ---------------------------------------------------------------------------
// Node taxonomy.
// ---------------------------------------------------------------------------

/** Source categories, ordered for the report. */
type Category =
  | "computed_leaf" // action:cf:module/… — pure JS value node (interpreter-eligible)
  | "collection" // raw:map / raw:filter / raw:flatMap
  | "control" // raw:ifElse / raw:when / raw:unless
  | "effect_sqlite" // raw:sqliteQuery / raw:sqliteDatabase
  | "effect_other" // raw:generateText/fetchData/wish/llm/navigateTo/streamData/…
  | "sink" // sink:… result + patternIdentity subscriptions
  | "interpreter" // raw:interpreterImpl:… — the interpreter's OWN synthetic node (flag ON)
  | "input" // input:… synthetic source markers (not reactive nodes)
  | "pull" // pull:… demand roots
  | "inactive" // type === "inactive" (stats only, unsubscribed)
  | "uncategorized"; // anything we could not place — surfaced explicitly

const COLLECTION_BUILTINS = new Set(["map", "filter", "flatMap"]);
const CONTROL_BUILTINS = new Set(["ifElse", "when", "unless"]);
const SQLITE_BUILTINS = new Set(["sqliteQuery", "sqliteDatabase"]);
// Effect/stream/async builtins (mirrors extract.ts EFFECT_REFS, minus the
// collection/control ones which we break out above).
const EFFECT_BUILTINS = new Set([
  "navigateTo",
  "streamData",
  "llm",
  "llmDialog",
  "generateText",
  "generateObject",
  "fetchData",
  "fetchProgram",
  "compileAndRun",
  "wish",
]);

interface NodeLike {
  id: string;
  type: string;
  preview?: string;
  parentId?: string;
  childCount?: number;
}

interface Categorized {
  category: Category;
  /** For `raw:` nodes, the builtin ref name (e.g. "map", "sqliteQuery"). */
  builtin?: string;
}

function categorize(node: NodeLike): Categorized {
  const id = node.id;
  if (node.type === "inactive") return { category: "inactive" };
  if (id.startsWith("input:")) return { category: "input" };
  if (id.startsWith("pull:")) return { category: "pull" };
  if (id.startsWith("sink:")) return { category: "sink" };
  if (id.startsWith("action:")) return { category: "computed_leaf" };
  if (id.startsWith("raw:")) {
    const builtin = id.split(":")[1] ?? "";
    // The interpreter's own synthetic node (one per interpreted pattern
    // instance, flag ON): `raw:interpreterImpl:<hash>`. It REPLACES that
    // pattern's pure-leaf nodes, so it is the collapsed footprint, not a source.
    if (builtin === "interpreterImpl") {
      return { category: "interpreter", builtin };
    }
    if (COLLECTION_BUILTINS.has(builtin)) {
      return { category: "collection", builtin };
    }
    if (CONTROL_BUILTINS.has(builtin)) return { category: "control", builtin };
    if (SQLITE_BUILTINS.has(builtin)) {
      return { category: "effect_sqlite", builtin };
    }
    if (EFFECT_BUILTINS.has(builtin)) {
      return { category: "effect_other", builtin };
    }
    // An unknown raw builtin — surface it, do not hide it.
    return { category: "uncategorized", builtin };
  }
  return { category: "uncategorized" };
}

// ---------------------------------------------------------------------------
// Per-runtime + aggregate breakdowns.
// ---------------------------------------------------------------------------

interface Breakdown {
  total: number;
  byCategory: Record<Category, number>;
  /** raw-builtin name → count (across all `raw:` nodes). */
  byBuiltin: Record<string, number>;
  /** Child element nodes (have a parentId) — the per-element fan-out. */
  childNodes: number;
  /** map/filter/flatMap parent nodes with their reported childCount. */
  collectionParents: Array<{ builtin: string; childCount: number }>;
}

const EMPTY_BY_CATEGORY = (): Record<Category, number> => ({
  computed_leaf: 0,
  collection: 0,
  control: 0,
  effect_sqlite: 0,
  effect_other: 0,
  sink: 0,
  interpreter: 0,
  input: 0,
  pull: 0,
  inactive: 0,
  uncategorized: 0,
});

function breakdownOf(nodes: NodeLike[]): Breakdown {
  const byCategory = EMPTY_BY_CATEGORY();
  const byBuiltin: Record<string, number> = {};
  let childNodes = 0;
  const collectionParents: Array<{ builtin: string; childCount: number }> = [];
  for (const node of nodes) {
    const { category, builtin } = categorize(node);
    byCategory[category]++;
    if (builtin) byBuiltin[builtin] = (byBuiltin[builtin] ?? 0) + 1;
    if (node.parentId) childNodes++;
    if (
      category === "collection" && typeof node.childCount === "number" &&
      node.childCount > 0
    ) {
      collectionParents.push({
        builtin: builtin ?? "?",
        childCount: node.childCount,
      });
    }
  }
  return {
    total: nodes.length,
    byCategory,
    byBuiltin,
    childNodes,
    collectionParents,
  };
}

function mergeBreakdown(into: Breakdown, add: Breakdown): void {
  into.total += add.total;
  for (const key of Object.keys(into.byCategory) as Category[]) {
    into.byCategory[key] += add.byCategory[key];
  }
  for (const [k, v] of Object.entries(add.byBuiltin)) {
    into.byBuiltin[k] = (into.byBuiltin[k] ?? 0) + v;
  }
  into.childNodes += add.childNodes;
  into.collectionParents.push(...add.collectionParents);
}

function emptyBreakdown(): Breakdown {
  return {
    total: 0,
    byCategory: EMPTY_BY_CATEGORY(),
    byBuiltin: {},
    childNodes: 0,
    collectionParents: [],
  };
}

// ---------------------------------------------------------------------------
// Census aggregation (flag ON).
// ---------------------------------------------------------------------------

async function collectCensus(
  sessions: readonly MultiRuntimeSession[],
): Promise<InterpreterCensus | null> {
  let any = false;
  const total: InterpreterCensus = {
    interpreted_ok: 0,
    fallback_by_reason: {},
  };
  for (const session of sessions) {
    const census = await session.interpreterCensus();
    if (!census) continue;
    any = true;
    total.interpreted_ok += census.interpreted_ok;
    for (const [reason, n] of Object.entries(census.fallback_by_reason)) {
      total.fallback_by_reason[reason] =
        (total.fallback_by_reason[reason] ?? 0) + n;
    }
  }
  return any ? total : null;
}

// ---------------------------------------------------------------------------
// Workload driver (mirrors lunch-poll-interpreter-bench.runCase).
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

async function optionIds(session: MultiRuntimeSession): Promise<string[]> {
  const result = await session.read();
  if (!isRecord(result)) return [];
  const options = Array.isArray(result.options) ? result.options : [];
  return options
    .map((o) => (isRecord(o) && typeof o.id === "string" ? o.id : ""))
    .filter((id) => id !== "");
}

interface DriveConfig {
  options: number;
  users: number;
  rounds: number;
  arm: "off" | "on";
}

interface DriveResult {
  /** Per-runtime breakdown, indexed by session label. */
  perRuntime: Array<{ label: string; breakdown: Breakdown }>;
  aggregate: Breakdown;
  census: InterpreterCensus | null;
  votes: number;
  options: number;
  users: number;
}

async function drive(config: DriveConfig): Promise<DriveResult> {
  const labels = Array.from(
    { length: config.users },
    (_v, i) => `user-${i + 1}`,
  );
  const harness = await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    diagnostics: true,
    input: { webSearchUrl: TEST_WEB_SEARCH_URL },
    sessions: labels,
    spaceName:
      `lunch-poll-nodes-${config.arm}-${config.options}o-${config.users}u-${crypto.randomUUID()}`,
    experimental: config.arm === "on"
      ? { experimentalInterpreter: true }
      : undefined,
    onCommitOperations: () => {},
  });
  const sessions = labels.map((label) => harness.session(label));
  const host = sessions[0];
  const trace = (msg: string) =>
    console.error(`[breakdown:${config.arm}] ${msg}`);

  try {
    // 1. Everyone joins (host first → captures adminName).
    await host.send("joinAs", { name: "User 1" });
    await Promise.all(
      sessions.slice(1).map((s, i) =>
        s.send("joinAs", { name: `User ${i + 2}` })
      ),
    );
    await harness.settle(3);
    trace("joined");

    // 2. Host adds options.
    for (let i = 0; i < config.options; i++) {
      await host.send("addOption", { title: `Restaurant ${i + 1}` });
      await harness.settled(1);
    }
    let visible = (await optionIds(host)).length;
    for (let retry = 0; visible < config.options && retry < 10; retry++) {
      await harness.settled(2);
      visible = (await optionIds(host)).length;
    }
    trace(`options added (${visible}/${config.options} visible)`);

    // 3. Concurrent vote rounds.
    let votes = 0;
    for (let round = 0; round < config.rounds; round++) {
      let ids = await optionIds(host);
      for (let retry = 0; ids.length === 0 && retry < 5; retry++) {
        await harness.settle(2);
        ids = await optionIds(host);
      }
      if (ids.length > 0) {
        await Promise.all(
          sessions.map((s, i) =>
            s.send("castVote", {
              optionId: ids[(round + i) % ids.length],
              voteType: VOTE_COLORS[(round + i) % VOTE_COLORS.length],
            })
          ),
        );
        votes += sessions.length;
      }
      await harness.settle(3);
      trace(`voted round ${round + 1}`);
    }

    // Final barrier: drain async builtin work + writeback so the steady-state
    // graph has genuinely converged before we snapshot it.
    await harness.settled(5);

    // 4. Snapshot every runtime's scheduler graph.
    const snapshots = await Promise.all(
      sessions.map(async (s) => ({
        label: s.label,
        snap: await s.diagnostics() as RuntimeDiagnosticsSnapshot,
      })),
    );
    const perRuntime = snapshots.map(({ label, snap }) => ({
      label,
      breakdown: breakdownOf(snap.graph.nodes as unknown as NodeLike[]),
    }));
    const aggregate = emptyBreakdown();
    for (const { breakdown } of perRuntime) {
      mergeBreakdown(aggregate, breakdown);
    }

    const census = await collectCensus(sessions);
    return {
      perRuntime,
      aggregate,
      census,
      votes,
      options: config.options,
      users: config.users,
    };
  } finally {
    await harness.dispose();
  }
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<Category, string> = {
  computed_leaf: "computed / lift / derive (pure JS leaf)",
  collection: "collection (map / filter / flatMap)",
  control: "control (ifElse / when / unless)",
  effect_sqlite: "effect: sqlite (sqliteQuery / sqliteDatabase)",
  effect_other: "effect: other builtins (fetchData / wish / generateText / …)",
  sink: "sink (result + patternIdentity subscriptions)",
  interpreter: "interpreter synthetic node (collapsed pattern, flag ON)",
  input: "input (synthetic source markers — not reactive nodes)",
  pull: "pull (demand roots)",
  inactive: "inactive (stats only, unsubscribed)",
  uncategorized: "UNCATEGORIZED (surfaced — should be 0)",
};

const CATEGORY_ORDER: Category[] = [
  "computed_leaf",
  "collection",
  "control",
  "effect_sqlite",
  "effect_other",
  "sink",
  "interpreter",
  "pull",
  "inactive",
  "input",
  "uncategorized",
];

function pct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : "0.0%";
}

function reportBreakdown(title: string, b: Breakdown): void {
  console.log("");
  console.log(`=== ${title} — total nodes: ${b.total} ===`);
  console.log(
    `  ${"category".padEnd(52)} ${"count".padStart(6)}  ${"%".padStart(6)}`,
  );
  for (const cat of CATEGORY_ORDER) {
    const n = b.byCategory[cat];
    if (n === 0 && cat === "uncategorized") continue;
    console.log(
      `  ${CATEGORY_LABEL[cat].padEnd(52)} ${String(n).padStart(6)}  ${
        pct(n, b.total).padStart(6)
      }`,
    );
  }
  // Reactive-node subtotal (excludes input/pull/inactive synthetic markers).
  const reactive = b.byCategory.computed_leaf + b.byCategory.collection +
    b.byCategory.control + b.byCategory.effect_sqlite +
    b.byCategory.effect_other + b.byCategory.sink + b.byCategory.interpreter;
  console.log(
    `  ${"— reactive nodes (excl. input/pull/inactive)".padEnd(52)} ${
      String(reactive).padStart(6)
    }  ${pct(reactive, b.total).padStart(6)}`,
  );
  console.log(`  child (per-element) nodes: ${b.childNodes}`);
  const rawEntries = Object.entries(b.byBuiltin).sort((a, c) => c[1] - a[1]);
  if (rawEntries.length > 0) {
    console.log(
      `  raw builtins: ${rawEntries.map(([k, v]) => `${k}=${v}`).join("  ")}`,
    );
  }
  if (b.collectionParents.length > 0) {
    const fanout = b.collectionParents
      .map((p) => `${p.builtin}×${p.childCount}`)
      .join("  ");
    console.log(`  collection fan-out (parent×childCount): ${fanout}`);
  }
}

function reportCensus(census: InterpreterCensus | null): void {
  console.log("");
  console.log("=== interpreter dispatch census (flag ON, summed runtimes) ===");
  if (!census) {
    console.log("  n/a");
    return;
  }
  const fallbackTotal = Object.values(census.fallback_by_reason).reduce(
    (s, n) => s + n,
    0,
  );
  const total = census.interpreted_ok + fallbackTotal;
  console.log(
    `  interpreted_ok: ${census.interpreted_ok} / ${total} pattern instances` +
      ` (${pct(census.interpreted_ok, total)})`,
  );
  const fb = Object.entries(census.fallback_by_reason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`)
    .join("  ");
  console.log(`  fallback_by_reason: ${fb || "none"}`);
}

/**
 * Node-level interpreter leverage. The interpreter collapses an ENTIRE
 * interpreted pattern's pure-leaf nodes into ONE synthetic node. So the slice it
 * eliminates today (flag ON) is the `computed_leaf` nodes that belong to
 * interpreted pattern instances. We can't attribute each leaf to a specific
 * pattern instance from the snapshot alone, but we CAN bound the leverage of
 * each UNSUPPORTED category by its node share, and rank where the nodes
 * concentrate. This prints that ranking from the OFF (full-legacy) aggregate.
 */
function reportLeverage(
  off: Breakdown,
  onCensus: InterpreterCensus | null,
): void {
  console.log("");
  console.log("=== NODE-LEVEL interpreter leverage (OFF aggregate basis) ===");
  const c = off.byCategory;
  const reactive = c.computed_leaf + c.collection + c.control +
    c.effect_sqlite + c.effect_other + c.sink + c.interpreter;
  // The pure-leaf slice is what the interpreter can collapse on an eligible
  // pattern. Control nodes are also eligible kinds but materialize as `raw:`
  // builtin nodes — the interpreter folds them into the synthetic node only
  // when the WHOLE pattern interprets.
  const eligibleLeafSlice = c.computed_leaf;
  console.log(
    `  ELIGIBLE pure-leaf slice (computed/lift/derive): ${eligibleLeafSlice}` +
      ` nodes = ${pct(eligibleLeafSlice, off.total)} of all nodes,` +
      ` ${pct(eligibleLeafSlice, reactive)} of reactive nodes`,
  );
  if (onCensus) {
    const fallbackTotal = Object.values(onCensus.fallback_by_reason).reduce(
      (s, n) => s + n,
      0,
    );
    const total = onCensus.interpreted_ok + fallbackTotal;
    console.log(
      `  census says ${onCensus.interpreted_ok}/${total} pattern instances` +
        ` interpret today (${pct(onCensus.interpreted_ok, total)}); the` +
        ` node-share of the leaf slice they can collapse is the number above.`,
    );
  }
  // The `child` tag is ORTHOGONAL to the category buckets: a child element node
  // is ALSO a computed_leaf / control / effect node. So we do NOT add childNodes
  // to a category — instead we report how many of the leaf/control/effect nodes
  // are children (the per-element fan-out) vs top-level pattern-body nodes.
  console.log("");
  console.log(
    `  child (per-element) nodes: ${off.childNodes}` +
      ` (${pct(off.childNodes, off.total)} of all nodes,` +
      ` ${
        pct(off.childNodes, reactive)
      } of reactive). These are NOT a separate` +
      ` bucket — they are the leaf/control/effect nodes that the collection` +
      ` maps INSTANTIATE per element, distributed across those categories.`,
  );
  console.log("");
  console.log(
    "  Per-source NODE leverage (categories are disjoint; child is a tag):",
  );
  const ranked: Array<{ name: string; nodes: number; note: string }> = [
    {
      name: "computed/lift/derive leaves",
      nodes: c.computed_leaf,
      note: "ELIGIBLE — collapse into the per-pattern interpreter node",
    },
    {
      name: "control (ifElse/when/unless)",
      nodes: c.control,
      note: "eligible kind; folds in only with the whole pattern",
    },
    {
      name: "collection map/filter/flatMap (parents)",
      nodes: c.collection,
      note:
        `the ${c.collection} parents SPAWN ${off.childNodes} child element` +
        ` nodes (counted in leaf/control/effect); only a single unscoped` +
        ` top-level map interprets today`,
    },
    {
      name: "effect: other builtins",
      nodes: c.effect_other,
      note: "I/O / stream builtins — ineligible_opkind",
    },
    {
      name: "sink subscriptions",
      nodes: c.sink,
      note: "result/patternIdentity sinks — not a pattern-body node",
    },
    {
      name: "effect: sqlite",
      nodes: c.effect_sqlite,
      note: "I/O builtin — ineligible_opkind",
    },
  ];
  ranked.sort((a, b) => b.nodes - a.nodes);
  let rank = 1;
  for (const r of ranked) {
    console.log(
      `   ${rank}. ${r.name.padEnd(40)} ${String(r.nodes).padStart(5)} nodes` +
        ` (${pct(r.nodes, off.total)})  — ${r.note}`,
    );
    rank++;
  }
  console.log("");
  console.log(
    "  KEY: the per-element fan-out (child nodes) is unlocked by COLLECTION" +
      " coverage, not by the 50 map parents themselves. Interpreting the" +
      " per-option/per-row maps' ELEMENT patterns is what would collapse the" +
      ` ${off.childNodes}-node bulk — leaf + control + effect children alike.`,
  );
}

// ---------------------------------------------------------------------------
// Arg parsing + main.
// ---------------------------------------------------------------------------

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((e) => e.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

async function main(): Promise<void> {
  const options = numberArg("options", 5);
  const users = numberArg("users", 5);
  const rounds = numberArg("rounds", 2);
  const emitJson = Deno.args.includes("--json");

  console.error(
    `[breakdown] lunch-poll ${options}×${users} rounds=${rounds} — OFF arm` +
      ` (full legacy graph)...`,
  );
  const off = await drive({ options, users, rounds, arm: "off" });
  console.error(`[breakdown] ${options}×${users} — ON arm (census)...`);
  const on = await drive({ options, users, rounds, arm: "on" });

  console.log("");
  console.log(
    `############ lunch-poll NODE-SOURCE breakdown — ${options} options ×` +
      ` ${users} users × ${rounds} rounds ############`,
  );
  console.log(
    `votes cast: ${off.votes} (off) / ${on.votes} (on)   ` +
      `runtimes: 1 host + ${users - 1} users = ${users}`,
  );

  // OFF aggregate — the full legacy node graph (where the thousands live).
  reportBreakdown(
    "OFF aggregate (all runtimes, full legacy graph)",
    off.aggregate,
  );

  // Per-runtime: which runtime owns the bulk (host owns options/votes/sqlite).
  console.log("");
  console.log("=== OFF per-runtime node totals (who owns the bulk) ===");
  for (const { label, breakdown } of off.perRuntime) {
    const c = breakdown.byCategory;
    console.log(
      `  ${label.padEnd(8)} total=${String(breakdown.total).padStart(5)}` +
        `  leaf=${String(c.computed_leaf).padStart(4)}` +
        `  coll=${String(c.collection).padStart(3)}` +
        `  ctrl=${String(c.control).padStart(3)}` +
        `  sqlite=${String(c.effect_sqlite).padStart(3)}` +
        `  effOther=${String(c.effect_other).padStart(3)}` +
        `  sink=${String(c.sink).padStart(3)}` +
        `  input=${String(c.input).padStart(4)}` +
        `  child=${String(breakdown.childNodes).padStart(4)}`,
    );
  }

  // ON aggregate (for contrast) + census.
  reportBreakdown("ON aggregate (interpreter where eligible)", on.aggregate);
  reportCensus(on.census);
  reportLeverage(off.aggregate, on.census);

  if (emitJson) {
    console.log("");
    console.log(JSON.stringify(
      { kind: "lunch-poll-node-breakdown", options, users, rounds, off, on },
      null,
      2,
    ));
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error
        ? `${error.message}\n${error.stack}`
        : String(error),
    );
    Deno.exit(1);
  }
}
