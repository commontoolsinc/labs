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
 */

import { parseArgs } from "@std/cli/parse-args";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
// The heap limit a process runs under is exposed only through `node:v8`.
// deno-lint-ignore no-external-import
import { getHeapStatistics } from "node:v8";

import type {
  Cell,
  IExtendedStorageTransaction,
  SchedulerGraphSnapshot,
} from "@commonfabric/runner";

import {
  type AttemptReads,
  type BodyReads,
  buildTopicsFixture,
  DEFAULT_COMMENTS_PER_TOPIC,
  DEFAULT_LINKS_PER_TOPIC,
  type FixtureComment,
  type FixtureLink,
  type FixtureTopic,
  latestStamp,
  MAX_SINGLE_BUCKET_MENTIONS_PER_SOURCE,
  measureTopicsFixture,
  mentionersOf,
  type MentionGraph,
  pivotEntriesOf,
  presentCommentCount,
  topicIndicesOf,
  TOPICS_FIXTURE_EXPERIMENTAL_OPTIONS,
  TOPICS_LIFT_NAMES,
  type TopicsDemand,
  type TopicsFixture,
  type TopicsFixtureOptions,
  type TopicsLiftName,
  type TopicsMeasurement,
  type TopicsOperation,
  type TopicsReads,
} from "../packages/patterns/integration/topics-headless-fixture.ts";

/** The repository root, where a child process finds the workspace config. */
const REPOSITORY_ROOT = fromFileUrl(new URL("..", import.meta.url));

//
// The case matrix
//

/** Topic counts the pivot cases scale over. */
const PIVOT_TOPIC_COUNTS = [32, 128, 512];

/** Topic count of the small pivot cases. */
const SMALL_TOPIC_COUNT = 4;

/** The mention graphs whose spread the pivot cases compare. */
const SPREADS = ["low-degree", "high-degree", "single-bucket"] as const;

/**
 * Mentions per source as the pivot cases scale over topic count, or as many
 * as a spread allows at the small topic count.
 */
const SCALING_MENTIONS_PER_SOURCE = 4;

/** Topic count at which the pivot cases vary mentions per source. */
const MENTION_SWEEP_TOPIC_COUNT = 128;

/**
 * Mentions per source the mention sweep covers. Zero is the `none` graph, in
 * which no spread differs from another.
 */
const MENTION_SWEEP = [0, 1, 4, 16];

/** Comment and link counts the thread cases scale over, one at a time. */
const THREAD_LENGTHS = [10, 100, 1_000];

/** Comments and links on each topic of the small thread case. */
const SMALL_THREAD_LENGTH = 1;

/** Topics in every thread case. */
const THREAD_TOPIC_COUNT = 4;

/** The mention graph of every thread case. */
const THREAD_MENTIONS: MentionGraph = { shape: "low-degree", perSource: 1 };

/** The demand workloads each pivot case is recorded under. */
const PIVOT_WORKLOADS = ["board", "topic-open", "all-backlinks"] as const;

/** The demand workloads each thread case is measured under. */
const THREAD_WORKLOADS = ["aggregates"] as const;

/**
 * Why no `board` case is measured, which each `board` sample says in place of
 * a measurement.
 */
const BOARD_NOT_MEASURED =
  "A board with no topic open reads its stored card values, and in a browser " +
  "with client execution it ran none of the reached lifts, so there is no " +
  "work of theirs to measure headlessly.";

/**
 * The topic a `topic-open` case opens, and the one every warm update edits or
 * mentions. How many other topics mention it depends on the mention graph, and
 * each sample records the count.
 */
const FOCUS_TOPIC = 0;

/** A demand workload, by name. */
type Workload =
  | typeof PIVOT_WORKLOADS[number]
  | typeof THREAD_WORKLOADS[number];

/** One case of the matrix. */
interface ProbeCase {
  /** Names the case in output, to `--filter`, and to the child that runs it. */
  readonly id: string;

