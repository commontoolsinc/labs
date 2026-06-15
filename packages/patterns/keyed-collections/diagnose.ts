import {
  MultiRuntimeHarness,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";
import {
  checkKeyedCollectionsViewPlanParityV1,
  type ViewPlanParityReportV1,
} from "./keyed-collection-v1.ts";

interface PerfOutputSummary {
  optionCount: number;
  voteCount: number;
  tallies: readonly { optionId?: string; total?: number }[];
}

interface CaseResult {
  program: string;
  mode: Mode;
  votes: number;
  addOptionsMs: number;
  castVotesMs: number;
  output: PerfOutputSummary;
  viewPlanParity?: ViewPlanParityReportV1;
  graph: {
    nodes: number;
    edges: number;
    byType: Record<string, number>;
    dirty: number;
    pending: number;
    demanded: number;
  };
  settle: {
    historyEntries: number;
    maxRecentSettleMs: number;
    maxRecentWorkSet: number;
    recentActionsRun: number;
  };
  actions: {
    traceEntries: number;
    slowestRecentMs: number;
  };
}

type Mode = "sequential" | "bulk";

const DEFAULT_PROGRAMS = [
  "perf-array.tsx",
  "perf-indexed.tsx",
  "perf-v1.tsx",
  "perf-sqlite.tsx",
];
const DEFAULT_VOTES = [100, 500];
const DEFAULT_MODES: readonly Mode[] = ["sequential"];
const OPTIONS = [
  { id: "ethiopia", title: "Ethiopia" },
  { id: "colombia", title: "Colombia" },
  { id: "kenya", title: "Kenya" },
  { id: "guatemala", title: "Guatemala" },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

function numberListArg(name: string, fallback: readonly number[]): number[] {
  const prefix = `--${name}=`;
  const raw = Deno.args.find((arg) => arg.startsWith(prefix))?.slice(
    prefix.length,
  );
  if (!raw) return [...fallback];
  return raw.split(",").map((part) => Number(part.trim())).filter((value) =>
    Number.isInteger(value) && value > 0
  );
}

function stringListArg(name: string, fallback: readonly string[]): string[] {
  const prefix = `--${name}=`;
  const raw = Deno.args.find((arg) => arg.startsWith(prefix))?.slice(
    prefix.length,
  );
  if (!raw) return [...fallback];
  return raw.split(",").map((part) => part.trim()).filter(Boolean);
}

function isMode(value: string): value is Mode {
  return value === "sequential" || value === "bulk";
}

function modesArg(): Mode[] {
  const modes = stringListArg("modes", DEFAULT_MODES).filter(isMode);
  return modes.length > 0 ? modes : [...DEFAULT_MODES];
}

function outputSummary(value: unknown): PerfOutputSummary {
  if (!isRecord(value)) {
    throw new Error(
      `pattern output is not an object: ${JSON.stringify(value)}`,
    );
  }
  const tallies = Array.isArray(value.tallies)
    ? value.tallies.filter(isRecord).map((entry) => ({
      optionId: typeof entry.optionId === "string" ? entry.optionId : undefined,
      total: asNumber(entry.total),
    }))
    : [];
  return {
    optionCount: asNumber(value.optionCount),
    voteCount: asNumber(value.voteCount),
    tallies,
  };
}

function summarizeSettleEntry(value: unknown) {
  const stats = isRecord(value) && isRecord(value.stats) ? value.stats : {};
  const iterations = Array.isArray(stats.iterations) ? stats.iterations : [];
  let maxWorkSetSize = 0;
  let actionsRun = 0;
  for (const iteration of iterations) {
    if (!isRecord(iteration)) continue;
    maxWorkSetSize = Math.max(maxWorkSetSize, asNumber(iteration.workSetSize));
    actionsRun += asNumber(iteration.actionsRun);
  }
  return {
    totalDurationMs: asNumber(stats.totalDurationMs),
    maxWorkSetSize,
    actionsRun,
  };
}

function diagnosticsSummary(diagnostics: RuntimeDiagnosticsSnapshot) {
  const byType: Record<string, number> = {};
  let dirty = 0;
  let pending = 0;
  let demanded = 0;
  for (const node of diagnostics.graph.nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    if (node.isDirty) dirty++;
    if (node.isPending) pending++;
    if (node.isDemanded) demanded++;
  }

  const recentSettle = diagnostics.settleStatsHistory.slice(-8).map(
    summarizeSettleEntry,
  );
  const recentActions = diagnostics.actionRunTrace.slice(-64).filter(isRecord);
  return {
    graph: {
      nodes: diagnostics.graph.nodes.length,
      edges: diagnostics.graph.edges.length,
      byType,
      dirty,
      pending,
      demanded,
    },
    settle: {
      historyEntries: diagnostics.settleStatsHistory.length,
      maxRecentSettleMs: Math.max(
        0,
        ...recentSettle.map((entry) => entry.totalDurationMs),
      ),
      maxRecentWorkSet: Math.max(
        0,
        ...recentSettle.map((entry) => entry.maxWorkSetSize),
      ),
      recentActionsRun: recentSettle.reduce(
        (sum, entry) => sum + entry.actionsRun,
        0,
      ),
    },
    actions: {
      traceEntries: diagnostics.actionRunTrace.length,
      slowestRecentMs: Math.max(
        0,
        ...recentActions.map((entry) => asNumber(entry.durationMs)),
      ),
    },
  };
}

async function timed(run: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await run();
  return performance.now() - started;
}

async function runCase(
  program: string,
  votes: number,
  mode: Mode,
): Promise<CaseResult> {
  const here = new URL(".", import.meta.url);
  const programPath = new URL(program, here).pathname;
  const rootPath = here.pathname.replace(/\/$/, "");
  const harness = await MultiRuntimeHarness.create({
    programPath,
    rootPath,
    diagnostics: true,
    sessions: ["perf"],
  });
  try {
    const session = harness.session("perf");
    const addOptionsMs = await timed(async () => {
      for (const option of OPTIONS) {
        await session.send("addOption", option);
      }
    });

    const castVotesMs = await timed(async () => {
      if (mode === "bulk") {
        await session.send("seedVotes", { count: votes });
      } else {
        for (let i = 0; i < votes; i++) {
          const option = OPTIONS[i % OPTIONS.length];
          await session.send("castVote", {
            voter: `user-${i}`,
            optionId: option.id,
            choice: "green",
          });
        }
      }
    });

    await harness.settle(3);
    const rawOutput = await session.read();
    const output = outputSummary(rawOutput);
    const viewPlanParity = checkKeyedCollectionsViewPlanParityV1(rawOutput);
    const diagnostics = diagnosticsSummary(await session.diagnostics());
    const result: CaseResult = {
      program,
      mode,
      votes,
      addOptionsMs,
      castVotesMs,
      output,
      ...diagnostics,
    };
    if (viewPlanParity.status !== "skipped") {
      result.viewPlanParity = viewPlanParity;
    }
    return result;
  } finally {
    await harness.dispose();
  }
}

async function main() {
  const programs = stringListArg("programs", DEFAULT_PROGRAMS);
  const voteCounts = numberListArg("votes", DEFAULT_VOTES);
  const modes = modesArg();
  const results: CaseResult[] = [];
  for (const votes of voteCounts) {
    for (const mode of modes) {
      for (const program of programs) {
        console.error(
          `[keyed-collections diagnose] ${program} mode=${mode} votes=${votes}`,
        );
        const result = await runCase(program, votes, mode);
        console.error(
          `[keyed-collections diagnose] ${program} mode=${mode} votes=${votes} ` +
            `workloadMs=${result.castVotesMs.toFixed(1)} ` +
            `nodes=${result.graph.nodes} edges=${result.graph.edges}`,
        );
        results.push(result);
      }
    }
  }
  console.log(JSON.stringify({ results }, null, 2));
}

if (import.meta.main) await main();
