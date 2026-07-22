// benchmark tile tests. The tile is driven through collect(ctx) and its /bench
// route with globalThis.fetch stubbed, so the GitHub Actions workflow-run pages,
// the per-run artifact listings and the artifact zips (real zip bytes, really
// deflated) are all canned. No network, no files, no subprocess.
//
// The tile keeps a persistent cache of each run's results and a module-level
// snapshot for the drill-down page. The dashboard test runner gives this module
// a temporary server-data directory. These tests share that state, use distinct
// run ids, and read snapshots after the collection that filled them.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx, TileView } from "../types.ts";
import { REPO } from "../config.ts";
import { BenchmarkHistoryStore } from "../benchmark-history-cache.ts";
import {
  benchmark,
  type BenchmarkFetchProgress,
  benchmarkHistoryCheckResponse,
  benchmarkHistoryProgressResponse,
  benchmarkTrend,
  benchPage,
  formatNs,
  jsonFromZip,
  pointsForWindow,
  sampleBenchmarkRuns,
  trendPct,
  trendStatus,
} from "./benchmark.ts";
import { CI_HISTORY_MIN_DAYS, ciHistoryBucketMs } from "../ci-job-history.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Midnight UTC yesterday plus two hours keeps test data inside the live window.
const BASE = Math.floor(Date.now() / DAY) * DAY - DAY + 2 * HOUR;
const COLLECTION_BUCKET = ciHistoryBucketMs(CI_HISTORY_MIN_DAYS);
const SAMPLED_BASE = Math.floor(BASE / COLLECTION_BUCKET) *
    COLLECTION_BUCKET +
  COLLECTION_BUCKET * 0.75;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// ---------------------------------------------------------------- zip building

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

interface Member {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  data: Uint8Array; // the bytes as they sit on disk (already compressed for method 8)
}

// Assemble a zip: a local header plus payload per member, then the central
// directory and the end-of-central-directory record. CRCs are left zero — the
// reader takes its sizes and offsets from the central directory and checks
// neither. `entryCount` overrides the count the EOCD advertises.
function makeZip(
  members: Member[],
  entryCount = members.length,
): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const local: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = enc.encode(m.name);
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, m.method, true);
    lv.setUint32(18, m.data.length, true);
    lv.setUint32(22, m.data.length, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);

    const cd = new Uint8Array(46 + name.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, m.method, true);
    cv.setUint32(20, m.data.length, true);
    cv.setUint32(24, m.data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    cd.set(name, 46);

    local.push(lh, m.data);
    central.push(cd);
    offset += lh.length + m.data.length;
  }
  const cdBytes = concat(central);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entryCount, true);
  ev.setUint16(10, entryCount, true);
  ev.setUint32(12, cdBytes.length, true);
  ev.setUint32(16, offset, true);
  return concat([...local, cdBytes, eocd]);
}

const bytes = (s: string) => new TextEncoder().encode(s);

async function deflate(s: string): Promise<Uint8Array> {
  const cs = new CompressionStream("deflate-raw");
  const done = new Response(cs.readable).arrayBuffer();
  const w = cs.writable.getWriter();
  await w.write(bytes(s));
  await w.close();
  return new Uint8Array(await done);
}

// The shape CI uploads: a text member alongside the deno bench report, the report
// deflated.
async function benchZip(json: string): Promise<Uint8Array<ArrayBuffer>> {
  return makeZip([
    { name: "notes.txt", method: 0, data: bytes("ignore me") },
    { name: "results.json", method: 8, data: await deflate(json) },
  ]);
}

// ------------------------------------------------------------- the stub api

interface GhRun {
  id: number;
  run_attempt: number;
  created_at: string;
  conclusion: string | null;
}

const ghRun = (
  id: number,
  at: number,
  conclusion: string | null = "success",
  runAttempt = 1,
): GhRun => ({
  id,
  run_attempt: runAttempt,
  created_at: new Date(at).toISOString(),
  conclusion,
});

interface Api {
  pages?: Record<number, GhRun[]>;
  // runId -> its artifact listing, or an HTTP status to fail with.
  artifacts?: Record<
    number,
    { id: number; name: string; expired: boolean }[] | number
  >;
  // artifactId -> the zip bytes, or an HTTP status to fail with.
  zips?: Record<number, Uint8Array<ArrayBuffer> | number>;
  // Thrown instead of answering, standing in for a dead network.
  throws?: Error;
  // Answered to everything, standing in for a refused request.
  status?: number;
}

// A stand-in GitHub Actions API answering exactly the three calls the tile makes.
function serve(api: Api): (url: URL) => Response {
  return (url) => {
    if (url.pathname === "/rate_limit") {
      return Response.json({
        resources: {
          core: {
            limit: 5_000,
            used: 0,
            remaining: 5_000,
            reset: Math.ceil(Date.now() / 1_000) + 3_600,
          },
        },
      });
    }
    if (api.throws) throw api.throws;
    if (api.status) return new Response("no", { status: api.status });
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Response.json({
        workflow_runs: api.pages?.[Number(url.searchParams.get("page"))] ?? [],
      });
    }
    const runId = url.pathname.match(/\/actions\/runs\/(\d+)\/artifacts$/)?.[1];
    if (runId) {
      const v = api.artifacts?.[Number(runId)];
      if (typeof v === "number") return new Response("no", { status: v });
      return Response.json({ artifacts: v ?? [] });
    }
    const artId = url.pathname.match(/\/actions\/artifacts\/(\d+)\/zip$/)?.[1];
    if (artId) {
      const v = api.zips?.[Number(artId)];
      if (v === undefined || typeof v === "number") {
        return new Response("no", { status: typeof v === "number" ? v : 404 });
      }
      return new Response(v);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
}

// Swap in the stub api for one test, recording every path requested, and put the
// real fetch back afterwards so no state leaks into the rest of the process.
async function withApi(
  api: Api,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  const handler = serve(api);
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

const runsPath = `/repos/${REPO}/actions/workflows/benchmarks.yml/runs`;
const artifactCalls = (calls: string[]) =>
  calls.filter((c) => c.includes("/artifacts"));
const apiCalls = (calls: string[]) =>
  calls.filter((call) => !call.startsWith("/rate_limit"));

// ------------------------------------------------------------ bench json

interface Timings {
  min?: number;
  avg?: number;
  max?: number;
  p75?: number;
  p99?: number;
  p995?: number;
  p999?: number;
}

// deno bench's per-benchmark timings, spread around a chosen p99 so a change of
// measurement in the drill-down visibly changes the number.
const timings = (p99: number): Timings => ({
  min: p99 * 0.4,
  avg: p99 * 0.5,
  max: p99 * 1.5,
  p75: p99 * 0.8,
  p99,
  p995: p99 * 1.05,
  p999: p99 * 1.2,
});

const bench = (
  origin: string,
  group: string | null,
  name: string,
  ok: Timings | undefined,
) => ({
  origin: `file:///w/${origin}`,
  group,
  name,
  results: [ok ? { ok } : {}],
});

// The deno bench report. `noise` stands in for a benchmark's own console output
// landing on stdout ahead of the JSON.
const report = (benches: unknown[], noise = "") =>
  noise + JSON.stringify({ version: 1, runtime: "deno", benches });

// ----------------------------------------------------------------- the tests

Deno.test("benchmark: no token -> gray, and nothing is fetched", async () => {
  await withApi({ throws: new Error("no request expected") }, async (calls) => {
    const v = await benchmark.collect(ctx({}));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "set GH_TOKEN");
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    assertEquals(v.hint, "all metrics ↗");
    assertEquals(calls, []);
  });
});

Deno.test("dashboard and /bench benchmark refreshes keep separate request scopes", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-scope-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const isolated = await import(
    `./benchmark.ts?scope=${crypto.randomUUID()}`
  );
  const originalFetch = globalThis.fetch;
  const token = `benchmark-scope-${crypto.randomUUID()}`;
  const calls: string[] = [];
  let workflowCalls = 0;
  let dashboardReleased = false;
  let requestsOverlapped = false;
  let releaseDashboard!: (response: Response) => void;
  let markDashboardStarted!: () => void;
  let releasePerformance!: (response: Response) => void;
  let markPerformanceStarted!: () => void;
  const dashboardResponse = new Promise<Response>((resolve) => {
    releaseDashboard = resolve;
  });
  const dashboardStarted = new Promise<void>((resolve) => {
    markDashboardStarted = resolve;
  });
  const performanceResponse = new Promise<Response>((resolve) => {
    releasePerformance = resolve;
  });
  const performanceStarted = new Promise<void>((resolve) => {
    markPerformanceStarted = resolve;
  });
  const handler = serve({ pages: {} });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      workflowCalls++;
      if (workflowCalls === 1) {
        markDashboardStarted();
        return dashboardResponse;
      }
      requestsOverlapped ||= !dashboardReleased;
      markPerformanceStarted();
      return performanceResponse;
    }
    return Promise.resolve(handler(url));
  }) as typeof fetch;

  let dashboardResult: Promise<TileView> | undefined;
  try {
    dashboardResult = isolated.benchmark.collect(ctx({ GH_TOKEN: token }));
    await dashboardStarted;

    const url = new URL("http://x/bench?view=runtime");
    const page = await isolated.benchmarkHistoryResponse(
      url,
      ctx({ GH_TOKEN: token }),
    );
    const html = await page.text();
    const progressMatch = html.match(/data-progress-url="([^"]+)"/);
    assert(progressMatch);
    const progressResponse = isolated.benchmarkHistoryProgressResponse(
      new URL(progressMatch[1], url),
    );
    const progressText = progressResponse.text();

    dashboardReleased = true;
    releaseDashboard(new Response("unavailable", { status: 503 }));
    await dashboardResult;
    await performanceStarted;
    releasePerformance(Response.json({ workflow_runs: [] }));
    const events = await progressText;
    assertStringIncludes(events, '"phase":"complete"');
    assertEquals(events.includes('"phase":"error"'), false);

    assertEquals(workflowCalls, 2);
    assertEquals(requestsOverlapped, false);
    assertEquals(calls.includes("/rate_limit"), true);
  } finally {
    dashboardReleased = true;
    releaseDashboard(new Response("unavailable", { status: 503 }));
    releasePerformance(Response.json({ workflow_runs: [] }));
    await dashboardResult?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: GITHUB_TOKEN stands in for GH_TOKEN", async () => {
  await withApi({ pages: {} }, async (calls) => {
    const v = await benchmark.collect(ctx({ GITHUB_TOKEN: "t" }));
    assertEquals(v.sub, "no benchmark runs"); // it got past the token gate and asked
    assertEquals(apiCalls(calls).length, 1);
    assertStringIncludes(apiCalls(calls)[0], runsPath);
    assertEquals(calls.includes("/rate_limit"), false);
  });
});

