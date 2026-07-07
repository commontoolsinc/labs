import {
  assertAlmostEquals,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  aggregateCacheStates,
  applyBaselineOverrides,
  type Artifact,
  buildCoverageDebtSuggestionComment,
  buildCoverageResolvedComment,
  compileCacheFamilyForMetric,
  type CompileCacheState,
  type CompileCacheStates,
  computeBaseline,
  computeCiWallTimeRevisitSignals,
  COVERAGE_BASELINE_RESET_MARKER,
  COVERAGE_SUGGESTION_MARKER,
  coverageGroupsForChangedFiles,
  coverageMetricGroupName,
  downloadAndExtractArtifact,
  dropColdSamples,
  extractMetrics,
  fetchArtifactsForRun,
  fetchCurrentPRBody,
  fetchPRBody,
  fetchPRFiles,
  formatMetricValue,
  formatOverrideSuggestion,
  githubGet,
  type Job,
  latestNonColdSample,
  newestArtifactsByName,
  parseAddedLinesFromPatch,
  parseBaselineOverrides,
  parseCacheStateFiles,
  parsePerfMetricsBackfillFile,
  parsePerfMetricsFile,
  parsePerfMetricsFileDetailed,
  serializePerfMetrics,
  serializePerfMetricsBackfill,
  shouldGateCoverageDebtMetric,
  type Step,
  timingArtifactLabel,
  type TimingSample,
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

Deno.test("extractMetrics aggregates split CLI core jobs", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "CLI Integration Tests (core-piece-values)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [
        makeStep(
          "🧪 Run CLI integration suite",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:20Z",
        ),
      ],
    ),
    makeJob(
      2,
      "CLI Integration Tests (core-piece-links)",
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
      3,
      "CLI Integration Tests (core-piece-call)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:02:40Z",
      [
        makeStep(
          "🧪 Run CLI integration suite",
          "2026-01-01T00:01:00Z",
          "2026-01-01T00:02:30Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: CLI Integration Tests (core-piece-values)")
      ?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: CLI Integration Tests (core-piece-links)")
      ?.durationSeconds,
    200,
  );
  assertEquals(
    metrics.get("job: CLI Integration Tests (core-piece-call)")
      ?.durationSeconds,
    160,
  );
  assertEquals(
    metrics.get("job: CLI Integration Tests (core)")?.durationSeconds,
    200,
  );
  assertEquals(
    metrics.get("step: CLI integration (core)")?.durationSeconds,
    120,
  );
  assertEquals(metrics.has("job: CLI Integration Tests"), false);
  assertEquals(metrics.has("step: CLI integration"), false);
});

Deno.test("extractMetrics aggregates package integration matrix jobs", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "Package Integration Tests (runner)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:20Z",
      [
        makeStep(
          "🧪 Run runner integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:00Z",
        ),
      ],
    ),
    makeJob(
      2,
      "Package Integration Tests (shell)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [
        makeStep(
          "🧪 Run shell integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:30Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: Package Integration Tests (runner)")?.durationSeconds,
    80,
  );
  assertEquals(
    metrics.get("job: Package Integration Tests (shell)")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: Package Integration Tests")?.durationSeconds,
    100,
  );
  assertEquals(metrics.get("step: runner integration")?.durationSeconds, 50);
  assertEquals(metrics.get("step: shell integration")?.durationSeconds, 80);
});

Deno.test("extractMetrics aggregates pattern integration matrix shards", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "Pattern Integration Tests (1/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [
        makeStep(
          "🧩 Run end-to-end patterns integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:30Z",
        ),
      ],
    ),
    makeJob(
      2,
      "Pattern Integration Tests (2/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:10Z",
      [
        makeStep(
          "🧩 Run end-to-end patterns integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:00Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: Pattern Integration Tests (1/4)")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: Pattern Integration Tests (2/4)")?.durationSeconds,
    70,
  );
  assertEquals(
    metrics.get("job: Pattern Integration Tests")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("step: patterns integration")?.durationSeconds,
    80,
  );
});

Deno.test("extractMetrics records pattern reload integration job", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "Pattern Reload Integration Tests",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:20Z",
      [
        makeStep(
          "🧩 Run pattern reload integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:10Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: Pattern Reload Integration Tests")?.durationSeconds,
    80,
  );
  assertEquals(
    metrics.get("step: pattern reload integration")?.durationSeconds,
    60,
  );
});