  /** The part of the matrix the case belongs to. */
  readonly family: "pivot" | "thread";

  /** Whether `--small` selects the case. */
  readonly small: boolean;

  /**
   * Names the cases that differ from this one only in `size`, as this case's
   * `id` with the scaled quantity written as `*`. A size that cannot be built
   * ends its series: no larger size in it runs.
   */
  readonly series: string;

  /** The quantity the series scales: topics, comments, or links. */
  readonly size: number;

  /** The demand the case is recorded under. */
  readonly workload: Workload;

  /** What the case's fixture is built from. */
  readonly options: TopicsFixtureOptions;
}

/** Returns every case of the matrix, each series in ascending size. */
function probeCases(): ProbeCase[] {
  const cases: ProbeCase[] = [];
  // `segments` name the case between its family and its workload, and the one
  // at `scaled` holds the count its series scales, which is `size`.
  const add = (
    family: ProbeCase["family"],
    workloads: readonly Workload[],
    small: boolean,
    segments: readonly string[],
    scaled: number,
    size: number,
    options: TopicsFixtureOptions,
  ) => {
    for (const workload of workloads) {
      const written = (value: string) =>
        [family, ...segments.with(scaled, value), workload].join("/");
      const id = written(segments[scaled]);
      if (cases.some((existing) => existing.id === id)) continue;
      cases.push({
        id,
        family,
        small,
        series: written(segments[scaled].replace(/\d+$/, "*")),
        size,
        workload,
        options,
      });
    }
  };
  const pivot = (mentions: MentionGraph, topicCount: number) => {
    const perSource = mentions.shape === "none" ? 0 : mentions.perSource;
    add(
      "pivot",
      PIVOT_WORKLOADS,
      topicCount === SMALL_TOPIC_COUNT,
      [mentions.shape, `mentions-${perSource}`, `topics-${topicCount}`],
      2,
      topicCount,
      { topicCount, mentions },
    );
  };
  const thread = (commentsPerTopic: number, linksPerTopic: number) => {
    const byLinks = linksPerTopic !== DEFAULT_LINKS_PER_TOPIC;
    add(
      "thread",
      THREAD_WORKLOADS,
      commentsPerTopic === SMALL_THREAD_LENGTH &&
        linksPerTopic === SMALL_THREAD_LENGTH,
      [`comments-${commentsPerTopic}`, `links-${linksPerTopic}`],
      byLinks ? 1 : 0,
      byLinks ? linksPerTopic : commentsPerTopic,
      {
        topicCount: THREAD_TOPIC_COUNT,
        mentions: THREAD_MENTIONS,
        commentsPerTopic,
        linksPerTopic,
      },
    );
  };

  for (const shape of SPREADS) {
    for (const topicCount of [SMALL_TOPIC_COUNT, ...PIVOT_TOPIC_COUNTS]) {
      const most = shape === "single-bucket"
        ? MAX_SINGLE_BUCKET_MENTIONS_PER_SOURCE
        : topicCount - 1;
      pivot(
        { shape, perSource: Math.min(SCALING_MENTIONS_PER_SOURCE, most) },
        topicCount,
      );
    }
  }
  for (const perSource of MENTION_SWEEP) {
    if (perSource === 0) {
      pivot({ shape: "none" }, MENTION_SWEEP_TOPIC_COUNT);
      continue;
    }
    for (const shape of SPREADS) {
      pivot({ shape, perSource }, MENTION_SWEEP_TOPIC_COUNT);
    }
  }
  thread(SMALL_THREAD_LENGTH, SMALL_THREAD_LENGTH);
  for (const length of THREAD_LENGTHS) {
    thread(length, DEFAULT_LINKS_PER_TOPIC);
  }
  for (const length of THREAD_LENGTHS) {
    thread(DEFAULT_COMMENTS_PER_TOPIC, length);
  }
  return cases;
}

