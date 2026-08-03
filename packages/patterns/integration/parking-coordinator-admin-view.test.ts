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
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
  waitForTextAbsent,
} from "./cfc-browser-helpers.ts";
import {
  beginServerExecutionMeasurement,
  finishServerExecutionMeasurement,
} from "./server-execution-measurement.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("parking coordinator admin view integration test", () => {
  const shell = new ShellIntegration();
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
        people: [
          {
            name: "Alice",
            email: "alice@example.test",
            commuteMode: "drive",
            spotPreferences: [],
            defaultSpot: "",
            priorityRank: 1,
          },
        ],
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

  it("renders manager and admin controls with the expected enabled states", async () => {
    const executionMeasurement = await beginServerExecutionMeasurement(
      "parking-coordinator-admin-view",
    );
    const page = shell.page();
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: {
        spaceName: SPACE_NAME,
        pieceId,
      },
      identity,
    });
    await waitForRuntimeIdle(page);

    await waitForText(page, "#parking-admin-access", "Alice");
    await waitForText(page, "#parking-admin-access", "Cannot manage admins");
    await waitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      "Make admin",
    );
    await waitForDisabled(page, "#parking-enable-admin-manager", false);
    await waitForDisabled(page, '[data-parking-admin-toggle="Alice"]', true);
    await waitForDisabled(page, "#parking-admin-mode-toggle", true);
    await waitForTextAbsent(page, "#parking-admin-people-section", "People");

    await clickCfButtonAndWaitForText(
      page,
      "#parking-enable-admin-manager",
      "#parking-admin-access",
      "Can manage admins",
    );
    await waitForRuntimeIdle(page);
    await waitForDisabled(page, "#parking-enable-admin-manager", true);
    await waitForDisabled(page, '[data-parking-admin-toggle="Alice"]', false);

    await clickCfButtonAndWaitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      '[data-parking-admin-row="Alice"]',
      "Admin",
    );
    await waitForRuntimeIdle(page);
    await waitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      "Remove admin",
    );
    await waitForDisabled(page, "#parking-admin-mode-toggle", false);
    await waitForText(page, "#parking-admin-mode-toggle", "Admin: OFF");

    await clickCfButtonAndWaitForText(
      page,
      "#parking-admin-mode-toggle",
      "#parking-admin-mode-toggle",
      "Admin: ON",
    );
    await waitForRuntimeIdle(page);
    await waitForText(page, "#parking-admin-people-section", "People");
    await waitForText(page, "#parking-admin-add-person-open", "+ Add Person");
    await finishServerExecutionMeasurement(executionMeasurement);
  });
});
