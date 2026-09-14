/**
 * Synthetic Topics data, and reach into the unmodified Topics sources, for
 * measuring the board's mention pivot and a topic's backlink, comment-count,
 * and activity lifts in one process with no browser and no server.
 *
 * A fixture is written straight to storage as one linked document per topic
 * and the board's list of links to them. Nothing goes through the board's
 * `addTopic`, so a fixture's size and mention graph are chosen by its options
 * rather than by what seeding a board can afford. The lifts are reached by
 * authored name through the runtime's artifact index, and each lift's runs are
 * attributed to it by the authored source the scheduler reports for them.
 *
 * Every value is derived from the options, so fixtures built from equal
 * options hold equal data, and counts taken in separate runtimes compare.
 */

import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";
import {
  type ActionReadStats,
  type Cell,
  isModule,
  type MemorySpace,
  type Module,
  Runtime,
  type RuntimeProgram,
  RuntimeTelemetryEvent,
  type SchedulerGraphSnapshot,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";

//
// Fixture data
//

/** Comments on each topic unless the options say otherwise. */
export const DEFAULT_COMMENTS_PER_TOPIC = 3;

/** Links on each topic unless the options say otherwise. */
export const DEFAULT_LINKS_PER_TOPIC = 3;

/**
 * The most comments or links one topic may carry. Each topic's timestamps sit
 * in a band of their own, and this bound keeps a topic's records inside it.
 */
export const MAX_RECORDS_PER_TOPIC = 10_000;

/** Width of the timestamp band each topic's records occupy. */
const TOPIC_STAMP_BAND = 1_000_000;

/** Gap between successive sends, and successive additions, in one topic. */
const RECORD_STAMP_STEP = 10;

/**
 * How a fixture's topics mention one another. Degree is counted inbound: the
 * shapes differ in how the mentions are spread over their destinations.
 */
export type MentionGraph =
  /** No topic mentions anything. */
  | { readonly shape: "none" }
  /**
   * Each topic mentions the `perSource` topics after it, wrapping at the end of
   * the list, so every topic is mentioned by `perSource` others.
   */
  | { readonly shape: "low-degree"; readonly perSource: number }
  /**
   * Each topic mentions the first `perSource` topics other than itself, so
   * each of those is mentioned by every other topic.
   */
  | { readonly shape: "high-degree"; readonly perSource: number }
  /**
   * Every topic but the first mentions the first topic, `perSource` times
   * over, so one destination holds every inbound mention and a `perSource`
   * above one repeats it within each source.
   */
  | { readonly shape: "single-bucket"; readonly perSource: number };

/** What a fixture is built from. */
export interface TopicsFixtureOptions {
  /** How many distinct topics the fixture holds. */
  readonly topicCount: number;

  /** How the topics mention one another. */
  readonly mentions: MentionGraph;

  /** Comments on every topic; {@link DEFAULT_COMMENTS_PER_TOPIC} if absent. */
  readonly commentsPerTopic?: number;

  /** Links on every topic; {@link DEFAULT_LINKS_PER_TOPIC} if absent. */
  readonly linksPerTopic?: number;

  /** A topic that also mentions itself, after the mentions its shape gives. */
  readonly selfMention?: number;

  /** A topic whose first mention appears a second time at the end of its list. */
  readonly repeatedMention?: number;

  /** A topic listed on the board a second time, after every other entry. */
  readonly duplicateBoardEntry?: number;
}

/** A comment's timestamps, which are what the reached lifts read of it. */
export interface FixtureComment {
  /** When the comment was sent. */
  readonly sentAt: number;

  /** When the comment was edited, absent on one never edited. */
  readonly editedAt?: number;

  /** When the comment was retracted, absent on one still present. */
  readonly removedAt?: number;
}

/** A link's timestamps, which are what the reached lifts read of it. */
export interface FixtureLink {
  /** When the link was added, absent on a link stored without the stamp. */
  readonly addedAt?: number;

  /** When the link was retracted, absent on one still present. */
  readonly removedAt?: number;
}

/** One topic of a fixture, with its mentions named by topic index. */
export interface FixtureTopic {
  /** The topic's title. */
  readonly title: string;

  /** Indices of the topics this one mentions, in order, repeats included. */
  readonly mentions: readonly number[];

  /** The topic's comments, in the order they were sent. */
  readonly comments: readonly FixtureComment[];

  /** The topic's links, in the order they were added. */
  readonly links: readonly FixtureLink[];

  /** When the topic was created. */
  readonly createdAt: number;

  /** When the topic's body was last saved. */
  readonly bodyUpdatedAt: number;

  /** When the topic was last renamed. */
  readonly titleUpdatedAt: number;
}

/** Synthetic Topics data, before anything is written to storage. */
export interface TopicsFixture {
  /** The distinct topics, by topic index. */
  readonly topics: readonly FixtureTopic[];

  /** The topic index at each board entry, in board order. */
  readonly board: readonly number[];
}

/**
 * Builds the fixture `options` describe.
 *
 * Each topic's comments and links carry edits, retractions, and a link stored
 * without an added stamp in a fixed rotation. Each topic's latest stamp is,
 * by topic index in turn, a comment retraction, a comment edit, and a link
 * retraction, for a topic with a comment, or for the last of the three a link,
 * to carry it.
 *
 * @throws RangeError when a count is out of range, or an option names a topic
 * index outside the fixture, or `repeatedMention` names a topic with nothing
 * to repeat.
 */
export function buildTopicsFixture(
  options: TopicsFixtureOptions,
): TopicsFixture {
  const { topicCount, mentions: graph } = options;
  const commentsPerTopic = options.commentsPerTopic ??
    DEFAULT_COMMENTS_PER_TOPIC;
  const linksPerTopic = options.linksPerTopic ?? DEFAULT_LINKS_PER_TOPIC;
  requireCount("topicCount", topicCount, 1, Number.MAX_SAFE_INTEGER);
  requireCount("commentsPerTopic", commentsPerTopic, 0, MAX_RECORDS_PER_TOPIC);
  requireCount("linksPerTopic", linksPerTopic, 0, MAX_RECORDS_PER_TOPIC);
  if (graph.shape === "low-degree" || graph.shape === "high-degree") {
    requireCount("mentions.perSource", graph.perSource, 1, topicCount - 1);
  } else if (graph.shape === "single-bucket") {
    requireCount(
      "mentions.perSource",
      graph.perSource,
      1,
      MAX_RECORDS_PER_TOPIC,
    );
  }
  for (
    const name of [
      "selfMention",
      "repeatedMention",
      "duplicateBoardEntry",
    ] as const
  ) {
    const index = options[name];
    if (index !== undefined) requireCount(name, index, 0, topicCount - 1);
  }

  const topics = Array.from({ length: topicCount }, (_, index) => {
    const mentions = shapedMentions(graph, index, topicCount);
    if (options.selfMention === index) mentions.push(index);
    if (options.repeatedMention === index) {
      if (mentions.length === 0) {
        throw new RangeError(
          `\`repeatedMention\` names topic ${index}, which mentions nothing.`,
        );
      }
      mentions.push(mentions[0]);
    }
    return fixtureTopic(index, mentions, commentsPerTopic, linksPerTopic);
  });
  const board = topics.map((_, index) => index);
  if (options.duplicateBoardEntry !== undefined) {
    board.push(options.duplicateBoardEntry);
  }
  return { topics, board };
}

/**
 * Helper for {@link buildTopicsFixture}, which throws unless `value` is a safe
 * integer from `min` to `max` inclusive.
 */
function requireCount(name: string, value: number, min: number, max: number) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(
      `\`${name}\` must be an integer from ${min} to ${max}: ${value}`,
    );
  }
}

