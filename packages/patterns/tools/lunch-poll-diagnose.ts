import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type RuntimeDiagnosticsSnapshot,
} from "../integration/multi-runtime-harness.ts";

interface PollOutputSummary {
  users: readonly { name?: string }[];
  options: readonly { id?: string; title?: string }[];
  votes: readonly {
    voterName?: string;
    optionId?: string;
    voteType?: string;
  }[];
  history: readonly unknown[];
  adminName: string;
  myName: string;
  userCount: number;
  optionCount: number;
  voteCount: number;
  historyCount: number;
  isJoined: boolean;
  isAdmin: boolean;
  homePageLookupUrls: readonly string[];
}

interface TraceAddressSummary {
  space?: string;
  entityId?: string;
  path?: readonly string[];
}

interface ActionRunTraceSummary {
  actionId: string;
  actionType: string;
  durationMs: number;
  declaredWrites: readonly TraceAddressSummary[];
  actualWrites: readonly TraceAddressSummary[];
}

interface DiagnosticsSummary {
  label: string;
  graph: {
    nodes: number;
    edges: number;
    byType: Record<string, number>;
    dirty: number;
    pending: number;
    demanded: number;
    liveEffects: number;
    pullDemandRoots: number;
    topReadNodes: readonly { id: string; type: string; readCount: number }[];
  };
  settle: {
    totalHistoryEntries: number;
    recent: readonly {
      iterations: number;
      totalDurationMs: number;
      initialSeedCount: number;
      maxWorkSetSize: number;
      maxOrderSize: number;
      actionsRun: number;
      settledEarly: boolean;
    }[];
  };
  actions: {
    totalTraceEntries: number;
    newTraceEntries: number;
    slowestNew: readonly ActionRunTraceSummary[];
    newWritesByPath: Record<string, number>;
  };
}

interface MatrixConfig {
  program: string;
  optionCounts: readonly number[];
  userCounts: readonly number[];
  voteRounds: number;
  includeHomepageRefresh: boolean;
}

interface CaseConfig {
  optionCount: number;
  userCount: number;
  voteRounds: number;
  includeHomepageRefresh: boolean;
}

interface CompactSessionSample {
  label: string;
  poll: {
    myName: string;
    isAdmin: boolean;
    users: number;
    options: number;
    votes: number;
    activeLookupUrls: number;
  };
  graph: {
    nodes: number;
    edges: number;
    computations: number;
    inputs: number;
    dirty: number;
    pending: number;
    demanded: number;
  };
  settle: {
    totalHistoryEntries: number;
    maxRecentSettleMs: number;
    maxRecentWorkSet: number;
    recentActionsRun: number;
  };
  actions: {
    totalTraceEntries: number;
    newTraceEntries: number;
    slowestNew: {
      site: string;
      durationMs: number;
      actualWrites: number;
    } | null;
  };
  topReadSites: readonly { site: string; readCount: number; type: string }[];
}

interface PhaseSample {
  phase: string;
  elapsedMs: number;
  aggregate: {
    maxNodes: number;
    maxEdges: number;
    maxDirty: number;
    maxPending: number;
    maxDemanded: number;
    maxRecentSettleMs: number;
    maxRecentWorkSet: number;
    totalRecentActionsRun: number;
    totalNewTraceEntries: number;
    topReadSites: readonly { site: string; readCount: number; type: string }[];
  };
  sessions: readonly CompactSessionSample[];
}

interface CaseResult {
  case: {
    users: number;
    options: number;
    voteRounds: number;
    includeHomepageRefresh: boolean;
  };
  phases: PhaseSample[];
}

const traceCursors = new Map<string, number>();
const TEST_WEB_SEARCH_URL =
  "data:application/json,%7B%22results%22%3A%5B%5D%7D";
const VOTE_COLORS = ["green", "yellow", "red"] as const;
let matrixProgram = "main.tsx";
const ROOT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LUNCH_POLL_DIR = new URL("../lunch-poll/", import.meta.url).pathname
  .replace(/\/$/, "");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const asString = (value: unknown): string =>
  typeof value === "string" ? value : "";

const asNumber = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

const asBoolean = (value: unknown): boolean => value === true;

const asRecordArray = (value: unknown): readonly Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

const asStringArray = (value: unknown): readonly string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

