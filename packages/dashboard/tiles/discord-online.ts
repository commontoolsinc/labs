// discord online: a one-shot Discord gateway snapshot of currently-online guild
// members, split into the "Team Member" role and everyone else ("Visitors").
// Each poll opens a fresh gateway connection, identifies, waits for the initial
// GUILD_CREATE, tallies presences against members, then tears the socket and
// heartbeat down. Successive polls accumulate a rolling history (persisted to
// disk) that is charted as two lines (team and visitors over time).
//
// The bot must have the "Server Members Intent" and "Presence Intent" enabled in
// the Discord developer portal (privileged intents); without them the gateway
// closes with 4014.
import type { Status, Tile, TileView } from "../types.ts";
import { escapeHtml, multiSparkline, thin } from "../lib.ts";
import { dashboardCacheFile } from "../history-files.ts";

const GATEWAY = "wss://gateway.discord.gg/?v=10&encoding=json";
const SNAPSHOT_TIMEOUT_MS = 12_000;

// Intents: GUILDS (1) | GUILD_MEMBERS (2) | GUILD_PRESENCES (256).
const INTENTS = 259;

// Online members carrying this role are counted as team; everyone else online is
// a visitor. Matched against the Discord role name exactly.
const TEAM_ROLE_NAME = "Team Member";
const VISITOR_COLOR = "#7c828c";
// The chart lines fade from this (a shade darker than the good-status tile
// background) on the far left up to their own color, matching the ci-duration
// sparkline.
const LINE_FADE = "#0e1915";

// A rolling series of timestamped samples, charted as two lines. Samples are
// retained for up to HISTORY_MAX_AGE_DAYS (~2 months) and persisted to disk in
// the dashboard cache directory, reloaded on start so a relaunch keeps the
// chart.
const HISTORY_MAX_AGE_DAYS = 60; // ~2 months
// Cap the plotted points so a long window still renders as a small SVG; the full
// history feeds the timestamps and span, this only thins the polyline.
const PLOT_POINTS = 500;
const HISTORY_FILE = dashboardCacheFile("fabric-wall-discord-history.json");
type Point = { t: number; team: number; visitors: number };
const history: Point[] = [];

const isPoint = (p: unknown): p is Point =>
  typeof p === "object" && p !== null &&
  typeof (p as Point).t === "number" &&
  typeof (p as Point).team === "number" &&
  typeof (p as Point).visitors === "number";

// Read the persisted history into `history`. Exported so tests can drive both a
// readable store and an unreadable one; ensureLoaded runs it at most once per
// process, which leaves only one of those two paths reachable through it.
export async function loadHistory(): Promise<void> {
  try {
    const data = JSON.parse(await Deno.readTextFile(HISTORY_FILE));
    if (Array.isArray(data)) {
      history.push(...data.filter(isPoint));
    }
  } catch { /* no file yet or unreadable: start from an empty history */ }
}

// Load the persisted history once, on first use.
let loaded = false;
async function ensureLoaded(): Promise<void> {
  if (loaded) return;
  loaded = true;
  await loadHistory();
}

// Persist atomically — write a temp file, then rename — so a restart mid-write
// can't corrupt the store. Failures are logged, not fatal.
async function saveHistory(): Promise<void> {
  try {
    const tmp = `${HISTORY_FILE}.tmp`;
    await Deno.writeTextFile(tmp, JSON.stringify(history));
    await Deno.rename(tmp, HISTORY_FILE);
  } catch (e) {
    console.error("discord: could not persist history:", e instanceof Error ? e.message : e);
  }
}

interface Role {
  id: string;
  name: string;
  color: number;
  position: number;
}
interface Member {
  user: { id: string };
  roles: string[];
}
interface Presence {
  user: { id: string };
  status: string;
}
interface GuildCreate {
  id: string;
  roles: Role[];
  members: Member[];
  presences: Presence[];
}

interface Snapshot {
  online: number;
  team: number;
  visitors: number;
  teamColor: string;
}

// A role's swatch color: decimal Discord color -> "#rrggbb"; the 0 sentinel
// (Discord's "no color") maps to the neutral grey used elsewhere in the shell.
function roleColor(color: number): string {
  if (!Number.isInteger(color) || color <= 0) return VISITOR_COLOR;
  return "#" + (color & 0xffffff).toString(16).padStart(6, "0");
}

// Count online users carrying the "Team Member" role as team; everyone else
// online is a visitor. Also returns the team role's own color. Exported for
// unit testing.
export function buildSnapshot(g: GuildCreate): Snapshot {
  const byId = new Map<string, Member>();
  for (const m of g.members) byId.set(m.user.id, m);
  const teamRole = g.roles.find((r) => r.name === TEAM_ROLE_NAME);

  const online = g.presences.filter((p) => p.status !== "offline");
  let team = 0;
  for (const p of online) {
    const member = byId.get(p.user.id);
    if (teamRole && member && member.roles.includes(teamRole.id)) team++;
  }
  return {
    online: online.length,
    team,
    visitors: online.length - team,
    teamColor: teamRole ? roleColor(teamRole.color) : VISITOR_COLOR,
  };
}

