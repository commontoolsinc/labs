/**
 * Multi-browser voting test for the lunch poll.
 *
 * Drives two simultaneous browser profiles (separate identities, same piece):
 * a host who joins first and adds options, and a second user who joins and
 * votes. It exercises the path the headless multiUserTest cannot — real DOM
 * event provenance through cf-button, login, and live cross-browser propagation
 * — and checks that two users voting on the SAME option end up with both votes
 * counted: the tally reaches "2 love it" on both browsers. The two greens are
 * cast CONCURRENTLY (both clicks dispatched before either side settles), so the
 * second voter is not guaranteed to have observed the first vote, and the votes
 * are distinct entities (one per voter), so "2 love it" requires two surviving
 * votes rather than one double-counted one.
 *
 * The deterministic stale-base no-clobber proof — where the second writer
 * commits against a base that provably lacks the first vote — lives in the
 * runner-level packages/runner/test/array-push-mergeable.test.ts, which can pin
 * the base exactly. This test is the end-to-end smoke that the same behavior
 * holds through the browser stack.
 */

import { env, type Page, waitFor } from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clickCfButton,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  logStepTimings,
  StepTimer,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const PROPAGATION_TIMEOUT = 60_000;

const HOST = "Alice";
const GUEST = "Bob";
const OPTION_A = "Sushi Place";
const OPTION_B = "Taco Stand";

const optionCard = (title: string) => `[data-option-title="${title}"]`;
const voteButton = (title: string, color: "green" | "yellow" | "red") =>
  `${optionCard(title)} cf-button[data-vote="${color}"]`;

type VoteSwatchType = "green" | "yellow" | "red";

interface VoteSwatchSnapshot {
  name: string;
  optionId: string;
  optionTitle: string;
  voteType: VoteSwatchType;
}

const optionIdForTitle = (page: Page, title: string): Promise<string> =>
  page.evaluate((expectedTitle) => {
    const walk = (root: Document | ShadowRoot): string | undefined => {
      for (const el of root.querySelectorAll("[data-option-title]")) {
        if (el.getAttribute("data-option-title") === expectedTitle) {
          const id = el.getAttribute("data-option-id");
          if (!id) {
            throw new Error(
              `Option card missing data-option-id: ${expectedTitle}`,
            );
          }
          return id;
        }
      }
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) {
          const id = walk(sr);
          if (id) return id;
        }
      }
    };

    const id = walk(document);
    if (!id) throw new Error(`Option card not found: ${expectedTitle}`);
    return id;
  }, { args: [title] });

// The "All options" swatches visible in a browser, grouped by their row's option
// id. This checks the exact displayed vote membership, not only global voter
// presence somewhere in the page.
const voteSwatches = (page: Page): Promise<VoteSwatchSnapshot[]> =>
  page.evaluate(() => {
    const isVoteSwatchType = (value: string | null): value is
      | "green"
      | "yellow"
      | "red" => value === "green" || value === "yellow" || value === "red";
    const snapshots: Array<{
      name: string;
      optionId: string;
      optionTitle: string;
      voteType: "green" | "yellow" | "red";
    }> = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("[data-vote-swatch-name]")) {
        const name = el.getAttribute("data-vote-swatch-name");
        const optionId = el.getAttribute("data-vote-swatch-option-id") ??
          el.getAttribute("data-all-option-id") ??
          el.closest("[data-all-option-id]")?.getAttribute(
            "data-all-option-id",
          );
        const optionTitle = el.getAttribute("data-all-option-title") ??
          el.closest("[data-all-option-title]")?.getAttribute(
            "data-all-option-title",
          );
        const voteType = el.getAttribute("data-vote-swatch-type");
        if (!name || !optionId || !optionTitle || !isVoteSwatchType(voteType)) {
          throw new Error(
            `Invalid vote swatch metadata: ${el.outerHTML}`,
          );
        }
        snapshots.push({ name, optionId, optionTitle, voteType });
      }
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return snapshots;
  });

const swatchesMatch = (
  actual: readonly VoteSwatchSnapshot[],
  expected: readonly VoteSwatchSnapshot[],
): boolean => {
  const normalize = (rows: readonly VoteSwatchSnapshot[]) =>
    rows.map((row) =>
      JSON.stringify({
        optionId: row.optionId,
        optionTitle: row.optionTitle,
        name: row.name,
        voteType: row.voteType,
      })
    ).sort();
  return JSON.stringify(normalize(actual)) ===
    JSON.stringify(normalize(expected));
};

