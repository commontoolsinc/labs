/**
 * High-contention browser repro for Lunch Poll's All-options vote display.
 *
 * The headless diagnostic proves durable votes converge, but the reported bug is
 * specifically that rendered All-options swatches can disagree with the stored
 * votes under contention. This test keeps five voter profiles live on one piece,
 * drives one concurrent vote wave for each of ten options, then verifies both
 * the active voters and a fresh observer browser render every stored swatch.
 * The 5x10 default mirrors the live failure shape: 50 stored votes with only a
 * subset of All-options swatches rendered.
 */

import {
  Browser,
  dismissDialogs,
  env,
  type Page,
  pipeConsole,
  waitFor,
} from "@commonfabric/integration";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { PiecesController } from "@commonfabric/piece/ops";
import { login, ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  type AppView,
  appViewToUrlPath,
  deserialize,
  isAppViewEqual,
} from "@commonfabric/shell/shared";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import type { ConsoleEvent, PageErrorEvent } from "@astral/astral";
import {
  clickCfButton,
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  logStepTimings,
  StepTimer,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
  waitForText,
} from "./cfc-browser-helpers.ts";
import type { Vote, VoteColor } from "../lunch-poll/main.tsx";

const { API_URL, FRONTEND_URL, SPACE_NAME, CFC_BROWSER_PROFILE_COUNT } = env;
const PROPAGATION_TIMEOUT = 60_000;
const OPTION_CARD_READY_TIMEOUT = 180_000;
const PROFILE_COUNT = Math.max(5, CFC_BROWSER_PROFILE_COUNT);
const OPTIONS = Array.from(
  { length: 10 },
  (_, index) => `Restaurant ${index + 1}`,
);
const EXPECTED_VOTE_COUNT = PROFILE_COUNT * OPTIONS.length;
const NAMES = [
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
const VOTE_TYPES: readonly VoteColor[] = ["green", "yellow", "red"];

const profileName = (index: number): string =>
  NAMES[index] ?? `User ${index + 1}`;

const optionCard = (title: string) => `[data-option-title="${title}"]`;
const voteButton = (title: string, color: VoteColor) =>
  `${optionCard(title)} cf-button[data-vote="${color}"]`;

interface VoteSwatchSnapshot {
  name: string;
  optionId: string;
  optionTitle: string;
  voteType: VoteColor;
}

const normalizeVotes = (votes: readonly Vote[]): string[] =>
  votes.map((vote) =>
    JSON.stringify({
      voterName: vote.voterName,
      optionId: vote.optionId,
      voteType: vote.voteType,
    })
  ).sort();

const normalizeSwatches = (
  swatches: readonly VoteSwatchSnapshot[],
): string[] =>
  swatches.map((swatch) =>
    JSON.stringify({
      voterName: swatch.name,
      optionId: swatch.optionId,
      optionTitle: swatch.optionTitle,
      voteType: swatch.voteType,
    })
  ).sort();

const assertVoteSet = (
  actual: readonly Vote[],
  expected: readonly Vote[],
  label: string,
) => {
  assertEquals(normalizeVotes(actual), normalizeVotes(expected), label);
};

const assertSwatchSet = (
  actual: readonly VoteSwatchSnapshot[],
  expected: readonly VoteSwatchSnapshot[],
  label: string,
) => {
  assertEquals(normalizeSwatches(actual), normalizeSwatches(expected), label);
};

const attachObserverDiagnostics = (
  page: Page,
  errorLogs: string[],
  exceptions: string[],
) => {
  page.addEventListener("console", (event: ConsoleEvent) => {
    if (event.detail.type === "error") {
      errorLogs.push(event.detail.text);
    }
    if (env.PIPE_CONSOLE) {
      pipeConsole(event);
    }
  });
  page.addEventListener("dialog", dismissDialogs);
  page.addEventListener("pageerror", (event: PageErrorEvent) => {
    console.error("Browser Page Error:", event.detail.message);
    exceptions.push(event.detail.message);
  });
};

const assertNoObserverDiagnostics = (
  errorLogs: readonly string[],
  exceptions: readonly string[],
) => {
  if (exceptions.length > 0) {
    throw new Error(
      `Fresh observer browser exception(s):\n${
        exceptions.map((message) => `  ${message}`).join("\n")
      }`,
    );
  }
  if (errorLogs.length > 0) {
    throw new Error(
      `Fresh observer browser console error(s):\n${
        errorLogs.map((message) => `  ${message}`).join("\n")
      }`,
    );
  }
};

const waitForShellState = async (
  page: Page,
  view: AppView,
  identity?: Identity,
): Promise<void> => {
  await waitFor(async () => {
    const serialized = await page.evaluate(() =>
      globalThis.app ? globalThis.app.serialize() : undefined
    );
    if (!serialized) return false;
    const state = await deserialize(serialized);
    return isAppViewEqual(state.view, view) &&
      (identity ? state.identity?.did() === identity.did() : true);
  }, { timeout: PROPAGATION_TIMEOUT });
};

const gotoFreshObserver = async (
  page: Page,
  frontendUrl: string,
  view: AppView,
  identity: Identity,
): Promise<void> => {
  const path = appViewToUrlPath(view).substring(1);
  await page.goto(`${frontendUrl}${path}`);
  await page.applyConsoleFormatter();
  await waitForShellState(page, view);
  await login(page, identity);
  await waitForShellState(page, view, identity);
};

const isVoteColor = (value: unknown): value is VoteColor =>
  value === "green" || value === "yellow" || value === "red";

const toVote = (value: unknown): Vote => {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Vote is not an object: ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.voterName !== "string" ||
    typeof record.optionId !== "string" ||
    !isVoteColor(record.voteType)
  ) {
    throw new Error(`Invalid vote: ${JSON.stringify(value)}`);
  }
  return {
    voterName: record.voterName,
    optionId: record.optionId,
    voteType: record.voteType,
  };
};

