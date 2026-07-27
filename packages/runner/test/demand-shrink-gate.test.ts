// P0 demand-blip fix (client-passivity plan): the runner's demand-shrink
// gate must fold the transient empty set out of same-space navigation
// (measured: 53/53 claim refusals were "sponsor-demand-gone" because every
// stop->start published {} between {A} and {B}).
import { assertEquals } from "@std/assert";
import { ExecutionDemandShrinkGate } from "../src/executor/demand-shrink-gate.ts";

class ManualTimers {
  readonly records = new Map<
    number,
    { callback: () => void; delayMs: number; cleared: boolean; fired: boolean }
  >();
  #next = 0;
  readonly setTimer = (callback: () => void, delayMs: number): number => {
    const timer = ++this.#next;
    this.records.set(timer, { callback, delayMs, cleared: false, fired: false });
    return timer;
  };
  readonly clearTimer = (timer: number): void => {
    const record = this.records.get(timer);
    if (record !== undefined) record.cleared = true;
  };
  fireAll(): void {
    for (const record of this.records.values()) {
      if (record.cleared || record.fired) continue;
      record.fired = true;
      record.callback();
    }
  }
  activeCount(): number {
    return [...this.records.values()].filter((r) => !r.cleared && !r.fired)
      .length;
  }
}

const SPACE = "did:key:z6Mk-space";

Deno.test("navigation blip: stop->start inside the hold publishes {A} then {B}, never {}", () => {
  const timers = new ManualTimers();
  const gate = new ExecutionDemandShrinkGate({
    holdMs: 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const published: string[][] = [];
  const publish = (pieces: readonly string[]) => published.push([...pieces]);

  gate.grow(SPACE, ["piece:a"], publish);
  gate.shrink(SPACE, [], publish); // stop A (navigation begins)
  gate.grow(SPACE, ["piece:b"], publish); // start B (navigation ends)
  timers.fireAll();

  assertEquals(published, [["piece:a"], ["piece:b"]]);
  assertEquals(timers.activeCount(), 0, "the held shrink was cancelled");
});

Deno.test("genuine departure: the shrunken set publishes once the hold lapses, with the LATEST set", () => {
  const timers = new ManualTimers();
  const gate = new ExecutionDemandShrinkGate({
    holdMs: 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const published: string[][] = [];
  const publish = (pieces: readonly string[]) => published.push([...pieces]);

  gate.grow(SPACE, ["piece:a", "piece:b"], publish);
  gate.shrink(SPACE, ["piece:b"], publish); // stop A
  gate.shrink(SPACE, [], publish); // stop B inside the same hold
  assertEquals(published, [["piece:a", "piece:b"]], "shrinks held");
  timers.fireAll();
  assertEquals(published, [["piece:a", "piece:b"], []], "one publish, latest set");
});

Deno.test("teardown flushes immediately through any held shrink", () => {
  const timers = new ManualTimers();
  const gate = new ExecutionDemandShrinkGate({
    holdMs: 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const published: string[][] = [];
  const publish = (pieces: readonly string[]) => published.push([...pieces]);

  gate.grow(SPACE, ["piece:a"], publish);
  gate.shrink(SPACE, [], publish);
  gate.flushImmediate(SPACE, [], publish);
  assertEquals(published, [["piece:a"], []]);
  assertEquals(timers.activeCount(), 0);
  timers.fireAll();
  assertEquals(published, [["piece:a"], []], "no double publish after flush");
});

Deno.test("holdMs 0 is byte-identical passthrough", () => {
  const timers = new ManualTimers();
  const gate = new ExecutionDemandShrinkGate({
    holdMs: 0,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const published: string[][] = [];
  const publish = (pieces: readonly string[]) => published.push([...pieces]);
  gate.grow(SPACE, ["piece:a"], publish);
  gate.shrink(SPACE, [], publish);
  gate.grow(SPACE, ["piece:b"], publish);
  assertEquals(published, [["piece:a"], [], ["piece:b"]]);
});

Deno.test("spaces are independent; dispose cancels without publishing", () => {
  const timers = new ManualTimers();
  const gate = new ExecutionDemandShrinkGate({
    holdMs: 10_000,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  const published: string[][] = [];
  const publish = (pieces: readonly string[]) => published.push([...pieces]);
  gate.shrink("space:one", [], publish);
  gate.shrink("space:two", ["piece:x"], publish);
  assertEquals(timers.activeCount(), 2);
  gate.dispose();
  timers.fireAll();
  assertEquals(published, [], "disposed holds never publish");
});