Deno.test("extractMetrics aggregates generated patterns matrix shards", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "Generated Patterns Integration Tests (1/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [
        makeStep(
          "🧪 Run generated patterns integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:30Z",
        ),
      ],
    ),
    makeJob(
      2,
      "Generated Patterns Integration Tests (2/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:10Z",
      [
        makeStep(
          "🧪 Run generated patterns integration tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:00Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: Generated Patterns Integration Tests (1/4)")
      ?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: Generated Patterns Integration Tests (2/4)")
      ?.durationSeconds,
    70,
  );
  assertEquals(
    metrics.get("job: Generated Patterns Integration Tests")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("step: generated patterns integration")?.durationSeconds,
    80,
  );
});

Deno.test("extractMetrics aggregates runner test matrix shards", () => {
  const metrics = extractMetrics(makeRun(), [
    makeJob(
      1,
      "Runner Tests (1/5)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [
        makeStep(
          "🧪 Run runner tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:30Z",
        ),
      ],
    ),
    makeJob(
      2,
      "Runner Tests (2/5)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:10Z",
      [
        makeStep(
          "🧪 Run runner tests",
          "2026-01-01T00:00:10Z",
          "2026-01-01T00:01:00Z",
        ),
      ],
    ),
  ]);

  assertEquals(
    metrics.get("job: Runner Tests (1/5)")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: Runner Tests (2/5)")?.durationSeconds,
    70,
  );
  assertEquals(metrics.get("job: Runner Tests")?.durationSeconds, 100);
  assertEquals(metrics.get("step: runner tests")?.durationSeconds, 80);
});

Deno.test("timingArtifactLabel normalizes matrix shard artifacts", () => {
  assertEquals(
    timingArtifactLabel("test-timing-package-integration-runner"),
    "package-integration",
  );
  assertEquals(
    timingArtifactLabel("test-timing-pattern-integration-1"),
    "pattern-integration",
  );
  assertEquals(
    timingArtifactLabel("test-timing-pattern-reload-integration"),
    "pattern-reload-integration",
  );
  assertEquals(
    timingArtifactLabel("test-timing-generated-patterns-1"),
    "generated-patterns",
  );
  assertEquals(
    timingArtifactLabel("test-timing-package-integration"),
    "package-integration",
  );
});

Deno.test("perf metrics files round-trip stable metric samples", () => {
  const metrics = new Map([
    [
      "step: Type check",
      {
        runId: 123,
        runUrl: "https://example.test/run/123",
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        durationSeconds: 42.5,
      },
    ],
    [
      "job: Check",
      {
        runId: 123,
        runUrl: "https://example.test/run/123",
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        durationSeconds: 60,
      },
    ],
  ]);

  const serialized = serializePerfMetrics(metrics);
  assertEquals(
    serialized.metrics.map((metric) => metric.name),
    ["job: Check", "step: Type check"],
  );

  assertEquals(
    parsePerfMetricsFile(JSON.stringify(serialized)),
    metrics,
  );
});

Deno.test("perf metrics backfill files round-trip run-keyed samples", () => {
  const runMetrics = new Map([
    [
      123,
      new Map([
        [
          "job: Check",
          {
            runId: 123,
            runUrl: "https://example.test/run/123",
            sha: "abc123",
            createdAt: "2026-01-01T00:00:00Z",
            durationSeconds: 60,
          },
        ],
      ]),
    ],
  ]);

  const serialized = serializePerfMetricsBackfill(runMetrics);
  assertEquals(serialized.runs.map((run) => run.runId), [123]);
  assertEquals(serialized.runs[0].metrics[0].name, "job: Check");

  assertEquals(
    parsePerfMetricsBackfillFile(JSON.stringify(serialized)),
    runMetrics,
  );
});

Deno.test("perf metrics files round-trip compile cache states", () => {
  const metrics = new Map<string, TimingSample>([
    [
      "job: Check",
      {
        runId: 123,
        runUrl: "https://example.test/run/123",
        sha: "abc123",
        createdAt: "2026-01-01T00:00:00Z",
        durationSeconds: 60,
      },
    ],
  ]);
  const states: CompileCacheStates = {
    "generated-patterns": "cold",
    "pattern-unit": "warm",
  };

  const serialized = JSON.stringify(serializePerfMetrics(metrics, states));

  const detailed = parsePerfMetricsFileDetailed(serialized);
  assertEquals(detailed.metrics, metrics);
  assertEquals(detailed.compileCacheStates, states);

  // The tagged file stays version 1, so the legacy parser still accepts it.
  assertEquals(parsePerfMetricsFile(serialized), metrics);
});

Deno.test("parsePerfMetricsFileDetailed treats legacy files as untagged", () => {
  const legacy = JSON.stringify(serializePerfMetrics(new Map()));
  assertFalse(legacy.includes("compileCacheStates"));

  const detailed = parsePerfMetricsFileDetailed(legacy);
  assertEquals(detailed.compileCacheStates, null);
  assertEquals(detailed.metrics.size, 0);

  // Empty states are omitted too, so an all-unknown run stays untagged.
  assertFalse(
    JSON.stringify(serializePerfMetrics(new Map(), {}))
      .includes("compileCacheStates"),
  );
});

