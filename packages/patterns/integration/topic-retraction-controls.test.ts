/**
 * That the browser's retraction controls stamp the records the reader is
 * looking at.
 *
 * The thread and the link list render from a `computed()` that drops stamped
 * records and sorts what is left, and each row's control is bound to an
 * element of that view. Binding it wrongly is a silent failure rather than a
 * loud one: a control that stamped a copy would leave the topic unchanged
 * while the click still looked as though it had worked, so what has to be
 * asserted is the STORED record, not the row leaving the page.
 *
 * The discriminating step is the second click. After the middle comment is
 * retracted the view holds the first and the last, while the stored array
 * still holds all three with the middle one stamped. Clicking the second
 * control again therefore separates two bindings that agree until then: bound
 * to the view it retracts the LAST comment, and bound to the underlying array
 * position it would find the already-stamped middle one and do nothing. A test
 * that only ever retracted the first row could not tell those apart.
 *
 * view-identity.test.tsx pins the model property this stands on — that an
 * element of such a view keeps the identity of the record it came from — and
 * topics-rejections.test.tsx holds the negative half, where a structural copy
 * of a real record is refused. This file is what says the SHIPPED controls are
 * bound to it.
 */
import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickNthCfButton,
  clickTrustedAction,
  fillCfInput,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import { waitForPieceView } from "./topics-navigation-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

const TOPIC_TITLE = "Retraction controls";
const AGENT = "Retraction controls test";
/** The viewer's Profile name, which every browser mutation here snapshots. */
const VIEWER = "Rowan";

const ALPHA = "Alpha survives both retractions";
const BRAVO = "Bravo is retracted first";
const CHARLIE = "Charlie is retracted second";
const LINK_ONE = "https://example.com/retraction-one";
const LINK_TWO = "https://example.com/retraction-two";

/**
 * The controls, addressed by the data hook each row's button carries.
 *
 * A `data-*` prop is the one form that reaches the DOM as an attribute a
 * selector can match: `setPropDefault` in packages/html/src/render-utils.ts
 * sets those as attributes and assigns every other prop as a JS property.
 */
const RETRACT_COMMENT = 'cf-button[data-retract="comment"]';
const RETRACT_LINK = 'cf-button[data-retract="link"]';
/** Pinned by the runner (wish.ts) and the profile-create pattern. */
const TRUSTED_PROFILE_CREATE_ACTION = "CreateProfile";

interface StoredComment {
  body?: string;
  removedAt?: number;
  removedBy?: { name?: string };
}
interface StoredLink {
  url?: string;
  removedAt?: number;
}

const stamped = <T extends { removedAt?: number }>(records: T[]): T[] =>
  records.filter((record) => record.removedAt !== undefined);
const live = <T extends { removedAt?: number }>(records: T[]): T[] =>
  records.filter((record) => record.removedAt === undefined);

