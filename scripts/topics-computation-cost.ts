/**
 * Measures the Topics board's mention pivot, each topic's backlink lookup, and
 * a topic's comment and link aggregates over the headless Topics fixture,
 * across topic counts, mention graphs, thread lengths, and demand workloads.
 * The "Topics computation cost probe" section of
 * `docs/development/BENCHMARKS.md` documents the matrix, the options, and the
 * output.
 *
 * Each measured case runs in a child process of its own, so a case that
 * exhausts the heap ends that process rather than the run: this process records
 * the limit, skips the larger sizes of that case's series, and carries on. Any
 * other failure ends the run. Output is JSON lines on stdout; progress, and
 * everything a child prints, goes to stderr.
 *
 * Given `--derive-limits`, it instead runs the read-budget cases five times
 * each and writes the read-budget limits module to stdout, as the "Topics read
 * budget" section of `docs/development/BENCHMARKS.md` describes.
 */

import { parseArgs } from "@std/cli/parse-args";
import { fromFileUrl } from "@std/path";
// The heap limit a process runs under is exposed only through `node:v8`.
// deno-lint-ignore no-external-import
import { getHeapStatistics } from "node:v8";

import {
  BOARD_NOT_MEASURED,
  caseNamed,
  caseRecord,
  measureCasePhases,
  type PhaseRecord,
  type ProbeCase,
  probeCases,
} from "../packages/patterns/integration/topics-cost-cases.ts";
import {
  buildTopicsFixture,
  TOPICS_FIXTURE_EXPERIMENTAL_OPTIONS,
} from "../packages/patterns/integration/topics-headless-fixture.ts";
import {
  GATED_MEASURES,
  type GatedMeasure,
  gatedMeasuresOf,
  limitFor,
  limitsModuleSource,
  type ReadBudgetLimits,
  TOPICS_READ_BUDGET_GROUPS,
} from "../packages/patterns/integration/topics-read-budget.ts";

/** The repository root, where a child process finds the workspace config. */
const REPOSITORY_ROOT = fromFileUrl(new URL("..", import.meta.url));

//
// The run
//

/** What the command line selects for a run. */
interface RunOptions {
  /** How many rounds of every selected case to run. */
  readonly repeat: number;

  /** Whether only the small cases run. */
  readonly small: boolean;

  /** Selects the cases whose `id` it matches, when present. */
  readonly filter?: RegExp;

  /** The heap size, in megabytes, each child is started with, when present. */
  readonly maxOldSpaceSize?: number;
}

/** Matches the line V8 writes to stderr when a process exhausts its heap. */
const HEAP_EXHAUSTED = /Fatal JavaScript out of memory|heap out of memory/i;

/** What running one case in a child process came to. */
type CaseOutcome =
  /** The case completed and wrote its sample. */
  | { readonly kind: "sample"; readonly sample: Record<string, unknown> }
  /** The case's process exhausted its heap before the case completed. */
  | {
    readonly kind: "limit";

    /** The signal that ended the process, when one did. */
    readonly signal: Deno.Signal | null;

    /** The process's exit code. */
    readonly exitCode: number;

    /** The line of the process's stderr that reports the exhausted heap. */
    readonly message: string;

    /** The heap limit the child ran under, when it recorded one. */
    readonly heapSizeLimitBytes: number | null;

    /** Wall-clock milliseconds from starting the child to its end. */
    readonly elapsedMs: number;
  };

/**
 * Runs every case `options` selects, in rounds, writing the environment, each
 * sample, each limit, and a completion record as JSON lines. A `board` case
 * starts no process: its sample records that it is not measured, and why.
 *
 * @throws Error when no case is selected, or when a case fails other than by
 * exhausting its process's heap.
 */
