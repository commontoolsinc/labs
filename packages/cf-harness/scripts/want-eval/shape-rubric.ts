/**
 * What the shape judge decides without a model or a run record: the rubric
 * and the prompt that carries it, how a reply is read back into scores, how
 * runs of one case are paired across two shapes, and the median and spread a
 * case×shape's tokens are reported by. `shape-judge.ts` gathers the runs and
 * asks the model.
 */

/**
 * The rubric, one line each, in the order the judge scores them. Length is
 * no criterion of its own: a run that writes more earns nothing for it unless
 * the extra is substance the ask called for.
 */
export const RUBRIC = {
  answers: "Answers the ask: the person's question is answered, or the thing " +
    "they asked for is done.",
  substance: "Substance over filler: findings and a judgement, not a list " +
    "of links, a shortlist without reasons, or an empty scaffold.",
  grounded: "Grounded: every claim rests on something the run read, shown " +
    "in its reads; where it used the web, it names its sources.",
  honest: "Honest about limits: it says what it did not check or could not " +
    "read, and claims absence only for what it searched.",
  fit: "Right-sized: as short as a small ask deserves and as full as a large " +
    "one needs. A brief answer that settles a small ask scores high.",
} as const;

export type Criterion = keyof typeof RUBRIC;
export const CRITERIA: readonly Criterion[] = [
  "answers",
  "substance",
  "grounded",
  "honest",
  "fit",
];

/** What one run left for the person, as the judge is shown it. */
export interface RunMaterial {
  answer: string;

  /** Each page the run wrote, by its path. */
  pages: { path: string; content: string }[];

  /** The tool calls it made, one line each, with an excerpt of each result. */
  reads: string[];
}

/** One run's score on one criterion. */
export interface Score {
  score: number;
  reason: string;
}

/** The judge's reading of one pair, by the label each run was shown under. */
export interface PairVerdict {
  A: Record<Criterion, Score>;
  B: Record<Criterion, Score>;
  winner: "A" | "B" | "tie";
  reason: string;
}

const materialBlock = (label: string, material: RunMaterial): string =>
  [
    `=== Run ${label} ===`,
    `Tile answer: ${material.answer || "(none)"}`,
    "",
    `Reads (${material.reads.length}):`,
    ...(material.reads.length > 0 ? material.reads : ["(none)"]),
    "",
    `Pages written (${material.pages.length}):`,
    ...material.pages.flatMap((page) => [
      `--- ${page.path} ---`,
      page.content,
    ]),
    `=== End of run ${label} ===`,
  ].join("\n");

/**
 * The whole prompt for one pair: the ask, both runs under neutral labels, and
 * the rubric. Which shape each run had is withheld, so the judge rewards what
 * the person got rather than how hard the run was asked to try.
 */
export const pairPrompt = (
  ask: string,
  a: RunMaterial,
  b: RunMaterial,
): string =>
  [
    "You are judging two runs of an assistant that answered the same ask from a person, " +
    "using the person's own data and the web. Each run left a short tile answer and may " +
    "have written pages. Its reads are the tool calls it made, with excerpts of what came back; " +
    "judge grounding against those.",
    "",
    `The ask: ${ask}`,
    "",
    materialBlock("A", a),
    "",
    materialBlock("B", b),
    "",
    "Score each run 1 to 5 on each criterion, with a one-line reason:",
    ...Object.entries(RUBRIC).map(([key, line]) => `- ${key}: ${line}`),
    "",
    "Then say which run the person is better served by, or tie if neither is clearly better. " +
    "Longer is not better in itself, and the order the runs are shown in means nothing.",
    "",
    "Reply with JSON only, in this shape:",
    `{"A": {${
      CRITERIA.map((key) => `"${key}": {"score": 1-5, "reason": "..."}`).join(
        ", ",
      )
    }}, "B": {...same keys...}, "winner": "A" | "B" | "tie", "reason": "one line"}`,
  ].join("\n");

/** The field `name` of `value`, or undefined when it has none. */
const fieldOf = (value: unknown, name: string): unknown =>
  typeof value === "object" && value !== null
    ? Object.entries(value).find(([key]) => key === name)?.[1]
    : undefined;

