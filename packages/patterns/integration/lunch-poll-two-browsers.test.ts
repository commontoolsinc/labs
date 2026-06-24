/**
 * Browser repro for lunch-poll All Options vote-swatch desync.
 *
 * This intentionally exercises the real shell + VDOM/browser path instead of
 * the headless multi-runtime harness. The live incident shape was: the shared
 * cell contained all votes and the header showed the full count, but some
 * rows under All Options missed voter swatches. This test compares the header,
 * rendered All Options rows, debug VDOM, and cell state after several browser
 * profiles vote through the rendered controls.
 */

import {
  awaitViewSettled,
  env,
  Page,
  waitFor,
} from "@commonfabric/integration";
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
  collectBrowserLoadSummary,
  fillCfInput,
  logBrowserLoadSummary,
  logStepTimings,
  StepTimer,
  waitForRuntimeIdle,
  waitForRuntimeSynced,
} from "./cfc-browser-helpers.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME, CFC_BROWSER_PROFILE_COUNT } = env;
const PROPAGATION_TIMEOUT = 90_000;
const PROFILE_COUNT = Math.max(3, CFC_BROWSER_PROFILE_COUNT);
const USER_NAMES = ["Alice", "Bob", "Carol", "Dave", "Erin", "Frank"];

type PollOptionState = {
  id: string;
  title: string;
  addedByName: string;
};

type PollVoteState = {
  optionId: string;
  optionTitle: string;
  voterName: string;
  voteType: string;
};

type PollCellSummary = {
  users: number;
  options: number;
  votes: number;
  distinctVoters: number;
  adminName: string;
  myName: string;
  isJoined: boolean | undefined;
  isAdmin: boolean | undefined;
  voteCount: number | undefined;
  userCount: number | undefined;
  optionCount: number | undefined;
  optionDetails: PollOptionState[];
  voteDetails: PollVoteState[];
  votersByTitle: Record<string, string[]>;
  voteTypesByTitle: Record<string, Record<string, string>>;
};

type VDomSwatchSummary = {
  count: number;
  names: string[];
  samples: string[];
};

type OptionSwatchSummary = {
  optionId: string;
  optionTitle: string;
  swatches: string[];
};

type OptionCardSummary = {
  optionId: string;
  optionTitle: string;
  myVote: string;
  voteControls: string[];
};

type ExpectedPollMatrix = {
  names: readonly string[];
  optionTitles: readonly string[];
  adminName: string;
  votersByTitle: Record<string, readonly string[]>;
};

type RenderedPollSnapshot = {
  pollSummary: string;
  viewerSummary: { name: string; hostChipVisible: boolean };
  topChoice: { title: string; summary: string };
  optionCards: OptionCardSummary[];
  allOptionsRows: OptionSwatchSummary[];
};

type DebugVDomPollSnapshot = RenderedPollSnapshot & {
  swatches: string[];
};

type BrowserRuntimeDiagnostics = {
  href: string;
  visibilityState: string;
  performanceMemory?: {
    jsHeapSizeLimit?: number;
    totalJSHeapSize?: number;
    usedJSHeapSize?: number;
  };
  loggerCounts?: unknown;
  timingStats?: unknown;
  nonIdempotent?: unknown;
  error?: string;
};