Deno.test("benchmark: a fresh disk cache prevents discovery after a dashboard restart", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-restart-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  const token = `benchmark-restart-${crypto.randomUUID()}`;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({ workflow_runs: [] }));
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  try {
    const first = await import(`./benchmark.ts?restart=${crypto.randomUUID()}`);
    await first.benchmark.collect(ctx({ GH_TOKEN: token }));
    assert(calls.some((call) => call.endsWith("/benchmarks.yml/runs")));

    calls.length = 0;
    const restarted = await import(
      `./benchmark.ts?restart=${crypto.randomUUID()}`
    );
    const restartedView = await restarted.benchmark.collect(ctx({
      GH_TOKEN: token,
    }));
    assertEquals(calls, []);
    assertEquals(restartedView.sub, "no benchmark runs");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("fresh runtime history serves the page and update check without discovery", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-history-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(input instanceof Request ? input.url : String(input));
    throw new Error("fresh runtime history must not request GitHub");
  }) as typeof fetch;

  try {
    const store = new BenchmarkHistoryStore();
    await store.load();
    store.markRefreshed(Date.now(), [], "no-runs");
    await store.save();

    const isolated = await import(
      `./benchmark.ts?fresh-history=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: "fresh-history-token" });
    const page = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    assertStringIncludes(await page.text(), "Idle");

    const checkIsolated = await import(
      `./benchmark.ts?fresh-check=${crypto.randomUUID()}`
    );
    const check = await checkIsolated.benchmarkHistoryCheckResponse(
      tokenContext,
    );
    assertEquals(await check.json(), {
      version: checkIsolated.benchmarkSnapshotVersion(),
      progress: null,
    });
    assertEquals(calls, []);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a stale disk cache is published while startup checks GitHub", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-startup-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const token = `benchmark-startup-${crypto.randomUUID()}`;
  const key = "packages/a/startup.bench.ts > cached";
  const stats = {
    min: 400,
    avg: 500,
    max: 1_500,
    p75: 800,
    p99: 1_000,
    p995: 1_050,
    p999: 1_200,
  };
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const store = new BenchmarkHistoryStore();
  await store.load();
  const cachedRuns = [
    { runId: 81_001, runAttempt: 1, at: Date.now() - 2 * DAY },
    { runId: 81_002, runAttempt: 1, at: Date.now() - DAY },
  ].map((run) => ({ ...run, metrics: new Map([[key, stats]]) }));
  for (const run of cachedRuns) store.set(run);
  store.markRefreshed(Date.now() - 31 * 60_000, cachedRuns);
  await store.save();

  let releaseDiscovery!: (response: Response) => void;
  const discovery = new Promise<Response>((resolve) => {
    releaseDiscovery = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return discovery;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  let published!: TileView;
  let markPublished!: () => void;
  const publishedResult = new Promise<void>((resolve) => {
    markPublished = resolve;
  });
  let collection: Promise<TileView> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?startup=${crypto.randomUUID()}`
    );
    const activeCollection = isolated.benchmark.collect(
      ctx({ GH_TOKEN: token, BENCH_METRIC: key }),
      (view: TileView) => {
        published = view;
        markPublished();
      },
    );
    collection = activeCollection;
    let settled = false;
    const observedCollection = activeCollection.then((view: TileView) => {
      settled = true;
      return view;
    });
    await publishedResult;
    assertEquals(published.value, "1.0µs");
    assertEquals(settled, false);

    releaseDiscovery(Response.json({ workflow_runs: [] }));
    await observedCollection;
  } finally {
    releaseDiscovery(Response.json({ workflow_runs: [] }));
    await collection?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark: a future refresh marker cannot suppress discovery", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-future-" });
  const file = `${directory}/fabric-wall-benchmark-history.json`;
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const store = new BenchmarkHistoryStore(file);
  await store.load();
  store.markRefreshed(Date.now() + DAY, []);
  await store.save();
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url.pathname);
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    return Promise.resolve(Response.json({ workflow_runs: [] }));
  }) as typeof fetch;

  try {
    const restarted = await import(
      `./benchmark.ts?future=${crypto.randomUUID()}`
    );
    await restarted.benchmark.collect(ctx({
      GH_TOKEN: `benchmark-future-${crypto.randomUUID()}`,
    }));
    assert(calls.some((call) => call.endsWith("/benchmarks.yml/runs")));
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench requires an explicit performance view", () => {
  const missing = new URL("http://x/bench?days=5");
  const res = benchmark.routes![0].handler(
    new Request(missing),
    missing,
  ) as Response;
  assertEquals(benchmark.routes![0].path, "/bench");
  assertEquals(res.status, 400);
  assertEquals(res.headers.get("location"), null);

  const unknown = new URL("http://x/bench?view=summary");
  assertEquals(
    (benchmark.routes![0].handler(
      new Request(unknown),
      unknown,
    ) as Response).status,
    400,
  );
});

Deno.test("/bench?view=runtime serves the runtime history page", async () => {
  const url = new URL("http://x/bench?view=runtime");
  const res = await benchmark.routes![0].handler(new Request(url), url);
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");

  const fragmentUrl = new URL(
    "http://x/bench?view=runtime&days=7&fragment=range",
  );
  const fragmentResponse = await benchmark.routes![0].handler(
    new Request(fragmentUrl),
    fragmentUrl,
  );
  const fragment = await fragmentResponse.text();
  assert(fragment.startsWith('<div id="range-content">'));
  assertStringIncludes(fragment, "selected 7-day trend");
  assert(!fragment.includes("<!doctype html>"));
  assert(!fragment.includes('<form class="controls"'));
});