const scoresOf = (value: unknown, label: string): Record<Criterion, Score> => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`no scores for run ${label}`);
  }
  const scoreOf = (key: Criterion): Score => {
    const score = fieldOf(fieldOf(value, key), "score");
    const reason = fieldOf(fieldOf(value, key), "reason");
    if (
      typeof score !== "number" || !Number.isInteger(score) || score < 1 ||
      score > 5
    ) {
      throw new Error(`run ${label} ${key}: score must be 1-5`);
    }
    return { score, reason: typeof reason === "string" ? reason : "" };
  };
  return {
    answers: scoreOf("answers"),
    substance: scoreOf("substance"),
    grounded: scoreOf("grounded"),
    honest: scoreOf("honest"),
    fit: scoreOf("fit"),
  };
};

/**
 * The verdict in a judge's reply. The reply may wrap its JSON in prose or a
 * code fence; a reply missing a criterion, scoring outside 1–5, or naming no
 * winner is refused rather than read as a partial verdict.
 */
export const parseVerdict = (reply: string): PairVerdict => {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("no JSON in the reply");
  const parsed: unknown = JSON.parse(reply.slice(start, end + 1));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("the reply is not an object");
  }
  const winner = fieldOf(parsed, "winner");
  if (winner !== "A" && winner !== "B" && winner !== "tie") {
    throw new Error(`winner must be A, B or tie, not ${String(winner)}`);
  }
  const reason = fieldOf(parsed, "reason");
  return {
    A: scoresOf(fieldOf(parsed, "A"), "A"),
    B: scoresOf(fieldOf(parsed, "B"), "B"),
    winner,
    reason: typeof reason === "string" ? reason : "",
  };
};

/**
 * The runs of each case paired across two shapes, the i-th run of one with
 * the i-th of the other; a case with more runs under one shape leaves the
 * extras unpaired.
 */
export const pairRuns = <T extends { case: string; variant: string }>(
  runs: readonly T[],
  first: string,
  second: string,
): { case: string; first: T; second: T }[] => {
  const cases = [...new Set(runs.map((run) => run.case))];
  return cases.flatMap((name) => {
    const ofShape = (variant: string) =>
      runs.filter((run) => run.case === name && run.variant === variant);
    const firsts = ofShape(first);
    const seconds = ofShape(second);
    return firsts.slice(0, seconds.length).map((run, index) => ({
      case: name,
      first: run,
      second: seconds[index],
    }));
  });
};

