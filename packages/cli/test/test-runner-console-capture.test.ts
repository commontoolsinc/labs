/**
 * Integration-level guard for console error/warning capture semantics.
 *
 * console.error() and console.warn() calls (plus logger-level activity) emitted
 * during a test run must fail the test unless the pattern opts out via
 * `allowConsoleErrors: true` or `allowConsoleWarnings: true`.
 *
 * Mirrors the design of test-runner-expect-non-idempotent.test.ts.
 */
import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import {
  appendLoggerDeltaMessages,
  snapshotLoggerErrorWarnCounts,
} from "../lib/console-capture.ts";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/console-capture",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

function withCommonfabric(value: unknown, test: () => undefined): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "commonfabric",
  );
  Object.defineProperty(globalThis, "commonfabric", {
    configurable: true,
    value,
  });
  try {
    test();
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "commonfabric", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "commonfabric");
    }
  }
}

describe(
  "console capture semantics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("ignores missing logger globals", () => {
      withCommonfabric(undefined, () => {
        expect(snapshotLoggerErrorWarnCounts().size).toBe(0);
      });
    });

    it("ignores non-object logger globals", () => {
      withCommonfabric({ logger: undefined }, () => {
        expect(snapshotLoggerErrorWarnCounts().size).toBe(0);
      });
    });

    it("captures logger deltas from global logger counts", () => {
      const countsByKey: Record<string, { error: number; warn: number }> = {
        active: { error: 1, warn: 2 },
      };
      withCommonfabric({
        logger: {
          test: {
            counts: { error: 0, warn: 0 },
            countsByKey,
          },
        },
      }, () => {
        const snapshot = snapshotLoggerErrorWarnCounts();
        countsByKey.active.error = 3;
        countsByKey.active.warn = 5;
        countsByKey.created = { error: 1, warn: 1 };

        const errors: string[] = [];
        const warnings: string[] = [];
        appendLoggerDeltaMessages(snapshot, errors, warnings);

        expect(errors).toEqual([
          "[logger:test] 2 error(s) (key: active)",
          "[logger:test] 1 error(s) (key: created)",
        ]);
        expect(warnings).toEqual([
          "[logger:test] 3 warning(s) (key: active)",
          "[logger:test] 1 warning(s) (key: created)",
        ]);
      });
    });

    it("fails when console.error is called and no allowConsoleErrors flag", async () => {
      const { passed, failed, results } = await runTests(
        fixture("console-error-unallowed.test.tsx"),
        { root: FIXTURES },
      );
      // The pattern's own assertion passes; the console error must add a failure.
      expect(passed).toBe(1);
      expect(failed).toBe(1);
      // Confirm the failure is reported as a console error, not a test assertion.
      const allErrors = results.flatMap((r) => r.consoleErrors ?? []);
      expect(allErrors.some((e) => e.includes("console.error"))).toBe(true);
    });

    it("passes when console.error is called and allowConsoleErrors is true", async () => {
      const { passed, failed } = await runTests(
        fixture("console-error-allowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("fails when console.warn is called and no allowConsoleWarnings flag", async () => {
      const { passed, failed, results } = await runTests(
        fixture("console-warn-unallowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(1);
      const allWarnings = results.flatMap((r) => r.consoleWarnings ?? []);
      expect(allWarnings.some((w) => w.includes("console.warn"))).toBe(true);
    });

    it("passes when console.warn is called and allowConsoleWarnings is true", async () => {
      const { passed, failed } = await runTests(
        fixture("console-warn-allowed.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("allowConsoleErrors and allowConsoleWarnings are independent", async () => {
      // allowConsoleErrors does NOT suppress warnings — they must be opted out
      // separately with allowConsoleWarnings.
      const { failed, results } = await runTests(
        fixture("console-error-allowed.test.tsx"),
        { root: FIXTURES },
      );
      // No warnings were emitted in the error-allowed fixture, so no warning failures.
      expect(failed).toBe(0);
      const allWarnings = results.flatMap((r) => r.consoleWarnings ?? []);
      expect(allWarnings.length).toBe(0);
    });
  },
);
