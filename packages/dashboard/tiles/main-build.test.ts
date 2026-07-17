// The main-build tile's streak: how long the tip conclusion has held on main.
// Canned runs, no network. See tiles.test.ts for the rest of this tile's contract.
import { assertEquals } from "@std/assert";
import type { Ctx, Run } from "../types.ts";
import { labsCi } from "./main-build.ts";

function ctx(runs: Run[]): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: () => Promise.resolve(runs),
    env: () => undefined,
  };
}

function run(over: Partial<Run>): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "sha",
    display_title: "t",
    run_started_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: "t (#1)" },
    ...over,
  };
}

// Runs arrive newest-first, and the tile ages the streak off Date.now().
const ago = (mins: number) => new Date(Date.now() - mins * 60_000).toISOString();

Deno.test("labs ci streak: measured from the flip, not from the oldest run in the window", async () => {
  const runs = [
    run({ conclusion: "success", run_started_at: ago(30) }),
    run({ conclusion: "success", run_started_at: ago(125) }), // the oldest green of this streak
    run({ conclusion: "failure", run_started_at: ago(300) }), // the red before it — outside the streak
  ];
  const v = await labsCi.collect(ctx(runs));
  assertEquals(v.status, "good");
  // Green since the 125-minute-old run. Reaching past the failure would say "5h 0m".
  assertEquals(v.sub, "green for 2h 5m");
});

Deno.test("labs ci streak: a red streak is named by its raw conclusion", async () => {
  const runs = [
    run({ conclusion: "timed_out", run_started_at: ago(20) }),
    run({ conclusion: "timed_out", run_started_at: ago(45) }),
    run({ conclusion: "success", run_started_at: ago(200) }),
  ];
  const v = await labsCi.collect(ctx(runs));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "timed_out");
  assertEquals(v.sub, "timed_out for 45m");
});

Deno.test("labs ci streak: in-flight runs neither start nor break a streak", async () => {
  const runs = [
    run({ status: "in_progress", conclusion: null, run_started_at: ago(5) }),
    run({ conclusion: "success", run_started_at: ago(70) }),
  ];
  const v = await labsCi.collect(ctx(runs));
  // The unfinished run is not a verdict, so the last completed green still stands.
  assertEquals(v.status, "good");
  assertEquals(v.sub, "green for 1h 10m");
});

Deno.test("labs ci: no completed runs -> unknown, and no streak claimed", async () => {
  const v = await labsCi.collect(ctx([run({ status: "queued", conclusion: null })]));
  assertEquals(v.status, "unknown");
  assertEquals(v.sub, "no completed runs in window");
});
