/**
 * Measures a browser's cold load of a seeded fabrichat room: shell boot,
 * login (which creates the runtime worker), the messages appearing, and the
 * settled view, with the worker's logger rows and a CPU profile of the worker
 * from the moment it exists.
 *
 * Run through `browser.sh`, which sets the environment this reads.
 */
import { afterAll, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import {
  attachWorkerProfiler,
  type CdpWorkerProfiler,
  env,
  startWorkerProfile,
  writeWorkerProfile,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import {
  collectBrowserLoadSummary,
  logStepTimings,
  settleView,
  StepTimer,
  waitForText,
} from "../../packages/patterns/integration/cfc-browser-helpers.ts";
import { waitForPieceView } from "../../packages/patterns/integration/topics-navigation-helpers.ts";

const fixture = JSON.parse(
  Deno.readTextFileSync(Deno.env.get("ROOM_FIXTURE")!),
) as {
  roomSpace: string;
  roomId: string;
  members: number;
  messages: number;
  salt?: string;
};
const salt = fixture.salt ?? Deno.env.get("ROOM_SALT") ?? "a";
const out = Deno.env.get("ROOM_OUT") ?? "room-load";
const LOADS = Number(Deno.env.get("ROOM_LOADS") ?? "1");
const PROFILE_US = Number(Deno.env.get("ROOM_PROFILE_US") ?? "1000");

describe("room load", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();
  let profiler: CdpWorkerProfiler | undefined;

  afterAll(() => {
    profiler?.close();
  });

  it("loads the seeded room in the browser", async () => {
    const identity = await Identity.fromPassphrase(
      `room-perf starter ${salt}`,
      { implementation: "noble" },
    );
    const page = shell.page();
    const pieceId = fixture.roomId.replace(/^of:/, "");
    // The seed can lose a send under load, so the text to wait for is the
    // last message a render of the room actually shows.
    const lastText = Deno.env.get("ROOM_LAST_TEXT")!;
    for (let load = 1; load <= LOADS; load++) {
      const timer = new StepTimer();
      await timer.run("shell boot", async () => {
        await page.goto(`${env.FRONTEND_URL}${fixture.roomSpace}/${pieceId}`);
        await waitForPieceView(page, fixture.roomSpace as never, pieceId);
      });
      // The worker exists only once the login builds the runtime; attaching
      // waits for it, so the profile starts a few hundred ms into the worker.
      const attaching = attachWorkerProfiler(shell.wsEndpoint());
      const loggingIn = timer.run("login", () => shell.login(identity));
      profiler = await attaching;
      const profiled = profiler !== undefined &&
        await startWorkerProfile(profiler, `room load ${load}`, {
          samplingIntervalUs: PROFILE_US,
        });
      await loggingIn;
      // Capture window: after ROOM_CAPTURE_S seconds the load is recorded as
      // not having shown its messages, so a load that never settles still
      // leaves its evidence; the wait itself then continues.
      const captureMs = Number(Deno.env.get("ROOM_CAPTURE_S") ?? "90") * 1000;
      const visible = timer.run(
        "last message visible",
        () => waitForText(page, "#fabrichat-messages", lastText),
      );
      let windowTimer: number | undefined;
      const windowDone = new Promise<void>((resolve) => {
        windowTimer = setTimeout(resolve, captureMs);
      });
      const outcome = await Promise.race([
        visible.then(() => "visible" as const),
        windowDone.then(() => "window" as const),
      ]);
      clearTimeout(windowTimer);
      console.log(`[room load ${load}] capture window ended by: ${outcome}`);
      if (outcome === "window") await visible;
      // The profile spans the settle too: half of a load's time can follow
      // the last message's appearance.
      await timer.run("view settled", () => settleView(page));
      if (profiled) {
        await writeWorkerProfile(profiler!, {
          pathPrefix: `${out}.load${load}`,
          label: `room load ${load}`,
          logReport: false,
        });
      }
      const summary = await collectBrowserLoadSummary(
        page,
        `room load ${load}`,
        { workerBudgetMs: 120_000 },
      );
      await Deno.writeTextFile(
        `${out}.load${load}.summary.json`,
        JSON.stringify({ outcome, steps: timer.rows(), summary }, null, 2),
      );
      logStepTimings(`room load ${load}`, timer);
      profiler?.close();
      profiler = undefined;
    }
  });
});