Deno.test("parsePerfMetricsFileDetailed drops invalid compile cache states", () => {
  const file = JSON.stringify({
    version: 1,
    generatedAt: "2026-01-01T00:00:00Z",
    metrics: [],
    compileCacheStates: {
      "generated-patterns": "lukewarm",
      "runner": "cold",
      "pattern-unit": "warm",
    },
  });

  assertEquals(parsePerfMetricsFileDetailed(file).compileCacheStates, {
    "pattern-unit": "warm",
  });
});

Deno.test("compileCacheFamilyForMetric maps job, step, and test metrics to families", () => {
  // Aggregate and per-shard job metrics.
  assertEquals(
    compileCacheFamilyForMetric("job: Generated Patterns Integration Tests"),
    "generated-patterns",
  );
  assertEquals(
    compileCacheFamilyForMetric(
      "job: Generated Patterns Integration Tests (2/4)",
    ),
    "generated-patterns",
  );
  assertEquals(
    compileCacheFamilyForMetric("job: Pattern Integration Tests"),
    "pattern-integration",
  );
  assertEquals(
    compileCacheFamilyForMetric("job: Pattern Integration Tests (3/4)"),
    "pattern-integration",
  );
  assertEquals(
    compileCacheFamilyForMetric("job: Pattern Unit Tests (3/5)"),
    "pattern-unit",
  );

  // Step metrics.
  assertEquals(
    compileCacheFamilyForMetric("step: generated patterns integration"),
    "generated-patterns",
  );
  assertEquals(
    compileCacheFamilyForMetric("step: patterns integration"),
    "pattern-integration",
  );
  assertEquals(
    compileCacheFamilyForMetric("step: pattern unit tests"),
    "pattern-unit",
  );

  // Per-test and per-subtest metrics keyed by timing-artifact label.
  assertEquals(
    compileCacheFamilyForMetric(
      "test: generated-patterns/packages/patterns/foo.test.tsx",
    ),
    "generated-patterns",
  );
  assertEquals(
    compileCacheFamilyForMetric(
      "subtest: pattern-integration/packages/patterns/foo.test.tsx > case",
    ),
    "pattern-integration",
  );
  assertEquals(
    compileCacheFamilyForMetric(
      "test: pattern-unit-3/packages/patterns/foo.test.tsx",
    ),
    "pattern-unit",
  );
});

Deno.test("compileCacheFamilyForMetric returns null for metrics without a compile cache", () => {
  for (
    const metric of [
      "job: Runner Tests",
      "job: Pattern Reload Integration Tests",
      "step: runner tests",
      "test: pattern-reload-integration/packages/patterns/foo.test.tsx",
      "test: package-integration/packages/runner/foo.test.ts",
      "subtest: pattern-unit/packages/patterns/foo.test.tsx > case",
      "coverage-debt: workspace uncovered lines",
      "bench: packages/runner/bench/cell.bench.ts > set",
    ]
  ) {
    assertEquals(compileCacheFamilyForMetric(metric), null, metric);
  }
});

Deno.test("cache state aggregation treats any restore hit as warm", () => {
  const records = parseCacheStateFiles([
    '{"family":"generated-patterns","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
    // A restore-key hit (exactHit false) still implies an unchanged compiler
    // fingerprint, so the family is warm.
    '{"family":"generated-patterns","shard":"2","matchedKey":"compile-abc","exactHit":false}',
    '{"family":"pattern-integration","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
  ]);

  // pattern-unit has no records, so its state stays absent (unknown).
  assertEquals(aggregateCacheStates(records), {
    "generated-patterns": "warm",
    "pattern-integration": "warm",
  });
});

Deno.test("cache state aggregation marks a family cold on any full miss", () => {
  const records = parseCacheStateFiles([
    '{"family":"pattern-unit","shard":"1","matchedKey":"compile-abc-1","exactHit":true}',
    '{"family":"pattern-unit","shard":"2","matchedKey":"","exactHit":false}',
    // A warm shard after the miss must not flip the family back to warm.
    '{"family":"pattern-unit","shard":"3","matchedKey":"compile-abc-3","exactHit":true}',
  ]);

  assertEquals(aggregateCacheStates(records), { "pattern-unit": "cold" });
});

