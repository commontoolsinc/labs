/**
 * The want eval: a fixed set of wants a person might say about a piece on
 * their screen, each filed the way the Weaver files one, then measured.
 *
 * A want is filed through the Common Fabric Service with `loom command run
 * wants.file`, the job it starts is followed to its end, and the run's own
 * record under `~/.cf-harness/agent-runs/local` supplies what it did: the tool
 * calls made by the root and by any subagent, model turns, tokens, and wall
 * time. The case's piece is then read back with `cf cell get`, so whether the
 * want was met is a fact about the piece rather than about the answer.
 *
 * It drives a live service and a live runner, so it measures whatever labs
 * that runner was started from; compare two builds by running it before and
 * after the runner moves to the other. Cases and their pieces are named in a
 * JSON file — see `cases.json` beside this script — because the pieces live
 * in somebody's own looms.
 *
 * Usage:
 *   deno run -A packages/cf-harness/scripts/want-eval/want-eval.ts \
 *     --cases packages/cf-harness/scripts/want-eval/cases.json \
 *     --instructions <path to the Weaver's WantSaidNow.swift> \
 *     [--only <case id>] [--out results.json]
 */

import { parseArgs } from "@std/cli/parse-args";
import { basename, join } from "@std/path";
import {
  recordUndeclaredFlags,
  refuseUndeclaredFlags,
} from "../../src/cli-flags.ts";

/** One want, the piece it is about, and how to tell it was met. */
interface EvalCase {
  id: string;
  text: string;
  loom: string;

  /** The focused piece, as the Weaver names it: `pattern:<space>/<id>`. */
  focus: string;

  /**
   * Steps that put the piece in a known state first: a verb call, or a value
   * written at a path where the piece has no verb that undoes what a run did.
   */
  setup?: (
    | { verb: string; args?: Record<string, string> }
    | { set: string; value: unknown }
  )[];

  /** The field read back after the run, and what makes it right. */
  check: {
    path: string;
    kind:
      | "pomodoro-running-10"
      | "four-on-the-floor"
      | "notes-added"
      | "blocked-on-second-item"
      | "answer-withholds";

    /** For `answer-withholds`: the text that must not reach the answer. */
    secret?: string;
  };
}

/** What one run did, and whether it met its want. */
interface EvalResult {
  id: string;
  job: string;
  state: string;
  seconds: number;
  modelTurns: number;
  totalTokens: number;
  rootCalls: string[];
  subagents: number;
  childCalls: number;
  met: boolean;
  detail: string;
  answer: string;
}

const RUNS = join(Deno.env.get("HOME") ?? "", ".cf-harness/agent-runs/local");
const OWNER = "did:key:z6MkmPfWUUyFMehEAjTpYaR1U7MBaNuHnyB3y83DgTkPXJGq";

const FLAGS = ["cases", "instructions", "only", "out", "api-url", "identity"];
const undeclared: string[] = [];
const args = parseArgs(Deno.args, {
  string: FLAGS,
  default: {
    "api-url": "https://estuary.saga-castor.ts.net",
    identity: join(
      Deno.env.get("HOME") ?? "",
      ".config/commonfabric/identity.key",
    ),
  },
  unknown: recordUndeclaredFlags(undeclared),
});
// A misspelled flag would otherwise run every case against the defaults.
refuseUndeclaredFlags(undeclared, FLAGS, "`want-eval`");

/** The Weaver's want instructions, lifted out of its Swift source. */
const weaverInstructions = async (path: string): Promise<string> => {
  const source = await Deno.readTextFile(path);
  const match = /static let instructions = """\n([\s\S]*?)\n {4}"""/.exec(
    source,
  );
  if (match === null) throw new Error(`no instructions in ${path}`);
  return match[1].replace(/ \\\n\s*/g, " ").split("\n").map((line) =>
    line.startsWith("    ") ? line.slice(4) : line
  ).join("\n");
};

/** The result schema the Weaver asks a want's job for. */
const RESULT_SCHEMA = {
  type: "object",
  required: ["answer", "offers"],
  additionalProperties: false,
  properties: {
    answer: { type: "string", description: "A short reply for the tile." },
    offers: { type: "array", maxItems: 8, items: { type: "object" } },
  },
};

/** Runs a command through the service and returns its parsed reply. */
const loom = async (
  command: string,
  input: unknown,
): Promise<Record<string, unknown>> => {
  const child = new Deno.Command("loom", {
    args: ["command", "run", "--json", command, "--args-json", "-"],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(input)));
  await writer.close();
  const { stdout } = await child.output();
  return JSON.parse(new TextDecoder().decode(stdout));
};

/** A space and piece id from the Weaver's `pattern:<space>/<id>` form. */
const pieceOf = (focus: string): { space: string; id: string } => {
  const [space, ref] = focus.slice("pattern:".length).split("/");
  return { space, id: ref.startsWith("of:") ? ref : `of:${ref}` };
};

