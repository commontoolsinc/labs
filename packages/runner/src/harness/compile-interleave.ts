import { isBrowser } from "@commonfabric/utils/env";

/**
 * Whether cold pattern compilation should yield real macrotask turns between
 * its steps (per-module transform/emit, per-body SES verify, pre-evaluate).
 *
 * Yielding lets latency-sensitive work sharing the SAME event loop interleave
 * with the CPU-bound compile. That matters in exactly one place: the browser
 * runtime worker, where a synchronous compile wedges the event loop and stalls
 * every queued IPC delivery (cell traffic) for the whole compile (measured
 * `runner.loop/workerLag` ~1.6s on a cold space-root compile).
 *
 * Everywhere else the compiler runs in Deno as a BATCH step — `cf test`, the
 * toolshed server, the CLI — with nothing latency-sensitive sharing its loop,
 * so each yield is pure macrotask overhead. Left on, it ~doubles the pattern
 * unit-test wall time. So gate the interleave on the browser context: yield in
 * the worker, run straight through the synchronous driver in Deno.
 *
 * Evaluated once at module load; the runtime environment does not change.
 */
export const COMPILE_INTERLEAVES_EVENT_LOOP = isBrowser();
