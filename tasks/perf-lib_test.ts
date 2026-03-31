import { assert, assertFalse } from "@std/assert";

import { isExcludedMetric } from "./perf-lib.ts";

Deno.test("isExcludedMetric excludes noisy aggregate test metrics", () => {
  assert(isExcludedMetric("job: Test"));
  assert(isExcludedMetric("job: Pattern Unit Tests (3/5)"));
  assert(isExcludedMetric("step: pattern unit tests"));

  assertFalse(isExcludedMetric("step: workspace tests"));
  assertFalse(isExcludedMetric("job: Generated Patterns Integration Tests"));
});
