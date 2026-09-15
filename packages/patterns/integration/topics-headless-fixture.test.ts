/**
 * Checks the headless Topics fixture's data, its reach into the unmodified
 * Topics sources, and what the reached lifts compute over it, each against an
 * oracle computed outside the runtime: `mentionedBy` and the fixture's own
 * mention indices for backlinks, and plain arithmetic over the fixture's
 * comments and links for the aggregates.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import type { Cell } from "@commonfabric/runner";

import {
  buildTopicsFixture,
  type FixtureTopic,
  latestStamp,
  measureTopicsFixture,
  mentionersOf,
  pivotEntriesOf,
  presentCommentCount,
  reachTopicsDerivations,
  resolveTopicsProgram,
  topicIndicesOf,
  TOPICS_LIFT_NAMES,
  type TopicsFixture,
  type TopicsLiftName,
  type TopicsMeasurement,
  type TopicsOperation,
} from "./topics-headless-fixture.ts";

/** How many inbound mentions each topic has, counting each source once. */
function inboundCounts(fixture: TopicsFixture): number[] {
  return fixture.topics.map((_, topic) => mentionersOf(fixture, topic).length);
}

/** The backlinks `measurement` holds for `topic`, which it must demand. */
function backlinksOutputOf(
  measurement: TopicsMeasurement,
  topic: number,
): Cell<unknown[]> {
  const backlinks = measurement.outputs.backlinks.get(topic);
  if (backlinks === undefined) {
    throw new Error(
      `The measurement does not demand topic ${topic}'s backlinks.`,
    );
  }
  return backlinks;
}

/** How many of each lift's actions the scheduler holds once settled. */
function graphActionCounts(
  measurement: TopicsMeasurement,
): Record<TopicsLiftName, number> {
  const { graph, derivations } = measurement;
  const countOf = (lift: TopicsLiftName) =>
    graph.nodes.filter((node) => node.src === derivations.sources[lift]).length;
  return {
    crossrefTable: countOf("crossrefTable"),
    backlinksOf: countOf("backlinksOf"),
    presentCommentCountOf: countOf("presentCommentCountOf"),
    lastActivityOf: countOf("lastActivityOf"),
  };
}

/** Every mention entry in the fixture, repeats included. */
function mentionCount(fixture: TopicsFixture): number {
  return fixture.topics.reduce((sum, topic) => sum + topic.mentions.length, 0);
}

/** What `mentionedBy` returns for `topic` over the measured board, by index. */
function mentionedByIndex(
  measurement: TopicsMeasurement,
  fixture: TopicsFixture,
  topic: number,
): number[] {
  const { seeded, derivations } = measurement;
  const entries = fixture.board.map((index) => seeded.topics[index]);
  const mentions = fixture.board.map((index) =>
    fixture.topics[index].mentions.map((target) => seeded.topics[target])
  );
  return derivations.mentionedBy(seeded.topics[topic], entries, mentions)
    .map((entry) => fixture.board[entries.indexOf(entry)]);
}

/** The latest stamp on a topic when edits and retractions are left out. */
function latestSendOrAddition(topic: FixtureTopic): number {
  return Math.max(
    topic.createdAt,
    topic.bodyUpdatedAt,
    topic.titleUpdatedAt,
    ...topic.comments.map((comment) => comment.sentAt),
    ...topic.links.map((link) => link.addedAt ?? 0),
  );
}

