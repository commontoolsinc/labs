import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
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

  it("updates the protected field through a trusted UI click", async () => {
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

    const button = await page.waitForSelector("[data-cf-button]", {
      strategy: "pierce",
    });
    await button.click();

    await waitForSavedTitle(page, "Saved from UI");
    await waitFor(async () =>
      (await piece.result.get(["savedTitle"])) === "Saved from UI"
    );
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