function pollSummary(value: unknown): PollOutputSummary {
  if (!isRecord(value)) {
    throw new Error(
      `poll output is not an object: ${JSON.stringify(value)}`,
    );
  }
  return {
    users: asRecordArray(value.users),
    options: asRecordArray(value.options),
    votes: asRecordArray(value.votes),
    history: Array.isArray(value.history) ? value.history : [],
    adminName: asString(value.adminName),
    myName: asString(value.myName),
    userCount: asNumber(value.userCount),
    optionCount: asNumber(value.optionCount),
    voteCount: asNumber(value.voteCount),
    historyCount: asNumber(value.historyCount),
    isJoined: asBoolean(value.isJoined),
    isAdmin: asBoolean(value.isAdmin),
    homePageLookupUrls: asStringArray(value.homePageLookupUrls),
  };
}

function pathKey(address: TraceAddressSummary): string {
  return `${address.space ?? "?"}/${address.entityId ?? "?"}/$$trel/${
    (address.path ?? []).join(".")
  }`;
}

function traceAddressSummary(value: unknown): TraceAddressSummary {
  if (!isRecord(value)) return {};
  return {
    space: asString(value.space),
    entityId: asString(value.entityId),
    path: asStringArray(value.path),
  };
}

function traceEntrySummary(value: unknown): ActionRunTraceSummary {
  if (!isRecord(value)) {
    return {
      actionId: "",
      actionType: "",
      durationMs: 0,
      declaredWrites: [],
      actualWrites: [],
    };
  }
  return {
    actionId: asString(value.actionId),
    actionType: asString(value.actionType),
    durationMs: asNumber(value.durationMs),
    declaredWrites: Array.isArray(value.declaredWrites)
      ? value.declaredWrites.map(traceAddressSummary)
      : [],
    actualWrites: Array.isArray(value.actualWrites)
      ? value.actualWrites.map(traceAddressSummary)
      : [],
  };
}

function summarizeSettleEntry(value: unknown) {
  const stats = isRecord(value) && isRecord(value.stats) ? value.stats : {};
  const iterations = Array.isArray(stats.iterations) ? stats.iterations : [];
  let maxWorkSetSize = 0;
  let maxOrderSize = 0;
  let actionsRun = 0;
  for (const iteration of iterations) {
    if (!isRecord(iteration)) continue;
    maxWorkSetSize = Math.max(maxWorkSetSize, asNumber(iteration.workSetSize));
    maxOrderSize = Math.max(maxOrderSize, asNumber(iteration.orderSize));
    actionsRun += asNumber(iteration.actionsRun);
  }
  return {
    iterations: iterations.length,
    totalDurationMs: asNumber(stats.totalDurationMs),
    initialSeedCount: asNumber(stats.initialSeedCount),
    maxWorkSetSize,
    maxOrderSize,
    actionsRun,
    settledEarly: asBoolean(stats.settledEarly),
  };
}

function diagnosticsSummary(
  label: string,
  diagnostics: RuntimeDiagnosticsSnapshot,
): DiagnosticsSummary {
  const byType: Record<string, number> = {};
  let dirty = 0;
  let pending = 0;
  let demanded = 0;
  let liveEffects = 0;
  let pullDemandRoots = 0;
  const topReadNodes = diagnostics.graph.nodes
    .map((node) => ({
      id: node.id,
      type: node.type,
      readCount: (node.reads?.length ?? 0) + (node.shallowReads?.length ?? 0),
    }))
    .filter((node) => node.readCount > 0)
    .sort((a, b) => b.readCount - a.readCount)
    .slice(0, 8);

  for (const node of diagnostics.graph.nodes) {
    byType[node.type] = (byType[node.type] ?? 0) + 1;
    if (node.isDirty) dirty++;
    if (node.isPending) pending++;
    if (node.isDemanded) demanded++;
    if (node.isLiveEffect) liveEffects++;
    if (node.isPullDemandRoot) pullDemandRoots++;
  }

  const previousTraceLength = traceCursors.get(label) ?? 0;
  traceCursors.set(label, diagnostics.actionRunTrace.length);
  const newTrace = diagnostics.actionRunTrace.slice(previousTraceLength)
    .map(traceEntrySummary);
  const newWritesByPath: Record<string, number> = {};
  for (const entry of newTrace) {
    for (const write of entry.actualWrites) {
      const key = pathKey(write);
      newWritesByPath[key] = (newWritesByPath[key] ?? 0) + 1;
    }
  }

  return {
    label,
    graph: {
      nodes: diagnostics.graph.nodes.length,
      edges: diagnostics.graph.edges.length,
      byType,
      dirty,
      pending,
      demanded,
      liveEffects,
      pullDemandRoots,
      topReadNodes,
    },
    settle: {
      totalHistoryEntries: diagnostics.settleStatsHistory.length,
      recent: diagnostics.settleStatsHistory.slice(-5).map(
        summarizeSettleEntry,
      ),
    },
    actions: {
      totalTraceEntries: diagnostics.actionRunTrace.length,
      newTraceEntries: newTrace.length,
      slowestNew: [...newTrace].sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 8),
      newWritesByPath,
    },
  };
}

