// The scheduler's non-settling telemetry (facade recordExecuteEndTelemetry)
// sits behind a wall-clock heuristic: it fires only when a busy window
// crosses 5s. Integration runs cover it only when a CI machine happens to run
// slow enough, which made the runner coverage gate flap. This test drives the
// path deterministically by backdating the private settling tracker — no
// sleeping, no real busy-looping.
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { SettlingTracker } from "../src/scheduler/execution.ts";
import type { RuntimeTelemetryEvent } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase("settling telemetry test");

// The tracker and the execute-end hook are private: backdating the tracker is
// the only seam that reaches the telemetry branch without real wall-clock
// busy time.
type SchedulerInternals = {
  settlingTracker: SettlingTracker;
  recordExecuteEndTelemetry(): void;
  diagnosisEnabled: boolean;
};

describe("scheduler non-settling telemetry", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await storageManager?.close();
  });

  it("submits telemetry and auto-triggers diagnosis for a busy window", async () => {
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      const scheduler = runtime.scheduler as unknown as SchedulerInternals;
      const markers: { busyTime: number; windowDuration: number }[] = [];
      const listener = (event: Event) => {
        const { marker } = (event as RuntimeTelemetryEvent).detail;
        if (marker.type === "scheduler.non-settling") markers.push(marker);
      };
      runtime.telemetry.addEventListener("telemetry", listener);
      try {
        runtime.scheduler.setAutoTriggerDiagnosis(true);
        // Backdate the tracker to a window that is unambiguously busy: 8s of
        // window with 4s busy stays over every threshold (5s window, 1s busy,
        // 0.3 ratio) no matter how much real time the test itself takes.
        const now = performance.now();
        scheduler.settlingTracker.windowStart = now - 8_000;
        scheduler.settlingTracker.busyTime = 4_000;
        scheduler.settlingTracker.lastExecuteStart = now;
        scheduler.settlingTracker.isExecuting = true;
        expect(runtime.scheduler.isNonSettling()).toBe(false);

        scheduler.recordExecuteEndTelemetry();

        expect(markers.length).toBe(1);
        expect(markers[0].busyTime).toBeGreaterThanOrEqual(4_000);
        expect(markers[0].windowDuration).toBeGreaterThanOrEqual(8_000);
        expect(runtime.scheduler.isNonSettling()).toBe(true);
        // Auto-trigger switched diagnosis on.
        expect(scheduler.diagnosisEnabled).toBe(true);

        // A later execute end in the same episode stays quiet (and takes the
        // diagnosis busy-time accounting branch instead).
        scheduler.recordExecuteEndTelemetry();
        expect(markers.length).toBe(1);
      } finally {
        runtime.telemetry.removeEventListener("telemetry", listener);
      }
    } finally {
      // Also clears the diagnosis auto-stop timer startDiagnosis armed.
      await runtime.dispose();
    }
  });
});
