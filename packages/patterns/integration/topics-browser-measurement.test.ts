import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { env } from "@commonfabric/integration";

import {
  seedIdentity,
  seedTopicBoard,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";
import {
  formatTopicsSample,
  liftFunctionPosition,
  measureTopicsReads,
  timeTopicsOperation,
  TOPICS_LIFTS,
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

  /**
   * Opens the topmost topic, waits for both topics' titles on its page, and
   * returns to the board through the shell's own navigation, so one runtime
   * serves the whole sequence.
   */
  async function openTopicAndReturn(): Promise<void> {
    await session.openTopic((pieceId) => {
      const index = fixture.topics.findIndex((topic) =>
        topic.fid === pieceId.replace(/^of:/, "")
      );
      return [topicTitle(index), topicTitle(1 - index)];
    });
    await session.page.evaluate(
      async (spaceName: string, pieceId: string) => {
        await globalThis.app.setView({ spaceName, pieceId });
      },
      { args: [fixture.spaceName, fixture.boardId] },
    );
    await waitForPieceView(session.page, fixture.spaceName, fixture.boardId);
    await session.showBoard();
  }

  describe("liftFunctionPosition()", () => {
    const source = [
      'import { lift } from "commonfabric";',
      "",
      "const doubled = lift(",
      "  (value: number) => value * 2,",
      ");",
    ].join("\n");

    it("returns the line and column where the lift's function starts", () => {
      expect(liftFunctionPosition(source, "doubled")).toEqual({
        line: 4,
        col: 2,
      });
    });

    it("returns a later line for the same lift once lines are added above it", () => {
      expect(liftFunctionPosition(`// one\n// two\n\n${source}`, "doubled"))
        .toEqual({ line: 7, col: 2 });
    });

    it("returns the position after a comment between the call and the function", () => {
      const text = "const doubled = lift( /* note */ (value: number) => 2);";
      expect(liftFunctionPosition(text, "doubled")).toEqual({
        line: 1,
        col: 33,
      });
    });

    it("throws for a binding that is not declared as a lift", () => {
      expect(() =>
        liftFunctionPosition(
          "const doubled = computed(() => 2);",
          "doubled",
          "fixture.tsx",
        )
      ).toThrow("`const doubled = lift(...)` declaration in fixture.tsx");
    });

    it("throws for a lift declared twice", () => {
      expect(() => liftFunctionPosition(`${source}\n${source}`, "doubled"))
        .toThrow("found 2");
    });
  });

  describe("measureTopicsReads()", () => {
    it("returns at least one run of each named lift over opening a topic and returning to the board", async () => {
      const sample = await measureTopicsReads(session.page, {
        label: "open topic and return",
        operation: openTopicAndReturn,
      });
      console.error(formatTopicsSample(sample).join("\n"));

      expect(sample.lifts.map((lift) => lift.name)).toEqual(
        TOPICS_LIFTS.map((lift) => lift.name),
      );
      expect(
        sample.lifts.filter((lift) => lift.runs === 0).map((lift) => lift.name),
      ).toEqual([]);
      expect(sample.graph.before.nodes).toBeGreaterThan(0);
      expect(sample.graph.before.edges).toBeGreaterThan(0);
      expect(sample.graph.after.nodes).toBeGreaterThan(0);
      expect(sample.graph.after.edges).toBeGreaterThan(0);
    });

    it("throws for an operation that demands nothing", async () => {
      await expect(
        measureTopicsReads(session.page, {
          label: "undemanded",
          operation: () => Promise.resolve(),
        }),
      ).rejects.toThrow("undemanded: the measured operation produced no runs");
    });
  });

  describe("timeTopicsOperation()", () => {
    it("returns elapsed time and graph size with read accounting off", async () => {
      const sample = await timeTopicsOperation(session.page, {
        label: "open topic and return, timed",
        operation: openTopicAndReturn,
      });
      console.error(formatTopicsSample(sample).join("\n"));

      expect(sample.readAccounting).toBe(false);
      expect(sample.elapsedMs).toBeGreaterThan(0);
      expect(sample.graph.after.nodes).toBeGreaterThan(0);
    });
  });
});
