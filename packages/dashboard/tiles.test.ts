// Tile tests: each tile is a pure collect(ctx) -> TileView, exercised with a
// hand-made Ctx. No server, no network, no subprocess — the CI tiles get canned
// runs and the token-gated tiles get an empty env (their gray-out contract).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, Run } from "./types.ts";
import { LOOM_REPO, REPO, TRUST_COLS } from "./config.ts";
import { labsCi, loomCi } from "./tiles/main-build.ts";
import { labsCiTrust, loomCiTrust } from "./tiles/ci-trust.ts";
import { labsCiDuration, loomCiDuration } from "./tiles/ci-duration.ts";
import { recentRuns } from "./tiles/recent-runs.ts";
import { dau, foldSeries, parseExcludes } from "./tiles/dau.ts";
import { yourMetric } from "./tiles/your-metric.ts";
import { buildSnapshot, discordOnline } from "./tiles/discord-online.ts";
import { gcpSpend } from "./tiles/gcp-spend.ts";
import { prodErrors } from "./tiles/prod-errors.ts";
import { githubCiSpend, GITHUB_LAG_DAYS, projectMonthly, settled } from "./tiles/github-ci-spend.ts";
import { modelSpend } from "./tiles/model-spend.ts";
import { benchmark, formatNs, trendPct, trendStatus } from "./tiles/benchmark.ts";
import { TILES } from "./registry.ts";

