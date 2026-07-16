// Tile tests: each tile is a pure collect(ctx) -> TileView, exercised with a
// hand-made Ctx. No server, no network, no subprocess — the CI tiles get canned
// runs and the token-gated tiles get an empty env (their gray-out contract).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, Run } from "./types.ts";
import { TRUST_COLS } from "./config.ts";
import { mainBuild } from "./tiles/main-build.ts";
import { ciTrust } from "./tiles/ci-trust.ts";
import { ciDuration } from "./tiles/ci-duration.ts";
import { recentRuns } from "./tiles/recent-runs.ts";
import { buildSnapshot, discordOnline } from "./tiles/discord-online.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { githubCiSpend, projectMonthly } from "./tiles/github-ci-spend.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { benchmark, formatNs, trendPct, trendStatus } from "./tiles/benchmark.ts";
import { TILES } from "./registry.ts";

function ctx(runs: Run[], env: Record<string, string> = {}): Ctx {
  return { runs: () => Promise.resolve(runs), env: (k) => env[k] };
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

Deno.test("main-build: passing tip -> good", async () => {
  const v = await mainBuild.collect(ctx([run({ conclusion: "success" })]));
  assertEquals(v.status, "good");
  assertEquals(v.value, "passing");
});

Deno.test("main-build: failing tip -> bad (shows the raw conclusion)", async () => {
  const v = await mainBuild.collect(ctx([run({ conclusion: "failure" })]));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "failure");
});

Deno.test("main-build: no completed runs -> unknown", async () => {
  const v = await mainBuild.collect(ctx([run({ status: "in_progress", conclusion: null })]));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
});

Deno.test("ci-trust: first-try-green rate drives status", async () => {
  // 2 of 3 completed passed first try -> 66.7% -> below the warn threshold -> bad.
  const runs = [
    run({ conclusion: "success", run_attempt: 1 }),
    run({ conclusion: "success", run_attempt: 1 }),
    run({ conclusion: "failure" }),
  ];
  const v = await ciTrust.collect(ctx(runs));
  assertStringIncludes(v.value ?? "", "66.7%");
  assertEquals(v.status, "bad");
});

Deno.test("ci-trust grid: cell count is a whole number of rows (no half-empty final row)", async () => {
  const runs = Array.from({ length: 130 }, () => run({ conclusion: "success" }));
  const cells = ((await ciTrust.collect(ctx(runs))).extra ?? "").match(/class="cell"/g)?.length ?? 0;
  assert(cells > 0 && cells % TRUST_COLS === 0, `expected a multiple of ${TRUST_COLS}, got ${cells}`);
  assertEquals(cells, 120); // floor(130 / 40) * 40
});

Deno.test("ci-duration window: the 6h window when it has >= 20 runs, else the most recent 20", async () => {
  const now = Date.now();
  const at = (minsAgo: number) =>
    run({
      run_started_at: new Date(now - minsAgo * 60_000).toISOString(),
      updated_at: new Date(now - minsAgo * 60_000 + 5 * 60_000).toISOString(),
    });
  // 25 runs within the last ~25 min -> the 6h window wins (25 >= 20).
  const busy = Array.from({ length: 25 }, (_, i) => at(i));
  assertStringIncludes((await ciDuration.collect(ctx(busy))).sub ?? "", "25 passing runs in the last 6h");
  // 5 recent + 30 from two days ago -> only 5 in 6h (< 20) -> fall back to the last 20.
  const quiet = [
    ...Array.from({ length: 5 }, (_, i) => at(i)),
    ...Array.from({ length: 30 }, () => at(60 * 48)),
  ];
  assertStringIncludes((await ciDuration.collect(ctx(quiet))).sub ?? "", "last 20 passing runs");
});

Deno.test("ci-duration: only runs that passed end to end count", async () => {
  const now = Date.now();
  const at = (i: number, over: Partial<Run>) =>
    run({
      run_started_at: new Date(now - i * 60_000).toISOString(),
      updated_at: new Date(now - i * 60_000 + 5 * 60_000).toISOString(),
      ...over,
    });
  const runs = [
    ...Array.from({ length: 20 }, (_, i) => at(i, { conclusion: "success" })),
    at(0, { conclusion: "failure" }),
    at(1, { conclusion: "cancelled" }),
    at(2, { conclusion: "timed_out" }),
    at(3, { status: "in_progress", conclusion: null }),
  ];
  // Only the 20 successful runs are counted; the rest are ignored.
  assertStringIncludes((await ciDuration.collect(ctx(runs))).sub ?? "", "20 passing runs in the last 6h");
});

Deno.test("recent-runs: wide, failure tip -> bad, rows link to the landing PR", async () => {
  const v = await recentRuns.collect(ctx([run({ conclusion: "failure", head_commit: { message: "oops (#42)" } })]));
  assertEquals(v.wide, true);
  assertEquals(v.status, "bad");
  assertStringIncludes(v.extra ?? "", "/pull/42");
});

