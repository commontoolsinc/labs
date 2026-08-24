/**
 * Topics journey benchmark (UNTRACKED SCRATCH INSTRUMENT — never committed;
 * source snapshot lives in docs/history/plans/server-execution-v2/optimize/
 * flip-dossier-raw/ as .ts.txt). Instruments the topics workload the way the
 * flip-readiness dossier's three journeys (chat / lunch / note) are
 * instrumented: a StepTimer wall per journey step, a per-event series with
 * the sender-echo probe beside the cross-surface arrival, and summary lines
 * the offline analysis re-computes nearest-rank from the raw series.
 *
 * The journey mirrors integration/topics-navigation.test.ts's construction
 * exactly where it matters:
 *   - the controller creates the board and seeds two topics via
 *     `["addTopic"]` stream events — the OW60 echo-drop window (the
 *     stream-action validation guard racing `$ctx` materialization fires
 *     right after board create, when `crossrefs` may not have materialized);
 *   - the browser then COLD-loads the populated board (the file's cold-load
 *     boundary), and
 *   - navigation clicks a rendered `cf-cell-link` "Open" and waits for the
 *     piece view (the file's single `it`).
 * On top of that the series leg (CF_TOPICS_SERIES, default 20, delay
 * CF_TOPICS_SERIES_DELAY_MS ms apart, default 2000 — the chat series'
 * cadence) measures per event:
 *   echo    = set() -> the CONTROLLER's own `topics` holds the new title
 *             (waitForCellValue, quiescence-gated — the Deno client's analog
 *             of the sender's own render), and
 *   arrival = set() -> the BROWSER's body text shows the new title
 *             (waitForText — the chat arrival's convention).
 * The gap (arrival - echo) is the post-local-cover cross-surface wait — the
 * shape §4 note 7 of the flip-readiness dossier flagged on chat micro-steps.
 */
import { Identity } from "@commonfabric/identity";
import { env } from "@commonfabric/integration";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import { assertEquals } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  logStepTimings,
  StepTimer,
  waitForRuntimeIdle,
  waitForText,
} from "./cfc-browser-helpers.ts";
import {
  clickCellLink,
  waitForPieceView,
} from "./topics-navigation-helpers.ts";
import {
  initializePiecesController,
  PieceController,
  PiecesController,
} from "./pieces-controller.ts";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;
const FIRST_TITLE = "Navigation target";
const SECOND_TITLE = "Navigation neighbour";
const AGENT = "Topics journey bench";

const SERIES = Math.max(
  0,
  Number.parseInt(Deno.env.get("CF_TOPICS_SERIES") ?? "20", 10) || 0,
);
const SERIES_DELAY_MS = Math.max(
  0,
  Number.parseInt(Deno.env.get("CF_TOPICS_SERIES_DELAY_MS") ?? "2000", 10) ||
    0,
);
const ARM = (() => {
  const raw = Deno.env.get("EXPERIMENTAL_SERVER_EXECUTION");
  const on = raw === undefined
    ? SERVER_EXECUTION_DEFAULT_ENABLED
    : raw === "true";
  return on ? "ON" : "OFF";
})();

type TopicRow = { title?: string } | undefined;

const includesTitle =
  (title: string) => (topics: TopicRow[] | undefined): boolean =>
    Array.isArray(topics) &&
    topics.some((topic) => topic?.title === title);