Deno.test("cache state parsing skips malformed files and unknown families", () => {
  const originalWarn = console.warn;
  const warnings: string[] = [];
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };

    const records = parseCacheStateFiles([
      "not json {",
      '{"family":"pattern-integration","shard":"1"}',
      '{"family":"runner","shard":"1","matchedKey":"","exactHit":false}',
      '{"family":"pattern-integration","shard":"2","matchedKey":"compile-abc","exactHit":false}',
    ]);

    assertEquals(records.length, 2);
    assertEquals(warnings.length, 2);
    assertStringIncludes(warnings[0], "malformed cache-state file");
    assertStringIncludes(warnings[1], "invalid cache-state record");

    // The unknown "runner" family parses but never becomes a state.
    assertEquals(aggregateCacheStates(records), {
      "pattern-integration": "warm",
    });
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("dropColdSamples removes known-cold runs and keeps unknown ones", () => {
  const sample = (runId: number): TimingSample => ({
    runId,
    runUrl: `https://example.test/run/${runId}`,
    sha: `sha${runId}`,
    createdAt: `2026-01-0${runId}T00:00:00Z`,
    durationSeconds: runId,
  });
  const states = new Map<number, CompileCacheState>([
    [1, "warm"],
    [2, "cold"],
    // Run 3 has no recorded state: unknown runs are kept.
  ]);

  const kept = dropColdSamples(
    [sample(1), sample(2), sample(3)],
    (runId) => states.get(runId),
  );

  assertEquals(kept.map((s) => s.runId), [1, 3]);
});

Deno.test("latestNonColdSample skips trailing cold runs and falls back when all are cold", () => {
  const sample = (runId: number): TimingSample => ({
    runId,
    runUrl: `https://example.test/run/${runId}`,
    sha: `sha${runId}`,
    createdAt: `2026-01-0${runId}T00:00:00Z`,
    durationSeconds: runId,
  });
  const samples = [sample(1), sample(2), sample(3)];
  const coldRuns = new Set([2, 3]);

  assertEquals(
    latestNonColdSample(samples, (runId) => coldRuns.has(runId))?.runId,
    1,
  );
  // All-cold: fall back to the last sample so override-truncation resets
  // still take effect.
  assertEquals(latestNonColdSample(samples, () => true)?.runId, 3);
  assertEquals(latestNonColdSample([], () => false), undefined);
});

Deno.test("computeCiWallTimeRevisitSignals stays quiet for balanced CI", () => {
  const signals = computeCiWallTimeRevisitSignals([
    makeJob(
      1,
      "Pattern Integration Tests (1/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:02:00Z",
      [],
    ),
    makeJob(
      2,
      "CLI Integration Tests (core-piece-call)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:50Z",
      [],
    ),
    makeJob(
      3,
      "Package Integration Tests (shell)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:45Z",
      [],
    ),
    makeJob(
      4,
      "Generated Patterns Integration Tests (1/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [],
    ),
    makeJob(
      5,
      "Runner Tests (1/5)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:35Z",
      [],
    ),
  ]);

  assertEquals(signals, []);
});

Deno.test("computeCiWallTimeRevisitSignals flags slow and imbalanced jobs", () => {
  const signals = computeCiWallTimeRevisitSignals([
    makeJob(
      1,
      "Pattern Integration Tests (2/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:04:00Z",
      [],
    ),
    makeJob(
      2,
      "CLI Integration Tests (core-piece-call)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:40Z",
      [],
    ),
    makeJob(
      3,
      "Package Integration Tests (shell)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:35Z",
      [],
    ),
    makeJob(
      4,
      "Generated Patterns Integration Tests (1/4)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:30Z",
      [],
    ),
    makeJob(
      5,
      "Runner Tests (1/5)",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:25Z",
      [],
    ),
  ]);

  assertEquals(
    signals.map((signal) => signal.kind),
    ["slow-job", "job-imbalance"],
  );
  assertEquals(
    signals[0].detail,
    "Pattern Integration Tests (2/4) took 4m 0s",
  );
});

Deno.test("computeCiWallTimeRevisitSignals flags long required wall time", () => {
  const signals = computeCiWallTimeRevisitSignals([
    makeJob(
      1,
      "Check",
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:01:00Z",
      [],
    ),
    makeJob(
      2,
      "Pattern Integration Tests (1/4)",
      "2026-01-01T00:07:30Z",
      "2026-01-01T00:08:30Z",
      [],
    ),
    makeJob(
      3,
      "Deploy to Toolshed (Staging)",
      "2026-01-01T00:20:00Z",
      "2026-01-01T00:25:00Z",
      [],
    ),
  ]);

  assertEquals(
    signals.map((signal) => signal.kind),
    ["required-wall-time"],
  );
  assertEquals(
    signals[0].detail,
    "Required non-deploy jobs took 8m 30s from first start to last completion",
  );
});

Deno.test("computeBaseline enforces the 50 percent floor for low-variance samples", () => {
  const baseline = computeBaseline([100, 100, 100, 100, 100]);

  assertEquals(baseline?.median, 100);
  assertEquals(baseline?.stddev, 0);
  assertAlmostEquals(baseline?.threshold ?? 0, 150, 1e-9);
});

Deno.test("computeBaseline uses the 3 sigma threshold when it exceeds 50 percent", () => {
  const baseline = computeBaseline([100, 100, 100, 100, 150]);

  assertEquals(baseline?.median, 100);
  assertAlmostEquals(baseline?.stddev ?? 0, 20, 1e-9);
  assertEquals(baseline?.threshold, 160);
});

Deno.test("coverage debt metrics format and parse line units", () => {
  const metric = "coverage-debt: workspace uncovered lines";
  assertEquals(formatMetricValue(metric, 12), "12 lines");
  assertEquals(formatMetricValue(metric, 1), "1 line");
  assertEquals(formatOverrideSuggestion(metric, 12.2), "13 lines");

  const overrides = parseBaselineOverrides(
    "NEW_PERF_BASELINE: coverage-debt: workspace uncovered lines = 7 lines",
  );
  assertEquals(overrides.metrics.get(metric), 7);
  assertEquals(overrides.coverageBaselineReset, false);
});

Deno.test("baseline override parser rejects line units for non-coverage metrics", () => {
  assertThrows(
    () =>
      parseBaselineOverrides(
        "NEW_PERF_BASELINE: job: Check = 7 lines",
      ),
    Error,
    "line units are only valid for coverage-debt metrics",
  );
});

Deno.test("baseline override parser rejects time units for coverage metrics", () => {
  assertThrows(
    () =>
      parseBaselineOverrides(
        "NEW_PERF_BASELINE: coverage-debt: workspace uncovered lines = 7s",
      ),
    Error,
    "coverage-debt metrics must use line units",
  );
});

Deno.test("coverage baseline reset marker parses from PR body", () => {
  const overrides = parseBaselineOverrides(
    `Reset coverage debt for one cycle\n${COVERAGE_BASELINE_RESET_MARKER}\n`,
  );

  assertEquals(overrides.coverageBaselineReset, true);
  assertEquals(overrides.metrics.size, 0);
});

Deno.test("coverage baseline reset truncates coverage timelines only", () => {
  const coverageMetric = "coverage-debt: workspace uncovered lines";
  const jobMetric = "job: Check";
  const sample = (
    sha: string,
    day: number,
    durationSeconds: number,
  ): TimingSample => ({
    runId: day,
    runUrl: `https://example.test/run/${day}`,
    sha,
    createdAt: `2026-01-0${day}T00:00:00Z`,
    durationSeconds,
  });
  const oldCoverage = sample("old", 1, 9);
  const resetCoverage = sample("reset", 2, 12);
  const newCoverage = sample("new", 3, 10);
  const oldJob = sample("old", 1, 20);
  const resetJob = sample("reset", 2, 21);
  const newJob = sample("new", 3, 22);
  const timelines = new Map([
    [
      coverageMetric,
      {
        name: coverageMetric,
        samples: [oldCoverage, resetCoverage, newCoverage],
      },
    ],
    [
      jobMetric,
      { name: jobMetric, samples: [oldJob, resetJob, newJob] },
    ],
  ]);

  applyBaselineOverrides(
    timelines,
    new Map([
      [
        "reset",
        { metrics: new Map(), coverageBaselineReset: true },
      ],
    ]),
  );

  assertEquals(
    timelines.get(coverageMetric)?.samples.map((s) => s.sha),
    ["reset", "new"],
  );
  assertEquals(
    timelines.get(jobMetric)?.samples.map((s) => s.sha),
    ["old", "reset", "new"],
  );
});

Deno.test("coverage debt gating follows changed source groups", () => {
  const groups = coverageGroupsForChangedFiles([
    "packages/runner/src/cell.ts",
    "packages/patterns/README.md",
    "packages/ui/src/button.test.tsx",
    "tasks/perf-check.ts",
    "scripts/build.ts",
  ]);

  assertEquals([...groups].sort(), ["packages/runner", "packages/ui", "tasks"]);
  assertEquals(
    coverageMetricGroupName("coverage-debt: packages/runner uncovered lines"),
    "packages/runner",
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/runner uncovered lines",
      groups,
    ),
    true,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/patterns uncovered lines",
      groups,
    ),
    false,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: workspace uncovered lines",
      groups,
    ),
    false,
  );
  assertEquals(
    shouldGateCoverageDebtMetric(
      "coverage-debt: packages/patterns uncovered lines",
      undefined,
    ),
    true,
  );
});