Deno.test("/bench CI progress route rejects an unknown collection", async () => {
  const route = benchmark.routes![2];
  const url = new URL("http://x/bench/ci-progress?id=missing");
  const response = await route.handler(new Request(url), url);
  assertEquals(route.path, "/bench/ci-progress");
  assertEquals(response.status, 404);
});

Deno.test("/bench update check returns an uncached runtime snapshot version", async () => {
  const route = benchmark.routes![1];
  const url = new URL("http://x/bench/check?view=runtime");
  const response = await route.handler(new Request(url), url);
  const state = await response.json();
  assertEquals(route.path, "/bench/check");
  assertEquals(typeof state.version, "string");
  assertEquals(response.headers.get("cache-control"), "no-store");
});

Deno.test("/bench update check requires an explicit supported view", async () => {
  const route = benchmark.routes![1];
  for (const query of ["", "?view=summary", "?view=gantt"]) {
    const url = new URL(`http://x/bench/check${query}`);
    const response = await route.handler(new Request(url), url);
    assertEquals(response.status, 400);
  }
});

Deno.test("runtime history shows live artifact progress and keeps collection running", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-progress-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const isolated = await import(
    `./benchmark.ts?progress=${crypto.randomUUID()}`
  );
  const originalFetch = globalThis.fetch;
  let releaseArtifact = (_response: Response) => {};
  let artifactRequested = () => {};
  const sawArtifact = new Promise<void>((resolve) =>
    artifactRequested = resolve
  );
  const artifactResponse = new Promise<Response>((resolve) => {
    releaseArtifact = resolve;
  });
  const runId = 39_001;
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({
        workflow_runs: [ghRun(runId, BASE)],
      }));
    }
    if (url.pathname.endsWith(`/actions/runs/${runId}/artifacts`)) {
      artifactRequested();
      return artifactResponse;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  const tokenContext = ctx({ GH_TOKEN: "progress-token" });
  try {
    await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime&days=7"),
      tokenContext,
    );
    await sawArtifact;

    const check = await isolated.benchmarkHistoryCheckResponse(tokenContext);
    const state = await check.json();
    assertEquals(state.progress.phase, "fetching");
    assertEquals(state.progress.requestsMade, 1);
    assertEquals(state.progress.responsesReceived, 0);
    assertEquals(state.progress.outstandingRequests, 1);

    const pageResponse = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime&days=7"),
      tokenContext,
    );
    const html = await pageResponse.text();
    assertStringIncludes(html, "0 of 1 artifact checks complete");
    assertStringIncludes(html, "1 artifact checks made · 0 responded");
    assertStringIncludes(html, "1 outstanding · 0 queued");
    assertStringIncludes(html, 'data-refresh-on-complete="1"');
    assertStringIncludes(
      html,
      `/bench/runtime-progress?id=${state.progress.id}`,
    );
    assert(!html.includes("reload in a moment"));
    assert(!html.includes('id="days" name="days" disabled'));
    assertStringIncludes(
      html,
      'fetchProgress.dataset.refreshOnComplete === "1"',
    );
    assertStringIncludes(
      html,
      'collectionFailed = state.phase === "error"',
    );
    assertStringIncludes(
      html,
      "if (!eventStream && !collectionFailed && !transportFailed) renderIdle()",
    );
    assertStringIncludes(html, "transportFailed = true");

    const progressUrl = new URL(
      `http://x/bench/runtime-progress?id=${state.progress.id}`,
    );
    const progressResponse = isolated.benchmarkHistoryProgressResponse(
      progressUrl,
    );
    const reader = progressResponse.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assertStringIncludes(first, '"outstandingRequests":1');

    releaseArtifact(Response.json({ artifacts: [] }));
    let completed = first;
    while (!completed.includes('"phase":"complete"')) {
      const next = await reader.read();
      if (next.done) break;
      completed += new TextDecoder().decode(next.value);
    }
    assertStringIncludes(completed, '"phase":"complete"');
    assertStringIncludes(completed, '"responsesReceived":1');
    assertStringIncludes(completed, '"outstandingRequests":0');
  } finally {
    releaseArtifact(Response.json({ artifacts: [] }));
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("/bench before any data shows an idle progress panel", async () => {
  const isolated = await import(
    `./benchmark.ts?idle=${crypto.randomUUID()}`
  );
  const html = isolated.benchPage("p99", "file", 45, BASE, "labs");
  assertStringIncludes(html, '<section class="fetch-progress"');
  assertStringIncludes(html, '<strong id="fetch-title">Idle</strong>');
  assertStringIncludes(
    html,
    "No runtime benchmark samples were found in the history window.",
  );
  assert(!html.includes("reload in a moment"));
  assertStringIncludes(
    html,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );
  assertStringIncludes(html, "<title>Benchmarks — p99</title>"); // p99 is the default measurement
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI duration history</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
  assert(
    !html.includes('class="brow'),
    "no rows are drawn with nothing to draw",
  );
});

Deno.test("/bench?view=ci serves CI job history through the same drill-down", async () => {
  const gh = Deno.env.get("GH_TOKEN");
  const github = Deno.env.get("GITHUB_TOKEN");
  const cacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.delete("GH_TOKEN");
  Deno.env.delete("GITHUB_TOKEN");
  Deno.env.set(
    "DASHBOARD_CACHE_DIR",
    `/tmp/ci-job-history-missing-${crypto.randomUUID()}`,
  );
  try {
    const url = new URL("http://x/bench?view=ci");
    const response = await benchmark.routes![0].handler(new Request(url), url);
    const html = await response.text();
    assertEquals(
      response.headers.get("content-type"),
      "text/html; charset=utf-8",
    );
    assertStringIncludes(html, "<title>CI job history</title>");
    assertStringIncludes(html, "Set GH_TOKEN to collect CI job history.");
  } finally {
    if (gh === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", gh);
    if (github === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", github);
    if (cacheDirectory === undefined) Deno.env.delete("DASHBOARD_CACHE_DIR");
    else Deno.env.set("DASHBOARD_CACHE_DIR", cacheDirectory);
  }
});

Deno.test("benchmark: paging stops at the 45-day cutoff; failures and out-of-window runs are not sampled", async () => {
  // One full page whose oldest run is past the window: the loop stops there rather
  // than asking for page 2. Nothing on it is both successful and in-window.
  const page1 = [
    ...Array.from(
      { length: 99 },
      (_, i) => ghRun(1_000 + i, BASE - i * HOUR, "failure"),
    ),
    ghRun(1_099, BASE - 50 * DAY, "success"), // in date order last, and older than the cutoff
  ];
  await withApi({ pages: { 1: page1 } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "no benchmark runs");
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    assertEquals(v.hint, "all metrics ↗");
    assertEquals(apiCalls(calls).length, 1); // page 2 was never asked for
    assertEquals(artifactCalls(calls), []); // and no artifact was downloaded
  });
});

Deno.test("benchmark: an empty page ends the paging", async () => {
  const page1 = Array.from(
    { length: 100 },
    (_, i) => ghRun(2_000 + i, BASE - i * HOUR, "failure"),
  );
  await withApi({ pages: { 1: page1, 2: [] } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.sub, "no benchmark runs");
    // A full page still inside the window is followed; the empty page 2 stops it.
    assertEquals(
      apiCalls(calls).map((c) => c.match(/[?&]page=(\d+)/)![1]),
      ["1", "2"],
    );
  });
});

Deno.test("benchmark: unusable artifacts -> gray, never a false green", async () => {
  // Four successful runs in four different windows, each unusable a different way.
  const runs = [
    ghRun(401, BASE - 3 * DAY),
    ghRun(402, BASE - 2 * DAY),
    ghRun(403, BASE - 1 * DAY),
    ghRun(404, BASE),
  ];
  const art = (id: number, name = "bench-results", expired = false) => ({
    id,
    name,
    expired,
  });
  await withApi({
    pages: { 1: runs },
    artifacts: {
      401: [art(4_010, "bench-results", true), art(4_011, "coverage")], // expired, and the wrong artifact
      402: [art(4_020)], // the zip download fails
      403: [art(4_030)], // the zip holds no json
      404: 500, // the listing itself fails
    },
    zips: {
      4_020: 404,
      4_030: makeZip([{
        name: "notes.txt",
        method: 0,
        data: bytes("nothing useful"),
      }]),
    },
  }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "benchmark data unavailable");
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
    // The expired artifact and the coverage artifact are never downloaded.
    assert(!calls.some((c) => c.includes("/artifacts/4010/zip")));
    assert(!calls.some((c) => c.includes("/artifacts/4011/zip")));
  });
});