describe(
  `lunch poll browser vote summary with ${PROFILE_COUNT} profiles`,
  () => {
    const shells = Array.from(
      { length: PROFILE_COUNT },
      () => new ShellIntegration(),
    );
    shells.forEach((shell) => shell.bindLifecycle());

    let identities: Identity[];
    let cc: PiecesController;
    let pieceId: string;
    let pieceSinkCancel: (() => void) | undefined;
    let uiSinkCancel: (() => void) | undefined;
    let latestVDomSwatches: VDomSwatchSummary = emptyVDomSwatchSummary();
    let readVDomSwatches = () => latestVDomSwatches;
    let readRuntimePollSummary = () => summarizePollValue(undefined);
    let readMemoryPollSummary = () => summarizePollValue(undefined);

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
        "lunch-poll",
        "main.tsx",
      );
      const rootPath = join(import.meta.dirname!, "..");
      const program = await cc.manager().runtime.harness.resolve(
        new FileSystemProgramResolver(sourcePath, rootPath),
      );
      const piece = await cc.create(program, { start: true });
      pieceId = piece.id;
      const pieceCell = piece.getCell();
      const resultCell = cc.manager().getResult(pieceCell);
      const debugVDomCell = resultCell.key(UI).asSchema(debugVDOMSchema);
      pieceSinkCancel = resultCell.sink(() => {});
      uiSinkCancel = debugVDomCell.sink(
        (vdom) => {
          latestVDomSwatches = collectVDomSwatches(vdom);
        },
      );
      readVDomSwatches = () => collectVDomSwatches(debugVDomCell.get());
      readRuntimePollSummary = () => summarizePollValue(resultCell.get());
      readMemoryPollSummary = () => summarizePollValue(pieceCell.get());
    });

    afterAll(async () => {
      uiSinkCancel?.();
      pieceSinkCancel?.();
      await cc?.dispose();
    });

    it("keeps header summary, voter chips, and cell state in sync", async () => {
      const timer = new StepTimer();
      const view = { spaceName: SPACE_NAME, pieceId };
      const pages = shells.map((shell) => shell.page());
      const names = pages.map((_, index) =>
        USER_NAMES[index] ?? `User ${index + 1}`
      );
      const optionTitles = names.map((name) => `${name}'s option`);
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
        await Promise.all(pages.map(installProbeHelpers));
        await settleAll(pages);

        await timer.run(
          "join all profiles",
          async () => {
            for (let index = 0; index < pages.length; index++) {
              await fillInputByAria(pages[index], "Your name", names[index]);
              await clickButtonByText(pages[index], "Join");
              await waitForDeepText(pages[index], names[index]);
              await settleAll(pages);
            }
          },
        );

        await timer.run(
          "clients rotate host and add options",
          async () => {
            for (let index = 0; index < pages.length; index++) {
              if (index > 0) {
                await clickButtonByText(pages[index], "Become host");
                await settleAll(pages);
                await waitForPollMatrixConvergence(
                  pages,
                  {
                    names,
                    optionTitles: optionTitles.slice(0, index),
                    adminName: names[index],
                    votersByTitle: emptyVotersByTitle(
                      optionTitles.slice(0, index),
                    ),
                  },
                  readRuntimePollSummary,
                  readMemoryPollSummary,
                );
              }

              await fillInputByAria(
                pages[index],
                "Option title",
                optionTitles[index],
              );
              await clickButtonByText(pages[index], "Add");
              await settleAll(pages);
              await waitForPollMatrixConvergence(
                pages,
                {
                  names,
                  optionTitles: optionTitles.slice(0, index + 1),
                  adminName: names[index],
                  votersByTitle: emptyVotersByTitle(
                    optionTitles.slice(0, index + 1),
                  ),
                },
                readRuntimePollSummary,
                readMemoryPollSummary,
              );
            }
          },
        );

        await timer.run(
          "every client sees every added option",
          async () => {
            await Promise.all(
              pages.map((page) =>
                Promise.all(
                  optionTitles.map((title) => waitForDeepText(page, title)),
                )
              ),
            );
          },
        );

        await timer.run(
          "all profiles vote all options",
          async () => {
            for (let index = 0; index < pages.length; index++) {
              for (const optionTitle of optionTitles) {
                await clickVoteByOptionTitle(
                  pages[index],
                  optionTitle,
                  "Love it",
                );
              }
              await settleAll(pages);
              await waitForPollMatrixConvergence(
                pages,
                {
                  names,
                  optionTitles,
                  adminName: names.at(-1)!,
                  votersByTitle: votersByTitleFor(
                    optionTitles,
                    names.slice(0, index + 1),
                  ),
                },
                readRuntimePollSummary,
                readMemoryPollSummary,
              );
            }
          },
        );

        await timer.run(
          "header/chips/cell convergence",
          async () => {
            try {
              await settleAll(pages);
              const expectedVotes = PROFILE_COUNT * optionTitles.length;
              const expectedHeader =
                `${PROFILE_COUNT} joined · ${optionTitles.length} options · ${expectedVotes} votes`;
              await Promise.all(
                pages.map((page) => waitForDeepText(page, expectedHeader)),
              );
              await Promise.all(
                pages.map((page) =>
                  Promise.all(
                    names.map((name) => waitForVoteSwatch(page, name)),
                  )
                ),
              );
              await Promise.all(
                pages.map((page) =>
                  waitFor(async () => {
                    const rows = await readRenderedAllOptionsSwatches(page);
                    return rows.length === optionTitles.length &&
                      rows.every((row) =>
                        row.swatches.length === PROFILE_COUNT &&
                        sameStringSet(row.swatches, names)
                      );
                  }, { timeout: PROPAGATION_TIMEOUT, delay: 250 })
                ),
              );
              const renderedSwatches = await Promise.all(
                pages.map(readRenderedVoteSwatches),
              );
              for (const swatches of renderedSwatches) {
                assertEquals(swatches.length, expectedVotes);
                assertEquals([...new Set(swatches)].sort(), [...names].sort());
              }
              const allOptionsRows = await Promise.all(
                pages.map(readRenderedAllOptionsSwatches),
              );
              for (const rows of allOptionsRows) {
                assertEquals(rows.length, optionTitles.length);
                for (const row of rows) {
                  assertEquals(
                    row.swatches.length,
                    PROFILE_COUNT,
                    row.optionTitle,
                  );
                  assertEquals(
                    [...row.swatches].sort(),
                    [...names].sort(),
                    row.optionTitle,
                  );
                }
              }
              await waitFor(
                async () => {
                  latestVDomSwatches = readVDomSwatches();
                  return latestVDomSwatches.count === expectedVotes;
                },
                { timeout: PROPAGATION_TIMEOUT, delay: 250 },
              );
              assertEquals(
                [...latestVDomSwatches.names].sort(),
                [...names].sort(),
              );

              const summaries = await Promise.all(
                pages.map(readPollCellSummary),
              );
              for (let index = 0; index < summaries.length; index++) {
                assertEquals(summaries[index].users, PROFILE_COUNT);
                assertEquals(summaries[index].options, optionTitles.length);
                assertEquals(summaries[index].votes, expectedVotes);
                assertEquals(summaries[index].distinctVoters, PROFILE_COUNT);
                assertEquals(summaries[index].voteCount, expectedVotes);
                assertEquals(summaries[index].userCount, PROFILE_COUNT);
                assertEquals(summaries[index].optionCount, optionTitles.length);
                assertEquals(summaries[index].myName, names[index]);
              }
            } catch (error) {
              console.log("Convergence diagnostics:", {
                summaries: await Promise.all(
                  pages.map((page) =>
                    readPollCellSummary(page).catch((cause) => ({
                      error: String(cause),
                    }))
                  ),
                ),
                snapshots: await Promise.all(
                  pages.map((page) =>
                    page.evaluate(() => globalThis.__lunchPollProbe.snapshot())
                  ),
                ),
                debugVDOM: latestVDomSwatches,
              });
              throw error;
            }
          },
        );
      } finally {
        logStepTimings(`lunch-poll ${PROFILE_COUNT}-profile`, timer);
        const summaries = await Promise.all(
          pages.map((page, index) =>
            collectBrowserLoadSummary(page, names[index]).catch(() => undefined)
          ),
        );
        for (const summary of summaries) {
          if (summary) logBrowserLoadSummary(summary);
        }
      }
    });
  },
);

