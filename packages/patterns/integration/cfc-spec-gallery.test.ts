import { env, Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc spec gallery integration test", () => {
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
      "cfc-spec-gallery",
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

  it("drives the trusted forward, command, and safe-link surfaces", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    await clickTrustedAction(page, "TrustedPrepareForward");
    await waitForText(page, "#trusted-forward-prepared", "Prepared for");
    await waitForText(page, "#forward-stage", "prepared");
    await clickTrustedAction(page, "TrustedForwardNote");
    await waitForText(
      page,
      "#trusted-forward-result",
      "Only the bounded itinerary excerpt will be forwarded.",
    );
    await waitForText(page, "#forward-stage", "forwarded");

    await clickTrustedAction(page, "TrustedCaptureDirectCommand");
    await waitForText(page, "#research-stage", "captured");
    await clickTrustedAction(page, "TrustedPrepareResearchBrief");
    await waitForText(page, "#trusted-command-prepared", "Prepared outbound");
    await waitForText(page, "#research-stage", "prepared");
    await clickTrustedAction(page, "TrustedAuthorizeResearchSend");
    await waitForText(
      page,
      "#trusted-command-result",
      "Authorized outbound message",
    );
    await waitForText(page, "#research-stage", "sent");

    await clickTrustedAction(page, "TrustedPrepareSafeLink");
    await waitForText(page, "#trusted-safe-link-prepared", "?view=summary");
    await waitForText(page, "#safe-link-stage", "prepared");
    await clickTrustedAction(page, "TrustedReleaseSafeLink");
    await waitForText(
      page,
      "#trusted-safe-link-result",
      "?view=summary",
    );
    await waitForText(page, "#safe-link-stage", "released");
  });
});

async function clickTrustedAction(page: Page, action: string) {
  const button = await page.waitForSelector(`[data-ui-action="${action}"]`, {
    strategy: "pierce",
  });
  await button.click();
}

async function waitForText(page: Page, selector: string, text: string) {
  await waitFor(async () => {
    try {
      const node = await page.waitForSelector(selector, {
        strategy: "pierce",
      });
      return (await node.innerText())?.includes(text) === true;
    } catch {
      return false;
    }
  });
}
