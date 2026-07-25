// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It replaces the clock so tests run under
// controllable time, and adds `settle` and `tick` to a global `clock`.
//
// Runner's own reactivity is time-coupled: the scheduler, storage, and wake
// shaper arm positive-delay timers (throttle windows, backoff, conflict
// retries) that `runtime.idle()`, `cell.pull()`, and commit await. So the clock
// distinguishes two callers of a positive-delay `setTimeout`:
//
//   - Production timers (scheduled from `src/`) AUTO-ADVANCE: when the event
//     loop would otherwise idle, logical time jumps to the earliest pending one
//     and fires it, in order. `Date.now`/`performance.now` move with it. So a
//     throttle window or backoff elapses instantly and deterministically, and
//     the reactive waits above resolve on their own — no real sleeping.
//
//   - Test timers (scheduled from a `test/` file — a wall-clock sleep) FREEZE.
//     They never fire, so a test that waits on one deadlocks, which Deno's
//     async-op sanitizer reports at once. The lesson: delete the sleep and wait
//     on `runtime.idle()`/`cell.pull()`, which now settle on their own, or use
//     `clock.tick(ms)` when the test needs to observe an intermediate instant.
//
// `clock.settle()` drains reactive (zero-delay) work without moving time.
// `clock.tick(ms)` advances logical time by `ms`, firing production timers in
// lockstep; the auto-advance pump is paused while it runs, so a test can
// observe a state partway through a window.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realDateNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);

const DATE_ORIGIN = 1_700_000_000_000;

type Kind = "zero" | "prod" | "test";
interface Timer {
  id: number;
  cb: (...args: unknown[]) => void;
  fireAt: number;
  args: unknown[];
  kind: Kind;
  interval?: number;
}

// The immediate caller of setTimeout: the first stack frame outside this file.
// A frame in a `test/` directory (or a `.test.ts` file) is test code.
function callerIsTest(): boolean {
  const stack = new Error().stack ?? "";
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes("clock-preload.ts")) continue;
    return /\/test\//.test(line) || /\.test\.ts/.test(line);
  }
  return false;
}

