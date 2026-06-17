/**
 * Multi-browser-profile test for the CFC group chat demo.
 *
 * Unlike cfc-group-chat-demo.test.ts (which switches identity on ONE page),
 * this drives N SIMULTANEOUS browser instances — separate profiles, separate
 * identities, same piece — and checks the multi-user contract that a single
 * page cannot: per-user state isolation while every user is live, live
 * propagation of shared state, and admin lockdown not interfering with the
 * other users' ability to post.
 *
 * The profile count defaults to 2 (the historical "two browsers" case) and is
 * configurable via `CFC_BROWSER_PROFILE_COUNT` — raise it to amplify the
 * cross-browser sync contention behind the dual-browser slowness. Every
 * reactive step is timed, and after the run each browser's aggregate IPC /
 * worker timing is dumped, so a slow or flaky run reports WHERE the wall-clock
 * went (chiefly main-thread `runtime-client` IPC round-trips waiting on a
 * saturated worker). Raising the count to 3+ reliably reproduced the
 * handler-lifetime race fixed in #4146 (Bob's save lost, status stuck at
 * "Name not set"); the save steps drive the trusted action by its marker and
 * retry, so a single dropped dispatch can no longer wedge the run.
 *
 * The deeper state-machine coverage lives in the headless
 * cfc-group-chat-demo-multi-runtime.test.ts; this test guards the real
 * browser stack (DOM input binding, event provenance, login flow).
 */

import { env } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { UI } from "@commonfabric/runner";
import { debugVDOMSchema } from "@commonfabric/runner/schemas";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickCfButton,
  clickTrustedActionAndWaitForText,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  logStepTimings,
  readCfInputValue,
  StepTimer,
  waitForDisabled,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME, CFC_BROWSER_PROFILE_COUNT } = env;
const PROPAGATION_TIMEOUT = 60_000;
const SAVE_PROFILE_ACTION = "TrustedGroupChatSaveProfile";
const PROFILE_COUNT = Math.max(2, CFC_BROWSER_PROFILE_COUNT);

// Deterministic, distinct names so isolation/liveness assertions read clearly.
const NAME_POOL = [
  "Alice",
  "Bob",
  "Carol",
  "Dave",
  "Erin",
  "Frank",
  "Grace",
  "Heidi",
  "Ivan",
  "Judy",
];
const profileName = (index: number): string =>
  NAME_POOL[index] ?? `User${index + 1}`;

