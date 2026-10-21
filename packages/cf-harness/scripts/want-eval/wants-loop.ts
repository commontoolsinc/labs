/**
 * The wants loop: whether a want kept for later reaches the answers to asks
 * said afterwards, and stops reaching them once it is archived, end to end
 * through the Common Fabric Service.
 *
 * Each marker want in the cases file is a want whose effect on an answer is
 * checkable without a model (see `wants-loop-judge.ts`). For each one the
 * loop runs every probe ask as a want said now, the way the Weaver files
 * one, three times over: before the marker is filed, while it is kept, and
 * after it is archived. Each run's job is read back from the runner: its
 * request says whether the service briefed the job with the marker
 * (`context.briefed`, and the marker's words under the briefing heading in
 * its instructions), and its answer is scored by the marker's check. The
 * marker is archived in a `finally`, so a run that stops partway leaves no
 * marker kept; no other want is touched.
 *
 * It drives a live service and runner and files real wants, so it measures
 * whatever that service and runner were started from. The answers can carry
 * the owner's data, so `--out` names a directory outside any repository.
 *
 * Usage:
 *   deno run -A packages/cf-harness/scripts/want-eval/wants-loop.ts \
 *     --cases packages/cf-harness/scripts/want-eval/wants-loop-cases.json \
 *     --instructions <path to the Weaver's WantSaidNow.swift> \
 *     --out <directory> [--only <marker id>] [--repeat N] [--owner <did>] \
 *     [--instance-dir <loom instance directory>] \
 *     [--runs-root <the runner's agent-runs/local>]
 *
 * It exits 1 when any marker's loop did not close.
 */

import { isObjectNotArray } from "@commonfabric/utils/types";
import { parseArgs } from "@std/cli/parse-args";
import { ensureDir } from "@std/fs";
import { dirname, join, resolve } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";
import { instructionsFromSwift, RESULT_SCHEMA } from "./judge.ts";
import { DEFAULT_OWNER, loomCommand } from "./loom-command.ts";
import {
  runnerJobEnded,
  runnerJobOf,
  runnerSocketOf,
} from "./runner-socket.ts";
import { defaultRunsRoot, recordOf, rootRunOf } from "./runs.ts";
import {
  briefingOf,
  briefs,
  checkMarker,
  judgeBriefing,
  type LoopRun,
  type Marker,
  parseCases,
  type Phase,
  type Probe,
  RUN_TABLE_HEADER,
  runRow,
  summarize,
  summaryTable,
} from "./wants-loop-judge.ts";

const FLAGS = [
  "cases",
  "instructions",
  "out",
  "only",
  "repeat",
  "owner",
  "instance-dir",
  "runs-root",
];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    repeat: "1",
    owner: DEFAULT_OWNER,
    "instance-dir": join(
      Deno.env.get("HOME") ?? "",
      ".local/share/loom/instances/loom",
    ),
    "runs-root": defaultRunsRoot(),
  },
  unknown: recordUndeclaredFlags(undeclared),
});
// A misspelled flag would otherwise run every marker against the defaults.
refuseUndeclaredFlags(undeclared, FLAGS, "`wants-loop`");

const refuse = (message: string): never => {
  console.error(message);
  Deno.exit(2);
};

const USAGE =
  "usage: wants-loop.ts --cases <json> --instructions <swift> --out <dir>";
const casesPath = args.cases ?? refuse(USAGE);
const swiftPath = args.instructions ?? refuse(USAGE);
const outDir = resolve(args.out ?? refuse(USAGE));
const repeat = Number(args.repeat);
if (!Number.isInteger(repeat) || repeat < 1) {
  refuse(`--repeat takes a positive whole number, not ${args.repeat}`);
}
const owner = args.owner;
const SOCKET = runnerSocketOf(args["instance-dir"]);

/**
 * Whether `path`, or the nearest directory above it that exists, is inside a
 * git work tree. The answers written there can carry the owner's data.
 */
