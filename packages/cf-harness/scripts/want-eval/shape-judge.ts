/**
 * The shape judge: reads a shape eval's results, pairs each case's runs under
 * two shapes (`default` and `deep` unless told otherwise), and asks a cheap
 * model which run left the person better served, scoring both on the rubric
 * in `shape-rubric.ts`. The runs are shown in a random order under neutral
 * labels, without their shapes. The model gives its verdict as a call to the
 * one tool it is offered, `submit_verdict`. Writes `<label>.json` (every
 * verdict), `<label>.replies.json` (every reply the judge made, as it came
 * back) and `<label>.md` (a line per case: median tokens and their spread
 * under each shape, the pairwise record, the mean rubric scores) to `--out`.
 *
 * It reads the runs' own records, and the model call goes out on the owner's
 * Codex credential, so it is run by hand, and `--out` names a directory
 * outside any repository: the verdicts quote the owner's data.
 *
 *   deno run -A packages/cf-harness/scripts/want-eval/shape-judge.ts \
 *     --results <shape-eval results.json>[,<more.json>] --out <directory> \
 *     [--label judged] [--first default] [--second deep] [--only <case id>] \
 *     [--harness-home ~/.cf-harness] [--owner local]
 */

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";
import type { HarnessToolCall } from "../../src/contracts/transcript.ts";
import { codexEvalToolModel } from "../task-classification-eval.ts";
import { rootRunOf, transcriptsOf } from "./runs.ts";
import {
  type JudgedPair,
  materialOf,
  pairPrompt,
  pairRuns,
  summarise,
  summaryTable,
  unblind,
  VERDICT_TOOL,
  verdictOf,
  winnerOf,
} from "./shape-rubric.ts";

const FLAGS = [
  "results",
  "out",
  "label",
  "first",
  "second",
  "only",
  "harness-home",
  "owner",
];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    label: "judged",
    first: "default",
    second: "deep",
    "harness-home": join(Deno.env.get("HOME") ?? ".", ".cf-harness"),
    owner: "local",
  },
  unknown: recordUndeclaredFlags(undeclared),
});
refuseUndeclaredFlags(undeclared, FLAGS, "`shape-judge`");
if (args.results === undefined || args.out === undefined) {
  console.error("usage: shape-judge.ts --results <json>[,<json>] --out <dir>");
  Deno.exit(2);
}

/** The part of a shape eval result the judge reads. */
interface ShapeRun {
  case: string;
  variant: string;
  job: string;
  state: string;
  totalTokens: number;
  answer: string;
}

/** The cases' asks, from the cases file beside this script. */
const suite: { cases: { id: string; text: string }[] } = JSON.parse(
  await Deno.readTextFile(new URL("./shape-cases.json", import.meta.url)),
);
const asks = new Map(suite.cases.map((c) => [c.id, c.text]));
const runs: ShapeRun[] = [];
for (const path of args.results.split(",")) {
  const read: ShapeRun[] = JSON.parse(await Deno.readTextFile(path));
  for (const run of read) {
    if (
      run.state === "completed" &&
      (args.only === undefined || run.case === args.only)
    ) runs.push(run);
  }
}
const model = codexEvalToolModel(args["harness-home"], args.owner);
await ensureDir(args.out);
const repliesFile = join(args.out, `${args.label}.replies.json`);

/** Every reply the judge made, as it came back. */
const replies: {
  case: string;
  firstJob: string;
  secondJob: string;
  firstWasA: boolean;
  content: string;
  toolCalls: readonly HarnessToolCall[];
}[] = [];
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const pairs = pairRuns(runs, args.first, args.second);
console.error(`judging ${pairs.length} pairs with ${model.name}`);

// Each pair is read twice, once in each order: a verdict that flips with the
// order is the judge's lean, not a difference between the runs.
const judged: JudgedPair[] = await Promise.all(pairs.map(async (pair) => {
  const ask = asks.get(pair.case);
  if (ask === undefined) throw new Error(`no case ${pair.case} in the cases`);
  const material = async (run: ShapeRun) =>
    materialOf(run.answer, await transcriptsOf(await rootRunOf(run.job)));
  const [first, second] = await Promise.all([
    material(pair.first),
    material(pair.second),
  ]);
  const readings = await Promise.all([true, false].map(async (firstWasA) => {
    let reply;
    try {
      reply = await model.turn(
        firstWasA
          ? pairPrompt(ask, first, second)
          : pairPrompt(ask, second, first),
        [VERDICT_TOOL],
      );
    } catch (error) {
      return { error: messageOf(error) };
    }
    replies.push({
      case: pair.case,
      firstJob: pair.first.job,
      secondJob: pair.second.job,
      firstWasA,
      content: reply.content,
      toolCalls: reply.toolCalls ?? [],
    });
    try {
      const verdict = verdictOf(reply);
      return {
        verdict: {
          ...unblind(verdict, firstWasA),
          reason: verdict.reason,
          firstWasA,
        },
      };
    } catch (error) {
      return { error: `${messageOf(error)} (reply saved in ${repliesFile})` };
    }
  }));
  const verdicts = readings.flatMap((one) =>
    one.verdict !== undefined ? [one.verdict] : []
  );
  const errors = readings.flatMap((one) =>
    one.error !== undefined ? [one.error] : []
  );
  console.error(`judged ${pair.case}${errors.length > 0 ? `: ${errors}` : ""}`);
  return {
    case: pair.case,
    firstJob: pair.first.job,
    secondJob: pair.second.job,
    verdicts,
    errors,
  };
}));

const shapeOf = (winner: string) =>
  winner === "first" ? args.first : winner === "second" ? args.second : winner;
const table = [
  `# Shape judge: ${args.label} (${args.first} vs ${args.second}, ${model.name})`,
  "",
  summaryTable(
    summarise(runs, judged, args.first, args.second),
    args.first,
    args.second,
  ),
  "",
  "Reasons name the runs A and B as the judge saw them; each says which shape A was.",
  "",
  ...judged.flatMap((pair) => [
    `- ${pair.case}: ${shapeOf(winnerOf(pair) ?? "failed")}`,
    ...pair.verdicts.map((verdict) =>
      `  - A=${verdict.firstWasA ? args.first : args.second}, ${
        shapeOf(verdict.winner)
      }: ${verdict.reason}`
    ),
    ...pair.errors.map((error) => `  - failed: ${error}`),
  ]),
].join("\n");
await Deno.writeTextFile(
  join(args.out, `${args.label}.json`),
  JSON.stringify(judged, null, 2),
);
await Deno.writeTextFile(repliesFile, JSON.stringify(replies, null, 2));
await Deno.writeTextFile(join(args.out, `${args.label}.md`), table);
console.log(table);