/**
 * Helper for {@link buildTopicsFixture}, which returns the mentions `graph`
 * gives the topic at `index`.
 */
function shapedMentions(
  graph: MentionGraph,
  index: number,
  topicCount: number,
): number[] {
  switch (graph.shape) {
    case "none":
      return [];
    case "low-degree":
      return Array.from(
        { length: graph.perSource },
        (_, k) => (index + 1 + k) % topicCount,
      );
    case "high-degree":
      return Array.from(
        { length: graph.perSource },
        (_, k) => k < index ? k : k + 1,
      );
    case "single-bucket":
      return index === 0 ? [] : Array(graph.perSource).fill(0);
  }
}

/**
 * Helper for {@link buildTopicsFixture}, which returns the topic at `index`
 * with its stamped comments and links.
 */
function fixtureTopic(
  index: number,
  mentions: number[],
  commentCount: number,
  linkCount: number,
): FixtureTopic {
  const createdAt = TOPIC_STAMP_BAND * (index + 1);
  const stampAt = (position: number) =>
    createdAt + RECORD_STAMP_STEP * (position + 1);
  // Later than every other stamp this topic's records carry, which is what
  // makes the record given it the topic's latest activity.
  const latest = stampAt(Math.max(commentCount, linkCount));

  const comments = Array.from({ length: commentCount }, (_, c) => {
    const sentAt = stampAt(c);
    const last = c === commentCount - 1;
    const editedAt = last && index % 3 === 1
      ? latest
      : c % 3 === 1
      ? sentAt + 1
      : undefined;
    const removedAt = last && index % 3 === 0
      ? latest
      : c % 3 === 2
      ? sentAt + 2
      : undefined;
    return {
      sentAt,
      ...(editedAt === undefined ? {} : { editedAt }),
      ...(removedAt === undefined ? {} : { removedAt }),
    };
  });
  const links = Array.from({ length: linkCount }, (_, l) => {
    const last = l === linkCount - 1;
    const addedAt = l % 3 === 2 ? undefined : stampAt(l) + 5;
    const removedAt = last && index % 3 === 2
      ? latest
      : l % 3 === 1
      ? stampAt(l) + 7
      : undefined;
    return {
      ...(addedAt === undefined ? {} : { addedAt }),
      ...(removedAt === undefined ? {} : { removedAt }),
    };
  });
  return {
    title: `Topic ${index}`,
    mentions,
    comments,
    links,
    createdAt,
    bodyUpdatedAt: createdAt + 3,
    titleUpdatedAt: createdAt + 4,
  };
}