describe("lunch poll first host empty options browser flow", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;
  let pieceSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
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
    pieceId = piece.id;
    pieceSinkCancel = cc.manager().getResult(piece.getCell()).sink(() => {});
  });

  afterAll(async () => {
    pieceSinkCancel?.();
    await cc?.dispose();
  });

  it("lets the first joiner become host and add the first option", async () => {
    const page = shell.page();
    const hostName = "Alice Host";
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity,
    });
    await installProbeHelpers(page);
    await settleAll([page]);

    await waitForDeepText(page, "No options yet");
    await waitForDeepText(page, "Waiting for a host to join.");

    await fillInputByAria(page, "Your name", hostName);
    await clickButtonByText(page, "Join");
    await settleAll([page]);

    await waitForDeepText(page, "HOST");
    await waitForDeepText(page, "Host controls");
    await waitForDeepText(page, "Add the first one above.");

    const snapshot = await page.evaluate(() =>
      globalThis.__lunchPollProbe.snapshot()
    );
    assertEquals(
      snapshot.normalizedText.includes("Waiting for a host to join."),
      false,
    );

    const joinedSummary = await readPollCellSummary(page);
    assertEquals(joinedSummary.users, 1);
    assertEquals(joinedSummary.options, 0);
    assertEquals(joinedSummary.votes, 0);
    assertEquals(joinedSummary.myName, hostName);
    assertEquals(joinedSummary.isJoined, true);
    assertEquals(joinedSummary.isAdmin, true);
    assertEquals(joinedSummary.userCount, 1);
    assertEquals(joinedSummary.optionCount, 0);
    assertEquals(joinedSummary.voteCount, 0);

    const firstOption = "First host option";
    await fillInputByAria(page, "Option title", firstOption);
    await clickButtonByText(page, "Add");
    await settleAll([page]);
    await waitForDeepText(page, "All options");
    await waitForDeepText(page, firstOption);

    const addedSummary = await readPollCellSummary(page);
    assertEquals(addedSummary.options, 1);
    assertEquals(addedSummary.optionCount, 1);
    assertEquals(addedSummary.votes, 0);
    assertEquals(addedSummary.voteCount, 0);
  });
});

async function settleAll(pages: readonly Page[]): Promise<void> {
  await Promise.all(pages.map(async (page) => {
    await waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT });
    await waitForRuntimeSynced(page, { timeout: PROPAGATION_TIMEOUT });
    await waitForRuntimeIdle(page, { timeout: PROPAGATION_TIMEOUT });
    await waitFor(() => awaitViewSettled(page), {
      timeout: PROPAGATION_TIMEOUT,
      delay: 250,
    });
  }));
}

async function fillInputByAria(
  page: Page,
  ariaLabel: string,
  value: string,
): Promise<void> {
  const selector = ariaLabel === "Option title"
    ? `cf-input[aria-label^="Option title"], cf-input[aria-label^="Add an option"]`
    : `cf-input[aria-label^="${ariaLabel}"]`;
  try {
    await fillCfInput(
      page,
      selector,
      value,
      { timeout: PROPAGATION_TIMEOUT },
    );
  } catch (cause) {
    const snapshot = await page.evaluate(() =>
      globalThis.__lunchPollProbe
        ?.snapshot()
    ).catch(() => undefined);
    throw new Error(
      `Unable to fill input ${ariaLabel}. Snapshot: ${
        JSON.stringify(snapshot)
      }`,
      { cause },
    );
  }
}

async function clickButtonByText(page: Page, text: string): Promise<void> {
  await page.evaluate(async (label) => {
    await globalThis.__lunchPollProbe.clickButtonByText(label);
  }, { args: [text] });
}

async function clickAllByAriaLabel(
  page: Page,
  ariaLabel: string,
): Promise<void> {
  await page.evaluate(async (label) => {
    await globalThis.__lunchPollProbe.clickAllByAriaLabel(label);
  }, { args: [ariaLabel] });
}

async function clickVoteByOptionTitle(
  page: Page,
  optionTitle: string,
  ariaLabel: string,
): Promise<void> {
  await page.evaluate(async ([title, label]) => {
    await globalThis.__lunchPollProbe.clickVoteByOptionTitle(title, label);
  }, { args: [[optionTitle, ariaLabel]] });
}

async function waitForDeepText(page: Page, text: string): Promise<void> {
  await waitFor(
    () =>
      page.evaluate(
        (expected) => globalThis.__lunchPollProbe.hasText(expected),
        {
          args: [text],
        },
      ),
    { timeout: PROPAGATION_TIMEOUT, delay: 250 },
  );
}

async function waitForVoteSwatch(page: Page, voterName: string): Promise<void> {
  await waitFor(
    () =>
      page.evaluate((name) => globalThis.__lunchPollProbe.hasVoteSwatch(name), {
        args: [voterName],
      }),
    { timeout: PROPAGATION_TIMEOUT, delay: 250 },
  );
}

async function readRenderedVoteSwatches(page: Page): Promise<string[]> {
  return await page.evaluate(() =>
    globalThis.__lunchPollProbe.snapshot().swatches
  );
}

async function readRenderedAllOptionsSwatches(
  page: Page,
): Promise<OptionSwatchSummary[]> {
  return await page.evaluate(() =>
    globalThis.__lunchPollProbe.snapshot().allOptionsRows
  );
}

async function readRenderedPollSummary(page: Page): Promise<string> {
  return await page.evaluate(() =>
    globalThis.__lunchPollProbe.snapshot().pollSummary
  );
}

async function readRenderedViewerSummary(
  page: Page,
): Promise<{ name: string; hostChipVisible: boolean }> {
  return await page.evaluate(() =>
    globalThis.__lunchPollProbe.snapshot().viewerSummary
  );
}

