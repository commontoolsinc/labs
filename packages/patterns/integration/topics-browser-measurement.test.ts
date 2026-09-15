/**
 * Browser tests of `topics-browser-measurement.ts`, against a seeded board in a
 * real shell. The decisions that need no page are tested in
 * `packages/patterns/test/topics-browser-measurement-core.test.ts`, which a
 * plain `deno test` runs.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { env } from "@commonfabric/integration";
import type { RuntimeClient } from "@commonfabric/runtime-client";

import {
  seedIdentity,
  seedTopicBoard,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";
import {
  formatTopicsSample,
  measureTopicsReads,
  timeTopicsOperation,
  type TopicsSample,
} from "./topics-browser-measurement.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";

describe("topics-browser-measurement", () => {
  let fixture: TopicBoardFixture;
  let session: BoardSession;

  // The smallest board on which every named lift runs: the newest of two topics
  // cites the other, so the pivot has a row to build and a backlink to find.
  beforeAll(async () => {
    const identity = await seedIdentity(
      `topics browser measurement ${crypto.randomUUID()}`,
    );
    fixture = await seedTopicBoard({
      apiUrl: new URL(env.API_URL),
      spaceName: env.SPACE_NAME,
      identity,
      topicCount: 2,
      crossrefsPerTopic: 1,
      citingTopics: 1,
    });
    session = await BoardSession.open({ fixture, identity });
    await session.load();
    await session.signIn();
    await session.showBoard();
  });

  afterAll(async () => {
    await session?.close();
  });

  /** Runs `check`, printing `sample` to stderr when a check fails. */
  function checkSample(sample: TopicsSample, check: () => void): void {
    try {
      check();
    } catch (error) {
      console.error(formatTopicsSample(sample).join("\n"));
      throw error;
    }
  }

  /** Index of the seeded topic `pieceId` addresses. */
  function topicIndexOf(pieceId: string): number {
    return fixture.topics.findIndex((topic) =>
      topic.fid === pieceId.replace(/^of:/, "")
    );
  }

  /**
   * Opens the topmost topic, waiting for both topics' titles on its page, and
   * returns its index.
   */
  async function openTopmostTopic(): Promise<number> {
    const pieceId = await session.openTopic((opened) => {
      const index = topicIndexOf(opened);
      return [topicTitle(index), topicTitle(1 - index)];
    });
    return topicIndexOf(pieceId);
  }

  /**
   * Returns to the board through the shell's own navigation, so one runtime
   * serves the whole sequence.
   */
  async function returnToBoard(): Promise<void> {
    await session.page.evaluate(
      async (spaceName: string, pieceId: string) => {
        await globalThis.app.setView({ spaceName, pieceId });
      },
      { args: [fixture.spaceName, fixture.boardId] },
    );
    await waitForPieceView(session.page, fixture.spaceName, fixture.boardId);
    await session.showBoard();
  }

  describe("measureTopicsReads()", () => {
    it("returns a run with reads of each named lift, attributed to its own implementation, over opening a topic and returning to the board", async () => {
      // The implementation each row carries is the graph's own text for the
      // action counted there. Checking its parameters against the lift's
      // declaration here pins each row to its lift, independently of how the
      // helper located the lift.

      const sample = await measureTopicsReads(session.page, {
        label: "open topic and return",
        operation: async () => {
          await openTopmostTopic();
          await returnToBoard();
        },
      });

      checkSample(sample, () => {
        expect(
          sample.lifts.map((lift) => [
            lift.name,
            lift.implementation?.split(" =>")[0],
          ]),
        ).toEqual([
          ["crossrefTable", "({ sources })"],
          ["backlinksOf", "({ table, self })"],
          ["presentCommentCountOf", "({ comments })"],
          [
            "lastActivityOf",
            "({ comments, links, createdAt, bodyUpdatedAt, titleUpdatedAt })",
          ],
        ]);
        expect(
          sample.lifts.filter((lift) =>
            lift.runs === 0 || lift.proxyAccesses === 0
          )
            .map((lift) => lift.name),
        ).toEqual([]);
        expect(sample.graph.before.nodes).toBeGreaterThan(0);
        expect(sample.graph.before.edges).toBeGreaterThan(0);
        expect(sample.graph.after.nodes).toBeGreaterThan(0);
        expect(sample.graph.after.edges).toBeGreaterThan(0);
      });
    });

    it("throws for an operation that demands nothing", async () => {
      await expect(
        measureTopicsReads(session.page, {
          label: "undemanded",
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow(
        "undemanded: the measured operation produced no runs with a read sample",
      );
    });
  });

  describe("timeTopicsOperation()", () => {
    it("returns a sample with accounting turned off, delivering no run marker to telemetry a caller left on", async () => {
      // Following the opened topic's cross-reference starts the other topic,
      // which no earlier case opens, so the interval runs work in the worker.
      // A repeat of an operation already run can run nothing, and a count of
      // delivered markers over it would be zero whatever the sampler did.

      await session.page.evaluate(async () => {
        const scope = globalThis as typeof globalThis & {
          commonfabric?: { rt?: RuntimeClient };
          __cfLeftOnRuns?: { count: number; stop: () => void };
        };
        const rt = scope.commonfabric!.rt!;
        const counter = { count: 0, stop: () => {} };
        const listener: Parameters<typeof rt.on<"telemetry">>[1] = (
          marker,
        ) => {
          if (marker.type === "scheduler.run.complete") counter.count++;
        };
        rt.on("telemetry", listener);
        counter.stop = () => rt.off("telemetry", listener);
        scope.__cfLeftOnRuns = counter;
        await rt.setTelemetryEnabled(true);
        await rt.setReadStatsEnabled(true);
      });
      const sample = await timeTopicsOperation(session.page, {
        label: "open the other topic and return, timed",
        operation: async () => {
          const opened = await openTopmostTopic();
          await session.followCrossref(topicTitle(1 - opened));
          await returnToBoard();
        },
      });
      const delivered = await session.page.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __cfLeftOnRuns?: { count: number; stop: () => void };
        };
        scope.__cfLeftOnRuns!.stop();
        return scope.__cfLeftOnRuns!.count;
      });

      checkSample(sample, () => {
        expect(sample.readAccounting).toBe(false);
        expect(sample.accountingTurnedOff).toBe(true);
        expect(sample.mayRunNothing).toBe(false);
        expect(sample.workerRuns).toBeGreaterThan(0);
        expect(delivered).toBe(0);
        expect(sample.elapsedMs).toBeGreaterThan(0);
        expect(sample.graph.after.nodes).toBeGreaterThan(0);
      });
    });

    it("throws for an operation that runs nothing in the worker", async () => {
      await expect(
        timeTopicsOperation(session.page, {
          label: "idle",
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow("idle: the timed operation ran nothing in the worker");
    });

    it("returns a sample recording the declaration for an operation declared to run nothing", async () => {
      const sample = await timeTopicsOperation(session.page, {
        label: "idle, declared",
        operation: () => Promise.resolve(),
        mayRunNothing: true,
      });

      expect(sample.mayRunNothing).toBe(true);
    });
  });
});
