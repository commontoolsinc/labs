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
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert } from "@std/assert";
import type { MemoryWireAccountingReport } from "@commonfabric/memory/v2/wire-accounting";
import {
  initializePiecesController,
  PiecesController,
} from "./pieces-controller.ts";
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
import {
  analyzeLunchPollWireAccounting,
  formatLunchPollWireAccounting,
  validateLunchPollWireAccounting,
} from "./lunch-poll-wire-accounting.ts";

const { API_URL, FRONTEND_URL, MEMORY_WIRE_ACCOUNTING_TOKEN, SPACE_NAME } = env;
const PROPAGATION_TIMEOUT = 60_000;
const WIRE_ACCOUNTING_PATH = "api/storage/memory/wire-accounting";

const HOST = "Alice";
const GUEST = "Bob";
const OPTION_A = "Sushi Place";
const OPTION_B = "Taco Stand";

const optionCard = (title: string) => `[data-option-title="${title}"]`;
const voteButton = (title: string, color: "green" | "yellow" | "red") =>
  `${optionCard(title)} cf-button[data-vote="${color}"]`;

// The voter names that currently have a vote swatch in the "All options"
// summary, descending through shadow roots. Each swatch carries a
// `data-vote-swatch-name` hook with the voter's name. On a given browser this
// includes every voter whose vote that browser can see — so checking the host's
// swatches names the votes that crossed from the guest's browser.
const voteSwatchVoters = (page: Page): Promise<string[]> =>
  page.evaluate(() => {
    const names = new Set<string>();
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("[data-vote-swatch-name]")) {
        const name = el.getAttribute("data-vote-swatch-name");
        if (name) names.add(name);
      }
      for (const el of root.querySelectorAll("*")) {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) walk(sr);
      }
    };
    walk(document);
    return [...names];
  });

function wireAccountingUrl(action: "start" | "stop"): URL {
  return new URL(`${WIRE_ACCOUNTING_PATH}/${action}`, API_URL);
}

async function accountingRequest(
  action: "start" | "stop",
): Promise<Response> {
  return await fetch(wireAccountingUrl(action), {
    method: "POST",
    headers: {
      authorization: `Bearer ${MEMORY_WIRE_ACCOUNTING_TOKEN}`,
    },
  });
}

async function accountingErrorMessage(
  response: Response,
  action: "start" | "stop",
): Promise<string> {
  const body = await response.text().catch(() => "");
  const bodySuffix = body.trim().length === 0
    ? ""
    : ` body=${body.trim().slice(0, 200)}`;
  return `Memory wire-accounting ${action} failed with HTTP ${response.status}.${bodySuffix}`;
}

async function startMemoryWireAccounting(): Promise<boolean> {
  if (MEMORY_WIRE_ACCOUNTING_TOKEN === "") {
    console.log(
      "Memory wire-accounting token was not provided by the root integration runner; running Lunch Poll behavior and skipping accounting assertions.",
    );
    return false;
  }

  const response = await accountingRequest("start");
  if (response.status === 404) {
    await response.body?.cancel();
    throw new Error(
      "Memory wire-accounting route was expected but unavailable. Ensure the root integration runner started Toolshed with CF_MEMORY_WIRE_ACCOUNTING_TOKEN and ENV=development or ENV=test.",
    );
  }
  if (!response.ok) {
    throw new Error(await accountingErrorMessage(response, "start"));
  }
  await response.body?.cancel();
  return true;
}

async function stopMemoryWireAccounting(): Promise<MemoryWireAccountingReport> {
  const response = await accountingRequest("stop");
  if (!response.ok) {
    throw new Error(await accountingErrorMessage(response, "stop"));
  }

  const payload: unknown = await response.json().catch((cause) => {
    throw new Error("Memory wire-accounting stop returned invalid JSON", {
      cause,
    });
  });
  if (!isMemoryWireAccountingReport(payload)) {
    throw new Error(
      "Memory wire-accounting stop returned a JSON payload with an unexpected schema",
    );
  }
  return payload;
}