function ctx(runs: Run[], env: Record<string, string> = {}, runsByRepo?: (repo: string) => Run[]): Ctx {
  return {
    runs: () => Promise.resolve(runs),
    runsFor: (repo: string) => Promise.resolve(runsByRepo ? runsByRepo(repo) : runs),
    env: (k) => env[k],
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

Deno.test("labs ci:passing tip -> good", async () => {
  const v = await labsCi.collect(ctx([run({ conclusion: "success" })]));
  assertEquals(v.status, "good");
  assertEquals(v.value, "passing");
});

Deno.test("labs ci:failing tip -> bad (shows the raw conclusion)", async () => {
  const v = await labsCi.collect(ctx([run({ conclusion: "failure" })]));
  assertEquals(v.status, "bad");
  assertEquals(v.value, "failure");
});

Deno.test("labs ci:no completed runs -> unknown", async () => {
  const v = await labsCi.collect(ctx([run({ status: "in_progress", conclusion: null })]));
  assertEquals(v.status, "unknown");
  assertEquals(v.value, "—");
});

Deno.test("labs ci trust: first-try-green rate drives status", async () => {
  // 2 of 3 completed passed first try -> 66.7% -> below the warn threshold -> bad.
  const runs = [
    run({ conclusion: "success", run_attempt: 1 }),
    run({ conclusion: "success", run_attempt: 1 }),
    run({ conclusion: "failure" }),
  ];
  const v = await labsCiTrust.collect(ctx(runs));
  assertStringIncludes(v.value ?? "", "66.7%");
  assertEquals(v.status, "bad");
});

Deno.test("labs ci trust grid: cell count is a whole number of rows (no half-empty final row)", async () => {
  const runs = Array.from({ length: 130 }, () => run({ conclusion: "success" }));
  const cells = ((await labsCiTrust.collect(ctx(runs))).extra ?? "").match(/class="cell"/g)?.length ?? 0;
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
  assertStringIncludes((await labsCiDuration.collect(ctx(busy))).sub ?? "", "25 passing runs in the last 6h");
  // 5 recent + 30 from two days ago -> only 5 in 6h (< 20) -> fall back to the last 20.
  const quiet = [
    ...Array.from({ length: 5 }, (_, i) => at(i)),
    ...Array.from({ length: 30 }, () => at(60 * 48)),
  ];
  assertStringIncludes((await labsCiDuration.collect(ctx(quiet))).sub ?? "", "last 20 passing runs");
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
  assertStringIncludes((await labsCiDuration.collect(ctx(runs))).sub ?? "", "20 passing runs in the last 6h");
});

Deno.test("recent-runs: wide, failure tip -> bad, rows link to the landing PR", async () => {
  const v = await recentRuns.collect(ctx([run({ conclusion: "failure", head_commit: { message: "oops (#42)" } })]));
  assertEquals(v.wide, true);
  assertEquals(v.status, "bad");
  assertStringIncludes(v.extra ?? "", "/pull/42");
});

Deno.test("recent runs: timestamps have a UTC fallback and a viewer-local marker", async () => {
  const startedAt = "2024-01-02T17:05:00Z";
  const runsByRepo = (repo: string) => repo === REPO ? [run({ run_started_at: startedAt })] : [];
  const v = await recentRuns.collect(ctx([], {}, runsByRepo));
  assertStringIncludes(
    v.extra ?? "",
    `<time class="t" datetime="${startedAt}" data-viewer-time>17:05 UTC</time>`,
  );
});

Deno.test("tile labels: the labs/loom ci family is renamed and paired", async () => {
  const one = ctx([run({ conclusion: "success" })]);
  assertEquals((await labsCi.collect(one)).label, "labs ci");
  assertEquals((await loomCi.collect(one)).label, "loom ci");
  assertEquals((await labsCiTrust.collect(one)).label, "labs ci trust");
  assertEquals((await loomCiTrust.collect(one)).label, "loom ci trust");
  assertEquals((await labsCiDuration.collect(one)).label, "labs ci duration");
  assertEquals((await loomCiDuration.collect(one)).label, "loom ci duration");
});

Deno.test("labs ci: an in-flight build renders at the bottom (extra), not the header (aside)", async () => {
  const runs = [
    run({ status: "in_progress", conclusion: null, display_title: "wip" }),
    run({ conclusion: "success" }),
  ];
  const v = await labsCi.collect(ctx(runs));
  assertStringIncludes(v.extra ?? "", "next build running");
  assert(!(v.aside ?? "").includes("next build running"), "the badge is no longer in the header aside");
});

Deno.test("recent runs: labs and loom runs interleave chronologically, each tagged", async () => {
  const now = Date.now();
  const mk = (repo: string, minsAgo: number, msg: string) =>
    run({ repo, run_started_at: new Date(now - minsAgo * 60_000).toISOString(), head_commit: { message: msg } });
  const byRepo = (repo: string) =>
    repo === LOOM_REPO
      ? [mk(LOOM_REPO, 10, "loom c (#7)"), mk(LOOM_REPO, 30, "loom b (#6)")]
      : [mk(REPO, 5, "labs c (#3)"), mk(REPO, 20, "labs a (#2)")];
  const v = await recentRuns.collect(ctx([], {}, byRepo));
  // Newest-first interleave across repos: labs 5m, loom 10m, labs 20m, loom 30m.
  const order = [...(v.extra ?? "").matchAll(/\/pull\/(\d+)/g)].map((m) => m[1]);
  assertEquals(order, ["3", "7", "2", "6"]);
  assertStringIncludes(v.extra ?? "", "labs · ");
  assertStringIncludes(v.extra ?? "", "loom · ");
});

Deno.test("dau: distinct identities per UTC day, excluding the DIDs we name", () => {
  const D = 86_400_000;
  const ser = (did: string, pts: [number, number][]) => ({
    labels: [{ key: { name: "user.did" }, value: did }],
    values: pts.map(([timestamp, value]) => ({ timestamp, value })),
  });
  const day1 = 1_783_641_600_000, day2 = day1 + D;
  const series = [
    ser("did:key:alice", [[day1, 998], [day2, 3184]]),
    ser("did:key:bob", [[day2, 12]]),
    ser("did:key:server", [[day1, 500], [day2, 500]]), // a service principal
  ];
  const all = foldSeries(series, new Set());
  assertEquals(all.get(day1)?.size, 2);
  assertEquals(all.get(day2)?.size, 3);
  // Naming the service principal takes it out of every day it appears in.
  const human = foldSeries(series, new Set(["did:key:server"]));
  assertEquals(human.get(day1)?.size, 1);
  assertEquals(human.get(day2)?.size, 2);
  // A bucket carrying no spans for an identity is not that identity being active.
  assertEquals(foldSeries([ser("did:key:alice", [[day1, 0]])], new Set()).size, 0);
});

Deno.test("dau: the exclusion list is read defensively", () => {
  assertEquals([...parseExcludes("did:key:a, did:key:b ,, ")], ["did:key:a", "did:key:b"]);
  assertEquals(parseExcludes(undefined).size, 0);
  assertEquals(parseExcludes("").size, 0);
});

Deno.test("your metric here: a gray placeholder that can't read as a live metric", async () => {
  const v = await yourMetric.collect(ctx([]));
  assertEquals(v.status, "unknown"); // never green/red
  assertEquals(v.label, "your metric here");
  assertStringIncludes(v.sub ?? "", "life, the universe");
});

Deno.test("gated tiles gray out cleanly without their env", async () => {
  const cases = [
    [discordOnline, "DISCORD_BOT_TOKEN"],
    [gcpSpend, "GCP_BILLING_TABLE"],
    [prodErrors, "SIGNOZ_URL"],
    [githubCiSpend, "GH_TOKEN"],
    [modelSpend, "OPENAI_ADMIN_KEY"],
    [benchmark, "GH_TOKEN"],
    [dau, "SIGNOZ_URL"],
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

Deno.test("settled: a day is known once it has a figure, or once billing has had time", () => {
  const L = GITHUB_LAG_DAYS; // 2
  // Day 15 of the month. Spend every day through the 15th: the last two days have
  // figures, so they are known despite being inside the lag.
  assertEquals(settled(Array.from({ length: 31 }, (_, i) => (i < 15 ? 10 : 0)), 15, L).length, 15);
  // Nothing since the 5th. The days that carried spend stop at 5, but by the 15th
  // billing has settled everything up to the 13th, so those quiet days are known.
  assertEquals(settled(Array.from({ length: 31 }, (_, i) => (i < 5 ? 10 : 0)), 15, L).length, 13);
  // The window keeps growing as the month goes on rather than stalling at 5.
  assertEquals(settled(Array.from({ length: 31 }, (_, i) => (i < 5 ? 10 : 0)), 31, L).length, 29);
  // Nothing at all this month: still only what billing has settled.
  assertEquals(settled(new Array(31).fill(0), 15, L).length, 13);
  // Day 1: nothing is settled yet and nothing has a figure.
  assertEquals(settled(new Array(31).fill(0), 1, L).length, 0);
  // A completed prior month, seen from part-way through the next one, is all known.
  assertEquals(settled(new Array(30).fill(0), 30 + 15, L).length, 30);
  // ...except at the very start of the next month, where its tail has not settled.
  assertEquals(settled(new Array(30).fill(0), 30 + 1, L).length, 29);
  assertEquals(settled([], 15, L).length, 0);
});

Deno.test("projectMonthly: the window keeps up with the calendar once spend stops", () => {
  // The real shape that started this: $1.01 across a fortnight, a penny on the 1st
  // and a dollar on the 14th, nothing else, no prior month.
  const month = new Array(31).fill(0);
  month[0] = 0.01;
  month[13] = 1.0;
  const rate = (day: number) => {
    const covered = settled(month, day, 1).length;
    return projectMonthly(1.01, covered, 31, []);
  };
  // On the 15th the fortnight is rated over 14 days, not over the 2 that spent.
  assert(Math.abs(rate(15) - (1.01 / 14) * 31) < 1e-6);
  // Counting only the days that spent would rate it over 2 and project ~7x higher.
  assert(projectMonthly(1.01, 2, 31, []) / rate(15) > 6);
  // By the end of the month the projection has converged on what was actually spent,
  // instead of stalling at the 14th and claiming double.
  assert(rate(31) < 1.15, `end-of-month projection should approach $1.01, got ${rate(31)}`);
  assert(rate(31) < rate(15), "the rate falls as quiet days accumulate");
  // The same money landing early is rated over the same elapsed fortnight, not over
  // the two days at the start of it.
  const early = new Array(31).fill(0);
  early[0] = 0.01;
  early[1] = 1.0;
  assertEquals(settled(early, 15, 1).length, 14);
});

Deno.test("projectMonthly: a borrowed tail is settled before it is borrowed", () => {
  // Early in a month the borrowed days are last month's tail, the part most likely
  // not to have settled. Taking those zeros as real quiet days rates the window near
  // zero and projects far under the truth.
  const steady = Array.from({ length: 30 }, () => 10); // $10/day last month
  const truth = 310; // day 3 of a 31-day month, $30 spent at the same $10/day
  assertEquals(projectMonthly(30, 3, 31, steady), truth);
  // On the 1st, with a 2-day lag, last month's final day is not known yet.
  const unsettledTail = [...steady.slice(0, 29), 0];
  assertEquals(settled(unsettledTail, 30 + 1, GITHUB_LAG_DAYS).length, 29);
  assertEquals(projectMonthly(30, 3, 31, settled(unsettledTail, 30 + 1, GITHUB_LAG_DAYS)), truth);
  // Borrowed raw, that one zero drags the rate down.
  assert(projectMonthly(30, 3, 31, unsettledTail) < truth, "an unsettled tail under-projects");
  // A prior month with no data at all borrows nothing rather than a month of zeros.
  assertEquals(settled(new Array(30).fill(0), 30 + 1, GITHUB_LAG_DAYS).length, 29);
  // But by mid-month a genuinely quiet prior month is known, and counts as quiet.
  assertEquals(settled(new Array(30).fill(0), 30 + 15, GITHUB_LAG_DAYS).length, 30);
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
