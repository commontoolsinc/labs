import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  computeBaseline,
  extractMetrics,
  extractPatternTestCpuMetrics,
  extractTestFileMetrics,
  isPatternUnitWallMetric,
  isTestMetricForPrefix,
  type Job,
  parseJUnitXml,
  parsePatternTestMetricsJson,
  patternUnitCpuMetricForWallMetric,
  shouldGatePatternUnitWallRegression,
  type Step,
  testMetricPrefixesForStepMetric,
  type WorkflowRun,
} from "./perf-lib.ts";

function makeRun(): WorkflowRun {
  return {
    id: 1,
    html_url: "https://example.test/run/1",
    head_sha: "deadbeef",
    created_at: "2026-01-01T00:00:00Z",
    conclusion: "success",
    event: "push",
  };
}

function makeStep(
  name: string,
  started_at: string,
  completed_at: string,
): Step {
  return { name, started_at, completed_at };
}

function makeJob(
  id: number,
  name: string,
  started_at: string,
  completed_at: string,
  steps: Step[],
): Job {
  return { id, name, started_at, completed_at, steps };
}

Deno.test("extractMetrics keeps CLI core and fuse timings separate", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "CLI Integration Tests (core)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:03:20Z",
      [
        makeStep(
          "🧪 Run CLI integration suite",
          "2026-01-01T00:01:00Z",
          "2026-01-01T00:03:00Z",
        ),
      ],
    ),
    makeJob(
      2,
      "CLI Integration Tests (fuse)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:35Z",
      [
        makeStep(
          "🧪 Run CLI FUSE integration suite",
          "2026-01-01T00:01:00Z",
          "2026-01-01T00:01:30Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: CLI Integration Tests (core)")?.durationSeconds,
    200,
  );
  assertEquals(
    metrics.get("job: CLI Integration Tests (fuse)")?.durationSeconds,
    95,
  );
  assertEquals(
    metrics.get("step: CLI integration (core)")?.durationSeconds,
    120,
  );
  assertEquals(
    metrics.get("step: CLI integration (fuse)")?.durationSeconds,
    30,
  );
  assertEquals(metrics.has("job: CLI Integration Tests"), false);
  assertEquals(metrics.has("step: CLI integration"), false);
});

Deno.test("computeBaseline enforces the 15 percent floor for low-variance samples", () => {
  const baseline = computeBaseline([100, 100, 100, 100, 100]);

  assertEquals(baseline?.median, 100);
  assertEquals(baseline?.stddev, 0);
  assertAlmostEquals(baseline?.threshold ?? 0, 115, 1e-9);
});

Deno.test("computeBaseline uses the 3 sigma threshold when it exceeds 15 percent", () => {
  const baseline = computeBaseline([100, 100, 100, 100, 150]);

  assertEquals(baseline?.median, 100);
  assertAlmostEquals(baseline?.stddev ?? 0, 20, 1e-9);
  assertEquals(baseline?.threshold, 160);
});

Deno.test("parseJUnitXml accepts Deno suites without suite-level time", () => {
  const suites = parseJUnitXml(
    `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="deno test" tests="2" failures="0" errors="0" time="1.500">
  <testsuite name="./integration/shell.test.ts" tests="2" disabled="0" errors="0" failures="0">
    <testcase name="shell tests" classname="./integration/shell.test.ts" time="1.250" line="1" col="1"></testcase>
    <testcase name="shell tests &gt; opens menu" classname="ext:cli/40_test.js" time="0.250" line="2" col="1" />
  </testsuite>
</testsuites>`,
    "shell",
  );

  assertEquals(suites.length, 1);
  assertEquals(suites[0].name, "./integration/shell.test.ts");
  assertEquals(suites[0].sourceLabel, "shell");
  assertAlmostEquals(suites[0].time, 1.5, 1e-9);
  assertEquals(suites[0].tests.length, 2);
  assertEquals(suites[0].tests[1].name, "shell tests &gt; opens menu");
});

Deno.test("extractTestFileMetrics includes XML source label when present", () => {
  const metrics = extractTestFileMetrics(makeRun(), "package-integration", [{
    name: "./integration/shell.test.ts",
    time: 1.5,
    sourceLabel: "shell",
    tests: [{ name: "shell tests", time: 1.25 }],
  }]);

  assertAlmostEquals(
    metrics.get("test: package-integration/shell/./integration/shell.test.ts")
      ?.durationSeconds ?? 0,
    1.5,
    1e-9,
  );
  assertAlmostEquals(
    metrics.get(
      "subtest: package-integration/shell/./integration/shell.test.ts > shell tests",
    )?.durationSeconds ?? 0,
    1.25,
    1e-9,
  );
});