const insideRepository = async (path: string): Promise<boolean> => {
  let at = path;
  for (;;) {
    try {
      if ((await Deno.stat(at)).isDirectory) break;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    at = dirname(at);
  }
  const { stdout } = await new Deno.Command("git", {
    args: ["-C", at, "rev-parse", "--is-inside-work-tree"],
    stdout: "piped",
    stderr: "null",
  }).output();
  return new TextDecoder().decode(stdout).trim() === "true";
};
if (await insideRepository(outDir)) {
  refuse(
    `--out ${outDir} is inside a git repository; answers can carry the ` +
      "owner's data, so name a directory outside any repository",
  );
}

const cases = parseCases(JSON.parse(await Deno.readTextFile(casesPath)));
const markers = cases.markers.filter((marker) =>
  args.only === undefined || marker.id === args.only
);
if (markers.length === 0) refuse(`no marker ${args.only} in ${casesPath}`);
const instructions = instructionsFromSwift(
  await Deno.readTextFile(swiftPath),
) ?? refuse(`no instructions in ${swiftPath}`);

/** A command's outputs, or a throw saying why the service refused it. */
const outputsOf = async (
  command: string,
  input: Record<string, unknown>,
): Promise<Readonly<Record<string, unknown>>> => {
  const reply = await loomCommand(command, input);
  if (reply.ok !== true || !isObjectNotArray(reply.outputs)) {
    throw new Error(
      `${command} refused: ${reply.code ?? "no code"}: ${
        reply.reason ?? reply.error ?? JSON.stringify(reply)
      }`,
    );
  }
  return reply.outputs;
};

const requestId = (kind: string): string =>
  `wants-loop-${kind}-${crypto.randomUUID().slice(0, 8)}`;

/**
 * The context a want said now carries: the Weaver's, on no loom and with no
 * piece in focus, so a probe's answer rests on nothing of the person's.
 */
const CONTEXT = {
  screen: "weave",
  commands: [],
  selectedFacetIDs: [],
  personalFacetID: "",
};

/** The model turns and tokens the job's run record reports. */
const measured = async (
  job: string,
): Promise<{ modelTurns: number; totalTokens: number; note?: string }> => {
  try {
    const report = await recordOf(
      await rootRunOf(job, args["runs-root"]),
      "run-report.json",
    );
    const usage = isObjectNotArray(report.totalUsage) ? report.totalUsage : {};
    return {
      modelTurns: typeof report.modelTurns === "number" ? report.modelTurns : 0,
      totalTokens: typeof usage.totalTokens === "number"
        ? usage.totalTokens
        : 0,
    };
  } catch (error) {
    // A job that failed before its run directory existed still has a state,
    // an answer and a briefing worth a row.
    return {
      modelTurns: 0,
      totalTokens: 0,
      note: `unmeasured: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
};

/** One probe said now, its job followed to its end and read back. */
const runProbe = async (
  marker: Marker,
  markerWant: string | undefined,
  phase: Phase,
  probe: Probe,
  attempt: number,
): Promise<LoopRun> => {
  const started = Date.now();
  const filed = await outputsOf("wants.file", {
    owner,
    request_id: requestId("probe"),
    text: probe.text,
    now: true,
    instructions,
    resultSchema: RESULT_SCHEMA,
    context: CONTEXT,
  });
  const job = isObjectNotArray(filed.job) && typeof filed.job.jobId === "string"
    ? filed.job.jobId
    : undefined;
  if (job === undefined) {
    throw new Error(
      `wants.file started no job: ${
        JSON.stringify(filed.jobRefusal ?? "no refusal given")
      }`,
    );
  }
  // The job id the service answers with is the runner's own, so the job's
  // end is read off the runner's event stream for it.
  await runnerJobEnded(SOCKET, job);
  const seconds = Math.round((Date.now() - started) / 1000);
  const snapshot = await runnerJobOf(SOCKET, job);
  const result = isObjectNotArray(snapshot.result) ? snapshot.result : {};
  const answer = typeof result.answer === "string" ? result.answer : "";
  const briefing = briefingOf(snapshot.request);
  const { modelTurns, totalTokens, note } = await measured(job);
  return {
    marker: marker.id,
    phase,
    probe: probe.id,
    attempt,
    job,
    state: String(snapshot.state) + (note === undefined ? "" : ` (${note})`),
    seconds,
    modelTurns,
    totalTokens,
    answer,
    briefing,
    markerBriefed: briefs(briefing, markerWant),
    briefingVerdict: judgeBriefing(phase, briefing, {
      id: markerWant,
      words: marker.words,
    }),
    check: checkMarker(marker.check, answer),
  };
};

/** Every probe, `repeat` times, one at a time, each run added to `runs`. */
const runPhase = async (
  marker: Marker,
  markerWant: string | undefined,
  phase: Phase,
  runs: LoopRun[],
): Promise<void> => {
  // One at a time: a probe's own want is a current want until its job is
  // marked started, so probes filed together could brief one another.
  for (let attempt = 1; attempt <= repeat; attempt++) {
    for (const probe of cases.probes) {
      const run = await runProbe(marker, markerWant, phase, probe, attempt);
      console.log(runRow(run));
      runs.push(run);
    }
  }
};

/** Keeps the marker for later, as `/later` would, and returns its want id. */
const fileMarker = async (marker: Marker): Promise<string> => {
  const filed = await outputsOf("wants.file", {
    owner,
    request_id: requestId("marker"),
    text: marker.words,
    now: false,
  });
  if (!isObjectNotArray(filed.want) || typeof filed.want.id !== "string") {
    throw new Error(`wants.file kept no want: ${JSON.stringify(filed)}`);
  }
  return filed.want.id;
};

/**
 * Archives the marker's want at its current revision. A want that is no
 * longer live is left as it is and said so.
 */
const archiveMarker = async (id: string): Promise<void> => {
  const listed = await outputsOf("wants.list", { owner });
  const want = (Array.isArray(listed.wants) ? listed.wants : []).find((row) =>
    isObjectNotArray(row) && row.id === id
  );
  if (!isObjectNotArray(want)) {
    throw new Error(`marker want ${id} is not in the wants list`);
  }
  if (want.status !== undefined && want.status !== "live") {
    console.error(`marker want ${id} is ${want.status}; left as it is`);
    return;
  }
  if (typeof want.revision !== "string") {
    throw new Error(`marker want ${id} has no revision`);
  }
  await outputsOf("wants.archive", {
    owner,
    request_id: requestId("archive"),
    id,
    revision: want.revision,
  });
};

/** The marker want kept while its phases run, archived on any way out. */
let kept: string | undefined;

/** Archives the kept marker, once, whichever way out reaches it first. */
const archiveKept = async (): Promise<void> => {
  const id = kept;
  kept = undefined;
  if (id !== undefined) await archiveMarker(id);
};

// An interrupted run ends without unwinding to a `finally`, so the kept
// marker is archived here before it exits.
Deno.addSignalListener("SIGINT", () => {
  archiveKept().finally(() => Deno.exit(130));
});

const runs: LoopRun[] = [];
console.log(RUN_TABLE_HEADER);
for (const marker of markers) {
  await runPhase(marker, undefined, "before", runs);
  try {
    kept = await fileMarker(marker);
    const want = kept;
    await runPhase(marker, want, "during", runs);
    await archiveKept();
    await runPhase(marker, want, "after", runs);
  } finally {
    await archiveKept();
  }
}

const summaries = summarize(runs);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = [
  `# Wants loop: ${stamp}`,
  "",
  summaryTable(summaries),
  "",
  "## Runs",
  "",
  RUN_TABLE_HEADER,
  ...runs.map(runRow),
  "",
  "## Answers",
  "",
  ...runs.flatMap((run) => [
    `**${run.marker} ${run.phase} ${run.probe} #${run.attempt}:** ${
      run.answer || "(no answer)"
    }`,
    "",
  ]),
].join("\n");
await ensureDir(outDir);
await Deno.writeTextFile(
  join(outDir, `wants-loop-${stamp}.json`),
  JSON.stringify({ summaries, runs }, null, 2),
);
await Deno.writeTextFile(join(outDir, `wants-loop-${stamp}.md`), report);
console.log("");
console.log(summaryTable(summaries));
console.log(`\nWritten to ${outDir}/wants-loop-${stamp}.{json,md}`);
Deno.exit(summaries.some((summary) => !summary.closed) ? 1 : 0);
