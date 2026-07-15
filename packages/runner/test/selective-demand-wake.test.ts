import { assertEquals } from "@std/assert";
import { SelectiveDemandWakeQueue } from "../src/executor/selective-demand-wake.ts";

class FakeTimers {
  #nextTimer = 0;
  now = 0;
  readonly pending = new Map<number, { callback: () => void; at: number }>();

  setTimer = (callback: () => void, delayMs: number): number => {
    const timer = ++this.#nextTimer;
    this.pending.set(timer, { callback, at: this.now + delayMs });
    return timer;
  };

  clearTimer = (timer: number): void => {
    this.pending.delete(timer);
  };

  /** Advance the deterministic clock and fire every timer that came due. */
  advance(byMs: number): void {
    this.now += byMs;
    for (const [timer, entry] of [...this.pending]) {
      if (entry.at <= this.now) {
        this.pending.delete(timer);
        entry.callback();
      }
    }
  }

  options() {
    return {
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      now: () => this.now,
    };
  }
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

Deno.test("selective demand wakes coalesce rapid stale piece batches", async () => {
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue((pieceIds) => {
    batches.push([...pieceIds]);
    return Promise.resolve();
  }, { windowMs: 0, maxWindowMs: 0 });

  queue.push(["space:of:b", "space:of:a"]);
  queue.push(["space:of:a"]);
  queue.push(["space:of:c"]);
  await queue.settled();

  assertEquals(batches, [[
    "space:of:a",
    "space:of:b",
    "space:of:c",
  ]]);
});

Deno.test("selective demand wakes retain commits arriving during a pull", async () => {
  const firstPull = Promise.withResolvers<void>();
  const releaseFirstPull = Promise.withResolvers<void>();
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue(async (pieceIds) => {
    batches.push([...pieceIds]);
    if (batches.length === 1) {
      firstPull.resolve();
      await releaseFirstPull.promise;
    }
  }, { windowMs: 0, maxWindowMs: 0 });

  queue.push(["space:of:first"]);
  await firstPull.promise;
  queue.push(["space:of:second", "space:of:second"]);
  releaseFirstPull.resolve();
  await queue.settled();

  assertEquals(batches, [
    ["space:of:first"],
    ["space:of:second"],
  ]);
});

Deno.test("wake pushes inside the coalescing window flush as one batch", async () => {
  const timers = new FakeTimers();
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue((pieceIds) => {
    batches.push([...pieceIds]);
    return Promise.resolve();
  }, { windowMs: 25, maxWindowMs: 100, ...timers.options() });

  queue.push(["space:of:a"]);
  timers.advance(10);
  queue.push(["space:of:b"]);
  timers.advance(10);
  queue.push(["space:of:c"]);
  assertEquals(batches, []);

  // The trailing window re-armed on each push; only quiet time flushes.
  timers.advance(25);
  await queue.settled();
  assertEquals(batches, [["space:of:a", "space:of:b", "space:of:c"]]);
});

Deno.test("a continuous push stream flushes at the window cap", async () => {
  const timers = new FakeTimers();
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue((pieceIds) => {
    batches.push([...pieceIds]);
    return Promise.resolve();
  }, { windowMs: 25, maxWindowMs: 100, ...timers.options() });

  // Pushes every 20ms never leave a 25ms quiet gap; the cap still flushes.
  queue.push(["space:of:seed"]);
  for (let step = 1; step <= 4; step++) {
    timers.advance(20);
    queue.push([`space:of:step-${step}`]);
    assertEquals(batches, []);
  }
  timers.advance(20);
  await flushMicrotasks();
  assertEquals(batches, [[
    "space:of:seed",
    "space:of:step-1",
    "space:of:step-2",
    "space:of:step-3",
    "space:of:step-4",
  ]]);

  // The stream continues after the flush: a fresh window opens for the rest.
  queue.push(["space:of:step-5"]);
  await flushMicrotasks();
  assertEquals(batches.length, 1);
  timers.advance(25);
  await queue.settled();
  assertEquals(batches.length, 2);
  assertEquals(batches[1], ["space:of:step-5"]);
});

Deno.test("settled waits through an armed coalescing window", async () => {
  const timers = new FakeTimers();
  const batches: string[][] = [];
  const queue = new SelectiveDemandWakeQueue((pieceIds) => {
    batches.push([...pieceIds]);
    return Promise.resolve();
  }, { windowMs: 25, maxWindowMs: 100, ...timers.options() });

  queue.push(["space:of:pending"]);
  let settled = false;
  const waiting = queue.settled().then(() => {
    settled = true;
  });
  await flushMicrotasks();
  assertEquals(settled, false);
  assertEquals(batches, []);

  timers.advance(25);
  await waiting;
  assertEquals(batches, [["space:of:pending"]]);
});