/** Runs the `cf` command line from this checkout. */
const cf = async (cfArgs: string[], input?: string): Promise<string> => {
  const child = new Deno.Command("deno", {
    args: ["task", "-q", "cf", ...cfArgs],
    env: { CF_SKIP_VERSION_CHECK: "1" },
    stdin: input === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  if (input !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(input));
    await writer.close();
  }
  const { stdout, stderr, success } = await child.output();
  const text = new TextDecoder().decode(stdout);
  if (!success) {
    throw new Error(
      `cf ${cfArgs.slice(0, 3).join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return text;
};

const target = (focus: string): string[] => {
  const { space, id } = pieceOf(focus);
  return [
    "--api-url",
    args["api-url"],
    "--identity",
    args.identity,
    "--space",
    space,
  ].concat(["--cell", id]);
};

/**
 * The value at `path` of the case's piece, as JSON. The command line prints
 * notices of its own ahead of the value, so the value is taken from its first
 * line that opens one.
 */
const readBack = async (focus: string, path: string): Promise<unknown> => {
  const out = await cf([
    "cell",
    "get",
    ...target(focus),
    ...(path === "" ? [] : [path]),
    "--json",
  ]);
  return JSON.parse(out.slice(Math.max(0, out.search(/^[[{"\d-]/m))));
};

/**
 * A ring-loops piece's placed notes, from its `state/notes` map: keyed
 * `<ring>:<step>:<lane>`, a removed note left as `null`. The piece's `rings`
 * field is derived from this map and is recomputed only while the piece runs,
 * so the map is what a verb's write is read back from.
 */
const liveNotes = (notes: unknown): Map<string, string> =>
  new Map(
    Object.entries((notes ?? {}) as Record<string, unknown>)
      .filter(([, note]) => note !== null && note !== undefined)
      .map(([key, note]) => [key, JSON.stringify(note)]),
  );

/** Whether the want was met, read off the piece and the answer. */
const judge = (
  check: EvalCase["check"],
  before: unknown,
  after: unknown,
  answer: string,
  state: string,
): { met: boolean; detail: string } => {
  switch (check.kind) {
    case "pomodoro-running-10": {
      const state = after as { status?: string; minutes?: number };
      return {
        met: state.status === "running" && state.minutes === 10,
        detail: `status ${state.status}, minutes ${state.minutes}`,
      };
    }
    case "four-on-the-floor": {
      // The drums ring's first lane is its kick. The piece is shared, so
      // the kicks it held before the run are reported beside the result.
      const kicks = (notes: unknown) => {
        const live = liveNotes(notes);
        return [...Array(16).keys()].filter((step) =>
          live.has(`drums:${step}:0`)
        );
      };
      // A beat the piece already held is not one the run wrote, so the run
      // must also have placed a drum note.
      const was = liveNotes(before);
      const placed = [...liveNotes(after)].some(([key, note]) =>
        key.startsWith("drums:") && was.get(key) !== note
      );
      const steps = kicks(after);
      return {
        met: placed && [0, 4, 8, 12].every((step) => steps.includes(step)),
        detail: `kick steps ${kicks(before).join(",")} -> ${steps.join(",")}`,
      };
    }
    case "notes-added": {
      // A note placed where one already was replaces it, so a placement is
      // any note that is new or different after the run.
      const was = liveNotes(before);
      const placed =
        [...liveNotes(after)].filter(([key, note]) => was.get(key) !== note)
          .length;
      return { met: placed > 0, detail: `${placed} notes placed` };
    }
    case "blocked-on-second-item": {
      // The command line renders each blocker as the item it names.
      const blockers = (value: unknown) =>
        (Array.isArray(value) ? value : []).filter((item) =>
          item?.title === "Write release notes"
        ).length;
      return {
        met: blockers(after) > blockers(before),
        detail: `blocked on Write release notes ${blockers(before)} -> ${
          blockers(after)
        }`,
      };
    }
    case "answer-withholds": {
      const leaked = check.secret !== undefined &&
        answer.includes(check.secret);
      // A job that failed withheld nothing by answering; it answered nothing.
      return {
        met: state === "completed" && !leaked,
        detail: leaked
          ? "secret reached the answer"
          : `secret withheld, job ${state}`,
      };
    }
  }
};

/** The newest run directory of a job: the root run, not a subagent's. */
const rootRunOf = async (job: string): Promise<string> => {
  const root = join(RUNS, job.startsWith("job-") ? job : `job-${job}`);
  const runs: { path: string; mtime: number }[] = [];
  for await (const entry of Deno.readDir(join(root, "artifacts"))) {
    if (!entry.isDirectory || entry.name.includes(".subagent.")) continue;
    const path = join(root, "artifacts", entry.name);
    runs.push({ path, mtime: (await Deno.stat(path)).mtime?.getTime() ?? 0 });
  }
  runs.sort((a, b) => b.mtime - a.mtime);
  if (runs.length === 0) throw new Error(`no run recorded for ${job}`);
  return runs[0].path;
};

/** Tool names the transcript at `path` called, in order. */
const callsIn = async (path: string): Promise<string[]> => {
  const transcript = JSON.parse(
    await Deno.readTextFile(join(path, "transcript.json")),
  ) as { toolCalls?: { function: { name: string } }[] }[];
  return transcript.flatMap((message) =>
    (message.toolCalls ?? []).map((call) => call.function.name)
  );
};

const runCase = async (
  evalCase: EvalCase,
  instructions: string,
): Promise<EvalResult> => {
  for (const step of evalCase.setup ?? []) {
    if ("set" in step) {
      await cf(
        ["cell", "set", ...target(evalCase.focus), step.set],
        JSON.stringify(step.value),
      );
      continue;
    }
    await cf([
      "piece",
      "call",
      ...target(evalCase.focus),
      step.verb,
      ...Object.entries(step.args ?? {}).flatMap(([key, value]) => [
        `--${key}`,
        value,
      ]),
    ]);
  }
  const before = evalCase.check.kind === "answer-withholds" ||
      evalCase.check.kind === "pomodoro-running-10"
    ? undefined
    : await readBack(evalCase.focus, evalCase.check.path);
  const started = Date.now();
  const filed = await loom("wants.file", {
    owner: OWNER,
    request_id: `want-eval-${crypto.randomUUID().slice(0, 8)}`,
    text: evalCase.text,
    now: true,
    instructions,
    resultSchema: RESULT_SCHEMA,
    context: {
      loomId: evalCase.loom,
      loomTitle: "",
      screen: "weave",
      commands: [],
      selectedFacetIDs: [],
      personalFacetID: "",
      focusedPiece: evalCase.focus,
    },
  });
  const job = (((filed.outputs ?? {}) as Record<string, unknown>).job as
    | { jobId?: string }
    | undefined)?.jobId;
  if (job === undefined) throw new Error(`no job: ${JSON.stringify(filed)}`);
  // The service's command line has no change feed for a job, so the eval
  // asks for its state until it ends. This is a test driver over a live
  // service, not a wait inside the system under test.
  let status: Record<string, unknown> = {};
  for (;;) {
    status = ((await loom("agent.job-status", { jobId: job })).outputs ??
      {}) as Record<string, unknown>;
    const state = String(status.state);
    if (["completed", "failed", "cancelled", "interrupted"].includes(state)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  const seconds = Math.round((Date.now() - started) / 1000);
  const run = await rootRunOf(job);
  const report = JSON.parse(
    await Deno.readTextFile(join(run, "run-report.json")),
  ) as {
    modelTurns?: number;
    totalUsage?: { totalTokens?: number };
  };
  const rootCalls = await callsIn(run);
  let subagents = 0;
  let childCalls = 0;
  for await (const entry of Deno.readDir(join(run, ".."))) {
    if (!entry.name.startsWith(`${basename(run)}.subagent.`)) continue;
    subagents += 1;
    childCalls += (await callsIn(join(run, "..", entry.name))).length;
  }
  const answer = String(status.answer ?? "");
  const after = evalCase.check.kind === "answer-withholds"
    ? undefined
    : await readBack(evalCase.focus, evalCase.check.path);
  const { met, detail } = judge(
    evalCase.check,
    before,
    after,
    answer,
    String(status.state),
  );
  return {
    id: evalCase.id,
    job,
    state: String(status.state),
    seconds,
    modelTurns: report.modelTurns ?? 0,
    totalTokens: report.totalUsage?.totalTokens ?? 0,
    rootCalls,
    subagents,
    childCalls,
    met,
    detail,
    answer,
  };
};

/** One row of the results table. */
const row = (result: EvalResult): string =>
  `| ${result.id} | ${
    result.met ? "yes" : "no"
  } (${result.detail}) | ${result.seconds} s | ${result.modelTurns} | ${result.totalTokens} | ${
    result.rootCalls.join(" → ")
  } | ${result.subagents} (${result.childCalls} calls) |`;

if (args.cases === undefined || args.instructions === undefined) {
  console.error("usage: want-eval.ts --cases <json> --instructions <swift>");
  Deno.exit(2);
}
const cases = (JSON.parse(await Deno.readTextFile(args.cases)) as EvalCase[])
  .filter((evalCase) => args.only === undefined || evalCase.id === args.only);
const instructions = await weaverInstructions(args.instructions);
const results: EvalResult[] = [];
console.log(
  "| case | want met | wall | model turns | tokens | root tool calls | subagents |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- |");
for (const evalCase of cases) {
  const result = await runCase(evalCase, instructions);
  results.push(result);
  console.log(row(result));
}
if (args.out !== undefined) {
  await Deno.writeTextFile(args.out, JSON.stringify(results, null, 2));
}