//
// Reach into the Topics sources
//

/** The Topics lifts reached by authored name. */
export const TOPICS_LIFT_NAMES = [
  "crossrefTable",
  "backlinksOf",
  "presentCommentCountOf",
  "lastActivityOf",
] as const;

/** The authored name of one reached Topics lift. */
export type TopicsLiftName = typeof TOPICS_LIFT_NAMES[number];

/** Which module of a Topics program defines each lift. */
const LIFT_MODULES: Readonly<Record<TopicsLiftName, "board" | "topic">> = {
  crossrefTable: "board",
  backlinksOf: "topic",
  presentCommentCountOf: "topic",
  lastActivityOf: "topic",
};

/** The patterns package, which the Topics sources resolve their imports within. */
const PATTERNS_ROOT = fromFileUrl(new URL("..", import.meta.url));

/** The board's entry module in this checkout. */
const BOARD_MAIN = fromFileUrl(new URL("../topics/main.tsx", import.meta.url));

/** The board's exported join, as the oracle calls it. */
export type MentionedBy = <T extends object>(
  topic: T,
  list: readonly T[],
  mentions: readonly (readonly (object | undefined)[] | undefined)[],
) => T[];

/** The Topics derivations a measurement runs, reached from a compiled program. */
export interface TopicsDerivations {
  /** The lifts, by authored name. */
  readonly lifts: Readonly<Record<TopicsLiftName, Module>>;

  /**
   * The authored source the scheduler reports for each lift's runs, as
   * `cf:module/<identity>/<path>:<line>:<col>`.
   */
  readonly sources: Readonly<Record<TopicsLiftName, string>>;

