import { Identity } from "@commonfabric/identity";
import { env, type Page, waitForCondition } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  CLICK_TARGET_ATTR,
  clickMarked,
  settleView,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const TARGET_TITLE = "Navigation target";
const SOURCE_TITLE = "Crossref source";

describe("Topics durable navigation", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let board: PieceController;
  let boardSinkCancel: (() => void) | undefined;
  let targetFid: string;
  let sourceFid: string;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();

    const sourcePath = join(import.meta.dirname!, "..", "topics", "main.tsx");
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    board = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(board.getCell());
    boardSinkCancel = resultCell.sink(() => {});

    await board.result.set(
      { title: TARGET_TITLE, agentName: "Topics navigation test" },
      ["addTopic"],
    );
    const target = await topicAt(board, 0);
    targetFid = target.id;

    await board.result.set(
      {
        title: SOURCE_TITLE,
        body: `This topic references ${targetFid}.`,
        agentName: "Topics navigation test",
      },
      ["addTopic"],
    );
    const sourceReference = await topicAt(board, 1);
    sourceFid = sourceReference.id;
  });

  afterAll(async () => {
    boardSinkCancel?.();
    await cc?.dispose();
  });

  it("opens topics and crossrefs after a cold browser load without scheduler handlers", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId: board.id },
      identity,
    });
    await waitForRuntimeIdle(page);
    await Promise.all([
      waitForText(page, "body", TARGET_TITLE),
      waitForText(page, "body", SOURCE_TITLE),
    ]);

    // The browser worker has never run this board before. This is the exact
    // cold-load boundary where pattern-owned click streams used to be present
    // in persisted VDOM without a registered handler.
    const openedPieceId = await clickCellLink(page, "Open");
    const openedFid = openedPieceId.replace(/^of:/, "");
    await waitForTopicView(page, openedPieceId);

    const otherTitle = openedFid === targetFid ? SOURCE_TITLE : TARGET_TITLE;
    const otherFid = openedFid === targetFid ? sourceFid : targetFid;
    await waitForText(page, "body", otherTitle);

    const crossrefPieceId = await clickCellLink(page, otherTitle);
    assertEquals(crossrefPieceId, `of:${otherFid}`);
    await waitForTopicView(page, crossrefPieceId);

    const droppedEvents = await page.evaluate(() =>
      ((globalThis as typeof globalThis & {
        __cfConsoleTail?: Array<{ method: string; text: string }>;
      }).__cfConsoleTail ?? []).filter((entry) =>
        entry.text.includes("scheduler Event dropped: no handler registered")
      )
    );
    assertEquals(droppedEvents, []);
  });
});

async function topicAt(
  board: PieceController,
  index: number,
): Promise<PieceController> {
  const result = await board.result.getCell();
  await result.pull();
  return new PieceController(
    board.manager(),
    result.key("topics").key(index).resolveAsCell(),
  );
}

/**
 * Wait for a resolved cf-cell-link, mark its native button, then issue one
 * trusted browser click. Returning the link's fid lets the test assert the
 * shell selected exactly the destination represented by the rendered data.
 *
 * Settle the view before marking, the same ordering `clickCfButton` uses. A
 * cold-loaded detail page keeps reflowing as content above the crossref links
 * settles (the topic body's markdown fills in, the links form and Connections
 * card render), so the link's layout box moves for a few frames after it first
 * becomes rendered and resolvable. A trusted click resolves the button's box
 * and then dispatches the mouse events; if the box moved in between, the click
 * lands on the shifted-away layout instead of the button, no navigation fires,
 * and the following `waitForTopicView` waits out its full safety net. Settling
 * first drains the pipeline that carries a change from the worker through an
 * applied vdom batch to a finished Lit update, so the target is stationary when
 * it is clicked.
 */
async function clickCellLink(page: Page, label: string): Promise<string> {
  await settleView(page);
  const token = `topics-cell-link-${crypto.randomUUID()}`;
  await waitForCondition(
    page,
    (
      probe,
      targetLabel: string,
      targetToken: string,
      clickTargetAttribute: string,
    ) => {
      for (const element of probe.collect("cf-cell-link")) {
        const link = element as HTMLElement & {
          label?: string;
          link?: string;
          _resolvedCell?: unknown;
        };
        if (
          link.label !== targetLabel || !link.link || !link._resolvedCell
        ) {
          continue;
        }
        const chip = link.shadowRoot?.querySelector("cf-chip");
        const button = chip?.shadowRoot?.querySelector("button");
        if (!button || !probe.isRendered(button)) continue;
        link.setAttribute("data-topics-link-target", targetToken);
        button.setAttribute(clickTargetAttribute, targetToken);
        return true;
      }
      return false;
    },
    { args: [label, token, CLICK_TARGET_ATTR] },
  );

  const target = await page.evaluate((targetToken: string) => {
    const stack: (Document | ShadowRoot)[] = [document];
    while (stack.length > 0) {
      const root = stack.pop()!;
      const found = root.querySelector(
        `[data-topics-link-target="${targetToken}"]`,
      ) as (HTMLElement & { link?: string }) | null;
      if (found?.link) return found.link;
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot) stack.push(element.shadowRoot);
      }
    }
    return undefined;
  }, { args: [token] });
  if (!target?.startsWith("/of:")) {
    throw new Error(`Topics link "${label}" had invalid target: ${target}`);
  }

  await clickMarked(page, token);
  return target.slice(1);
}

async function waitForTopicView(page: Page, pieceId: string): Promise<void> {
  await waitForCondition(
    page,
    (_probe, expectedSpaceName: string, expectedPieceId: string) => {
      const state = globalThis.app?.serialize() as
        | { view?: { spaceName?: string; pieceId?: string } }
        | undefined;
      return state?.view?.spaceName === expectedSpaceName &&
        state.view.pieceId === expectedPieceId;
    },
    { args: [SPACE_NAME, pieceId] },
  );
}