/** Returns the case of the matrix named `id`. */
function caseNamed(id: string): ProbeCase {
  const found = probeCases().find((probeCase) => probeCase.id === id);
  if (found === undefined) throw new Error(`No case is named \`${id}\`.`);
  return found;
}

/**
 * Returns what every sample of `probeCase` records about the case itself, with
 * `fixture` the data its options build.
 */
function caseRecord(
  probeCase: ProbeCase,
  fixture: TopicsFixture,
): Record<string, unknown> {
  const { id, family, series, size, workload, options } = probeCase;
  return {
    case: id,
    family,
    series,
    size,
    workload,
    fixture: {
      topicCount: options.topicCount,
      mentions: options.mentions,
      commentsPerTopic: options.commentsPerTopic ?? DEFAULT_COMMENTS_PER_TOPIC,
      linksPerTopic: options.linksPerTopic ?? DEFAULT_LINKS_PER_TOPIC,
      mentionEntries: fixture.topics.reduce(
        (sum, topic) => sum + topic.mentions.length,
        0,
      ),
      focusTopic: FOCUS_TOPIC,
      focusMentioners: mentionersOf(fixture, FOCUS_TOPIC).length,
    },
    demandedActions: demandedActionsOf(
      demandOf(workload),
      options.topicCount,
    ),
  };
}

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
  const v8Flags = [
    "--expose-gc",
    ...(options.maxOldSpaceSize === undefined
      ? []
      : [`--max-old-space-size=${options.maxOldSpaceSize}`]),
  ];
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

/** The seeded shape of a topic document, as a warm update writes to it. */
interface StoredTopic {
  /** The topic's title. */
  title: string;

  /** Links to the topics this one mentions. */
  mentions: unknown[];

  /** The topic's comments. */
  comments: FixtureComment[];

  /** The topic's links. */
  links: FixtureLink[];
}

/** What a warm update's edit touched, by topic and entry index. */
type EditRecord = Readonly<Record<string, number | boolean>>;

/** What a phase recorded, or why it was not measured. */
type PhaseRecord =
  | Readonly<Record<string, unknown> & { phase: string; measured: true }>
  | {
    readonly phase: string;
    readonly measured: false;
    readonly reason: string;
  };

/**
 * Measures `probeCase` and writes its sample to `sampleFile`: the case, the
 * heap limit the process ran under, and a record for each phase.
 *
 * @throws Error for a `board` case, which is not measured, or when an output
 * differs from what the fixture data says it should be after any phase, or the
 * runtime reports an error.
 */