async function collectBrowserRuntimeDiagnostics(
  page: Page,
): Promise<BrowserRuntimeDiagnostics> {
  return await page.evaluate(async () => {
    type PerformanceWithMemory = Performance & {
      memory?: {
        jsHeapSizeLimit?: number;
        totalJSHeapSize?: number;
        usedJSHeapSize?: number;
      };
    };
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: {
        getLoggerCountsBreakdown?: () => unknown;
        getTimingStatsBreakdown?: () => unknown;
        detectNonIdempotent?: (durationMs?: number) => Promise<unknown>;
      };
    }).commonfabric;
    const memory = (performance as PerformanceWithMemory).memory;
    const diagnostics: BrowserRuntimeDiagnostics = {
      href: location.href,
      visibilityState: document.visibilityState,
      performanceMemory: memory
        ? {
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
          totalJSHeapSize: memory.totalJSHeapSize,
          usedJSHeapSize: memory.usedJSHeapSize,
        }
        : undefined,
      loggerCounts: cf?.getLoggerCountsBreakdown?.(),
      timingStats: cf?.getTimingStatsBreakdown?.(),
    };
    if (cf?.detectNonIdempotent) {
      try {
        diagnostics.nonIdempotent = await cf.detectNonIdempotent(1_000);
      } catch (error) {
        diagnostics.nonIdempotent = { error: String(error) };
      }
    }
    return diagnostics;
  });
}

function sameStringSet(actual: readonly string[], expected: readonly string[]) {
  return actual.length === expected.length &&
    [...actual].sort().every((value, index) =>
      value === [...expected].sort()[index]
    );
}

function emptyVotersByTitle(
  optionTitles: readonly string[],
): Record<string, readonly string[]> {
  const votersByTitle: Record<string, readonly string[]> = {};
  for (const title of optionTitles) votersByTitle[title] = [];
  return votersByTitle;
}

function votersByTitleFor(
  optionTitles: readonly string[],
  voters: readonly string[],
): Record<string, readonly string[]> {
  const votersByTitle: Record<string, readonly string[]> = {};
  for (const title of optionTitles) votersByTitle[title] = voters;
  return votersByTitle;
}

function expectedVoteCount(expected: ExpectedPollMatrix): number {
  return Object.values(expected.votersByTitle).reduce(
    (total, voters) => total + voters.length,
    0,
  );
}

function pollStateMatches(
  actual: PollCellSummary,
  expected: ExpectedPollMatrix,
): boolean {
  const voteCount = expectedVoteCount(expected);
  if (actual.users !== expected.names.length) return false;
  if (actual.options !== expected.optionTitles.length) return false;
  if (actual.votes !== voteCount) return false;
  if (actual.userCount !== expected.names.length) return false;
  if (actual.optionCount !== expected.optionTitles.length) return false;
  if (actual.voteCount !== voteCount) return false;
  if (actual.adminName !== expected.adminName) return false;
  if (
    !sameStringSet(
      actual.optionDetails.map((option) => option.title),
      expected.optionTitles,
    )
  ) return false;
  for (const title of expected.optionTitles) {
    const expectedVoters = expected.votersByTitle[title] ?? [];
    if (!sameStringSet(actual.votersByTitle[title] ?? [], expectedVoters)) {
      return false;
    }
    for (const voter of expectedVoters) {
      if (actual.voteTypesByTitle[title]?.[voter] !== "green") return false;
    }
  }
  return true;
}

function renderedPollMatches(
  snapshot: RenderedPollSnapshot,
  expected: ExpectedPollMatrix,
  viewerName: string,
): boolean {
  const voteCount = expectedVoteCount(expected);
  const expectedSummaryBase =
    `${expected.names.length} joined · ${expected.optionTitles.length} options · ${voteCount} votes`;
  if (!snapshot.pollSummary.includes(expectedSummaryBase)) return false;
  const hostedBy = `hosted by ${expected.adminName}`;
  if (expected.adminName !== "" && viewerName !== expected.adminName) {
    if (!snapshot.pollSummary.includes(hostedBy)) return false;
  }
  if (
    expected.adminName !== "" &&
    snapshot.pollSummary.includes("hosted by") &&
    !snapshot.pollSummary.includes(hostedBy)
  ) return false;
  if (snapshot.viewerSummary.name !== viewerName) return false;
  if (
    snapshot.viewerSummary.hostChipVisible !==
      (viewerName === expected.adminName)
  ) {
    return false;
  }
  if (
    !sameStringSet(
      snapshot.optionCards.map((card) => card.optionTitle),
      expected.optionTitles,
    )
  ) return false;
  for (const title of expected.optionTitles) {
    const card = snapshot.optionCards.find((candidate) =>
      candidate.optionTitle === title
    );
    if (!card) return false;
    if (!sameStringSet(card.voteControls, ["green", "yellow", "red"])) {
      return false;
    }
  }
  if (snapshot.allOptionsRows.length !== expected.optionTitles.length) {
    return false;
  }
  for (const title of expected.optionTitles) {
    const row = snapshot.allOptionsRows.find((candidate) =>
      candidate.optionTitle === title
    );
    if (!row) return false;
    if (!sameStringSet(row.swatches, expected.votersByTitle[title] ?? [])) {
      return false;
    }
  }
  if (voteCount === 0) return snapshot.topChoice.title === "";
  const firstOption = expected.optionTitles[0];
  const firstOptionVoters = expected.votersByTitle[firstOption] ?? [];
  return snapshot.topChoice.title === firstOption &&
    snapshot.topChoice.summary === `${firstOptionVoters.length} love it`;
}