describe("topics-headless-fixture", () => {
  describe("buildTopicsFixture()", () => {
    it("returns no mentions for the `none` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
      });
      expect(mentionCount(fixture)).toBe(0);
      expect(inboundCounts(fixture)).toEqual([0, 0, 0, 0, 0, 0]);
    });

    it("returns `perSource` mentions from each topic and `perSource` inbound to each for the `low-degree` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "low-degree", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(12);
      expect(inboundCounts(fixture)).toEqual([2, 2, 2, 2, 2, 2]);
      expect(fixture.topics[5].mentions).toEqual([0, 1]);
    });

    it("returns `perSource` mentions from each topic, landing on `perSource` + 1 topics, for the `high-degree` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "high-degree", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(12);
      expect(inboundCounts(fixture)).toEqual([5, 5, 2, 0, 0, 0]);
    });

    it("returns `perSource` mentions of the first topic from each other topic, and none from the first topic, for the `single-bucket` shape", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "single-bucket", perSource: 2 },
      });
      expect(mentionCount(fixture)).toBe(10);
      expect(inboundCounts(fixture)).toEqual([5, 0, 0, 0, 0, 0]);
      expect(fixture.topics[0].mentions).toEqual([]);
      expect(fixture.topics[3].mentions).toEqual([0, 0]);
    });

    it("returns one more mention each for a self-mention and a repeated mention", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "low-degree", perSource: 2 },
        selfMention: 0,
        repeatedMention: 1,
      });
      expect(mentionCount(fixture)).toBe(14);
      expect(fixture.topics[0].mentions).toEqual([1, 2, 0]);
      expect(fixture.topics[1].mentions).toEqual([2, 3, 2]);
    });

    it("returns a board listing a duplicated topic again after every other entry", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
        duplicateBoardEntry: 2,
      });
      expect(fixture.board).toEqual([0, 1, 2, 3, 4, 5, 2]);
    });

    it("returns equal fixtures for equal options", () => {
      const options = {
        topicCount: 8,
        mentions: { shape: "high-degree", perSource: 3 },
        commentsPerTopic: 7,
        linksPerTopic: 5,
        selfMention: 4,
        repeatedMention: 6,
        duplicateBoardEntry: 1,
      } as const;
      expect(buildTopicsFixture(options)).toEqual(buildTopicsFixture(options));
    });

    it("returns edited and retracted comments, and retracted and unstamped links, on every topic", () => {
      const fixture = buildTopicsFixture({
        topicCount: 6,
        mentions: { shape: "none" },
      });
      for (const topic of fixture.topics) {
        expect(topic.comments.some((c) => c.editedAt !== undefined)).toBe(true);
        expect(topic.comments.some((c) => c.removedAt !== undefined)).toBe(
          true,
        );
        expect(topic.links.some((l) => l.removedAt !== undefined)).toBe(true);
        expect(topic.links.some((l) => l.addedAt === undefined)).toBe(true);
      }
    });

    it("returns topics whose latest stamps are, in rotation, a comment retraction, a comment edit, and a link retraction", () => {
      const fixture = buildTopicsFixture({
        topicCount: 3,
        mentions: { shape: "none" },
      });
      const [retracted, edited, unlinked] = fixture.topics;
      for (const topic of fixture.topics) {
        expect(latestStamp(topic)).toBeGreaterThan(latestSendOrAddition(topic));
      }
      expect(retracted.comments.at(-1)?.removedAt).toBe(
        latestStamp(retracted),
      );
      expect(edited.comments.at(-1)?.editedAt).toBe(latestStamp(edited));
      expect(unlinked.links.at(-1)?.removedAt).toBe(latestStamp(unlinked));
    });

    it("throws for an option naming a topic index outside the fixture", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "none" },
          selfMention: 6,
        })
      ).toThrow(/`selfMention`/);
    });

    it("throws for more mentions per source than there are other topics", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "low-degree", perSource: 6 },
        })
      ).toThrow(/`mentions.perSource`/);
    });

    it("throws for a repeated mention on a topic that mentions nothing", () => {
      expect(() =>
        buildTopicsFixture({
          topicCount: 6,
          mentions: { shape: "single-bucket", perSource: 1 },
          repeatedMention: 0,
        })
      ).toThrow(/`repeatedMention`/);
    });
  });

  describe("reachTopicsDerivations()", () => {
    it("returns the four lifts, each with its authored source, and `mentionedBy` from the Topics sources", async () => {
      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture reach",
      );
      const { sources, mentionedBy } = measurement.derivations;
      expect(sources.crossrefTable).toMatch(
        /^cf:module\/[^/]+\/topics\/main\.tsx:\d+:\d+$/,
      );
      for (
        const name of [
          "backlinksOf",
          "presentCommentCountOf",
          "lastActivityOf",
        ] as const
      ) {
        expect(sources[name]).toMatch(
          /^cf:module\/[^/]+\/topics\/topic\.tsx:\d+:\d+$/,
        );
      }
      expect(new Set(Object.values(sources)).size).toBe(4);
      expect(typeof mentionedBy).toBe("function");
    });

    it("throws naming each symbol a Topics program does not define", async () => {
      // A board whose topic module defines two of the three topic lifts, and
      // whose entry module defines the pivot but exports no join.

      await using measurement = await measureTopicsFixture(
        buildTopicsFixture({ topicCount: 1, mentions: { shape: "none" } }),
        "topics-headless-fixture missing symbol",
      );
      const { runtime } = measurement;
      const stub = {
        main: "/topics/main.tsx",
        files: [
          {
            name: "/topics/main.tsx",
            contents: [
              `import { lift } from "commonfabric";`,
              `import { presentCount } from "./topic.tsx";`,
              `const crossrefTable = lift(`,
              `  ({ sources }: { sources: unknown[] }) => sources.length,`,
              `);`,
              `export const pivot = crossrefTable;`,
              `export const counted = presentCount;`,
            ].join("\n"),
          },
          {
            name: "/topics/topic.tsx",
            contents: [
              `import { lift } from "commonfabric";`,
              `const presentCommentCountOf = lift(`,
              `  ({ comments }: { comments: unknown[] }) => comments.length,`,
              `);`,
              `const lastActivityOf = lift(`,
              `  ({ createdAt }: { createdAt: number }) => createdAt,`,
              `);`,
              `export const presentCount = presentCommentCountOf;`,
              `export const activity = lastActivityOf;`,
            ].join("\n"),
          },
        ],
      };
      const reached = reachTopicsDerivations(runtime, stub);
      await expect(reached).rejects.toThrow(/`backlinksOf`, `mentionedBy`/);
      await expect(reachTopicsDerivations(runtime, stub)).rejects.not.toThrow(
        /`crossrefTable`|`presentCommentCountOf`|`lastActivityOf`/,
      );
      await expect(
        reachTopicsDerivations(runtime, await resolveTopicsProgram(runtime)),
      ).resolves.toBeDefined();
    });
  });

  describe("over a board with a self-mention and a repeated mention", () => {
    const SELF_MENTIONER = 0;
    const REPEATED_MENTIONER = 1;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "low-degree", perSource: 2 },
      selfMention: SELF_MENTIONER,
      repeatedMention: REPEATED_MENTIONER,
    });
    const topicIndices = fixture.topics.map((_, index) => index);
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture oracle",
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns every topic's backlinks as `mentionedBy` and the fixture's indices compute them", () => {
      const { seeded } = measurement;
      const expected = topicIndices.map((topic) =>
        mentionersOf(fixture, topic)
      );
      expect(
        topicIndices.map((topic) =>
          mentionedByIndex(measurement, fixture, topic)
        ),
      )
        .toEqual(expected);
      expect(
        topicIndices.map((topic) =>
          topicIndicesOf(seeded, backlinksOutputOf(measurement, topic))
        ),
      ).toEqual(expected);
      expect(expected.every((backlinks) => backlinks.length > 0)).toBe(true);
    });

    it("returns a self-mentioning topic's backlinks without the topic itself", () => {
      const { seeded } = measurement;
      expect(fixture.topics[SELF_MENTIONER].mentions).toContain(SELF_MENTIONER);
      expect(
        topicIndicesOf(seeded, backlinksOutputOf(measurement, SELF_MENTIONER)),
      )
        .toEqual(mentionedByIndex(measurement, fixture, SELF_MENTIONER));
      expect(
        topicIndicesOf(seeded, backlinksOutputOf(measurement, SELF_MENTIONER)),
      )
        .not.toContain(SELF_MENTIONER);
    });

    it("returns a source that mentions a topic twice once among that topic's backlinks", () => {
      const { seeded } = measurement;
      const [target] = fixture.topics[REPEATED_MENTIONER].mentions;
      expect(
        fixture.topics[REPEATED_MENTIONER].mentions.filter((m) => m === target),
      ).toHaveLength(2);
      const backlinks = topicIndicesOf(
        seeded,
        backlinksOutputOf(measurement, target),
      );
      expect(backlinks).toEqual(mentionedByIndex(measurement, fixture, target));
      expect(backlinks.filter((source) => source === REPEATED_MENTIONER))
        .toHaveLength(1);
    });

    it("returns a pivot entry per board entry, naming its topic and the topics `mentionedBy` computes", () => {
      const { seeded, outputs } = measurement;
      expect(
        pivotEntriesOf(seeded, outputs.table).map(({ topic, mentionedBy }) => ({
          topic,
          mentionedBy,
        })),
      ).toEqual(fixture.board.map((topic) => ({
        topic,
        mentionedBy: mentionedByIndex(measurement, fixture, topic),
      })));
    });

    it("returns each topic's present comment count as a count of its unretracted comments", () => {
      const counts = measurement.outputs.commentCounts.map((cell) =>
        cell.get()
      );
      expect(counts).toEqual(fixture.topics.map(presentCommentCount));
      expect(
        counts.some((count, topic) =>
          count < fixture.topics[topic].comments.length
        ),
      ).toBe(true);
    });

    it("returns each topic's last activity as its latest stamp, edits and retractions included", () => {
      const activity = measurement.outputs.lastActivity.map((cell) =>
        cell.get()
      );
      expect(activity).toEqual(fixture.topics.map(latestStamp));
      expect(
        fixture.topics.every((topic) =>
          latestStamp(topic) > latestSendOrAddition(topic)
        ),
      ).toBe(true);
    });

    it("attributes each lift's runs and attempts to that lift by the source the scheduler reports", () => {
      // Each lift has one scheduler action per instance: one pivot, and one of
      // each topic lift per topic. The run telemetry the reads are keyed on,
      // the graph snapshot, and the reach helper's `src` all take an action's
      // authored source from one lookup, so the source string is not checked
      // independently here. The action IDs are: the reads gather them from
      // run telemetry, and the snapshot lists the actions the scheduler holds,
      // so the two sets agreeing shows each lift's runs are attributed to that
      // lift's own actions and to no others. Attempts are attributed through
      // those same action IDs, and each run commits in an attempt of its own.

      const { reads, graph, derivations } = measurement;
      const instances = {
        crossrefTable: 1,
        backlinksOf: fixture.topics.length,
        presentCommentCountOf: fixture.topics.length,
        lastActivityOf: fixture.topics.length,
      } satisfies Record<TopicsLiftName, number>;
      for (const lift of TOPICS_LIFT_NAMES) {
        const count = instances[lift];
        const body = reads.bodies[lift];
        const graphActions = graph.nodes
          .filter((node) => node.src === derivations.sources[lift])
          .map((node) => node.id);
        expect({ lift, actions: body.actions.size }).toEqual({
          lift,
          actions: count,
        });
        expect([...body.actions].toSorted()).toEqual(graphActions.toSorted());
        expect(body.runs).toBeGreaterThanOrEqual(count);
        expect(body.proxyAccesses).toBeGreaterThan(0);
        expect({ lift, attempts: reads.attempts[lift].attempts >= count })
          .toEqual({ lift, attempts: true });
      }
      expect(reads.attempts.other.attempts).toBeGreaterThan(0);
    });
  });

  describe("over a board listing one topic twice", () => {
    const DUPLICATED = 2;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "low-degree", perSource: 2 },
      // `mentionedBy` leaves a topic out of its own backlinks by identity, not
      // by board position, so the duplicated topic's self-mention must not
      // reach it through its second entry. Without the self-mention, a
      // position comparison would pass every case below.
      selfMention: DUPLICATED,
      duplicateBoardEntry: DUPLICATED,
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture duplicate entry",
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns a duplicated topic its own backlinks once", () => {
      const { seeded } = measurement;
      const oracle = mentionedByIndex(measurement, fixture, DUPLICATED);
      expect(oracle).toEqual(mentionersOf(fixture, DUPLICATED));
      expect(oracle).toEqual([0, 1]);
      expect(
        topicIndicesOf(seeded, backlinksOutputOf(measurement, DUPLICATED)),
      ).toEqual(oracle);
    });

    it("returns one pivot entry per distinct topic, each on its own row, in the order of each topic's first board entry", () => {
      // The duplicate is the board's last entry, so ordering by last
      // occurrence would move the duplicated topic to the end.

      const entries = pivotEntriesOf(
        measurement.seeded,
        measurement.outputs.table,
      );
      expect(fixture.board).toEqual([0, 1, 2, 3, 4, 5, DUPLICATED]);
      const firstOccurrences = [0, 1, 2, 3, 4, 5];
      expect(
        entries.map(({ topic, mentionedBy }) => ({ topic, mentionedBy })),
      ).toEqual(firstOccurrences.map((topic) => ({
        topic,
        mentionedBy: mentionedByIndex(measurement, fixture, topic),
      })));
      expect(new Set(entries.map((entry) => entry.row)).size).toBe(
        firstOccurrences.length,
      );
    });

    it("returns every other topic's backlinks as the fixture's indices and `mentionedBy` compute them, with the duplicated source listed per entry", () => {
      const { seeded } = measurement;
      const others = fixture.topics.map((_, topic) => topic).filter((topic) =>
        topic !== DUPLICATED
      );
      const expected = others.map((topic) => mentionersOf(fixture, topic));
      expect(
        others.map((topic) => mentionedByIndex(measurement, fixture, topic)),
      ).toEqual(expected);
      expect(
        others.map((topic) =>
          topicIndicesOf(seeded, backlinksOutputOf(measurement, topic))
        ),
      ).toEqual(expected);
      const [target] = fixture.topics[DUPLICATED].mentions;
      expect(
        expected[others.indexOf(target)].filter((source) =>
          source === DUPLICATED
        ),
      ).toHaveLength(2);
    });
  });

  describe("over a board with no topic open", () => {
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "high-degree", perSource: 2 },
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture board demand",
        { workload: "board" },
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("starts the pivot and every topic's comment count and last activity, and no backlinks", () => {
      expect(graphActionCounts(measurement)).toEqual({
        crossrefTable: 1,
        backlinksOf: 0,
        presentCommentCountOf: fixture.topics.length,
        lastActivityOf: fixture.topics.length,
      });
      expect(measurement.outputs.backlinks.size).toBe(0);
      expect(measurement.reads.bodies.crossrefTable.runs).toBeGreaterThan(0);
    });

    it("returns a pivot entry per distinct topic on the board, naming the topics that mention it", () => {
      const { seeded, outputs } = measurement;
      expect(
        pivotEntriesOf(seeded, outputs.table).map(({ topic, mentionedBy }) => ({
          topic,
          mentionedBy,
        })),
      ).toEqual([...new Set(fixture.board)].map((topic) => ({
        topic,
        mentionedBy: mentionersOf(fixture, topic),
      })));
    });

    it("returns every topic's present comment count and last activity", () => {
      const { outputs } = measurement;
      expect({
        commentCounts: outputs.commentCounts.map((cell) => cell.get()),
        lastActivity: outputs.lastActivity.map((cell) => cell.get()),
      }).toEqual({
        commentCounts: fixture.topics.map(presentCommentCount),
        lastActivity: fixture.topics.map(latestStamp),
      });
    });
  });

  describe("over a board with one topic open", () => {
    const OPEN = 1;
    const fixture = buildTopicsFixture({
      topicCount: 6,
      mentions: { shape: "high-degree", perSource: 2 },
    });
    let measurement: TopicsMeasurement;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture topic-open demand",
        { workload: "topic-open", topic: OPEN },
      );
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("starts the board's lifts and the open topic's backlinks, and no other topic's backlinks", () => {
      expect(graphActionCounts(measurement)).toEqual({
        crossrefTable: 1,
        backlinksOf: 1,
        presentCommentCountOf: fixture.topics.length,
        lastActivityOf: fixture.topics.length,
      });
      expect([...measurement.outputs.backlinks.keys()]).toEqual([OPEN]);
    });

    it("returns the open topic's backlinks, present comment count, and last activity", () => {
      const { seeded, outputs } = measurement;
      expect(mentionersOf(fixture, OPEN)).toHaveLength(5);
      expect({
        backlinks: topicIndicesOf(seeded, backlinksOutputOf(measurement, OPEN)),
        commentCount: outputs.commentCounts[OPEN].get(),
        lastActivity: outputs.lastActivity[OPEN].get(),
      }).toEqual({
        backlinks: mentionersOf(fixture, OPEN),
        commentCount: presentCommentCount(fixture.topics[OPEN]),
        lastActivity: latestStamp(fixture.topics[OPEN]),
      });
    });

    it("throws for an open topic outside the fixture", async () => {
      await expect(
        measureTopicsFixture(fixture, "topics-headless-fixture out of range", {
          workload: "topic-open",
          topic: fixture.topics.length,
        }),
      ).rejects.toThrow(/`demand.topic`/);
    });
  });

  describe("update()", () => {
    const MENTIONER = 2;
    const OPEN = 0;
    const fixture = buildTopicsFixture({
      topicCount: 4,
      mentions: { shape: "none" },
    });
    let measurement: TopicsMeasurement;
    let initialPivotRuns: number;
    let update: TopicsOperation;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture update",
        { workload: "topic-open", topic: OPEN },
      );
      const { seeded } = measurement;
      initialPivotRuns = measurement.reads.bodies.crossrefTable.runs;
      update = await measurement.update((tx) => {
        seeded.topics[MENTIONER].withTx(tx).key("mentions").set([
          seeded.topics[OPEN],
        ]);
      });
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("returns once the outputs reflect the edit", () => {
      expect(
        topicIndicesOf(
          measurement.seeded,
          backlinksOutputOf(measurement, OPEN),
        ),
      ).toEqual([MENTIONER]);
    });

    it("returns the runs and attempts the edit causes, attributed to the pivot and the lookup", () => {
      const { bodies, attempts } = update.reads;
      expect({
        pivotRuns: bodies.crossrefTable.runs > 0,
        lookupRuns: bodies.backlinksOf.runs > 0,
        pivotAttempts: attempts.crossrefTable.attempts > 0,
        lookupAttempts: attempts.backlinksOf.attempts > 0,
      }).toEqual({
        pivotRuns: true,
        lookupRuns: true,
        pivotAttempts: true,
        lookupAttempts: true,
      });
    });

    it("leaves the initialization reads as they were", () => {
      expect(measurement.reads.bodies.crossrefTable.runs).toBe(
        initialPivotRuns,
      );
    });
  });

  describe("reopen()", () => {
    const MENTIONER = 2;
    const OPEN = 0;
    const fixture = buildTopicsFixture({
      topicCount: 4,
      mentions: { shape: "none" },
    });
    let measurement: TopicsMeasurement;
    let measuredRuntime: TopicsMeasurement["runtime"];
    let reopened: TopicsOperation;

    beforeAll(async () => {
      measurement = await measureTopicsFixture(
        fixture,
        "topics-headless-fixture reopen",
        { workload: "topic-open", topic: OPEN },
      );
      const { seeded } = measurement;
      await measurement.update((tx) => {
        seeded.topics[MENTIONER].withTx(tx).key("mentions").set([
          seeded.topics[OPEN],
        ]);
      });
      measuredRuntime = measurement.runtime;
      reopened = await measurement.reopen();
    });
    afterAll(async () => {
      await measurement?.[Symbol.asyncDispose]();
    });

    it("reports no runtime errors", () => {
      expect(measurement.errors).toEqual([]);
    });

    it("leaves the measurement holding a runtime other than the one it started", () => {
      expect(measurement.runtime).not.toBe(measuredRuntime);
    });

    it("returns outputs holding what the first runtime stored, its update included", () => {
      const { seeded, outputs } = measurement;
      expect({
        backlinks: topicIndicesOf(seeded, backlinksOutputOf(measurement, OPEN)),
        commentCount: outputs.commentCounts[OPEN].get(),
        lastActivity: outputs.lastActivity[OPEN].get(),
      }).toEqual({
        backlinks: [MENTIONER],
        commentCount: presentCommentCount(fixture.topics[OPEN]),
        lastActivity: latestStamp(fixture.topics[OPEN]),
      });
    });

    it("returns the reads of starting the demanded lifts again", () => {
      const { bodies, attempts } = reopened.reads;
      expect(
        TOPICS_LIFT_NAMES.map((lift) => ({
          lift,
          actions: bodies[lift].actions.size,
          attempted: attempts[lift].attempts > 0,
        })),
      ).toEqual([
        { lift: "crossrefTable", actions: 1, attempted: true },
        { lift: "backlinksOf", actions: 1, attempted: true },
        {
          lift: "presentCommentCountOf",
          actions: fixture.topics.length,
          attempted: true,
        },
        {
          lift: "lastActivityOf",
          actions: fixture.topics.length,
          attempted: true,
        },
      ]);
    });
  });
});
