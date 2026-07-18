// Tests for the generic runtime: the ticker, the SSE fan-out, the routes, and
// the page. Importing server.ts neither serves nor collects, so nothing here
// binds a port or reaches a source; the tiles are stand-ins with a canned
// collect(), registered under the ids the real registry uses so their views
// reach the page.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { broadcast, clients, handle, page, start, tick } from "./server.ts";
import { PORT } from "./config.ts";
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
}

function updateFromEvent(event: string): TestUpdate {
  assertStringIncludes(event, "event: update\n");
  return JSON.parse(event.match(/^data: (.*)$/m)?.[1] ?? "") as TestUpdate;
}

// The rendered markup for one tile, keyed off its header label. The returned
// string starts with the tile's status classes.
function tileHtml(label: string): string {
  const parts = page().split(`<div class="tile `);
  const hit = parts.filter((p) => p.includes(`</span> ${label}<span class="spacer">`));
  assertEquals(hit.length, 1, `expected exactly one tile labelled "${label}"`);
  return hit[0];
}

Deno.test("healthz: not ok until the board has collected something", async () => {
  // Runs before any tick: nothing has been collected, so the probe an external
  // uptime check reads must not claim the board is up.
  const res = await handle(req("/healthz"));
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { ok: false, at: 0 });
});

Deno.test("a tile that has never succeeded falls back to a gray tile labelled with its id", async () => {
  await tick([fake("labs-ci", () => {
    throw new Error("HTTP 404: Not Found");
  })]);
  const html = tileHtml("labs-ci"); // no view to keep, so the id stands in for the label
  assert(html.startsWith(`unknown" data-tile-id="labs-ci">`)); // gray, never a color it hasn't earned
  assertStringIncludes(html, `<p class="big unknown">—</p>`);
  assertStringIncludes(html, `<p class="sub">not found</p>`); // the short reason, not the raw error
});

Deno.test("a tile whose collect throws keeps its last good view, desaturated to gray", async () => {
  const good: TileView = { label: "recent main runs", status: "good", value: "passing", sub: "10 runs", wide: true };
  await tick([fake("recent-runs", () => good)]);
  assert(tileHtml("recent main runs").startsWith(`good wide" data-tile-id="recent-runs">`));

  await tick([fake("recent-runs", () => {
    throw new Error("error sending request for url");
  })]);
  const html = tileHtml("recent main runs");
  assert(html.startsWith(`unknown wide" data-tile-id="recent-runs">`)); // gray, and still full-width
  assertStringIncludes(html, `<p class="big unknown">passing</p>`); // the last-known value stays on the wall
  assertStringIncludes(html, `<p class="sub">source unreachable</p>`); // and says why it can't tell
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

  await tick([fake("labs-ci", () => ({ label: "labs ci", status: "good", value: "live update" }))]);
  const update = updateFromEvent(await chunk(reader));
  assertStringIncludes(update.gridHtml, `data-tile-id="labs-ci"`);
  assertStringIncludes(update.gridHtml, "live update");
  assert(update.ageSeconds >= 0);
  assertEquals(update.shellVersion, initial.shellVersion);

  await reader.cancel();
  assertEquals(clients.size, 0, "a disconnected browser is not kept as a client");
});

Deno.test("broadcast: a client whose stream is gone is dropped rather than throwing", async () => {
  const res = await handle(req("/events"));
  const dead = [...clients].at(-1)!;
  await res.body!.cancel(); // closes the stream, so enqueueing to it now throws
  clients.add(dead); // back in the set, standing for a disconnect that went unnoticed
  broadcast({ gridHtml: "", wideHtml: "", ageSeconds: 0, shellVersion: 1 });
  assertEquals(clients.size, 0);
});

Deno.test("routes: a tile's drill-down path wins over the page; anything else is the page", async () => {
  // ci-duration declares /ci, so the generic runtime serves it without knowing the tile.
  const drill = await handle(req("/ci"));
  assertEquals(drill.status, 200);
  const html = await drill.text();
  assertStringIncludes(html, "<title>CI Gantt — configurable</title>");

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