function summarizeForDiagnostics(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("error" in value) return value;
  const summary = value as Partial<PollCellSummary>;
  return {
    users: summary.users,
    options: summary.options,
    votes: summary.votes,
    adminName: summary.adminName,
    myName: summary.myName,
    isAdmin: summary.isAdmin,
    voteCount: summary.voteCount,
    userCount: summary.userCount,
    optionCount: summary.optionCount,
    optionTitles: summary.optionDetails?.map((option) => option.title),
    votersByTitle: summary.votersByTitle,
  };
}

function summarizeSnapshotForDiagnostics(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if ("error" in value) return value;
  const snapshot = value as Partial<RenderedPollSnapshot>;
  return {
    pollSummary: snapshot.pollSummary,
    viewerSummary: snapshot.viewerSummary,
    topChoice: snapshot.topChoice,
    optionCards: snapshot.optionCards,
    allOptionsRows: snapshot.allOptionsRows,
  };
}

async function waitForPollMatrixConvergence(
  pages: readonly Page[],
  expected: ExpectedPollMatrix,
  readRuntimePollSummary: () => PollCellSummary,
  readMemoryPollSummary: () => PollCellSummary,
): Promise<void> {
  try {
    await Promise.all([
      ...pages.map((page, index) =>
        waitFor(async () => {
          const state = await readPollCellSummary(page);
          await drainRuntimeAndView(page);
          const snapshot = await page.evaluate(() =>
            globalThis.__lunchPollProbe.snapshot()
          );
          return pollStateMatches(state, expected) &&
            renderedPollMatches(snapshot, expected, expected.names[index]);
        }, { timeout: PROPAGATION_TIMEOUT, delay: 250 })
      ),
      waitFor(
        async () => pollStateMatches(readRuntimePollSummary(), expected),
        { timeout: PROPAGATION_TIMEOUT, delay: 250 },
      ),
      waitFor(
        async () => pollStateMatches(readMemoryPollSummary(), expected),
        { timeout: PROPAGATION_TIMEOUT, delay: 250 },
      ),
    ]);
  } catch (cause) {
    const pageDiagnostics = await Promise.all(
      pages.map(async (page, index) => {
        const state = await readPollCellSummary(page).catch((error) => ({
          error: String(error),
        }));
        const snapshot = await page.evaluate(() =>
          globalThis.__lunchPollProbe.snapshot()
        ).catch((error) => ({ error: String(error) }));
        const debugVDOM = await readPageDebugVDOM(page)
          .then(summarizeVDomForDiagnostics)
          .catch((error) => ({ error: String(error) }));
        const runtimeDiagnostics = await collectBrowserRuntimeDiagnostics(page)
          .catch((error) => ({
            href: "",
            visibilityState: "",
            error: String(error),
          }));
        return {
          index,
          expectedViewer: expected.names[index],
          state: summarizeForDiagnostics(state),
          snapshot: summarizeSnapshotForDiagnostics(snapshot),
          debugVDOM,
          runtimeDiagnostics,
        };
      }),
    );
    console.log(
      "Poll matrix convergence diagnostics:",
      JSON.stringify(
        {
          expected,
          runtime: summarizeForDiagnostics(readRuntimePollSummary()),
          memory: summarizeForDiagnostics(readMemoryPollSummary()),
          pages: pageDiagnostics,
        },
        null,
        2,
      ),
    );
    throw cause;
  }
}

async function drainRuntimeAndView(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const rt = (globalThis as typeof globalThis & {
      commonfabric?: {
        rt?: { idle?: () => Promise<void> };
        viewSettled?: () => Promise<void>;
      };
    }).commonfabric;
    await rt?.rt?.idle?.();
    await rt?.viewSettled?.();
  });
}

async function readPageDebugVDOM(page: Page): Promise<unknown> {
  return await page.evaluate(async () => {
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: { vdom?: { tree?: () => Promise<unknown> } };
    }).commonfabric;
    return await cf?.vdom?.tree?.();
  });
}

