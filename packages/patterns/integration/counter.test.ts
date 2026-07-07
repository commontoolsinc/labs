import { env, waitFor } from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";
import { waitForText } from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("counter direct operations test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let piece: PieceController;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "counter",
      "counter.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    piece = await cc.create(
      program, // We operate on the piece in this thread
      { start: true },
    );

    // In pull mode, create a sink to keep the piece reactive when inputs change.
    // Without this, setting values won't trigger pattern re-computation.
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    if (cc) await cc.dispose();
  });

  it("should load the counter piece and verify initial state", async () => {
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    // Verify initial value is 0
    await waitForText(page, "#counter-result", "Counter is the 0th number");

    assertEquals(await piece.result.get(["value"]), 0);
  });

  it("should update counter value via direct operation (live)", async () => {
    const page = shell.page();

    await page.waitForSelector("#counter-result", {
      strategy: "pierce",
    });

    await piece.result.set(42, ["value"]);

    await waitForText(page, "#counter-result", "Counter is the 42nd number");

    // Verify we can also read the value back
    await waitFor(async () => (await piece.result.get(["value"]) === 42));
  });

  it("should update counter value and verify after page refresh", async () => {
    const page = shell.page();

    console.log("Setting counter value to 42 via direct operation");
    await piece.result.set(42, ["value"]);
    await waitFor(async () => (await piece.result.get(["value"]) === 42));

    // Now refresh the page by navigating to the same URL
    console.log("Refreshing the page...");
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId: piece.id,
      },
      identity,
    });

    // Get the counter result element after refresh
    await waitForText(page, "#counter-result", "Counter is the 42nd number");
  });
});
