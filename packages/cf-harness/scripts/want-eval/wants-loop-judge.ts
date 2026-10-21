/**
 * What the wants loop decides without a live service: how its cases are
 * written, whether an answer shows a marker want's effect, whether a job was
 * briefed with the marker, and how the runs add up to a table.
 * `wants-loop.ts` does the filing and the reading.
 *
 * A marker want is one whose effect on an answer can be checked without a
 * model: answering in French, ending on a given word, writing in lowercase.
 * The loop runs the same asks before the marker is kept, while it is kept,
 * and after it is archived, so its effect should appear and then go.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The line the service opens a job's briefing with, in the job's
 * instructions, ahead of one `- <words>` line for each of the person's
 * current wants.
 */
export const BRIEFING_HEADING =
  "The person's current wants, in their own words, from their wants list:";

/** How a marker's effect is read off an answer. */
export type MarkerCheck =
  | { kind: "french" }
  | { kind: "last-word"; word: string }
  | { kind: "lowercase" };

/** A want kept for later whose effect on an answer is checkable. */
export interface Marker {
  id: string;
  words: string;
  check: MarkerCheck;
}

/** An ask said now, needing no personal data to answer. */
export interface Probe {
  id: string;
  text: string;
}

/** The asks, and the markers each is run against. */
export interface LoopCases {
  probes: Probe[];
  markers: Marker[];
}

/** When a run happened, relative to the marker being kept. */
export type Phase = "before" | "during" | "after";

export const PHASES: readonly Phase[] = ["before", "during", "after"];

/** Whether a check held, and what it saw. */
export interface Verdict {
  pass: boolean;
  detail: string;
}

/** What a job's request says it was briefed with. */
export interface Briefing {
  /**
   * The want ids in the request's `context.briefed`, or `undefined` where
   * the request carries no such list, which is not the same as an empty one.
   */
  briefed: string[] | undefined;

  /** Whether the instructions carry the briefing heading. */
  heading: boolean;

  /** The `- <words>` lines under the heading, without their dash. */
  listed: string[];
}

/** One probe run once in one phase of one marker. */
export interface LoopRun {
  marker: string;
  phase: Phase;
  probe: string;
  attempt: number;
  job: string;
  state: string;
  seconds: number;
  modelTurns: number;
  totalTokens: number;
  answer: string;
  briefing: Briefing;

  /** Whether the run's `context.briefed` names the marker's want. */
  markerBriefed: boolean;

  briefingVerdict: Verdict;
  check: Verdict;
}

/** How one phase of one marker went, over its runs. */
export interface PhaseSummary {
  runs: number;
  passes: number;
  briefed: number;
  briefingOk: number;
  meanSeconds: number;
  meanTurns: number;
  meanTokens: number;
}

/** How one marker went across its three phases. */
export interface MarkerSummary {
  marker: string;
  phases: Record<Phase, PhaseSummary>;

  /**
   * Whether the loop closed: every briefing as expected, and the marker's
   * check passing more often while it was kept than before or after.
   */
  closed: boolean;
}

/** Helper for `parseCases()`: `value` as a nonempty string, or a throw. */
const text = (value: unknown, where: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where} must be a nonempty string`);
  }
  return value;
};

/** Helper for `parseCases()`: `value` as an array, or a throw. */
const list = (value: unknown, where: string): unknown[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${where} must be a nonempty array`);
  }
  return value;
};

