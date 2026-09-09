#!/usr/bin/env -S deno run --quiet --allow-net --allow-ffi --allow-read --allow-write --allow-env --allow-run --allow-sys
/**
 * Run one `cf` invocation in this process and write what it measured.
 *
 * The launcher's own flag set plus `--allow-sys`, which the in-process V8
 * profiler needs — the reason this exists rather than `cf` itself: a
 * `.cpuprofile` of a CLI command has to come from inside the command's
 * process, and the launcher does not grant that.
 *
 *   CF_PROF_OUT=/tmp/run CF_PROF_CPU=1 CF_TIMING_MEASURES=1 \
 *     deno run --quiet --config deno.jsonc --allow-net --allow-ffi \
 *     --allow-read --allow-write --allow-env --allow-run --allow-sys \
 *     skills/perf-investigation/scripts/profile-cf.ts cell get <address> ...
 *
 * Writes, under the `CF_PROF_OUT` prefix: `.timing.json` and `.counts.json`
 * (the logger's statistics and counts for the whole run), `.flags.json`,
 * `.measures.json` when `CF_TIMING_MEASURES=1` (the input the other scripts
 * here read), and with `CF_PROF_CPU=1` a `.cpuprofile` that Chrome DevTools
 * and speedscope load beside a `.report.txt` ranked by self time.
 * `CF_PROF_INTERVAL_US` sets the sampling period (500 unless set). Every
 * other variable `cf` reads — `CF_API_URL`, `CF_IDENTITY`, `CF_SPACE`,
 * `CF_CLI_TRACE_TIMINGS`, `CF_MEMORY_FRAME_LOG` — applies as it would to
 * `cf`. Run from the repository root.
 */
// deno-lint-ignore no-external-import
import { Session } from "node:inspector";
import { main } from "../../../packages/cli/mod.ts";
import {
  clearTimingMeasures,
  getLoggerCountsBreakdown,
  getLoggerFlagsBreakdown,
  getTimingStatsBreakdown,
  TIMING_MEASURE_PREFIX,
} from "@commonfabric/utils/logger";
import { renderProfileReport } from "../../../packages/integration/cdp-profiler.ts";

const out = Deno.env.get("CF_PROF_OUT") ?? "cf-prof";
const cpu = Deno.env.get("CF_PROF_CPU") === "1";
const interval = Number(Deno.env.get("CF_PROF_INTERVAL_US") ?? "500");
Deno.env.set("CF_CLI_NAME", Deno.env.get("CF_CLI_NAME") ?? "cf");

let session: Session | undefined;
const post = (method: string, params?: unknown) =>
  new Promise<unknown>((resolve, reject) =>
    session!.post(
      method,
      params as never,
      (error: unknown, result: unknown) =>
        error ? reject(error) : resolve(result),
    )
  );
const started = performance.now();
if (cpu) {
  session = new Session();
  session.connect();
  await post("Profiler.enable");
  await post("Profiler.setSamplingInterval", { interval });
  await post("Profiler.start");
}

let finalized = false;
async function finalize(code: number): Promise<void> {
  if (finalized) return;
  finalized = true;
  const wall = performance.now() - started;
  if (cpu) {
    const { profile } = await post("Profiler.stop") as {
      profile: Parameters<typeof renderProfileReport>[0];
    };
    await Deno.writeTextFile(`${out}.cpuprofile`, JSON.stringify(profile));
    await Deno.writeTextFile(
      `${out}.report.txt`,
      renderProfileReport(profile, out, { topFrames: 60, topFiles: 25 }),
    );
  }
  await Deno.writeTextFile(
    `${out}.timing.json`,
    JSON.stringify(getTimingStatsBreakdown()),
  );
  await Deno.writeTextFile(
    `${out}.counts.json`,
    JSON.stringify(getLoggerCountsBreakdown()),
  );
  await Deno.writeTextFile(
    `${out}.flags.json`,
    JSON.stringify(getLoggerFlagsBreakdown()),
  );
  const measures: { name: string; startTime: number; duration: number }[] = [];
  for (const entry of performance.getEntriesByType("measure")) {
    if (entry.name.startsWith(TIMING_MEASURE_PREFIX)) {
      measures.push({
        name: entry.name,
        startTime: entry.startTime,
        duration: entry.duration,
      });
    }
  }
  if (measures.length > 0) {
    await Deno.writeTextFile(`${out}.measures.json`, JSON.stringify(measures));
  }
  clearTimingMeasures();
  console.error(
    `[profile-cf] wall ${wall.toFixed(0)}ms, exit ${code}, ` +
      `measures ${measures.length}, wrote ${out}.*`,
  );
  Deno.exit(code);
}

await main(Deno.args, {
  exit: (code) => {
    void finalize(code);
  },
});