Deno.test("parseAddedLinesFromPatch maps added lines to their new line numbers", () => {
  const patch = [
    "@@ -1,3 +1,5 @@",
    " const a = 1;",
    "-const b = 2;",
    "+const b = 20;",
    "+const c = 3;",
    " const d = 4;",
    "+const e = 5;",
    "\\ No newline at end of file",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [
    [2, "const b = 20;"],
    [3, "const c = 3;"],
    [5, "const e = 5;"],
  ]);
});

Deno.test("parseAddedLinesFromPatch tracks line numbers across multiple hunks", () => {
  const patch = [
    "@@ -10,2 +10,3 @@",
    " keep;",
    "+added at 11;",
    " keep;",
    "@@ -40,1 +41,2 @@",
    " keep;",
    "+added at 42;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals(added.get(11), "added at 11;");
  assertEquals(added.get(42), "added at 42;");
  assertEquals(added.size, 2);
});

Deno.test("parseAddedLinesFromPatch keeps added lines whose content starts with +", () => {
  const patch = [
    "@@ -1,1 +1,4 @@",
    " context;",
    "+++count;", // added source line "++count;"
    "+ leading-space kept;",
    "+normal;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [
    [2, "++count;"],
    [3, " leading-space kept;"],
    [4, "normal;"],
  ]);
});

