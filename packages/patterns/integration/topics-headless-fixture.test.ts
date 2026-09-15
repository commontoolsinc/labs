/**
 * Checks the headless Topics fixture's data, its reach into the unmodified
 * Topics sources, and what the reached lifts compute over it, each against an
 * oracle computed outside the runtime: `mentionedBy` and the fixture's own
 * mention indices for backlinks, and plain arithmetic over the fixture's
 * comments and links for the aggregates.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import {
  buildTopicsFixture,
  type FixtureTopic,
  measureTopicsFixture,
  pivotEntriesOf,
  reachTopicsDerivations,
  resolveTopicsProgram,
  topicIndicesOf,
  TOPICS_LIFT_NAMES,
  type TopicsFixture,
  type TopicsLiftName,
  type TopicsMeasurement,
} from "./topics-headless-fixture.ts";

/** The topic index of each board entry whose mention list names `topic`. */
function inboundByIndex(fixture: TopicsFixture, topic: number): number[] {
  return fixture.board.filter((source) =>
    source !== topic && fixture.topics[source].mentions.includes(topic)
  );
}

/** How many inbound mentions each topic has, counting each source once. */
function inboundCounts(fixture: TopicsFixture): number[] {
  return fixture.topics.map((_, topic) =>
    inboundByIndex(fixture, topic).length
  );
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

/** The count of a topic's comments carrying no retraction stamp. */
function presentComments(topic: FixtureTopic): number {
  return topic.comments.filter((comment) => comment.removedAt === undefined)
    .length;
}

/** The latest stamp anywhere on a topic, edits and retractions included. */
function latestStamp(topic: FixtureTopic): number {
  return Math.max(
    topic.createdAt,
    topic.bodyUpdatedAt,
    topic.titleUpdatedAt,
    ...topic.comments.flatMap((comment) => [
      comment.sentAt,
      comment.editedAt ?? 0,
      comment.removedAt ?? 0,
    ]),
    ...topic.links.flatMap((link) => [link.addedAt ?? 0, link.removedAt ?? 0]),
  );
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
      const { seeded, outputs } = measurement;
      const expected = topicIndices.map((topic) =>
        inboundByIndex(fixture, topic)
      );
      expect(
        topicIndices.map((topic) =>
          mentionedByIndex(measurement, fixture, topic)
        ),
      )
        .toEqual(expected);
      expect(
        topicIndices.map((topic) =>
          topicIndicesOf(seeded, outputs.backlinks[topic])
        ),
      ).toEqual(expected);
      expect(expected.every((backlinks) => backlinks.length > 0)).toBe(true);
    });

    it("returns a self-mentioning topic's backlinks without the topic itself", () => {
      const { seeded, outputs } = measurement;
      expect(fixture.topics[SELF_MENTIONER].mentions).toContain(SELF_MENTIONER);
      expect(topicIndicesOf(seeded, outputs.backlinks[SELF_MENTIONER]))
        .toEqual(mentionedByIndex(measurement, fixture, SELF_MENTIONER));
      expect(topicIndicesOf(seeded, outputs.backlinks[SELF_MENTIONER]))
        .not.toContain(SELF_MENTIONER);
    });

    it("returns a source that mentions a topic twice once among that topic's backlinks", () => {
      const { seeded, outputs } = measurement;
      const [target] = fixture.topics[REPEATED_MENTIONER].mentions;
      expect(
        fixture.topics[REPEATED_MENTIONER].mentions.filter((m) => m === target),
      ).toHaveLength(2);
      const backlinks = topicIndicesOf(seeded, outputs.backlinks[target]);
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
      expect(counts).toEqual(fixture.topics.map(presentComments));
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

    it("attributes each lift's runs to that lift by the source the scheduler reports", () => {
      // Each lift has one scheduler action per instance: one pivot, and one of
      // each topic lift per topic. The run telemetry the reads are keyed on,
      // the graph snapshot, and the reach helper's `src` all take an action's
      // authored source from one lookup, so the source string is not checked
      // independently here. The action IDs are: the reads gather them from
      // run telemetry, and the snapshot lists the actions the scheduler holds,
      // so the two sets agreeing shows each lift's runs are attributed to that
      // lift's own actions and to no others.

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
      }
      expect(reads.attempts.attempts).toBeGreaterThan(0);
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
      const { seeded, outputs } = measurement;
      const oracle = mentionedByIndex(measurement, fixture, DUPLICATED);
      expect(oracle).toEqual(inboundByIndex(fixture, DUPLICATED));
      expect(oracle).toEqual([0, 1]);
      expect(topicIndicesOf(seeded, outputs.backlinks[DUPLICATED])).toEqual(
        oracle,
      );
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
      const { seeded, outputs } = measurement;
      const others = fixture.topics.map((_, topic) => topic).filter((topic) =>
        topic !== DUPLICATED
      );
      const expected = others.map((topic) => inboundByIndex(fixture, topic));
      expect(
        others.map((topic) => mentionedByIndex(measurement, fixture, topic)),
      ).toEqual(expected);
      expect(
        others.map((topic) => topicIndicesOf(seeded, outputs.backlinks[topic])),
      ).toEqual(expected);
      const [target] = fixture.topics[DUPLICATED].mentions;
      expect(
        expected[others.indexOf(target)].filter((source) =>
          source === DUPLICATED
        ),
      ).toHaveLength(2);
    });
  });
});
