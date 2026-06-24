/**
 * Reactive Interpreter footprint bench — Shell default-app notes list.
 *
 * Runs the SAME note-create workload twice, identically, against the notes-list
 * bench fixture (`packages/patterns/notes-list-bench/main.tsx` — a headless
 * model of the Shell default/home app: a top-level `map` over a growing notes
 * array + a "New Note" handler that appends):
 *
 *   - OFF: `experimentalInterpreter` off (legacy: a child pattern per map
 *          element — argument doc + lift docs + one CONSOLIDATED VNode result
 *          doc, + ~4 scheduler nodes).
 *   - ON:  `experimentalInterpreter` on (the eligible pure-render map element
 *          dispatches to `$ri-collection-map`; ineligible surfaces fall back
 *          with no behavior change).
 *
 * MEASURED FINDING (see DECISIONS.md D-VNODE-DOC-FRAGMENTATION): on this
 * VNode-rendering element map the interpreter REDUCES scheduler nodes (~-20%,
 * dropping the child pattern) but INCREASES docs — it drops the arg doc and
 * inlines the lifts, yet writes the element-result VNode subtree as one doc PER
 * NODE (tr/td/vstack/spans) instead of legacy's single consolidated VNode doc,
 * net +~2 docs/element. The "~1 doc/element" doc win holds only for
 * scalar/object element results (the W3 test), NOT for rendered (VNode) elements.
 * This bench surfaces that real, fixable regression; the node win is unaffected.
 *
 * The workload: a single session (the notes app is single-user) drives the real
 * `addNote` handler N times, growing the notes list one note at a time, exactly
 * as the shell's "New Note" flow does. This is the slowly-growing-data shape
 * where the per-element doc/node tax dominates — the interpreter's best case.
 *
 * For each (N, arm) it measures:
 *   - docs:    distinct documents written / created (counted server-side via
 *              the memory server's commit tap).
 *   - nodes:   total scheduler graph nodes (+ by type).
 *   - timeMs:  wall-clock for the whole N-note workload.
 *   - conflicts: commit-conflict / revert / rejected counts (loggerCounts).
 *   - census (ON only): interpreter dispatch census — `interpreted_ok` vs
 *              `fallback_by_reason`. The honest coverage story: how much of the
 *              app the interpreter handled vs fell back.
 *
 * Headline output: per-arm SLOPES (docs/note, nodes/note) across the N points,
 * so the footprint trend is visible — does interp docs/note < legacy docs/note
 * as N grows? That is the whole interpreter thesis on this shape.
 *
 * It also asserts OUTPUT EQUIVALENCE: the final note count + the per-note title
 * projection must be identical OFF vs ON. The interpreter must not change
 * results — this is the correctness guard on the bench itself.
 *
 * This is a MEASUREMENT, not a correctness gate. Run it directly:
 *
 *   deno run -A packages/patterns/tools/default-app-interpreter-bench.ts \
 *     --notes=30,100
 *
 * Flags:
 *   --notes=<N>[,<N>...]  note counts to measure (default 30,100)
 *   --json                emit the full result object as JSON to stdout
 */