function freezeAround(
  fn: (t: Deno.TestContext) => void | Promise<void>,
): (t: Deno.TestContext) => Promise<void> {
  return async (t: Deno.TestContext) => {
    let elapsed = 0;
    let seq = 1;
    let ticking = false;
    let kickScheduled = false;
    let autoScheduled = false;
    const timers = new Map<number, Timer>();

    const drainMicrotasks = () =>
      new Promise<void>((resolve) => realSetTimeout(resolve, 0));

    // Fire pending zero-delay timers (scheduler dispatch) on a real macrotask.
    const kick = () => {
      kickScheduled = false;
      for (const tm of [...timers.values()]) {
        if (tm.kind !== "zero" || tm.fireAt > elapsed) continue;
        timers.delete(tm.id);
        tm.cb(...tm.args);
      }
    };
    const scheduleKick = () => {
      if (kickScheduled) return;
      kickScheduled = true;
      realSetTimeout(kick, 0);
    };

    const hasPendingZero = () =>
      kickScheduled ||
      [...timers.values()].some((tm) =>
        tm.kind === "zero" && tm.fireAt <= elapsed
      );

    const settle = async () => {
      // Pause auto-advance while draining, so `settle()` observes reactive work
      // without letting a production timer (a throttle/debounce window) fire —
      // that is what lets a test check a state partway through a window.
      const wasTicking = ticking;
      ticking = true;
      try {
        for (let guard = 0; guard < 100_000; guard++) {
          await drainMicrotasks();
          if (!hasPendingZero()) return;
          kick();
        }
        throw new Error(
          "settle() did not converge: zero-delay work regenerated",
        );
      } finally {
        ticking = wasTicking;
        if (!ticking) scheduleAuto();
      }
    };

    // Auto-advance: fire the earliest future production timer, jumping the clock
    // to it, so runner's reactive waits resolve without real time passing.
    // The earliest future timer to fire. `onlyProd` restricts to the runtime's
    // own timers (used by the auto-advance pump, so a test's frozen sleep is
    // never fired on its own); `tick` passes false, advancing test timers too,
    // so a test can model a slow async step with `setTimeout` and step through
    // it explicitly.
    const nextTimer = (limit: number, onlyProd: boolean): Timer | undefined => {
      let next: Timer | undefined;
      for (const tm of timers.values()) {
        if (tm.kind === "zero" || tm.fireAt <= elapsed || tm.fireAt > limit) {
          continue;
        }
        if (onlyProd && tm.kind !== "prod") continue;
        if (!next || tm.fireAt < next.fireAt) next = tm;
      }
      return next;
    };
    const nextProd = (limit: number) => nextTimer(limit, true);
    let autoCount = 0;
    const autoAdvance = () => {
      autoScheduled = false;
      if (ticking) return;
      const next = nextProd(Infinity);
      if (!next) return;
      if (++autoCount > 200_000) {
        throw new Error(
          "clock auto-advance runaway: a production timer keeps re-arming. " +
            "This test likely needs explicit clock.tick(ms) control.",
        );
      }
      elapsed = next.fireAt;
      if (next.interval === undefined) timers.delete(next.id);
      else next.fireAt = elapsed + next.interval;
      next.cb(...next.args);
      if (nextProd(Infinity)) scheduleAuto();
    };
    const scheduleAuto = () => {
      if (autoScheduled || ticking) return;
      autoScheduled = true;
      realSetTimeout(autoAdvance, 0);
    };

    const settleObj = {
      settle,
      async tick(ms: number) {
        if (ms < 0) throw new Error("tick(ms) requires ms >= 0");
        ticking = true;
        try {
          const target = elapsed + ms;
          for (let guard = 0; guard < 1_000_000; guard++) {
            await settle();
            const next = nextTimer(target, false);
            if (!next) break;
            elapsed = next.fireAt;
            if (next.interval === undefined) timers.delete(next.id);
            else next.fireAt = elapsed + next.interval;
            next.cb(...next.args);
          }
          elapsed = target;
          await settle();
        } finally {
          ticking = false;
          scheduleAuto();
        }
      },
      // Return logical time to zero and drop every pending timer. One
      // `freezeAround` wraps a whole `describe`, so a suite whose cases each
      // start from a known instant — reading absolute, coarsened wall-clock
      // values — calls this from `beforeEach` to keep a clock an earlier case
      // built from leaking into the next.
      reset() {
        elapsed = 0;
        seq = 1;
        autoCount = 0;
        ticking = false;
        kickScheduled = false;
        autoScheduled = false;
        timers.clear();
      },
    };

    const fakeSetTimeout = (
      cb: (...args: unknown[]) => void,
      delay = 0,
      ...args: unknown[]
    ): number => {
      const id = seq++;
      const ms = Number(delay) || 0;
      if (ms <= 0) {
        timers.set(id, { id, cb, fireAt: elapsed, args, kind: "zero" });
        scheduleKick();
      } else if (callerIsTest()) {
        timers.set(id, { id, cb, fireAt: elapsed + ms, args, kind: "test" });
      } else {
        timers.set(id, { id, cb, fireAt: elapsed + ms, args, kind: "prod" });
        scheduleAuto();
      }
      return id;
    };
    const fakeSetInterval = (
      cb: (...args: unknown[]) => void,
      delay = 0,
      ...args: unknown[]
    ): number => {
      const id = seq++;
      const ms = Math.max(1, Number(delay) || 0);
      const kind: Kind = callerIsTest() ? "test" : "prod";
      timers.set(id, {
        id,
        cb,
        fireAt: elapsed + ms,
        args,
        kind,
        interval: ms,
      });
      if (kind === "prod") scheduleAuto();
      return id;
    };
    const fakeClear = (id: number): void => {
      timers.delete(id);
    };

    Reflect.set(globalThis, "setTimeout", fakeSetTimeout);
    Reflect.set(globalThis, "setInterval", fakeSetInterval);
    Reflect.set(globalThis, "clearTimeout", fakeClear);
    Reflect.set(globalThis, "clearInterval", fakeClear);
    Reflect.set(Date, "now", () => DATE_ORIGIN + elapsed);
    Reflect.set(performance, "now", () => elapsed);
    Reflect.set(globalThis, "clock", settleObj);

    try {
      await fn(t);
      await settle();
    } finally {
      Reflect.set(globalThis, "setTimeout", realSetTimeout);
      Reflect.set(globalThis, "setInterval", realSetInterval);
      Reflect.set(globalThis, "clearTimeout", realClearTimeout);
      Reflect.set(globalThis, "clearInterval", realClearInterval);
      Reflect.set(Date, "now", realDateNow);
      Reflect.set(performance, "now", realPerformanceNow);
      Reflect.set(globalThis, "clock", undefined);
    }
  };
}

const realTest = Deno.test;

// Test files kept on the real clock for now. These should be converted to use
// a fake clock. // TODO: convert these tests to a fake clock
const REAL_CLOCK_FILES = [
  // A second (resuming) runtime drives a real loopback memory-client transport
  // whose connect/mount/sync machinery does not complete under the fake clock:
  // the resume deadlocks rather than settling.
  "list-resume-container-defer",
  // Asserts on the retry-backoff *windowing* of transient multi-space commit
  // rejections — which rejection fails fast versus is retried within a window.
  // Auto-advance collapses those windows instantly, erasing the distinction the
  // tests check.
  "mergeable-append-multispace-conflict",
  // Drives a nested-subagent generateObject: a delegate tool runs a child
  // pattern whose result feeds back to the parent through the post-commit
  // outbox across several cycles. The tool-calling path carries its own
  // timeout, which auto-advance fires against the subagent's own outbox
  // progress rather than the wall clock, aborting the delegate ("tool call
  // timed out") before it can complete. Real time paces the two together.
  "generate-object-tools",
];
function registeredFromRealClockFile(): boolean {
  const stack = new Error().stack ?? "";
  // Match the whole test-file name, not a bare substring: a name like `wish`
  // must not also claim `wish-now-interval.test.ts`.
  return REAL_CLOCK_FILES.some((name) => stack.includes(`${name}.test.ts`));
}

function frozenTest(
  nameOrDef: string | Deno.TestDefinition,
  fn?: (t: Deno.TestContext) => void | Promise<void>,
): void {
  const wrap = registeredFromRealClockFile() ? <T>(f: T) => f : freezeAround;
  if (typeof nameOrDef === "string") {
    realTest(nameOrDef, wrap(fn!));
  } else {
    realTest({ ...nameOrDef, fn: wrap(nameOrDef.fn) });
  }
}

Reflect.set(Deno, "test", frozenTest);
