import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { assert } from "@std/assert";
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

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("parking coordinator admin view integration test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let resultCell: ReturnType<PiecesController["getResult"]>;
  let adminChangeIntegrity: readonly unknown[] = [];
  const sinkCancels: (() => void)[] = [];

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
    const program = await cc.runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const piece = await cc.create(program, {
      start: true,
      input: {
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
    resultCell = cc.getResult(piece.getCell());
    sinkCancels.push(resultCell.sink(() => {}));
    sinkCancels.push(
      resultCell.key("adminChanges").resolveAsCell().sink((_value, label) => {
        adminChangeIntegrity = (label?.entries ?? []).flatMap(
          (entry) => entry.label.integrity ?? [],
        );
      }, { includeCfcLabel: true }),
    );
  });

  afterAll(async () => {
    for (const cancel of sinkCancels) cancel();
    await cc?.dispose();
  });

  it("grants and revokes endorsed parking administrator access", async () => {
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
    await cc.synced();
    await resultCell.pull();
    assert(
      adminChangeIntegrity.includes("parking-admin"),
      `the trusted grant must carry the parking administrator endorsement: ${
        JSON.stringify(adminChangeIntegrity)
      }`,
    );
    assert(
      adminChangeIntegrity.includes("parking-admin-manager"),
      "the trusted grant must carry the administrator-manager endorsement",
    );
    (resultCell.key("removePerson") as unknown as {
      send(event: { name: string }): void;
    }).send({ name: "Alice" });
    await cc.runtime.idle();
    await cc.synced();
    await resultCell.pull();
    assert(
      (resultCell.key("people").get() as { name: string }[]).some(
        ({ name }) => name === "Alice",
      ),
      "an active administrator must not be removable",
    );
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

    await clickCfButtonAndWaitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      '[data-parking-admin-row="Alice"]',
      "Member",
    );
    await waitForRuntimeIdle(page);
    await waitForText(
      page,
      '[data-parking-admin-toggle="Alice"]',
      "Make admin",
    );
    (resultCell.key("removePerson") as unknown as {
      send(event: { name: string }): void;
    }).send({ name: "Alice" });
    await cc.runtime.idle();
    await cc.synced();
    await resultCell.pull();
    assert(
      !(resultCell.key("people").get() as { name: string }[]).some(
        ({ name }) => name === "Alice",
      ),
      "a former administrator must become removable after revocation",
    );
  });
});