const maxOf = (values: readonly number[]): number =>
  values.length === 0 ? 0 : Math.max(...values);

function compactActionSite(actionId: string): string {
  const marker = `lunch-poll/${matrixProgram}:`;
  const markerIndex = actionId.indexOf(marker);
  if (markerIndex >= 0) {
    const rest = actionId.slice(markerIndex + marker.length);
    const [line = "?", column = "?"] = rest.split(":");
    return `${matrixProgram}:${line}:${column}`;
  }
  if (actionId.startsWith("raw:")) {
    return actionId.split(":").slice(0, 3).join(":");
  }
  if (actionId.startsWith("pull:")) return "pull:result";
  if (actionId.startsWith("sink:")) return "sink:result";
  return actionId.slice(0, 80);
}

function compactTopReadSites(
  diagnostics: DiagnosticsSummary,
): readonly { site: string; readCount: number; type: string }[] {
  const bySite = new Map<
    string,
    { site: string; readCount: number; type: string }
  >();
  for (const node of diagnostics.graph.topReadNodes) {
    const site = compactActionSite(node.id);
    const previous = bySite.get(site);
    bySite.set(site, {
      site,
      readCount: (previous?.readCount ?? 0) + node.readCount,
      type: previous?.type ?? node.type,
    });
  }
  return [...bySite.values()]
    .sort((a, b) => b.readCount - a.readCount)
    .slice(0, 6);
}

function compactSessionSample(
  label: string,
  poll: PollOutputSummary,
  diagnostics: DiagnosticsSummary,
): CompactSessionSample {
  const recent = diagnostics.settle.recent;
  const slowest = diagnostics.actions.slowestNew[0];
  return {
    label,
    poll: {
      myName: poll.myName,
      isAdmin: poll.isAdmin,
      users: poll.userCount,
      options: poll.optionCount,
      votes: poll.voteCount,
      activeLookupUrls: poll.homePageLookupUrls.filter((url) => url !== "")
        .length,
    },
    graph: {
      nodes: diagnostics.graph.nodes,
      edges: diagnostics.graph.edges,
      computations: diagnostics.graph.byType.computation ?? 0,
      inputs: diagnostics.graph.byType.input ?? 0,
      dirty: diagnostics.graph.dirty,
      pending: diagnostics.graph.pending,
      demanded: diagnostics.graph.demanded,
    },
    settle: {
      totalHistoryEntries: diagnostics.settle.totalHistoryEntries,
      maxRecentSettleMs: maxOf(recent.map((entry) => entry.totalDurationMs)),
      maxRecentWorkSet: maxOf(recent.map((entry) => entry.maxWorkSetSize)),
      recentActionsRun: recent.reduce(
        (sum, entry) => sum + entry.actionsRun,
        0,
      ),
    },
    actions: {
      totalTraceEntries: diagnostics.actions.totalTraceEntries,
      newTraceEntries: diagnostics.actions.newTraceEntries,
      slowestNew: slowest
        ? {
          site: compactActionSite(slowest.actionId),
          durationMs: slowest.durationMs,
          actualWrites: slowest.actualWrites.length,
        }
        : null,
    },
    topReadSites: compactTopReadSites(diagnostics),
  };
}

