/**
 * End-to-end navigation of a data-heavy topic board, driven through a real
 * browser against a running toolshed.
 *
 * The micro-benchmarks elsewhere in the repository measure one component at a
 * time. This one measures what a person waits for: a cold page load of a board
 * carrying dozens of topics, signing in, the board's cards appearing, opening a
 * topic, and following a crossref from that topic to a sibling. Each of those
 * is its own benchmark, so the dashboard charts the timeline in parts as well
 * as end to end, and a regression lands on the segment that caused it.
 *
 * Every segment benchmark reaches its starting point outside the measured
 * window: the browser is launched, the board is loaded, and the earlier
 * segments are replayed with the timer stopped. Each iteration therefore
 * measures exactly one segment of a fresh navigation, and the benchmarks do not
 * depend on each other or on the order Deno runs them in.
 *
 * Requirements beyond the other bench files: a toolshed at `API_URL`, a shell at
 * `FRONTEND_URL` (which defaults to `API_URL`, where a compiled toolshed serves
 * one), and a Chrome for Astral to drive. `.github/workflows/benchmarks.yml`
 * provides all three. Locally, start the dev servers and run:
 *
 *     API_URL=http://localhost:8000/ FRONTEND_URL=http://localhost:5173/ \
 *       deno bench -A \
 *       packages/patterns/integration/topic-board-navigation.bench.ts
 *
 * Stdout carries the JSON report and nothing else, so everything this file has
 * to say goes to stderr. The board's size and the iteration count go there at
 * startup, since a run's numbers only mean something alongside them.
 */

import { env } from "@commonfabric/integration";
import type { Identity } from "@commonfabric/identity";
import {
  crossrefTargets,
  seedIdentity,
  seedTopicBoardOutOfProcess,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";

/**
 * The dashboard keys a chart series on this file, the group, and the
 * benchmark's name, so all three stay put. The size of the board is a fourth
 * thing the numbers depend on and the series cannot express: changing it starts
 * the timeline over at a new scale, as renaming a benchmark would.
 */
const GROUP = "topic board";

const DEFAULT_TOPIC_COUNT = 30;

/**
 * Size of the seeded board. CI leaves this alone, so its series all describe
 * the same board; set `CF_TOPIC_BOARD_TOPICS` locally to see how a segment
 * scales with the amount of data. Whichever value is in force is written to
 * stderr below, and so into the run's diagnostics.
 */
const TOPIC_COUNT = (() => {
  const raw = Deno.env.get("CF_TOPIC_BOARD_TOPICS");
  if (raw === undefined) return DEFAULT_TOPIC_COUNT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`CF_TOPIC_BOARD_TOPICS must be a positive integer: ${raw}`);
  }
  return parsed;
})();

/**
 * Measured iterations per segment, plus one unmeasured warm-up. A browser
 * navigation costs seconds, and every iteration of a later segment replays the
 * earlier ones to reach its starting point, so this stays small.
 */
const ITERATIONS = 5;
const WARMUP = 1;

const PASSPHRASE = "topic board navigation benchmark";

/** Which of a topic's citations the crossref segment follows. */
const CROSSREF_INDEX = 0;

const note = (message: string): void => {
  // Module-scope diagnostics reach the workflow's stderr copy directly. Bench
  // bodies do not: the JSON reporter captures their console output, so a body
  // writes to `Deno.stderr` itself.
  console.error(`[topic-board-navigation] ${message}`);
};

const seedingStartedAt = performance.now();
note(
  `seeding ${TOPIC_COUNT} topics into space ${env.SPACE_NAME} at ${env.API_URL}`,
);
const fixture: TopicBoardFixture = await seedTopicBoardOutOfProcess({
  apiUrl: new URL(env.API_URL),
  spaceName: env.SPACE_NAME,
  passphrase: PASSPHRASE,
  topicCount: TOPIC_COUNT,
});
const identity: Identity = await seedIdentity(PASSPHRASE);
note(
  `seeded board ${fixture.boardId} in ${
    Math.round(performance.now() - seedingStartedAt)
  }ms; ${ITERATIONS} iterations per segment after ${WARMUP} warm-up`,
);

/** Index of the topic `pieceId` addresses, by the fid the fixture recorded. */
function topicIndexOf(pieceId: string): number {
  const fid = pieceId.replace(/^of:/, "");
  const index = fixture.topics.findIndex((topic) => topic.fid === fid);
  if (index < 0) {
    throw new Error(`Opened piece ${pieceId} is not a seeded topic.`);
  }
  return index;
}

/**
 * Title of the sibling the topic at `index` cites, which is both the label of
 * the crossref link on its page and the heading of the page that link leads to.
 */
function citedTitle(index: number): string {
  const target = crossrefTargets(index, { topicCount: TOPIC_COUNT })
    .at(CROSSREF_INDEX);
  if (target === undefined) {
    throw new Error(`Topic ${index} cites nothing to navigate to.`);
  }
  return topicTitle(target);
}

/**
 * The text an opened topic's page has to show before it counts as complete:
 * the topic's own title, and the connection it cites.
 */
function expectedOnTopicPage(openedPieceId: string): readonly string[] {
  const index = topicIndexOf(openedPieceId);
  return [topicTitle(index), citedTitle(index)];
}

/**
 * Run `measure` against a navigation that `reach` has already brought to the
 * segment's starting point. Only `measure` is timed.
 */
function segment<Reached>(
  name: string,
  reach: (navigation: BoardSession) => Promise<Reached>,
  measure: (
    navigation: BoardSession,
    reached: Reached,
  ) => Promise<void>,
): void {
  Deno.bench({
    name,
    group: GROUP,
    n: ITERATIONS,
    warmup: WARMUP,
  }, async (b) => {
    const navigation = await BoardSession.open({ fixture, identity });
    try {
      const reached = await reach(navigation);
      b.start();
      await measure(navigation, reached);
      b.end();
    } finally {
      await navigation.close();
    }
  });
}

segment(
  "load",
  () => Promise.resolve(),
  (navigation) => navigation.load(),
);

segment(
  "sign in",
  (navigation) => navigation.load(),
  (navigation) => navigation.signIn(),
);

segment(
  "board",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
  },
  (navigation) => navigation.showBoard(),
);

segment(
  "open topic",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
  },
  async (navigation) => {
    await navigation.openTopic(expectedOnTopicPage);
  },
);

segment(
  "crossref",
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
    return await navigation.openTopic(expectedOnTopicPage);
  },
  (navigation, opened) =>
    navigation.followCrossref(citedTitle(topicIndexOf(opened))),
);

segment(
  "journey",
  () => Promise.resolve(),
  async (navigation) => {
    await navigation.load();
    await navigation.signIn();
    await navigation.showBoard();
    const opened = await navigation.openTopic(expectedOnTopicPage);
    await navigation.followCrossref(citedTitle(topicIndexOf(opened)));
  },
);
