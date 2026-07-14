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
  StepTimer,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("cfc render policy demo integration test", () => {
  const shell = new ShellIntegration({
    presentation: { label: "Policy demo", color: "#7c3aed" },
  });
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

    // Pre-create the space-root (default) pattern so the browser's
    // `pattern:getSpaceRoot` storage-RESUMEs it instead of taking the create
    // path and cold-compiling default-app inside its worker — see the
    // beforeAll comment in lunch-poll-vote.test.ts.
    await cc.ensureDefaultPattern();

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
    const timeline = new StepTimer();
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

    await timeline.run(
      "Confidential data starts hidden on every untrusted surface",
      async () => {
        await waitForText(
          page,
          "#raw-health-attempt",
          "Content hidden by policy",
        );
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
      },
    );

    await timeline.run(
      "A trusted action reveals the approved value only inside its trusted surface",
      () =>
        clickTrustedActionAndWaitForText(
          page,
          "TrustedRevealHealthData",
          "#trusted-health-visible",
          "Sensitive health data: migraine treatment plan",
          { timeout: 45_000 },
        ),
    );
    await timeline.run(
      "The raw pattern output remains hidden after the trusted reveal",
      () =>
        waitForTextAbsent(
          page,
          "#raw-health-attempt",
          "Sensitive health data:",
        ),
    );
  });
});