/** The median of `values`; the mean of the middle two for an even count. */
export const median = (values: readonly number[]): number => {
  if (values.length === 0) throw new Error("no values to take a median of");
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** How `values` spread: their least and greatest. */
export const spread = (
  values: readonly number[],
): { min: number; max: number } => {
  if (values.length === 0) throw new Error("no values to spread");
  const sorted = [...values].sort((a, b) => a - b);
  return { min: sorted[0], max: sorted[sorted.length - 1] };
};

/** A verdict read back to the shapes its runs had, from what A and B were. */
export const unblind = (
  verdict: PairVerdict,
  firstWasA: boolean,
): {
  first: Record<Criterion, Score>;
  second: Record<Criterion, Score>;
  winner: "first" | "second" | "tie";
} => ({
  first: firstWasA ? verdict.A : verdict.B,
  second: firstWasA ? verdict.B : verdict.A,
  winner: verdict.winner === "tie"
    ? "tie"
    : (verdict.winner === "A") === firstWasA
    ? "first"
    : "second",
});

/** How much of each page, each read's result, and all reads the judge sees. */
export const LIMITS = { page: 16000, readResult: 1500, reads: 24000 };

const clip = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit)} …[clipped]`;

const argumentsOf = (call: unknown): unknown => {
  const raw = fieldOf(fieldOf(call, "function"), "arguments");
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/** A call's arguments, short: a URL, a query, or a command and its path. */
const callSummary = (name: string, args: unknown): string => {
  const command = fieldOf(args, "command");
  const inner = fieldOf(args, "args");
  const brief = typeof args === "string" ? args : JSON.stringify(
    typeof command === "string" ? { command, args: inner } : args,
  );
  return `${name} ${clip(brief ?? "", 200)}`;
};

/**
 * What the transcripts of one run (its root and any subagents) left for the
 * person: each `page.write` as a page, and every other tool call as a read,
 * with an excerpt of what came back. A tool result the host supplied without
 * a call, such as the opening research a deep run gets before its first
 * turn, is a read too. The answer is the job's own result.
 */
export const materialOf = (
  answer: string,
  transcripts: readonly unknown[],
): RunMaterial => {
  const pages: RunMaterial["pages"] = [];
  const reads: string[] = [];
  let readChars = 0;
  const read = (summary: string, result: string | undefined) => {
    if (readChars === Infinity) return;
    const line = `- ${summary}\n  → ${
      clip((result ?? "(no result)").replace(/\s+/g, " "), LIMITS.readResult)
    }`;
    if (readChars + line.length > LIMITS.reads) {
      reads.push("- …[further reads clipped]");
      readChars = Infinity;
      return;
    }
    reads.push(line);
    readChars += line.length;
  };
  for (const transcript of transcripts) {
    if (!Array.isArray(transcript)) {
      throw new Error("a transcript is not a list of messages");
    }
    const results = new Map<string, string>();
    for (const message of transcript) {
      const id = fieldOf(message, "toolCallId");
      const content = fieldOf(message, "content");
      if (typeof id === "string") {
        results.set(
          id,
          typeof content === "string" ? content : JSON.stringify(content),
        );
      }
    }
    for (const message of transcript) {
      const content = fieldOf(message, "content");
      if (
        fieldOf(message, "toolResultProvenance") !== undefined &&
        fieldOf(message, "toolCallId") === undefined
      ) {
        read(
          "host-supplied result, before the first turn",
          typeof content === "string" ? content : JSON.stringify(content),
        );
      }
      const calls = fieldOf(message, "toolCalls");
      if (!Array.isArray(calls)) continue;
      for (const call of calls) {
        const name = String(fieldOf(fieldOf(call, "function"), "name"));
        if (name === "submit_result") continue;
        const args = argumentsOf(call);
        const inner = fieldOf(args, "args");
        const content = fieldOf(inner, "content");
        if (
          fieldOf(args, "command") === "page.write" &&
          typeof content === "string"
        ) {
          const path = fieldOf(inner, "path");
          pages.push({
            path: typeof path === "string" ? path : "(no path)",
            content: clip(content, LIMITS.page),
          });
          continue;
        }
        const id = fieldOf(call, "id");
        read(
          callSummary(name, args),
          typeof id === "string" ? results.get(id) : undefined,
        );
      }
    }
  }
  return { answer, pages, reads };
};

/** One reading of a pair, read back to its shapes. */
export type Verdict = ReturnType<typeof unblind> & {
  reason: string;
  firstWasA: boolean;
};

/**
 * One pair, judged once in each order so that a judge leaning to whichever
 * run it reads first shows up as a split rather than a win.
 */
export interface JudgedPair {
  case: string;
  firstJob: string;
  secondJob: string;
  verdicts: Verdict[];
  errors: string[];
}

/**
 * Which shape a pair went to: the winner its readings agree on, `split` when
 * they disagree, and undefined when no reading came back.
 */
export const winnerOf = (
  pair: JudgedPair,
): "first" | "second" | "tie" | "split" | undefined => {
  if (pair.verdicts.length === 0) return undefined;
  const [one, ...rest] = pair.verdicts.map((verdict) => verdict.winner);
  return rest.every((winner) => winner === one) ? one : "split";
};

/** A case's line in the summary: cost under both shapes and how pairs went. */
export interface CaseSummary {
  case: string;
  tokens: {
    first: { median: number; min: number; max: number; n: number };
    second: { median: number; min: number; max: number; n: number };
  };
  ratio: number;
  wins: {
    first: number;
    second: number;
    tie: number;
    split: number;
    failed: number;
  };

  /** The mean of each criterion's scores, per shape, over every reading. */
  scores?: {
    first: Record<Criterion, number>;
    second: Record<Criterion, number>;
  };

  /** `second` when it won more pairs than it lost, `first` when fewer. */
  better: "first" | "second" | "even";
}

const meanScores = (
  sides: readonly Record<Criterion, Score>[],
): Record<Criterion, number> => {
  const mean = (key: Criterion) =>
    sides.reduce((sum, side) => sum + side[key].score, 0) / sides.length;
  return {
    answers: mean("answers"),
    substance: mean("substance"),
    grounded: mean("grounded"),
    honest: mean("honest"),
    fit: mean("fit"),
  };
};

/** Each case's summary, from its runs' tokens and its judged pairs. */
export const summarise = (
  runs: readonly { case: string; variant: string; totalTokens: number }[],
  pairs: readonly JudgedPair[],
  first: string,
  second: string,
): CaseSummary[] =>
  [...new Set(runs.map((run) => run.case))].flatMap((name) => {
    const tokensOf = (variant: string) => {
      const values = runs.filter((run) =>
        run.case === name && run.variant === variant
      ).map((run) => run.totalTokens);
      return values.length === 0
        ? undefined
        : { median: median(values), ...spread(values), n: values.length };
    };
    const firstTokens = tokensOf(first);
    const secondTokens = tokensOf(second);
    if (firstTokens === undefined || secondTokens === undefined) return [];
    const ofCase = pairs.filter((pair) => pair.case === name);
    const winners = ofCase.map(winnerOf);
    const count = (winner: ReturnType<typeof winnerOf>) =>
      winners.filter((one) => one === winner).length;
    const wins = {
      first: count("first"),
      second: count("second"),
      tie: count("tie"),
      split: count("split"),
      failed: count(undefined),
    };
    const readings = ofCase.flatMap((pair) => pair.verdicts);
    return [{
      case: name,
      tokens: { first: firstTokens, second: secondTokens },
      ratio: firstTokens.median === 0
        ? 0
        : secondTokens.median / firstTokens.median,
      wins,
      ...(readings.length > 0
        ? {
          scores: {
            first: meanScores(readings.map((v) => v.first)),
            second: meanScores(readings.map((v) => v.second)),
          },
        }
        : {}),
      better: wins.second > wins.first
        ? "second"
        : wins.first > wins.second
        ? "first"
        : "even",
    }];
  });

const total = (scores: Record<Criterion, number>) =>
  CRITERIA.reduce((sum, key) => sum + scores[key], 0);

/** The summary as a markdown table, the shapes named. */
export const summaryTable = (
  summaries: readonly CaseSummary[],
  first: string,
  second: string,
): string =>
  [
    `| case | ${first} tokens (min–max) | ${second} tokens (min–max) | × | ${second} / ${first} / tie / split | ${first} score /25 | ${second} score /25 | widest gap | better |`,
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summaries.map((s) => {
      const tokens = (t: CaseSummary["tokens"]["first"]) =>
        `${Math.round(t.median)} (${t.min}–${t.max}, n=${t.n})`;
      const wins =
        `${s.wins.second} / ${s.wins.first} / ${s.wins.tie} / ${s.wins.split}${
          s.wins.failed > 0 ? ` (${s.wins.failed} failed)` : ""
        }`;
      const scores = s.scores;
      const judged = scores === undefined ? "| - | - | - |" : (() => {
        const widest = CRITERIA.map((key) => ({
          key,
          gap: scores.second[key] - scores.first[key],
        })).reduce((a, b) => Math.abs(b.gap) > Math.abs(a.gap) ? b : a);
        return `| ${total(scores.first).toFixed(1)} | ${
          total(scores.second).toFixed(1)
        } | ${widest.key} ${widest.gap >= 0 ? "+" : ""}${
          widest.gap.toFixed(1)
        } |`;
      })();
      return `| ${s.case} | ${tokens(s.tokens.first)} | ${
        tokens(s.tokens.second)
      } | ${s.ratio.toFixed(1)} | ${wins} ${judged} ${
        s.better === "even" ? "even" : s.better === "second" ? second : first
      } |`;
    }),
  ].join("\n");
