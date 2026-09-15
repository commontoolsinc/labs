/**
 * Browser tests of `topics-browser-measurement.ts`, against a seeded board in a
 * real shell. The decisions that need no page are tested in
 * `packages/patterns/test/topics-browser-measurement-core.test.ts`, which a
 * plain `deno test` runs.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import type { Identity } from "@commonfabric/identity";
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
  let identity: Identity;
  let session: BoardSession;

  // The smallest board on which every named lift runs: the newest of two topics
  // cites the other, so the pivot has a row to build and a backlink to find.
  beforeAll(async () => {
    identity = await seedIdentity(
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

  /** Tokens of the samples the page still holds. */
  async function samplesLeftInPage(): Promise<string[]> {
    return await session.page.evaluate(() =>
      Object.keys(
        (globalThis as typeof globalThis & {
          __cfTopicsSamples?: Record<string, unknown>;
        }).__cfTopicsSamples ?? {},
      )
    );
  }

  /**
   * Stands a client that answers only `idle()` in for the page's runtime
   * client, as a replaced runtime would appear to a sample in progress.
   */
  async function replaceRuntimeClient(): Promise<void> {
    await session.page.evaluate(() => {
      const scope = globalThis as typeof globalThis & {
        commonfabric?: { rt?: RuntimeClient };
        __cfReplacedClient?: RuntimeClient;
      };
      scope.__cfReplacedClient = scope.commonfabric!.rt;
      scope.commonfabric!.rt = {
        idle: () => Promise.resolve(),
      } as unknown as RuntimeClient;
    });
  }

  /**
   * Puts the page's own runtime client back after
   * {@link replaceRuntimeClient}, with telemetry and read accounting off.
   */
  async function restoreRuntimeClient(): Promise<void> {
    await session.page.evaluate(async () => {
      const scope = globalThis as typeof globalThis & {
        commonfabric?: { rt?: RuntimeClient };
        __cfReplacedClient?: RuntimeClient;
      };
      if (scope.__cfReplacedClient === undefined) return;
      scope.commonfabric!.rt = scope.__cfReplacedClient;
      delete scope.__cfReplacedClient;
      await scope.commonfabric!.rt.setReadStatsEnabled(false);
      await scope.commonfabric!.rt.setTelemetryEnabled(false);
    });
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
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws the operation's own error and leaves no sample in the page", async () => {
      const failure = new Error("the operation failed on purpose");
      await expect(
        measureTopicsReads(session.page, {
          label: "failing",
          operation: () => Promise.reject(failure),
        }),
      ).rejects.toBe(failure);
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws when the runtime client is replaced during the operation", async () => {
      try {
        await expect(
          measureTopicsReads(session.page, {
            label: "replaced client",
            operation: replaceRuntimeClient,
          }),
        ).rejects.toThrow("The runtime client was replaced");
      } finally {
        await restoreRuntimeClient();
      }
      expect(await samplesLeftInPage()).toEqual([]);
    });
  });

  describe("timeTopicsOperation()", () => {
    it("returns a sample with accounting turned off, delivering no run marker to telemetry a caller left on", async () => {
      // A browser of its own, in which no other case has opened a topic, so
      // the timed interval runs work in the worker whichever cases ran first.
      // An operation already run in a page can run nothing, and a count of
      // delivered markers over it would be zero whatever the sampler did.

      const fresh = await BoardSession.open({ fixture, identity });
      try {
        await fresh.load();
        await fresh.signIn();
        await fresh.showBoard();
        await fresh.page.evaluate(async () => {
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
        const sample = await timeTopicsOperation(fresh.page, {
          label: "open topic and return, timed",
          operation: async () => {
            await fresh.openTopic((opened) => {
              const index = topicIndexOf(opened);
              return [topicTitle(index), topicTitle(1 - index)];
            });
            await fresh.page.evaluate(
              async (spaceName: string, pieceId: string) => {
                await globalThis.app.setView({ spaceName, pieceId });
              },
              { args: [fixture.spaceName, fixture.boardId] },
            );
            await waitForPieceView(
              fresh.page,
              fixture.spaceName,
              fixture.boardId,
            );
            await fresh.showBoard();
          },
        });
        const delivered = await fresh.page.evaluate(() => {
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
      } finally {
        await fresh.close();
      }
    });

    it("throws for an operation that runs nothing in the worker", async () => {
      await expect(
        timeTopicsOperation(session.page, {
          label: "idle",
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow("idle: the timed operation ran nothing in the worker");
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws the operation's own error, ends the interval, and leaves no sample in the page", async () => {
      const failure = new Error("the operation failed on purpose");
      const interval = { started: 0, ended: 0 };
      await expect(
        timeTopicsOperation(session.page, {
          label: "failing, timed",
          operation: () => Promise.reject(failure),
          interval: {
            start: () => interval.started++,
            end: () => interval.ended++,
          },
        }),
      ).rejects.toBe(failure);
      expect(interval).toEqual({ started: 1, ended: 1 });
      expect(await samplesLeftInPage()).toEqual([]);
    });

    it("throws when the runtime client is replaced during the operation", async () => {
      try {
        await expect(
          timeTopicsOperation(session.page, {
            label: "replaced client, timed",
            operation: replaceRuntimeClient,
          }),
        ).rejects.toThrow("The runtime client was replaced");
      } finally {
        await restoreRuntimeClient();
      }
      expect(await samplesLeftInPage()).toEqual([]);
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