/** Helper for `parseCases()`: `value` as an object, or a throw. */
const record = (
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> => {
  if (!isObjectNotArray(value)) throw new Error(`${where} must be an object`);
  return value;
};

/** Helper for `parseCases()`, which reads one marker's check. */
const checkOf = (value: unknown, where: string): MarkerCheck => {
  const check = record(value, where);
  switch (check.kind) {
    case "french":
      return { kind: "french" };
    case "lowercase":
      return { kind: "lowercase" };
    case "last-word":
      return { kind: "last-word", word: text(check.word, `${where}.word`) };
    default:
      throw new Error(
        `${where}.kind must be french, last-word or lowercase, not ${
          JSON.stringify(check.kind)
        }`,
      );
  }
};

/**
 * The cases a cases file holds, or a throw naming the first thing wrong with
 * it, so a typo stops the loop before it files anything.
 */
export const parseCases = (json: unknown): LoopCases => {
  const cases = record(json, "cases");
  const probes = list(cases.probes, "probes").map((value, index) => {
    const probe = record(value, `probes[${index}]`);
    return {
      id: text(probe.id, `probes[${index}].id`),
      text: text(probe.text, `probes[${index}].text`),
    };
  });
  const markers = list(cases.markers, "markers").map((value, index) => {
    const marker = record(value, `markers[${index}]`);
    return {
      id: text(marker.id, `markers[${index}].id`),
      words: text(marker.words, `markers[${index}].words`),
      check: checkOf(marker.check, `markers[${index}].check`),
    };
  });
  for (const ids of [probes, markers].map((rows) => rows.map((r) => r.id))) {
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
    if (repeated !== undefined) throw new Error(`id ${repeated} repeats`);
  }
  return { probes, markers };
};

/** Words that mark a sentence as French, none of them common English. */
const FRENCH = new Set([
  "le",
  "la",
  "les",
  "des",
  "du",
  "de",
  "est",
  "et",
  "une",
  "un",
  "pour",
  "dans",
  "avec",
  "sur",
  "qui",
  "que",
  "pas",
  "sont",
  "au",
  "aux",
  "ce",
  "cette",
  "il",
  "elle",
  "par",
  "été",
  "parce",
  "jours",
  "année",
]);

/** Words that mark a sentence as English, none of them French. */
const ENGLISH = new Set([
  "the",
  "is",
  "of",
  "and",
  "to",
  "in",
  "was",
  "are",
  "it",
  "for",
  "with",
  "that",
  "by",
  "as",
  "because",
  "has",
  "days",
  "year",
]);

/** The words of `answer`, lowercased, split at anything not a letter. */
const wordsOf = (answer: string): string[] =>
  answer.toLowerCase().split(/[^\p{L}]+/u).filter((word) => word !== "");

/** Whether `answer` shows the marker's effect, and what was seen. */
export const checkMarker = (check: MarkerCheck, answer: string): Verdict => {
  switch (check.kind) {
    case "french": {
      // A bare name such as "Canberra." is in no language, so it fails: the
      // probes ask for an explanation, which a French answer gives in French.
      const words = wordsOf(answer);
      const french = words.filter((word) => FRENCH.has(word)).length;
      const english = words.filter((word) => ENGLISH.has(word)).length;
      return {
        pass: french >= 3 && french > english,
        detail: `${french} French, ${english} English stopwords`,
      };
    }
    case "last-word": {
      // The word is matched exactly, case included, so an English sentence
      // that happens to end on "over" does not pass for one ending on "OVER".
      const last = answer.trim().split(/\s+/).at(-1)?.replace(
        /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
        "",
      ) ?? "";
      return {
        pass: last === check.word,
        detail: `last word ${JSON.stringify(last)}`,
      };
    }
    case "lowercase": {
      const capitals = [...answer].filter((char) =>
        char !== char.toLowerCase()
      );
      return {
        pass: /\p{L}/u.test(answer) && capitals.length === 0,
        detail: capitals.length === 0
          ? "no capitals"
          : `${capitals.length} capitals (${capitals.slice(0, 5).join("")})`,
      };
    }
  }
};

/**
 * What a job's request, as the runner's snapshot holds it, says it was
 * briefed with.
 */
export const briefingOf = (request: unknown): Briefing => {
  const fields = isObjectNotArray(request) ? request : {};
  const instructions = typeof fields.instructions === "string"
    ? fields.instructions
    : "";
  const context = isObjectNotArray(fields.context) ? fields.context : {};
  const briefed = Array.isArray(context.briefed)
    ? context.briefed.map((id) => String(id))
    : undefined;
  const lines = instructions.split("\n");
  const at = lines.indexOf(BRIEFING_HEADING);
  const listed: string[] = [];
  if (at >= 0) {
    for (const line of lines.slice(at + 1)) {
      if (!line.startsWith("- ")) break;
      listed.push(line.slice(2));
    }
  }
  return { briefed, heading: at >= 0, listed };
};

/**
 * Whether a briefing names the want `id`, which is `undefined` before the
 * want is filed. A want's id may be listed bare or as Moments names its
 * subject, `want:<id>`.
 */
export const briefs = (briefing: Briefing, id: string | undefined): boolean =>
  id !== undefined && briefing.briefed !== undefined &&
  (briefing.briefed.includes(id) || briefing.briefed.includes(`want:${id}`));

/**
 * Whether a run's briefing is the one its phase calls for. While the marker
 * is kept, the job is briefed with it: its id in `context.briefed`, and its
 * words under the heading. Before it is filed and after it is archived, it
 * is in neither. Other wants the person keeps may be briefed in any phase.
 * A request without `context.briefed` fails every phase, since the service
 * records the list even when it is empty.
 */
export const judgeBriefing = (
  phase: Phase,
  briefing: Briefing,
  marker: { id: string | undefined; words: string },
): Verdict => {
  if (briefing.briefed === undefined) {
    return { pass: false, detail: "request has no context.briefed" };
  }
  const named = briefs(briefing, marker.id);
  const listed = briefing.listed.includes(marker.words);
  const seen = `id ${named ? "briefed" : "not briefed"}, words ${
    listed ? "listed" : "not listed"
  }, ${briefing.briefed.length} briefed`;
  if (phase === "during") {
    return {
      pass: named && listed && briefing.heading,
      detail: briefing.heading ? seen : `${seen}, no heading`,
    };
  }
  return { pass: !named && !listed, detail: seen };
};

const mean = (values: number[]): number =>
  values.length === 0
    ? 0
    : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);

