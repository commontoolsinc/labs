// Shared fake-clock harness for package test suites. A package wires it in
// through Deno's `--preload` on its test task by writing a one-line
// `test/clock-preload.ts` that calls `installFakeClock` with a mode. The
// harness replaces `Deno.test` so each test runs under a controllable clock, and
// exposes drain/advance controls.
//
// Two modes exist, chosen by the caller:
//
//   - "auto-advance": positive-delay timers are sorted by who scheduled them.
//     A timer armed from `src/` (production code — the runtime's own scheduler,
//     storage, and wake shaper arm throttle windows, backoff, and conflict
//     retries) AUTO-ADVANCES: when the event loop would otherwise idle, logical
//     time jumps to the earliest pending one and fires it, in order, with
//     `Date.now` and `performance.now` moving in lockstep. So a window elapses
//     instantly and deterministically, and the reactive waits that await it
//     resolve on their own — no real sleeping. A timer armed from a `test/` file
//     (a wall-clock sleep) FREEZES: it never fires, so a test that waits on one
//     deadlocks, which Deno's async-op sanitizer reports at once. The controls
//     are a global `clock` with `settle()`, `tick(ms)`, and `reset()`.
//
//   - "freeze-all": every positive-delay timer FREEZES regardless of caller,
//     and only `setTimeout`/`clearTimeout` are replaced (`setInterval`,
//     `Date.now`, and `performance.now` stay real). A zero-delay timer still
//     fires, so scheduler dispatch and teardown resolve on their own, while a
//     wall-clock sleep deadlocks and announces itself. The control is
//     `t.settle()`, attached to each test's context.
//
// In both modes a zero-delay `setTimeout(fn, 0)` fires on a real macrotask, so
// reactive dispatch that runs on `setTimeout(fn, 0)` drains through the real
// event loop with no test-side driving. `settle()` resolves once every
// zero-delay timer and microtask has run to a fixpoint: it is an ordering
// guarantee rather than a deadline, so it cannot lose a race under load, and it
// holds for a test asserting an op is absent as much as one asserting it is
// present. `tick(ms)` advances logical time by `ms`, firing timers in lockstep;
// the auto-advance pump is paused while it runs, so a test can observe a state
// partway through a window.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realDateNow = Date.now;
const realPerformanceNow = performance.now.bind(performance);

// The basename of this module, read from its own URL so the stack-frame caller
// classification keeps working if the file is renamed. Frames inside the
// harness (and inside a package's thin `clock-preload.ts` wrapper, which shares
// the basename) are skipped when deciding who scheduled a timer.
const HARNESS_FILE = new URL(import.meta.url).pathname.split("/").pop() ??
  "clock-preload.ts";

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

/** Which behavior a package's preload selects. */
export type FakeClockMode = "auto-advance" | "freeze-all";

/** Options a package's thin `clock-preload.ts` passes to {@link installFakeClock}. */
export interface FakeClockOptions {
  mode: FakeClockMode;
  // Test-file stems kept entirely on the real clock (no faking). Matched against
  // the registering stack frame as `${stem}.test.ts`. Defaults to none.
  realClockFiles?: readonly string[];
}

interface ResolvedConfig {
  autoAdvance: boolean;
  fakeInterval: boolean;
  fakeTimeSource: boolean;
  exposeGlobalClock: boolean;
  exposeContextSettle: boolean;
  settleAfterBody: boolean;
  realClockFiles: readonly string[];
}

const PRESETS: Record<FakeClockMode, Omit<ResolvedConfig, "realClockFiles">> = {
  "auto-advance": {
    autoAdvance: true,
    fakeInterval: true,
    fakeTimeSource: true,
    exposeGlobalClock: true,
    exposeContextSettle: false,
    settleAfterBody: true,
  },
  "freeze-all": {
    autoAdvance: false,
    fakeInterval: false,
    fakeTimeSource: false,
    exposeGlobalClock: false,
    exposeContextSettle: true,
    settleAfterBody: false,
  },
};

// The current call stack, as newline-separated frames with the innermost first.
//
// A plain `new Error().stack` is enough until SES enters the picture. The runner
// package locks SES down the first time a test builds a `Runtime`, with
// `errorTaming` set to "safe" — a permanent, process-global change. Safe taming
// still captures each error's frames, but hides them behind the tamed `stack`
// accessor, which from then on reads back as the empty string. Every timer a
// test schedules after that first lockdown would otherwise arrive here with no
// stack to classify, so `callerIsTest` would read every one as `src/` and let a
// stray test sleep auto-advance instead of freezing.
//
// SES hands the real frames back through `getStackString`, the sanctioned hook
// it installs on the global during lockdown; the runtime's own error mapping
// reads stacks through the same hook. We use it whenever lockdown has installed
// it, and fall back to the native `stack` before lockdown, and in a package that
// loads this harness without ever loading SES. Reading the frames this way keeps
// the caller classification working without relaxing the production error
// taming.
function currentStack(): string {
  const error = new Error();
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString === "function") {
    return getStackString(error) ?? "";
  }
  return error.stack ?? "";
}

