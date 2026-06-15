import {
  encodeKey,
  executeViewPlanV1,
  validateViewPlanV1,
  type ViewPlanV1,
} from "./keyed-collection-v1.ts";

type Status = "passed" | "failed" | "skipped";

export interface ViewPlanParityCheckV1 {
  name: string;
  ok: boolean;
  error?: string;
}

export interface ViewPlanParityReportV1 {
  status: Status;
  ok: boolean;
  checks: readonly ViewPlanParityCheckV1[];
  errors: readonly string[];
}

interface OptionRow extends Record<string, unknown> {
  id: string;
  title: string;
}

interface VoteRow extends Record<string, unknown> {
  voter: string;
  optionId: string;
  choice: string;
}

interface TallyRow {
  optionId: string;
  title: string;
  red: number;
  yellow: number;
  green: number;
  total: number;
}

type ReadStringResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

export function checkKeyedCollectionsViewPlanParityV1(
  output: unknown,
): ViewPlanParityReportV1 {
  if (!isRecord(output)) return failed(["output must be an object"]);
  if (output.viewPlans === undefined) {
    return skipped("output has no viewPlans");
  }

  const plans = readViewPlans(output.viewPlans);
  if (Array.isArray(plans)) {
    const optionsPlan = findPlanByView(plans, "orderedValues");
    const votesPlan = findPlanByView(plans, "latestRowsAndCountBuckets");
    if (!optionsPlan) return failed(["missing orderedValues view plan"]);
    if (!votesPlan) {
      return failed(["missing latestRowsAndCountBuckets view plan"]);
    }

    const options = readOptions(output.options);
    const votes = readVotes(output.votes);
    const tallies = readTallies(output.tallies);
    const votedOptions = readOptions(output.votedOptions);
    const optionCount = readNumber(output.optionCount, "optionCount");
    const voteCount = readNumber(output.voteCount, "voteCount");
    const votedOptionCount = readNumber(
      output.votedOptionCount,
      "votedOptionCount",
    );
    if (isErrorString(options)) return failed([options]);
    if (isErrorString(votes)) return failed([votes]);
    if (isErrorString(tallies)) return failed([tallies]);
    if (isErrorString(votedOptions)) return failed([votedOptions]);
    if (isErrorString(optionCount)) return failed([optionCount]);
    if (isErrorString(voteCount)) return failed([voteCount]);
    if (isErrorString(votedOptionCount)) return failed([votedOptionCount]);

    return compareOutputs({
      optionsPlan,
      votesPlan,
      options,
      votes,
      tallies,
      votedOptions,
      optionCount,
      voteCount,
      votedOptionCount,
    });
  }

  return failed([plans]);
}

function compareOutputs(
  input: {
    optionsPlan: ViewPlanV1;
    votesPlan: ViewPlanV1;
    options: readonly OptionRow[];
    votes: readonly VoteRow[];
    tallies: readonly TallyRow[];
    votedOptions: readonly OptionRow[];
    optionCount: number;
    voteCount: number;
    votedOptionCount: number;
  },
): ViewPlanParityReportV1 {
  const checks: ViewPlanParityCheckV1[] = [];

  const optionsExecution = executeViewPlanV1(input.optionsPlan, input.options);
  if (!optionsExecution.ok) {
    return failed([`orderedValues executor failed: ${optionsExecution.error}`]);
  }
  const optionsResult = optionsExecution.result;
  if (optionsResult.view !== "orderedValues") {
    return failed([`orderedValues executor returned ${optionsResult.view}`]);
  }

  addCheck(
    checks,
    "orderedValues count matches optionCount",
    optionsResult.count === input.optionCount,
    `expected ${input.optionCount}, got ${optionsResult.count}`,
  );
  addCheck(
    checks,
    "orderedValues rows match options",
    optionsResult.rows.length === input.options.length &&
      input.options.every((option, index) => {
        const executed = optionsResult.rows[index];
        return executed?.id === option.id && executed.title === option.title;
      }),
    "executor rows differ from published options",
  );

  const votesExecution = executeViewPlanV1(input.votesPlan, input.votes);
  if (!votesExecution.ok) {
    return failed([
      `latestRowsAndCountBuckets executor failed: ${votesExecution.error}`,
    ]);
  }
  const votesResult = votesExecution.result;
  if (votesResult.view !== "latestRowsAndCountBuckets") {
    return failed([
      `latestRowsAndCountBuckets executor returned ${votesResult.view}`,
    ]);
  }

  addCheck(
    checks,
    "latest row count matches voteCount",
    votesResult.count === input.voteCount &&
      votesResult.latestRows.length === input.votes.length,
    `expected ${input.voteCount}, got count=${votesResult.count} rows=${votesResult.latestRows.length}`,
  );
  addCheck(
    checks,
    "latestByKey rows match votes",
    input.votes.every((vote) => {
      const executed = votesResult.latestByKey[encodeKey(vote.voter)];
      return executed?.voter === vote.voter &&
        executed.optionId === vote.optionId &&
        executed.choice === vote.choice;
    }),
    "executor latestByKey differs from published votes",
  );

  const optionKeys = new Set(
    input.options.map((option) => encodeKey(option.id)),
  );
  const talliesMatch = input.tallies.length === input.options.length &&
    input.options.every((option, index) => {
      const tally = input.tallies[index];
      if (
        !tally || tally.optionId !== option.id || tally.title !== option.title
      ) {
        return false;
      }
      const bucket = votesResult.countsByGroup[encodeKey(option.id)];
      return tally.red === (bucket?.choices.red ?? 0) &&
        tally.yellow === (bucket?.choices.yellow ?? 0) &&
        tally.green === (bucket?.choices.green ?? 0) &&
        tally.total === (bucket?.total ?? 0);
    });
  const hasNoOrphanNonzeroBuckets = Object.entries(
    votesResult.countsByGroup,
  ).every(([key, bucket]) => optionKeys.has(key) || bucket.total === 0);
  addCheck(
    checks,
    "count buckets match tallies",
    talliesMatch && hasNoOrphanNonzeroBuckets,
    "executor count buckets differ from published tallies",
  );

  const executedVotedOptions = input.options.filter((option) => {
    return (votesResult.countsByGroup[encodeKey(option.id)]?.total ?? 0) > 0;
  });
  addCheck(
    checks,
    "voted options match nonzero buckets",
    hasNoOrphanNonzeroBuckets &&
      executedVotedOptions.length === input.votedOptionCount &&
      executedVotedOptions.length === input.votedOptions.length &&
      input.votedOptions.every((option, index) =>
        executedVotedOptions[index]?.id === option.id &&
        executedVotedOptions[index]?.title === option.title
      ),
    "published votedOptions differ from nonzero executor buckets",
  );

  const errors = checks.flatMap((check) =>
    check.ok ? [] : [
      `${check.name}: ${check.error ?? "failed"}`,
    ]
  );
  return {
    status: errors.length === 0 ? "passed" : "failed",
    ok: errors.length === 0,
    checks,
    errors,
  };
}