describe(
  `cfc group chat demo with ${PROFILE_COUNT} concurrent browser profiles`,
  () => {
    const shells = Array.from(
      { length: PROFILE_COUNT },
      () => new ShellIntegration(),
    );
    shells.forEach((shell) => shell.bindLifecycle());

    const userNames = Array.from(
      { length: PROFILE_COUNT },
      (_, index) => profileName(index),
    );

    let identities: Identity[];
    let cc: PiecesController;
    let pieceId: string;
    let pieceSinkCancel: (() => void) | undefined;
    let uiSinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      identities = await Promise.all(
        Array.from(
          { length: PROFILE_COUNT },
          () => Identity.generate({ implementation: "noble" }),
        ),
      );
      cc = await PiecesController.initialize({
        spaceName: SPACE_NAME,
        apiUrl: new URL(API_URL),
        identity: identities[0],
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
      // Pull on [UI] with the cell-less vdom schema (children expanded inline,
      // no asCell) so the controller materializes the WHOLE tree: every UI
      // computed runs and stays subscribed. That extra generation churn on the
      // shared space is what makes the concurrent-browser reproduction
      // realistic — more writes to race, more chances to conflict.
      uiSinkCancel = resultCell.key(UI).asSchema(debugVDOMSchema).sink(
        () => {},
      );
    });

    afterAll(async () => {
      uiSinkCancel?.();
      pieceSinkCancel?.();
      await cc?.dispose();
    });

    it("keeps per-user state isolated and shared state live across browsers", async () => {
      const timer = new StepTimer();
      const view = { spaceName: SPACE_NAME, pieceId };
      const pages = shells.map((shell) => shell.page());
      const others = (index: number) =>
        pages.filter((_, other) => other !== index);

      try {
        await timer.run(
          "navigate + login all profiles",
          () =>
            Promise.all(shells.map((shell, index) =>
              shell.goto({
                frontendUrl: FRONTEND_URL,
                view,
                identity: identities[index],
              })
            )),
        );
        await timer.run(
          "runtime idle (all)",
          () =>
            Promise.all(
              pages.map((page) =>
                waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT })
              ),
            ),
        );
        await timer.run(
          "initial 'No profile' (all)",
          () =>
            Promise.all(
              pages.map((page) =>
                waitForText(page, "#group-chat-manager-chip", "No profile", {
                  timeout: PROPAGATION_TIMEOUT,
                })
              ),
            ),
        );

        // Typing a name in the first browser must NOT appear in any other
        // browser's input — the profile draft is per-user state.
        await fillCfInput(pages[0], "#trusted-profile-name", userNames[0]);
        await Promise.all(
          pages.map((page) =>
            waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT })
          ),
        );
        for (let index = 1; index < pages.length; index++) {
          assertEquals(
            await readCfInputValue(pages[index], "#trusted-profile-name"),
            "",
            `${userNames[0]}'s profile-name draft leaked into ${
              userNames[index]
            }'s browser`,
          );
        }

        // First user saves. The trusted action is driven by its marker and
        // retried until the status flips, so a dropped dispatch can't wedge
        // the run. Every other user's profile must stay unset (not clobbered).
        await waitForDisabled(pages[0], "#trusted-profile-save", false);
        await timer.run(
          `${userNames[0]} save + own status`,
          () =>
            clickTrustedActionAndWaitForText(
              pages[0],
              SAVE_PROFILE_ACTION,
              "#trusted-profile-status",
              userNames[0],
              { timeout: PROPAGATION_TIMEOUT },
            ),
        );
        await Promise.all(
          pages.map((page) =>
            waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT })
          ),
        );
        for (let index = 1; index < pages.length; index++) {
          await waitForText(
            pages[index],
            "#trusted-profile-status",
            "Name not set",
          );
          await waitForText(
            pages[index],
            "#group-chat-manager-chip",
            "No profile",
          );
        }

        // Each remaining user, after the prior saver's name has reached them,
        // saves their own profile.
        for (let index = 1; index < pages.length; index++) {
          await timer.run(
            `${userNames[index]} sees ${userNames[index - 1]} before save`,
            () =>
              waitForText(
                pages[index],
                "#trusted-admin-user-list",
                userNames[index - 1],
                { timeout: PROPAGATION_TIMEOUT },
              ),
          );
          await waitForRuntimeIdle(pages[index], {
            timeout: PROPAGATION_TIMEOUT,
          });
          await fillCfInput(
            pages[index],
            "#trusted-profile-name",
            userNames[index],
          );
          await waitForDisabled(pages[index], "#trusted-profile-save", false);
          await timer.run(
            `${userNames[index]} save + own status`,
            () =>
              clickTrustedActionAndWaitForText(
                pages[index],
                SAVE_PROFILE_ACTION,
                "#trusted-profile-status",
                userNames[index],
                { timeout: PROPAGATION_TIMEOUT },
              ),
          );
        }

        // Every user's view must show every OTHER user by their actual name
        // (not an unnamed placeholder), and each user's own profile must
        // survive. This is the cross-browser propagation that the dual-browser
        // slowness most visibly degrades.
        await timer.run(
          "cross-browser name propagation (all pairs)",
          () =>
            Promise.all(pages.map(async (page, index) => {
              for (let other = 0; other < pages.length; other++) {
                if (other === index) continue;
                await waitForText(
                  page,
                  "#trusted-admin-user-list",
                  userNames[other],
                  { timeout: PROPAGATION_TIMEOUT },
                );
              }
              await waitForText(
                page,
                "#trusted-profile-status",
                userNames[index],
                { timeout: PROPAGATION_TIMEOUT },
              );
            })),
        );

        // Shared transcript propagates live to every other browser, with
        // snapshot author names intact.
        const helloMessage = `Hello from ${userNames[0]}`;
        await fillCfInput(pages[0], "#trusted-message-draft", helloMessage);
        await waitForDisabled(pages[0], "#trusted-send-button", false);
        await clickCfButton(pages[0], "#trusted-send-button");
        await timer.run(
          "message propagation (first -> all)",
          () =>
            Promise.all(
              others(0).map((page) =>
                waitForText(
                  page,
                  "#trusted-conversation-preview",
                  helloMessage,
                  { timeout: PROPAGATION_TIMEOUT },
                )
              ),
            ),
        );

        // First user locks down admin. Every other user loses admin (cannot
        // add rooms) but must still be able to POST — sending is never
        // admin-gated.
        await clickCfButton(pages[0], "#trusted-everyone-admin-checkbox");
        await waitForText(
          pages[0],
          "#group-chat-manager-chip",
          "Can manage admins",
          { timeout: PROPAGATION_TIMEOUT },
        );
        await timer.run(
          "lockdown propagation (first -> others)",
          () =>
            Promise.all(
              others(0).map((page) =>
                waitForText(
                  page,
                  "#trusted-room-admin-hint",
                  "Ask an admin manager to make you an admin",
                  { timeout: PROPAGATION_TIMEOUT },
                )
              ),
            ),
        );

        // A now-non-admin user can still post, and the admin sees it.
        const lastIndex = pages.length - 1;
        const lockdownMessage = `${userNames[lastIndex]} posts after lockdown`;
        await fillCfInput(
          pages[lastIndex],
          "#trusted-message-draft",
          lockdownMessage,
        );
        await waitForDisabled(pages[lastIndex], "#trusted-send-button", false);
        await clickCfButton(pages[lastIndex], "#trusted-send-button");
        await timer.run(
          "post-lockdown message (non-admin -> admin)",
          () =>
            waitForText(
              pages[0],
              "#trusted-conversation-preview",
              lockdownMessage,
              { timeout: PROPAGATION_TIMEOUT },
            ),
        );

        // Admin can still add rooms, and every other user sees the shared room.
        await fillCfInput(pages[0], "#trusted-room-name", "Ops");
        await waitForDisabled(pages[0], "#trusted-room-add-button", false);
        await clickCfButton(pages[0], "#trusted-room-add-button");
        await waitForText(pages[0], "#rooms-panel", "Ops");
        await timer.run(
          "room propagation (first -> all)",
          () =>
            Promise.all(
              others(0).map((page) =>
                waitForText(page, "#rooms-panel", "Ops", {
                  timeout: PROPAGATION_TIMEOUT,
                })
              ),
            ),
        );
      } finally {
        // Always report where the wall-clock went — on success to track the
        // contention trend, on failure to localize the slow propagation.
        logStepTimings(`group-chat ${PROFILE_COUNT}-profile`, timer);
        const summaries = await Promise.all(
          pages.map((page, index) =>
            collectBrowserLoadSummary(page, userNames[index]).catch(() =>
              undefined
            )
          ),
        );
        for (const summary of summaries) {
          if (summary) logBrowserLoadSummary(summary);
        }
      }
    });
  },
);
