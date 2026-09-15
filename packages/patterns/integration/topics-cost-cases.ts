/**
 * The case matrix of the Topics computation cost probe, and what measuring one
 * case runs: the warm updates, the checks made after every phase against
 * values computed from the fixture data, and the record each phase writes.
 * `scripts/topics-computation-cost.ts` runs a case through them in a process
 * of its own. The "Topics computation cost probe" section of
 * `docs/development/BENCHMARKS.md` documents the matrix, the phases, and the
 * records.
 */

import { expect } from "@std/expect";

import type {
  Cell,
  IExtendedStorageTransaction,
  SchedulerGraphSnapshot,
} from "@commonfabric/runner";

import {
  type AttemptReads,
  type BodyReads,
  DEFAULT_COMMENTS_PER_TOPIC,
  DEFAULT_LINKS_PER_TOPIC,
  type FixtureComment,
  type FixtureLink,
  type FixtureTopic,
  latestStamp,
  MAX_SINGLE_BUCKET_MENTIONS_PER_SOURCE,
  mentionersOf,
  type MentionGraph,
  pivotEntriesOf,
  presentCommentCount,
  topicIndicesOf,
  TOPICS_LIFT_NAMES,
  type TopicsDemand,
  type TopicsFixture,
  type TopicsFixtureOptions,
  type TopicsLiftName,
  type TopicsMeasurement,
  type TopicsOperation,
  type TopicsReads,
} from "./topics-headless-fixture.ts";

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
export const BOARD_NOT_MEASURED =
  "A board loaded before any topic is opened reads its stored card values, " +
  "and in a browser with client execution loading it ran none of the reached " +
  "lifts, so there is no work of theirs to measure headlessly. Returning to " +
  "the board after opening a topic ran that topic's last activity once; that " +
  "state is not one of the probe's workloads.";

/**
 * The topic a `topic-open` case opens. The mention phases change which topics
 * mention it, and the comment and link phases edit it; the unrelated sibling
 * edit changes a different topic, the last one. How many other topics mention
 * it depends on the mention graph, and each sample records the count.
 */
const FOCUS_TOPIC = 0;

/** A demand workload, by name. */
export type Workload =
  | typeof PIVOT_WORKLOADS[number]
  | typeof THREAD_WORKLOADS[number];

/** One case of the matrix. */
export interface ProbeCase {
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
export function probeCases(): ProbeCase[] {
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
export function caseNamed(id: string): ProbeCase {
  const found = probeCases().find((probeCase) => probeCase.id === id);
  if (found === undefined) throw new Error(`No case is named \`${id}\`.`);
  return found;
}

/**
 * Returns what every sample of `probeCase` records about the case itself, with
 * `fixture` the data its options build.
 */
export function caseRecord(
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
// Measuring a case's phases
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
export type PhaseRecord =
  | Readonly<Record<string, unknown> & { phase: string; measured: true }>
  | {
    readonly phase: string;
    readonly measured: false;
    readonly reason: string;
  };

/** Returns the demand `workload` names, opening the focus topic. */
export function demandOf(workload: Workload): TopicsDemand {
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
 * checking every output and every undemanded lift after each, and returns the
 * fixture data as the updates left it.
 */
export async function measureWarmUpdates(
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
    const update = await measurement.update(write);
    phases.push(phaseRecord(phase, update, edit));
    model = next;
    verifyOutputs(measurement, model);
    verifyIdleLifts(measurement, update);
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
export function verifyOutputs(
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
 * Checks that no lift `measurement.demand` starts none of completed an action
 * during `operation`, so that a lift running without being demanded, whether or
 * not it holds an output, fails the case.
 *
 * @throws Error when such a lift completed an action.
 */
export function verifyIdleLifts(
  measurement: TopicsMeasurement,
  operation: { readonly reads: TopicsReads },
): void {
  const { demand, seeded } = measurement;
  const started = demandedActionsOf(demand, seeded.topics.length);
  const idle = TOPICS_LIFT_NAMES.filter((lift) => started[lift] === 0);
  expect(
    idle.map((lift) => ({
      lift,
      actions: operation.reads.bodies[lift].actions.size,
    })),
  ).toEqual(idle.map((lift) => ({ lift, actions: 0 })));
}

/**
 * Checks that reopening completed at least one action of every lift
 * `measurement.demand` starts.
 *
 * @throws Error when a demanded lift completed no action.
 */
export function verifyReopen(
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
export function phaseRecord(
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
