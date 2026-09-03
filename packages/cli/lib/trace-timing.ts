/**
 * Phase timing for the CLI's own code paths, written to stderr when
 * `CF_CLI_TRACE_TIMINGS=1` (docs/development/CONFIGURATION.md). Every phase
 * line has one shape, `[cf-phase] <ms>ms :: <label>`, so a trace from any
 * command greps the same way. The piece package keeps its own `[piece-phase]`
 * lines behind the same variable; together they attribute a command's latency
 * across the CLI/controller boundary.
 */

/** Where a phase reports, and whether it does. Injected by tests; commands
 * use {@link cliPhaseTrace}. */
export interface PhaseTrace {
  enabled: boolean;
  log: (line: string) => void;
}

/** The process-wide trace: read once, since the flag is a property of the
 * process rather than of any one call. */
export const cliPhaseTrace: PhaseTrace = {
  enabled: Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1",
  log: (line) => console.error(line),
};

/**
 * Run `run` as one named phase. With tracing off this is `run` itself; with
 * it on, the elapsed time is reported whether the phase returned or threw, so
 * a failing command's trace still says where its time went.
 */
export async function timeCliPhase<T>(
  label: string,
  run: () => T | Promise<T>,
  trace: PhaseTrace = cliPhaseTrace,
): Promise<T> {
  if (!trace.enabled) return await run();
  const start = performance.now();
  try {
    return await run();
  } finally {
    const elapsed = Math.round(performance.now() - start);
    trace.log(`[cf-phase] ${elapsed}ms :: ${label}`);
  }
}