Deno.test("benchmark: a read that blipped is retried; a run with a definite answer is not", async () => {
  // Continues from the test above, which left runs 401-404 in the two states that
  // matter. 401 (only an expired artifact and the wrong one) and 403 (a zip holding
  // no report) each reached a definite answer: those runs have no results and never
  // will, so they are settled and must not be asked again. 402 (the zip download
  // failed) and 404 (the listing itself failed) reached no answer at all, so whether
  // they have results is still unknown and they must be retried.
  const runs = [
    ghRun(401, BASE - 3 * DAY),
    ghRun(402, BASE - 2 * DAY),
    ghRun(403, BASE - 1 * DAY),
    ghRun(404, BASE),
  ];
  const json = report([
    bench("packages/a/x.bench.ts", null, "tick", timings(1_000)),
  ]);
  await withApi({
    pages: { 1: runs },
    // The source is healthy again, and now answers for the two that blipped.
    artifacts: {
      402: [{ id: 4_020, name: "bench-results", expired: false }],
      404: [{ id: 4_040, name: "bench-results", expired: false }],
    },
    zips: { 4_020: await benchZip(json), 4_040: await benchZip(json) },
  }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    // The blips are asked again, so the tile recovers rather than staying dark for
    // the life of the process.
    assertEquals(v.value, "1.0µs");
    assert(
      calls.some((c) => c.includes("/runs/402/artifacts")),
      "the failed zip download is retried",
    );
    assert(
      calls.some((c) => c.includes("/runs/404/artifacts")),
      "the failed listing is retried",
    );
    // The settled runs are answered from the cache; the healthy source is not asked.
    assert(
      !calls.some((c) => c.includes("/runs/401/artifacts")),
      "a run with no usable artifact is settled",
    );
    assert(
      !calls.some((c) => c.includes("/runs/403/artifacts")),
      "a zip with no report is settled",
    );
  });
});

Deno.test("benchmark: a failed newer attempt stays stale and reports an error", async () => {
  const firstRun = ghRun(40_101, BASE - DAY);
  const secondRun = ghRun(40_102, BASE);
  const key = "packages/a/rerun.bench.ts";
  await withApi({
    pages: { 1: [firstRun, secondRun] },
    artifacts: {
      40_101: [{
        id: 401_010,
        name: "bench-results",
        expired: false,
      }],
      40_102: [{
        id: 401_020,
        name: "bench-results",
        expired: false,
      }],
    },
    zips: {
      401_010: await benchZip(
        report([bench(key, null, "work", timings(1_000))]),
      ),
      401_020: await benchZip(
        report([bench(key, null, "work", timings(2_000))]),
      ),
    },
  }, async () => {
    const view = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(view.value, "2.0µs");
  });

  const originalFetch = globalThis.fetch;
  let releaseAttempt = (_response: Response) => {};
  let attemptRequested = () => {};
  const sawAttempt = new Promise<void>((resolve) => attemptRequested = resolve);
  const attemptResponse = new Promise<Response>((resolve) => {
    releaseAttempt = resolve;
  });
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") {
      return Promise.resolve(serve({})(url));
    }
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Promise.resolve(Response.json({
        workflow_runs: [
          ghRun(firstRun.id, BASE - DAY, "success", 2),
          secondRun,
        ],
      }));
    }
    if (url.pathname.endsWith(`/actions/runs/${firstRun.id}/artifacts`)) {
      attemptRequested();
      return attemptResponse;
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;

  try {
    const collection = benchmark.collect(ctx({ GH_TOKEN: "t" }));
    await sawAttempt;
    const check = await benchmarkHistoryCheckResponse(ctx({ GH_TOKEN: "t" }));
    const state = await check.json();
    const progress = benchmarkHistoryProgressResponse(
      new URL(`http://x/bench/runtime-progress?id=${state.progress.id}`),
    );
    const reader = progress.body!.getReader();
    let events = new TextDecoder().decode((await reader.read()).value);

    releaseAttempt(new Response("unavailable", { status: 503 }));
    const view = await collection;
    assertEquals(view.value, "2.0µs");
    while (!events.includes('"phase":"error"')) {
      const next = await reader.read();
      if (next.done) break;
      events += new TextDecoder().decode(next.value);
    }
    assertStringIncludes(events, '"phase":"error"');
    assertStringIncludes(events, '"failedResponses":1');

    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
        return Promise.resolve(Response.json({ workflow_runs: [] }));
      }
      throw new Error(`unexpected request ${url.pathname}`);
    }) as typeof fetch;
    await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(
      benchmarkHistoryProgressResponse(
        new URL(`http://x/bench/runtime-progress?id=${state.progress.id}`),
      ).status,
      404,
    );
  } finally {
    releaseAttempt(new Response("unavailable", { status: 503 }));
    globalThis.fetch = originalFetch;
  }
});

Deno.test("benchmark: one benchmark per shortest-view bucket (the newest in the bucket wins)", async () => {
  // Twelve days, one run a day, all at 1µs. Two runs share the last window: the
  // older one is wildly slow, so if the wrong one were sampled the headline would
  // read 10ms and the tile would turn red.
  const at = (d: number) => SAMPLED_BASE - (11 - d) * DAY;
  const key = "packages/runner/solo.bench.ts";
  const runs: GhRun[] = [];
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  for (let d = 0; d <= 11; d++) {
    const id = 501 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    // No "version" key here: the report is parsed whole when there is no console
    // output to skip past.
    zips[id * 10] = await benchZip(
      JSON.stringify({ benches: [bench(key, null, "tick", timings(1_000))] }),
    );
  }
  // The stale twin, listed before its window's winner so the newer one displaces it.
  runs.push(ghRun(599, at(11) - COLLECTION_BUCKET / 2));
  artifacts[599] = [{ id: 5_990, name: "bench-results", expired: false }];
  zips[5_990] = await benchZip(
    JSON.stringify({ benches: [bench(key, null, "tick", timings(9_999_999))] }),
  );

  await withApi({
    pages: {
      1: [ghRun(599, at(11) - COLLECTION_BUCKET / 2), ...runs.slice(0, 12)],
    },
    artifacts,
    zips,
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.value, "1.0µs"); // the newest run in the window, not the 10ms twin
    assertEquals(v.status, "good"); // flat p99 over 45 days
    assertEquals(v.label, "benchmark");
    assertEquals(v.duration, 11 * DAY);
    assertEquals(v.sub, undefined);
    assertStringIncludes(v.extra ?? "", "<svg");
    assertStringIncludes(v.extra ?? "", "tick"); // the benchmark's name, without its file
    assertStringIncludes(v.extra ?? "", "p99 flat");
  });
});

Deno.test("benchmark: a run's results are immutable, so a cached run is not refetched", async () => {
  const at = (d: number) => SAMPLED_BASE - (11 - d) * DAY;
  const runs = [
    ghRun(599, at(11) - COLLECTION_BUCKET / 2),
    ...Array.from({ length: 12 }, (_, d) => ghRun(501 + d, at(d))),
  ];
  // Every artifact call would 500; the cache from the previous test answers instead.
  await withApi({ pages: { 1: runs } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.value, "1.0µs");
    assertEquals(v.status, "good");
    assertEquals(artifactCalls(calls), []);
  });
});

Deno.test("jsonFromZip: reads a stored json member, ignoring a text member beside it", async () => {
  const zip = makeZip([
    { name: "notes.txt", method: 0, data: bytes("not the report") },
    { name: "results.json", method: 0, data: bytes(`{"benches":[]}`) },
  ]);
  assertEquals(await jsonFromZip(zip), `{"benches":[]}`);
});

