/**
 * The shape judge: reads a shape eval's results, pairs each case's runs under
 * two shapes (`default` and `deep` unless told otherwise), and asks a cheap
 * model which run left the person better served, scoring both on the rubric
 * in `shape-rubric.ts`. Each pair is shown in both orders under neutral
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
 *     [--harness-home ~/.cf-harness] [--owner local] \
 *     [--runs-root <the runner's agent-runs/local, as given to shape-eval>]
 */

import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";
import { codexEvalToolModel } from "../codex-eval-model.ts";
import {
  defaultHarnessHome,
  defaultRunsRoot,
  rootRunOf,
  transcriptsOf,
} from "./runs.ts";
import {
  type JudgedPair,
  judgePair,
  type JudgeReply,
  materialOf,
  pairRuns,
  selectRuns,
  summarise,
  summaryTable,
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
  "runs-root",
];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    label: "judged",
    first: "default",
    second: "deep",
    "harness-home": defaultHarnessHome(),
    owner: "local",
    "runs-root": defaultRunsRoot(),
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

  /** False for a run whose record the eval could not read; older files omit it. */
  measured?: boolean;
  totalTokens: number;
  answer: string;
}

/** The cases' asks, from the cases file beside this script. */
const suite: { cases: { id: string; text: string }[] } = JSON.parse(
  await Deno.readTextFile(new URL("./shape-cases.json", import.meta.url)),
);
const asks = new Map(suite.cases.map((c) => [c.id, c.text]));
const read: ShapeRun[] = [];
for (const path of args.results.split(",")) {
  const runsOfFile: ShapeRun[] = JSON.parse(await Deno.readTextFile(path));
  for (const run of runsOfFile) read.push(run);
}
let runs: ShapeRun[];
try {
  runs = selectRuns(read, args);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(2);
}
const model = codexEvalToolModel(
  args["harness-home"],
  args.owner,
  "shape-judge",
);
await ensureDir(args.out);
const repliesFile = join(args.out, `${args.label}.replies.json`);

/** Every reply the judge made, as it came back. */
const replies: JudgeReply[] = [];
const pairs = pairRuns(runs, args.first, args.second);
console.error(`judging ${pairs.length} pairs with ${model.name}`);

let judged: JudgedPair[];
try {
  judged = await Promise.all(pairs.map(async (pair) => {
    const one = await judgePair(pair, asks.get(pair.case), {
      material: async (run) =>
        materialOf(
          run.answer,
          await transcriptsOf(await rootRunOf(run.job, args["runs-root"])),
        ),
      turn: model.turn,
      onReply: (reply) => replies.push(reply),
      repliesFile,
    });
    console.error(
      `judged ${pair.case}${one.errors.length > 0 ? `: ${one.errors}` : ""}`,
    );
    return one;
  }));
} finally {
  // Written whatever became of the judging: a reply is the evidence a failed
  // reading is diagnosed from.
  await Deno.writeTextFile(repliesFile, JSON.stringify(replies, null, 2));
}

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
await Deno.writeTextFile(join(args.out, `${args.label}.md`), table);
console.log(table);
