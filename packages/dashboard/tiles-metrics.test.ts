import { assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, Run } from "./types.ts";
import { benchmark } from "./tiles/benchmark.ts";
import { ciDuration } from "./tiles/ci-duration.ts";
import { projectMonthly } from "./tiles/github-ci-spend.ts";

function ctx(runs: Run[], env: Record<string, string> = {}): Ctx {
  return { runs: () => Promise.resolve(runs), env: (key) => env[key] };
}

function run(overrides: Partial<Run>): Run {
  return {
    id: 1,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: "sha",
    display_title: "test",
    run_started_at: new Date(Date.now() - 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: "test (#1)" },
    ...overrides,
  };
}

Deno.test("ci-duration: empty passing window is unavailable", async () => {
  const view = await ciDuration.collect(ctx([]));
  assertEquals(view.status, "unknown");
  assertEquals(view.value, "—");
  assertStringIncludes(view.sub ?? "", "last 0 passing runs");
});

Deno.test("ci-duration: even median averages the two middle durations", async () => {
  const now = Date.now();
  const durations = [10, 20, 30, 40];
  const runs = durations.map((minutes, index) =>
    run({
      id: index + 1,
      run_started_at: new Date(now - index * 60_000).toISOString(),
      updated_at: new Date(now - index * 60_000 + minutes * 60_000).toISOString(),
    })
  );
  assertEquals((await ciDuration.collect(ctx(runs))).value, "25m");
});

Deno.test("ci-duration: time-window median uses the filtered non-contiguous runs", async () => {
  const now = Date.now();
  const makeRun = (id: number, minutesAgo: number, durationMinutes: number) =>
    run({
      id,
      run_started_at: new Date(now - minutesAgo * 60_000).toISOString(),
      updated_at: new Date(now - minutesAgo * 60_000 + durationMinutes * 60_000).toISOString(),
    });
  const runs = [
    ...Array.from({ length: 10 }, (_, index) => makeRun(index + 1, index, 10)),
    makeRun(999, 60 * 48, 0),
    ...Array.from({ length: 10 }, (_, index) => makeRun(index + 20, index + 20, 20)),
  ];
  const view = await ciDuration.collect(ctx(runs));
  assertEquals(view.value, "15m");
  assertStringIncludes(view.sub ?? "", "20 passing runs in the last 6h");
});

Deno.test("projectMonthly: sparse prior usage includes zero-usage calendar days", () => {
  assertEquals(projectMonthly(100, 2, 30, [0, 100, 0, 100]), 1500);
});

Deno.test("benchmark: transient artifact failures are retried instead of cached empty", async () => {
  const originalFetch = globalThis.fetch;
  let artifactRequests = 0;
  globalThis.fetch = (input) => {
    const url = String(input);
    if (url.includes("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({ workflow_runs: [{ id: 987654321, created_at: new Date().toISOString(), conclusion: "success" }] }));
    }
    if (url.includes("/actions/runs/987654321/artifacts")) {
      artifactRequests++;
      return Promise.resolve(Response.json({ artifacts: [{ id: 444, name: "bench-results", expired: false }] }));
    }
    if (url.includes("/actions/artifacts/444/zip")) return Promise.resolve(new Response("temporary", { status: 503 }));
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  };
  try {
    const env = { GH_TOKEN: "token" };
    assertEquals((await benchmark.collect(ctx([], env))).sub, "benchmark data unavailable");
    assertEquals((await benchmark.collect(ctx([], env))).sub, "benchmark data unavailable");
    assertEquals(artifactRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
