#!/usr/bin/env -S deno run --allow-net --allow-run=deno --allow-read --allow-write --allow-env
// Fabric wall — modular live dashboard.
//
// Each tile lives in tiles/ and is registered once in registry.ts. This file is
// generic: it schedules every tile's collect() on its own interval, renders the
// results uniformly, serves the page, pushes SSE updates, and mounts any
// drill-down routes a tile declares. It knows nothing about individual tiles.
//
//   cd <repo root>
//   deno run --allow-net --allow-run=deno --allow-read --allow-write --allow-env \
//     packages/dashboard/server.ts
//   open http://localhost:8731
//
// Optional env for the token-gated tiles (each grays out cleanly without it):
//   SIGNOZ_URL, SIGNOZ_API_KEY        production error-rate tile
//   GCP_BILLING_TABLE                 cloud-spend tile (BigQuery REST; Workload
//                                     Identity in GKE, or GCP_SA_KEY locally)
//   DISCORD_BOT_TOKEN, DISCORD_GUILD_ID   online-by-role tile
//   GH_TOKEN                          GitHub tiles; org Members read also powers
//                                     the organization-users tile

import { PORT } from "./config.ts";
import { TILES } from "./registry.ts";
import { makeCtx } from "./ctx.ts";
import { friendlyError } from "./lib.ts";
import { faviconPng, faviconStatus } from "./favicon.ts";
import type { FaviconStatus } from "./favicon.ts";
import { renderTile, shell, SHELL_VERSION } from "./render.ts";
import type { Tile, TileView } from "./types.ts";

const ctx = makeCtx();
const views = new Map<string, TileView>();
const lastRun = new Map<string, number>();
let lastChange = 0;
let faviconRedSince: number | null = null;

export function nextFaviconRedSince(
  current: number | null,
  status: FaviconStatus,
  now: number,
): number | null {
  return status === "bad" ? current ?? now : null;
}

function updateFaviconRedSince(now: number, recoveryIsSettled = true): void {
  const status = faviconStatus(
    TILES.flatMap((tile) => {
      const view = views.get(tile.id);
      return view ? [view.status] : [];
    }),
  );
  if (status === "bad" || recoveryIsSettled) {
    faviconRedSince = nextFaviconRedSince(faviconRedSince, status, now);
  }
}

interface DashboardUpdate {
  gridHtml: string;
  wideHtml: string;
  ageSeconds: number;
  shellVersion: number;
  faviconStatus: FaviconStatus;
  faviconRedSince: number | null;
  faviconRedAgeMs: number | null;
}

function dashboardUpdate(currentViews: ReadonlyMap<string, TileView> = views): DashboardUpdate {
  const grid: string[] = [];
  const wide: string[] = [];
  const statuses: TileView["status"][] = [];
  for (const t of TILES) {
    const v = currentViews.get(t.id) ?? {
      label: t.id,
      status: "unknown" as const,
    };
    statuses.push(v.status);
    (t.wide ? wide : grid).push(renderTile(v, t.id, t.wide));
  }
  const now = Date.now();
  const ageSeconds = lastChange
    ? Math.max(0, Math.floor((now - lastChange) / 1000))
    : 0;
  return {
    gridHtml: grid.join(""),
    wideHtml: wide.join(""),
    ageSeconds,
    shellVersion: SHELL_VERSION,
    faviconStatus: faviconStatus(statuses),
    faviconRedSince,
    faviconRedAgeMs: faviconRedSince === null
      ? null
      : Math.max(0, now - faviconRedSince),
  };
}

export const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
const encodeUpdate = (update: DashboardUpdate) =>
  enc.encode(`event: update\ndata: ${JSON.stringify(update)}\n\n`);
export const broadcast = (update: DashboardUpdate) => {
  const event = encodeUpdate(update);
  for (const c of clients) {
    try {
      c.enqueue(event);
    } catch {
      clients.delete(c); // drop a dead controller so the set can't grow forever
    }
  }
};

// One ticker collects every tile that is due (respecting each tile's interval).
// A reentrancy guard stops a slow tick from overlapping the next one.
const TICK_MS = 15_000;
let ticking = false;
export async function tick(tiles: Tile[] = TILES) {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = tiles.filter((t) => now - (lastRun.get(t.id) ?? 0) >= t.intervalMs);
    if (!due.length) return;
    let remaining = due.length;
    await Promise.all(due.map(async (t) => {
      let view: TileView;
      try {
        view = await t.collect(ctx);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`tile ${t.id} failed:`, msg); // full detail to the log
        // A failed collection preserves the previous view in gray and shows a
        // short error.
        const prev = views.get(t.id);
        view = prev
          ? { ...prev, status: "unknown", sub: friendlyError(msg) }
          : { label: t.id, status: "unknown", value: "—", sub: friendlyError(msg) };
      }
      views.set(t.id, view);
      lastRun.set(t.id, Date.now());
      lastChange = Date.now();
      remaining--;
      // A non-red intermediate snapshot keeps the incident until every due
      // collection has settled.
      updateFaviconRedSince(lastChange, remaining === 0);
      broadcast(dashboardUpdate());
    }));
  } finally {
    ticking = false;
  }
}

// Collect drill-down routes declared by tiles.
const routes = TILES.flatMap((t) => t.routes ?? []);

// How often the page actually updates, which the client colors the "updated"
// indicator against (fresh up to this, then stale). The server broadcasts when a
// tile is due, but the 15s ticker only notices a tile is due on the tick after its
// interval elapses (and collection latency pushes that to the tick after that), so
// the real cadence for the fastest tile is its interval plus a tick, not the bare
// interval.
const REFRESH_MS = Math.min(...TILES.map((t) => t.intervalMs)) + TICK_MS;

export function page(currentViews: ReadonlyMap<string, TileView> = views): string {
  const update = dashboardUpdate(currentViews);
  return shell(
    update.gridHtml,
    update.wideHtml,
    update.ageSeconds,
    REFRESH_MS,
    update.shellVersion,
    update.faviconStatus,
    update.faviconRedSince,
    update.faviconRedAgeMs,
  );
}

export async function handle(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/favicon.png") {
    return new Response(faviconPng(url.searchParams.get("status")), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=3600",
      },
    });
  }
  if (url.pathname === "/events") {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        clients.add(c);
        c.enqueue(enc.encode(": connected\n\n"));
        c.enqueue(encodeUpdate(dashboardUpdate()));
      },
      cancel() {
        if (controller) clients.delete(controller);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname === "/healthz") return Response.json({ ok: views.size > 0, at: lastChange });
  for (const r of routes) {
    if (url.pathname === r.path) return await r.handler(req, url);
  }
  return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
}

// The side effects: collect once, keep collecting, and serve. Running the file
// starts them; importing it does not.
export function start(serve: typeof Deno.serve = Deno.serve) {
  tick();
  const timer = setInterval(tick, TICK_MS);
  const server = serve({
    port: PORT,
    onListen: () => console.log(`\n  Fabric wall LIVE:  http://localhost:${PORT}\n  ${TILES.length} tiles registered.\n`),
  }, handle);
  return { timer, server };
}

// Running the file boots; importing it (the tests do) boots nothing.
if (import.meta.main) start();