  /** The board's exported join, which its pivot applies to each topic. */
  readonly mentionedBy: MentionedBy;
}

/** Resolves the unmodified Topics board program from this checkout. */
export function resolveTopicsProgram(
  runtime: Runtime,
): Promise<RuntimeProgram> {
  return resolveLocalProgram(
    (resolver) => runtime.harness.resolve(resolver),
    { main: BOARD_MAIN, root: PATTERNS_ROOT },
  );
}

/**
 * Compiles `program`, a Topics board whose entry module imports its topic
 * from a sibling `topic.tsx`, and returns its lifts by authored name from the
 * runtime's artifact index, and `mentionedBy` from the board's exports.
 *
 * @throws Error naming the module `program` does not evaluate, or naming
 * every reached symbol the program does not define as a lift or, for
 * `mentionedBy`, as an exported function.
 */
export async function reachTopicsDerivations(
  runtime: Runtime,
  program: RuntimeProgram,
): Promise<TopicsDerivations> {
  const { patternManager } = runtime;
  const evaluated = await patternManager.compileAndRegisterModules(program);
  const identityOf = (path: string) => {
    for (const [identity, source] of evaluated.sourcePathByIdentity ?? []) {
      if (source === path) return identity;
    }
    throw new Error(`The Topics program evaluated no module \`${path}\`.`);
  };
  const boardPath = program.main;
  const identities = {
    board: identityOf(boardPath),
    topic: identityOf(
      `${boardPath.slice(0, boardPath.lastIndexOf("/") + 1)}topic.tsx`,
    ),
  };

  const missing: string[] = [];
  const lifts: Partial<Record<TopicsLiftName, Module>> = {};
  const sources: Partial<Record<TopicsLiftName, string>> = {};
  for (const name of TOPICS_LIFT_NAMES) {
    const artifact = patternManager.artifactFromIdentitySync(
      identities[LIFT_MODULES[name]],
      name,
    );
    const source = isModule(artifact) ? authoredSourceOf(artifact) : undefined;
    if (!isModule(artifact) || source === undefined) {
      missing.push(name);
      continue;
    }
    lifts[name] = artifact;
    sources[name] = source;
  }
  const mentionedBy: unknown = evaluated.main?.mentionedBy;
  if (typeof mentionedBy !== "function") missing.push("mentionedBy");
  if (missing.length > 0) {
    throw new Error(
      `The Topics program \`${boardPath}\` does not define ${
        missing.map((name) => `\`${name}\``).join(", ")
      }.`,
    );
  }
  return {
    lifts: lifts as Record<TopicsLiftName, Module>,
    sources: sources as Record<TopicsLiftName, string>,
    mentionedBy: mentionedBy as MentionedBy,
  };
}

/**
 * Helper for {@link reachTopicsDerivations}, which returns the authored source
 * of a lift, or `undefined` for a module with no verified implementation.
 *
 * The builder installs a `src` accessor on a lift's implementation, and it
 * resolves through the same record the scheduler reads when it reports a run's
 * `src`, so the two agree by construction.
 */
function authoredSourceOf(module: Module): string | undefined {
  const { implementation } = module;
  if (typeof implementation !== "function") return undefined;
  const src: unknown = (implementation as { src?: unknown }).src;
  return typeof src === "string" ? src : undefined;
}

//
// Measurement
//

/** Completed-body reads, summed over the runs attributed to one bucket. */
export interface BodyReads extends ActionReadStats {
  /** Completed runs. */
  runs: number;

  /** The scheduler actions those runs belong to, by action ID. */
  readonly actions: Set<string>;

  /** The most proxy accesses any one of those runs made. */
  maxRunProxyAccesses: number;
}

/** Transaction-attempt reads, summed over every attempt of every kind. */
export interface AttemptReads {
  /** Attempts recorded. */
  attempts: number;

  /** Proxy accesses across those attempts. */
  proxyAccesses: number;

  /** Link resolutions across those attempts. */
  linkResolutions: number;
}

/** Reads recorded over one measurement. */
export interface TopicsReads {
  /**
   * Body reads per reached lift, attributed by the authored source each run
   * reports. Every other run, builtins and sinks included, is under `other`.
   */
  readonly bodies: Readonly<Record<TopicsLiftName | "other", BodyReads>>;

  /** Attempt reads, initialization included. */
  readonly attempts: AttemptReads;
}

/** A fixture written to storage. */
export interface SeededTopicsFixture {
  /** Each topic's document, by topic index. */
  readonly topics: readonly Cell<unknown>[];

  /** The board's list: one link to a topic document per board entry. */
  readonly board: Cell<unknown[]>;
}

/**
 * One row of the board's pivot, as a reader of the table sees it: links it
 * compares and follows, never values it expands.
 */
export interface PivotRow {
  /** The topic the row describes. */
  topic: unknown;

  /** The topics that mention it. */
  mentionedBy: unknown[];
}

/** The reached lifts' outputs over a seeded fixture. */
export interface TopicsOutputs {
  /** The board's pivot over the fixture's board: a link to a row per entry. */
  readonly table: Cell<PivotRow[]>;

  /** Each topic's backlinks, by topic index. */
  readonly backlinks: readonly Cell<unknown[]>[];

  /** Each topic's present comment count, by topic index. */
  readonly commentCounts: readonly Cell<number>[];

  /** Each topic's last activity, by topic index. */
  readonly lastActivity: readonly Cell<number>[];
}

/** A settled measurement, holding its runtime open until disposed. */
export interface TopicsMeasurement extends AsyncDisposable {
  /** The runtime the measurement ran in. */
  readonly runtime: Runtime;

  /** The reached derivations. */
  readonly derivations: TopicsDerivations;

  /** The fixture as written to storage. */
  readonly seeded: SeededTopicsFixture;

  /** The outputs, each held demanded until the measurement is disposed. */
  readonly outputs: TopicsOutputs;

  /** Reads from the start of the derivations through settlement. */
  readonly reads: TopicsReads;

  /** The scheduler's graph once settled. */
  readonly graph: SchedulerGraphSnapshot;

  /** Errors the runtime reported, in the order it reported them. */
  readonly errors: readonly string[];
}

/**
 * Runs the reached Topics lifts over `fixture` in a fresh runtime, holding
 * every output demanded, and returns once the runtime has settled.
 *
 * That demand is the all-backlinks workload: a scaling probe, not what a board
 * in use demands. Reads are recorded from the transaction that starts the
 * lifts, which is accounted as initialization, through settlement; compiling
 * the sources and writing the fixture precede it and are not recorded.
 */
export async function measureTopicsFixture(
  fixture: TopicsFixture,
  passphrase: string,
): Promise<TopicsMeasurement> {
  await using stack = new AsyncDisposableStack();
  const identity = await Identity.fromPassphrase(passphrase);
  const space: MemorySpace = identity.did();
  const storage = EmulatedStorageManager.emulate({ as: identity });
  stack.defer(() => storage.close());
  const errors: string[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    // Pinned here rather than taken from the environment, so a measurement
    // runs the same read semantics, on the client, whatever its host sets.
    experimental: { lazyMaterialization: true, serverExecution: false },
    errorHandlers: [(error) => errors.push(String(error))],
  });
  stack.defer(() => runtime.dispose({ closeStorage: false }));

  const derivations = await reachTopicsDerivations(
    runtime,
    await resolveTopicsProgram(runtime),
  );
  const seeded = await seedTopicsFixture(runtime, space, fixture);
  const recorder = recordTopicsReads(runtime, derivations.sources);
  let outputs: TopicsOutputs;
  try {
    outputs = await startTopicsLifts(runtime, space, derivations, seeded);
    for (
      const cell of [
        outputs.table,
        ...outputs.backlinks,
        ...outputs.commentCounts,
        ...outputs.lastActivity,
      ]
    ) {
      stack.defer(cell.sink(() => {}));
    }
    await runtime.settled(Infinity);
  } finally {
    recorder[Symbol.dispose]();
  }
  const graph = runtime.scheduler.getGraphSnapshot();

  const cleanup = stack.move();
  return {
    runtime,
    derivations,
    seeded,
    outputs,
    reads: recorder.reads,
    graph,
    errors,
    [Symbol.asyncDispose]: () => cleanup.disposeAsync(),
  };
}

/**
 * Helper for {@link measureTopicsFixture}, which writes `fixture` into `space`
 * in one commit, each mention as a link to the topic it names.
 */
async function seedTopicsFixture(
  runtime: Runtime,
  space: MemorySpace,
  fixture: TopicsFixture,
): Promise<SeededTopicsFixture> {
  const tx = runtime.edit();
  const topics = fixture.topics.map((_, index) =>
    runtime.getCell<unknown>(
      space,
      `topics-fixture-topic-${index}`,
      undefined,
      tx,
    )
  );
  fixture.topics.forEach((topic, index) =>
    topics[index].set({
      ...topic,
      mentions: topic.mentions.map((target) => topics[target]),
    })
  );
  const board = runtime.getCell<unknown[]>(
    space,
    "topics-fixture-board",
    undefined,
    tx,
  );
  board.set(fixture.board.map((index) => topics[index]));
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(`Writing the Topics fixture failed: ${error.name}`, {
      cause: error,
    });
  }
  return { topics: topics.map((cell) => cell.withTx()), board: board.withTx() };
}

/**
 * Helper for {@link measureTopicsFixture}, which starts the pivot over the
 * seeded board and every topic's three lifts in one transaction, begun as an
 * initialization attempt.
 */
async function startTopicsLifts(
  runtime: Runtime,
  space: MemorySpace,
  { lifts }: TopicsDerivations,
  seeded: SeededTopicsFixture,
): Promise<TopicsOutputs> {
  const tx = runtime.edit();
  runtime.scheduler.beginReadAttempt(tx, "initialization");
  const output = <T>(cause: string) =>
    runtime.getCell<T>(space, cause, undefined, tx);
  const table = runtime.run(
    tx,
    lifts.crossrefTable,
    { sources: seeded.board },
    output<PivotRow[]>("topics-fixture-crossrefs"),
  );
  const perTopic = seeded.topics.map((topic, index) => ({
    backlinks: runtime.run(
      tx,
      lifts.backlinksOf,
      { table, self: topic },
      output<unknown[]>(`topics-fixture-backlinks-${index}`),
    ),
    commentCount: runtime.run(
      tx,
      lifts.presentCommentCountOf,
      { comments: topic.key("comments") },
      output<number>(`topics-fixture-comment-count-${index}`),
    ),
    lastActivity: runtime.run(
      tx,
      lifts.lastActivityOf,
      {
        comments: topic.key("comments"),
        links: topic.key("links"),
        createdAt: topic.key("createdAt"),
        bodyUpdatedAt: topic.key("bodyUpdatedAt"),
        titleUpdatedAt: topic.key("titleUpdatedAt"),
      },
      output<number>(`topics-fixture-last-activity-${index}`),
    ),
  }));
  runtime.prepareTxForCommit(tx);
  const { error } = await tx.commit();
  if (error !== undefined) {
    throw new Error(`Starting the Topics lifts failed: ${error.name}`, {
      cause: error,
    });
  }
  return {
    table,
    backlinks: perTopic.map((topic) => topic.backlinks),
    commentCounts: perTopic.map((topic) => topic.commentCount),
    lastActivity: perTopic.map((topic) => topic.lastActivity),
  };
}

/**
 * Helper for {@link measureTopicsFixture}, which enables body and attempt read
 * accounting on `runtime` and records each completed run under the lift whose
 * authored source it reports, until disposed.
 */
function recordTopicsReads(
  runtime: Runtime,
  sources: Readonly<Record<TopicsLiftName, string>>,
): { readonly reads: TopicsReads } & Disposable {
  const liftBySource = new Map<string, TopicsLiftName>(
    TOPICS_LIFT_NAMES.map((name) => [sources[name], name]),
  );
  const emptyBody = (): BodyReads => ({
    runs: 0,
    actions: new Set(),
    proxyAccesses: 0,
    linkResolutions: 0,
    distinctDocuments: 0,
    registeredDependencies: 0,
    maxRunProxyAccesses: 0,
  });
  const reads = {
    bodies: {
      crossrefTable: emptyBody(),
      backlinksOf: emptyBody(),
      presentCommentCountOf: emptyBody(),
      lastActivityOf: emptyBody(),
      other: emptyBody(),
    },
    attempts: { attempts: 0, proxyAccesses: 0, linkResolutions: 0 },
  };
  const listener = (event: Event) => {
    if (!(event instanceof RuntimeTelemetryEvent)) return;
    const { marker } = event;
    if (marker.type === "scheduler.read-attempt") {
      reads.attempts.attempts++;
      reads.attempts.proxyAccesses += marker.reads.proxyAccesses;
      reads.attempts.linkResolutions += marker.reads.linkResolutions;
    } else if (marker.type === "scheduler.run.complete") {
      const lift = marker.src === undefined
        ? undefined
        : liftBySource.get(marker.src);
      const body = reads.bodies[lift ?? "other"];
      const run = marker.reads;
      body.runs++;
      body.actions.add(marker.actionId);
      body.proxyAccesses += run?.proxyAccesses ?? 0;
      body.linkResolutions += run?.linkResolutions ?? 0;
      body.distinctDocuments += run?.distinctDocuments ?? 0;
      body.registeredDependencies += run?.registeredDependencies ?? 0;
      body.maxRunProxyAccesses = Math.max(
        body.maxRunProxyAccesses,
        run?.proxyAccesses ?? 0,
      );
    }
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  runtime.scheduler.setReadStatsEnabled(true, { attempts: true });
  return {
    reads,
    [Symbol.dispose]: () => {
      runtime.scheduler.setReadStatsEnabled(false);
      runtime.telemetry.removeEventListener("telemetry", listener);
    },
  };
}

//
// Reading outputs back
//

/** One pivot entry, with its topics named by topic index. */
export interface PivotEntry {
  /** The row document the entry links to. */
  readonly row: string;

  /** The topic the row describes. */
  readonly topic: number;

  /** The topics the row says mention it, in the row's order. */
  readonly mentionedBy: readonly number[];
}

/**
 * Returns the topic index of each element of `list`, a list of links to the
 * seeded topic documents, and `-1` for an element that names none of them.
 */
export function topicIndicesOf(
  seeded: SeededTopicsFixture,
  list: Cell<unknown[]>,
): number[] {
  const ids = seeded.topics.map(documentIdOf);
  const length = list.get()?.length ?? 0;
  return Array.from(
    { length },
    (_, position) => ids.indexOf(documentIdOf(list.key(position))),
  );
}

/** Returns each entry of the board's pivot, in the pivot's order. */
export function pivotEntriesOf(
  seeded: SeededTopicsFixture,
  table: Cell<PivotRow[]>,
): PivotEntry[] {
  const ids = seeded.topics.map(documentIdOf);
  const length = table.get()?.length ?? 0;
  return Array.from({ length }, (_, position) => {
    const entry = table.key(position);
    return {
      row: documentIdOf(entry),
      topic: ids.indexOf(documentIdOf(entry.key("topic"))),
      mentionedBy: topicIndicesOf(seeded, entry.key("mentionedBy")),
    };
  });
}

/** Helper for the readers above, which returns the document a cell resolves to. */
function documentIdOf(cell: Cell<unknown>): string {
  return cell.resolveAsCell().getAsNormalizedFullLink().id;
}