Deno.test("jsonFromZip: inflates a deflated json member", async () => {
  const json = report([
    bench("packages/a/x.bench.ts", null, "tick", timings(5)),
  ]);
  assertEquals(await jsonFromZip(await benchZip(json)), json);
});

Deno.test("jsonFromZip: a zip with no json member -> null", async () => {
  const zip = makeZip([{
    name: "notes.txt",
    method: 0,
    data: bytes("nothing"),
  }]);
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: bytes with no end-of-central-directory record -> null", async () => {
  assertEquals(await jsonFromZip(new Uint8Array(10)), null); // shorter than the record itself
  assertEquals(await jsonFromZip(new Uint8Array(200)), null);
});

Deno.test("jsonFromZip: a central directory shorter than its own count stops instead of reading past it", async () => {
  const zip = makeZip([{ name: "notes.txt", method: 0, data: bytes("x") }], 2);
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: a member whose local header the central directory does not point at -> null", async () => {
  const zip = makeZip([{
    name: "results.json",
    method: 0,
    data: bytes(`{"benches":[]}`),
  }]);
  new DataView(zip.buffer).setUint32(0, 0xdeadbeef, true); // clobber the local file header signature
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: a compression method we cannot read -> null, not garbage", async () => {
  const zip = makeZip([{
    name: "results.json",
    method: 99,
    data: bytes(`{"benches":[]}`),
  }]);
  assertEquals(await jsonFromZip(zip), null);
});

// A geometric series over twelve days: the Theil–Sen slope is exact, so the
// series ends at exactly `fold` times where it started.
const SHAPES = [
  // origin, group, name, p99 on day 0, end/start ratio
  [
    "packages/runner/scheduler-persistent-state.bench.ts",
    null,
    "commit",
    1_000,
    1.12,
  ],
  [
    "packages/runner/scheduler-persistent-state.bench.ts",
    "hot",
    "steep",
    1_000_000,
    20,
  ],
  ["packages/memory/query.bench.ts", null, "fivefold", 10_000, 5],
  ["packages/memory/query.bench.ts", null, "quarter", 400_000_000, 0.25],
  ["packages/html/render.bench.ts", null, "easing", 1_000, 0.9],
] as const;

async function fillVaried(): Promise<Api> {
  const at = (d: number) => BASE - (11 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 11; d++) {
    const id = 601 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    const benches = [
      ...SHAPES.map(([origin, group, name, start, fold]) =>
        bench(origin, group, name, timings(start * Math.pow(fold, d / 11)))
      ),
      // Only an average reported: every percentile falls back to it.
      bench("packages/html/render.bench.ts", null, "flat", { avg: 2_500_000 }),
      // Neither of these is a measurement, so neither reaches the page.
      bench("packages/x/skip.bench.ts", null, "no-ok", undefined),
      bench(
        "packages/x/skip.bench.ts",
        null,
        "not-a-number",
        { avg: "quick" } as unknown as Timings,
      ),
    ];
    // A benchmark's own console output precedes the report on stdout.
    zips[id * 10] = await benchZip(
      report(benches, "running 7 benchmarks\ncpu: apple m2\n"),
    );
  }
  return { pages: { 1: runs }, artifacts, zips };
}

// Pull the rendered rows out of the drill-down html.
function rows(html: string) {
  return [...html.matchAll(
    /<div class="brow (\w+)">[\s\S]*?<span class="bname">([^<]*)<\/span><span class="bval">([^<]*)<span class="btrend">([^<]*)<\/span>/g,
  )].map((m) => ({ status: m[1], name: m[2], value: m[3], trend: m[4] }));
}

const page = async (query: string): Promise<string> => {
  const suffix = query ? `&${query.replace(/^\?/, "")}` : "";
  const url = new URL(`http://x/bench?view=runtime${suffix}`);
  return await (await benchmark.routes![0].handler(new Request(url), url))
    .text();
};

Deno.test("benchmark: BENCH_METRIC pins the grid tile to a named benchmark", async () => {
  await withApi(await fillVaried(), async () => {
    const v = await benchmark.collect(
      ctx({ GH_TOKEN: "t", BENCH_METRIC: "steep" }),
    );
    assertEquals(v.value, "20ms"); // 1ms rising twenty-fold over the 45 days
    assertEquals(v.status, "bad"); // past RAPID_PCT -> trending up rapidly
    assertEquals(v.duration, 11 * DAY);
    assertStringIncludes(v.extra ?? "", "hot/steep"); // group and name, file dropped
    assertStringIncludes(v.extra ?? "", "p99 ▲20×"); // a fold, not "▲1900%"
  });
});

Deno.test("/bench: grouped by source file, each benchmark coloured by its own trend", async () => {
  const html = await page("?stat=p99&sort=file");
  assertEquals(
    [...html.matchAll(/<h2>([^<]*)<\/h2>/g)].map((m) => m[1]),
    [
      "packages/html/render.bench.ts",
      "packages/memory/query.bench.ts",
      "packages/runner/scheduler-persistent-state.bench.ts",
    ],
  );
  assertEquals(rows(html), [
    { status: "good", name: "easing", value: "900ns", trend: "▼10%" },
    { status: "good", name: "flat", value: "2.5ms", trend: "flat" },
    { status: "bad", name: "fivefold", value: "50µs", trend: "▲5.0×" },
    { status: "good", name: "quarter", value: "100ms", trend: "▼4.0×" }, // four times faster is still good
    { status: "warn", name: "commit", value: "1.1µs", trend: "▲12%" },
    { status: "bad", name: "hot/steep", value: "20ms", trend: "▲20×" },
  ]);
  // A bench with no `ok` block, or an average that is not a number, is not a
  // measurement and never reaches the page.
  assert(!html.includes("no-ok"), "a result with no ok block is dropped");
  assert(!html.includes("not-a-number"), "a non-numeric average is dropped");
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="true">p99</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p75">p75</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="true">file</a>`,
  );
  assertStringIncludes(
    html,
    `<a class="stat" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=duration&amp;stat=p99">duration</a>`,
  );
  assertStringIncludes(html, 'aria-label="Benchmark metric"');
  assertStringIncludes(html, 'aria-label="Sort benchmarks"');
  assertStringIncludes(
    html,
    'href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=file&amp;stat=p99" aria-current="page">Runtime benchmarks</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=labs&amp;days=45&amp;sort=job&amp;stat=p99">CI run Gantt</a>',
  );
  assertStringIncludes(
    html,
    '<input type="hidden" name="view" value="runtime">',
  );
  assertStringIncludes(html, '<input type="hidden" name="repo" value="labs">');
  assertStringIncludes(html, '<div id="range-content">');
  assertStringIncludes(html, 'days.addEventListener("keydown"');
  assertStringIncludes(html, "syncDayLinks()");
  assertStringIncludes(html, 'days.addEventListener("change", applyDays)');
  assert(!html.includes("keyboardEditing"));
  assertStringIncludes(html, "new DOMParser().parseFromString");
  assertStringIncludes(html, "rangeContent.replaceWith(replacement)");
  assertStringIncludes(html, "history.pushState(null");
  assertStringIncludes(html, 'window.addEventListener("popstate"');
  assertStringIncludes(html, 'void loadRange("pop")');
  assertStringIncludes(html, 'void loadRange("restore")');
  assertStringIncludes(html, 'if (mode === "refresh")');
  assertStringIncludes(html, "rangeRequestDays !== days.value");
  assertStringIncludes(html, "if (loaded && pendingRefresh)");
  assertStringIncludes(html, "days.value !== appliedDays ||");
  assertStringIncludes(
    html,
    "if (!Number.isFinite(value)) return DEFAULT_DAYS",
  );
  assertStringIncludes(html, "rangeRequest.abort()");
  assertStringIncludes(html, "refreshRangeWhenIdle()");
  assert(!html.includes("location.reload()"));
  assert(!html.includes("benchRestoreDaysFocus"));
  assertStringIncludes(html, "setInterval(checkForUpdates, 60000)");
  assert(
    !html.includes(
      ".views a.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assert(
    !html.includes(
      "a.stat.on{background:#6ea8fe;border-color:#6ea8fe;color:#0d0e11;font-weight",
    ),
  );
  assertStringIncludes(
    html,
    '<div class="axisrow"><div class="timeaxis"><span>',
  );
});

