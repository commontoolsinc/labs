import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc authorized save integration test", () => {
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
      "cfc-authorized-save",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    piece = await cc.create(program, { start: true });

    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("accepts the trusted surface and rejects a lookalike host button", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    const input = await page.waitForSelector("[data-cf-input]", {
      strategy: "pierce",
    });
    await input.type("Saved from UI");

    const legacyButton = await page.waitForSelector("#legacy-save-button", {
      strategy: "pierce",
    });
    await legacyButton.click();

    await new Promise((resolve) => setTimeout(resolve, 300));
    const savedTitleBeforeTrustedClick = await page.waitForSelector(
      "#saved-title",
      { strategy: "pierce" },
    );
    assertEquals((await savedTitleBeforeTrustedClick.innerText())?.trim(), "");

    const trustedButton = await page.waitForSelector(
      '[data-ui-action="TrustedSaveTitle"]',
      {
        strategy: "pierce",
      },
    );
    await trustedButton.click();

    await waitForSavedTitle(page, "Saved from UI");
  });
});

async function waitForSavedTitle(page: Page, text: string) {
  await waitFor(async () => {
    try {
      const savedTitle = await page.waitForSelector("#saved-title", {
        strategy: "pierce",
      });
      return (await savedTitle.innerText())?.trim() === text;
    } catch (_) {
      return false;
    }
  });
}
