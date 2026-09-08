/**
 * Listeners on a runtime's telemetry that shadow two indexes a test would
 * otherwise have to read from inside the class: the runner's pending
 * commit-gated starts, and the pattern manager's in-flight cache write-backs.
 * Each rebuilds its index from the marker pair the class emits as an entry
 * comes and goes. Dispatch is synchronous, so a read here sees the change the
 * moment the class made it.
 */

import type { Runtime } from "../../src/runtime.ts";
import type {
  RuntimeTelemetryEvent,
  RuntimeTelemetryMarker,
} from "../../src/telemetry.ts";

/**
 * Helper for the observers, which runs `onMarker` for every marker `runtime`
 * emits until the returned function is called.
 */
function listen(
  runtime: Runtime,
  onMarker: (marker: RuntimeTelemetryMarker) => void,
): () => void {
  const listener = (event: Event) => {
    onMarker((event as RuntimeTelemetryEvent).detail.marker);
  };
  runtime.telemetry.addEventListener("telemetry", listener);
  return () => runtime.telemetry.removeEventListener("telemetry", listener);
}

/**
 * Watches the runner's index of pending commit-gated starts through its
 * `runner.deferred-start.pending` and `runner.deferred-start.settled` markers.
 * Install it before the start whose attempts are to be counted.
 */
export function observePendingDeferredStarts(runtime: Runtime): {
  /** How many keys hold at least one pending attempt. */
  keys(): number;

  /** How many attempts are pending under `key`. */
  count(key: string): number;

  /** How many attempts have settled with the given outcome. */
  settled(outcome: "installed" | "cancelled"): number;

  /** Stops listening. */
  restore(): void;
} {
  const pending = new Map<string, number>();
  const settled = { installed: 0, cancelled: 0 };
  const restore = listen(runtime, (marker) => {
    if (marker.type === "runner.deferred-start.pending") {
      pending.set(marker.key, (pending.get(marker.key) ?? 0) + 1);
    } else if (marker.type === "runner.deferred-start.settled") {
      const left = (pending.get(marker.key) ?? 0) - 1;
      if (left > 0) pending.set(marker.key, left);
      else pending.delete(marker.key);
      settled[marker.outcome]++;
    }
  });
  return {
    keys: () => pending.size,
    count: (key) => pending.get(key) ?? 0,
    settled: (outcome) => settled[outcome],
    restore,
  };
}

/**
 * Watches the pattern manager's in-flight compile-cache write-backs through
 * its `pattern.cache-write-back.start` and `pattern.cache-write-back.complete`
 * markers. Install it before the compile or persist whose writes are to be
 * counted.
 */
export function observeCacheWriteBacks(runtime: Runtime): {
  /** How many write-backs have started. */
  started(): number;

  /** How many write-backs have started and not yet settled. */
  inFlight(): number;

  /** Stops listening. */
  restore(): void;
} {
  let started = 0;
  let completed = 0;
  const restore = listen(runtime, (marker) => {
    if (marker.type === "pattern.cache-write-back.start") started++;
    else if (marker.type === "pattern.cache-write-back.complete") completed++;
  });
  return {
    started: () => started,
    inFlight: () => started - completed,
    restore,
  };
}