const readVotes = async (page: Page): Promise<Vote[]> => {
  const votes = await page.evaluate(async () => {
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: {
        readCell?: (options?: { path?: string[] }) => Promise<unknown>;
      };
    }).commonfabric;
    if (!cf?.readCell) throw new Error("commonfabric.readCell unavailable");
    const value = await cf.readCell({ path: ["votes"] });
    if (!Array.isArray(value)) {
      throw new Error(`votes is not an array: ${JSON.stringify(value)}`);
    }
    return value;
  });
  return votes.map(toVote);
};

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

const waitForOptionIdForTitle = async (
  page: Page,
  title: string,
): Promise<string> => {
  let optionId: string | undefined;
  let lastError: unknown;
  await waitFor(
    async () => {
      try {
        optionId = await optionIdForTitle(page, title);
        return true;
      } catch (error) {
        lastError = error;
        return false;
      }
    },
    { timeout: OPTION_CARD_READY_TIMEOUT, delay: 250 },
  );
  if (!optionId) {
    throw new Error(`Option card id not ready for title: ${title}`, {
      cause: lastError,
    });
  }
  return optionId;
};

const voteSwatches = (page: Page): Promise<VoteSwatchSnapshot[]> =>
  page.evaluate(() => {
    const isVoteSwatchType = (value: string | null): value is
      | "green"
      | "yellow"
      | "red" => value === "green" || value === "yellow" || value === "red";
    const snapshots: VoteSwatchSnapshot[] = [];
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
          throw new Error(`Invalid vote swatch metadata: ${el.outerHTML}`);
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

const allPagesMatch = async (
  pages: readonly Page[],
  expectedVotes: readonly Vote[],
  expectedSwatches: readonly VoteSwatchSnapshot[],
): Promise<boolean> => {
  const [votesByPage, swatchesByPage] = await Promise.all([
    Promise.all(pages.map(readVotes)),
    Promise.all(pages.map(voteSwatches)),
  ]);
  return votesByPage.every((votes) =>
    JSON.stringify(normalizeVotes(votes)) ===
      JSON.stringify(normalizeVotes(expectedVotes))
  ) && swatchesByPage.every((swatches) =>
    JSON.stringify(normalizeSwatches(swatches)) ===
      JSON.stringify(normalizeSwatches(expectedSwatches))
  );
};

describe(
  `lunch poll: ${PROFILE_COUNT} voters plus fresh observer under contention`,
  () => {
    const voterShells = Array.from(
      { length: PROFILE_COUNT },
      () => new ShellIntegration(),
    );
    voterShells.forEach((shell) => shell.bindLifecycle());

    const userNames = Array.from(
      { length: PROFILE_COUNT },
      (_, index) => profileName(index),
    );

    let identities: Identity[];
    let cc: PiecesController;
    let pieceId: string;
    let resultSinkCancel: (() => void) | undefined;

    beforeAll(async () => {
      identities = await Promise.all(
        Array.from(
          { length: PROFILE_COUNT + 1 },
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
      resultSinkCancel = resultCell.sink(() => {});
    });

    afterAll(async () => {
      resultSinkCancel?.();
      if (pieceId) await cc?.remove(pieceId);
      await cc?.dispose();
    });

    it(`renders all stored swatches for a fresh observer after ${EXPECTED_VOTE_COUNT} contended votes`, async () => {
      const timer = new StepTimer();
      const view = { spaceName: SPACE_NAME, pieceId };
      const voterPages = voterShells.map((shell) => shell.page());
      const pageLabels = [...userNames, "Fresh observer"];
      const observerErrorLogs: string[] = [];
      const observerExceptions: string[] = [];
      let observerBrowser: Browser | undefined;
      let observerPage: Page | undefined;

      try {
        await timer.run(
          "navigate + login voter profiles",
          () =>
            Promise.all(voterShells.map((shell, index) =>
              shell.goto({
                frontendUrl: FRONTEND_URL,
                view,
                identity: identities[index],
              })
            )),
        );
        await timer.run(
          "runtime idle (voters)",
          () =>
            Promise.all(
              voterPages.map((page) =>
                waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT })
              ),
            ),
        );

        await fillCfInput(voterPages[0], "#lp-join-name", userNames[0]);
        await clickCfButton(voterPages[0], "#lp-join-button");
        await timer.run(
          "host joined",
          () =>
            waitForText(voterPages[0], "body", userNames[0], {
              timeout: PROPAGATION_TIMEOUT,
            }),
        );

        await timer.run(
          "remaining users join concurrently",
          async () => {
            await Promise.all(
              voterPages.slice(1).map(async (page, index) => {
                const name = userNames[index + 1];
                await fillCfInput(page, "#lp-join-name", name);
                await clickCfButton(page, "#lp-join-button");
              }),
            );
            await Promise.all(
              voterPages.map((page) =>
                waitForText(page, "body", `${PROFILE_COUNT} joined`, {
                  timeout: PROPAGATION_TIMEOUT,
                })
              ),
            );
          },
        );

        for (const title of OPTIONS) {
          await fillCfInput(voterPages[0], "#lp-add-option-input", title);
          await clickCfButton(voterPages[0], "#lp-add-option-button");
        }
        const optionIdsByPage = await timer.run(
          "all option cards ready on all profiles",
          () =>
            Promise.all(
              voterPages.map(async (page) => {
                const pageOptionIds = new Map<string, string>();
                for (const title of OPTIONS) {
                  pageOptionIds.set(
                    title,
                    await waitForOptionIdForTitle(page, title),
                  );
                }
                return pageOptionIds;
              }),
            ),
        );
        await Promise.all(
          voterPages.map((page) =>
            waitForRuntimeSynced(page, { timeout: PROPAGATION_TIMEOUT })
          ),
        );

        const optionIds = optionIdsByPage[0];

        const expectedVotes: Vote[] = [];
        const expectedSwatches: VoteSwatchSnapshot[] = [];
        for (let optionIndex = 0; optionIndex < OPTIONS.length; optionIndex++) {
          const optionTitle = OPTIONS[optionIndex];
          await timer.run(
            `vote ${optionTitle} (${PROFILE_COUNT} clicks)`,
            () =>
              Promise.all(
                voterPages.map((page, userIndex) => {
                  const optionId = optionIds.get(optionTitle);
                  if (!optionId) {
                    throw new Error(`Missing option id: ${optionTitle}`);
                  }
                  const voteType = VOTE_TYPES[
                    (optionIndex + userIndex) % VOTE_TYPES.length
                  ];
                  expectedVotes.push({
                    voterName: userNames[userIndex],
                    optionId,
                    voteType,
                  });
                  expectedSwatches.push({
                    name: userNames[userIndex],
                    optionId,
                    optionTitle,
                    voteType,
                  });
                  return clickCfButton(page, voteButton(optionTitle, voteType));
                }),
              ),
          );
        }

        await timer.run(
          "active voters agree on stored votes and displayed swatches",
          () =>
            waitFor(
              () => allPagesMatch(voterPages, expectedVotes, expectedSwatches),
              { timeout: PROPAGATION_TIMEOUT, delay: 500 },
            ),
        );

        await Promise.all(
          voterPages.map((page) =>
            waitForRuntimeSynced(page, { timeout: PROPAGATION_TIMEOUT })
          ),
        );

        await timer.run(
          "fresh observer loads completed poll",
          async () => {
            observerBrowser = await Browser.launch({ headless: env.HEADLESS });
            observerPage = await observerBrowser.newPage();
            attachObserverDiagnostics(
              observerPage,
              observerErrorLogs,
              observerExceptions,
            );
            await gotoFreshObserver(
              observerPage,
              FRONTEND_URL,
              view,
              identities[PROFILE_COUNT],
            );
            await waitForRuntimeIdle(observerPage, {
              timeout: PROPAGATION_TIMEOUT,
            });
            await waitForRuntimeSynced(observerPage, {
              timeout: PROPAGATION_TIMEOUT,
            });
          },
        );

        await timer.run(
          "fresh observer displays every stored swatch",
          () =>
            waitFor(
              () =>
                observerPage
                  ? allPagesMatch(
                    [observerPage],
                    expectedVotes,
                    expectedSwatches,
                  )
                  : Promise.resolve(false),
              { timeout: PROPAGATION_TIMEOUT, delay: 500 },
            ),
        );

        if (!observerPage) {
          throw new Error("Fresh observer page was not initialized");
        }

        const checkedPages = [...voterPages, observerPage];

        const [votesByPage, swatchesByPage] = await Promise.all([
          Promise.all(checkedPages.map(readVotes)),
          Promise.all(checkedPages.map(voteSwatches)),
        ]);
        votesByPage.forEach((votes, index) =>
          assertVoteSet(
            votes,
            expectedVotes,
            `${pageLabels[index]} stored votes`,
          )
        );
        swatchesByPage.forEach((swatches, index) =>
          assertSwatchSet(
            swatches,
            expectedSwatches,
            `${pageLabels[index]} displayed swatches`,
          )
        );
        await timer.run(
          "all checked browsers show aggregate count",
          () =>
            Promise.all(
              checkedPages.map((page) =>
                waitForText(page, "body", `${EXPECTED_VOTE_COUNT} votes`, {
                  timeout: PROPAGATION_TIMEOUT,
                })
              ),
            ),
        );
        assertNoObserverDiagnostics(observerErrorLogs, observerExceptions);
      } finally {
        logStepTimings(
          `lunch-poll contention ${PROFILE_COUNT}-voter fresh-observer`,
          timer,
        );
        const summaryPages = [...voterPages];
        const summaryLabels = [...userNames];
        if (observerPage) {
          summaryPages.push(observerPage);
          summaryLabels.push("Fresh observer");
        }
        const summaries = await Promise.all(
          summaryPages.map((page, index) =>
            collectBrowserLoadSummary(page, summaryLabels[index]).catch(() =>
              undefined
            )
          ),
        );
        for (const summary of summaries) {
          if (summary) logBrowserLoadSummary(summary);
        }
        if (observerPage) {
          await observerPage.evaluate(async () => {
            await globalThis.commonfabric?.rt?.dispose();
            if (globalThis.commonfabric) {
              globalThis.commonfabric.rt = undefined;
            }
          }).catch(() => {});
          await observerPage.close().catch(() => {});
        }
        await observerBrowser?.close().catch(() => {});
      }
    });
  },
);