Deno.test("gated tiles gray out cleanly without their env", async () => {
  const cases = [
    [discordOnline, "DISCORD_BOT_TOKEN"],
    [gcpSpend, "GCP_BILLING_TABLE"],
    [prodErrors, "SIGNOZ_URL"],
    [githubCiSpend, "GH_TOKEN"],
    [modelSpend, "OPENAI_ADMIN_KEY"],
    [benchmark, "GH_TOKEN"],
  ] as const;
  for (const [tile, needle] of cases) {
    const v = await tile.collect(ctx([]));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", needle);
  }
});

Deno.test("discord snapshot: splits online members into Team Member and Visitors", () => {
  const guild = {
    id: "g",
    roles: [
      { id: "team", name: "Team Member", color: 0x2ecc71, position: 5 },
      { id: "g", name: "@everyone", color: 0, position: 0 },
    ],
    members: [
      { user: { id: "a" }, roles: ["team"] },
      { user: { id: "b" }, roles: [] },
      { user: { id: "c" }, roles: ["team"] }, // offline, excluded
      { user: { id: "d" }, roles: ["team"] },
    ],
    presences: [
      { user: { id: "a" }, status: "online" },
      { user: { id: "b" }, status: "idle" },
      { user: { id: "c" }, status: "offline" },
      { user: { id: "d" }, status: "dnd" },
    ],
  };
  const snap = buildSnapshot(guild);
  assertEquals(snap.online, 3); // a, b, d (c is offline)
  assertEquals(snap.team, 2); // a, d carry the role and are online
  assertEquals(snap.visitors, 1); // b
  assertEquals(snap.teamColor, "#2ecc71"); // the role's own color
});

Deno.test("projectMonthly: >=2-week (or month-to-date) window, spilling into last month", () => {
  const lastMonth = Array.from({ length: 30 }, () => 100); // $100/day last month
  // >= 2 weeks of data this month -> pure month-to-date rate, last month ignored.
  //   $2000 over 20 days, 30-day month -> $3000.
  assertEquals(projectMonthly(2000, 20, 30, lastMonth), 3000);
  // < 2 weeks -> 14-day window = 6 days this month + last 8 of last month.
  //   window = 1200 + 8*100 = 2000 over 14 days -> (2000/14)*30.
  assert(Math.abs(projectMonthly(1200, 6, 30, lastMonth) - (2000 / 14) * 30) < 1e-6);
  // No data this month yet -> window is the last 14 days of last month.
  assertEquals(projectMonthly(0, 0, 31, lastMonth), 100 * 31);
  // No data anywhere -> falls back to mtd.
  assertEquals(projectMonthly(0, 0, 31, []), 0);
});

Deno.test("benchmark: trend classification — flat/down good, up warn, steep up bad", () => {
  const t = (v: number[]) => v.map((_, i) => i * 86_400_000); // one sample per day
  const st = (v: number[]) => trendStatus(trendPct(t(v), v));
  assertEquals(st([100, 101, 99, 100, 100, 101, 99, 100]), "good"); // flat
  assertEquals(st([130, 125, 120, 115, 110, 105, 100]), "good"); // falling
  assertEquals(st([100, 102, 104, 106, 108, 110, 112]), "warn"); // ~12% rise
  assertEquals(st([100, 120, 140, 160, 180, 200, 240]), "bad"); // steep rise
});

Deno.test("benchmark: fewer than a week of days claims no trend", () => {
  const t = (v: number[]) => v.map((_, i) => i * 86_400_000);
  // A big jump, but only three days of data -> reported flat (too little to judge).
  assertEquals(trendPct(t([100, 500, 2000]), [100, 500, 2000]), 0);
});

Deno.test("benchmark: Theil–Sen trend ignores a lone spike", () => {
  const flat = [100, 100, 100, 100, 100, 100, 100, 100];
  const spiked = [...flat];
  spiked[3] = 400; // a 4x outlier — least squares would flag it, the median slope doesn't
  const times = flat.map((_, i) => i * 86_400_000);
  assertEquals(trendStatus(trendPct(times, spiked)), "good");
});

Deno.test("benchmark: formatNs picks a readable unit", () => {
  assertEquals(formatNs(500), "500ns");
  assertEquals(formatNs(1500), "1.5µs");
  assertEquals(formatNs(2_000_000), "2.0ms");
  assertEquals(formatNs(50_000_000), "50ms");
  assertEquals(formatNs(NaN), "—");
});

Deno.test("registry: unique ids and positive intervals", () => {
  const ids = TILES.map((t) => t.id);
  assertEquals(new Set(ids).size, ids.length, "tile ids must be unique");
  for (const t of TILES) assert(t.intervalMs > 0, `${t.id} needs a positive intervalMs`);
});
