import { env, Page, waitFor } from "@commonfabric/integration";
import { createSession, Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PieceManager } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assertEquals, assertRejects } from "@std/assert";
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
    const session = await createSession({ identity, spaceName: SPACE_NAME });
    const runtime = new Runtime({
      apiUrl: new URL(API_URL),
      storageManager: StorageManager.open({
        as: session.as,
        address: new URL("/api/storage/memory", API_URL),
        spaceIdentity: session.spaceIdentity,
      }),
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: `patterns-integration:${session.as.did()}`,
        actingPrincipal: session.as.did(),
      }),
    });
    const manager = new PieceManager(session, runtime);
    await manager.synced();
    cc = new PiecesController(manager);

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

  it("rejects direct writes to the protected field", async () => {
    await assertRejects(
      () => piece.result.set("tampered", ["savedTitle"]),
      Error,
      "writeAuthorizedBy",
    );
    assertEquals(await piece.result.get(["savedTitle"]), "");
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