import {
  type InterpreterCensus,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";

const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const FIXTURE_DIR = new URL("../notes-list-bench/", import.meta.url).pathname
  .replace(/\/$/, "");
const PROGRAM_PATH = `${FIXTURE_DIR}/main.tsx`;

// ---------------------------------------------------------------------------
// Doc counter (server-side commit tap).
// ---------------------------------------------------------------------------

interface DocCounter {
  /** Distinct doc ids that ever received a write (`set` or `patch`). */
  writtenIds: Set<string>;
  /** Distinct doc ids first seen via a root `set` (doc creation). */
  createdIds: Set<string>;
  onCommitOperations: (
    operations: readonly Record<string, unknown>[],
    connectionTag: number,
  ) => void;
}

function makeDocCounter(): DocCounter {
  const writtenIds = new Set<string>();
  const createdIds = new Set<string>();
  return {
    writtenIds,
    createdIds,
    onCommitOperations(operations) {
      for (const op of operations) {
        const id = typeof op.id === "string" ? op.id : undefined;
        if (!id) continue;
        writtenIds.add(id);
        // A `set` op writes the whole document — the create/replace signal,
        // matching attachDocRecorder's "root write = create" semantics.
        if (op.op === "set") createdIds.add(id);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Per-arm measurement aggregation.
// ---------------------------------------------------------------------------

interface NodeTotals {
  nodes: number;
  edges: number;
  byType: Record<string, number>;
}

interface ConflictTotals {
  commitConflicts: number;
  commitReverts: number;
  commitRejected: number;
  commitPreempted: number;
}

interface CaseMeasurement {
  notes: number;
  timeMs: number;
  docsWritten: number;
  docsCreated: number;
  nodes: NodeTotals;
  conflicts: ConflictTotals;
  census: InterpreterCensus | null;
  fingerprint: NotesFingerprint;
}

interface ArmMeasurement {
  arm: "off" | "on";
  cases: CaseMeasurement[];
}

// ---------------------------------------------------------------------------
// Equivalence fingerprint (the correctness guard).
// ---------------------------------------------------------------------------

interface NotesFingerprint {
  noteCount: number;
  /** Sorted per-note title projection ("title (tagCount)"). */
  titles: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function notesFingerprint(result: unknown): NotesFingerprint {
  if (!isRecord(result)) {
    throw new Error(`notes output is not an object: ${JSON.stringify(result)}`);
  }
  const titlesValue = Array.isArray(result.titles) ? result.titles : [];
  const titles = titlesValue
    .map((t) => (typeof t === "string" ? t : JSON.stringify(t)))
    .slice()
    .sort()
    .join("\n");
  return {
    noteCount: asNumber(result.noteCount),
    titles,
  };
}

function sameFingerprint(a: NotesFingerprint, b: NotesFingerprint): boolean {
  return a.noteCount === b.noteCount && a.titles === b.titles;
}

// ---------------------------------------------------------------------------
// Aggregation helpers.
// ---------------------------------------------------------------------------

function sumNodes(snapshot: RuntimeDiagnosticsSnapshot): NodeTotals {
  const byType: Record<string, number> = {};
  for (const node of snapshot.graph.nodes) {
    const type = (node as { type?: string }).type ?? "?";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  return {
    nodes: snapshot.graph.nodes.length,
    edges: snapshot.graph.edges.length,
    byType,
  };
}

async function collectConflicts(
  session: MultiRuntimeSession,
): Promise<ConflictTotals> {
  const counts = await session.loggerCounts();
  const storage = counts["storage.v2"] ?? {};
  return {
    commitConflicts: storage["commit-conflict"]?.total ?? 0,
    commitReverts: storage["commit-revert"]?.total ?? 0,
    commitRejected: storage["commit-rejected"]?.total ?? 0,
    commitPreempted: storage["commit-preempted"]?.total ?? 0,
  };
}

/**
 * Read the converged notes result, settling + retrying until `noteCount`
 * reaches the expected value. Under the post-commit flush/sync cascade a single
 * `read()` may observe a stale count before state has settled.
 */
async function readSettled(
  harness: MultiRuntimeHarness,
  session: MultiRuntimeSession,
  expectedCount: number,
): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const value = await session.read();
      if (isRecord(value) && asNumber(value.noteCount) >= expectedCount) {
        return value;
      }
      last = value;
    } catch (error) {
      last = error;
    }
    await harness.settled(2);
  }
  return last;
}

// ---------------------------------------------------------------------------
// One case: drive N note-creates in one arm and measure it.
// ---------------------------------------------------------------------------

async function runCase(
  arm: "off" | "on",
  notes: number,
): Promise<CaseMeasurement> {
  const docs = makeDocCounter();
  const harness = await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    diagnostics: true,
    sessions: ["notes"],
    spaceName: `default-app-interp-${arm}-${notes}n-${crypto.randomUUID()}`,
    experimental: arm === "on" ? { experimentalInterpreter: true } : undefined,
    onCommitOperations: docs.onCommitOperations,
  });

  const session = harness.session("notes");
  const trace = (msg: string) =>
    console.error(`[bench:${arm} ${notes}n] ${msg}`);

  try {
    await harness.settled(2);
    const startedAt = performance.now();

    // Drive the real "New Note" handler N times, one note per settle — the
    // slowly-growing-data shape (each create grows the mapped list by one).
    for (let i = 0; i < notes; i++) {
      await session.send("addNote", {});
      await harness.settled(1);
    }

    // Final barrier: wait for all in-flight async work + writeback cascade so
    // the measured state has genuinely converged.
    await harness.settled(4);
    const timeMs = performance.now() - startedAt;

    const snapshot = await session.diagnostics();
    const conflicts = await collectConflicts(session);
    const census = await session.interpreterCensus();
    const fingerprint = notesFingerprint(
      await readSettled(harness, session, notes),
    );
    trace(
      `done — ${fingerprint.noteCount} notes, ${docs.createdIds.size} docs, ` +
        `${snapshot.graph.nodes.length} nodes`,
    );

    return {
      notes,
      timeMs,
      docsWritten: docs.writtenIds.size,
      docsCreated: docs.createdIds.size,
      nodes: sumNodes(snapshot),
      conflicts,
      census,
      fingerprint,
    };
  } finally {
    await harness.dispose();
  }
}

// ---------------------------------------------------------------------------
// Arg parsing.
// ---------------------------------------------------------------------------

function notesArg(): number[] {
  const prefix = "--notes=";
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  const spec = arg ? arg.slice(prefix.length) : "30,100";
  const counts = spec
    .split(",")
    .map((entry) => Number(entry.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (counts.length === 0) throw new Error(`no valid note counts in "${spec}"`);
  return counts;
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

function fmtCensus(census: InterpreterCensus | null): string {
  if (!census) return "n/a (flag off)";
  const fallbacks = Object.entries(census.fallback_by_reason)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${reason}=${n}`)
    .join(" ");
  const totalFallback = Object.values(census.fallback_by_reason)
    .reduce((sum, n) => sum + n, 0);
  const total = census.interpreted_ok + totalFallback;
  const pct = total > 0
    ? ((census.interpreted_ok / total) * 100).toFixed(1)
    : "0.0";
  return `interpreted_ok=${census.interpreted_ok}/${total} (${pct}%) ` +
    `fallback{${fallbacks || "none"}}`;
}

/** Least-squares slope of y over x (the per-note marginal cost). */
function slope(points: Array<{ x: number; y: number }>): number {
  const n = points.length;
  if (n < 2) return NaN;
  const sx = points.reduce((s, p) => s + p.x, 0);
  const sy = points.reduce((s, p) => s + p.y, 0);
  const sxx = points.reduce((s, p) => s + p.x * p.x, 0);
  const sxy = points.reduce((s, p) => s + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return NaN;
  return (n * sxy - sx * sy) / denom;
}

function reportComparison(
  off: ArmMeasurement,
  on: ArmMeasurement,
): { equivalent: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const pct = (a: number, b: number) =>
    a === 0 ? "n/a" : `${(((b - a) / a) * 100).toFixed(1)}%`;

  console.log("");
  console.log(
    "=== default-app (notes list) Reactive Interpreter bench — OFF vs ON ===",
  );
  for (let i = 0; i < off.cases.length; i++) {
    const o = off.cases[i];
    const n = on.cases[i];
    const equivalent = sameFingerprint(o.fingerprint, n.fingerprint);
    if (!equivalent) {
      mismatches.push(
        `N=${o.notes}: OFF noteCount=${o.fingerprint.noteCount} != ON ${n.fingerprint.noteCount} (or titles differ)`,
      );
    }
    console.log("");
    console.log(`--- N = ${o.notes} notes ---`);
    console.log(
      `  notes: OFF ${o.fingerprint.noteCount} / ON ${n.fingerprint.noteCount}  ` +
        `equivalent=${equivalent ? "YES" : "NO"}`,
    );
    console.log(
      `  docs created:  OFF ${o.docsCreated}  ON ${n.docsCreated}  ` +
        `(Δ ${pct(o.docsCreated, n.docsCreated)})  ` +
        `[per-note OFF ${(o.docsCreated / o.notes).toFixed(2)} ON ${
          (n.docsCreated / n.notes).toFixed(2)
        }]`,
    );
    console.log(
      `  docs written:  OFF ${o.docsWritten}  ON ${n.docsWritten}  ` +
        `(Δ ${pct(o.docsWritten, n.docsWritten)})`,
    );
    console.log(
      `  scheduler nodes: OFF ${o.nodes.nodes}  ON ${n.nodes.nodes}  ` +
        `(Δ ${pct(o.nodes.nodes, n.nodes.nodes)})  ` +
        `[per-note OFF ${(o.nodes.nodes / o.notes).toFixed(2)} ON ${
          (n.nodes.nodes / n.notes).toFixed(2)
        }]`,
    );
    console.log(
      `  wall-clock:    OFF ${o.timeMs.toFixed(0)}ms  ON ${
        n.timeMs.toFixed(0)
      }ms  (Δ ${pct(o.timeMs, n.timeMs)})`,
    );
    console.log(
      `  conflicts:     OFF ${o.conflicts.commitConflicts}  ON ${n.conflicts.commitConflicts}  ` +
        `(reverts OFF ${o.conflicts.commitReverts} ON ${n.conflicts.commitReverts})`,
    );
    console.log(`  census (ON):   ${fmtCensus(n.census)}`);
  }

  // --- Slopes: the real footprint signal (marginal cost per note). ---
  if (off.cases.length >= 2) {
    const docsSlope = (arm: ArmMeasurement) =>
      slope(arm.cases.map((c) => ({ x: c.notes, y: c.docsCreated })));
    const nodesSlope = (arm: ArmMeasurement) =>
      slope(arm.cases.map((c) => ({ x: c.notes, y: c.nodes.nodes })));
    const offDocs = docsSlope(off);
    const onDocs = docsSlope(on);
    const offNodes = nodesSlope(off);
    const onNodes = nodesSlope(on);
    console.log("");
    console.log("--- SLOPES (marginal footprint per note, least-squares) ---");
    console.log(
      `  docs/note:  OFF ${offDocs.toFixed(2)}  ON ${onDocs.toFixed(2)}  ` +
        `(Δ ${pct(offDocs, onDocs)})`,
    );
    console.log(
      `  nodes/note: OFF ${offNodes.toFixed(2)}  ON ${onNodes.toFixed(2)}  ` +
        `(Δ ${pct(offNodes, onNodes)})`,
    );
  }

  console.log("");
  return { equivalent: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const noteCounts = notesArg();
  const emitJson = Deno.args.includes("--json");

  const off: ArmMeasurement = { arm: "off", cases: [] };
  const on: ArmMeasurement = { arm: "on", cases: [] };

  for (const notes of noteCounts) {
    console.error(`[bench] N=${notes} — OFF arm...`);
    off.cases.push(await runCase("off", notes));
    console.error(`[bench] N=${notes} — ON arm...`);
    on.cases.push(await runCase("on", notes));
  }

  const { equivalent, mismatches } = reportComparison(off, on);
  if (!equivalent) {
    console.error("OUTPUT EQUIVALENCE FAILED — interpreter changed results:");
    for (const mismatch of mismatches) console.error(`  ${mismatch}`);
  } else {
    console.log(
      "OUTPUT EQUIVALENCE: PASS — note count + titles identical OFF vs ON.",
    );
  }

  if (emitJson) {
    console.log(JSON.stringify(
      { kind: "default-app-interpreter-bench", equivalent, off, on },
      null,
      2,
    ));
  }

  if (!equivalent) Deno.exit(1);
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