function isMemoryWireAccountingReport(
  payload: unknown,
): payload is MemoryWireAccountingReport {
  if (payload === null || typeof payload !== "object") return false;
  const object = payload as Record<string, unknown>;
  return typeof object.totals === "object" && object.totals !== null &&
    Array.isArray(object.byDirection) &&
    Array.isArray(object.byConnection) &&
    Array.isArray(object.byMetadataKind) &&
    Array.isArray(object.byClassification) &&
    Array.isArray(object.records);
}

describe("lunch poll: two users vote on a shared option", () => {
  const hostShell = new ShellIntegration({
    presentation: { id: "alice", label: "Alice", color: "#7c3aed" },
  });
  const guestShell = new ShellIntegration({
    presentation: { id: "bob", label: "Bob", color: "#0891b2" },
  });
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
    cc = await initializePiecesController({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: hostIdentity,
    });

    // Create the space-root (default) pattern up front, the way a real space
    // gets it at creation time — so each browser's `pattern:getSpaceRoot` is a
    // storage-RESUME boot (byte-cache read + evaluate) rather than a create.
    // Without this, both browsers race ensureDefaultPattern and each
    // cold-compiles default-app inside its worker (~2s locally, 5-10s on
    // 2-core CI); those synchronous compile stretches wedge the worker event
    // loop, stall unrelated IPC for seconds, and under enough load starve the
    // first fill's commit ack — the "second-boot slow window".
    await cc.ensureDefaultPattern();

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
    const resultCell = cc.manager().getResult(piece.getCell());
    // Keep the piece running without materializing the whole UI tree in this
    // controller process; the two browsers render their own UI.
    resultSinkCancel = resultCell.sink(() => {});
  });

  afterAll(async () => {
    resultSinkCancel?.();
    await cc?.dispose();
  });

  it("both users' votes on the same option survive, and a second option tallies independently", async () => {
    const timer = new StepTimer();
    const view = { spaceName: SPACE_NAME, pieceId };
    const hostPage = hostShell.page();
    const guestPage = guestShell.page();
    let accountingStarted = false;
    let accountingStopped = false;

    try {
      accountingStarted = await startMemoryWireAccounting();

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
      await timer.run(
        "both runtimes idle",
        () =>
          Promise.all([
            waitForRuntimeIdle(hostPage, { timeout: PROPAGATION_TIMEOUT }),
            waitForRuntimeIdle(guestPage, { timeout: PROPAGATION_TIMEOUT }),
          ]),
      );

      // Host joins first -> becomes host/admin. The roster chip carrying the
      // host's name appears once the join lands.
      await timer.run(
        "host name filled",
        () => fillCfInput(hostPage, "#lp-join-name", HOST),
      );
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
      // guest's vote and vice versa. This is the cross-browser visibility the
      // count alone does not name — it identifies WHO voted, sourced from the
      // resolved tally so a remote voter's keyed entity is rendered.
      await timer.run(
        "both voters' swatches visible on both browsers",
        () =>
          waitFor(async () => {
            const [hostVoters, guestVoters] = await Promise.all([
              voteSwatchVoters(hostPage),
              voteSwatchVoters(guestPage),
            ]);
            return hostVoters.includes(HOST) && hostVoters.includes(GUEST) &&
              guestVoters.includes(HOST) && guestVoters.includes(GUEST);
          }, { timeout: PROPAGATION_TIMEOUT, delay: 500 }),
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
        "final runtimes idle for accounting",
        () =>
          Promise.all([
            waitForRuntimeIdle(hostPage, { timeout: PROPAGATION_TIMEOUT }),
            waitForRuntimeIdle(guestPage, { timeout: PROPAGATION_TIMEOUT }),
          ]),
      );

      if (accountingStarted) {
        const report = await stopMemoryWireAccounting();
        accountingStopped = true;
        const analysis = analyzeLunchPollWireAccounting(report);
        console.log(formatLunchPollWireAccounting(analysis));
        const errors = validateLunchPollWireAccounting(analysis);
        assert(
          errors.length === 0,
          `Memory wire-accounting invariants failed:\n${errors.join("\n")}`,
        );
      }
    } finally {
      if (accountingStarted && !accountingStopped) {
        await stopMemoryWireAccounting().catch((error) => {
          console.error(
            `Failed to stop Memory wire-accounting during cleanup: ${error}`,
          );
        });
      }
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
