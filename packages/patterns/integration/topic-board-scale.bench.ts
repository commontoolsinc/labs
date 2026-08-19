/**
 * How the cost of showing a board grows with the number of topics on it.
 *
 * `topic-board-navigation.bench.ts` measures one board of one size, which
 * catches a regression but says nothing about shape: a change that is flat at
 * thirty topics and quadratic at three hundred looks the same there. This file
 * measures the same thing — a signed-in cold load, timed until every card has
 * rendered — across several board sizes, so the shape of the curve is a thing
 * the dashboard charts rather than a thing somebody has to go and measure.
 *
 * The boards carry no crossrefs. Citations are what the board can least afford
 * (see `DEFAULT_CITING_TOPICS` in `topic-board-fixture.ts`), and a scaling
 * measurement wants the cost of the list itself, not of the join over it.
 *
 * Requirements and stdout discipline are the same as the navigation benchmark:
 * a toolshed at `API_URL`, a shell at `FRONTEND_URL`, a Chrome for Astral, and
 * nothing but the JSON report on stdout.
 */

import { env } from "@commonfabric/integration";
import {
  seedIdentity,
  seedTopicBoardOutOfProcess,
  type TopicBoardFixture,
} from "./topic-board-fixture.ts";
import { BoardSession } from "./topic-board-session.ts";

const GROUP = "topic board scale";

/** Board sizes the curve is sampled at. */
const SIZES = [100, 1000, 10000];

/**
 * The largest board that can be built today.
 *
 * Seeding cost grows faster than the topic count, because the board recomputes
 * its whole crossref join and index on every write and each topic holds the
 * board's own list: on an Apple M3 Max, thirty topics take 33 seconds and
 * 0.95GB of peak resident memory, sixty take 143 seconds and 1.6GB, and a
 * hundred take 274 seconds and 2.6GB.
 *
 * Memory is what binds rather than time. It is close to linear at roughly 26MB
 * per topic, so a thousand needs on the order of 26GB — more than a runner has
 * — while time extrapolates to several hours. Ten thousand is out of reach on
 * both counts. Neither limit belongs to this benchmark, and neither is caused
 * by crossrefs: these boards carry none, creating the same topic pieces without
 * a board is linear and flat in memory, and attaching them to one in a single
 * write is refused by the board's element schema.
 *
 * `docs/development/BENCHMARKS.md` carries the same figures; move both together.
 *
 * The larger sizes are declared and skipped rather than left out, so the curve
 * they belong to is written down and turning them on is one edit. Raise this
 * with `CF_TOPIC_BOARD_SCALE_LIMIT` to run them once a board can be built at
 * that size.
 */
const DEFAULT_SCALE_LIMIT = 100;

const SCALE_LIMIT = (() => {
  const raw = Deno.env.get("CF_TOPIC_BOARD_SCALE_LIMIT");
  if (raw === undefined) return DEFAULT_SCALE_LIMIT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(
      `CF_TOPIC_BOARD_SCALE_LIMIT must be a positive integer: ${raw}`,
    );
  }
  return parsed;
})();

/**
 * Measured iterations per size, plus one unmeasured warm-up. Lower than the
 * navigation benchmark's: each iteration loads a board an order of magnitude
 * larger, and the seed in front of it already dominates the run.
 */
const ITERATIONS = 3;
const WARMUP = 1;

const PASSPHRASE = "topic board scale benchmark";

const encoder = new TextEncoder();

const note = (message: string): void => {
  // Boards are seeded inside a bench body, where the JSON reporter captures
  // console output. Writing to the stream is what reaches the workflow's copy
  // of stderr, and so `diagnostics.log`.
  Deno.stderr.writeSync(encoder.encode(`[topic-board-scale] ${message}\n`));
};

note(
  `sizes ${
    SIZES.join(", ")
  }; building up to ${SCALE_LIMIT} topics at ${env.API_URL}`,
);

/**
 * Boards are seeded on first use rather than at module scope, so a size that
 * is skipped costs nothing and a size that runs is seeded once for all of its
 * iterations.
 */
const boards = new Map<number, Promise<TopicBoardFixture>>();

function board(topicCount: number): Promise<TopicBoardFixture> {
  let seeding = boards.get(topicCount);
  if (!seeding) {
    const startedAt = performance.now();
    seeding = seedTopicBoardOutOfProcess({
      apiUrl: new URL(env.API_URL),
      // One space per size, so each board holds only its own topics.
      spaceName: `${env.SPACE_NAME}-${topicCount}`,
      passphrase: PASSPHRASE,
      topicCount,
      citingTopics: 0,
    }).then((fixture) => {
      note(
        `seeded ${topicCount} topics in ${
          Math.round(performance.now() - startedAt)
        }ms`,
      );
      return fixture;
    });
    boards.set(topicCount, seeding);
  }
  return seeding;
}

for (const topicCount of SIZES) {
  Deno.bench({
    // Bare sizes: the group already says these are topic boards, and the
    // dashboard has little room for a series label.
    name: `${topicCount}`,
    group: GROUP,
    n: ITERATIONS,
    warmup: WARMUP,
    ignore: topicCount > SCALE_LIMIT,
  }, async (b) => {
    const session = await BoardSession.open({
      fixture: await board(topicCount),
      identity: await seedIdentity(PASSPHRASE),
    });
    try {
      await session.load();
      await session.signIn();
      b.start();
      await session.showBoard();
      b.end();
    } finally {
      await session.close();
    }
  });
}