Deno.test("/bench?sort=trend: a flat list, biggest rise first, showing the full key", async () => {
  const html = await page("?stat=p99&sort=trend");
  // The " > " between a benchmark's file and its name is html-escaped on the page.
  assertEquals(rows(html).map((r) => r.name), [
    "packages/runner/scheduler-persistent-state.bench.ts &gt; hot/steep",
    "packages/memory/query.bench.ts &gt; fivefold",
    "packages/runner/scheduler-persistent-state.bench.ts &gt; commit",
    "packages/html/render.bench.ts &gt; flat",
    "packages/html/render.bench.ts &gt; easing",
    "packages/memory/query.bench.ts &gt; quarter",
  ]);
  assert(!html.includes("<h2>"), "a flat list has no file headings");
  assertStringIncludes(
    html,
    `<a class="stat on" href="/bench?view=runtime&amp;repo=labs&amp;days=45&amp;sort=trend&amp;stat=p99" aria-current="true">trend</a>`,
  );
});

Deno.test("/bench?sort=duration lists the longest current benchmark first", async () => {
  const html = await page("?stat=p99&sort=duration");
  assertEquals(rows(html).map((row) => row.name).slice(0, 3), [
    "packages/memory/query.bench.ts &gt; quarter",
    "packages/runner/scheduler-persistent-state.bench.ts &gt; hot/steep",
    "packages/html/render.bench.ts &gt; flat",
  ]);
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=labs&amp;days=45&amp;sort=duration&amp;stat=p99">CI duration history</a>',
  );
});

Deno.test("/bench history windows keep about the same chart point count", () => {
  const now = 45 * DAY;
  const step = 10 * 60_000;
  const points = Array.from(
    { length: Math.floor(45 * DAY / step) + 1 },
    (_, index) => ({ at: now - index * step }),
  );
  const full = pointsForWindow(points, 0, ciHistoryBucketMs(45));
  const short = pointsForWindow(
    points,
    now - CI_HISTORY_MIN_DAYS * DAY,
    ciHistoryBucketMs(CI_HISTORY_MIN_DAYS),
  );

  assert(full.length >= 89 && full.length <= 91);
  assert(short.length >= 89 && short.length <= 91);
});

Deno.test("benchmark collection retains enough runs for the shortest history window", () => {
  const now = 45 * DAY;
  const step = 10 * 60_000;
  const runs = Array.from(
    { length: Math.floor(45 * DAY / step) + 1 },
    (_, index) => ghRun(30_000 + index, now - index * step),
  );
  const collected = sampleBenchmarkRuns(runs, 0).map((run) => ({
    at: Date.parse(run.created_at),
  }));
  const short = pointsForWindow(
    collected,
    now - CI_HISTORY_MIN_DAYS * DAY,
    ciHistoryBucketMs(CI_HISTORY_MIN_DAYS),
    now,
  );

  assert(short.length >= 89 && short.length <= 91);
});

Deno.test("/bench: the measurement selector changes what is plotted", async () => {
  const p50 = rows(await page("?stat=p50"));
  assertEquals(p50.find((r) => r.name === "hot/steep")?.value, "10ms"); // the mean, half the p99
  // A benchmark that reported only an average reads the same at every percentile.
  assertEquals(p50.find((r) => r.name === "flat")?.value, "2.5ms");
  assertEquals(
    rows(await page("?stat=p0")).find((r) => r.name === "flat")?.value,
    "2.5ms",
  );
  assertStringIncludes(
    await page("?stat=p50"),
    "<title>Benchmarks — p50</title>",
  );
  // An unknown measurement falls back to the default rather than blanking the page.
  assertStringIncludes(
    await page("?stat=nonsense"),
    "<title>Benchmarks — p99</title>",
  );
  assertEquals(
    rows(await page("?stat=nonsense")).find((r) => r.name === "hot/steep")
      ?.value,
    "20ms",
  );
  // So does an unknown sort.
  assertStringIncludes(
    await page("?sort=nonsense"),
    "<h2>packages/html/render.bench.ts</h2>",
  );
});

Deno.test("/bench: the history slider selects and clamps the displayed days", async () => {
  const short = await page("?days=1");
  assertStringIncludes(
    short,
    'id="days" name="days" min="1" max="45" step="1" value="1"',
  );
  assertStringIncludes(short, "selected 1-day trend");
  assertStringIncludes(
    await page("?days=7"),
    '<div class="axisrow"><div class="timeaxis"><span>',
  );
  assertStringIncludes(await page("?days=0"), ">1 day</output>");
  assertStringIncludes(await page("?days=100"), ">45 days</output>");

  const requestedEnd = BASE + DAY;
  const anchored = benchPage("p99", "file", 7, requestedEnd);
  const date = (at: number) =>
    new Date(at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
  assertStringIncludes(
    anchored,
    `<div class="timeaxis"><span>${date(requestedEnd - 7 * DAY)}</span><span>${
      date(requestedEnd)
    }</span>`,
  );

  const stale = benchPage("p99", "file", 7, BASE + 20 * DAY);
  assertStringIncludes(
    stale,
    "No benchmark samples were found in the selected window.",
  );
  assert(!stale.includes('class="brow'));
});

Deno.test("/bench: the page names the repo and workflow it read", async () => {
  const html = await page("");
  assertStringIncludes(html, `${REPO} · benchmarks.yml`);
  assertStringIncludes(
    html,
    `https://github.com/${REPO}/actions/workflows/benchmarks.yml`,
  );
});

Deno.test("/bench runtime preserves the selected CI repository across its links", () => {
  const html = benchPage("p75", "duration", 9, BASE, "loom");

  assertStringIncludes(html, '<input type="hidden" name="repo" value="loom">');
  assertStringIncludes(
    html,
    'href="/bench?view=ci&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">CI duration history</a>',
  );
  assertStringIncludes(
    html,
    'href="/bench?view=gantt&amp;repo=loom&amp;days=9&amp;sort=duration&amp;stat=p75">CI run Gantt</a>',
  );
});

Deno.test("benchmark: a pinned metric that disappeared yields to the current default", async () => {
  const runs = Array.from(
    { length: 4 },
    (_, index) => ghRun(38_100 + index, BASE - (3 - index) * DAY),
  );
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  for (let index = 0; index < runs.length; index++) {
    const run = runs[index];
    artifacts[run.id] = [{
      id: run.id * 10,
      name: "bench-results",
      expired: false,
    }];
    const benches = [
      bench(
        "packages/runner/scheduler-persistent-state.bench.ts",
        null,
        "current",
        timings(2_000),
      ),
      ...(index < 2
        ? [
          bench(
            "packages/old/removed.bench.ts",
            null,
            "removed",
            timings(9_000),
          ),
        ]
        : []),
    ];
    zips[run.id * 10] = await benchZip(report(benches));
  }

  await withApi({ pages: { 1: runs }, artifacts, zips }, async () => {
    const view = await benchmark.collect(ctx({
      GH_TOKEN: "t",
      BENCH_METRIC: "removed",
    }));
    assertEquals(view.value, "2.0µs");
    assertStringIncludes(view.extra ?? "", "current");
    assert(!view.extra?.includes("removed"));
  });
});

Deno.test("benchmark: a BENCH_METRIC that names nothing falls back to the default benchmark", async () => {
  // Runs 601-612 are cached from the fill above; only the pick changes.
  const at = (d: number) => BASE - (11 - d) * DAY;
  await withApi({
    pages: { 1: Array.from({ length: 12 }, (_, d) => ghRun(601 + d, at(d))) },
  }, async () => {
    const v = await benchmark.collect(
      ctx({ GH_TOKEN: "t", BENCH_METRIC: "no-such-benchmark" }),
    );
    // DEFAULT_METRIC is scheduler-persistent-state.bench.ts; "commit" is its first.
    assertEquals(v.value, "1.1µs");
    assertEquals(v.status, "warn");
    assertStringIncludes(v.extra ?? "", "p99 ▲12%");
  });
});

Deno.test("benchmark: with neither the named nor the default benchmark present, the slowest is shown", async () => {
  const at = (d: number) => BASE - (7 - d) * DAY;
  const artifacts: Api["artifacts"] = {};
  const zips: Api["zips"] = {};
  const runs: GhRun[] = [];
  for (let d = 0; d <= 7; d++) {
    const id = 701 + d;
    runs.push(ghRun(id, at(d)));
    artifacts[id] = [{ id: id * 10, name: "bench-results", expired: false }];
    zips[id * 10] = await benchZip(report([
      bench("packages/a/x.bench.ts", null, "fast", timings(1_000)),
      bench("packages/a/x.bench.ts", null, "slow", timings(500_000_000)),
    ]));
  }
  await withApi({ pages: { 1: runs }, artifacts, zips }, async () => {
    const v = await benchmark.collect(
      ctx({ GH_TOKEN: "t", BENCH_METRIC: "nothing-matches-this" }),
    );
    assertEquals(v.value, "500ms"); // the slowest benchmark by p99, not the 1µs one
    assertEquals(v.status, "good"); // flat
    assertEquals(v.duration, 7 * DAY);
  });
});

Deno.test("benchmark: an unreachable source grays out with a calm reason, and never reads red", async () => {
  await withApi({
    throws: new TypeError(
      "error sending request for url (https://api.github.com/...)",
    ),
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown"); // gray, not bad
    assertEquals(v.value, "—");
    assertEquals(v.sub, "source unreachable"); // not a stack trace or an api path
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
  });
});

Deno.test("benchmark: a rejected token grays out as an auth failure", async () => {
  await withApi({ status: 401 }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "wrong" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "auth failed"); // the http status is not put on the wall
  });
});