function readViewPlans(value: unknown): ViewPlanV1[] | string {
  if (!Array.isArray(value)) return "viewPlans must be an array";
  const plans: ViewPlanV1[] = [];
  for (const entry of value) {
    const validation = validateViewPlanV1(entry);
    if (!validation.ok) {
      return `invalid viewPlan: ${validation.errors.join("; ")}`;
    }
    if (!isViewPlanV1(entry)) {
      return "invalid viewPlan";
    }
    plans.push(entry);
  }
  return plans;
}

function findPlanByView(
  plans: readonly ViewPlanV1[],
  view: string,
): ViewPlanV1 | undefined {
  return plans.find((plan) =>
    plan.steps.some((step) => step.kind === "materialize" && step.view === view)
  );
}

function readOptions(value: unknown): OptionRow[] | string {
  if (!Array.isArray(value)) return "options must be an array";
  const rows: OptionRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return "option entries must be objects";
    const id = stringField(entry, "id");
    const title = stringField(entry, "title");
    if (!id.ok) return `option.id ${id.error}`;
    if (!title.ok) return `option.title ${title.error}`;
    rows.push({ id: id.value, title: title.value });
  }
  return rows;
}

function readVotes(value: unknown): VoteRow[] | string {
  if (!Array.isArray(value)) return "votes must be an array";
  const rows: VoteRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return "vote entries must be objects";
    const voter = stringField(entry, "voter");
    const optionId = stringField(entry, "optionId");
    const choice = stringField(entry, "choice");
    if (!voter.ok) return `vote.voter ${voter.error}`;
    if (!optionId.ok) return `vote.optionId ${optionId.error}`;
    if (!choice.ok) return `vote.choice ${choice.error}`;
    rows.push({
      voter: voter.value,
      optionId: optionId.value,
      choice: choice.value,
    });
  }
  return rows;
}

function readTallies(value: unknown): TallyRow[] | string {
  if (!Array.isArray(value)) return "tallies must be an array";
  const rows: TallyRow[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return "tally entries must be objects";
    const optionId = stringField(entry, "optionId");
    const title = stringField(entry, "title");
    if (!optionId.ok) return `tally.optionId ${optionId.error}`;
    if (!title.ok) return `tally.title ${title.error}`;
    const red = readNumber(entry.red, "tally.red");
    const yellow = readNumber(entry.yellow, "tally.yellow");
    const green = readNumber(entry.green, "tally.green");
    const total = readNumber(entry.total, "tally.total");
    if (isErrorString(red)) return red;
    if (isErrorString(yellow)) return yellow;
    if (isErrorString(green)) return green;
    if (isErrorString(total)) return total;
    rows.push({
      optionId: optionId.value,
      title: title.value,
      red,
      yellow,
      green,
      total,
    });
  }
  return rows;
}

function readNumber(value: unknown, label: string): number | string {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : `${label} must be a finite number`;
}

function stringField(
  record: Record<string, unknown>,
  field: string,
): ReadStringResult {
  const value = record[field];
  return typeof value === "string" && value.trim() !== ""
    ? { ok: true, value }
    : { ok: false, error: "must be a nonblank string" };
}

function addCheck(
  checks: ViewPlanParityCheckV1[],
  name: string,
  ok: boolean,
  error: string,
): void {
  checks.push(ok ? { name, ok } : { name, ok, error });
}

function skipped(reason: string): ViewPlanParityReportV1 {
  return { status: "skipped", ok: true, checks: [], errors: [reason] };
}

function failed(errors: readonly string[]): ViewPlanParityReportV1 {
  return { status: "failed", ok: false, checks: [], errors };
}

function isViewPlanV1(value: unknown): value is ViewPlanV1 {
  return validateViewPlanV1(value).ok;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isErrorString(value: unknown): value is string {
  return typeof value === "string";
}
