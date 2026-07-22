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
import type { Tile, TileView } from "./types.ts";

const req = (path: string) => new Request(`http://localhost${path}`);

// intervalMs 0 keeps a stand-in due on every tick, whatever earlier tests ran.
function fake(id: string, collect: () => TileView | Promise<TileView>, intervalMs = 0): Tile {
  return { id, intervalMs, collect: () => Promise.resolve(collect()) };
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
  const handoff = tick([
    fake("model-spend", () => modelGood),
    fake("gcp-spend", () => new Promise<TileView>((resolve) => release = resolve)),
  ]);
  await Promise.resolve();
  assertStringIncludes(
    tileHtml("atomic model spend"),
    `good" data-tile-id="model-spend">`,
  );
  assertStringIncludes(
    tileHtml("atomic gcp spend"),
    `good" data-tile-id="gcp-spend">`,
  );
  assertEquals(faviconRedSinceInPage(), redSince);

  release(gcpBad);
  await handoff;
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

Deno.test("a tick that is still running makes the next tick a no-op", async () => {
  let release = (_: TileView) => {};
  const slow = tick([fake("labs-ci", () => new Promise<TileView>((r) => release = r))]);
  let collects = 0;
  await tick([fake("loom-ci", () => {
    collects++;
    return { label: "loom ci", status: "good", value: "passing" };
  })]);
  assertEquals(collects, 0, "the overlapping tick collected nothing");
  release({ label: "labs ci", status: "good", value: "passing" });
  await slow;
});

Deno.test("each completed collection is published while slower tiles are still running", async () => {
  const messages: string[] = [];
  const client = {
    enqueue(value: Uint8Array) {
      messages.push(dec.decode(value));
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  clients.add(client);
  let beforeSlow: string[] = [];
  try {
    await tick([
      fake("labs-ci", () => ({ label: "fast", status: "good" })),
      fake("loom-ci", async () => {
        await Promise.resolve();
        beforeSlow = [...messages];
        return { label: "slow", status: "good" };
      }),
    ]);
  } finally {
    clients.delete(client);
  }
  assertEquals(beforeSlow.length, 1);
  assertStringIncludes(updateFromEvent(beforeSlow[0]).gridHtml, "fast");
  assertEquals(messages.length, 2);
  assertStringIncludes(updateFromEvent(messages[1]).gridHtml, "slow");
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

Deno.test("start: serves the handler on the configured port and keeps collecting", async () => {
  // A tick in flight makes start()'s own first tick a no-op, so this reaches no source.
  let release = (_: TileView) => {};
  const inflight = tick([fake("labs-ci", () => new Promise<TileView>((r) => release = r))]);

  const served: { opts: Deno.ServeTcpOptions; handler: unknown }[] = [];
  const logged: string[] = [];
  const log = console.log;
  console.log = (m: string) => logged.push(m);
  let timer = 0;
  try {
    timer = start(((opts: Deno.ServeTcpOptions, handler: unknown) => {
      served.push({ opts, handler });
      opts.onListen?.({ transport: "tcp", hostname: "localhost", port: PORT });
      return undefined;
    }) as unknown as typeof Deno.serve).timer;
  } finally {
    clearInterval(timer);
    console.log = log;
  }
  assertEquals(served.length, 1);
  assertEquals(served[0].opts.port, PORT);
  assertEquals(served[0].handler, handle, "every request goes through the one handler");
  assertStringIncludes(logged[0], `http://localhost:${PORT}`);
  assertStringIncludes(logged[0], `${TILES.length} tiles registered`);

  release({ label: "labs ci", status: "good", value: "passing" });
  await inflight;
});
