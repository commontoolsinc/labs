#!/usr/bin/env -S deno run --allow-all

// Run a command while sampling how much CPU the whole machine is using, then
// print how many cores the command actually drove. On a dedicated CI runner
// nothing else is running, so the system-wide figure is this job's usage.
//
// Reads the aggregate line of /proc/stat at a fixed interval and turns the
// busy fraction into "cores busy" by multiplying by the core count. Reports the
// average over the whole run plus the per-interval peak and percentiles, which
// separates a job that pins many cores throughout from one that only spikes
// briefly and is otherwise single-threaded. Also samples the 1-minute load
// average, which unlike utilization can rise above the core count and so shows
// when the command wants more cores than the runner has.
//
// Runs under --allow-all: Deno gates /proc/stat behind the all-access
// permission, and the wrapped command brings its own permissions when spawned.
//
// Exits with the wrapped command's exit code, so it is a transparent prefix in
// front of any command. On a platform without /proc/stat it still runs the
// command and simply reports the CPU figures as unavailable.
//
// Usage:
//   run-with-cpu-stats.ts <command> [args...]

const command = Deno.args;
if (command.length === 0) {
  console.error("usage: run-with-cpu-stats.ts <command> [args...]");
  Deno.exit(2);
}

const cores = navigator.hardwareConcurrency;

interface StatSample {
  idle: number;
  total: number;
}

// The first read failure, kept so the summary can explain why CPU stats are
// missing instead of guessing "no /proc/stat".
let statError: string | null = null;

// Read the first line of /proc/stat through an explicit descriptor loop.
// procfs files report a size of 0, so read until the first newline rather than
// trusting a size-hinted whole-file read.
function readProcStatFirstLine(): string | null {
  let file: Deno.FsFile;
  try {
    file = Deno.openSync("/proc/stat", { read: true });
  } catch (e) {
    statError ??= `open /proc/stat: ${e instanceof Error ? e.message : e}`;
    return null;
  }
  try {
    const decoder = new TextDecoder();
    const buf = new Uint8Array(8192);
    let text = "";
    while (!text.includes("\n")) {
      const n = file.readSync(buf);
      if (n === null || n === 0) break;
      text += decoder.decode(buf.subarray(0, n), { stream: true });
    }
    return text.split("\n", 1)[0];
  } catch (e) {
    statError ??= `read /proc/stat: ${e instanceof Error ? e.message : e}`;
    return null;
  } finally {
    file.close();
  }
}

// Parse the aggregate "cpu" line of /proc/stat into idle and total jiffies.
// Fields after the label are: user nice system idle iowait irq softirq steal ...
function readStat(): StatSample | null {
  const line = readProcStatFirstLine();
  if (line === null) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 5 || fields.some((n) => !Number.isFinite(n))) {
    statError ??= `unexpected /proc/stat first line: ${JSON.stringify(line)}`;
    return null;
  }
  const idle = fields[3] + (fields[4] ?? 0); // idle + iowait
  const total = fields.reduce((sum, n) => sum + n, 0);
  return { idle, total };
}

// Convert the change between two samples into the average number of cores busy
// over that window.
function coresBusy(a: StatSample, b: StatSample): number | null {
  const dTotal = b.total - a.total;
  if (dTotal <= 0) return null;
  const dIdle = b.idle - a.idle;
  return (1 - dIdle / dTotal) * cores;
}

function loadavg1(): number | null {
  try {
    return Deno.loadavg()[0];
  } catch {
    return null;
  }
}

const SAMPLE_INTERVAL_MS = 2000;
const intervalCores: number[] = [];
let peakLoad = loadavg1() ?? 0;
let prev = readStat();
const overallStart = prev;

const timer = setInterval(() => {
  const cur = readStat();
  if (prev && cur) {
    const busy = coresBusy(prev, cur);
    if (busy !== null) intervalCores.push(busy);
  }
  prev = cur ?? prev;
  const load = loadavg1();
  if (load !== null) peakLoad = Math.max(peakLoad, load);
}, SAMPLE_INTERVAL_MS);

const startedAt = performance.now();
const child = new Deno.Command(command[0], {
  args: command.slice(1),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();
const status = await child.status;
const wallSeconds = (performance.now() - startedAt) / 1000;
const overallEnd = readStat();
const endLoad = loadavg1();
if (endLoad !== null) peakLoad = Math.max(peakLoad, endLoad);
clearInterval(timer);

function fmt(n: number): string {
  return n.toFixed(2);
}

const lines = [
  "===== CPU stats (system-wide on a dedicated runner) =====",
  `runner cores (nproc): ${cores}`,
  `wall time: ${wallSeconds.toFixed(1)}s`,
];
if (overallStart && overallEnd) {
  const avg = coresBusy(overallStart, overallEnd);
  lines.push(
    `average cores busy: ${avg === null ? "n/a" : fmt(avg)} of ${cores}`,
  );
} else {
  lines.push(`average cores busy: n/a (${statError ?? "no /proc/stat"})`);
}
if (intervalCores.length) {
  const sorted = [...intervalCores].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
  lines.push(
    `peak cores busy (${SAMPLE_INTERVAL_MS / 1000}s intervals): ${
      fmt(sorted[sorted.length - 1])
    }`,
    `median / p90 cores busy: ${fmt(at(0.5))} / ${
      fmt(at(0.9))
    } (${intervalCores.length} samples)`,
  );
}
if (peakLoad > 0) {
  lines.push(
    `peak 1-min load average: ${fmt(peakLoad)}` +
      (peakLoad > cores ? ` (above ${cores} cores — wants more)` : ""),
  );
}
lines.push("=========================================================");
console.error("\n" + lines.join("\n") + "\n");

Deno.exit(status.code);