const bothPagesShowSwatches = async (
  hostPage: Page,
  guestPage: Page,
  expected: readonly VoteSwatchSnapshot[],
): Promise<boolean> => {
  const [hostSwatches, guestSwatches] = await Promise.all([
    voteSwatches(hostPage),
    voteSwatches(guestPage),
  ]);
  return swatchesMatch(hostSwatches, expected) &&
    swatchesMatch(guestSwatches, expected);
};

describe("lunch poll: two users vote on a shared option", () => {
  const hostShell = new ShellIntegration();
  const guestShell = new ShellIntegration();
  hostShell.bindLifecycle();
  guestShell.bindLifecycle();

  let hostIdentity: Identity;
  let guestIdentity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let resultSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    [hostIdentity, guestIdentity] = await Promise.all([
      Identity.generate({ implementation: "noble" }),
      Identity.generate({ implementation: "noble" }),
    ]);
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: hostIdentity,
    });

    const sourcePath = join(
      import.meta.dirname!,
      "..",
      "lunch-poll",
      "main.tsx",
    );
    const rootPath = join(import.meta.dirname!, "..");
    const program = await cc.manager().runtime.harness.resolve(
      new FileSystemProgramResolver(sourcePath, rootPath),
    );
    const piece = await cc.create(program, { start: true });
    await cc.manager().runtime.patternManager.flushCompileCacheWrites();
    pieceId = piece.id;
    const resultCell = cc.manager().getResult(piece.getCell());
    // Keep the piece running without materializing the whole UI tree in this
    // controller process; the two browsers render their own UI.
    resultSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    if (pieceId) await cc?.remove(pieceId);
    await cc?.dispose();
  });

  it("both users' votes on the same option survive, and a second option tallies independently", async () => {
    const timer = new StepTimer();
    const view = { spaceName: SPACE_NAME, pieceId };
    const hostPage = hostShell.page();
    const guestPage = guestShell.page();

    try {
      await timer.run(
        "navigate + login both",
        () =>
          Promise.all([
            hostShell.goto({
              frontendUrl: FRONTEND_URL,
              view,
              identity: hostIdentity,
            }),
            guestShell.goto({
              frontendUrl: FRONTEND_URL,
              view,
              identity: guestIdentity,
            }),
          ]),
      );
      await Promise.all([
        waitForRuntimeIdle(hostPage, { timeout: PROPAGATION_TIMEOUT }),
        waitForRuntimeIdle(guestPage, { timeout: PROPAGATION_TIMEOUT }),
      ]);

      // Host joins first -> becomes host/admin. The roster chip carrying the
      // host's name appears once the join lands.
      await fillCfInput(hostPage, "#lp-join-name", HOST);
      await clickCfButton(hostPage, "#lp-join-button");
      await timer.run(
        "host joined (name in roster)",
        () =>
          waitForText(hostPage, "body", HOST, { timeout: PROPAGATION_TIMEOUT }),
      );

      // Guest joins second. The board shows a participant count, not a full
      // roster, so the host's join landing is observed as "2 joined" (and the
      // guest's own page shows its name plus "hosted by Alice").
      await fillCfInput(guestPage, "#lp-join-name", GUEST);
      await clickCfButton(guestPage, "#lp-join-button");
      await timer.run(
        "both join lands (count reaches 2)",
        () =>
          Promise.all([
            waitForText(hostPage, "body", "2 joined", {
              timeout: PROPAGATION_TIMEOUT,
            }),
            waitForText(guestPage, "body", GUEST, {
              timeout: PROPAGATION_TIMEOUT,
            }),
          ]),
      );

      // Host adds the shared option.
      await fillCfInput(hostPage, "#lp-add-option-input", OPTION_A);
      await clickCfButton(hostPage, "#lp-add-option-button");
      await timer.run(
        "option A propagates to both",
        () =>
          Promise.all([
            waitForText(hostPage, "body", OPTION_A, {
              timeout: PROPAGATION_TIMEOUT,
            }),
            waitForText(guestPage, "body", OPTION_A, {
              timeout: PROPAGATION_TIMEOUT,
            }),
          ]),
      );
      const optionAId = await optionIdForTitle(hostPage, OPTION_A);

      // Both users vote green on the SAME option CONCURRENTLY: both clicks are
      // dispatched before either browser settles, so the second voter is not
      // guaranteed to have seen the first vote. The votes are distinct entities
      // (keyed per voter), so both must survive and the tally reaches "2 love
      // it" on BOTH browsers. A clobbering whole-list write against a base that
      // missed the other vote would leave it at "1 love it".
      await timer.run(
        "both cast green concurrently",
        () =>
          Promise.all([
            clickCfButton(hostPage, voteButton(OPTION_A, "green")),
            clickCfButton(guestPage, voteButton(OPTION_A, "green")),
          ]),
      );
      await timer.run(
        "both browsers see 2 love it (merge)",
        () =>
          Promise.all([
            waitForText(hostPage, "body", "2 love it", {
              timeout: PROPAGATION_TIMEOUT,
            }),
            waitForText(guestPage, "body", "2 love it", {
              timeout: PROPAGATION_TIMEOUT,
            }),
          ]),
      );

      // Both voters' swatches are visible on BOTH browsers: the host sees the
      // guest's vote and vice versa, attached to the correct All options row.
      // This is the cross-browser visibility the count alone does not name — it
      // identifies WHO voted, FOR WHICH option, and WHICH color, sourced from the
      // resolved tally so a remote voter's keyed entity is rendered.
      await timer.run(
        "both voters' option A swatches visible on both browsers",
        () =>
          waitFor(
            () =>
              bothPagesShowSwatches(hostPage, guestPage, [
                {
                  optionId: optionAId,
                  optionTitle: OPTION_A,
                  name: HOST,
                  voteType: "green",
                },
                {
                  optionId: optionAId,
                  optionTitle: OPTION_A,
                  name: GUEST,
                  voteType: "green",
                },
              ]),
            { timeout: PROPAGATION_TIMEOUT, delay: 500 },
          ),
      );

      // A second option tallies independently: host adds it, guest vetoes it,
      // and option A's "2 love it" is unaffected.
      await fillCfInput(hostPage, "#lp-add-option-input", OPTION_B);
      await clickCfButton(hostPage, "#lp-add-option-button");
      await Promise.all([
        waitForText(hostPage, "body", OPTION_B, {
          timeout: PROPAGATION_TIMEOUT,
        }),
        waitForText(guestPage, "body", OPTION_B, {
          timeout: PROPAGATION_TIMEOUT,
        }),
      ]);
      const optionBId = await optionIdForTitle(hostPage, OPTION_B);
      await clickCfButton(guestPage, voteButton(OPTION_B, "red"));
      // The third vote (red on option B) lands on both browsers — the count
      // reaches "3 votes" — while option A's tally is unchanged at "2 love it".
      // Option A stays the top choice (it has the greens), so its "2 love it"
      // is the surfaced summary either way.
      await timer.run(
        "option B vote lands (3 votes); option A unchanged",
        () =>
          Promise.all([
            waitForText(hostPage, "body", "3 votes", {
              timeout: PROPAGATION_TIMEOUT,
            }),
            waitForText(guestPage, "body", "3 votes", {
              timeout: PROPAGATION_TIMEOUT,
            }),
            waitForText(hostPage, "body", "2 love it", {
              timeout: PROPAGATION_TIMEOUT,
            }),
          ]),
      );
      await timer.run(
        "all option swatches match displayed vote rows",
        () =>
          waitFor(
            () =>
              bothPagesShowSwatches(hostPage, guestPage, [
                {
                  optionId: optionAId,
                  optionTitle: OPTION_A,
                  name: HOST,
                  voteType: "green",
                },
                {
                  optionId: optionAId,
                  optionTitle: OPTION_A,
                  name: GUEST,
                  voteType: "green",
                },
                {
                  optionId: optionBId,
                  optionTitle: OPTION_B,
                  name: GUEST,
                  voteType: "red",
                },
              ]),
            { timeout: PROPAGATION_TIMEOUT, delay: 500 },
          ),
      );
    } finally {
      logStepTimings("lunch-poll vote", timer);
      for (
        const [page, label] of [[hostPage, HOST], [guestPage, GUEST]] as const
      ) {
        const summary = await collectBrowserLoadSummary(page, label).catch(() =>
          undefined
        );
        if (summary) logBrowserLoadSummary(summary);
      }
    }
  });
});