// Open a gateway connection, identify, and resolve once the guild's initial
// GUILD_CREATE arrives. Resolves to null on timeout, invalid session, or a
// disallowed-intents close so the caller can render an "unknown" tile. Always
// clears the heartbeat and closes the socket before resolving.
function takeSnapshot(token: string, guildId: string): Promise<Snapshot | null> {
  return new Promise((resolve) => {
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let done = false;

    const ws = new WebSocket(GATEWAY);

    const finish = (value: Snapshot | null) => {
      if (done) return;
      done = true;
      if (heartbeat !== undefined) clearInterval(heartbeat);
      try {
        ws.close();
      } catch { /* ignore */ }
      resolve(value);
    };

    const timer = setTimeout(() => finish(null), SNAPSHOT_TIMEOUT_MS);
    const finishAndStop = (value: Snapshot | null) => {
      clearTimeout(timer);
      finish(value);
    };

    ws.onmessage = (ev) => {
      let msg: { op: number; t?: string | null; d?: unknown };
      try {
        msg = JSON.parse(typeof ev.data === "string" ? ev.data : "");
      } catch {
        return;
      }

      if (msg.op === 10) {
        // HELLO: begin heartbeating, then identify.
        const interval = (msg.d as { heartbeat_interval: number }).heartbeat_interval;
        heartbeat = setInterval(() => {
          try {
            ws.send(JSON.stringify({ op: 1, d: null }));
          } catch { /* ignore */ }
        }, interval);
        ws.send(JSON.stringify({
          op: 2,
          d: {
            token,
            intents: INTENTS,
            properties: { os: "linux", browser: "fabric-wall", device: "fabric-wall" },
          },
        }));
        return;
      }

      if (msg.op === 9) {
        // Invalid Session.
        finishAndStop(null);
        return;
      }

      if (msg.op === 0 && msg.t === "GUILD_CREATE") {
        const g = msg.d as GuildCreate;
        if (g.id === guildId) finishAndStop(buildSnapshot(g));
        return;
      }
    };

    ws.onclose = () => {
      // 4014 = disallowed (privileged) intents; any close before we finished is
      // treated as "no snapshot".
      finishAndStop(null);
    };
    ws.onerror = () => finishAndStop(null);
  });
}

export const discordOnline: Tile = {
  id: "discord-online",
  // A fresh gateway connect per poll; keep this well above the snapshot timeout.
  // The bot needs the privileged Server Members and Presence intents enabled in
  // the Discord developer portal.
  intervalMs: 300_000,
  async collect(ctx): Promise<TileView> {
    const label = "discord online";
    const token = ctx.env("DISCORD_BOT_TOKEN");
    const guildId = ctx.env("DISCORD_GUILD_ID");
    if (!token || !guildId) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "set DISCORD_BOT_TOKEN + DISCORD_GUILD_ID (presences + members intents)",
      };
    }

    let snap: Snapshot | null;
    try {
      snap = await takeSnapshot(token, guildId);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { label, status: "unknown" as Status, value: "—", sub: escapeHtml(reason).slice(0, 80) };
    }

    if (!snap) {
      return {
        label,
        status: "unknown",
        value: "—",
        sub: "enable the presences + members intents on the bot",
      };
    }

    await ensureLoaded();
    history.push({ t: Date.now(), team: snap.team, visitors: snap.visitors });
    // Drop samples older than the retention window. Points are appended in time
    // order, so the oldest sit at the front.
    const cutoff = Date.now() - HISTORY_MAX_AGE_DAYS * 86_400_000;
    while (history.length && history[0].t < cutoff) history.shift();
    await saveHistory();

    // How long the chart spans, from the oldest to newest sample. The polyline
    // plots a thinned copy so a 2-month window stays a small SVG; the full
    // history feeds the span.
    const spanMs = history.length >= 2 ? history[history.length - 1].t - history[0].t : 0;
    const plot = thin(history, PLOT_POINTS);
    const chart = multiSparkline(
      [
        { vals: plot.map((h) => h.team), color: snap.teamColor, label: String(snap.team) },
        { vals: plot.map((h) => h.visitors), color: VISITOR_COLOR, label: String(snap.visitors) },
      ],
      { fadeFrom: LINE_FADE },
    );
    const swatch = (c: string) => `<span class="swatch" style="background:${escapeHtml(c)}"></span>`;
    // With the chart drawn, the counts sit at each line's end; until there are
    // two samples show them inline so the tile is never numberless.
    const subline = chart
      ? `<p class="sub">${swatch(snap.teamColor)} team + ${swatch(VISITOR_COLOR)} visitors</p>`
      : `<p class="sub">${swatch(snap.teamColor)} team ${snap.team} + ${swatch(VISITOR_COLOR)} visitors ${snap.visitors}</p>`;

    return {
      label,
      status: "good",
      value: String(snap.online),
      extra: subline + chart,
      duration: spanMs,
    };
  },
};