/** Helper for `summarize()`, which sums one phase of one marker. */
const phaseSummary = (runs: LoopRun[]): PhaseSummary => ({
  runs: runs.length,
  passes: runs.filter((run) => run.check.pass).length,
  briefed: runs.filter((run) => run.markerBriefed).length,
  briefingOk: runs.filter((run) => run.briefingVerdict.pass).length,
  meanSeconds: mean(runs.map((run) => run.seconds)),
  meanTurns: mean(runs.map((run) => run.modelTurns)),
  meanTokens: mean(runs.map((run) => run.totalTokens)),
});

const rate = (phase: PhaseSummary): number =>
  phase.runs === 0 ? 0 : phase.passes / phase.runs;

/** Each marker's runs summed by phase, in the order the markers appear. */
export const summarize = (runs: LoopRun[]): MarkerSummary[] =>
  [...new Set(runs.map((run) => run.marker))].map((marker) => {
    const ofMarker = runs.filter((run) => run.marker === marker);
    const phases = {
      before: phaseSummary(ofMarker.filter((run) => run.phase === "before")),
      during: phaseSummary(ofMarker.filter((run) => run.phase === "during")),
      after: phaseSummary(ofMarker.filter((run) => run.phase === "after")),
    };
    const complete = PHASES.every((phase) => phases[phase].runs > 0);
    return {
      marker,
      phases,
      closed: complete &&
        PHASES.every((phase) =>
          phases[phase].briefingOk === phases[phase].runs
        ) &&
        rate(phases.during) > rate(phases.before) &&
        rate(phases.during) > rate(phases.after),
    };
  });

/** The summary table: one row per marker and phase. */
export const summaryTable = (summaries: MarkerSummary[]): string =>
  [
    "| marker | phase | check passed | marker briefed | briefing as expected | wall (mean) | turns (mean) | tokens (mean) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...summaries.flatMap((summary) =>
      PHASES.map((phase) => {
        const p = summary.phases[phase];
        return `| ${summary.marker} | ${phase} | ${p.passes}/${p.runs} | ${p.briefed}/${p.runs} | ${p.briefingOk}/${p.runs} | ${p.meanSeconds} s | ${p.meanTurns} | ${p.meanTokens} |`;
      })
    ),
    "",
    ...summaries.map((summary) =>
      `- ${summary.marker}: loop ${summary.closed ? "closed" : "NOT closed"}`
    ),
  ].join("\n");

/** One row of the per-run table. */
export const runRow = (run: LoopRun): string =>
  `| ${run.marker} | ${run.phase} | ${run.probe} #${run.attempt} | ${run.job} | ${run.state} | ${
    run.briefingVerdict.pass ? "ok" : "WRONG"
  } (${run.briefingVerdict.detail}) | ${
    run.check.pass ? "pass" : "fail"
  } (${run.check.detail}) | ${run.seconds} s | ${run.modelTurns} | ${run.totalTokens} |`;

/** The per-run table's header. */
export const RUN_TABLE_HEADER = [
  "| marker | phase | probe | job | state | briefing | check | wall | turns | tokens |",
  "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
].join("\n");