async function runProbe(options: RunOptions): Promise<void> {
  const cases = probeCases().filter((probeCase) =>
    (!options.small || probeCase.small) &&
    (options.filter?.test(probeCase.id) ?? true)
  );
  if (cases.length === 0) throw new Error("No case matches the arguments.");
  const v8Flags = childV8Flags(options.maxOldSpaceSize);
  emit({
    kind: "environment",
    ...await gitState(),
    deno: Deno.version,
    platform: {
      os: Deno.build.os,
      arch: Deno.build.arch,
      target: Deno.build.target,
    },
    processors: navigator.hardwareConcurrency,
    experimental: TOPICS_FIXTURE_EXPERIMENTAL_OPTIONS,
    arguments: Deno.args,
    childV8Flags: v8Flags,
    repeat: options.repeat,
    cases: cases.map((probeCase) => probeCase.id),
  });

  // Per series, the smallest size whose process exhausted its heap, and every
  // size with a sample.
  const limits = new Map<string, number>();
  const sampled = new Map<string, Set<number>>();
  let samples = 0;
  for (let round = 1; round <= options.repeat; round++) {
    for (const probeCase of cases) {
      const { id, series, size } = probeCase;
      if (probeCase.workload === "board") {
        emit({
          kind: "sample",
          round,
          ...caseRecord(probeCase, buildTopicsFixture(probeCase.options)),
          measured: false,
          reason: BOARD_NOT_MEASURED,
        });
        samples++;
        continue;
      }
      if (size >= (limits.get(series) ?? Infinity)) continue;
      console.error(`round ${round}: ${id}`);
      const outcome = await runCase(probeCase, v8Flags);
      if (outcome.kind === "sample") {
        emit({ kind: "sample", round, ...outcome.sample });
        samples++;
        sampled.set(series, (sampled.get(series) ?? new Set()).add(size));
        continue;
      }
      limits.set(series, size);
      const smaller = [...sampled.get(series) ?? []].filter((built) =>
        built < size
      );
      emit({
        kind: "limit",
        round,
        case: id,
        series,
        size,
        largestBuilt: smaller.length === 0 ? null : Math.max(...smaller),
        heapSizeLimitBytes: outcome.heapSizeLimitBytes,
        elapsedMs: outcome.elapsedMs,
        signal: outcome.signal,
        exitCode: outcome.exitCode,
        message: outcome.message,
        skipped: cases
          .filter((other) => other.series === series && other.size > size)
          .map((other) => other.id),
      });
    }
  }
  emit({ kind: "complete", samples, limitedSeries: [...limits.keys()] });
}

/**
 * Returns the V8 flags a child process starts with, with its heap set to
 * `maxOldSpaceSize` megabytes when that is given.
 */
function childV8Flags(maxOldSpaceSize?: number): string[] {
  return [
    "--expose-gc",
    ...(maxOldSpaceSize === undefined
      ? []
      : [`--max-old-space-size=${maxOldSpaceSize}`]),
  ];
}

/** Writes `record` to stdout as one JSON line. */
function emit(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/**
 * Returns the checked-out revision, and whether the working tree differs from
 * it.
 *
 * @throws Error when `git` fails.
 */
async function gitState(): Promise<{ revision: string; dirty: boolean }> {
  const git = async (...args: string[]) => {
    const { success, stdout } = await new Deno.Command("git", {
      args,
      cwd: REPOSITORY_ROOT,
      stdout: "piped",
      stderr: "inherit",
    }).output();
    if (!success) throw new Error(`\`git ${args.join(" ")}\` failed.`);
    return new TextDecoder().decode(stdout).trim();
  };
  return {
    revision: await git("rev-parse", "HEAD"),
    dirty: await git("status", "--porcelain") !== "",
  };
}

/**
 * Runs `probeCase` in a child process started with `v8Flags`, forwarding
 * everything the child prints to stderr, and returns its sample, or the limit
 * its process reached by exhausting its heap.
 *
 * @throws Error when the child fails other than by exhausting its heap, or
 * exits successfully without writing its sample.
 */
async function runCase(
  probeCase: ProbeCase,
  v8Flags: readonly string[],
): Promise<CaseOutcome> {
  const sampleFile = await Deno.makeTempFile({
    prefix: "topics-computation-cost-",
    suffix: ".json",
  });
  try {
    const started = performance.now();
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        "--frozen",
        `--v8-flags=${v8Flags.join(",")}`,
        fromFileUrl(import.meta.url),
        `--case=${probeCase.id}`,
        `--sample-file=${sampleFile}`,
      ],
      cwd: REPOSITORY_ROOT,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const [status, , stderr] = await Promise.all([
      child.status,
      forwardToStderr(child.stdout),
      forwardToStderr(child.stderr),
    ]);
    const elapsedMs = performance.now() - started;
    const written = await Deno.readTextFile(sampleFile);
    if (!status.success) {
      const exhausted = stderr.split("\n").map((line) => line.trim())
        .find((line) => HEAP_EXHAUSTED.test(line));
      if (exhausted === undefined) {
        const ending = status.signal === null
          ? `exited with code ${status.code}`
          : `was ended by \`${status.signal}\``;
        throw new Error(
          `Case \`${probeCase.id}\` ${ending} without exhausting its heap.`,
        );
      }
      // The file holds the child's first record or a sample cut short, so the
      // limit is read out of its text rather than parsed as a whole.
      const heapLimit = /"heapSizeLimitBytes":(\d+)/.exec(written);
      return {
        kind: "limit",
        signal: status.signal,
        exitCode: status.code,
        message: exhausted,
        heapSizeLimitBytes: heapLimit === null ? null : Number(heapLimit[1]),
        elapsedMs,
      };
    }
    const sample: Record<string, unknown> = JSON.parse(written);
    if (sample.kind !== "sample") {
      throw new Error(`Case \`${probeCase.id}\` wrote no sample.`);
    }
    return { kind: "sample", sample };
  } finally {
    await Deno.remove(sampleFile);
  }
}