Deno.test("parseAddedLinesFromPatch ignores file headers before the first hunk", () => {
  const patch = [
    "diff --git a/f.ts b/f.ts",
    "index 1111111..2222222 100644",
    "--- a/f.ts",
    "+++ b/f.ts",
    "@@ -1,1 +1,2 @@",
    " keep;",
    "+added;",
  ].join("\n");

  const added = parseAddedLinesFromPatch(patch);

  assertEquals([...added.entries()], [[2, "added;"]]);
});

Deno.test("buildCoverageDebtSuggestionComment lists files (not lines), command, and targets", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "packages/runner", target: 12, current: 15 },
    ],
    files: [
      {
        relativePath: "packages/runner/src/cell.ts",
        group: "packages/runner",
        uncoveredCount: 2,
      },
    ],
  });

  // Marker so a later run can detect and update it.
  assertStringIncludes(comment, COVERAGE_SUGGESTION_MARKER);
  // The body is wrapped in an open <details> summarizing the over-by total
  // (15 - 12 = 3 lines), with no standalone header.
  assertStringIncludes(comment, "<details open>");
  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 3 lines</h3></summary>",
  );
  assertStringIncludes(comment, "</details>");
  assertFalse(comment.includes("## 🧪 Test coverage regressed"));
  // The regressed group with its target and current value.
  assertStringIncludes(comment, "`packages/runner`");
  assertStringIncludes(comment, "| 12 | 15 | +3 |");
  // The affected file with its uncovered-line count, but no per-line code dump.
  assertStringIncludes(comment, "`packages/runner/src/cell.ts` — 2 lines");
  // The prompt block still carries the command and the metric target.
  assertStringIncludes(comment, "tasks/coverage-metrics.ts");
  assertStringIncludes(
    comment,
    "coverage-debt: packages/runner uncovered lines  <=  12",
  );
  // The comment ends at the prompt block — no verify/footer sections.
  assertFalse(comment.includes("### Verify locally"));
});

Deno.test("buildCoverageDebtSuggestionComment handles a regression with no pinned lines", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "tasks", target: 0, current: 4 },
    ],
    files: [],
  });

  assertStringIncludes(comment, COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(comment, "Could not tie the regression");
  assertStringIncludes(
    comment,
    "coverage-debt: tasks uncovered lines  <=  0",
  );
});

Deno.test("buildCoverageDebtSuggestionComment sums Over by across groups in the summary", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "packages/runner", target: 12, current: 15 },
      { group: "tasks", target: 4, current: 8 },
    ],
    files: [],
  });

  // 3 + 4 = 7 over baseline.
  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 7 lines</h3></summary>",
  );
});

Deno.test("buildCoverageDebtSuggestionComment uses the singular for a one-line regression", () => {
  const comment = buildCoverageDebtSuggestionComment({
    groups: [
      { group: "tasks", target: 4, current: 5 },
    ],
    files: [],
  });

  assertStringIncludes(
    comment,
    "<summary><h3>🕵🏻‍♀️ Test coverage regressed by 1 line</h3></summary>",
  );
});