// The chat series' in-test quantile convention (floor-index); the offline
// analysis recomputes nearest-rank from the per-event lines, dossier §4
// note 5.
const summarize = (vals: number[]): string => {
  const sorted = [...vals].sort((a, b) => a - b);
  const q = (f: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  return `median=${q(0.5).toFixed(0)}ms q1=${q(0.25).toFixed(0)}ms ` +
    `q3=${q(0.75).toFixed(0)}ms p95=${q(0.95).toFixed(0)}ms ` +
    `min=${sorted[0].toFixed(0)}ms max=${sorted[sorted.length - 1].toFixed(0)}ms`;
};

describe("Topics journey benchmark (scratch instrument)", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let board: PieceController;
  let boardSinkCancel: (() => void) | undefined;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await initializePiecesController({
      space: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity,
    });
    await cc.ensureDefaultPattern();
  });

  afterAll(async () => {
    boardSinkCancel?.();
    await cc?.dispose();
  });

  it("measures the topics journey ON-vs-OFF stimuli", async () => {
    const timer = new StepTimer();
    const seedEchoes: number[] = [];
    let topicFids: string[] = [];

    try {
      // Board create — the journey's first stimulus.
      await timer.run("board create + start (controller)", async () => {
        const sourcePath = join(
          import.meta.dirname!,
          "..",
          "topics",
          "main.tsx",
        );
        const rootPath = join(import.meta.dirname!, "..");
        const program = await resolveLocalProgram(
          (resolver) => cc.runtime.harness.resolve(resolver),
          { main: sourcePath, root: rootPath },
        );
        board = await cc.create(program, { start: true });
      });
      const resultCell = cc.getResult(board.getCell());
      boardSinkCancel = resultCell.sink(() => {});
      const topicsCell = resultCell.key("topics");

      // The two seed topics, echo-timed one by one — the drop-prone window
      // right after board create (OW60).
      for (const [index, title] of [FIRST_TITLE, SECOND_TITLE].entries()) {
        await timer.run(
          `addTopic seed ${index + 1} echo (controller)`,
          async () => {
            const t0 = performance.now();
            await board.result.set({ title, agentName: AGENT }, ["addTopic"]);
            await waitForCellValue(
              cc.runtime,
              topicsCell,
              includesTitle(title),
            );
            seedEchoes.push(performance.now() - t0);
          },
        );
      }

      // The fid capture — the real test's barrier tail (result.pull +
      // resolveAsCell per topic).
      await timer.run("fid capture (result.pull + resolveAsCell x2)", async () => {
        topicFids = [
          (await topicAt(board, 0)).id,
          (await topicAt(board, 1)).id,
        ];
      });

      // Browser COLD load of the populated board — the file's cold-load
      // boundary (no scheduler handlers registered in this worker yet).
      const page = shell.page();
      await timer.run("browser cold load: goto + login", () =>
        shell.goto({
          frontendUrl: FRONTEND_URL,
          view: { spaceName: SPACE_NAME, pieceId: board.id },
          identity,
        }));
      await timer.run("browser runtime idle", () => waitForRuntimeIdle(page));
      await timer.run("browser renders both seed titles", () =>
        Promise.all([
          waitForText(page, "body", FIRST_TITLE),
          waitForText(page, "body", SECOND_TITLE),
        ]).then(() => {}));

      // The series: per event, the controller echo and the browser arrival
      // measured from the same t0 (both waits level-triggered, so ordering
      // after the awaited set() loses nothing).
      const echoes: number[] = [];
      const arrivals: number[] = [];
      if (SERIES > 0) {
        for (let k = 0; k < SERIES; k++) {
          const title = `Journey topic ${k} of ${SERIES}`;
          const t0 = performance.now();
          await board.result.set({ title, agentName: AGENT }, ["addTopic"]);
          const [echoMs, arrivalMs] = await Promise.all([
            waitForCellValue(cc.runtime, topicsCell, includesTitle(title))
              .then(() => performance.now() - t0),
            waitForText(page, "body", title)
              .then(() => performance.now() - t0),
          ]);
          echoes.push(echoMs);
          arrivals.push(arrivalMs);
          if (SERIES_DELAY_MS > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, SERIES_DELAY_MS)
            );
          }
        }
      }

      // Raw series + summaries, printed BEFORE navigation so a navigation
      // failure cannot eat the series data. The offline analysis recomputes
      // percentiles nearest-rank from the per-event lines.
      const load = (() => {
        try {
          return Deno.loadavg().map((v) => v.toFixed(2)).join("/");
        } catch {
          return "n/a";
        }
      })();
      console.log(
        `\n[topics-journey] arm=${ARM} seed echo ms: ${
          seedEchoes.map((v) => v.toFixed(0)).join(" ")
        }`,
      );
      if (echoes.length > 0) {
        const gaps = arrivals.map((arrival, i) => arrival - echoes[i]);
        console.log(
          `[topics-series] arm=${ARM} n=${echoes.length} ` +
            `delay=${SERIES_DELAY_MS}ms load1/5/15=${load}`,
        );
        console.log(`[topics-series] echo    ${summarize(echoes)}`);
        console.log(`[topics-series] arrival ${summarize(arrivals)}`);
        console.log(`[topics-series] gap     ${summarize(gaps)}`);
        console.log(
          `[topics-series] per-event echo ms: ${
            echoes.map((v) => v.toFixed(0)).join(" ")
          }`,
        );
        console.log(
          `[topics-series] per-event arrival ms: ${
            arrivals.map((v) => v.toFixed(0)).join(" ")
          }`,
        );
        console.log(
          `[topics-series] per-event gap ms: ${
            gaps.map((v) => v.toFixed(0)).join(" ")
          }`,
        );
      }

      // Every board topic's fid (seeds + series), so the navigation assert
      // accepts any of the board's own topics — the first RESOLVED "Open"
      // link is not deterministically a seed once the series populated the
      // board. Untimed: controller-side reads, no store writes.
      const boardFids: string[] = [...topicFids];
      {
        const result = await board.result.getCell();
        await result.pull();
        const count = 2 + echoes.length;
        for (let i = 2; i < count; i++) {
          boardFids.push(
            new PieceController(
              board.pieces(),
              result.key("topics").key(i).resolveAsCell(),
            ).id,
          );
        }
      }

      // Navigation — the real test's single interaction: a resolved "Open"
      // link into the piece view.
      let openedPieceId = "";
      await timer.run("navigate-to-topic: click Open -> piece view", async () => {
        openedPieceId = await clickCellLink(page, "Open");
        await waitForPieceView(page, SPACE_NAME, openedPieceId);
      });
      assertEquals(
        boardFids.map((fid) => `of:${fid}`).includes(openedPieceId),
        true,
        `Open navigated to ${openedPieceId}, which is not a board topic`,
      );
      await timer.run("post-navigation runtime idle", () =>
        waitForRuntimeIdle(page));
    } finally {
      logStepTimings(`topics-journey ${ARM}`, timer);
    }
  });
});

async function topicAt(
  board: PieceController,
  index: number,
): Promise<PieceController> {
  const result = await board.result.getCell();
  await result.pull();
  return new PieceController(
    board.pieces(),
    result.key("topics").key(index).resolveAsCell(),
  );
}
