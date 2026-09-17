/**
 * The four actions of the Topics demo, as one continuous journey: the board
 * listing its topics, a topic opened from its own card, a backlink followed to
 * the topic that cites it, and a comment added that the thread then shows.
 *
 *     deno task demo patterns topic-board-demo
 *
 * records it. `deno task integration patterns topic-board-demo` runs the same
 * file without a recording, which is what CI does.
 *
 * ## What this holds a candidate to
 *
 * The demo exists so a change to how Topics computes can be shown working
 * before and after, which only means something if the two runs are comparable.
 * So the board comes from `seedTopicBoard` in a space of the demo's own rather
 * than from whatever a space happens to hold, and every title and citation is
 * derived from the fixture rather than written down here.
 *
 * A candidate may change, without invalidating the comparison: how the board
 * produces its crossref pivot and where that production is shared; which
 * per-topic derivations are reused; what a view demands; what is cached and
 * what is computed lazily; how often a lift runs; how long any of it takes;
 * and the order the board lists its cards in. None of those is asserted here.
 * The card is addressed by its title through `clickCardOpenLink` precisely so
 * that the ordering is not asserted by accident.
 *
 * A candidate may not change, and this fails if it does: the board lists each
 * topic the fixture seeded; the Open link on a card addresses the topic that
 * card describes; a cited topic names the topic citing it, by an identity the
 * shell can select; and a comment sent through the composer is stored with its
 * author and shown. The middle two are each checked on the one card and the one
 * citation this journey passes through, which is what a journey can check.
 *
 * Two counts are left unasserted on purpose, and neither is a weakening. The
 * board's topic count would additionally say that nothing else is listed, which
 * this does not need: the space holds the demo's board alone. The thread's
 * comment count is avoided because `topic-retraction-controls.test.ts` records
 * that a topic's first `addComment` can commit twice under server execution
 * (#6808), so a count would fail for a reason that is not the regression this
 * demo is for.
 */

