/**
 * Integration-level guard for expectRuntimeErrors semantics: the flag REQUIRES
 * runtime errors (exact count when numeric) rather than merely tolerating
 * them, so a thrown rejection quietly reverting to a silent return fails the
 * suite that depends on it.
 *
 * Mirrors the design of test-runner-console-capture.test.ts.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { resolve } from "@std/path";
import { runTests } from "../lib/test-runner.ts";

const FIXTURES = resolve(
  import.meta.dirname!,
  "fixtures/expect-runtime-errors",
);

function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

describe(
  "expectRuntimeErrors semantics",
  { sanitizeOps: false, sanitizeResources: false },
  () => {
    it("passes when the expected error fires, and tolerates it", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-and-throwing.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(0);
    });

    it("fails when errors were expected but none fired", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-but-silent.test.tsx"),
        { root: FIXTURES },
      );
      // The pattern's own assertion passes; the unmet expectation must fail.
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });

    it("fails on an exact-count mismatch", async () => {
      const { passed, failed } = await runTests(
        fixture("expected-count-mismatch.test.tsx"),
        { root: FIXTURES },
      );
      expect(passed).toBe(1);
      expect(failed).toBe(1);
    });
  },
);
