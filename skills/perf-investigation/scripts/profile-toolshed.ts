#!/usr/bin/env -S deno run --allow-net --allow-run --allow-read --allow-write --allow-env
/**
 * Profile a toolshed over its inspector port while a command provokes it.
 *
 *   deno run --allow-net --allow-run --allow-read --allow-write --allow-env \
 *     skills/perf-investigation/scripts/profile-toolshed.ts <outPrefix> \
 *     [--interval=<us>] -- <command> [args...]
 *
 * The toolshed must be running under `--inspect` (`start-local-dev.sh
 * --inspect` does that); `INSPECT_URL` names its inspector (the default is
 * port offset 0's, `http://127.0.0.1:9229`) and `CF_API_URL` its API (for
 * the health-stats captures on either side of the command). The bracket is
 * the command's lifetime: the profiler starts before it is spawned and stops
 * when it exits, so the profile is the command's server-side work plus
 * whatever else the server did meanwhile.
 *
 * Writes `<outPrefix>.server.cpuprofile`, `.server.report.txt` (ranked by
 * self time), and `.server.delta.txt`: the timing rows whose count grew
 * during the command, differenced on the two additive fields, and the
 * slow-query entries the command added. `CF_SLOW_QUERY_THRESHOLD_MS=0` on
 * the toolshed makes that list every operation rather than the ones over
 * 100 ms.
 */
import { renderProfileReport } from "../../../packages/integration/cdp-profiler.ts";

const args = [...Deno.args];
const out = args.shift();
if (out === undefined) {
  console.error(
    "usage: profile-toolshed.ts <outPrefix> [--interval=us] -- <command...>",
  );
  Deno.exit(2);
}
let interval = 500;
if (args[0]?.startsWith("--interval=")) {
  interval = Number(args.shift()!.slice("--interval=".length));
}
if (args[0] === "--") args.shift();
if (args.length === 0) {
  console.error("profile-toolshed.ts: no command given after --");
  Deno.exit(2);
}
const inspect = Deno.env.get("INSPECT_URL") ?? "http://127.0.0.1:9229";
const api = Deno.env.get("CF_API_URL") ?? "http://localhost:8000";

type Stats = {
  timingStats?: Record<
    string,
    Record<string, { count: number; totalTime: number }>
  >;
  slowQueries?: Record<string, unknown>[];
  documentCaches?: unknown;
};
const stats = async (): Promise<Stats> =>
  (await fetch(`${api}/api/health/stats`)).json();

const targets = await (await fetch(`${inspect}/json`)).json();
const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
await new Promise((resolve) => ws.onopen = resolve);
let nextId = 0;
const pending = new Map<number, (value: { result: unknown }) => void>();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const waiter = pending.get(message.id);
  if (waiter !== undefined) {
    pending.delete(message.id);
    waiter(message);
  }
};
const send = (method: string, params: unknown = {}) =>
  new Promise<{ result: unknown }>((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

const before = await stats();
await send("Profiler.enable");
await send("Profiler.setSamplingInterval", { interval });
await send("Profiler.start");
const started = performance.now();
const child = new Deno.Command(args[0], {
  args: args.slice(1),
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const status = await child.status;
const wall = performance.now() - started;
const { result } = await send("Profiler.stop");
const after = await stats();
ws.close();

const profile =
  (result as { profile: Parameters<typeof renderProfileReport>[0] }).profile;
await Deno.writeTextFile(`${out}.server.cpuprofile`, JSON.stringify(profile));
await Deno.writeTextFile(
  `${out}.server.report.txt`,
  renderProfileReport(profile, `${out} (server)`, {
    topFrames: 60,
    topFiles: 25,
  }),
);

// Only `count` and `totalTime` subtract; the percentiles describe the
// process's whole lifetime.
const rows: { key: string; count: number; totalMs: number }[] = [];
for (const [loggerName, ops] of Object.entries(after.timingStats ?? {})) {
  for (const [op, stat] of Object.entries(ops)) {
    const prior = before.timingStats?.[loggerName]?.[op];
    const count = stat.count - (prior?.count ?? 0);
    const totalMs = stat.totalTime - (prior?.totalTime ?? 0);
    if (count > 0) rows.push({ key: `${loggerName}/${op}`, count, totalMs });
  }
}
rows.sort((a, b) => b.totalMs - a.totalMs);
const priorSlow = new Set(
  (before.slowQueries ?? []).map((entry) => JSON.stringify(entry)),
);
const newSlow = (after.slowQueries ?? []).filter((entry) =>
  !priorSlow.has(JSON.stringify(entry))
);
let text = `# server timing delta (command wall ${
  wall.toFixed(0)
}ms, exit ${status.code})\n`;
for (const row of rows.slice(0, 40)) {
  text += `${row.totalMs.toFixed(0).padStart(8)}ms ${
    String(row.count).padStart(7)
  }x ${(row.totalMs / row.count).toFixed(2).padStart(9)}ms/call  ${row.key}\n`;
}
text += `\n# new slow queries (${newSlow.length})\n`;
for (const entry of newSlow) {
  const q = entry as Record<string, number | string | undefined>;
  text += `${Number(q.elapsed).toFixed(0).padStart(6)}ms ${q.operation} ` +
    `roots=${q.rootsVisited ?? "-"} reads=${q.managerReads ?? "-"} ` +
    `upserts=${q.upserts ?? "-"} watches=${q.watches ?? "-"} ` +
    `lockWait=${q.lockWaitMs ?? "-"}\n`;
}
await Deno.writeTextFile(`${out}.server.delta.txt`, text);
await Deno.writeTextFile(
  `${out}.server.stats.json`,
  JSON.stringify({ wall, rows, newSlow, documentCaches: after.documentCaches }),
);
console.error(
  `[profile-toolshed] wrote ${out}.server.* (command ${wall.toFixed(0)}ms)`,
);
Deno.exit(status.code);
