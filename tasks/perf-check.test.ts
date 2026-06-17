import { assertEquals, assertStringIncludes } from "@std/assert";
import { parseMergedBaselineOverrides } from "./perf-check.ts";

Deno.test("invalid merged PR baseline override metadata is ignored", () => {
  const warnings: string[] = [];
  const overrides = parseMergedBaselineOverrides(
    {
      number: 123,
      body: "NEW_PERF_BASELINE: job: Check = 7 lines",
    },
    (message) => warnings.push(message),
  );

  assertEquals(overrides, null);
  assertEquals(warnings.length, 1);
  assertStringIncludes(warnings[0], "merged PR #123");
  assertStringIncludes(
    warnings[0],
    "line units are only valid for coverage-debt metrics",
  );
});

Deno.test("valid merged PR baseline override metadata is parsed", () => {
  const overrides = parseMergedBaselineOverrides({
    number: 124,
    body: "NEW_PERF_BASELINE: job: Check = 7s",
  });

  assertEquals(overrides?.metrics.get("job: Check"), 7);
});
