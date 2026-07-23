// Tests for the generic runtime: the ticker, the SSE fan-out, the routes, and
// the page. Importing server.ts neither serves nor collects, so nothing here
// binds a port or reaches a source; the tiles are stand-ins with a canned
// collect(), registered under the ids the real registry uses so their views
// reach the page.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  broadcast,
  clients,
  handle,
  nextFaviconRedSince,
  page,
  start,
  tick,
} from "./server.ts";
import { LOOM_CI_WORKFLOW, LOOM_REPO, PORT } from "./config.ts";
import { TILES } from "./registry.ts";
import type { Ctx, Run, RunSource, Tile, TileView } from "./types.ts";

const req = (path: string) => new Request(`http://localhost${path}`);

// intervalMs 0 keeps a stand-in due on every tick, whatever earlier tests ran.
function fake(id: string, collect: () => TileView | Promise<TileView>, intervalMs = 0): Tile {
  return { id, intervalMs, collect: () => Promise.resolve(collect()) };
}

function sourceRun(id: number, title: string): Run {
  return {
    id,
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    event: "push",
    head_sha: `sha-${id}`,
    display_title: title,
    run_started_at: new Date(Date.now() - id * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
    html_url: "",
    head_commit: { message: title },
  };
}

function deferred<T>() {
  let resolve = (_value: T) => {};
  let reject = (_reason: unknown) => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sourceTile(
  id: string,
  label: string,
  runSources: readonly RunSource[],
  wide = false,
): Tile {
  return {
    id,
    intervalMs: 0,
    runSources,
    wide,
    async collect(ctx): Promise<TileView> {
      const snapshots = await Promise.all(runSources.map((source) => ctx.runsFor(source.repo, source.workflow)));
      const titles = snapshots.flat().map((run) => run.display_title);
      return { label, status: "good", value: titles.join(", ") || "empty" };
    },
  };
}

const dec = new TextDecoder();
async function chunk(r: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await r.read();
  assert(!done, "the event stream ended");
  return dec.decode(value);
}

interface TestUpdate {
  gridHtml: string;
  wideHtml: string;
  ageSeconds: number;
  shellVersion: number;
  faviconStatus: "good" | "warn" | "bad";
  faviconRedSince: number | null;
  faviconRedAgeMs: number | null;
}

function updateFromEvent(event: string): TestUpdate {
  assertStringIncludes(event, "event: update\n");
  return JSON.parse(event.match(/^data: (.*)$/m)?.[1] ?? "") as TestUpdate;
}

// The rendered markup for one tile, keyed off its header label. The returned
// string starts with the tile's status classes.
function tileHtml(label: string, html = page()): string {
  const parts = html.split(`<div class="tile `);
  const hit = parts.filter((p) => p.includes(`</span> ${label}<span class="spacer">`));
  assertEquals(hit.length, 1, `expected exactly one tile labelled "${label}"`);
  return hit[0];
}

function faviconRedSinceInPage(): string {
  const match = page().match(/let faviconServerRedSince = ([^;]+);/);
  assert(match, "the page includes the server red timestamp");
  return match[1];
}

Deno.test("healthz: not ok until the board has collected something", async () => {
  // Runs before any tick: nothing has been collected, so the probe an external
  // uptime check reads must not claim the board is up.
  const res = await handle(req("/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: false, at: 0 });
});

Deno.test("registered tiles render before their first collection completes", () => {
  const html = page(new Map());
  for (const tile of TILES) {
    assertStringIncludes(
      html,
      `</span> ${tile.id}<span class="spacer"></span>`,
    );
  }
  assert(tileHtml("recent-runs", html).startsWith(`unknown wide" data-tile-id="recent-runs">`));
});

Deno.test("favicon: serves distinct status PNGs and defaults unknown requests to green", async () => {
  const signature = new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
  const encoded: string[] = [];
  for (const status of ["good", "warn", "bad", "bad-crying"]) {
    const res = await handle(req(`/favicon.png?status=${status}`));
    assertEquals(res.headers.get("content-type"), "image/png");
    assertEquals(res.headers.get("cache-control"), "public, max-age=3600");
    const png = new Uint8Array(await res.arrayBuffer());
    assertEquals(png.slice(0, signature.length), signature);
    encoded.push(png.toBase64());
  }
  assertEquals(new Set(encoded).size, 4, "each face has its own raster icon");

  const unknown = new Uint8Array(
    await (await handle(req("/favicon.png?status=unknown"))).arrayBuffer(),
  );
  assertEquals(unknown.toBase64(), encoded[0], "an unsupported status stays green");
});

Deno.test("favicon: continuous red keeps its start time and recovery resets it", () => {
  assertEquals(nextFaviconRedSince(null, "good", 1_000), null);
  assertEquals(nextFaviconRedSince(null, "bad", 2_000), 2_000);
  assertEquals(nextFaviconRedSince(2_000, "bad", 3_000), 2_000);
  assertEquals(nextFaviconRedSince(2_000, "warn", 4_000), null);
  assertEquals(nextFaviconRedSince(null, "bad", 5_000), 5_000);
});

Deno.test("per-collector updates keep a red handoff's incident age", async () => {
  const modelBad: TileView = {
    label: "atomic model spend",
    status: "bad",
    value: "failed",
  };
  const modelGood: TileView = {
    label: "atomic model spend",
    status: "good",
    value: "passing",
  };
  const gcpGood: TileView = {
    label: "atomic gcp spend",
    status: "good",
    value: "passing",
  };
  const gcpBad: TileView = {
    label: "atomic gcp spend",
    status: "bad",
    value: "failed",
  };
  await tick([
    fake("model-spend", () => modelBad),
    fake("gcp-spend", () => gcpGood),
  ]);
  const redSince = faviconRedSinceInPage();
  assert(redSince !== "null");

  let release = (_: TileView) => {};
  let published = () => {};
  const firstUpdate = new Promise<void>((resolve) => published = resolve);
  const client = {
    enqueue() {
      published();
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const handoff = tick([
    fake("model-spend", () => modelGood),
    fake("gcp-spend", () => new Promise<TileView>((resolve) => release = resolve)),
  ]);
  try {
    await firstUpdate;
    assertStringIncludes(
      tileHtml("atomic model spend"),
      `good" data-tile-id="model-spend">`,
    );
    assertStringIncludes(
      tileHtml("atomic gcp spend"),
      `good" data-tile-id="gcp-spend">`,
    );
    assertEquals(faviconRedSinceInPage(), redSince);
  } finally {
    clients.delete(client);
    release(gcpBad);
    await handoff;
  }
  assertStringIncludes(
    tileHtml("atomic model spend"),
    `good" data-tile-id="model-spend">`,
  );
  assertStringIncludes(
    tileHtml("atomic gcp spend"),
    `bad" data-tile-id="gcp-spend">`,
  );
  assertEquals(faviconRedSinceInPage(), redSince);

  await tick([
    fake("model-spend", () => modelGood),
    fake("gcp-spend", () => gcpGood),
  ]);
  assertEquals(faviconRedSinceInPage(), "null");
});

Deno.test("simultaneous collector completions keep a red handoff's incident age", async () => {
  const realNow = Date.now;
  const startedAt = realNow() + 1_000;
  let now = startedAt;
  Date.now = () => now;
  const modelGood: TileView = {
    label: "simultaneous model spend",
    status: "good",
    value: "passing",
  };
  const modelBad: TileView = {
    label: "simultaneous model spend",
    status: "bad",
    value: "failed",
  };
  const gcpGood: TileView = {
    label: "simultaneous gcp spend",
    status: "good",
    value: "passing",
  };
  const gcpBad: TileView = {
    label: "simultaneous gcp spend",
    status: "bad",
    value: "failed",
  };
  const model = deferred<TileView>();
  const gcp = deferred<TileView>();
  let handoff: Promise<void> | undefined;
  try {
    await tick([
      fake("model-spend", () => modelBad),
      fake("gcp-spend", () => gcpGood),
    ]);
    const redSince = faviconRedSinceInPage();
    assertEquals(redSince, String(startedAt));

    now = startedAt + 1_000;
    handoff = tick([
      fake("model-spend", () => model.promise),
      fake("gcp-spend", () => gcp.promise),
    ]);
    model.resolve(modelGood);
    gcp.resolve(gcpBad);
    await handoff;

    assertEquals(faviconRedSinceInPage(), redSince);
  } finally {
    model.resolve(modelGood);
    gcp.resolve(gcpGood);
    await handoff;
    await tick([
      fake("model-spend", () => modelGood),
      fake("gcp-spend", () => gcpGood),
    ]);
    Date.now = realNow;
  }
});

Deno.test("a tile stays wide through failures and keeps its last good view", async () => {
  await tick([fake("recent-runs", () => {
    throw new Error("HTTP 404: Not Found");
  })]);
  const firstFailure = tileHtml("recent-runs");
  assert(firstFailure.startsWith(`unknown wide" data-tile-id="recent-runs">`));
  assertStringIncludes(firstFailure, `<p class="big unknown">—</p>`);
  assertStringIncludes(firstFailure, `<p class="sub">not found</p>`);

  const good: TileView = { label: "recent main runs", status: "good", value: "passing", sub: "10 runs" };
  await tick([fake("recent-runs", () => good)]);
  assert(tileHtml("recent main runs").startsWith(`good wide" data-tile-id="recent-runs">`));

  await tick([fake("recent-runs", () => {
    throw new Error("error sending request for url");
  })]);
  const html = tileHtml("recent main runs");
  assert(html.startsWith(`unknown wide" data-tile-id="recent-runs">`));
  assertStringIncludes(html, `<p class="big unknown">passing</p>`);
  assertStringIncludes(html, `<p class="sub">source unreachable</p>`);
});

Deno.test("the ticker leaves a tile alone until its interval has elapsed", async () => {
  let collects = 0;
  // An id of its own: an earlier tick of a registered id would already have
  // stamped that id's last run, leaving the tile not due here.
  const t = fake("interval-probe", () => {
    collects++;
    return { label: "interval probe", status: "good", value: "passing" };
  }, 600_000);
  await tick([t]);
  assertEquals(collects, 1);
  const at = (await (await handle(req("/healthz"))).json()).at;
  assert(at > 0, "collecting stamps the board's last change");

  await tick([t]); // nothing is due this time
  assertEquals(collects, 1, "the tile is not re-collected inside its interval");
  assertEquals((await (await handle(req("/healthz"))).json()).at, at, "and nothing is reported as changed");
});

Deno.test("overlapping ticks skip a tile already updating and collect other due tiles", async () => {
  const slow = deferred<TileView>();
  let duplicateCollects = 0;
  let otherCollects = 0;
  const first = tick([fake("overlap-slow", () => slow.promise)]);

  await tick([
    fake("overlap-slow", () => {
      duplicateCollects++;
      return { label: "duplicate", status: "good" };
    }),
    fake("overlap-fast", () => {
      otherCollects++;
      return { label: "fast", status: "good" };
    }),
  ]);

  assertEquals(duplicateCollects, 0, "the updating tile is not collected twice");
  assertEquals(otherCollects, 1, "another due tile is still collected");
  slow.resolve({ label: "slow", status: "good" });
  await first;
});

Deno.test("overlapping ticks skip an updating run source and refresh another source", async () => {
  const slowSource = { repo: "test/overlap-slow", workflow: "ci.yml" };
  const fastSource = { repo: "test/overlap-fast", workflow: "ci.yml" };
  const slowRuns = deferred<Run[]>();
  let slowFetches = 0;
  let fastFetches = 0;
  let slowCollections = 0;
  let fastCollections = 0;
  const sourceCtx: Ctx = {
    runs: () => slowRuns.promise,
    runsFor: (repo) => {
      if (repo === slowSource.repo) {
        slowFetches++;
        return slowRuns.promise;
      }
      fastFetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const slowTile: Tile = {
    id: "overlap-source-slow",
    intervalMs: 0,
    runSources: [slowSource],
    collect: () => {
      slowCollections++;
      return Promise.resolve({ label: "slow source", status: "good" });
    },
  };
  const fastTile: Tile = {
    id: "overlap-source-fast",
    intervalMs: 0,
    runSources: [fastSource],
    collect: () => {
      fastCollections++;
      return Promise.resolve({ label: "fast source", status: "good" });
    },
  };
  const first = tick([slowTile], sourceCtx);

  try {
    await tick([slowTile, fastTile], sourceCtx);
    assertEquals(slowFetches, 1, "the updating source is not fetched twice");
    assertEquals(slowCollections, 0, "the slow source has not completed");
    assertEquals(fastFetches, 1, "another due source is fetched");
    assertEquals(fastCollections, 1, "another source's tile is collected");
  } finally {
    slowRuns.resolve([]);
    await first;
  }
  assertEquals(slowCollections, 1);
});

Deno.test("a multi-source tile stays active until every source update completes", async () => {
  const slowSource = { repo: "test/multi-source-slow", workflow: "ci.yml" };
  const fastSource = { repo: "test/multi-source-fast", workflow: "ci.yml" };
  const slowRuns = deferred<Run[]>();
  let slowFetches = 0;
  let fastFetches = 0;
  let collections = 0;
  const sourceCtx: Ctx = {
    runs: () => slowRuns.promise,
    runsFor: (repo) => {
      if (repo === slowSource.repo) {
        slowFetches++;
        return slowRuns.promise;
      }
      fastFetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const tile: Tile = {
    id: "overlap-multi-source",
    intervalMs: 0,
    runSources: [slowSource, fastSource],
    collect: () => {
      collections++;
      return Promise.resolve({ label: "multi source", status: "good" });
    },
  };
  let published = () => {};
  const firstPublication = new Promise<void>((resolve) => published = resolve);
  const client = {
    enqueue() {
      published();
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const first = tick([tile], sourceCtx);

  try {
    await firstPublication;
    assertEquals(collections, 1, "the ready source collected the tile");
    await tick([tile], sourceCtx);
    assertEquals(slowFetches, 1, "the pending source was not fetched again");
    assertEquals(fastFetches, 1, "the completed source still skips the active tile");
  } finally {
    clients.delete(client);
    slowRuns.resolve([]);
    await first;
  }
  assertEquals(collections, 2, "the pending source completes its original collection");
});

Deno.test("each completed collection is published while slower tiles are still running", async () => {
  const messages: string[] = [];
  let firstPublished = (_message: string) => {};
  const firstUpdate = new Promise<string>((resolve) => firstPublished = resolve);
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      if (messages.length === 1) firstPublished(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const slow = deferred<TileView>();
  clients.add(client);
  const collection = tick([
    fake("labs-ci", () => ({ label: "fast", status: "good" })),
    fake("loom-ci", () => slow.promise),
  ]);
  try {
    const first = await firstUpdate;
    assertEquals(messages.length, 1);
    assertStringIncludes(updateFromEvent(first).gridHtml, "fast");
    slow.resolve({ label: "slow", status: "good" });
    await collection;
  } finally {
    clients.delete(client);
    slow.resolve({ label: "slow", status: "good" });
    await collection;
  }
  assertEquals(messages.length, 2);
  assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "slow");
});

Deno.test("each run source publishes its dependent tiles as one batch", async () => {
  const labsSource = { repo: "test/labs-incremental", workflow: "ci.yml" };
  const loomSource = { repo: "test/loom-incremental", workflow: "ci.yml" };
  const labs = deferred<Run[]>();
  const loom = deferred<Run[]>();
  const sourceCtx: Ctx = {
    runs: () => labs.promise,
    runsFor: (repo) => repo === labsSource.repo ? labs.promise : loom.promise,
    env: () => undefined,
  };
  const tiles = [
    sourceTile("labs-ci", "incremental labs ci", [labsSource]),
    sourceTile("ci-trust", "incremental labs trust", [labsSource]),
    sourceTile("loom-ci", "incremental loom ci", [loomSource]),
    sourceTile("loom-ci-trust", "incremental loom trust", [loomSource]),
    sourceTile("recent-runs", "incremental recent", [labsSource, loomSource], true),
  ];

  const messages: string[] = [];
  const waiting: ((message: string) => void)[] = [];
  const nextMessage = () => new Promise<string>((resolve) => waiting.push(resolve));
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      waiting.shift()?.(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const refresh = tick(tiles, sourceCtx);
  try {
    const firstMessage = nextMessage();
    labs.resolve([sourceRun(1, "labs new")]);
    const first = updateFromEvent(await firstMessage);
    assertStringIncludes(first.gridHtml, "incremental labs ci");
    assertStringIncludes(first.gridHtml, "incremental labs trust");
    assert(!first.gridHtml.includes("incremental loom ci"));
    assertStringIncludes(first.wideHtml, "incremental recent");
    assertStringIncludes(first.wideHtml, "labs new");
    assertStringIncludes(first.wideHtml, "loom-incremental pending");
    assertEquals(messages.length, 1, "one source arrival produces one broadcast");

    const secondMessage = nextMessage();
    loom.resolve([sourceRun(2, "loom new")]);
    const second = updateFromEvent(await secondMessage);
    assertStringIncludes(second.gridHtml, "incremental loom ci");
    assertStringIncludes(second.gridHtml, "incremental loom trust");
    assertStringIncludes(second.wideHtml, "labs new, loom new");
    assert(!second.wideHtml.includes("pending"));
    assertEquals(messages.length, 2, "the second source produces the second broadcast");
    await refresh;
  } finally {
    clients.delete(client);
    labs.resolve([]);
    loom.resolve([]);
    await refresh;
  }
});

Deno.test("a ready source publishes while an older combined collection is still running", async () => {
  const labsSource = { repo: "test/labs-independent", workflow: "ci.yml" };
  const loomSource = { repo: "test/loom-independent", workflow: "ci.yml" };
  const labs = deferred<Run[]>();
  const loom = deferred<Run[]>();
  const oldCollection = deferred<void>();
  let started = () => {};
  const oldCollectionStarted = new Promise<void>((resolve) => started = resolve);
  let publishOld = (_view: TileView) => {};
  const sourceCtx: Ctx = {
    runs: () => labs.promise,
    runsFor: (repo) => repo === labsSource.repo ? labs.promise : loom.promise,
    env: () => undefined,
  };
  const combined: Tile = {
    id: "recent-runs",
    intervalMs: 0,
    runSources: [labsSource, loomSource],
    wide: true,
    async collect(ctx, publish): Promise<TileView> {
      const [labsRuns, loomRuns] = await Promise.all([
        ctx.runsFor(labsSource.repo, labsSource.workflow),
        ctx.runsFor(loomSource.repo, loomSource.workflow),
      ]);
      if (!loomRuns.length) {
        publishOld = publish ?? publishOld;
        started();
        await oldCollection.promise;
      }
      const titles = [...labsRuns, ...loomRuns].map((run) => run.display_title);
      return { label: "independent recent", status: "good", value: titles.join(", ") };
    },
  };
  const tiles = [
    sourceTile("labs-ci", "independent labs", [labsSource]),
    sourceTile("loom-ci", "independent loom", [loomSource]),
    combined,
  ];

  const messages: string[] = [];
  let published = (_message: string) => {};
  const nextMessage = () => new Promise<string>((resolve) => published = resolve);
  const client = {
    enqueue(value: Uint8Array) {
      const message = dec.decode(value);
      messages.push(message);
      published(message);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  const refresh = tick(tiles, sourceCtx);
  try {
    labs.resolve([sourceRun(4, "labs ready")]);
    await oldCollectionStarted;

    const loomUpdate = nextMessage();
    loom.resolve([sourceRun(5, "loom ready")]);
    const first = updateFromEvent(await loomUpdate);
    assertStringIncludes(first.gridHtml, "independent loom");
    assertStringIncludes(first.wideHtml, "labs ready, loom ready");
    assert(!first.gridHtml.includes("independent labs"));
    publishOld({ label: "independent recent", status: "bad", value: "older cached merge" });
    assertEquals(messages.length, 1);
    assertStringIncludes(tileHtml("independent recent"), "labs ready, loom ready");

    const labsUpdate = nextMessage();
    oldCollection.resolve(undefined);
    const second = updateFromEvent(await labsUpdate);
    assertStringIncludes(second.gridHtml, "independent labs");
    assertStringIncludes(second.wideHtml, "labs ready, loom ready");
    assertEquals(messages.length, 2);
    await refresh;
  } finally {
    clients.delete(client);
    labs.resolve([]);
    loom.resolve([]);
    oldCollection.resolve(undefined);
    await refresh;
  }
});

Deno.test("a shared run source preserves each dependent tile's per-source interval", async () => {
  const source = { repo: "test/source-cadence", workflow: "ci.yml" };
  let fetches = 0;
  let fastCollections = 0;
  let slowCollections = 0;
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    runsFor: () => {
      fetches++;
      return Promise.resolve([]);
    },
    env: () => undefined,
  };
  const tiles: Tile[] = [
    {
      id: "labs-ci",
      intervalMs: 0,
      runSources: [source],
      collect(): Promise<TileView> {
        fastCollections++;
        return Promise.resolve({ label: "fast source cadence", status: "good" });
      },
    },
    {
      id: "ci-trust",
      intervalMs: 600_000,
      runSources: [source],
      collect(): Promise<TileView> {
        slowCollections++;
        return Promise.resolve({ label: "slow source cadence", status: "good" });
      },
    },
  ];

  await tick(tiles, sourceCtx);
  await tick(tiles, sourceCtx);

  assertEquals(fetches, 2);
  assertEquals(fastCollections, 2);
  assertEquals(slowCollections, 1);
});

Deno.test("a failed run source keeps its last good snapshot", async () => {
  const source = { repo: "test/stale-source", workflow: "ci.yml" };
  let failing = false;
  const sourceCtx: Ctx = {
    runs: () => sourceCtx.runsFor(source.repo, source.workflow),
    runsFor: () => failing
      ? Promise.reject(new Error("error sending request for url"))
      : Promise.resolve([sourceRun(3, "last good run")]),
    env: () => undefined,
  };
  const tile = sourceTile("labs-ci", "last good source", [source]);

  await tick([tile], sourceCtx);
  assertStringIncludes(tileHtml("last good source"), "last good run");

  failing = true;
  await tick([tile], sourceCtx);
  const stale = tileHtml("last good source");
  assert(stale.startsWith(`unknown" data-tile-id="labs-ci">`));
  assertStringIncludes(stale, "last good run");
  assertStringIncludes(stale, "stale-source source unreachable");
});

Deno.test("a tile can publish cached data while its collection is still running", async () => {
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  let releaseCollection!: (view: TileView) => void;
  const finalView = new Promise<TileView>((resolve) => {
    releaseCollection = resolve;
  });
  let cachedPublished!: () => void;
  const sawCached = new Promise<void>((resolve) => {
    cachedPublished = resolve;
  });
  let publishIntermediate = (_view: TileView) => {};
  let collection: Promise<void> | undefined;
  clients.add(client);
  try {
    collection = tick([{
      id: "benchmark",
      intervalMs: 0,
      async collect(_ctx, publish) {
        publishIntermediate = publish ?? publishIntermediate;
        publish?.({ label: "benchmark", status: "good", value: "cached" });
        cachedPublished();
        return await finalView;
      },
    }]);
    await sawCached;
    assertEquals(messages.length, 1);
    assertStringIncludes(updateFromEvent(messages[0]).gridHtml, "cached");

    releaseCollection({
      label: "benchmark",
      status: "good",
      value: "refreshed",
    });
    await collection;
    assertEquals(messages.length, 2);
    assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "refreshed");
    publishIntermediate({
      label: "benchmark",
      status: "bad",
      value: "late cached value",
    });
    assertEquals(messages.length, 2);
    assertStringIncludes(tileHtml("benchmark"), "refreshed");
  } finally {
    releaseCollection({
      label: "benchmark",
      status: "unknown",
      value: "stopped",
    });
    await collection;
    clients.delete(client);
  }
});

Deno.test("a source-backed tile can publish cached data while its collection is still running", async () => {
  const source = { repo: "test/intermediate-source", workflow: "ci.yml" };
  const sourceCtx: Ctx = {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: () => undefined,
  };
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const finalView = deferred<TileView>();
  let cachedPublished = () => {};
  const sawCached = new Promise<void>((resolve) => cachedPublished = resolve);
  let publishIntermediate = (_view: TileView) => {};
  let collection: Promise<void> | undefined;
  clients.add(client);
  try {
    collection = tick([{
      id: "benchmark",
      intervalMs: 0,
      runSources: [source],
      async collect(_ctx, publish) {
        publishIntermediate = publish ?? publishIntermediate;
        publish?.({ label: "source benchmark", status: "good", value: "cached" });
        cachedPublished();
        return await finalView.promise;
      },
    }], sourceCtx);
    await sawCached;
    assertEquals(messages.length, 1);
    assertStringIncludes(updateFromEvent(messages[0]).gridHtml, "cached");

    finalView.resolve({ label: "source benchmark", status: "good", value: "refreshed" });
    await collection;
    assertEquals(messages.length, 2);
    assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "refreshed");
    publishIntermediate({ label: "source benchmark", status: "bad", value: "late cached value" });
    assertEquals(messages.length, 2);
    assertStringIncludes(tileHtml("source benchmark"), "refreshed");
  } finally {
    finalView.resolve({ label: "source benchmark", status: "unknown", value: "stopped" });
    await collection;
    clients.delete(client);
  }
});

Deno.test("sse: /events opens a stream, tick pushes new tile markup, disconnect drops the client", async () => {
  const res = await handle(req("/events"));
  assertEquals(res.headers.get("content-type"), "text/event-stream");
  assertEquals(res.headers.get("cache-control"), "no-cache");
  const reader = res.body!.getReader();
  assertEquals(await chunk(reader), ": connected\n\n");
  assertEquals(clients.size, 1);
  const initial = updateFromEvent(await chunk(reader));
  assert(initial.shellVersion > 0);
  assert(initial.ageSeconds >= 0);
  assert(["good", "warn", "bad"].includes(initial.faviconStatus));
  assert(Object.hasOwn(initial, "faviconRedSince"));
  assert(Object.hasOwn(initial, "faviconRedAgeMs"));

  await tick([fake("labs-ci", () => ({ label: "labs ci", status: "good", value: "live update" }))]);
  const update = updateFromEvent(await chunk(reader));
  assertStringIncludes(update.gridHtml, `data-tile-id="labs-ci"`);
  assertStringIncludes(update.gridHtml, "live update");
  assert(update.ageSeconds >= 0);
  assertEquals(update.shellVersion, initial.shellVersion);
  assert(["good", "warn", "bad"].includes(update.faviconStatus));
  assert(Object.hasOwn(update, "faviconRedSince"));
  assert(Object.hasOwn(update, "faviconRedAgeMs"));

  await reader.cancel();
  assertEquals(clients.size, 0, "a disconnected browser is not kept as a client");
});

Deno.test("broadcast: a client whose stream is gone is dropped rather than throwing", async () => {
  const res = await handle(req("/events"));
  const dead = [...clients].at(-1)!;
  await res.body!.cancel(); // closes the stream, so enqueueing to it now throws
  clients.add(dead); // back in the set, standing for a disconnect that went unnoticed
  broadcast({
    gridHtml: "",
    wideHtml: "",
    ageSeconds: 0,
    shellVersion: 1,
    faviconStatus: "good",
    faviconRedSince: null,
    faviconRedAgeMs: null,
  });
  assertEquals(clients.size, 0);
});

Deno.test("routes: a tile's drill-down path wins over the page; anything else is the page", async () => {
  const gantt = await handle(req("/bench?view=gantt&repo=loom"));
  assertEquals(gantt.status, 200);
  const html = await gantt.text();
  assertStringIncludes(html, "<title>CI run Gantt</title>");
  assertStringIncludes(html, `${LOOM_REPO} · ${LOOM_CI_WORKFLOW}`);

  const sha = "c".repeat(40);
  const commitGantt = await handle(
    req(`/ci-gantt?repo=labs&sha=${sha}&limit=1&mainOnly=1&run=901:1`),
  );
  assertEquals(commitGantt.status, 200);
  assertStringIncludes(
    await commitGantt.text(),
    `<title>CI Gantt · ${sha.slice(0, 7)}</title>`,
  );

  const fallback = await handle(req("/not-a-route"));
  assertEquals(fallback.status, 200);
  assertEquals(fallback.headers.get("content-type"), "text/html; charset=utf-8");
  assertStringIncludes(await fallback.text(), "<title>Fabric wall — LIVE</title>");

  // Views have landed by now, so the probe reports the board as up.
  assertEquals((await (await handle(req("/healthz"))).json()).ok, true);
});

Deno.test("start: serves the handler on the configured port and keeps collecting", () => {
  const served: { opts: Deno.ServeTcpOptions; handler: unknown }[] = [];
  const logged: string[] = [];
  let collections = 0;
  const log = console.log;
  console.log = (m: string) => logged.push(m);
  let timer = 0;
  try {
    timer = start(((opts: Deno.ServeTcpOptions, handler: unknown) => {
      served.push({ opts, handler });
      opts.onListen?.({ transport: "tcp", hostname: "localhost", port: PORT });
      return undefined;
    }) as unknown as typeof Deno.serve, () => {
      collections++;
    }).timer;
  } finally {
    clearInterval(timer);
    console.log = log;
  }
  assertEquals(served.length, 1);
  assertEquals(served[0].opts.port, PORT);
  assertEquals(served[0].handler, handle, "every request goes through the one handler");
  assertStringIncludes(logged[0], `http://localhost:${PORT}`);
  assertStringIncludes(logged[0], `${TILES.length} tiles registered`);
  assertEquals(collections, 1, "startup collects immediately");
});
