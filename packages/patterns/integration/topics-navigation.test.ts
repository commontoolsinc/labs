import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { waitForRuntimeIdle, waitForText } from "./cfc-browser-helpers.ts";
import {
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";
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
    const program = await cc.runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    board = await cc.create(program, { start: true });

    const resultCell = cc.getResult(board.getCell());
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
    await waitForPieceView(page, SPACE_NAME, openedPieceId);

    const otherTitle = openedFid === targetFid ? SOURCE_TITLE : TARGET_TITLE;
    const otherFid = openedFid === targetFid ? sourceFid : targetFid;
    await waitForText(page, "body", otherTitle);

    const crossrefPieceId = await clickCellLink(page, otherTitle);
    assertEquals(crossrefPieceId, `of:${otherFid}`);
    await waitForPieceView(page, SPACE_NAME, crossrefPieceId);

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
    board.pieces(),
    result.key("topics").key(index).resolveAsCell(),
  );
}
