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
//   BLACKSMITH_API_TOKEN              Blacksmith share of the ci-spend tile

import { CI_WORKFLOW, PORT, REPO } from "./config.ts";
import { TILES } from "./registry.ts";
import { makeCtx } from "./ctx.ts";
import { friendlyError } from "./lib.ts";
import { faviconPng, faviconStatus } from "./favicon.ts";
import type { FaviconStatus } from "./favicon.ts";
import { renderTile, shell, SHELL_VERSION } from "./render.ts";
import type { Ctx, Run, RunSource, Tile, TileView } from "./types.ts";

const ctx = makeCtx();
const views = new Map<string, TileView>();
const lastRun = new Map<string, number>();
const runSnapshots = new Map<string, Run[]>();
const runSourceErrors = new Map<string, string>();
const lastSourceTileRun = new Map<string, number>();
interface ActiveTileUpdate {
  count: number;
  startedAt: number;
  stale: boolean;
}
const activeTileUpdates = new Map<string, ActiveTileUpdate>();
const activeRunSourceUpdates = new Set<string>();
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
      return view ? [activeTileView(tile, view).status] : [];
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
    const v = activeTileView(
      t,
      currentViews.get(t.id) ?? {
        label: t.id,
        status: "unknown" as const,
      },
    );
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

const runSourceKey = (source: RunSource): string => `${source.repo} ${source.workflow}`;
const runSourceTileKey = (source: RunSource, tile: Tile): string => `${runSourceKey(source)} ${tile.id}`;

function beginTileUpdate(tile: Tile, startedAt: number): void {
  const active = activeTileUpdates.get(tile.id);
  if (active) {
    active.count++;
  } else {
    activeTileUpdates.set(tile.id, {
      count: 1,
      startedAt,
      stale: false,
    });
  }
}

function finishTileUpdate(tile: Tile): void {
  const active = activeTileUpdates.get(tile.id);
  if (!active || active.count === 1) activeTileUpdates.delete(tile.id);
  else active.count--;
}

function allUpdatesSettled(): boolean {
  return activeTileUpdates.size === 0 && activeRunSourceUpdates.size === 0;
}

const STALE_UPDATE_MS = 60_000;
const STALE_UPDATE_SUB = "refresh still pending";

function activeTileView(tile: Tile, view: TileView): TileView {
  return activeTileUpdates.get(tile.id)?.stale
    ? { ...view, status: "unknown", sub: STALE_UPDATE_SUB }
    : view;
}

function grayStaleTileUpdates(now: number): void {
  let changed = false;
  for (const active of activeTileUpdates.values()) {
    if (active.stale || now - active.startedAt < STALE_UPDATE_MS) continue;
    active.stale = true;
    changed = true;
  }
  if (changed) {
    lastChange = now;
    updateFaviconRedSince(now, false);
    broadcast(dashboardUpdate());
  }
}

interface RunSourceGroup {
  source: RunSource;
  tiles: Tile[];
}

function groupRunSources(tiles: Tile[]): RunSourceGroup[] {
  const groups = new Map<string, RunSourceGroup>();
  for (const tile of tiles) {
    for (const source of tile.runSources ?? []) {
      const key = runSourceKey(source);
      const group = groups.get(key);
      if (group) {
        if (!group.tiles.includes(tile)) group.tiles.push(tile);
      } else {
        groups.set(key, { source, tiles: [tile] });
      }
    }
  }
  return [...groups.values()];
}

function snapshotCtx(base: Ctx, snapshots: ReadonlyMap<string, Run[]>): Ctx {
  const runsFor = (repo: string, workflow: string) =>
    Promise.resolve(snapshots.get(runSourceKey({ repo, workflow })) ?? []);
  return {
    runs: () => runsFor(REPO, CI_WORKFLOW),
    runsFor,
    env: base.env,
  };
}

function sourceLabel(source: RunSource): string {
  return source.repo.split("/").at(-1) ?? source.repo;
}

function withSourceHealth(
  tile: Tile,
  view: TileView,
  snapshots: ReadonlyMap<string, Run[]>,
  errors: ReadonlyMap<string, string>,
): TileView {
  const problems: string[] = [];
  for (const source of tile.runSources ?? []) {
    const key = runSourceKey(source);
    const error = errors.get(key);
    if (error) problems.push(`${sourceLabel(source)} ${friendlyError(error)}`);
    else if (!snapshots.has(key)) problems.push(`${sourceLabel(source)} pending`);
  }
  return problems.length ? { ...view, status: "unknown", sub: problems.join(" · ") } : view;
}

async function collectView(
  tile: Tile,
  collectionCtx: Ctx,
  publish?: (view: TileView) => void,
): Promise<TileView> {
  let acceptingIntermediate = true;
  try {
    try {
      return await tile.collect(
        collectionCtx,
        publish
          ? (intermediate) => {
            if (acceptingIntermediate) publish(intermediate);
          }
          : undefined,
      );
    } finally {
      acceptingIntermediate = false;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`tile ${tile.id} failed:`, msg);
    const prev = views.get(tile.id);
    return prev
      ? { ...prev, status: "unknown", sub: friendlyError(msg) }
      : { label: tile.id, status: "unknown", value: "—", sub: friendlyError(msg) };
  }
}