describe("Topics retraction controls", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let topic: PieceController;
  // deno-lint-ignore no-explicit-any
  let topicResult: any;
  const sinkCancels: Array<() => void> = [];

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();

    const sourcePath = join(import.meta.dirname!, "..", "topics", "main.tsx");
    const rootPath = join(import.meta.dirname!, "..");
    const program = await resolveLocalProgram(
      (resolver) => cc.runtime.harness.resolve(resolver),
      { main: sourcePath, root: rootPath },
    );
    const board = await cc.create(program, { start: true });
    const boardResult = cc.getResult(board.getCell());
    sinkCancels.push(boardResult.sink(() => {}));

    await board.result.set({ title: TOPIC_TITLE, agentName: AGENT }, [
      "addTopic",
    ]);
    // The topic is reached by its own address, which is where its verbs live:
    // the board demands a projection that carries none of them.
    await waitForCellValue(
      cc.runtime,
      boardResult.key("topics"),
      (topics: Array<{ title?: string } | undefined> | undefined) =>
        Array.isArray(topics) && topics.length === 1 &&
        topics[0]?.title === TOPIC_TITLE,
    );
    const resolved = await board.result.getCell();
    await resolved.pull();
    topic = new PieceController(
      board.pieces(),
      resolved.key("topics").key(0).resolveAsCell(),
    );
    topicResult = cc.getResult(topic.getCell());
    sinkCancels.push(topicResult.sink(() => {}));

    // Filed one at a time, each barriered on its own arrival before the next
    // is sent, so the thread's sort by `sentAt` puts them on the page in the
    // order named above and a row index addresses the row intended.
    //
    // The barrier is the whole point rather than caution. Under server
    // execution a `set()` resolves before the SERVED consequence arrives, so
    // three appends sent back to back can commit in any order and land
    // `sentAt` stamps in that order too — which reorders the rendered thread
    // and silently moves every row this test clicks. Unbarriered, this file
    // passed with server execution off and retracted the wrong comment with
    // it on.
    const comments = topicResult.key("comments");
    const bodies = [ALPHA, BRAVO, CHARLIE];
    for (const [index, body] of bodies.entries()) {
      await topic.result.set({ body, agentName: AGENT }, ["addComment"]);
      await waitForCellValue(
        cc.runtime,
        comments,
        (stored: StoredComment[] | undefined) =>
          (stored ?? []).length === index + 1 &&
          stored![index]?.body === body,
      );
    }

    const links = topicResult.key("links");
    const urls = [LINK_ONE, LINK_TWO];
    for (const [index, url] of urls.entries()) {
      await topic.result.set({ kind: "web", url, agentName: AGENT }, [
        "addLink",
      ]);
      await waitForCellValue(
        cc.runtime,
        links,
        (stored: StoredLink[] | undefined) =>
          (stored ?? []).length === index + 1 && stored![index]?.url === url,
      );
    }

    // Every write reaches the server before a browser asks for the piece; one
    // created but not yet synced is answered with "No data at cell".
    await cc.synced();
  });

  afterAll(async () => {
    for (const cancel of sinkCancels) cancel();
    await cc?.dispose();
  });

  it("retracts the record the reader sees at that row, and stamps rather than removes it", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId: topic.id },
      identity,
    });
    await waitForPieceView(page, SPACE_NAME, topic.id);
    await waitForRuntimeIdle(page);

    // A fresh identity has no Profile, and the controls stay disabled without
    // one: a retraction records who made it, and there is no viewer to name
    // until the wish resolves. The topic renders the wish's own create surface
    // in that state, which is the only path in.
    await fillCfInput(page, "#wish-profile-name-input", VIEWER);
    await clickTrustedAction(page, TRUSTED_PROFILE_CREATE_ACTION);
    await waitForRuntimeIdle(page);

    // The whole thread is on the page before anything is clicked, so a row
    // index addresses the row it is meant to.
    await Promise.all([
      waitForText(page, "body", ALPHA),
      waitForText(page, "body", BRAVO),
      waitForText(page, "body", CHARLIE),
    ]);

    await clickNthCfButton(page, RETRACT_COMMENT, 1);
    const afterFirst = await waitForCellValue<StoredComment[]>(
      cc.runtime,
      topicResult.key("comments"),
      (comments) => stamped(comments ?? []).length === 1,
    );
    assertEquals(stamped(afterFirst).map((c) => c.body), [BRAVO]);
    // The viewer's Profile, not the agent that filed the comment.
    assertEquals(stamped(afterFirst)[0]?.removedBy?.name, VIEWER);

    // The discriminating click. See the header: the view and the stored array
    // disagree about what sits at index 1 from here on.
    await clickNthCfButton(page, RETRACT_COMMENT, 1);
    const afterSecond = await waitForCellValue<StoredComment[]>(
      cc.runtime,
      topicResult.key("comments"),
      (comments) => stamped(comments ?? []).length === 2,
    );
    assertEquals(
      stamped(afterSecond).map((c) => c.body).toSorted(),
      [BRAVO, CHARLIE].toSorted(),
    );
    assertEquals(live(afterSecond).map((c) => c.body), [ALPHA]);
    // Stamped, not removed: membership is what never shrinks, and the board's
    // activity ordering depends on it.
    assertEquals(afterSecond.length, 3);

    await clickNthCfButton(page, RETRACT_LINK, 0);
    const afterLink = await waitForCellValue<StoredLink[]>(
      cc.runtime,
      topicResult.key("links"),
      (links) => stamped(links ?? []).length === 1,
    );
    assertEquals(stamped(afterLink).map((l) => l.url), [LINK_ONE]);
    assertEquals(live(afterLink).map((l) => l.url), [LINK_TWO]);
    assertEquals(afterLink.length, 2);
  });
});
