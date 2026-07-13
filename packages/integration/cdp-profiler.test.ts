import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  analyzeCounterbalancedRendererCpu,
  assertCounterbalancedRendererCpu,
  type CPUProfile,
  deltaRendererProcessCpu,
  parseBrowserProcessMetrics,
  parseCpuBenchmarkEventCount,
  summarizeCPUProfile,
} from "./cdp-profiler.ts";

const profile = (
  overrides: Partial<CPUProfile> = {},
): CPUProfile => ({
  nodes: [
    {
      id: 1,
      callFrame: {
        functionName: "(idle)",
        url: "",
        lineNumber: 0,
      },
    },
    {
      id: 2,
      callFrame: {
        functionName: "runAction",
        url: "worker-runtime.js",
        lineNumber: 10,
      },
    },
    {
      id: 3,
      callFrame: {
        functionName: "(garbage collector)",
        url: "",
        lineNumber: 0,
      },
    },
    {
      id: 4,
      callFrame: {
        functionName: "(program)",
        url: "",
        lineNumber: 0,
      },
    },
  ],
  startTime: 1_000,
  endTime: 3_000,
  ...overrides,
});

Deno.test("summarizeCPUProfile separates worker busy samples from V8 idle samples", () => {
  const summary = summarizeCPUProfile(profile({
    samples: [1, 2, 3, 1, 4, 999],
    timeDeltas: [100, 200, 300, 400, 250, 500],
  }));

  assertEquals(summary, {
    wallUs: 2_000,
    sampledUs: 1_750,
    idleUs: 500,
    programUs: 250,
    attributedWorkUs: 500,
    busyUs: 1_250,
    busyFraction: 5 / 7,
  });
});

Deno.test("summarizeCPUProfile treats GC and unknown sample ids as busy", () => {
  const summary = summarizeCPUProfile(profile({
    samples: [3, 999],
    timeDeltas: [125, 375],
  }));

  assertEquals(summary.busyUs, 500);
  assertEquals(summary.idleUs, 0);
  assertEquals(summary.programUs, 0);
  assertEquals(summary.attributedWorkUs, 125);
  assertEquals(summary.busyFraction, 1);
});

Deno.test("summarizeCPUProfile handles profiles without samples", () => {
  const summary = summarizeCPUProfile(profile({
    samples: undefined,
    timeDeltas: undefined,
  }));

  assertEquals(summary, {
    wallUs: 2_000,
    sampledUs: 0,
    idleUs: 0,
    programUs: 0,
    attributedWorkUs: 0,
    busyUs: 0,
    busyFraction: 0,
  });
});

Deno.test("summarizeCPUProfile ignores missing and invalid sample deltas", () => {
  const summary = summarizeCPUProfile(profile({
    samples: [1, 2, 2, 2],
    timeDeltas: [100, Number.NaN, -50],
  }));

  assertEquals(summary, {
    wallUs: 2_000,
    sampledUs: 100,
    idleUs: 100,
    programUs: 0,
    attributedWorkUs: 0,
    busyUs: 0,
    busyFraction: 0,
  });
});

Deno.test("summarizeCPUProfile clamps an invalid wall interval", () => {
  const summary = summarizeCPUProfile(profile({
    startTime: 5_000,
    endTime: 4_000,
    samples: [2],
    timeDeltas: [250],
  }));

  assertEquals(summary.wallUs, 0);
  assertEquals(summary.busyUs, 250);
  assertEquals(summary.attributedWorkUs, 250);
});

Deno.test("summarizeCPUProfile separates ambiguous program samples from attributed work", () => {
  const summary = summarizeCPUProfile(profile({
    samples: [4, 2, 3, 999],
    timeDeltas: [600, 200, 100, 400],
  }));

  assertEquals(summary.programUs, 600);
  // Unknown node ids are not evidence of attributed JavaScript/GC work.
  assertEquals(summary.attributedWorkUs, 300);
  assertEquals(summary.busyUs, 1_300);
});

Deno.test("parseBrowserProcessMetrics extracts deterministic cumulative process counters", () => {
  assertEquals(
    parseBrowserProcessMetrics({
      processInfo: [
        { type: "renderer", id: 42, cpuTime: 0.375 },
        { type: "browser", id: 7, cpuTime: 1.25 },
      ],
    }),
    {
      processes: [
        { type: "browser", id: 7, cpuTimeSeconds: 1.25 },
        { type: "renderer", id: 42, cpuTimeSeconds: 0.375 },
      ],
    },
  );
});

Deno.test("parseBrowserProcessMetrics rejects unavailable or invalid counters", () => {
  assertThrows(
    () => parseBrowserProcessMetrics({}),
    Error,
    "processInfo array",
  );
  assertThrows(
    () =>
      parseBrowserProcessMetrics({
        processInfo: [{ type: "renderer", id: -1, cpuTime: 1 }],
      }),
    Error,
    "invalid process id",
  );
  assertThrows(
    () =>
      parseBrowserProcessMetrics({
        processInfo: [
          { type: "renderer", id: 1, cpuTime: Number.NaN },
        ],
      }),
    Error,
    "invalid cpuTime",
  );
  assertThrows(
    () =>
      parseBrowserProcessMetrics({
        processInfo: [
          { type: "renderer", id: 1, cpuTime: 1 },
          { type: "renderer", id: 1, cpuTime: 2 },
        ],
      }),
    Error,
    "duplicate process id 1",
  );
  assertThrows(
    () =>
      parseBrowserProcessMetrics({
        processInfo: [{ type: "browser", id: 1, cpuTime: 1 }],
      }),
    Error,
    "no renderer process",
  );
});