async function measureCase(
  probeCase: ProbeCase,
  sampleFile: string,
): Promise<void> {
  const { id, options, workload } = probeCase;
  if (workload === "board") {
    throw new Error(`Case \`${id}\` is not measured: ${BOARD_NOT_MEASURED}`);
  }
  const heapSizeLimitBytes = getHeapStatistics().heap_size_limit;
  // Written before anything is measured, so that a limit record can name the
  // heap this process had even when the case never finishes. The sample
  // replaces it.
  await Deno.writeTextFile(sampleFile, JSON.stringify({ heapSizeLimitBytes }));
  const fixture = buildTopicsFixture(options);
  console.error(`${id}: initialization`);
  await using measurement = await measureTopicsFixture(
    fixture,
    `topics-computation-cost ${id}`,
    demandOf(workload),
  );
  const phases: PhaseRecord[] = [phaseRecord("initialization", measurement)];
  verifyOutputs(measurement, fixture);
  const updated = await measureWarmUpdates(id, measurement, fixture, phases);
  console.error(`${id}: reopen`);
  const reopened = await measurement.reopen();
  phases.push(phaseRecord("reopen", reopened));
  verifyOutputs(measurement, updated);
  verifyReopen(measurement, reopened);

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

/** Returns the demand `workload` names, opening the focus topic. */
function demandOf(workload: Workload): TopicsDemand {
  switch (workload) {
    case "board":
      return { workload };
    case "topic-open":
      return { workload, topic: FOCUS_TOPIC };
    case "all-backlinks":
      return { workload };
    case "aggregates":
      return { workload };
  }
}

/**
 * Helper for {@link measureCase}, which measures each warm update in turn on
 * the one evolving fixture, appending a record for each to `phases` and
 * checking every output after each, and returns the fixture data as the
 * updates left it.
 */
async function measureWarmUpdates(
  id: string,
  measurement: TopicsMeasurement,
  fixture: TopicsFixture,
  phases: PhaseRecord[],
): Promise<TopicsFixture> {
  const { seeded } = measurement;
  let model = fixture;
  const others = model.topics.map((_, index) => index)
    .filter((index) => index !== FOCUS_TOPIC);
  const stored = (index: number, tx: IExtendedStorageTransaction) =>
    seeded.topics[index].withTx(tx) as Cell<StoredTopic>;
  const focus = () => model.topics[FOCUS_TOPIC];
  const measure = async (
    phase: string,
    edit: EditRecord,
    next: TopicsFixture,
    write: (tx: IExtendedStorageTransaction) => void,
  ) => {
    console.error(`${id}: ${phase}`);
    phases.push(phaseRecord(phase, await measurement.update(write), edit));
    model = next;
    verifyOutputs(measurement, model);
  };

  // Removal drops every entry naming the focus topic from a topic that
  // mentions it, and insertion appends one again, so each moves that topic
  // out of or into the focus topic's mentioners. Where nothing mentions the
  // focus topic, removal is not measured and insertion starts from the first
  // other topic.
  const mentioner = others.find((index) =>
    model.topics[index].mentions.includes(FOCUS_TOPIC)
  );
  const source = mentioner ?? others[0];
  if (mentioner === undefined) {
    phases.push({
      phase: "mention removal",
      measured: false,
      reason: "No topic mentions the focus topic.",
    });
  } else {
    const before = model.topics[source].mentions;
    const kept = before.filter((index) => index !== FOCUS_TOPIC);
    await measure(
      "mention removal",
      {
        source,
        target: FOCUS_TOPIC,
        removedEntries: before.length - kept.length,
      },
      withTopic(model, source, (topic) => ({ ...topic, mentions: kept })),
      (tx) =>
        stored(source, tx).key("mentions").set(
          kept.map((index) => seeded.topics[index]),
        ),
    );
  }
  await measure(
    "mention insertion",
    { source, target: FOCUS_TOPIC },
    withTopic(model, source, (topic) => ({
      ...topic,
      mentions: [...topic.mentions, FOCUS_TOPIC],
    })),
    (tx) => stored(source, tx).key("mentions").push(seeded.topics[FOCUS_TOPIC]),
  );

  // The same topic, which now names the focus topic in exactly one entry,
  // points that entry at a topic it does not yet mention, leaving the focus
  // topic's mentioners and joining that topic's. Where it already mentions
  // every other topic, it points the entry at one it mentions, and
  // `targetGainsSource` records that the target's mentioners did not change.
  const mentions = model.topics[source].mentions;
  const position = mentions.indexOf(FOCUS_TOPIC);
  const candidates = others.filter((index) => index !== source);
  const unmentioned = candidates.filter((index) => !mentions.includes(index));
  const target = unmentioned[0] ?? candidates[0];
  await measure(
    "same-count retarget",
    {
      source,
      position,
      from: FOCUS_TOPIC,
      to: target,
      targetGainsSource: unmentioned.length > 0,
    },
    withTopic(model, source, (topic) => ({
      ...topic,
      mentions: mentions.with(position, target),
    })),
    (tx) =>
      stored(source, tx).key("mentions").key(position).set(
        seeded.topics[target],
      ),
  );

  // The focus topic's thread gains a comment, and its first present comment
  // is edited and then retracted. Each stamp is later than any the topic
  // holds, as a live edit's would be.
  const sentAt = latestStamp(focus()) + 1;
  await measure(
    "comment append",
    { topic: FOCUS_TOPIC, comment: focus().comments.length },
    withTopic(model, FOCUS_TOPIC, (topic) => ({
      ...topic,
      comments: [...topic.comments, { sentAt }],
    })),
    (tx) => stored(FOCUS_TOPIC, tx).key("comments").push({ sentAt }),
  );
  const comment = focus().comments.findIndex((record) =>
    record.removedAt === undefined
  );
  for (
    const [phase, stamp] of [
      ["comment edit", "editedAt"],
      ["comment retraction", "removedAt"],
    ] as const
  ) {
    const at = latestStamp(focus()) + 1;
    await measure(
      phase,
      { topic: FOCUS_TOPIC, comment },
      withTopic(model, FOCUS_TOPIC, (topic) => ({
        ...topic,
        comments: topic.comments.with(comment, {
          ...topic.comments[comment],
          [stamp]: at,
        }),
      })),
      (tx) =>
        stored(FOCUS_TOPIC, tx).key("comments").key(comment).key(stamp).set(
          at,
        ),
    );
  }

  // The focus topic's first present link is retracted.
  const link = focus().links.findIndex((record) =>
    record.removedAt === undefined
  );
  if (link === -1) {
    phases.push({
      phase: "link removal",
      measured: false,
      reason: "The focus topic has no present link.",
    });
  } else {
    const removedAt = latestStamp(focus()) + 1;
    await measure(
      "link removal",
      { topic: FOCUS_TOPIC, link },
      withTopic(model, FOCUS_TOPIC, (topic) => ({
        ...topic,
        links: topic.links.with(link, { ...topic.links[link], removedAt }),
      })),
      (tx) =>
        stored(FOCUS_TOPIC, tx).key("links").key(link).key("removedAt").set(
          removedAt,
        ),
    );
  }

  // Another topic's title, and nothing else on it, is written. None of the
  // reached lifts reads a title, which a rename's `titleUpdatedAt` stamp would
  // change, so this is not a rename.
  const sibling = others[others.length - 1];
  const title = `${model.topics[sibling].title}, renamed`;
  await measure(
    "unrelated sibling edit",
    { topic: sibling },
    withTopic(model, sibling, (topic) => ({ ...topic, title })),
    (tx) => stored(sibling, tx).key("title").set(title),
  );
  return model;
}

/**
 * Returns `model` with the topic at `index` replaced by what `change` returns
 * for it.
 */
function withTopic(
  model: TopicsFixture,
  index: number,
  change: (topic: FixtureTopic) => FixtureTopic,
): TopicsFixture {
  return {
    ...model,
    topics: model.topics.with(index, change(model.topics[index])),
  };
}

/** What a measurement under a demand holds, by topic index. */
interface DemandedOutputs {
  /** Whether it holds the pivot. */
  readonly pivot: boolean;

  /** The topics whose backlinks it holds, in topic order. */
  readonly backlinks: readonly number[];

  /** The topics whose present comment count it holds, in topic order. */
  readonly commentCounts: readonly number[];

  /** The topics whose last activity it holds, in topic order. */
  readonly lastActivity: readonly number[];
}

/**
 * Returns what a measurement under `demand` over `topicCount` topics holds. It
 * is worked out from `demand` alone, apart from the fixture, so the outputs a
 * measurement holds are checked against it rather than against themselves.
 */
function demandedOutputsOf(
  demand: TopicsDemand,
  topicCount: number,
): DemandedOutputs {
  const every = Array.from({ length: topicCount }, (_, index) => index);
  switch (demand.workload) {
    case "board":
      return {
        pivot: false,
        backlinks: [],
        commentCounts: [],
        lastActivity: [],
      };
    case "topic-open":
      return {
        pivot: true,
        backlinks: [demand.topic],
        commentCounts: [demand.topic],
        lastActivity: [],
      };
    case "all-backlinks":
      return {
        pivot: true,
        backlinks: every,
        commentCounts: [],
        lastActivity: [],
      };
    case "aggregates":
      return {
        pivot: false,
        backlinks: [],
        commentCounts: every,
        lastActivity: every,
      };
  }
}

/**
 * Returns how many actions of each reached lift a measurement under `demand`
 * over `topicCount` topics starts.
 */
function demandedActionsOf(
  demand: TopicsDemand,
  topicCount: number,
): Record<TopicsLiftName, number> {
  const { pivot, backlinks, commentCounts, lastActivity } = demandedOutputsOf(
    demand,
    topicCount,
  );
  return {
    crossrefTable: pivot ? 1 : 0,
    backlinksOf: backlinks.length,
    presentCommentCountOf: commentCounts.length,
    lastActivityOf: lastActivity.length,
  };
}

/**
 * Checks that `measurement` holds exactly the outputs its demand names, and
 * checks each of them, the pivot when demanded included, against what `model`
 * says it should be. The pivot holds one entry per distinct topic on the
 * board, in the order of each topic's first entry.
 *
 * @throws Error when one differs, or when the runtime has reported an error.
 */
function verifyOutputs(
  measurement: TopicsMeasurement,
  model: TopicsFixture,
): void {
  const { seeded, outputs, errors, demand } = measurement;
  expect(errors).toEqual([]);
  expect({
    pivot: outputs.table !== undefined,
    backlinks: [...outputs.backlinks.keys()],
    commentCounts: [...outputs.commentCounts.keys()],
    lastActivity: [...outputs.lastActivity.keys()],
  }).toEqual(demandedOutputsOf(demand, model.topics.length));
  if (outputs.table !== undefined) {
    expect(
      pivotEntriesOf(seeded, outputs.table).map(({ topic, mentionedBy }) => ({
        topic,
        mentionedBy,
      })),
    ).toEqual([...new Set(model.board)].map((topic) => ({
      topic,
      mentionedBy: mentionersOf(model, topic),
    })));
  }
  for (const [topic, backlinks] of outputs.backlinks) {
    expect({ topic, backlinks: topicIndicesOf(seeded, backlinks) }).toEqual({
      topic,
      backlinks: mentionersOf(model, topic),
    });
  }
  for (const [topic, commentCount] of outputs.commentCounts) {
    expect({ topic, commentCount: commentCount.get() }).toEqual({
      topic,
      commentCount: presentCommentCount(model.topics[topic]),
    });
  }
  for (const [topic, lastActivity] of outputs.lastActivity) {
    expect({ topic, lastActivity: lastActivity.get() }).toEqual({
      topic,
      lastActivity: latestStamp(model.topics[topic]),
    });
  }
}

/**
 * Checks that reopening completed at least one action of every lift
 * `measurement.demand` starts.
 *
 * @throws Error when a demanded lift completed no action.
 */
function verifyReopen(
  measurement: TopicsMeasurement,
  reopened: TopicsOperation,
): void {
  const { demand, seeded } = measurement;
  const started = demandedActionsOf(demand, seeded.topics.length);
  const demanded = TOPICS_LIFT_NAMES.filter((lift) => started[lift] > 0);
  expect(
    demanded.map((lift) => ({
      lift,
      completed: reopened.reads.bodies[lift].actions.size > 0,
    })),
  ).toEqual(demanded.map((lift) => ({ lift, completed: true })));
}

/**
 * Returns the record of a measured phase: its elapsed time, its body and
 * attempt reads by role, the graph once settled, and the memory in use after a
 * collection.
 */
function phaseRecord(
  phase: string,
  measured: {
    readonly reads: TopicsReads;
    readonly graph: SchedulerGraphSnapshot;
    readonly elapsedMs: number;
  },
  edit?: EditRecord,
): PhaseRecord {
  const { reads, graph, elapsedMs } = measured;
  const { bodies, attempts } = reads;
  return {
    phase,
    measured: true,
    ...(edit === undefined ? {} : { edit }),
    elapsedMs,
    bodies: {
      producer: { crossrefTable: bodyRecord(bodies.crossrefTable) },
      consumer: { backlinksOf: bodyRecord(bodies.backlinksOf) },
      aggregate: {
        presentCommentCountOf: bodyRecord(bodies.presentCommentCountOf),
        lastActivityOf: bodyRecord(bodies.lastActivityOf),
      },
      other: bodyRecord(bodies.other),
      total: bodyTotalOf(Object.values(bodies)),
    },
    attempts: {
      producer: { crossrefTable: { ...attempts.crossrefTable } },
      consumer: { backlinksOf: { ...attempts.backlinksOf } },
      aggregate: {
        presentCommentCountOf: { ...attempts.presentCommentCountOf },
        lastActivityOf: { ...attempts.lastActivityOf },
      },
      other: { ...attempts.other },
      unattributed: { ...attempts.unattributed },
      total: attemptTotalOf(Object.values(attempts)),
    },
    graph: { nodes: graph.nodes.length, edges: graph.edges.length },
    memory: memoryRecord(),
  };
}

/** Returns `body` with its actions counted rather than listed. */
function bodyRecord(body: BodyReads): Record<string, number> {
  return { ...body, actions: body.actions.size };
}

/** Returns `bodies` summed, with the largest single run's proxy accesses. */
function bodyTotalOf(bodies: readonly BodyReads[]): Record<string, number> {
  const sum = (count: (body: BodyReads) => number) =>
    bodies.reduce((total, body) => total + count(body), 0);
  return {
    runs: sum((body) => body.runs),
    actions: sum((body) => body.actions.size),
    proxyAccesses: sum((body) => body.proxyAccesses),
    linkResolutions: sum((body) => body.linkResolutions),
    distinctDocuments: sum((body) => body.distinctDocuments),
    registeredDependencies: sum((body) => body.registeredDependencies),
    maxRunProxyAccesses: Math.max(
      0,
      ...bodies.map((body) => body.maxRunProxyAccesses),
    ),
  };
}

/** Returns `buckets` summed. */
function attemptTotalOf(buckets: readonly AttemptReads[]): AttemptReads {
  return buckets.reduce((total, bucket) => ({
    attempts: total.attempts + bucket.attempts,
    proxyAccesses: total.proxyAccesses + bucket.proxyAccesses,
    linkResolutions: total.linkResolutions + bucket.linkResolutions,
  }), { attempts: 0, proxyAccesses: 0, linkResolutions: 0 });
}

/**
 * Returns the process's memory use, after a full collection when the process
 * was started with `--expose-gc`, which says whether it was.
 */
function memoryRecord(): Record<string, number | boolean> {
  const collect: unknown = Reflect.get(globalThis, "gc");
  if (typeof collect === "function") collect();
  const { rss, heapTotal, heapUsed, external } = Deno.memoryUsage();
  return {
    collected: typeof collect === "function",
    heapUsedBytes: heapUsed,
    heapTotalBytes: heapTotal,
    rssBytes: rss,
    externalBytes: external,
  };
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
 * run.
 *
 * @throws Error for an argument the probe does not take.
 */
async function main(): Promise<void> {
  const args = parseArgs(Deno.args, {
    boolean: ["small"],
    string: ["case", "filter", "max-old-space-size", "repeat", "sample-file"],
    unknown: (arg) => {
      throw new Error(`Unknown argument: \`${arg}\``);
    },
  });
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
    maxOldSpaceSize: args["max-old-space-size"] === undefined
      ? undefined
      : positiveInteger("max-old-space-size", args["max-old-space-size"]),
  });
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error);
    Deno.exitCode = 1;
  });
}
