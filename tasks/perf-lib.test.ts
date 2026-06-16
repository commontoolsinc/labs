import { assertAlmostEquals, assertEquals } from "@std/assert";
import {
  type Artifact,
  computeBaseline,
  computeCiWallTimeRevisitSignals,
  extractMetrics,
  fetchCurrentPRBody,
  fetchPRBody,
  githubGet,
  type Job,
  newestArtifactsByName,
  parsePerfMetricsBackfillFile,
  parsePerfMetricsFile,
  serializePerfMetrics,
  serializePerfMetricsBackfill,
  type Step,
  timingArtifactLabel,
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
      "Runner Tests (1/4)",
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
      "Runner Tests (2/4)",
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
    metrics.get("job: Runner Tests (1/4)")?.durationSeconds,
    100,
  );
  assertEquals(
    metrics.get("job: Runner Tests (2/4)")?.durationSeconds,
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
      "Runner Tests (1/4)",
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
      "Runner Tests (1/4)",
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