async function installProbeHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = async () => {
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      );
    };
    const findAllDeep = <T extends Element>(
      root: Document | ShadowRoot | Element,
      predicate: (element: Element) => boolean,
    ): T[] => {
      const matches: T[] = [];
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (predicate(element)) matches.push(element as T);
        if (element.shadowRoot) {
          matches.push(...findAllDeep<T>(element.shadowRoot, predicate));
        }
      }
      return matches;
    };
    const findDeep = <T extends Element>(
      root: Document | ShadowRoot | Element,
      predicate: (element: Element) => boolean,
    ): T | undefined => findAllDeep<T>(root, predicate)[0];
    const deepText = (root: Document | ShadowRoot | Element): string => {
      let text = "";
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        text += `\n${walker.currentNode.textContent ?? ""}`;
      }
      for (const element of Array.from(root.querySelectorAll("*"))) {
        if (element.shadowRoot) text += `\n${deepText(element.shadowRoot)}`;
      }
      return text;
    };
    const normalizeText = (text: string) => text.replace(/\s+/g, " ").trim();
    globalThis.__lunchPollProbe = {
      async clickButtonByText(label: string) {
        const button = findDeep<HTMLElement>(document, (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const tag = element.tagName.toLowerCase();
          if (tag !== "button" && tag !== "cf-button") return false;
          return deepText(element).trim() === label;
        });
        if (!button) throw new Error(`Button not found: ${label}`);
        button.scrollIntoView({ block: "center", inline: "center" });
        await frame();
        const target = button.shadowRoot?.querySelector("[data-cf-button]");
        if (target instanceof HTMLElement) target.click();
        else button.click();
      },
      async clickAllByAriaLabel(label: string) {
        const fallbackText = label === "Love it" ? "🟢" : label;
        const buttons = findAllDeep<HTMLElement>(document, (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const tag = element.tagName.toLowerCase();
          if (tag !== "button" && tag !== "cf-button") return false;
          return element.getAttribute("aria-label") === label ||
            deepText(element).trim() === fallbackText;
        });
        if (buttons.length === 0) {
          throw new Error(`No controls found with aria-label: ${label}`);
        }
        for (const button of buttons) {
          button.scrollIntoView({ block: "center", inline: "center" });
          await frame();
          const target = button.shadowRoot?.querySelector("[data-cf-button]");
          if (target instanceof HTMLElement) target.click();
          else button.click();
          await frame();
        }
      },
      async clickVoteByOptionTitle(optionTitle: string, label: string) {
        const card = findDeep<HTMLElement>(
          document,
          (element) =>
            element instanceof HTMLElement &&
            element.getAttribute("data-option-card") === "true" &&
            element.getAttribute("data-option-card-title") === optionTitle,
        );
        if (!card) throw new Error(`Option card not found: ${optionTitle}`);
        const fallbackText = label === "Love it" ? "🟢" : label;
        const button = findDeep<HTMLElement>(card, (element) => {
          if (!(element instanceof HTMLElement)) return false;
          const tag = element.tagName.toLowerCase();
          if (tag !== "button" && tag !== "cf-button") return false;
          if (
            label === "Love it" &&
            element.getAttribute("data-vote-control") === "green"
          ) {
            return true;
          }
          return element.getAttribute("aria-label") === label ||
            deepText(element).trim() === fallbackText;
        });
        if (!button) {
          throw new Error(`Vote control not found: ${optionTitle} / ${label}`);
        }
        button.scrollIntoView({ block: "center", inline: "center" });
        await frame();
        const target = button.shadowRoot?.querySelector("[data-cf-button]");
        if (target instanceof HTMLElement) target.click();
        else button.click();
        await frame();
      },
      hasText(expected: string) {
        return normalizeText(deepText(document)).includes(
          normalizeText(expected),
        );
      },
      hasVoteSwatch(name: string) {
        return findDeep<HTMLElement>(
          document,
          (element) =>
            element instanceof HTMLElement &&
            element.getAttribute("data-vote-swatch-name") === name,
        ) !== undefined;
      },
      snapshot() {
        const tags: string[] = [];
        const labels: string[] = [];
        const collect = (root: Document | ShadowRoot) => {
          for (const element of root.querySelectorAll("*")) {
            const tag = element.tagName.toLowerCase();
            if (tag.includes("cf-") || element.id) {
              tags.push(`${tag}${element.id ? `#${element.id}` : ""}`);
            }
            const label = element.getAttribute("aria-label");
            if (label) labels.push(`${tag}:${label}`);
            if (element.shadowRoot) collect(element.shadowRoot);
          }
        };
        collect(document);
        return {
          bodyText: document.body?.innerText ?? "",
          deepText: deepText(document).slice(0, 4000),
          normalizedText: normalizeText(deepText(document)).slice(0, 4000),
          pollSummary: normalizeText(
            findDeep<HTMLElement>(
              document,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-poll-summary") === "true",
            )?.textContent ?? "",
          ),
          viewerSummary: (() => {
            const hostChip = findDeep<HTMLElement>(
              document,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-viewer-host-chip") === "true",
            );
            const name = findDeep<HTMLElement>(
              document,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-viewer-name") !== null,
            )?.getAttribute("data-viewer-name") ?? "";
            const style = hostChip ? getComputedStyle(hostChip) : undefined;
            return {
              name,
              hostChipVisible: !!hostChip && style?.display !== "none" &&
                style?.visibility !== "hidden",
            };
          })(),
          topChoice: (() => {
            const card = findDeep<HTMLElement>(
              document,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-top-choice") === "true",
            );
            return {
              title: card?.getAttribute("data-top-choice-title") ?? "",
              summary: card?.getAttribute("data-top-choice-summary") ?? "",
            };
          })(),
          optionCards: findAllDeep<HTMLElement>(
            document,
            (element) =>
              element instanceof HTMLElement &&
              element.getAttribute("data-option-card") === "true",
          ).map((card) => ({
            optionId: card.getAttribute("data-option-card-id") ?? "",
            optionTitle: card.getAttribute("data-option-card-title") ?? "",
            myVote: card.getAttribute("data-option-card-my-vote") ?? "",
            me: card.getAttribute("data-option-card-me") ?? "",
            isJoined: card.getAttribute("data-option-card-is-joined") ?? "",
            isAdmin: card.getAttribute("data-option-card-is-admin") ?? "",
            voteControls: findAllDeep<HTMLElement>(
              card,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-vote-control") !== null,
            ).map((element) => element.getAttribute("data-vote-control") ?? ""),
          })),
          swatches: findAllDeep<HTMLElement>(
            document,
            (element) =>
              element instanceof HTMLElement &&
              element.getAttribute("data-vote-swatch-name") !== null,
          ).map((element) =>
            element.getAttribute("data-vote-swatch-name") ?? ""
          ),
          allOptionsRows: findAllDeep<HTMLElement>(
            document,
            (element) =>
              element instanceof HTMLElement &&
              element.getAttribute("data-all-options-row") === "true",
          ).map((row) => ({
            optionId: row.getAttribute("data-option-id") ?? "",
            optionTitle: row.getAttribute("data-option-title") ?? "",
            swatches: findAllDeep<HTMLElement>(
              row,
              (element) =>
                element instanceof HTMLElement &&
                element.getAttribute("data-vote-swatch-name") !== null,
            ).map((element) =>
              element.getAttribute("data-vote-swatch-name") ?? ""
            ),
          })),
          tags: tags.slice(0, 200),
          labels,
        };
      },
    };
  });
}

