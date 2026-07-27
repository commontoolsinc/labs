// Runs before every test module in this package (wired in through `--preload`
// on the package's test task). It replaces `Deno.test` so that each test runs
// under a clock that freezes only positive-delay timers, and adds a `settle`
// method to the test context. A test author writes plain `Deno.test` and
// `await t.settle()`; nothing is imported.
//
// A zero-delay `setTimeout(fn, 0)` still fires, driven through the real event
// loop, so the scheduler's dispatch (which runs on `setTimeout(fn, 0)`), the
// worker reconciler's microtask flush, and teardown (`runtime.dispose()`) all
// resolve on their own. A positive-delay timer is recorded but never fired, so
// a wall-clock sleep — `setTimeout(resolve, 10)`, in any spelling — leaves the
// promise it backs unresolved. A test that waits on one deadlocks, which Deno's
// async-op sanitizer reports at once rather than letting the sleep pass by luck.
//
// `t.settle()` resolves once every zero-delay timer and microtask has run to a
// fixpoint. It is an ordering guarantee rather than a deadline, so it cannot
// lose a race under load, and it holds for a test asserting an op is absent as
// much as one asserting an op is present.

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

interface Timer {
  id: number;
  cb: (...args: unknown[]) => void;
  delay: number;
  args: unknown[];
}

function freezeAround(
  fn: (t: Deno.TestContext) => void | Promise<void>,
): (t: Deno.TestContext) => Promise<void> {
  return async (t: Deno.TestContext) => {
    let seq = 1;
    const pending = new Map<number, Timer>();
    let kickScheduled = false;

    // Fire every pending zero-delay timer on a real macrotask. Firing one may
    // schedule more, each re-arming the kick, so zero-delay work drains through
    // the real event loop with no test-side driving. Positive-delay timers are
    // left in `pending` and never fired.
    const kick = () => {
      kickScheduled = false;
      for (const timer of [...pending.values()]) {
        if (timer.delay !== 0) continue;
        pending.delete(timer.id);
        timer.cb(...timer.args);
      }
    };
    const scheduleKick = () => {
      if (kickScheduled) return;
      kickScheduled = true;
      realSetTimeout(kick, 0);
    };

    const hasZeroDelayWork = () =>
      kickScheduled || [...pending.values()].some((timer) => timer.delay === 0);

    const settle = async () => {
      for (let guard = 0; guard < 100_000; guard++) {
        await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
        if (!hasZeroDelayWork()) return;
      }
      throw new Error(
        "settle() did not converge: zero-delay work kept regenerating",
      );
    };

    const fakeSetTimeout = (
      cb: (...args: unknown[]) => void,
      delay = 0,
      ...args: unknown[]
    ): number => {
      const id = seq++;
      const ms = Number(delay) || 0;
      pending.set(id, { id, cb, delay: ms, args });
      if (ms === 0) scheduleKick();
      return id;
    };
    const fakeClearTimeout = (id: number): void => {
      pending.delete(id);
    };
    // Reflect.set reassigns these read-only-typed slots without a cast: its
    // value parameter is already unknown, so the fakes stay fully typed.
    Reflect.set(globalThis, "setTimeout", fakeSetTimeout);
    Reflect.set(globalThis, "clearTimeout", fakeClearTimeout);
    Reflect.set(t, "settle", settle);

    try {
      await fn(t);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  };
}

const realTest = Deno.test;

function frozenTest(
  nameOrDef: string | Deno.TestDefinition,
  fn?: (t: Deno.TestContext) => void | Promise<void>,
): void {
  if (typeof nameOrDef === "string") {
    realTest(nameOrDef, freezeAround(fn!));
  } else {
    realTest({ ...nameOrDef, fn: freezeAround(nameOrDef.fn) });
  }
}

Reflect.set(Deno, "test", frozenTest);