Deno.test("buildCoverageResolvedComment collapses the details and summarizes the reduction", () => {
  const resolved = buildCoverageResolvedComment(5, [
    { group: "packages/runner", baseline: 15, current: 12 },
  ]);

  // The disclosure stays collapsed (no `open`) and the summary celebrates the
  // reduction; none of the stale regression copy survives.
  assertFalse(resolved.includes("<details open>"));
  assertStringIncludes(resolved, "<details>");
  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt reduced by 5 lines!</strong></summary>",
  );
  assertFalse(resolved.includes("Test coverage regressed by"));
  assertFalse(resolved.includes("Prompt for an AI coding agent"));
  // The body keeps the marker and summarizes the per-group before-and-after.
  assertStringIncludes(resolved, COVERAGE_SUGGESTION_MARKER);
  assertStringIncludes(
    resolved,
    "| Source group | Baseline (`main`) | This PR | Change |",
  );
  assertStringIncludes(
    resolved,
    "| `packages/runner` | 15 | 12 | 3 lines fewer |",
  );
});

Deno.test("buildCoverageResolvedComment notes resolution when there is no net reduction", () => {
  const resolved = buildCoverageResolvedComment(0, [
    { group: "tasks", baseline: 8, current: 8 },
  ]);

  assertFalse(resolved.includes("<details open>"));
  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage regression resolved.</strong></summary>",
  );
  assertStringIncludes(resolved, "| `tasks` | 8 | 8 | no change |");
});

Deno.test("buildCoverageResolvedComment uses a single line of one uncovered line", () => {
  const resolved = buildCoverageResolvedComment(1, [
    { group: "tasks", baseline: 5, current: 4 },
  ]);

  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt reduced by 1 line!</strong></summary>",
  );
  assertStringIncludes(resolved, "| `tasks` | 5 | 4 | 1 line fewer |");
});

Deno.test("buildCoverageResolvedComment reports a group that gained uncovered lines", () => {
  // A changed group can reach the resolved comment with more uncovered lines
  // than `main` when the regression was accepted with a per-metric override or
  // the coverage reset marker. The table reports the increase rather than
  // hiding it.
  const resolved = buildCoverageResolvedComment(0, [
    { group: "packages/runner", baseline: 12, current: 15 },
  ]);

  assertStringIncludes(
    resolved,
    "| `packages/runner` | 12 | 15 | 3 lines more |",
  );
});

Deno.test("buildCoverageResolvedComment says the debt was overridden, not improved", () => {
  // The gate passed because the debt was accepted, so the summary must not
  // imply the new code is covered, even when a group also improved.
  const resolved = buildCoverageResolvedComment(
    4,
    [{ group: "packages/runner", baseline: 12, current: 15 }],
    true,
  );

  assertStringIncludes(
    resolved,
    "<summary><strong>🕵🏻‍♀️ Code coverage debt accepted with an override.</strong></summary>",
  );
  assertStringIncludes(
    resolved,
    "accepted with an override rather than covered by new tests",
  );
  assertFalse(resolved.includes("Code coverage debt reduced by"));
  assertFalse(resolved.includes("no test reached on"));
  // The table still shows the real per-group numbers.
  assertStringIncludes(
    resolved,
    "| `packages/runner` | 12 | 15 | 3 lines more |",
  );
});

Deno.test("buildCoverageResolvedComment falls back to a sentence with no groups", () => {
  const resolved = buildCoverageResolvedComment(3, []);

  assertStringIncludes(resolved, "<details>");
  assertFalse(resolved.includes("| Source group |"));
  assertStringIncludes(
    resolved,
    "Every changed source group is at or below its `main` baseline",
  );
});

