// A production backstop is a timer that lets a wait give up: the caller
// proceeds as if the event it waited for had arrived, and the only trace is a
// counted log line the module's logger sits above (`storage.v2` logs at
// `error`, so its `warn` is never printed). Under the runner's auto-advance
// clock such a backstop fires the moment nothing else is pending, so a test
// whose awaited event never arrives still passes, riding a silent logical
// jump instead of the event. This guard turns that ride into a failure: it
// snapshots the counts behind each listed backstop around every test body,
// and a count that moved fails the test with the backstop named.

import { registerFrameworkModule } from "@commonfabric/test-support/records";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";

// A test registered through this guard is attributed to the file that called
// `Deno.test`, not to the frame this guard adds between them.
registerFrameworkModule(import.meta.url);

/** One backstop the guard watches, identified by the log line it counts. */
export interface SilentBackstop {
  /** The logger's module name, as passed to `getLogger`. */
  logger: string;
  /** The message key the backstop logs under when it fires. */
  key: string;
  /** What a firing means, for the failure message. */
  meaning: string;
}

/** A firing the guard found: the backstop and how many times it fired. */
export interface FiredBackstop {
  backstop: SilentBackstop;
  fired: number;
}

const countKey = (backstop: SilentBackstop): string =>
  `${backstop.logger}\0${backstop.key}`;

/**
 * The current count behind each backstop, keyed by logger and message key.
 * Read through the registry breakdown rather than `getLogger`, which would
 * CREATE a logger the production module has not made yet — with default
 * options in place of the module's own.
 */
export function readBackstopCounts(
  backstops: readonly SilentBackstop[],
): Map<string, number> {
  const breakdown = getLoggerCountsBreakdown();
  const counts = new Map<string, number>();
  for (const backstop of backstops) {
    const entry = breakdown[backstop.logger]?.[backstop.key];
    counts.set(
      countKey(backstop),
      typeof entry === "object" && entry !== null ? entry.total : 0,
    );
  }
  return counts;
}

/** The backstops whose count rose between two readings. */
export function firedBackstops(
  backstops: readonly SilentBackstop[],
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): FiredBackstop[] {
  const fired: FiredBackstop[] = [];
  for (const backstop of backstops) {
    const key = countKey(backstop);
    const delta = (after.get(key) ?? 0) - (before.get(key) ?? 0);
    if (delta > 0) fired.push({ backstop, fired: delta });
  }
  return fired;
}

/** The failure a fired backstop produces, naming each one and its meaning. */
export function describeFiredBackstops(
  fired: readonly FiredBackstop[],
): string {
  const lines = fired.map(({ backstop, fired }) =>
    `${backstop.logger} "${backstop.key}" fired ${fired} time${
      fired === 1 ? "" : "s"
    }: ${backstop.meaning}`
  );
  return `silent backstop fired during this test — the test rode a ` +
    `timeout instead of the event it waits for:\n  ${lines.join("\n  ")}`;
}

/**
 * Wrap `Deno.test` so every test registered from here on fails when one of
 * `backstops` fires during its body. Install it after the fake clock, so the
 * check runs inside the clock's wrapper — right after the body and before
 * the clock's own post-body settle — where a firing is still this test's.
 */
export function installSilentBackstopGuard(
  backstops: readonly SilentBackstop[],
): void {
  const previousTest = Deno.test;

  const guard = (
    fn: (t: Deno.TestContext) => void | Promise<void>,
  ): (t: Deno.TestContext) => Promise<void> =>
  async (t: Deno.TestContext) => {
    const before = readBackstopCounts(backstops);
    await fn(t);
    const fired = firedBackstops(
      backstops,
      before,
      readBackstopCounts(backstops),
    );
    if (fired.length > 0) {
      throw new Error(describeFiredBackstops(fired));
    }
  };

  function guardedTest(
    nameOrDef: string | Deno.TestDefinition,
    fn?: (t: Deno.TestContext) => void | Promise<void>,
  ): void {
    if (typeof nameOrDef === "string") {
      previousTest(nameOrDef, guard(fn!));
    } else {
      previousTest({ ...nameOrDef, fn: guard(nameOrDef.fn) });
    }
  }

  Reflect.set(Deno, "test", guardedTest);
}
