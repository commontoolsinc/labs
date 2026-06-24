/**
 * Reactive Interpreter footprint bench — lunch-poll multi-user vote simulation.
 *
 * Runs the SAME realistic multi-user workload twice, identically, against the
 * lunch-poll pattern:
 *
 *   - OFF: `experimentalInterpreter` off (legacy per-node materialization).
 *   - ON:  `experimentalInterpreter` on (interpreter where eligible; the rest
 *          falls back to the legacy path with no behavior change).
 *
 * The workload: N simulated users (one runtime/worker each, sharing one
 * in-process memory server) join the poll, the host adds M options, then every
 * user casts a vote concurrently for R rounds — the same join → add-options →
 * concurrent-vote shape the lunch-poll diagnostics tool uses.
 *
 * For each arm it measures:
 *   - docs:    distinct documents written / created (counted server-side via
 *              the memory server's commit tap).
 *   - nodes:   total scheduler graph nodes (+ by type), summed across sessions.
 *   - timeMs:  wall-clock for the whole workload.
 *   - conflicts: commit-conflict / revert / rejected counts (loggerCounts),
 *              summed across sessions.
 *   - census (ON only): interpreter dispatch census — `interpreted_ok` vs
 *              `fallback_by_reason`, summed across sessions. This is the honest
 *              coverage story: how much of lunch-poll the interpreter actually
 *              handled vs fell back (handlers/effects/sqlite fall back).
 *
 * It also asserts OUTPUT EQUIVALENCE: the canonical vote tallies (per-option
 * green/yellow/red, plus user/option/vote counts) must be identical OFF vs ON.
 * The interpreter must not change results — this is the correctness guard on
 * the bench itself.
 *
 * This is a MEASUREMENT, not a correctness gate. Run it directly:
 *
 *   deno run -A packages/patterns/tools/lunch-poll-interpreter-bench.ts \
 *     --cases=3x3 --rounds=2
 *
 * Flags:
 *   --cases=<MxN>[,<MxN>...]  options x users per case (default 3x3,5x3)
 *   --rounds=<R>              concurrent vote rounds per case (default 2)
 *   --json                    emit the full result object as JSON to stdout
 */