Deno.test("benchmark: benchmarks seen in only one run give no trend to draw", async () => {
  // Two runs, each reporting a different benchmark: no benchmark has two points,
  // so there is nothing to plot and the tile says so instead of guessing.
  const runs = [ghRun(801, BASE - DAY), ghRun(802, BASE)];
  await withApi({
    pages: { 1: runs },
    artifacts: {
      801: [{ id: 8_010, name: "bench-results", expired: false }],
      802: [{ id: 8_020, name: "bench-results", expired: false }],
    },
    zips: {
      8_010: await benchZip(
        report([bench("packages/a/one.bench.ts", null, "a", timings(10))]),
      ),
      8_020: await benchZip(
        report([bench("packages/a/two.bench.ts", null, "b", timings(20))]),
      ),
    },
  }, async () => {
    const v = await benchmark.collect(
      ctx({ GH_TOKEN: "t", BENCH_METRIC: "a" }),
    );
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "no metric");
    assertEquals(v.href, "/bench?view=runtime&repo=labs");
  });
});

Deno.test("benchmark: trend classification — flat or falling good, a rise warn, a steep rise bad", () => {
  const t = (v: number[]) => v.map((_, i) => i * DAY);
  const st = (v: number[]) => trendStatus(trendPct(t(v), v));
  assertEquals(st([100, 101, 99, 100, 100, 101, 99, 100]), "good");
  assertEquals(st([130, 125, 120, 115, 110, 105, 100]), "good");
  assertEquals(st([100, 102, 104, 106, 108, 110, 112]), "warn");
  assertEquals(st([100, 120, 140, 160, 180, 200, 240]), "bad");
});

Deno.test("benchmark: a whole day's samples collapse to that day's median before the trend is taken", () => {
  // Seven days, three samples each, all at 100 apart from one spike of 10000 in
  // the middle of day 3. The day's median is still 100, so the trend stays flat.
  const times: number[] = [], values: number[] = [];
  for (let d = 0; d < 7; d++) {
    for (let s = 0; s < 3; s++) {
      times.push(d * DAY + s * HOUR);
      values.push(d === 3 && s === 1 ? 10_000 : 100);
    }
  }
  assertEquals(trendPct(times, values), 0);
  // Values at or below zero are not timings and are left out entirely.
  assertEquals(trendPct([...times, 7 * DAY], [...values, 0]), 0);
});

Deno.test("benchmark: fewer than a week of days claims no trend", () => {
  assertEquals(trendPct([0, DAY, 2 * DAY], [100, 500, 2_000]), 0);
  assertEquals(
    benchmarkTrend(
      Array.from({ length: 12 }, (_, hour) => hour * HOUR),
      Array.from({ length: 12 }, (_, hour) => 2 ** hour),
    ),
    { pct: 0, status: "unknown", label: "new" },
  );
});

Deno.test("benchmark: an even number of days takes the mean of the two middle slopes", () => {
  // Eight days doubling each day: every pairwise slope is ln 2, so the median of
  // the even-sized list is ln 2 too, and seven days of it is a 128-fold rise.
  const v = [1, 2, 4, 8, 16, 32, 64, 128];
  const pct = trendPct(v.map((_, i) => i * DAY), v);
  assert(Math.abs(pct - 127) < 1e-6, `expected ~127, got ${pct}`);
  assertEquals(trendStatus(pct), "bad");
});

Deno.test("benchmark: formatNs picks a readable unit", () => {
  assertEquals(formatNs(500), "500ns");
  assertEquals(formatNs(1_500), "1.5µs");
  assertEquals(formatNs(50_000), "50µs");
  assertEquals(formatNs(2_000_000), "2.0ms");
  assertEquals(formatNs(50_000_000), "50ms");
  assertEquals(formatNs(2_500_000_000), "2.50s");
  assertEquals(formatNs(NaN), "—");
  assertEquals(formatNs(Infinity), "—");
});

Deno.test("benchmark: the trend thresholds", () => {
  assertEquals(trendStatus(0.05), "good"); // exactly at UP_PCT
  assertEquals(trendStatus(0.051), "warn");
  assertEquals(trendStatus(0.20), "warn"); // exactly at RAPID_PCT
  assertEquals(trendStatus(0.21), "bad");
  assertEquals(trendStatus(-1), "good");
});

Deno.test("benchmark routes serve the Gantt and both progress endpoints", async () => {
  const gantt = new URL("http://x/bench?view=gantt");
  const ganttResponse = await benchmark.routes![0].handler(
    new Request(gantt),
    gantt,
  );
  assertStringIncludes(
    await ganttResponse.text(),
    "<title>CI run Gantt</title>",
  );

  const gh = Deno.env.get("GH_TOKEN");
  const github = Deno.env.get("GITHUB_TOKEN");
  Deno.env.delete("GH_TOKEN");
  Deno.env.delete("GITHUB_TOKEN");
  try {
    const check = new URL("http://x/bench/check?view=ci");
    assertEquals(
      (await benchmark.routes![1].handler(new Request(check), check)).status,
      200,
    );
  } finally {
    if (gh === undefined) Deno.env.delete("GH_TOKEN");
    else Deno.env.set("GH_TOKEN", gh);
    if (github === undefined) Deno.env.delete("GITHUB_TOKEN");
    else Deno.env.set("GITHUB_TOKEN", github);
  }

  const progress = new URL("http://x/bench/runtime-progress");
  const progressResponse = await benchmark.routes![3].handler(
    new Request(progress),
    progress,
  );
  assertEquals(benchmark.routes![3].path, "/bench/runtime-progress");
  assertEquals(progressResponse.status, 400);
});

Deno.test("benchmark defaults a missing workflow run attempt to one", async () => {
  const runId = 80_001;
  const run = {
    id: runId,
    created_at: new Date(BASE).toISOString(),
    conclusion: "success",
  } as GhRun;
  await withApi({
    pages: { 1: [run] },
    artifacts: { [runId]: [] },
  }, async () => {
    await benchmark.collect(ctx({ GH_TOKEN: "token" }));
    const store = new BenchmarkHistoryStore();
    await store.load();
    assertEquals(store.get(runId, 1)?.runAttempt, 1);
  });
});

