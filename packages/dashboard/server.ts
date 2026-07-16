#!/usr/bin/env -S deno run --allow-net --allow-run=deno --allow-read --allow-write --allow-env
// Fabric wall — modular live dashboard.
//
// Each tile lives in tiles/ and is registered once in registry.ts. This file is
// generic: it schedules every tile's collect() on its own interval, renders the
// results uniformly, serves the page, pushes SSE reloads, and mounts any
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

import { PORT } from "./config.ts";
import { TILES } from "./registry.ts";
import { makeCtx } from "./ctx.ts";
import { friendlyError } from "./lib.ts";
import { renderTile, shell } from "./render.ts";
import type { TileView } from "./types.ts";

const ctx = makeCtx();
const views = new Map<string, TileView>();
const lastRun = new Map<string, number>();
let lastChange = 0;

const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
const broadcast = (kind: string) => {
  for (const c of clients) {
    try {
      c.enqueue(enc.encode(`data: ${kind}\n\n`));
    } catch {
      clients.delete(c); // drop a dead controller so the set can't grow forever
    }
  }
};

// One ticker collects every tile that is due (respecting each tile's interval).
// A reentrancy guard stops a slow tick from overlapping the next one.
let ticking = false;
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    const due = TILES.filter((t) => now - (lastRun.get(t.id) ?? 0) >= t.intervalMs);
    if (!due.length) return;
    await Promise.all(due.map(async (t) => {
      try {
        views.set(t.id, await t.collect(ctx));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`tile ${t.id} failed:`, msg); // full detail to the log
        // Keep the last good view but desaturate it to gray and show a short
        // reason, so a blip leaves the last-known values on the wall (and keeps a
        // wide tile wide) instead of blanking everything to "—".
        const prev = views.get(t.id);
        views.set(
          t.id,
          prev
            ? { ...prev, status: "unknown", sub: friendlyError(msg) }
            : { label: t.id, status: "unknown", value: "—", sub: friendlyError(msg) },
        );
      }
      lastRun.set(t.id, Date.now());
    }));
    lastChange = Date.now();
    broadcast("reload");
  } finally {
    ticking = false;
  }
}
if (import.meta.main) {
  tick();
  setInterval(tick, 15_000);
}

// Collect drill-down routes declared by tiles.
const routes = TILES.flatMap((t) => t.routes ?? []);

const ROUTE_CACHE_TTL_MS = 60_000;
const ROUTE_CACHE_MAX_ENTRIES = 16;
interface RouteCacheEntry {
  at: number;
  response: Response;
}
const routeCache = new Map<string, RouteCacheEntry>();
let routeInflight: { key: string; response: Promise<Response> } | undefined;

export async function cachedRoute(
  key: string,
  render: () => Promise<Response>,
  now: () => number = Date.now,
  ttlMs = ROUTE_CACHE_TTL_MS,
): Promise<Response> {
  const cached = routeCache.get(key);
  if (cached && now() - cached.at <= ttlMs) {
    routeCache.delete(key);
    routeCache.set(key, cached);
    return cached.response.clone();
  }
  routeCache.delete(key);
  if (routeInflight?.key === key) return (await routeInflight.response).clone();
  if (routeInflight) {
    return new Response("render already in progress", {
      status: 429,
      headers: { "retry-after": "5" },
    });
  }
  const pending = (async () => {
    const res = await render();
    if (res.ok) {
      routeCache.set(key, { at: now(), response: res.clone() });
      if (routeCache.size > ROUTE_CACHE_MAX_ENTRIES) {
        const oldest = routeCache.keys().next().value;
        if (oldest !== undefined) routeCache.delete(oldest);
      }
    }
    return res;
  })().finally(() => {
    if (routeInflight?.response === pending) routeInflight = undefined;
  });
  routeInflight = { key, response: pending };
  return (await pending).clone();
}

export function ganttCacheKey(url: URL): string {
  const params = new URLSearchParams(url.searchParams);
  params.delete("t");
  params.sort();
  const search = params.toString();
  return search ? `${url.pathname}?${search}` : url.pathname;
}

function page(): string {
  const ago = Math.floor((Date.now() - (lastChange || Date.now())) / 1000);
  const grid: string[] = [];
  const wide: string[] = [];
  for (const t of TILES) {
    const v = views.get(t.id);
    if (!v) continue;
    (v.wide ? wide : grid).push(renderTile(v));
  }
  return shell(grid.join(""), wide.join(""), ago);
}

export async function handleDashboardRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/events") {
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
        clients.add(c);
        c.enqueue(enc.encode(": connected\n\n"));
      },
      cancel() {
        if (controller) clients.delete(controller);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } });
  }
  if (url.pathname === "/healthz") return Response.json({ ok: views.size > 0, at: lastChange });
  for (const r of routes) {
    if (url.pathname === r.path) {
      if (url.pathname === "/ci-gantt.png") {
        return await cachedRoute(ganttCacheKey(url), () => Promise.resolve(r.handler(req, url)));
      }
      return await r.handler(req, url);
    }
  }
  return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } });
}

if (import.meta.main) {
  Deno.serve({
    port: PORT,
    onListen: () => console.log(`\n  Fabric wall LIVE:  http://localhost:${PORT}\n  ${TILES.length} tiles registered.\n`),
  }, handleDashboardRequest);
}