function aggregateSessions(
  sessions: readonly CompactSessionSample[],
): PhaseSample["aggregate"] {
  const topBySite = new Map<
    string,
    { site: string; readCount: number; type: string }
  >();
  for (const session of sessions) {
    for (const site of session.topReadSites) {
      const previous = topBySite.get(site.site);
      if (!previous || site.readCount > previous.readCount) {
        topBySite.set(site.site, site);
      }
    }
  }
  return {
    maxNodes: maxOf(sessions.map((session) => session.graph.nodes)),
    maxEdges: maxOf(sessions.map((session) => session.graph.edges)),
    maxDirty: maxOf(sessions.map((session) => session.graph.dirty)),
    maxPending: maxOf(sessions.map((session) => session.graph.pending)),
    maxDemanded: maxOf(sessions.map((session) => session.graph.demanded)),
    maxRecentSettleMs: maxOf(
      sessions.map((session) => session.settle.maxRecentSettleMs),
    ),
    maxRecentWorkSet: maxOf(
      sessions.map((session) => session.settle.maxRecentWorkSet),
    ),
    totalRecentActionsRun: sessions.reduce(
      (sum, session) => sum + session.settle.recentActionsRun,
      0,
    ),
    totalNewTraceEntries: sessions.reduce(
      (sum, session) => sum + session.actions.newTraceEntries,
      0,
    ),
    topReadSites: [...topBySite.values()]
      .sort((a, b) => b.readCount - a.readCount)
      .slice(0, 8),
  };
}

async function samplePhase(
  phase: string,
  harness: MultiRuntimeHarness,
  runActions: () => Promise<void>,
): Promise<PhaseSample> {
  const startedAt = performance.now();
  await runActions();
  await harness.settle(3);
  const sessions = await Promise.all(harness.sessions.map(async (session) => {
    const poll = pollSummary(await session.read());
    const diagnostics = diagnosticsSummary(
      session.label,
      await session.diagnostics(),
    );
    return compactSessionSample(session.label, poll, diagnostics);
  }));
  const sample = {
    phase,
    elapsedMs: performance.now() - startedAt,
    aggregate: aggregateSessions(sessions),
    sessions,
  } satisfies PhaseSample;
  console.error(
    `[lunch-poll diagnose] ${phase}: maxNodes=${sample.aggregate.maxNodes} ` +
      `maxEdges=${sample.aggregate.maxEdges} maxSettleMs=${
        sample.aggregate.maxRecentSettleMs.toFixed(1)
      } totalNewTrace=${sample.aggregate.totalNewTraceEntries}`,
  );
  return sample;
}

async function optionIds(session: MultiRuntimeSession): Promise<string[]> {
  const poll = pollSummary(await session.read());
  return poll.options.map((option) => option.id).filter((id): id is string =>
    typeof id === "string" && id !== ""
  );
}

async function createHarness(config: CaseConfig): Promise<MultiRuntimeHarness> {
  const harness = await MultiRuntimeHarness.create({
    programPath: `${LUNCH_POLL_DIR}/${matrixProgram}`,
    rootPath: ROOT_PATH,
    diagnostics: true,
    input: {
      webSearchUrl: TEST_WEB_SEARCH_URL,
    },
    sessions: Array.from(
      { length: config.userCount },
      (_entry, index) => `user-${index + 1}`,
    ),
    spaceName:
      `lunch-poll-diagnostics-${config.userCount}u-${config.optionCount}o-${crypto.randomUUID()}`,
  });
  return harness;
}

async function runCase(config: CaseConfig): Promise<CaseResult> {
  traceCursors.clear();
  const harness = await createHarness(config);
  const phases: PhaseSample[] = [];
  const labels = Array.from(
    { length: config.userCount },
    (_entry, index) => `user-${index + 1}`,
  );
  const sessions = labels.map((label) => harness.session(label));
  const host = sessions[0];

  try {
    phases.push(await samplePhase("baseline-open", harness, async () => {}));

    phases.push(
      await samplePhase("all-users-join", harness, async () => {
        await host.send("joinAs", { name: "User 1" });
        await Promise.all(
          sessions.slice(1).map((session, index) =>
            session.send("joinAs", { name: `User ${index + 2}` })
          ),
        );
      }),
    );

    phases.push(
      await samplePhase("host-adds-options", harness, async () => {
        for (let index = 0; index < config.optionCount; index++) {
          await host.send("addOption", { title: `Restaurant ${index + 1}` });
        }
      }),
    );

    for (let round = 0; round < config.voteRounds; round++) {
      phases.push(
        await samplePhase(
          `concurrent-vote-round-${round + 1}`,
          harness,
          async () => {
            const ids = await optionIds(host);
            if (ids.length === 0) return;
            await Promise.all(
              sessions.map((session, index) =>
                session.send("castVote", {
                  optionId: ids[(round + index) % ids.length],
                  voteType: VOTE_COLORS[(round + index) % VOTE_COLORS.length],
                })
              ),
            );
          },
        ),
      );
    }

    if (config.includeHomepageRefresh) {
      phases.push(
        await samplePhase(
          "host-refreshes-homepage-lookups",
          harness,
          async () => {
            await host.send("enrichHomePages", {});
          },
        ),
      );
    }

    return {
      case: {
        users: config.userCount,
        options: config.optionCount,
        voteRounds: config.voteRounds,
        includeHomepageRefresh: config.includeHomepageRefresh,
      },
      phases,
    };
  } finally {
    await harness.dispose();
  }
}

