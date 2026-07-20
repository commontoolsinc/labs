// benchmark tile tests. The tile is driven through collect(ctx) and its /bench
// route with globalThis.fetch stubbed, so the GitHub Actions workflow-run pages,
// the per-run artifact listings and the artifact zips (real zip bytes, really
// deflated) are all canned. No network, no files, no subprocess.
//
// The tile keeps a per-process cache of each run's results and a module-level
// snapshot for the drill-down page, so these tests share state: every test uses
// its own run ids, and the tests that read the snapshot follow the collect that
// filled it. They run in declaration order.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { Ctx } from "../types.ts";
import { REPO } from "../config.ts";
import { benchmark, formatNs, jsonFromZip, trendPct, trendStatus } from "./benchmark.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Midnight UTC yesterday plus two hours: half way through a 4-hour sampling
// window, so a run an hour either side of it lands in the same window.
const BASE = Math.floor(Date.now() / DAY) * DAY - DAY + 2 * HOUR;

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
function makeZip(members: Member[], entryCount = members.length): Uint8Array<ArrayBuffer> {
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
  created_at: string;
  conclusion: string | null;
}

const ghRun = (id: number, at: number, conclusion: string | null = "success"): GhRun => ({
  id,
  created_at: new Date(at).toISOString(),
  conclusion,
});

interface Api {
  pages?: Record<number, GhRun[]>;
  // runId -> its artifact listing, or an HTTP status to fail with.
  artifacts?: Record<number, { id: number; name: string; expired: boolean }[] | number>;
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
    if (api.throws) throw api.throws;
    if (api.status) return new Response("no", { status: api.status });
    if (url.pathname.endsWith("/actions/workflows/benchmarks.yml/runs")) {
      return Response.json({ workflow_runs: api.pages?.[Number(url.searchParams.get("page"))] ?? [] });
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
      if (v === undefined || typeof v === "number") return new Response("no", { status: typeof v === "number" ? v : 404 });
      return new Response(v);
    }
    throw new Error(`unexpected request ${url.pathname}`);
  };
}

// Swap in the stub api for one test, recording every path requested, and put the
// real fetch back afterwards so no state leaks into the rest of the process.
async function withApi(api: Api, fn: (calls: string[]) => Promise<void>): Promise<void> {
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
const artifactCalls = (calls: string[]) => calls.filter((c) => c.includes("/artifacts"));

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

const bench = (origin: string, group: string | null, name: string, ok: Timings | undefined) => ({
  origin: `file:///w/${origin}`,
  group,
  name,
  results: [ok ? { ok } : {}],
});

// The deno bench report. `noise` stands in for a benchmark's own console output
// landing on stdout ahead of the JSON.
const report = (benches: unknown[], noise = "") => noise + JSON.stringify({ version: 1, runtime: "deno", benches });

// ----------------------------------------------------------------- the tests

Deno.test("benchmark: no token -> gray, and nothing is fetched", async () => {
  await withApi({ throws: new Error("no request expected") }, async (calls) => {
    const v = await benchmark.collect(ctx({}));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "set GH_TOKEN");
    assertEquals(v.href, undefined); // no drill-down offered when there is nothing behind it
    assertEquals(calls, []);
  });
});

Deno.test("benchmark: GITHUB_TOKEN stands in for GH_TOKEN", async () => {
  await withApi({ pages: {} }, async (calls) => {
    const v = await benchmark.collect(ctx({ GITHUB_TOKEN: "t" }));
    assertEquals(v.sub, "no benchmark runs"); // it got past the token gate and asked
    assertEquals(calls.length, 1);
    assertStringIncludes(calls[0], runsPath);
  });
});

Deno.test("/bench before any data: says it is still collecting, rather than drawing an empty chart", () => {
  const url = new URL("http://x/bench");
  const res = benchmark.routes![0].handler(new Request(url), url) as Response;
  assertEquals(benchmark.routes![0].path, "/bench");
  assertEquals(res.headers.get("content-type"), "text/html; charset=utf-8");
});

Deno.test("/bench before any data: the body is the collecting notice", async () => {
  const url = new URL("http://x/bench");
  const html = await (benchmark.routes![0].handler(new Request(url), url) as Response).text();
  assertStringIncludes(html, `<p class="empty">Collecting benchmark data from CI artifacts`);
  assertStringIncludes(html, "<title>Benchmarks — p99</title>"); // p99 is the default measurement
  assert(!html.includes('class="brow'), "no rows are drawn with nothing to draw");
});