Deno.test("fetchPRBody reads the live pull request body from the GitHub API", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl: string | undefined;
  try {
    globalThis.fetch = ((input, _init) => {
      requestedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ body: "LIVE PR BODY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    assertEquals(await fetchPRBody(3427), "LIVE PR BODY");
    assertEquals(
      requestedUrl,
      "https://api.github.com/repos/commontoolsinc/labs/pulls/3427",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchCurrentPRBody prefers the live pull request body over stale event payloads", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(
        new Response(JSON.stringify({ body: "LIVE PR BODY" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )) as typeof fetch;

    const result = await fetchCurrentPRBody(3427, {
      pull_request: { body: "STALE EVENT BODY" },
    });

    assertEquals(result, { body: "LIVE PR BODY", source: "live" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchCurrentPRBody falls back to the event body if the live request fails", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = ((_input, _init) =>
      Promise.resolve(
        new Response("rate limited", { status: 429 }),
      )) as typeof fetch;

    const result = await fetchCurrentPRBody(3427, {
      pull_request: { body: "EVENT BODY" },
    });

    assertEquals(result.body, "EVENT BODY");
    assertEquals(result.source, "event-fallback");
    assertEquals(
      result.errorMessage?.includes("GitHub API 429:"),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("githubGet retries transient GitHub responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((input, _init) => {
      calls++;
      if (calls < 3) {
        return Promise.resolve(
          new Response("temporary GitHub timeout", {
            status: 504,
            headers: { "retry-after": "0" },
          }),
        );
      }

      const requestedUrl = input instanceof Request ? input.url : String(input);
      return Promise.resolve(
        new Response(JSON.stringify({ ok: requestedUrl }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    assertEquals(
      await githubGet<{ ok: string }>("/repos/commontoolsinc/labs/actions"),
      { ok: "https://api.github.com/repos/commontoolsinc/labs/actions" },
    );
    assertEquals(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("githubGet does not retry non-transient GitHub responses", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((_input, _init) => {
      calls++;
      return Promise.resolve(new Response("not found", { status: 404 }));
    }) as typeof fetch;

    let rejected = false;
    try {
      await githubGet("/repos/commontoolsinc/labs/missing");
    } catch {
      rejected = true;
    }

    assertEquals(rejected, true);
    assertEquals(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchArtifactsForRun reads every artifact page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  const artifact = (id: number, name: string): Artifact => ({
    id,
    name,
    size_in_bytes: 1,
    expired: false,
  });
  try {
    globalThis.fetch = ((input, _init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPages.push(
        `${url.searchParams.get("per_page")}:${url.searchParams.get("page")}`,
      );
      const page = Number(url.searchParams.get("page"));
      const artifacts = page === 1
        ? [artifact(1, "coverage-profile-workspace")]
        : [artifact(2, "coverage-profile-generated-patterns-1")];

      return Promise.resolve(
        new Response(JSON.stringify({ total_count: 2, artifacts }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const artifacts = await fetchArtifactsForRun(123);
    assertEquals(
      artifacts.map((artifact) => artifact.name),
      [
        "coverage-profile-workspace",
        "coverage-profile-generated-patterns-1",
      ],
    );
    assertEquals(requestedPages, ["100:1", "100:2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("fetchPRFiles reads every changed-file page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: string[] = [];
  try {
    globalThis.fetch = ((input, _init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      requestedPages.push(
        `${url.searchParams.get("per_page")}:${url.searchParams.get("page")}`,
      );
      const page = Number(url.searchParams.get("page"));
      const files = page === 1
        ? Array.from({ length: 100 }, (_, index) => ({
          filename: `packages/runner/src/file-${index}.ts`,
        }))
        : [{ filename: "packages/ui/src/card.ts" }];

      return Promise.resolve(
        new Response(JSON.stringify(files), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }) as typeof fetch;

    const files = await fetchPRFiles(123);
    assertEquals(files.length, 101);
    assertEquals(files.at(-1)?.filename, "packages/ui/src/card.ts");
    assertEquals(requestedPages, ["100:1", "100:2"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("downloadAndExtractArtifact retries transient artifact downloads", async () => {
  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  const warnings: string[] = [];
  let calls = 0;
  try {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "));
    };
    globalThis.fetch = ((_input, _init) => {
      calls++;
      if (calls < 4) {
        return Promise.resolve(
          new Response("temporary artifact backend error", {
            status: 503,
            headers: { "retry-after": "0" },
          }),
        );
      }
      return Promise.resolve(new Response("gone", { status: 410 }));
    }) as typeof fetch;

    assertEquals(await downloadAndExtractArtifact(123, "artifact-test-"), null);
    assertEquals(calls, 4);
    assertEquals(
      warnings.some((warning) =>
        warning.includes("GitHub artifact download 410")
      ),
      true,
    );
    assertEquals(
      warnings.some((warning) =>
        warning.includes("attempt 1: GitHub artifact download 503") &&
        warning.includes("attempt 4: GitHub artifact download 410")
      ),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
  }
});

Deno.test("newestArtifactsByName keeps the latest re-run upload per name", () => {
  const artifact = (id: number, name: string): Artifact => ({
    id,
    name,
    size_in_bytes: 1,
    expired: false,
  });
  // API order is newest-first; a naive last-write-wins iteration would let
  // the stale attempt-1 artifact shadow the re-run's upload.
  const result = newestArtifactsByName([
    artifact(200, "test-timing-pattern-unit-4"),
    artifact(150, "test-timing-pattern-unit-1"),
    artifact(100, "test-timing-pattern-unit-4"),
  ]);
  assertEquals(
    result.map((a) => [a.name, a.id]).sort(),
    [
      ["test-timing-pattern-unit-1", 150],
      ["test-timing-pattern-unit-4", 200],
    ],
  );
});
