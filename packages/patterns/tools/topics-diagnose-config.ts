export const ALL_TOPICS_SCENARIOS = [
  "names",
  "create-topics",
  "noops",
  "titles",
  "comments",
  "links",
  "bodies",
  "crossrefs",
  "root-oscillation",
] as const;

export type TopicsScenario = typeof ALL_TOPICS_SCENARIOS[number];

const MATRIX_TOPICS_SCENARIOS = ALL_TOPICS_SCENARIOS.filter(
  (scenario) => scenario !== "root-oscillation",
);

export const TOPICS_DIAGNOSTICS_PROFILES = ["matrix", "conflicts"] as const;

export type TopicsDiagnosticsProfile =
  typeof TOPICS_DIAGNOSTICS_PROFILES[number];

export interface TopicsDiagnosticsConfig {
  profile: TopicsDiagnosticsProfile;
  program: string;
  topicCounts: readonly number[];
  userCounts: readonly number[];
  rounds: number;
  typingSteps: number;
  sessionsPerUser: number;
  wsDelayMs: number;
  scenarios: readonly TopicsScenario[];
}

export interface TopicsDiagnosticsCase {
  topics: number;
  users: number;
}

/** The counter-only shape supplied by MultiRuntimeSession telemetry snapshots. */
export interface RuntimeTelemetrySnapshot {
  invocationCount: number;
  distinctInvokedEventCount: number;
  distinctSuccessfulEventCount: number;
  distinctDroppedEventCount: number;
  droppedEventsByReason: Record<
    "piece-load" | "lineage" | "preflight" | "load-gate",
    number
  >;
  permanentRejectionsByReason: Record<
    "origin-committed" | "receipt-exists",
    number
  >;
  commitMarkerCount: number;
  directCommitCount: number;
  successfulCommitCount: number;
  failedAttemptCount: number;
  terminalFailureCount: number;
  retryMarkerCount: number;
  maxRetryAttempt: number;
  readCount: number;
  writeCount: number;
  changedWriteCount: number;
  writesTruncatedCount: number;
  writesByPathShape: Record<string, number>;
}

export interface DerivedTelemetry {
  changedWritesPerSubmittedOperation: number;
  attemptedWritesPerSubmittedOperation: number;
  elidedNoopCandidateWrites: number;
}

export interface RootOscillationMetadata {
  distinctStateCount: number;
  targetWriteCount: number;
  twoStepEligibleCount: number;
  twoStepRepeatCount: number;
  twoStepRepeatRatio: number | null;
}

export { writePathShape } from "../integration/telemetry-path-shape.ts";

function explicitArg(
  args: readonly string[],
  name: string,
): string | undefined {
  const prefix = `--${name}=`;
  const matches = args.filter((arg) => arg.startsWith(prefix));
  if (matches.length > 1) throw new Error(`--${name} may be provided once`);
  return matches[0]?.slice(prefix.length);
}

