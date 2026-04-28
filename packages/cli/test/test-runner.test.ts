import { assertEquals } from "@std/assert";
import { testRunPassed, type TestRunResult } from "../lib/test-runner.ts";

function makeResult(
  overrides: Partial<TestRunResult> = {},
): TestRunResult {
  return {
    path: "packages/patterns/example.test.tsx",
    results: [{
      name: "assertion_1",
      passed: true,
      afterAction: null,
      durationMs: 1,
    }],
    totalDurationMs: 1,
    navigations: [],
    runtimeErrors: [],
    nonIdempotent: [],
    ...overrides,
  };
}

Deno.test("testRunPassed follows pattern test failure accounting", () => {
  assertEquals(testRunPassed(makeResult()), true);
  assertEquals(
    testRunPassed(makeResult({
      results: [{
        name: "assertion_1",
        passed: false,
        afterAction: null,
        durationMs: 1,
      }],
    })),
    false,
  );
  assertEquals(
    testRunPassed(makeResult({ runtimeErrors: ["boom"] })),
    false,
  );
  assertEquals(
    testRunPassed(makeResult({
      runtimeErrors: ["expected"],
      allowRuntimeErrors: true,
    })),
    true,
  );
  assertEquals(
    testRunPassed(makeResult({ nonIdempotent: ["computed-value"] })),
    false,
  );
  assertEquals(
    testRunPassed(makeResult({
      nonIdempotent: ["computed-value"],
      expectNonIdempotent: true,
    })),
    true,
  );
});