function publishViews(collected: { tile: Tile; view: TileView }[], recoveryIsSettled: boolean): void {
  const now = Date.now();
  for (const { tile, view } of collected) {
    views.set(tile.id, view);
    lastRun.set(tile.id, now);
  }
  lastChange = now;
  updateFaviconRedSince(now, recoveryIsSettled);
  broadcast(dashboardUpdate());
}

function publishIntermediateView(tile: Tile, view: TileView): void {
  const now = Date.now();
  views.set(tile.id, view);
  lastChange = now;
  updateFaviconRedSince(now, false);
  broadcast(dashboardUpdate());
}

// One ticker collects every tile that is due (respecting each tile's interval).
// Later ticks skip work that is still running and collect the other due tiles.
const TICK_MS = 15_000;
export async function tick(tiles: Tile[] = TILES, sourceCtx: Ctx = ctx) {
  const now = Date.now();
  grayStaleTileUpdates(now);
  const sourceGroups = groupRunSources(tiles);
  const sourceTiles = new Set(sourceGroups.flatMap((group) => group.tiles));
  const activeAtTickStart = new Set(activeTileUpdates.keys());
  const dueTiles = tiles.filter((tile) =>
    !sourceTiles.has(tile) &&
    !activeAtTickStart.has(tile.id) &&
    now - (lastRun.get(tile.id) ?? 0) >= tile.intervalMs
  );
  const dueSources = sourceGroups.flatMap((group) => {
    if (activeRunSourceUpdates.has(runSourceKey(group.source))) return [];
    const due = group.tiles.filter((tile) =>
      !activeAtTickStart.has(tile.id) &&
      now - (lastSourceTileRun.get(runSourceTileKey(group.source, tile)) ?? 0) >= tile.intervalMs
    );
    return due.length ? [{ source: group.source, tiles: due }] : [];
  });
  if (!dueTiles.length && !dueSources.length) return;

  for (const tile of dueTiles) beginTileUpdate(tile, now);
  for (const group of dueSources) {
    activeRunSourceUpdates.add(runSourceKey(group.source));
    for (const tile of group.tiles) beginTileUpdate(tile, now);
  }

  const refreshTile = async (tile: Tile) => {
    let released = false;
    try {
      const view = await collectView(
        tile,
        sourceCtx,
        (intermediate) => publishIntermediateView(tile, intermediate),
      );
      finishTileUpdate(tile);
      released = true;
      publishViews([{ tile, view }], allUpdatesSettled());
    } finally {
      if (!released) finishTileUpdate(tile);
    }
  };

  // Source fetches and dependent collections run independently. Each tile
  // retains the completed view with the highest snapshot revision.
  let sourceRevision = 0;
  const publishedTileRevision = new Map<string, number>();
  const refreshSource = async (group: RunSourceGroup) => {
    let released = false;
    try {
      let runs: Run[] | undefined;
      let error: string | undefined;
      try {
        runs = await sourceCtx.runsFor(group.source.repo, group.source.workflow);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.error(`run source ${runSourceKey(group.source)} failed:`, error);
      }

      const key = runSourceKey(group.source);
      if (runs) {
        runSnapshots.set(key, runs);
        runSourceErrors.delete(key);
      } else {
        runSourceErrors.set(key, error ?? "temporarily unavailable");
      }
      const snapshots = new Map(runSnapshots);
      const errors = new Map(runSourceErrors);
      const currentCtx = snapshotCtx(sourceCtx, snapshots);
      const revision = ++sourceRevision;
      const publishIntermediate = (tile: Tile, view: TileView) => {
        if (revision < (publishedTileRevision.get(tile.id) ?? 0)) return;
        publishedTileRevision.set(tile.id, revision);
        publishIntermediateView(
          tile,
          withSourceHealth(tile, view, snapshots, errors),
        );
      };
      const collected = await Promise.all(group.tiles.map(async (tile) => ({
        tile,
        view: withSourceHealth(
          tile,
          await collectView(
            tile,
            currentCtx,
            (intermediate) => publishIntermediate(tile, intermediate),
          ),
          snapshots,
          errors,
        ),
      })));
      const current = collected.filter(({ tile }) => revision >= (publishedTileRevision.get(tile.id) ?? 0));
      for (const { tile } of current) publishedTileRevision.set(tile.id, revision);
      const completedAt = Date.now();
      for (const tile of group.tiles) {
        lastSourceTileRun.set(runSourceTileKey(group.source, tile), completedAt);
      }
      activeRunSourceUpdates.delete(runSourceKey(group.source));
      for (const tile of group.tiles) finishTileUpdate(tile);
      released = true;
      publishViews(current, allUpdatesSettled());
    } finally {
      if (!released) {
        activeRunSourceUpdates.delete(runSourceKey(group.source));
        for (const tile of group.tiles) finishTileUpdate(tile);
      }
    }
  };

  await Promise.all([
    ...dueTiles.map(refreshTile),
    ...dueSources.map(refreshSource),
  ]);
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
export function start(
  serve: typeof Deno.serve = Deno.serve,
  collect: () => void | Promise<void> = tick,
) {
  collect();
  const timer = setInterval(collect, TICK_MS);
  const server = serve({
    port: PORT,
    onListen: () => console.log(`\n  Fabric wall LIVE:  http://localhost:${PORT}\n  ${TILES.length} tiles registered.\n`),
  }, handle);
  return { timer, server };
}

// Running the file boots; importing it (the tests do) boots nothing.
if (import.meta.main) start();
