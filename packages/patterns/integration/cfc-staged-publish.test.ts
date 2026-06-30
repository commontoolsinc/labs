import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
import {
  clickTrustedActionAndWaitForText,
  fillCfInput,
  waitForText,
} from "./cfc-browser-helpers.ts";

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
    cc = await initializePiecesController({
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

    await fillCfInput(
      page,
      "#trusted-save-draft-title-input",
      "Launch checklist",
    );
    await fillCfInput(
      page,
      "#trusted-save-draft-body-input",
      "Ship the staged publish demo with trusted UI gates.",
    );

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedSaveDraft",
      "#saved-title",
      "Launch checklist",
    );
    await waitForText(page, "#stage-pill", "saved");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedReviewSnapshot",
      "#reviewed-title",
      "Launch checklist",
    );
    await waitForText(page, "#stage-pill", "reviewed");

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedPublishSnapshot",
      "#published-title",
      "Launch checklist",
    );
    await waitForText(page, "#stage-pill", "published");
    await waitForText(
      page,
      "#published-body",
      "Ship the staged publish demo with trusted UI gates.",
    );
  });
});
