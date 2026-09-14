import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FakeTime } from "@std/testing/time";
import { StallWatchdog } from "../lib/stall-watchdog.ts";

/**
 * Watches `promise` for settlement. A rejection is absorbed here, so a
 * watch that fires never surfaces as an unhandled rejection; `error` holds
 * what it rejected with.
 */
function observe(promise: Promise<unknown>): {
  readonly settled: boolean;
  readonly error: unknown;
} {
  const state = { settled: false, error: undefined as unknown };
  promise.then(
    () => {
      state.settled = true;
    },
    (error) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

/**
 * Whether `outcome`'s promise has settled by now: the handlers `observe()`
 * attached run a microtask after the settlement, so this drains the queue
 * before reading, and a promise settled by the last timer to fire reads as
 * settled.
 */
async function isSettled(outcome: { readonly settled: boolean }) {
  await Promise.resolve();
  await Promise.resolve();
  return outcome.settled;
}

describe("StallWatchdog", () => {
  // The clock under test is `FakeTime`'s, handed in as `Date.now`, so every
  // case says exactly how much time passes and the timers fire on that clock.

  describe("watch()", () => {
    it("rejects with the message once the bound passes with no progress", async () => {
      using time = new FakeTime();
      const watchdog = new StallWatchdog(1000, () => Date.now());
      const outcome = observe(watchdog.watch("stalled").promise);
      await time.tickAsync(999);
      expect(await isSettled(outcome)).toBe(false);
      await time.tickAsync(1);
      expect(await isSettled(outcome)).toBe(true);
      expect(outcome.error).toBeInstanceOf(Error);
      expect((outcome.error as Error).message).toBe("stalled");
    });

    it("stays pending while progress keeps arriving inside the bound", async () => {
      using time = new FakeTime();
      const watchdog = new StallWatchdog(1000, () => Date.now());
      const watch = watchdog.watch("stalled");
      const outcome = observe(watch.promise);
      // Progress every 600 ms for a total well past the bound: the gaps are
      // each under it, so the watch never fires.
      for (let i = 0; i < 10; i++) {
        await time.tickAsync(600);
        watchdog.progress();
      }
      expect(await isSettled(outcome)).toBe(false);
      watch.stop();
    });

    it("rejects once the gap after the last progress reaches the bound", async () => {
      using time = new FakeTime();
      const watchdog = new StallWatchdog(1000, () => Date.now());
      const outcome = observe(watchdog.watch("stalled").promise);
      await time.tickAsync(600);
      watchdog.progress();
      await time.tickAsync(999);
      expect(await isSettled(outcome)).toBe(false);
      await time.tickAsync(1);
      expect(await isSettled(outcome)).toBe(true);
      expect((outcome.error as Error).message).toBe("stalled");
    });

    it("counts from the call, not from progress reported before it", async () => {
      using time = new FakeTime();
      const watchdog = new StallWatchdog(1000, () => Date.now());
      await time.tickAsync(5000);
      const outcome = observe(watchdog.watch("stalled").promise);
      await time.tickAsync(999);
      expect(await isSettled(outcome)).toBe(false);
      await time.tickAsync(1);
      expect(await isSettled(outcome)).toBe(true);
    });

    it("never fires after `stop()`", async () => {
      using time = new FakeTime();
      const watchdog = new StallWatchdog(1000, () => Date.now());
      const watch = watchdog.watch("stalled");
      const outcome = observe(watch.promise);
      watch.stop();
      await time.tickAsync(10_000);
      expect(await isSettled(outcome)).toBe(false);
    });
  });
});