/**
 * Helper for {@link runCase}, which copies `stream` to stderr as it arrives,
 * and returns everything it carried as text.
 */
async function forwardToStderr(
  stream: ReadableStream<Uint8Array>,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) {
    for (let written = 0; written < chunk.length;) {
      written += Deno.stderr.writeSync(chunk.subarray(written));
    }
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

//
// One case, in a child process
//

/**
 * Measures `probeCase` and writes its sample to `sampleFile`: the case, the
 * heap limit the process ran under, and a record for each phase.
 *
 * @throws Error as {@link measureCasePhases} does.
 */
async function measureCase(
  probeCase: ProbeCase,
  sampleFile: string,
): Promise<void> {
  const heapSizeLimitBytes = getHeapStatistics().heap_size_limit;
  // Written before anything is measured, so that a limit record can name the
  // heap this process had even when the case never finishes. The sample
  // replaces it.
  await Deno.writeTextFile(sampleFile, JSON.stringify({ heapSizeLimitBytes }));
  const { fixture, phases } = await measureCasePhases(probeCase, {
    progress: (line) => console.error(line),
  });
  await Deno.writeTextFile(
    sampleFile,
    JSON.stringify({
      kind: "sample",
      ...caseRecord(probeCase, fixture),
      measured: true,
      heapSizeLimitBytes,
      phases,
    }),
  );
}

//
// Deriving the read-budget limits
//

/** How many rounds `--derive-limits` runs every read-budget case. */
const DERIVATION_ROUNDS = 5;

/**
 * Runs every case the read-budget groups name in {@link DERIVATION_ROUNDS}
 * rounds, each case in a process of its own started with `v8Flags`, and writes
 * the read-budget limits module to stdout. Each gated count of each measured
 * phase gets {@link limitFor} the largest value the rounds observed, or, where
 * the rounds observed different values, is written as ungated with those
 * values.
 *
 * @throws Error when a case fails or exhausts its heap, and, once the module is
 * written, when any gated count differed between rounds.
 */
async function deriveLimits(v8Flags: readonly string[]): Promise<void> {
  const ids = Object.values(TOPICS_READ_BUDGET_GROUPS).flat();
  // By case, then by phase, each gated count every round observed.
  const observed = new Map<string, Map<string, Record<GatedMeasure, number[]>>>(
    ids.map((id) => [id, new Map()]),
  );
  for (let round = 1; round <= DERIVATION_ROUNDS; round++) {
    for (const id of ids) {
      console.error(`derivation round ${round}: ${id}`);
      const outcome = await runCase(caseNamed(id), v8Flags);
      if (outcome.kind === "limit") {
        throw new Error(
          `Case \`${id}\` exhausted its heap: ${outcome.message}`,
        );
      }
      const phases = observed.get(id)!;
      for (const record of outcome.sample.phases as PhaseRecord[]) {
        if (!record.measured) continue;
        const counts = gatedMeasuresOf(record);
        for (const measure of GATED_MEASURES) {
          if (!Number.isSafeInteger(counts[measure])) {
            throw new Error(
              `Case \`${id}\` recorded no \`${measure}\` count in its ` +
                `\`${record.phase}\` phase.`,
            );
          }
        }
        const values = phases.get(record.phase) ??
          Object.fromEntries(
            GATED_MEASURES.map((measure) => [measure, [] as number[]]),
          ) as Record<GatedMeasure, number[]>;
        for (const measure of GATED_MEASURES) {
          values[measure].push(counts[measure]);
        }
        phases.set(record.phase, values);
      }
    }
  }

  const limits: Record<
    string,
    Record<string, ReadBudgetLimits[string][string]>
  > = {};
  const differing: string[] = [];
  for (const [id, phases] of observed) {
    limits[id] = {};
    for (const [phase, values] of phases) {
      limits[id][phase] = Object.fromEntries(
        GATED_MEASURES.map((measure) => {
          const counts = values[measure];
          const repeated = counts.length === DERIVATION_ROUNDS &&
            counts.every((count) => count === counts[0]);
          if (!repeated) {
            differing.push(`${id}, ${phase}, ${measure}: ${counts.join(", ")}`);
          }
          return [
            measure,
            repeated ? limitFor(Math.max(...counts)) : { ungated: counts },
          ];
        }),
      ) as ReadBudgetLimits[string][string];
    }
  }
  console.log(limitsModuleSource(limits));
  if (differing.length > 0) {
    throw new Error(
      `These gated counts differed between rounds, and are written as ` +
        `ungated:\n${differing.join("\n")}`,
    );
  }
}

//
// Entry point
//

/**
 * Helper for {@link main}, which returns `value` as a positive integer.
 *
 * @throws RangeError when `value` is not one.
 */
function positiveInteger(name: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`\`--${name}\` must be a positive integer: ${value}`);
  }
  return parsed;
}