Deno.test("benchmark: paging stops at the 45-day cutoff; failures and out-of-window runs are not sampled", async () => {
  // One full page whose oldest run is past the window: the loop stops there rather
  // than asking for page 2. Nothing on it is both successful and in-window.
  const page1 = [
    ...Array.from({ length: 99 }, (_, i) => ghRun(1_000 + i, BASE - i * HOUR, "failure")),
    ghRun(1_099, BASE - 50 * DAY, "success"), // in date order last, and older than the cutoff
  ];
  await withApi({ pages: { 1: page1 } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "no benchmark runs");
    assertEquals(v.href, "/bench");
    assertEquals(v.hint, "all metrics ↗");
    assertEquals(calls.length, 1); // page 2 was never asked for
    assertEquals(artifactCalls(calls), []); // and no artifact was downloaded
  });
});

Deno.test("benchmark: an empty page ends the paging", async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ghRun(2_000 + i, BASE - i * HOUR, "failure"));
  await withApi({ pages: { 1: page1, 2: [] } }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.sub, "no benchmark runs");
    // A full page still inside the window is followed; the empty page 2 stops it.
    assertEquals(calls.map((c) => c.match(/[?&]page=(\d+)/)![1]), ["1", "2"]);
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
  const art = (id: number, name = "bench-results", expired = false) => ({ id, name, expired });
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
      4_030: makeZip([{ name: "notes.txt", method: 0, data: bytes("nothing useful") }]),
    },
  }, async (calls) => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "benchmark data unavailable");
    assertEquals(v.href, "/bench");
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
  const json = report([bench("packages/a/x.bench.ts", null, "tick", timings(1_000))]);
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
    assert(calls.some((c) => c.includes("/runs/402/artifacts")), "the failed zip download is retried");
    assert(calls.some((c) => c.includes("/runs/404/artifacts")), "the failed listing is retried");
    // The settled runs are answered from the cache; the healthy source is not asked.
    assert(!calls.some((c) => c.includes("/runs/401/artifacts")), "a run with no usable artifact is settled");
    assert(!calls.some((c) => c.includes("/runs/403/artifacts")), "a zip with no report is settled");
  });
});

Deno.test("benchmark: one benchmark, one run sampled per 4-hour window (the newest in the window wins)", async () => {
  // Twelve days, one run a day, all at 1µs. Two runs share the last window: the
  // older one is wildly slow, so if the wrong one were sampled the headline would
  // read 10ms and the tile would turn red.
  const at = (d: number) => BASE - (11 - d) * DAY;
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
    zips[id * 10] = await benchZip(JSON.stringify({ benches: [bench(key, null, "tick", timings(1_000))] }));
  }
  // The stale twin, listed before its window's winner so the newer one displaces it.
  runs.push(ghRun(599, at(11) - HOUR));
  artifacts[599] = [{ id: 5_990, name: "bench-results", expired: false }];
  zips[5_990] = await benchZip(JSON.stringify({ benches: [bench(key, null, "tick", timings(9_999_999))] }));

  await withApi({ pages: { 1: [ghRun(599, at(11) - HOUR), ...runs.slice(0, 12)] }, artifacts, zips }, async () => {
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
  const at = (d: number) => BASE - (11 - d) * DAY;
  const runs = [ghRun(599, at(11) - HOUR), ...Array.from({ length: 12 }, (_, d) => ghRun(501 + d, at(d)))];
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
  const json = report([bench("packages/a/x.bench.ts", null, "tick", timings(5))]);
  assertEquals(await jsonFromZip(await benchZip(json)), json);
});

Deno.test("jsonFromZip: a zip with no json member -> null", async () => {
  const zip = makeZip([{ name: "notes.txt", method: 0, data: bytes("nothing") }]);
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
  const zip = makeZip([{ name: "results.json", method: 0, data: bytes(`{"benches":[]}`) }]);
  new DataView(zip.buffer).setUint32(0, 0xdeadbeef, true); // clobber the local file header signature
  assertEquals(await jsonFromZip(zip), null);
});

Deno.test("jsonFromZip: a compression method we cannot read -> null, not garbage", async () => {
  const zip = makeZip([{ name: "results.json", method: 99, data: bytes(`{"benches":[]}`) }]);
  assertEquals(await jsonFromZip(zip), null);
});

// A geometric series over twelve days: the Theil–Sen slope is exact, so the
// series ends at exactly `fold` times where it started.
const SHAPES = [
  // origin, group, name, p99 on day 0, end/start ratio
  ["packages/runner/scheduler-persistent-state.bench.ts", null, "commit", 1_000, 1.12],
  ["packages/runner/scheduler-persistent-state.bench.ts", "hot", "steep", 1_000_000, 20],
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
      bench("packages/x/skip.bench.ts", null, "not-a-number", { avg: "quick" } as unknown as Timings),
    ];
    // A benchmark's own console output precedes the report on stdout.
    zips[id * 10] = await benchZip(report(benches, "running 7 benchmarks\ncpu: apple m2\n"));
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
  const url = new URL(`http://x/bench${query}`);
  return await (benchmark.routes![0].handler(new Request(url), url) as Response).text();
};