import {
  type InterpreterCensus,
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";

const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LUNCH_POLL_DIR = new URL("../lunch-poll/", import.meta.url).pathname
  .replace(/\/$/, "");
const PROGRAM_PATH = `${LUNCH_POLL_DIR}/main.tsx`;
// A data: URL so the host's homepage-enrichment web search resolves to an
// empty result instead of hitting the network (the diagnostics tool idiom).
const TEST_WEB_SEARCH_URL =
  "data:application/json,%7B%22results%22%3A%5B%5D%7D";
const VOTE_COLORS = ["green", "yellow", "red"] as const;

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

interface ArmMeasurement {
  arm: "off" | "on";
  cases: CaseMeasurement[];
}

interface CaseMeasurement {
  options: number;
  users: number;
  rounds: number;
  timeMs: number;
  docsWritten: number;
  docsCreated: number;
  nodes: NodeTotals;
  conflicts: ConflictTotals;
  census: InterpreterCensus | null;
  tally: TallyFingerprint;
}

// ---------------------------------------------------------------------------
// Equivalence fingerprint (the correctness guard).
// ---------------------------------------------------------------------------

interface TallyFingerprint {
  userCount: number;
  optionCount: number;
  voteCount: number;
  /** Per-option green/yellow/red tally, keyed by option id, sorted. */
  perOption: string;
  /** Sorted canonical vote set: voterName|optionId|voteType. */
  votes: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asArray = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

function tallyFingerprint(result: unknown): TallyFingerprint {
  if (!isRecord(result)) {
    throw new Error(`poll output is not an object: ${JSON.stringify(result)}`);
  }
  const options = asArray(result.options);
  const votes = asArray(result.votes);
  // Option ids are randomly minted per run (nonPrivateRandom), so they differ
  // between arms even when the workload is identical. Key everything by the
  // deterministic option TITLE instead, so the fingerprint captures semantic
  // results (who voted what on which restaurant) without spurious id churn.
  const titleById = new Map(
    options.map((option) => [asString(option.id), asString(option.title)]),
  );
  const perOption = options
    .map((option) => {
      const id = asString(option.id);
      const title = asString(option.title);
      const optionVotes = votes.filter((v) => asString(v.optionId) === id);
      const count = (color: string) =>
        optionVotes.filter((v) => asString(v.voteType) === color).length;
      return `${title}:g${count("green")},y${count("yellow")},r${count("red")}`;
    })
    .sort()
    .join(";");
  const voteSet = votes
    .map((v) =>
      `${asString(v.voterName)}|${titleById.get(asString(v.optionId)) ?? "?"}|${
        asString(v.voteType)
      }`
    )
    .sort()
    .join(",");
  return {
    userCount: asNumber(result.userCount),
    optionCount: asNumber(result.optionCount),
    voteCount: asNumber(result.voteCount),
    perOption,
    votes: voteSet,
  };
}

function sameFingerprint(a: TallyFingerprint, b: TallyFingerprint): boolean {
  return a.userCount === b.userCount &&
    a.optionCount === b.optionCount &&
    a.voteCount === b.voteCount &&
    a.perOption === b.perOption &&
    a.votes === b.votes;
}

// ---------------------------------------------------------------------------
// Aggregation helpers.
// ---------------------------------------------------------------------------

function sumNodes(
  snapshots: readonly RuntimeDiagnosticsSnapshot[],
): NodeTotals {
  const byType: Record<string, number> = {};
  let nodes = 0;
  let edges = 0;
  for (const snap of snapshots) {
    nodes += snap.graph.nodes.length;
    edges += snap.graph.edges.length;
    for (const node of snap.graph.nodes) {
      const type = (node as { type?: string }).type ?? "?";
      byType[type] = (byType[type] ?? 0) + 1;
    }
  }
  return { nodes, edges, byType };
}

async function collectConflicts(
  sessions: readonly MultiRuntimeSession[],
): Promise<ConflictTotals> {
  const totals: ConflictTotals = {
    commitConflicts: 0,
    commitReverts: 0,
    commitRejected: 0,
    commitPreempted: 0,
  };
  for (const session of sessions) {
    const counts = await session.loggerCounts();
    const storage = counts["storage.v2"] ?? {};
    totals.commitConflicts += storage["commit-conflict"]?.total ?? 0;
    totals.commitReverts += storage["commit-revert"]?.total ?? 0;
    totals.commitRejected += storage["commit-rejected"]?.total ?? 0;
    totals.commitPreempted += storage["commit-preempted"]?.total ?? 0;
  }
  return totals;
}

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

async function optionIds(session: MultiRuntimeSession): Promise<string[]> {
  const result = await session.read();
  if (!isRecord(result)) return [];
  return asArray(result.options)
    .map((option) => asString(option.id))
    .filter((id) => id !== "");
}

/**
 * Read the converged poll result, settling + retrying until it materializes as
 * an object. Under heavy concurrent-conflict load the post-commit outbox flush
 * / sync can lag, so a single `read()` may observe `undefined` before state has
 * settled. PerSpace votes/options/users are shared, so any session that has
 * materialized the result is an equally valid witness — try them all each
 * round and return the first object.
 */
async function readSettled(
  harness: MultiRuntimeHarness,
  sessions: readonly MultiRuntimeSession[],
): Promise<unknown> {
  let last: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    for (const session of sessions) {
      try {
        const value = await session.read();
        if (isRecord(value)) return value;
        last = value;
      } catch (error) {
        last = error;
      }
    }
    await harness.settled(3);
  }
  return last;
}

// ---------------------------------------------------------------------------
// One case: drive the workload in one arm and measure it.
// ---------------------------------------------------------------------------

interface CaseConfig {
  options: number;
  users: number;
  rounds: number;
}

async function runCase(
  arm: "off" | "on",
  config: CaseConfig,
): Promise<CaseMeasurement> {
  const docs = makeDocCounter();
  const labels = Array.from(
    { length: config.users },
    (_v, index) => `user-${index + 1}`,
  );
  const harness = await MultiRuntimeHarness.create({
    programPath: PROGRAM_PATH,
    rootPath: ROOT_PATH,
    diagnostics: true,
    input: { webSearchUrl: TEST_WEB_SEARCH_URL },
    sessions: labels,
    spaceName:
      `lunch-poll-interp-${arm}-${config.options}o-${config.users}u-${crypto.randomUUID()}`,
    experimental: arm === "on" ? { experimentalInterpreter: true } : undefined,
    onCommitOperations: docs.onCommitOperations,
  });

  const sessions = labels.map((label) => harness.session(label));
  const host = sessions[0];
  const trace = (msg: string) =>
    console.error(`[bench:${arm} ${config.options}x${config.users}] ${msg}`);

  try {
    const startedAt = performance.now();

    // 1. Everyone joins (host first → captures adminName).
    await host.send("joinAs", { name: "User 1" });
    await Promise.all(
      sessions.slice(1).map((session, index) =>
        session.send("joinAs", { name: `User ${index + 2}` })
      ),
    );
    await harness.settle(3);
    trace("joined");

    // 2. Host adds options (only the admin may add). Settle (async sqlite
    //    builtins) and confirm the host can see all options before voting —
    //    otherwise the rounds would have no targets and the bench would
    //    under-measure.
    for (let index = 0; index < config.options; index++) {
      await host.send("addOption", { title: `Restaurant ${index + 1}` });
      await harness.settled(1);
    }
    let visibleOptions = (await optionIds(host)).length;
    for (
      let retry = 0;
      visibleOptions < config.options && retry < 10;
      retry++
    ) {
      await harness.settled(2);
      visibleOptions = (await optionIds(host)).length;
    }
    trace(`options added (${visibleOptions}/${config.options} visible)`);

    // 3. Concurrent vote rounds: every user votes each round, rotating the
    //    option + color so the rounds are deterministic and produce real
    //    cross-session write-write contention.
    for (let round = 0; round < config.rounds; round++) {
      let ids = await optionIds(host);
      // Tolerate a lagging read at the start of a round under conflict load.
      for (let retry = 0; ids.length === 0 && retry < 5; retry++) {
        await harness.settle(2);
        ids = await optionIds(host);
      }
      if (ids.length > 0) {
        await Promise.all(
          sessions.map((session, index) =>
            session.send("castVote", {
              optionId: ids[(round + index) % ids.length],
              voteType: VOTE_COLORS[(round + index) % VOTE_COLORS.length],
            })
          ),
        );
      }
      await harness.settle(3);
      trace(`voted round ${round + 1}`);
    }

    // Final barrier: wait for all in-flight async builtin work (lunch-poll's
    // sqlite handlers) + the writeback cascade across every session, so the
    // measured state has genuinely converged (not just gone idle).
    await harness.settled(5);
    const timeMs = performance.now() - startedAt;

    // Measurements (after the workload + a final settle so state has converged).
    const snapshots = await Promise.all(
      sessions.map((session) => session.diagnostics()),
    );
    const conflicts = await collectConflicts(sessions);
    const census = await collectCensus(sessions);
    const tally = tallyFingerprint(await readSettled(harness, sessions));

    return {
      options: config.options,
      users: config.users,
      rounds: config.rounds,
      timeMs,
      docsWritten: docs.writtenIds.size,
      docsCreated: docs.createdIds.size,
      nodes: sumNodes(snapshots),
      conflicts,
      census,
      tally,
    };
  } finally {
    await harness.dispose();
  }
}

// ---------------------------------------------------------------------------
// Arg parsing.
// ---------------------------------------------------------------------------

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function casesArg(rounds: number): CaseConfig[] {
  const prefix = "--cases=";
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  const spec = arg ? arg.slice(prefix.length) : "3x3,5x3";
  const cases = spec.split(",").flatMap((entry) => {
    const match = entry.trim().match(/^(\d+)x(\d+)$/);
    if (!match) return [];
    const options = Number(match[1]);
    const users = Number(match[2]);
    if (users < 1 || options < 0) {
      throw new Error(`invalid case "${entry}" (need optionsXusers, users>=1)`);
    }
    return [{ options, users, rounds }];
  });
  if (cases.length === 0) throw new Error(`no valid cases in "${spec}"`);
  return cases;
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

function reportComparison(
  off: ArmMeasurement,
  on: ArmMeasurement,
): { equivalent: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  console.log("");
  console.log("=== lunch-poll Reactive Interpreter bench — OFF vs ON ===");
  for (let i = 0; i < off.cases.length; i++) {
    const o = off.cases[i];
    const n = on.cases[i];
    const equivalent = sameFingerprint(o.tally, n.tally);
    if (!equivalent) {
      mismatches.push(
        `${o.options}x${o.users}: OFF ${JSON.stringify(o.tally)} != ON ${
          JSON.stringify(n.tally)
        }`,
      );
    }
    const pct = (a: number, b: number) =>
      a === 0 ? "n/a" : `${(((b - a) / a) * 100).toFixed(1)}%`;
    console.log("");
    console.log(
      `--- case ${o.options} options x ${o.users} users x ${o.rounds} rounds ---`,
    );
    console.log(
      `  votes: ${o.tally.voteCount} (OFF) / ${n.tally.voteCount} (ON)  ` +
        `equivalent=${equivalent ? "YES" : "NO"}`,
    );
    console.log(
      `  docs written:  OFF ${o.docsWritten}  ON ${n.docsWritten}  ` +
        `(Δ ${pct(o.docsWritten, n.docsWritten)})`,
    );
    console.log(
      `  docs created:  OFF ${o.docsCreated}  ON ${n.docsCreated}  ` +
        `(Δ ${pct(o.docsCreated, n.docsCreated)})`,
    );
    console.log(
      `  scheduler nodes: OFF ${o.nodes.nodes}  ON ${n.nodes.nodes}  ` +
        `(Δ ${pct(o.nodes.nodes, n.nodes.nodes)})`,
    );
    console.log(
      `  wall-clock:    OFF ${o.timeMs.toFixed(0)}ms  ON ${
        n.timeMs.toFixed(0)
      }ms  (Δ ${pct(o.timeMs, n.timeMs)})`,
    );
    console.log(
      `  conflicts:     OFF ${o.conflicts.commitConflicts}  ON ${n.conflicts.commitConflicts}  ` +
        `(reverts OFF ${o.conflicts.commitReverts} ON ${n.conflicts.commitReverts}, ` +
        `rejected OFF ${o.conflicts.commitRejected} ON ${n.conflicts.commitRejected})`,
    );
    console.log(`  census (ON):   ${fmtCensus(n.census)}`);
  }
  console.log("");
  return { equivalent: mismatches.length === 0, mismatches };
}

// ---------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const rounds = numberArg("rounds", 2);
  const cases = casesArg(rounds);
  const emitJson = Deno.args.includes("--json");

  const off: ArmMeasurement = { arm: "off", cases: [] };
  const on: ArmMeasurement = { arm: "on", cases: [] };

  for (const config of cases) {
    console.error(
      `[bench] case ${config.options}x${config.users} rounds=${config.rounds} ` +
        `— OFF arm...`,
    );
    off.cases.push(await runCase("off", config));
    console.error(
      `[bench] case ${config.options}x${config.users} rounds=${config.rounds} ` +
        `— ON arm...`,
    );
    on.cases.push(await runCase("on", config));
  }

  const { equivalent, mismatches } = reportComparison(off, on);
  if (!equivalent) {
    console.error("OUTPUT EQUIVALENCE FAILED — interpreter changed results:");
    for (const mismatch of mismatches) console.error(`  ${mismatch}`);
  } else {
    console.log(
      "OUTPUT EQUIVALENCE: PASS — vote tallies identical OFF vs ON.",
    );
  }

  if (emitJson) {
    console.log(JSON.stringify(
      { kind: "lunch-poll-interpreter-bench", equivalent, off, on },
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