function nonNegativeInteger(value: string, name: string, minimum = 0): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`--${name} must be an integer >= ${minimum}; got ${value}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`--${name} must be an integer >= ${minimum}; got ${value}`);
  }
  return parsed;
}

function numberList(
  args: readonly string[],
  name: string,
  fallback: readonly number[],
  minimum: number,
): number[] {
  const raw = explicitArg(args, name);
  if (raw === undefined) return [...fallback];
  if (raw.trim() === "") throw new Error(`--${name} must not be empty`);
  return raw.split(",").map((value) =>
    nonNegativeInteger(value.trim(), name, minimum)
  );
}

function isTopicsScenario(value: string): value is TopicsScenario {
  return ALL_TOPICS_SCENARIOS.some((scenario) => scenario === value);
}

function scenarioList(
  args: readonly string[],
  fallback: readonly TopicsScenario[],
): TopicsScenario[] {
  const raw = explicitArg(args, "scenario");
  if (raw === undefined) return [...fallback];
  if (raw === "all") return [...ALL_TOPICS_SCENARIOS];
  if (raw.trim() === "") throw new Error("--scenario must not be empty");
  const names = raw.split(",").map((entry) => entry.trim());
  if (names.includes("all")) {
    throw new Error("--scenario=all cannot be combined with named scenarios");
  }
  const unknown = names.find((name) => !isTopicsScenario(name));
  if (unknown) {
    throw new Error(
      `unknown scenario "${unknown}"; choose ${
        ALL_TOPICS_SCENARIOS.join(", ")
      }, or all`,
    );
  }
  return [...new Set(names.filter(isTopicsScenario))];
}

function profileFromArgs(args: readonly string[]): TopicsDiagnosticsProfile {
  const profile = explicitArg(args, "profile") ?? "matrix";
  if (
    !TOPICS_DIAGNOSTICS_PROFILES.some((candidate) => candidate === profile)
  ) {
    throw new Error(
      `unknown profile "${profile}"; choose ${
        TOPICS_DIAGNOSTICS_PROFILES.join(", ")
      }`,
    );
  }
  return profile as TopicsDiagnosticsProfile;
}

export function configFromArgs(
  args: readonly string[],
): TopicsDiagnosticsConfig {
  const quick = args.includes("--quick");
  const profile = profileFromArgs(args);
  const conflicts = profile === "conflicts";
  const program = explicitArg(args, "program") ?? "topics/main.tsx";
  if (program.trim() === "") throw new Error("--program must not be empty");
  return {
    profile,
    program,
    topicCounts: numberList(
      args,
      "topics",
      conflicts || quick ? [2] : [2, 8],
      1,
    ),
    userCounts: numberList(
      args,
      "users",
      conflicts || quick ? [2] : [2, 4],
      1,
    ),
    rounds: nonNegativeInteger(
      explicitArg(args, "rounds") ??
        String(conflicts ? (quick ? 2 : 4) : quick ? 1 : 3),
      "rounds",
    ),
    typingSteps: nonNegativeInteger(
      explicitArg(args, "typing-steps") ??
        String(conflicts ? 2 : quick ? 2 : 5),
      "typing-steps",
    ),
    sessionsPerUser: nonNegativeInteger(
      explicitArg(args, "sessions-per-user") ?? String(conflicts ? 2 : 1),
      "sessions-per-user",
      1,
    ),
    wsDelayMs: nonNegativeInteger(
      explicitArg(args, "ws-delay-ms") ?? String(conflicts ? 10 : 0),
      "ws-delay-ms",
    ),
    scenarios: scenarioList(
      args,
      conflicts ? ["root-oscillation"] : MATRIX_TOPICS_SCENARIOS,
    ),
  };
}

export function casesFromArgs(
  args: readonly string[],
  config: TopicsDiagnosticsConfig,
): TopicsDiagnosticsCase[] {
  const raw = explicitArg(args, "cases");
  const cases = raw === undefined
    ? config.topicCounts.flatMap((topics) =>
      config.userCounts.map((users) => ({ topics, users }))
    )
    : raw.split(",").map((entry) => {
      if (raw.trim() === "") throw new Error("--cases must not be empty");
      const source = entry.trim();
      const match = /^(\d+)x(\d+)$/.exec(source);
      if (!match) {
        throw new Error(`--cases entries must be TOPICSxUSERS; got ${source}`);
      }
      return {
        topics: nonNegativeInteger(match[1], "cases topics", 1),
        users: nonNegativeInteger(match[2], "cases users", 1),
      };
    });
  if (
    config.scenarios.includes("crossrefs") ||
    config.scenarios.includes("root-oscillation")
  ) {
    const invalid = cases.find((entry) => entry.topics < 2);
    if (invalid) {
      throw new Error(
        `${
          config.scenarios.includes("root-oscillation")
            ? "root-oscillation"
            : "crossrefs"
        } requires at least 2 topics; got ${invalid.topics}x${invalid.users}`,
      );
    }
  }
  if (config.scenarios.includes("root-oscillation")) {
    if (config.rounds < 1) {
      throw new Error("root-oscillation requires --rounds >= 1");
    }
    const invalid = cases.find((entry) =>
      entry.users * config.sessionsPerUser < 2
    );
    if (invalid) {
      throw new Error(
        `root-oscillation requires at least 2 total sessions; got ${invalid.topics}x${invalid.users} with ${config.sessionsPerUser} sessions per user`,
      );
    }
  }
  return cases;
}

export function deriveTelemetry(
  telemetry: RuntimeTelemetrySnapshot,
  submittedOperations: number,
): DerivedTelemetry {
  return {
    changedWritesPerSubmittedOperation: submittedOperations === 0
      ? 0
      : telemetry.changedWriteCount / submittedOperations,
    attemptedWritesPerSubmittedOperation: submittedOperations === 0
      ? 0
      : telemetry.writeCount / submittedOperations,
    elidedNoopCandidateWrites: Math.max(
      0,
      telemetry.writeCount - telemetry.changedWriteCount,
    ),
  };
}

/** Content-free repeat statistics for intended whole-root state transitions. */
export function rootOscillationMetadata(
  attemptedStates: readonly number[],
): RootOscillationMetadata {
  const twoStepAttemptCount = Math.max(0, attemptedStates.length - 2);
  const twoStepRepeatCount = attemptedStates.reduce(
    (count, state, index) =>
      index >= 2 && state === attemptedStates[index - 2] ? count + 1 : count,
    0,
  );
  return {
    distinctStateCount: new Set(attemptedStates).size,
    targetWriteCount: attemptedStates.length,
    twoStepEligibleCount: twoStepAttemptCount,
    twoStepRepeatCount,
    twoStepRepeatRatio: twoStepAttemptCount === 0
      ? null
      : twoStepRepeatCount / twoStepAttemptCount,
  };
}
