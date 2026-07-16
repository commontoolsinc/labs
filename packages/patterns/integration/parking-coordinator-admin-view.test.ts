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
  clickCfButtonAndWaitForText,
  fillCfInput,
  logStepTimings,
  StepTimer,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("parking coordinator admin view integration test", () => {
  const shell = new ShellIntegration({
    presentation: {
      id: "parking-coordinator",
      label: "Parking coordinator",
      color: "#2563eb",
    },
  });
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;
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
      "factory-outputs",
      "parking-coordinator",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const piece = await cc.create(program, {
      start: true,
      input: {
        spots: [
          {
            spotNumber: "1",
            label: "Near entrance",
            notes: "",
            active: true,
          },
          { spotNumber: "5", label: "", notes: "", active: true },
          {
            spotNumber: "12",
            label: "Compact only",
            notes: "Tight, no large vehicles",
            active: true,
          },
        ],
        people: [],
        requests: [],
      },
    });
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("bootstraps a team, adds capacity, and allocates parking through the UI", async () => {
    const timeline = new StepTimer();
    const page = shell.page();
    try {
      await shell.goto({
        frontendUrl: FRONTEND_URL,
        view: {
          spaceName: SPACE_NAME,
          pieceId,
        },
        identity,
      });
      await waitForRuntimeIdle(page);

      await timeline.run("The empty coordinator starts locked", async () => {
        await waitForText(page, "body", "No team members yet");
        await waitForText(
          page,
          "#parking-admin-access",
          "Cannot manage admins",
        );
        await waitForDisabled(page, "#parking-enable-admin-manager", false);
        await waitForDisabled(page, "#parking-admin-mode-toggle", true);
        await waitForDisabled(page, "#parking-request-submit", true);
        await waitForTextAbsent(
          page,
          "#parking-admin-people-section",
          "People",
        );
      });

      await timeline.run(
        "Demo manager access unlocks team setup",
        async () => {
          await clickCfButtonAndWaitForText(
            page,
            "#parking-enable-admin-manager",
            "#parking-admin-people-section",
            "People",
          );
          await waitForDisabled(page, "#parking-enable-admin-manager", true);
          await waitForText(
            page,
            "#parking-admin-add-person-open",
            "+ Add Person",
          );
        },
      );

      await timeline.run("Alice joins the parking roster", async () => {
        await clickCfButtonAndWaitForText(
          page,
          "#parking-admin-add-person-open",
          "#parking-admin-add-person-form",
          "Add Person",
        );
        await fillCfInput(
          page,
          "#parking-admin-add-person-name",
          "Alice",
        );
        await fillCfInput(
          page,
          "#parking-admin-add-person-email",
          "alice@example.test",
        );
        await fillCfInput(
          page,
          "#parking-admin-add-person-preferences",
          "5, 1",
        );
        await clickCfButtonAndWaitForText(
          page,
          "#parking-admin-add-person-submit",
          '[data-parking-admin-row="Alice"]',
          "Alice",
        );
        await waitForTextAbsent(
          page,
          "#parking-admin-add-person-form",
          "Add Person",
        );
        await waitForDisabled(page, "#parking-request-submit", false);
      });

      await timeline.run("Alice becomes the parking admin", async () => {
        await clickCfButtonAndWaitForText(
          page,
          '[data-parking-admin-toggle="Alice"]',
          '[data-parking-admin-row="Alice"]',
          "Admin",
        );
        await waitForText(
          page,
          '[data-parking-admin-toggle="Alice"]',
          "Remove admin",
        );
        await waitForDisabled(page, "#parking-admin-mode-toggle", false);
      });

      await timeline.run("Alice opens the admin tools", async () => {
        await clickCfButtonAndWaitForText(
          page,
          "#parking-admin-mode-toggle",
          "#parking-admin-mode-toggle",
          "Admin: ON",
        );
        await waitForText(
          page,
          "#parking-admin-spots-section",
          "Parking Spots",
        );
      });

      await timeline.run("A new covered spot is added", async () => {
        await clickCfButtonAndWaitForText(
          page,
          "#parking-admin-add-spot-open",
          "#parking-admin-add-spot-form",
          "Add Spot",
        );
        await fillCfInput(page, "#parking-admin-add-spot-number", "7");
        await fillCfInput(
          page,
          "#parking-admin-add-spot-label",
          "Level 2",
        );
        await fillCfInput(
          page,
          "#parking-admin-add-spot-notes",
          "Covered",
        );
        await clickCfButtonAndWaitForText(
          page,
          "#parking-admin-add-spot-submit",
          "#parking-admin-spots-section",
          "Covered",
        );
        await waitForTextAbsent(
          page,
          "#parking-admin-add-spot-form",
          "Add Spot",
        );
      });

      await timeline.run("Alice requests today's parking", async () => {
        await clickCfButtonAndWaitForText(
          page,
          "#parking-request-submit",
          "#parking-request-result",
          "Spot #5 allocated to Alice",
        );
        await waitForText(
          page,
          '[data-parking-today-spot="5"]',
          "Alice",
        );
      });

      await timeline.run("Duplicate requests are rejected", async () => {
        await clickCfButtonAndWaitForText(
          page,
          "#parking-request-submit",
          "#parking-request-result",
          "already have an active request",
        );
      });
    } finally {
      logStepTimings("parking coordinator", timeline);
    }
  });
});