import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import {
  clickTrustedAction,
  fillCfInput,
  fillCfTextarea,
  logStepTimings,
  StepTimer,
  waitForRuntimeIdle,
  waitForSettledText,
} from "./cfc-browser-helpers.ts";
import { clickButtonWithExactText } from "./note-button-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  crossrefTargets,
  seedIdentity,
  seedTopicBoard,
  topicAt,
  type TopicBoardFixture,
  topicTitle,
} from "./topic-board-fixture.ts";
import {
  clickCardOpenLink,
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

/**
 * Topics on the demo's board. Small by default, because CI pays this on every
 * pull request and seeding cost grows faster than the topic count
 * (`docs/development/BENCHMARKS.md`, "The board scaling benchmark"). An
 * investigation that wants a fuller board asks for one.
 */
const SIZE = Number(Deno.env.get("CF_TOPICS_DEMO_TOPICS") ?? "5");
if (!Number.isInteger(SIZE) || SIZE < 2) {
  throw new Error(
    `CF_TOPICS_DEMO_TOPICS must be an integer of at least 2: ${SIZE}`,
  );
}

/**
 * One citing topic, citing one earlier one. The board then carries exactly one
 * crossref edge, so the topic the demo opens has exactly one backlink and the
 * viewer has one thing to follow.
 */
const CROSSREF_SHAPE = {
  topicCount: SIZE,
  crossrefsPerTopic: 1,
  citingTopics: 1,
};

/** The topic that cites, and the one it cites, by the fixture's own rule. */
const CITING = SIZE - 1;
const CITATIONS = crossrefTargets(CITING, CROSSREF_SHAPE);
if (CITATIONS.length !== 1) {
  throw new Error(
    `A ${SIZE}-topic board shaped this way should place one citation on topic ` +
      `${CITING}, not ${CITATIONS.length}`,
  );
}
const CITED = CITATIONS[0];

/** The Profile the viewer acts under. Every mutation below snapshots it. */
const VIEWER = "Robin";
const COMMENT = "Followed the backlink here from the topic this one cites.";

/**
 * The thread's composer. `packages/patterns/topics/topic.tsx` authors exactly
 * one `cf-textarea`, the Thread card's, so its element type names it without
 * reaching for the structure around it.
 */
const COMMENT_DRAFT = "cf-textarea";

/** Pinned by the runner (wish.ts) and the profile-create pattern. */
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

/** A rendered link carries `of:fid1:…`; a fixture records the bare `fid1:…`. */
const fidOf = (id: string): string => id.replace(/^of:/, "");

interface StoredComment {
  body?: string;
  author?: { name?: string };
}

describe("Topics board demo", () => {
  const shell = new ShellIntegration({
    presentation: { label: "Topics", color: "#2563eb" },
  });
  shell.bindLifecycle();

  let identity: Identity;
  let fixture: TopicBoardFixture;
  let reader: PiecesController;
  let citingTopic: PieceController;

  beforeAll(async () => {
    // A space of the demo's own, so the board it opens is the board it seeded
    // and nothing else a shard put in the shared space.
    const spaceName = `${SPACE_NAME}-topic-board-demo`;
    identity = await seedIdentity(`topic board demo ${crypto.randomUUID()}`);
    fixture = await seedTopicBoard({
      apiUrl: new URL(API_URL),
      spaceName,
      identity,
      topicCount: SIZE,
      crossrefsPerTopic: CROSSREF_SHAPE.crossrefsPerTopic,
      citingTopics: CROSSREF_SHAPE.citingTopics,
    });

    // A second observer of the same space, for the durability half of the
    // comment assertion. It is opened after the seed's own controller has been
    // disposed, and it holds no standing subscription: `waitForCellValue`
    // installs a sink on the one key it watches and drops it again. So the
    // browser is what demands the board, in this run as in a candidate's.
    reader = await initializePiecesController({
      space: spaceName,
      apiUrl: new URL(API_URL),
      identity,
    });
    const board = await reader.get(fixture.boardId, false);
    citingTopic = await topicAt(board, CITING);
  });

  afterAll(async () => {
    await reader?.dispose();
  });

  it("opens a topic from its card, follows its backlink, and adds a comment the thread shows", async () => {
    const timeline = new StepTimer();
    const page = shell.page();

    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: fixture.spaceName, pieceId: fixture.boardId },
      identity,
    });
    await waitForPieceView(page, fixture.spaceName, fixture.boardId);
    await waitForRuntimeIdle(page);

    // Not one of the four. A fresh identity has no Profile, and the thread's
    // composer stays disabled without one, because a comment records who sent
    // it. The board renders the wish's own create surface in that state.
    await timeline.run("Robin arrives at the board", async () => {
      await fillCfInput(page, "#wish-profile-name-input", VIEWER);
      await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
      await waitForRuntimeIdle(page);
      await waitForSettledText(page, "body", VIEWER);
    });

    await timeline.run("The board lists its topics", async () => {
      // Every title, one at a time. `waitForSettledText` drives the page while
      // it waits, which `waitForText` does not, and an integration test holds
      // no subscription of its own to move it. Each returns as soon as its
      // title is there, so the cost of the ones already rendered is a check.
      for (let index = 0; index < SIZE; index++) {
        await waitForSettledText(page, "body", topicTitle(index));
      }
    });

    const opened = await timeline.run(
      `Opening the topic titled ${topicTitle(CITED)}`,
      () => clickCardOpenLink(page, topicTitle(CITED)),
    );
    // The card said which topic it describes; the link it carries has to
    // address that same topic. A pivot rebuilt around a copy of a topic rather
    // than the topic itself is what this catches.
    expect(fidOf(opened)).toBe(fixture.topics[CITED].fid);
    await waitForPieceView(page, fixture.spaceName, opened);
    await waitForSettledText(page, "body", topicTitle(CITED));

    const followed = await timeline.run(
      "Following the backlink to the topic that cites this one",
      async () => {
        // The backlink card is the only thing on this page that names the
        // citing topic — this topic cites nothing itself — so waiting for the
        // card's own heading first is what makes the click below a click on a
        // backlink rather than on whatever else resolved to that name.
        await waitForSettledText(page, "body", "Referenced by");
        return await clickCellLink(page, topicTitle(CITING));
      },
    );
    expect(fidOf(followed)).toBe(fixture.topics[CITING].fid);
    await waitForPieceView(page, fixture.spaceName, followed);
    await waitForSettledText(page, "body", topicTitle(CITING));

    await timeline.run("Adding a comment to the thread", async () => {
      await fillCfTextarea(page, COMMENT_DRAFT, COMMENT);
      await clickButtonWithExactText(page, "Send");
      await waitForSettledText(page, "body", COMMENT);
    });

    // Shown is half of it; the other half is that it reached the store, read
    // by an observer that is not the browser that sent it. The stuck label is
    // this process's only way to say what a wait was waiting for: it holds a
    // browser and a live connection open, so it never goes quiet on its own.
    const thread = await waitForCellValue<StoredComment[]>(
      reader.runtime,
      (await citingTopic.result.getCell()).key("comments"),
      (comments) =>
        (comments ?? []).some((comment) => comment.body === COMMENT),
      { stuckLabel: `the demo's comment on ${topicTitle(CITING)}` },
    );
    const authors = thread
      .filter((comment) => comment.body === COMMENT)
      .map((comment) => comment.author?.name);
    // Stated before the `every` below, which an empty array satisfies: without
    // this line a thread that stored nothing would pass.
    expect(authors.length).toBeGreaterThan(0);
    // The viewer's Profile, not the agent that seeded the board.
    expect(authors.every((name) => name === VIEWER)).toBe(true);

    logStepTimings("topic-board-demo", timeline);
  });
});