Deno.test("runtime benchmark progress removes failed listeners and closes cleanly", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-progress-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  let resolveRuns: (response: Response) => void = () => {};
  const runs = new Promise<Response>((resolve) => resolveRuns = resolve);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    return runs;
  }) as typeof fetch;
  try {
    const isolated = await import(
      `./benchmark.ts?listener=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx({ GH_TOKEN: `listener-${crypto.randomUUID()}` }),
    );
    const html = await response.text();
    const id = html.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    assertEquals(
      isolated.subscribeBenchmarkProgress("missing", () => {}),
      null,
    );
    assertEquals(
      isolated.subscribeBenchmarkProgress(id, () => {
        throw new Error("initial listener failed");
      }),
      null,
    );
    let listenerCalls = 0;
    assert(isolated.subscribeBenchmarkProgress(id, () => {
      listenerCalls++;
      if (listenerCalls > 1) throw new Error("updated listener failed");
    }));

    assertEquals(
      isolated.benchmarkHistoryProgressResponse(
        new URL("http://x/bench/runtime-progress"),
      ).status,
      400,
    );
    const progressUrl = new URL(`http://x/bench/runtime-progress?id=${id}`);
    const completion = isolated.benchmarkHistoryProgressResponse(progressUrl)
      .text();
    const canceled = isolated.benchmarkHistoryProgressResponse(progressUrl);
    const reader = canceled.body!.getReader();
    await reader.read();
    await reader.cancel();

    resolveRuns(Response.json({ workflow_runs: [] }));
    assertStringIncludes(await completion, '"phase":"complete"');
    assertEquals(listenerCalls, 2);
    assertStringIncludes(
      await isolated.benchmarkHistoryProgressResponse(progressUrl).text(),
      '"phase":"complete"',
    );
  } finally {
    resolveRuns(Response.json({ workflow_runs: [] }));
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime benchmark progress ignores duplicate terminal updates", async () => {
  const progress: BenchmarkFetchProgress = {
    id: "duplicate-terminal",
    phase: "complete",
    totalRuns: 0,
    cachedRuns: 0,
    requestsMade: 0,
    responsesReceived: 0,
    successfulResponses: 0,
    failedResponses: 0,
    completedRuns: 0,
    queuedRuns: 0,
    outstandingRequests: 0,
    needsReload: false,
    updatedAt: BASE,
  };
  let unsubscribed = false;
  const response = benchmarkHistoryProgressResponse(
    new URL("http://x/bench/runtime-progress?id=duplicate-terminal"),
    {
      progress: () => progress,
      subscribe: (_id, listener) => {
        listener(progress);
        listener(progress);
        return () => unsubscribed = true;
      },
    },
  );
  assertStringIncludes(await response.text(), '"phase":"complete"');
  assertEquals(unsubscribed, true);
});

Deno.test("runtime history reconstructs unmanifested cache data before asking for a token", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cache-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  const stats = {
    min: 400,
    avg: 500,
    max: 1_500,
    p75: 800,
    p99: 1_000,
    p995: 1_050,
    p999: 1_200,
  };
  try {
    const store = new BenchmarkHistoryStore();
    await store.load();
    store.set({
      runId: 81_001,
      runAttempt: 1,
      at: BASE - DAY,
      metrics: new Map([["packages/a/cache.bench.ts > cached", stats]]),
    });
    store.set({
      runId: 81_002,
      runAttempt: 1,
      at: BASE,
      metrics: new Map([["packages/a/cache.bench.ts > cached", stats]]),
    });
    await store.save(BASE);
    const isolated = await import(
      `./benchmark.ts?cache=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx(),
    );
    const html = await response.text();
    assertStringIncludes(
      html,
      "Set GH_TOKEN to refresh runtime benchmark history.",
    );
    assertStringIncludes(html, "cache.bench.ts");
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("empty runtime history asks for a token to collect data", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-cache-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  try {
    const isolated = await import(
      `./benchmark.ts?empty=${crypto.randomUUID()}`
    );
    const response = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      ctx(),
    );
    assertStringIncludes(
      await response.text(),
      "Set GH_TOKEN to collect runtime benchmark history.",
    );
  } finally {
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("benchmark collection reports cache writes that fail during a run or manifest", async () => {
  const archive = await benchZip(report([
    bench("packages/a/write.bench.ts", null, "write", timings(1_000)),
  ]));
  for (const failedRename of [1, 2]) {
    const directory = await Deno.makeTempDir({ prefix: "benchmark-write-" });
    const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
    const originalFetch = globalThis.fetch;
    const rename = Deno.rename;
    let renames = 0;
    Deno.env.set("DASHBOARD_CACHE_DIR", directory);
    try {
      const isolated = await import(
        `./benchmark.ts?write=${failedRename}-${crypto.randomUUID()}`
      );
      const runId = 82_000 + failedRename;
      const handler = serve({
        pages: { 1: [ghRun(runId, BASE)] },
        artifacts: {
          [runId]: [{
            id: runId * 10,
            name: "bench-results",
            expired: false,
          }],
        },
        zips: { [runId * 10]: archive },
      });
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        return Promise.resolve(handler(url));
      }) as typeof fetch;
      Deno.rename = ((oldpath, newpath) => {
        renames++;
        return renames === failedRename
          ? Promise.reject(new Error(`rename ${failedRename} failed`))
          : rename(oldpath, newpath);
      }) as typeof Deno.rename;

      const view = await isolated.benchmark.collect(ctx({ GH_TOKEN: "token" }));
      assertEquals(view.status, "unknown");
      assertEquals(renames, failedRename);
    } finally {
      Deno.rename = rename;
      globalThis.fetch = originalFetch;
      if (previousCacheDirectory === undefined) {
        Deno.env.delete("DASHBOARD_CACHE_DIR");
      } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
      await Deno.remove(directory, { recursive: true });
    }
  }
});

Deno.test("a queued runtime history refresh reuses a dashboard refresh that just completed", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-queue-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  let resolveRuns: (response: Response) => void = () => {};
  const runs = new Promise<Response>((resolve) => resolveRuns = resolve);
  let workflowRequests = 0;
  let rateRequests = 0;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") {
      rateRequests++;
      return Promise.resolve(serve({})(url));
    }
    workflowRequests++;
    return runs;
  }) as typeof fetch;
  let dashboard: Promise<TileView> | undefined;
  try {
    const isolated = await import(
      `./benchmark.ts?queue=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: `queue-${crypto.randomUUID()}` });
    dashboard = isolated.benchmark.collect(tokenContext);
    const page = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const html = await page.text();
    const id = html.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    const completion = isolated.benchmarkHistoryProgressResponse(
      new URL(`http://x/bench/runtime-progress?id=${id}`),
    ).text();

    resolveRuns(Response.json({ workflow_runs: [] }));
    await dashboard;
    assertStringIncludes(await completion, '"phase":"complete"');
    assertEquals(workflowRequests, 1);
    assertEquals(rateRequests, 0);
  } finally {
    resolveRuns(Response.json({ workflow_runs: [] }));
    await dashboard?.catch(() => {});
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("runtime history reports a recent failed collection without starting another", async () => {
  const directory = await Deno.makeTempDir({ prefix: "benchmark-failure-" });
  const previousCacheDirectory = Deno.env.get("DASHBOARD_CACHE_DIR");
  const originalFetch = globalThis.fetch;
  Deno.env.set("DASHBOARD_CACHE_DIR", directory);
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rate_limit") return Promise.resolve(serve({})(url));
    return Promise.resolve(new Response("unavailable", { status: 503 }));
  }) as typeof fetch;
  try {
    const isolated = await import(
      `./benchmark.ts?failure=${crypto.randomUUID()}`
    );
    const tokenContext = ctx({ GH_TOKEN: `failure-${crypto.randomUUID()}` });
    const first = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    const firstHtml = await first.text();
    const id = firstHtml.match(/runtime-progress\?id=([^"&]+)/)?.[1];
    assert(id);
    assertStringIncludes(
      await isolated.benchmarkHistoryProgressResponse(
        new URL(`http://x/bench/runtime-progress?id=${id}`),
      ).text(),
      '"phase":"error"',
    );

    const second = await isolated.benchmarkHistoryResponse(
      new URL("http://x/bench?view=runtime"),
      tokenContext,
    );
    assertStringIncludes(await second.text(), "Last collection stopped:");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousCacheDirectory === undefined) {
      Deno.env.delete("DASHBOARD_CACHE_DIR");
    } else Deno.env.set("DASHBOARD_CACHE_DIR", previousCacheDirectory);
    await Deno.remove(directory, { recursive: true });
  }
});