async function readPollCellSummary(page: Page): Promise<PollCellSummary> {
  return await page.evaluate(async () => {
    const isBrowserRecord = (
      value: unknown,
    ): value is Record<string, unknown> =>
      value !== null && typeof value === "object";
    const cf = (globalThis as typeof globalThis & {
      commonfabric?: { readCell?: () => Promise<unknown> };
    }).commonfabric;
    const value = await cf?.readCell?.();
    if (!isBrowserRecord(value)) {
      throw new Error("readCell did not return an object");
    }
    const users = Array.isArray(value.users) ? value.users : [];
    const options = Array.isArray(value.options) ? value.options : [];
    const votes = Array.isArray(value.votes) ? value.votes : [];
    const optionDetails = options
      .map((option): PollOptionState | undefined => {
        if (!isBrowserRecord(option)) return undefined;
        return {
          id: typeof option.id === "string" ? option.id : "",
          title: typeof option.title === "string" ? option.title : "",
          addedByName: typeof option.addedByName === "string"
            ? option.addedByName
            : "",
        };
      })
      .filter((option): option is PollOptionState => option !== undefined);
    const titleById = new Map(
      optionDetails.map((option) => [option.id, option.title]),
    );
    const voteDetails = votes
      .map((vote): PollVoteState | undefined => {
        if (!isBrowserRecord(vote)) return undefined;
        const optionId = typeof vote.optionId === "string" ? vote.optionId : "";
        return {
          optionId,
          optionTitle: titleById.get(optionId) ?? "",
          voterName: typeof vote.voterName === "string" ? vote.voterName : "",
          voteType: typeof vote.voteType === "string" ? vote.voteType : "",
        };
      })
      .filter((vote): vote is PollVoteState => vote !== undefined);
    const votersByTitle: Record<string, string[]> = {};
    const voteTypesByTitle: Record<string, Record<string, string>> = {};
    for (const option of optionDetails) {
      votersByTitle[option.title] = [];
      voteTypesByTitle[option.title] = {};
    }
    for (const vote of voteDetails) {
      if (!vote.optionTitle || !vote.voterName) continue;
      votersByTitle[vote.optionTitle] ??= [];
      voteTypesByTitle[vote.optionTitle] ??= {};
      votersByTitle[vote.optionTitle].push(vote.voterName);
      voteTypesByTitle[vote.optionTitle][vote.voterName] = vote.voteType;
    }
    const distinctVoters = new Set(
      votes
        .map((vote) => isBrowserRecord(vote) ? vote.voterName : undefined)
        .filter((name): name is string => typeof name === "string"),
    ).size;
    return {
      users: users.length,
      options: options.length,
      votes: votes.length,
      distinctVoters,
      adminName: typeof value.adminName === "string" ? value.adminName : "",
      myName: typeof value.myName === "string" ? value.myName : "",
      isJoined: typeof value.isJoined === "boolean"
        ? value.isJoined
        : undefined,
      isAdmin: typeof value.isAdmin === "boolean" ? value.isAdmin : undefined,
      voteCount: typeof value.voteCount === "number"
        ? value.voteCount
        : undefined,
      userCount: typeof value.userCount === "number"
        ? value.userCount
        : undefined,
      optionCount: typeof value.optionCount === "number"
        ? value.optionCount
        : undefined,
      optionDetails,
      voteDetails,
      votersByTitle,
      voteTypesByTitle,
    } satisfies PollCellSummary;
  });
}

declare global {
  interface Window {
    commonfabric?: {
      readCell?: () => Promise<unknown>;
      viewSettled?: () => Promise<void>;
      vdom?: { tree?: () => Promise<unknown> };
    };
  }

  var __lunchPollProbe: {
    clickButtonByText: (label: string) => Promise<void>;
    clickAllByAriaLabel: (label: string) => Promise<void>;
    clickVoteByOptionTitle: (
      optionTitle: string,
      label: string,
    ) => Promise<void>;
    hasText: (expected: string) => boolean;
    hasVoteSwatch: (name: string) => boolean;
    snapshot: () => {
      bodyText: string;
      deepText: string;
      normalizedText: string;
      pollSummary: string;
      viewerSummary: { name: string; hostChipVisible: boolean };
      topChoice: { title: string; summary: string };
      optionCards: OptionCardSummary[];
      swatches: string[];
      allOptionsRows: OptionSwatchSummary[];
      tags: string[];
      labels: string[];
    };
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function summarizePollValue(value: unknown): PollCellSummary {
  const record = isRecord(value) ? value : {};
  const users = Array.isArray(record.users) ? record.users : [];
  const options = Array.isArray(record.options) ? record.options : [];
  const votes = Array.isArray(record.votes) ? record.votes : [];
  const optionDetails = options
    .map((option): PollOptionState | undefined => {
      if (!isRecord(option)) return undefined;
      return {
        id: typeof option.id === "string" ? option.id : "",
        title: typeof option.title === "string" ? option.title : "",
        addedByName: typeof option.addedByName === "string"
          ? option.addedByName
          : "",
      };
    })
    .filter((option): option is PollOptionState => option !== undefined);
  const titleById = new Map(
    optionDetails.map((option) => [option.id, option.title]),
  );
  const voteDetails = votes
    .map((vote): PollVoteState | undefined => {
      if (!isRecord(vote)) return undefined;
      const optionId = typeof vote.optionId === "string" ? vote.optionId : "";
      return {
        optionId,
        optionTitle: titleById.get(optionId) ?? "",
        voterName: typeof vote.voterName === "string" ? vote.voterName : "",
        voteType: typeof vote.voteType === "string" ? vote.voteType : "",
      };
    })
    .filter((vote): vote is PollVoteState => vote !== undefined);
  const votersByTitle: Record<string, string[]> = {};
  const voteTypesByTitle: Record<string, Record<string, string>> = {};
  for (const option of optionDetails) {
    votersByTitle[option.title] = [];
    voteTypesByTitle[option.title] = {};
  }
  for (const vote of voteDetails) {
    if (!vote.optionTitle || !vote.voterName) continue;
    votersByTitle[vote.optionTitle] ??= [];
    voteTypesByTitle[vote.optionTitle] ??= {};
    votersByTitle[vote.optionTitle].push(vote.voterName);
    voteTypesByTitle[vote.optionTitle][vote.voterName] = vote.voteType;
  }
  const distinctVoters = new Set(
    voteDetails
      .map((vote) => vote.voterName)
      .filter((name) => name !== ""),
  ).size;
  return {
    users: users.length,
    options: optionDetails.length,
    votes: voteDetails.length,
    distinctVoters,
    adminName: typeof record.adminName === "string" ? record.adminName : "",
    myName: typeof record.myName === "string" ? record.myName : "",
    isJoined: typeof record.isJoined === "boolean"
      ? record.isJoined
      : undefined,
    isAdmin: typeof record.isAdmin === "boolean" ? record.isAdmin : undefined,
    voteCount: typeof record.voteCount === "number"
      ? record.voteCount
      : voteDetails.length,
    userCount: typeof record.userCount === "number"
      ? record.userCount
      : users.length,
    optionCount: typeof record.optionCount === "number"
      ? record.optionCount
      : optionDetails.length,
    optionDetails,
    voteDetails,
    votersByTitle,
    voteTypesByTitle,
  };
}

function emptyVDomSwatchSummary(): VDomSwatchSummary {
  return { count: 0, names: [], samples: [] };
}

function collectVDomSwatches(root: unknown): VDomSwatchSummary {
  const names: string[] = [];
  const samples: string[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown) => {
    const value = readCellLikeValue(node);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);

    const props = propsOf(value);
    const swatchName = props
      ? readCellLikeValue(props["data-vote-swatch-name"])
      : undefined;
    if (typeof swatchName === "string") {
      names.push(swatchName);
      if (samples.length < 12) {
        samples.push(
          `${
            typeof value.type === "string" ? value.type : "unknown"
          }:${swatchName}`,
        );
      }
    }

    const ui = value[UI];
    if (ui !== undefined && ui !== value) visit(ui);
    const children = readCellLikeValue(value.children);
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    } else if (children !== undefined && children !== null) {
      visit(children);
    }
  };

  visit(root);
  return { count: names.length, names: [...new Set(names)], samples };
}