function numberArg(name: string, fallback: number): number {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  const parsed = Number(arg.slice(prefix.length));
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function numberListArg(
  name: string,
  fallback: readonly number[],
  minimum = 0,
): number[] {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return [...fallback];
  const values = arg.slice(prefix.length).split(",")
    .map((entry) => Number(entry.trim()));
  const invalid = values.find((entry) =>
    !Number.isInteger(entry) || entry < minimum
  );
  if (invalid !== undefined) {
    throw new Error(
      `--${name} must be comma-separated integers >= ${minimum}; got ${arg}`,
    );
  }
  return values;
}

function stringArg(name: string, fallback: string): string {
  const prefix = `--${name}=`;
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function explicitCasesArg(
  config: MatrixConfig,
): CaseConfig[] | undefined {
  const prefix = "--cases=";
  const arg = Deno.args.find((entry) => entry.startsWith(prefix));
  if (!arg) return undefined;
  const cases = arg.slice(prefix.length).split(",").flatMap((entry) => {
    const match = entry.trim().match(/^(\d+)x(\d+)$/);
    if (!match) return [];
    const optionCount = Number(match[1]);
    const userCount = Number(match[2]);
    validateUserCount(userCount, entry.trim());
    return [{
      optionCount,
      userCount,
      voteRounds: config.voteRounds,
      includeHomepageRefresh: config.includeHomepageRefresh,
    }];
  });
  return cases.length > 0 ? cases : undefined;
}

function validateUserCount(userCount: number, source: string): void {
  if (!Number.isInteger(userCount) || userCount < 1) {
    throw new Error(
      `lunch-poll diagnostics require at least 1 user for ${source}; ` +
        `got ${userCount}`,
    );
  }
}

function matrixConfigFromArgs(): MatrixConfig {
  const quick = Deno.args.includes("--quick");
  return {
    program: stringArg("program", "main.tsx"),
    optionCounts: numberListArg("options", quick ? [1, 3] : [1, 3, 10]),
    userCounts: numberListArg("users", quick ? [2] : [2, 5], 1),
    voteRounds: numberArg("rounds", quick ? 1 : 3),
    includeHomepageRefresh: !Deno.args.includes("--skip-refresh"),
  };
}

function casesFromConfig(config: MatrixConfig): CaseConfig[] {
  const explicit = explicitCasesArg(config);
  if (explicit) return explicit;
  const cases: CaseConfig[] = [];
  for (const optionCount of config.optionCounts) {
    for (const userCount of config.userCounts) {
      validateUserCount(userCount, `${optionCount}x${userCount}`);
      cases.push({
        optionCount,
        userCount,
        voteRounds: config.voteRounds,
        includeHomepageRefresh: config.includeHomepageRefresh,
      });
    }
  }
  return cases;
}

async function run(): Promise<void> {
  const config = matrixConfigFromArgs();
  matrixProgram = config.program;
  const cases = casesFromConfig(config);
  const startedAt = performance.now();
  const results: ({ ok: true; result: CaseResult } | {
    ok: false;
    case: CaseConfig;
    error: string;
  })[] = [];

  for (const caseConfig of cases) {
    console.error(
      `[lunch-poll diagnose] case ${caseConfig.optionCount} options x ` +
        `${caseConfig.userCount} users, rounds=${caseConfig.voteRounds}`,
    );
    try {
      results.push({ ok: true, result: await runCase(caseConfig) });
    } catch (error) {
      results.push({
        ok: false,
        case: caseConfig,
        error: error instanceof Error
          ? `${error.message}\n${error.stack ?? ""}`
          : String(error),
      });
    }
  }

  console.log(JSON.stringify(
    {
      kind: "lunch-poll-scaling-diagnostics",
      config,
      elapsedMs: performance.now() - startedAt,
      results,
    },
    null,
    2,
  ));
}

if (import.meta.main) {
  try {
    await run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
