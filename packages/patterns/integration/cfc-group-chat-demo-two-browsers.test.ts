/**
 * Two-browser-profile test for the CFC group chat demo.
 *
 * Unlike cfc-group-chat-demo.test.ts (which switches identity on ONE page),
 * this drives two SIMULTANEOUS browser instances — separate profiles,
 * separate identities, same piece — and checks the multi-user contract that
 * a single page cannot: per-user state isolation while both users are live,
 * live propagation of shared state, and admin lockdown not interfering with
 * the other user's ability to post.
 *
 * The deeper state-machine coverage lives in the headless
 * cfc-group-chat-demo-multi-runtime.test.ts; this test guards the real
 * browser stack (DOM input binding, event provenance, login flow).
 */

import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickCfButton,
  clickTrustedActionAndWaitForText,
  fillCfInput,
  readCfInputValue,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const PROPAGATION_TIMEOUT = 60_000;
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";

describe("cfc group chat demo with two concurrent browser profiles", () => {
  const aliceShell = new ShellIntegration();
  const bobShell = new ShellIntegration();
  aliceShell.bindLifecycle();
  bobShell.bindLifecycle();

  let aliceIdentity: Identity;
  let bobIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    aliceIdentity = await Identity.generate({ implementation: "noble" });
    bobIdentity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: aliceIdentity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "cfc-group-chat-demo",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const piece = await cc.create(program, { start: true });
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    pieceSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("keeps per-user state isolated and shared state live across two browsers", async () => {
    const alice = aliceShell.page();
    const bob = bobShell.page();
    const view = { spaceName: SPACE_NAME, pieceId };
    await Promise.all([
      aliceShell.goto({
        frontendUrl: FRONTEND_URL,
        view,
        identity: aliceIdentity,
      }),
      bobShell.goto({ frontendUrl: FRONTEND_URL, view, identity: bobIdentity }),
    ]);
    await waitForRuntimeIdle(alice);
    await waitForRuntimeIdle(bob);
    await waitForText(alice, "#group-chat-manager-chip", "No profile");
    await waitForText(bob, "#group-chat-manager-chip", "No profile");

    // Typing a name in Alice's browser must NOT appear in Bob's input —
    // the profile draft is per-user state.
    await fillCfInput(alice, "#trusted-profile-name", "Alice");
    await waitForRuntimeIdle(alice);
    await waitForRuntimeIdle(bob);
    assertEquals(
      await readCfInputValue(bob, "#trusted-profile-name"),
      "",
      "Alice's profile-name draft leaked into Bob's browser",
    );

    // Alice saves her profile. Her status updates; Bob's profile must stay
    // unset (not clobbered to Alice's).
    await waitForDisabled(alice, "#trusted-profile-save", false);
    await clickTrustedActionAndWaitForText(
      alice,
      SAVE_PROFILE_ACTION,
      "#trusted-profile-status",
      "Alice",
    );
    await waitForRuntimeIdle(alice);
    await waitForRuntimeIdle(bob);
    await waitForText(bob, "#trusted-profile-status", "Name not set");
    await waitForText(bob, "#group-chat-manager-chip", "No profile");

    // Bob saves his own profile. Alice's view must show Bob by his actual
    // name (not an unnamed placeholder), and her own profile must survive.
    await fillCfInput(bob, "#trusted-profile-name", "Bob");
    await waitForDisabled(bob, "#trusted-profile-save", false);
    await clickTrustedActionAndWaitForText(
      bob,
      SAVE_PROFILE_ACTION,
      "#trusted-profile-status",
      "Bob",
    );
    await waitForText(
      alice,
      "#trusted-admin-user-list",
      "Bob",
      { timeout: PROPAGATION_TIMEOUT },
    );
    await waitForText(alice, "#trusted-profile-status", "Alice");
    await waitForText(
      bob,
      "#trusted-admin-user-list",
      "Alice",
      { timeout: PROPAGATION_TIMEOUT },
    );

    // Shared transcript propagates live in both directions, with snapshot
    // author names intact.
    await fillCfInput(alice, "#trusted-message-draft", "Hello from Alice");
    await waitForDisabled(alice, "#trusted-send-button", false);
    await clickCfButton(alice, "#trusted-send-button");
    await waitForText(
      bob,
      "#trusted-conversation-preview",
      "Hello from Alice",
      { timeout: PROPAGATION_TIMEOUT },
    );

    // Alice locks down admin. Bob loses admin (cannot add rooms) but must
    // still be able to POST — message sending is never admin-gated.
    await clickCfButton(alice, "#trusted-everyone-admin-checkbox");
    await waitForText(alice, "#group-chat-manager-chip", "Can manage admins");
    await waitForText(
      bob,
      "#trusted-room-admin-hint",
      "Ask an admin manager to make you an admin",
      { timeout: PROPAGATION_TIMEOUT },
    );
    await fillCfInput(
      bob,
      "#trusted-message-draft",
      "Bob posts after lockdown",
    );
    await waitForDisabled(bob, "#trusted-send-button", false);
    await clickCfButton(bob, "#trusted-send-button");
    await waitForText(
      alice,
      "#trusted-conversation-preview",
      "Bob posts after lockdown",
      { timeout: PROPAGATION_TIMEOUT },
    );

    // Admin Alice can still add rooms, and Bob sees the shared room list.
    await fillCfInput(alice, "#trusted-room-name", "Ops");
    await waitForDisabled(alice, "#trusted-room-add-button", false);
    await clickCfButton(alice, "#trusted-room-add-button");
    await waitForText(alice, "#rooms-panel", "Ops");
    await waitForText(
      bob,
      "#rooms-panel",
      "Ops",
      { timeout: PROPAGATION_TIMEOUT },
    );
  });
});
