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
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc render policy demo integration test", () => {
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
      "cfc-render-policy-demo",
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

  it("blocks raw confidential content and reveals it through the trusted surface", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });
    await waitForRuntimeIdle(page);

    await waitForText(page, "#raw-health-attempt", "Content hidden by policy");
    await waitForText(
      page,
      "#trusted-health-surface",
      "Content hidden by policy",
    );
    await waitForTextAbsent(
      page,
      "#raw-health-attempt",
      "Sensitive health data:",
    );

    await clickTrustedActionAndWaitForText(
      page,
      "TrustedRevealHealthData",
      "#trusted-health-visible",
      "Sensitive health data: migraine treatment plan",
      { timeout: 45_000 },
    );
    await waitForTextAbsent(
      page,
      "#raw-health-attempt",
      "Sensitive health data:",
    );
  });
});