function summarizeVDomForDiagnostics(root: unknown): DebugVDomPollSnapshot {
  const byAttr = (name: string, value?: string) =>
    findAllVDom(root, (props) => {
      const actual = readCellLikeValue(props[name]);
      return value === undefined ? actual !== undefined : actual === value;
    });
  const attr = (node: unknown, name: string): string => {
    const props = propsOf(node);
    const value = props ? readCellLikeValue(props[name]) : undefined;
    return typeof value === "string" ? value : "";
  };
  const pollSummary = byAttr("data-poll-summary", "true")[0];
  const hostChip = byAttr("data-viewer-host-chip", "true")[0];
  const viewerName = byAttr("data-viewer-name")[0];
  const topChoice = byAttr("data-top-choice", "true")[0];
  const optionCards = byAttr("data-option-card", "true").map((card) => ({
    optionId: attr(card, "data-option-card-id"),
    optionTitle: attr(card, "data-option-card-title"),
    myVote: attr(card, "data-option-card-my-vote"),
    me: attr(card, "data-option-card-me"),
    isJoined: attr(card, "data-option-card-is-joined"),
    isAdmin: attr(card, "data-option-card-is-admin"),
    voteControls: findAllVDom(
      card,
      (props) => readCellLikeValue(props["data-vote-control"]) !== undefined,
    ).map((control) => attr(control, "data-vote-control")),
  }));
  const allOptionsRows = byAttr("data-all-options-row", "true").map((row) => ({
    optionId: attr(row, "data-option-id"),
    optionTitle: attr(row, "data-option-title"),
    swatches: findAllVDom(
      row,
      (props) =>
        readCellLikeValue(props["data-vote-swatch-name"]) !== undefined,
    ).map((swatch) => attr(swatch, "data-vote-swatch-name")),
  }));
  const swatches = byAttr("data-vote-swatch-name").map((swatch) =>
    attr(swatch, "data-vote-swatch-name")
  );
  return {
    pollSummary: vdomText(pollSummary),
    viewerSummary: {
      name: attr(viewerName, "data-viewer-name"),
      hostChipVisible: hostChip !== undefined,
    },
    topChoice: {
      title: attr(topChoice, "data-top-choice-title"),
      summary: attr(topChoice, "data-top-choice-summary"),
    },
    optionCards,
    allOptionsRows,
    swatches,
  };
}

function findAllVDom(
  root: unknown,
  predicate: (
    props: Record<string, unknown>,
    node: Record<string, unknown>,
  ) => boolean,
): unknown[] {
  const matches: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    const value = readCellLikeValue(node);
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const props = propsOf(value);
    if (props && predicate(props, value)) matches.push(value);
    const ui = value[UI];
    if (ui !== undefined && ui !== value) visit(ui);
    const children = readCellLikeValue(value.children);
    if (Array.isArray(children)) {
      for (const child of children) visit(child);
    } else if (children !== undefined && children !== null) {
      visit(children);
    }
  };
  visit(root);
  return matches;
}

function vdomText(root: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    const value = readCellLikeValue(node);
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!isRecord(value) || seen.has(value)) return;
    seen.add(value);
    const ui = value[UI];
    if (ui !== undefined && ui !== value) visit(ui);
    visit(value.children);
  };
  visit(root);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

function propsOf(node: unknown): Record<string, unknown> | undefined {
  const value = readCellLikeValue(node);
  if (!isRecord(value)) return undefined;
  const props = readCellLikeValue(value.props);
  return isRecord(props) ? props : undefined;
}

function readCellLikeValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const get = value.get;
  return typeof get === "function" ? get.call(value) : value;
}