Deno.test("step metrics map to related test metric prefixes", () => {
  assertEquals(testMetricPrefixesForStepMetric("step: shell integration"), [
    "package-integration/shell/",
  ]);
  assertEquals(
    isTestMetricForPrefix(
      "subtest: package-integration/shell/./integration/shell.test.ts > shell tests",
      "package-integration/shell/",
    ),
    true,
  );
  assertEquals(
    isTestMetricForPrefix(
      "subtest: package-integration/runner/./integration/runner.test.ts > runner tests",
      "package-integration/shell/",
    ),
    false,
  );
});

Deno.test("parsePatternTestMetricsJson accepts pattern-unit CPU metrics", () => {
  const parsed = parsePatternTestMetricsJson(JSON.stringify({
    kind: "pattern-test-metrics",
    version: 1,
    metrics: [
      {
        file: "packages/patterns/calendar/calendar.test.tsx",
        durationMs: 12_500,
        passed: true,
        cpuMetrics: {
          userCpuMicros: 2_000_000,
          systemCpuMicros: 500_000,
          totalCpuMicros: 2_500_000,
          rssBytes: 400_000_000,
          heapTotalBytes: 100_000_000,
          heapUsedBytes: 80_000_000,
          externalBytes: 10_000_000,
        },
      },
    ],
  }));

  assertEquals(parsed?.kind, "pattern-test-metrics");
  assertEquals(parsed?.metrics.length, 1);
  assertEquals(parsed?.metrics[0].cpuMetrics?.totalCpuMicros, 2_500_000);
});

Deno.test("extractPatternTestCpuMetrics emits aggregate and per-file CPU seconds", () => {
  const parsed = parsePatternTestMetricsJson(JSON.stringify({
    kind: "pattern-test-metrics",
    version: 1,
    metrics: [
      {
        file: "packages/patterns/calendar/calendar.test.tsx",
        durationMs: 12_500,
        passed: true,
        cpuMetrics: {
          userCpuMicros: 2_000_000,
          systemCpuMicros: 500_000,
          totalCpuMicros: 2_500_000,
          rssBytes: 400_000_000,
          heapTotalBytes: 100_000_000,
          heapUsedBytes: 80_000_000,
          externalBytes: 10_000_000,
        },
      },
      {
        file: "packages/patterns/reading-list/reading-list.test.tsx",
        durationMs: 8_000,
        passed: true,
        cpuMetrics: {
          userCpuMicros: 3_000_000,
          systemCpuMicros: 250_000,
          totalCpuMicros: 3_250_000,
          rssBytes: 410_000_000,
          heapTotalBytes: 110_000_000,
          heapUsedBytes: 85_000_000,
          externalBytes: 11_000_000,
        },
      },
    ],
  }));
  if (!parsed) throw new Error("expected valid pattern metrics JSON");

  const metrics = extractPatternTestCpuMetrics(
    makeRun(),
    "pattern-unit-2",
    parsed,
  );

  assertAlmostEquals(
    metrics.get("cpu: pattern-unit-2/pattern-unit-tests")
      ?.durationSeconds ?? 0,
    5.75,
    1e-9,
  );
  assertAlmostEquals(
    metrics.get(
      "cpu: pattern-unit-2/pattern-unit-tests > packages/patterns/calendar/calendar.test.tsx",
    )?.durationSeconds ?? 0,
    2.5,
    1e-9,
  );
});

Deno.test("pattern-unit wall metrics map to matching CPU metrics", () => {
  assertEquals(
    patternUnitCpuMetricForWallMetric(
      "test: pattern-unit-1/pattern-unit-tests",
    ),
    "cpu: pattern-unit-1/pattern-unit-tests",
  );
  assertEquals(
    patternUnitCpuMetricForWallMetric(
      "subtest: pattern-unit-1/pattern-unit-tests > packages/patterns/calendar/calendar.test.tsx",
    ),
    "cpu: pattern-unit-1/pattern-unit-tests > packages/patterns/calendar/calendar.test.tsx",
  );
  assertEquals(
    isPatternUnitWallMetric("step: pattern unit tests"),
    false,
  );
});

Deno.test("shouldGatePatternUnitWallRegression requires CPU corroboration unless wall is very large", () => {
  assertEquals(
    shouldGatePatternUnitWallRegression({
      wallFailed: true,
      wallCurrentSeconds: 12,
      wallBaselineMedianSeconds: 10,
      cpuFailed: true,
    }),
    true,
  );
  assertEquals(
    shouldGatePatternUnitWallRegression({
      wallFailed: true,
      wallCurrentSeconds: 13,
      wallBaselineMedianSeconds: 10,
      cpuFailed: false,
    }),
    false,
  );
  assertEquals(
    shouldGatePatternUnitWallRegression({
      wallFailed: true,
      wallCurrentSeconds: 14.1,
      wallBaselineMedianSeconds: 10,
      cpuFailed: false,
    }),
    true,
  );
  assertEquals(
    shouldGatePatternUnitWallRegression({
      wallFailed: false,
      wallCurrentSeconds: 14.1,
      wallBaselineMedianSeconds: 10,
      cpuFailed: true,
    }),
    false,
  );
});