// The immediate caller of setTimeout: the first stack frame outside this file.
// A frame in a `test/` directory (or a `.test.ts` file) is test code.
function callerIsTest(): boolean {
  const stack = currentStack();
  for (const line of stack.split("\n").slice(1)) {
    if (line.includes(HARNESS_FILE)) continue;
    return /\/test\//.test(line) || /\.test\.ts/.test(line);
  }
  return false;
}

function freezeAround(
  config: ResolvedConfig,
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
      if (config.autoAdvance) ticking = true;
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
        if (config.autoAdvance) {
          ticking = wasTicking;
          if (!ticking) scheduleAuto();
        }
      }
    };

    // Auto-advance: fire the earliest future production timer, jumping the clock
    // to it, so the runtime's reactive waits resolve without real time passing.
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
      } else if (!config.autoAdvance || callerIsTest()) {
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
      const kind: Kind = (!config.autoAdvance || callerIsTest())
        ? "test"
        : "prod";
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
    Reflect.set(globalThis, "clearTimeout", fakeClear);
    if (config.fakeInterval) {
      Reflect.set(globalThis, "setInterval", fakeSetInterval);
      Reflect.set(globalThis, "clearInterval", fakeClear);
    }
    if (config.fakeTimeSource) {
      Reflect.set(Date, "now", () => DATE_ORIGIN + elapsed);
      Reflect.set(performance, "now", () => elapsed);
    }
    if (config.exposeGlobalClock) {
      Reflect.set(globalThis, "clock", settleObj);
    }
    if (config.exposeContextSettle) {
      Reflect.set(t, "settle", settle);
    }

    try {
      await fn(t);
      if (config.settleAfterBody) await settle();
    } finally {
      // A kick or autoAdvance macrotask may still sit queued on the real event
      // loop when the body returns (settle's own finally re-arms auto-advance).
      // Emptying the timer map makes those callbacks no-ops, so this test's
      // timers cannot fire — and reschedule onto the real clock — once real
      // time is restored.
      timers.clear();
      Reflect.set(globalThis, "setTimeout", realSetTimeout);
      Reflect.set(globalThis, "clearTimeout", realClearTimeout);
      if (config.fakeInterval) {
        Reflect.set(globalThis, "setInterval", realSetInterval);
        Reflect.set(globalThis, "clearInterval", realClearInterval);
      }
      if (config.fakeTimeSource) {
        Reflect.set(Date, "now", realDateNow);
        Reflect.set(performance, "now", realPerformanceNow);
      }
      if (config.exposeGlobalClock) {
        Reflect.set(globalThis, "clock", undefined);
      }
    }
  };
}

// Match the whole test-file name, not a bare substring: a name like `wish` must
// not also claim `wish-now-interval.test.ts`.
function registeredFromRealClockFile(
  realClockFiles: readonly string[],
): boolean {
  if (realClockFiles.length === 0) return false;
  const stack = currentStack();
  return realClockFiles.some((name) => stack.includes(`${name}.test.ts`));
}

/**
 * Replace `Deno.test` so every test in the preloading package runs under the
 * fake clock selected by `options.mode`. Call this once, from a package's
 * `test/clock-preload.ts`, which its test task loads through `--preload`.
 */
export function installFakeClock(options: FakeClockOptions): void {
  const config: ResolvedConfig = {
    ...PRESETS[options.mode],
    realClockFiles: options.realClockFiles ?? [],
  };

  const realTest = Deno.test;

  function frozenTest(
    nameOrDef: string | Deno.TestDefinition,
    fn?: (t: Deno.TestContext) => void | Promise<void>,
  ): void {
    if (registeredFromRealClockFile(config.realClockFiles)) {
      if (typeof nameOrDef === "string") realTest(nameOrDef, fn!);
      else realTest(nameOrDef);
      return;
    }
    if (typeof nameOrDef === "string") {
      realTest(nameOrDef, freezeAround(config, fn!));
    } else {
      realTest({ ...nameOrDef, fn: freezeAround(config, nameOrDef.fn) });
    }
  }

  Reflect.set(Deno, "test", frozenTest);
}
