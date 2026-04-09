import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc staged publish integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: Awaited<ReturnType<PiecesController["create"]>>;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-staged-publish",
      "main.tsx",
    );
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath),
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("drives save, review, and publish through trusted UI actions", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    const inputs = await waitForCount(page, "[data-cf-input]", 2);
    await inputs[0].type("Launch checklist");
    await inputs[1].type("Ship the staged publish demo with trusted UI gates.");

    await clickButtonAtIndex(page, 0);
    await waitForStage(page, "saved");
    await waitForText(page, "#saved-title", "Launch checklist");

    await clickButtonAtIndex(page, 1);
    await waitForStage(page, "reviewed");
    await waitForText(page, "#reviewed-title", "Launch checklist");

    await clickButtonAtIndex(page, 2);
    await waitForStage(page, "published");
    await waitForText(page, "#published-title", "Launch checklist");
    await waitFor(async () =>
      (await piece.result.get(["publishedBody"])) ===
        "Ship the staged publish demo with trusted UI gates."
    );
  });
});

async function waitForStage(page: Page, stage: string) {
  await waitFor(async () => {
    try {
      const stageNode = await page.waitForSelector("#stage-pill", {
        strategy: "pierce",
      });
      return (await stageNode.innerText())?.trim() === stage;
    } catch {
      return false;
    }
  });
}

async function waitForText(page: Page, selector: string, text: string) {
  await waitFor(async () => {
    try {
      const node = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      return (await node.innerText())?.trim() === text;
    } catch {
      return false;
    }
  });
}

async function waitForCount(page: Page, selector: string, count: number) {
  await waitFor(async () => {
    const nodes = await page.$$(selector, { strategy: "pierce" });
    return nodes.length >= count;
  });
  return await page.$$(selector, { strategy: "pierce" });
}

async function clickButtonAtIndex(page: Page, index: number) {
  await waitFor(async () => {
    const buttons = await page.$$("[data-cf-button]", { strategy: "pierce" });
    if (buttons.length <= index) return false;
    try {
      await buttons[index].click();
      return true;
    } catch {
      return false;
    }
  });
}
