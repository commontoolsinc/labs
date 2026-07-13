import { assertAlmostEquals, assertEquals, assertThrows } from "@std/assert";
import {
  type CPUProfile,
  deltaWorkerPerformanceMetrics,
  parseWorkerPerformanceMetrics,
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

Deno.test("parseWorkerPerformanceMetrics extracts cumulative worker CPU counters", () => {
  assertEquals(
    parseWorkerPerformanceMetrics({
      metrics: [
        { name: "Timestamp", value: 123.5 },
        { name: "ScriptDuration", value: 0.125 },
        { name: "TaskDuration", value: 0.375 },
        { name: "LayoutDuration", value: 99 },
      ],
    }),
    {
      taskDurationSeconds: 0.375,
      scriptDurationSeconds: 0.125,
    },
  );
});

Deno.test("parseWorkerPerformanceMetrics rejects unavailable or invalid counters", () => {
  assertThrows(
    () => parseWorkerPerformanceMetrics({}),
    Error,
    "metrics array",
  );
  assertThrows(
    () =>
      parseWorkerPerformanceMetrics({
        metrics: [{ name: "TaskDuration", value: 1 }],
      }),
    Error,
    "missing required ScriptDuration",
  );
  assertThrows(
    () =>
      parseWorkerPerformanceMetrics({
        metrics: [
          { name: "TaskDuration", value: -1 },
          { name: "ScriptDuration", value: 1 },
        ],
      }),
    Error,
    "invalid TaskDuration",
  );
  assertThrows(
    () =>
      parseWorkerPerformanceMetrics({
        metrics: [
          { name: "TaskDuration", value: 1 },
          { name: "TaskDuration", value: 2 },
          { name: "ScriptDuration", value: 1 },
        ],
      }),
    Error,
    "duplicate TaskDuration",
  );
});

Deno.test("deltaWorkerPerformanceMetrics returns monotonic CPU deltas in microseconds", () => {
  const delta = deltaWorkerPerformanceMetrics(
    { taskDurationSeconds: 10.25, scriptDurationSeconds: 4.125 },
    { taskDurationSeconds: 10.375, scriptDurationSeconds: 4.175 },
  );

  assertAlmostEquals(delta.taskDurationUs, 125_000);
  assertAlmostEquals(delta.scriptDurationUs, 50_000);
});

Deno.test("deltaWorkerPerformanceMetrics rejects reset worker counters", () => {
  assertThrows(
    () =>
      deltaWorkerPerformanceMetrics(
        { taskDurationSeconds: 2, scriptDurationSeconds: 1 },
        { taskDurationSeconds: 1, scriptDurationSeconds: 0.5 },
      ),
    Error,
    "TaskDuration decreased",
  );
});