/**
 * Runs the probe, or, given `--case`, measures that one case as a child of a
 * run, or, given `--derive-limits`, derives the read-budget limits.
 *
 * @throws Error for an argument the probe does not take.
 */
async function main(): Promise<void> {
  const booleanOptions = ["derive-limits", "small"] as const;
  const stringOptions = [
    "case",
    "filter",
    "max-old-space-size",
    "repeat",
    "sample-file",
  ] as const;
  const args = parseArgs(Deno.args, {
    boolean: booleanOptions,
    string: stringOptions,
    unknown: (arg) => {
      throw new Error(`Unknown argument: \`${arg}\``);
    },
  });
  const maxOldSpaceSize = args["max-old-space-size"] === undefined
    ? undefined
    : positiveInteger("max-old-space-size", args["max-old-space-size"]);
  if (args["derive-limits"]) {
    // Every option the probe takes, other than these two, selects or runs cases
    // some other way.
    const conflicting = [
      ...booleanOptions.filter((name) => args[name]),
      ...stringOptions.filter((name) => args[name] !== undefined),
    ].filter((name) =>
      name !== "derive-limits" && name !== "max-old-space-size"
    );
    if (conflicting.length > 0) {
      throw new Error(
        "`--derive-limits` takes no other option but " +
          "`--max-old-space-size`, and was given " +
          `${conflicting.map((name) => `\`--${name}\``).join(", ")}.`,
      );
    }
    await deriveLimits(childV8Flags(maxOldSpaceSize));
    return;
  }
  if (args.case !== undefined) {
    if (args["sample-file"] === undefined) {
      throw new Error("`--case` needs `--sample-file`.");
    }
    await measureCase(caseNamed(args.case), args["sample-file"]);
    return;
  }
  await runProbe({
    repeat: args.repeat === undefined
      ? 1
      : positiveInteger("repeat", args.repeat),
    small: args.small,
    filter: args.filter === undefined ? undefined : new RegExp(args.filter),
    maxOldSpaceSize,
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error);
    Deno.exitCode = 1;
  });
}