Deno.test("benchmark: BENCH_METRIC pins the grid tile to a named benchmark", async () => {
  await withApi(await fillVaried(), async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t", BENCH_METRIC: "steep" }));
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
    ["packages/html/render.bench.ts", "packages/memory/query.bench.ts", "packages/runner/scheduler-persistent-state.bench.ts"],
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
  assertStringIncludes(html, `<a class="stat on" href="/bench?stat=p99&sort=file">p99</a>`);
  assertStringIncludes(html, `<a class="stat" href="/bench?stat=p75&sort=file">p75</a>`);
  assertStringIncludes(html, `<a class="stat on" href="/bench?stat=p99&sort=file">file</a>`);
  assertStringIncludes(html, `<a class="stat" href="/bench?stat=p99&sort=trend">trend</a>`);
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
  assertStringIncludes(html, `<a class="stat on" href="/bench?stat=p99&sort=trend">trend</a>`);
});

Deno.test("/bench: the measurement selector changes what is plotted", async () => {
  const p50 = rows(await page("?stat=p50"));
  assertEquals(p50.find((r) => r.name === "hot/steep")?.value, "10ms"); // the mean, half the p99
  // A benchmark that reported only an average reads the same at every percentile.
  assertEquals(p50.find((r) => r.name === "flat")?.value, "2.5ms");
  assertEquals(rows(await page("?stat=p0")).find((r) => r.name === "flat")?.value, "2.5ms");
  assertStringIncludes(await page("?stat=p50"), "<title>Benchmarks — p50</title>");
  // An unknown measurement falls back to the default rather than blanking the page.
  assertStringIncludes(await page("?stat=nonsense"), "<title>Benchmarks — p99</title>");
  assertEquals(rows(await page("?stat=nonsense")).find((r) => r.name === "hot/steep")?.value, "20ms");
  // So does an unknown sort.
  assertStringIncludes(await page("?sort=nonsense"), "<h2>packages/html/render.bench.ts</h2>");
});

Deno.test("/bench: the page names the repo and workflow it read", async () => {
  const html = await page("");
  assertStringIncludes(html, `${REPO} · benchmarks.yml`);
  assertStringIncludes(html, `https://github.com/${REPO}/actions/workflows/benchmarks.yml`);
});

Deno.test("benchmark: a BENCH_METRIC that names nothing falls back to the default benchmark", async () => {
  // Runs 601-612 are cached from the fill above; only the pick changes.
  const at = (d: number) => BASE - (11 - d) * DAY;
  await withApi({ pages: { 1: Array.from({ length: 12 }, (_, d) => ghRun(601 + d, at(d))) } }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t", BENCH_METRIC: "no-such-benchmark" }));
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
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t", BENCH_METRIC: "nothing-matches-this" }));
    assertEquals(v.value, "500ms"); // the slowest benchmark by p99, not the 1µs one
    assertEquals(v.status, "good"); // flat
    assertEquals(v.duration, 7 * DAY);
  });
});

Deno.test("benchmark: an unreachable source grays out with a calm reason, and never reads red", async () => {
  await withApi({ throws: new TypeError("error sending request for url (https://api.github.com/...)") }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t" }));
    assertEquals(v.status, "unknown"); // gray, not bad
    assertEquals(v.value, "—");
    assertEquals(v.sub, "source unreachable"); // not a stack trace or an api path
    assertEquals(v.href, "/bench");
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
      8_010: await benchZip(report([bench("packages/a/one.bench.ts", null, "a", timings(10))])),
      8_020: await benchZip(report([bench("packages/a/two.bench.ts", null, "b", timings(20))])),
    },
  }, async () => {
    const v = await benchmark.collect(ctx({ GH_TOKEN: "t", BENCH_METRIC: "a" }));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "no metric");
    assertEquals(v.href, "/bench");
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