Deno.test("deltaRendererProcessCpu matches renderer ids and sums CPU deltas", () => {
  const delta = deltaRendererProcessCpu(
    {
      processes: [
        { type: "browser", id: 7, cpuTimeSeconds: 100 },
        { type: "renderer", id: 42, cpuTimeSeconds: 10.25 },
        { type: "renderer", id: 43, cpuTimeSeconds: 4.125 },
      ],
    },
    {
      processes: [
        { type: "browser", id: 7, cpuTimeSeconds: 101 },
        { type: "renderer", id: 42, cpuTimeSeconds: 10.375 },
        { type: "renderer", id: 43, cpuTimeSeconds: 4.175 },
      ],
    },
  );

  assertAlmostEquals(delta.totalCpuTimeUs, 175_000);
  assertEquals(delta.renderers.map(({ id }) => id), [42, 43]);
  assertAlmostEquals(delta.renderers[0]!.cpuTimeUs, 125_000);
  assertAlmostEquals(delta.renderers[1]!.cpuTimeUs, 50_000);
  assertEquals(
    delta.renderers.map(({ startedDuringMeasurement }) =>
      startedDuringMeasurement
    ),
    [false, false],
  );
});

Deno.test("deltaRendererProcessCpu rejects renderer churn and reset counters", () => {
  assertThrows(
    () =>
      deltaRendererProcessCpu(
        {
          processes: [{ type: "renderer", id: 1, cpuTimeSeconds: 2 }],
        },
        {
          processes: [{ type: "renderer", id: 1, cpuTimeSeconds: 1 }],
        },
      ),
    Error,
    "renderer process 1 CPU time decreased",
  );
  assertThrows(
    () =>
      deltaRendererProcessCpu(
        {
          processes: [{ type: "renderer", id: 1, cpuTimeSeconds: 2 }],
        },
        {
          processes: [{ type: "renderer", id: 2, cpuTimeSeconds: 3 }],
        },
      ),
    Error,
    "renderer process 1 disappeared",
  );
});

Deno.test("deltaRendererProcessCpu rejects newly started renderers", () => {
  assertThrows(
    () =>
      deltaRendererProcessCpu(
        {
          processes: [{ type: "renderer", id: 1, cpuTimeSeconds: 2 }],
        },
        {
          processes: [
            { type: "renderer", id: 1, cpuTimeSeconds: 3 },
            { type: "renderer", id: 2, cpuTimeSeconds: 0.5 },
          ],
        },
      ),
    Error,
    "renderer process 2 started during measurement",
  );
});

Deno.test("parseCpuBenchmarkEventCount accepts only bounded canonical integers", () => {
  assertEquals(parseCpuBenchmarkEventCount(undefined), 500);
  assertEquals(parseCpuBenchmarkEventCount("500"), 500);
  assertEquals(parseCpuBenchmarkEventCount("2000"), 2_000);
  for (
    const value of [
      "",
      "0",
      "499",
      "2001",
      "500.5",
      "Infinity",
      "500events",
      " 500",
      "500 ",
      "0500",
    ]
  ) {
    assertThrows(
      () => parseCpuBenchmarkEventCount(value),
      Error,
      "CF_SERVER_EXECUTION_CPU_EVENTS",
    );
  }
});

Deno.test("counterbalanced renderer CPU maps ABBA and BAAB phases exactly", () => {
  const analysis = analyzeCounterbalancedRendererCpu([
    100,
    104,
    106,
    100,
    105,
    100,
    100,
    105,
  ]);
  assertEquals(analysis.abba.disabledMeanUsPerEvent, 100);
  assertEquals(analysis.abba.enabledMeanUsPerEvent, 105);
  assertEquals(analysis.abba.enabledToDisabledRatio, 1.05);
  assertEquals(analysis.baab.disabledMeanUsPerEvent, 100);
  assertEquals(analysis.baab.enabledMeanUsPerEvent, 105);
  assertEquals(analysis.baab.enabledToDisabledRatio, 1.05);
  assertEquals(analysis.combined.disabledMeanUsPerEvent, 100);
  assertEquals(analysis.combined.enabledMeanUsPerEvent, 105);
  assertEquals(analysis.combined.enabledToDisabledRatio, 1.05);
});

Deno.test("counterbalanced renderer CPU rejects regression and noisy replicates", () => {
  assertThrows(
    () =>
      assertCounterbalancedRendererCpu([
        100,
        112,
        112,
        100,
        112,
        100,
        100,
        112,
      ]),
    Error,
    "exceeded 1.1",
  );
  assertThrows(
    () =>
      assertCounterbalancedRendererCpu([
        100,
        100,
        100,
        116,
        100,
        100,
        116,
        100,
      ]),
    Error,
    "inconclusive/noisy",
  );
  assertThrows(
    () => analyzeCounterbalancedRendererCpu([100, 100]),
    Error,
    "exactly eight",
  );
  assertThrows(
    () =>
      analyzeCounterbalancedRendererCpu([
        100,
        100,
        100,
        100,
        100,
        Number.NaN,
        100,
        100,
      ]),
    Error,
    "positive finite",
  );
});
