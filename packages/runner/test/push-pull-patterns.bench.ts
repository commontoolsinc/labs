/**
 * Push vs pull benchmarks using real patterns and list builtins.
 *
 * These benches go through createBuilder() + runtime.run() so they exercise the
 * actual map/filter/flatMap machinery instead of synthetic scheduler actions.
 */
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import {
  getTimingStatsBreakdown,
  resetAllTimingBaselines,
  resetAllTimingStats,
  setGlobalLogFloor,
  type TimingStats,
} from "@commontools/utils/logger";
import { createBuilder } from "../src/builder/factory.ts";
import type { Cell, JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("bench push pull patterns");
const space = signer.did();

setGlobalLogFloor("error");

const LIST_SIZE = 64;
const UPDATE_ROUNDS = 12;
const SINK_ROUNDS = 20;
const TARGET_INDEX = Math.floor(LIST_SIZE / 2);
const FANOUT_WIDTH = 48;
const FANOUT_UPDATE_ROUNDS = 8;
const FANOUT_LIVE_SINKS = 24;
const FANOUT_SPARSE_PULLS = 4;
const FANOUT_WIDE_PULLS = 12;

const numberSchema = {
  type: "number",
} as const satisfies JSONSchema;

const booleanSchema = {
  type: "boolean",
} as const satisfies JSONSchema;

const numberArraySchema = {
  type: "array",
  items: numberSchema,
} as const satisfies JSONSchema;

const numberElementArgumentSchema = {
  type: "object",
  properties: {
    element: numberSchema,
  },
  required: ["element"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const numberListInputSchema = {
  type: "object",
  properties: {
    values: numberArraySchema,
  },
  required: ["values"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const scalarInputSchema = {
  type: "object",
  properties: {
    value: numberSchema,
  },
  required: ["value"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const mappedResultSchema = {
  type: "object",
  properties: {
    mapped: numberArraySchema,
  },
  required: ["mapped"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const filteredResultSchema = {
  type: "object",
  properties: {
    filtered: numberArraySchema,
  },
  required: ["filtered"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const flatMappedResultSchema = {
  type: "object",
  properties: {
    flat: numberArraySchema,
  },
  required: ["flat"],
  additionalProperties: false,
} as const satisfies JSONSchema;

const scalarResultSchema = {
  type: "object",
  properties: {
    result: numberSchema,
  },
  required: ["result"],
  additionalProperties: false,
} as const satisfies JSONSchema;

let blackhole = 0;

type BenchEnv = {
  runtime: Runtime;
  storageManager: ReturnType<typeof StorageManager.emulate>;
  lift: ReturnType<typeof createBuilder>["commontools"]["lift"];
  pattern: ReturnType<typeof createBuilder>["commontools"]["pattern"];
};

type ListScenario = {
  targetCell: Cell<number>;
  outputCell: Cell<number[]>;
};

type FanoutScenario = {
  targetCell: Cell<number>;
  outputCells: Cell<number>[];
  sinkCancels: Array<() => void>;
};

type TimingDelta = {
  count: number;
  totalTime: number;
  average: number;
  min: number;
  p50: number;
  p95: number;
  max: number;
};

type BenchTimingSummary = {
  execute?: TimingDelta;
  run?: TimingDelta;
  runAction?: TimingDelta;
  depCollect?: TimingDelta;
  collectDirty?: TimingDelta;
  dirtyScan?: TimingDelta;
  writerLookup?: TimingDelta;
  scheduleAffectedEffects?: TimingDelta;
};

const benchTimingSummaries = new Map<string, BenchTimingSummary>();

function benchOptions(group: string, baseline: boolean) {
  return {
    group,
    baseline,
    n: 1,
    warmup: 0,
  } as const;
}

function snapshotSchedulerTiming(): Record<string, TimingStats> {
  return getTimingStatsBreakdown().scheduler ?? {};
}

function percentileFromCDF(
  cdf: Array<{ x: number; y: number }> | null | undefined,
  percentile: number,
): number {
  if (!cdf || cdf.length === 0) return 0;
  return cdf.find((point) => point.y >= percentile)?.x ??
    cdf[cdf.length - 1].x;
}

function extractTimingDelta(
  before: Record<string, TimingStats>,
  after: Record<string, TimingStats>,
  key: string,
): TimingDelta | undefined {
  const afterStat = after[key];
  if (!afterStat) return undefined;

  const beforeStat = before[key];
  const count = afterStat.count - (beforeStat?.count ?? 0);
  const totalTime = afterStat.totalTime - (beforeStat?.totalTime ?? 0);
  if (count <= 0 || totalTime < 0) return undefined;

  const cdf = afterStat.cdfSinceBaseline ?? afterStat.cdf;
  return {
    count,
    totalTime,
    average: totalTime / count,
    min: cdf[0]?.x ?? afterStat.min,
    p50: percentileFromCDF(cdf, 0.5),
    p95: percentileFromCDF(cdf, 0.95),
    max: cdf[cdf.length - 1]?.x ?? afterStat.max,
  };
}

function recordSchedulerTimingSummary(
  benchmarkName: string,
  before: Record<string, TimingStats>,
  after: Record<string, TimingStats>,
) {
  const summary = {
    execute: extractTimingDelta(before, after, "scheduler/execute"),
    run: extractTimingDelta(before, after, "scheduler/run"),
    runAction: extractTimingDelta(before, after, "scheduler/run/action"),
    depCollect: extractTimingDelta(
      before,
      after,
      "scheduler/execute/depCollect",
    ),
    collectDirty: extractTimingDelta(
      before,
      after,
      "scheduler/execute/collectDirtyDependencies",
    ),
    dirtyScan: extractTimingDelta(
      before,
      after,
      "scheduler/execute/collectDirtyDependencies/dirtyScan",
    ),
    writerLookup: extractTimingDelta(
      before,
      after,
      "scheduler/execute/collectDirtyDependencies/writerLookup",
    ),
    scheduleAffectedEffects: extractTimingDelta(
      before,
      after,
      "scheduler/scheduleAffectedEffects",
    ),
  } satisfies BenchTimingSummary;

  const currentWeight = (summary.execute?.totalTime ?? 0) +
    (summary.run?.totalTime ?? 0) +
    (summary.scheduleAffectedEffects?.totalTime ?? 0);
  const previous = benchTimingSummaries.get(benchmarkName);
  const previousWeight = previous
    ? (previous.execute?.totalTime ?? 0) +
      (previous.run?.totalTime ?? 0) +
      (previous.scheduleAffectedEffects?.totalTime ?? 0)
    : -1;

  if (currentWeight >= previousWeight) {
    benchTimingSummaries.set(benchmarkName, summary);
  }
}

function formatMs(value: number | undefined): string {
  if (value === undefined) return "n/a";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  if (value >= 100) return `${value.toFixed(0)}ms`;
  if (value >= 10) return `${value.toFixed(1)}ms`;
  return `${value.toFixed(2)}ms`;
}

function formatTimingDelta(label: string, delta?: TimingDelta): string | null {
  if (!delta) return null;
  return `${label}: x${delta.count}, total ${formatMs(delta.totalTime)}, avg ${
    formatMs(delta.average)
  }, p50 ${formatMs(delta.p50)}, p95 ${formatMs(delta.p95)}, max ${
    formatMs(delta.max)
  }`;
}

addEventListener("unload", () => {
  if (benchTimingSummaries.size === 0) return;

  console.log("\nScheduler timing summaries:");
  for (const [benchmarkName, summary] of benchTimingSummaries) {
    const executeTotal = summary.execute?.totalTime ?? 0;
    const runTotal = summary.run?.totalTime ?? 0;
    const actionTotal = summary.runAction?.totalTime ?? 0;
    const externalScheduling = Math.max(0, executeTotal - runTotal);
    const runWrapper = Math.max(0, runTotal - actionTotal);

    console.log(`- ${benchmarkName}`);
    console.log(
      `  scheduling vs compute: execute ${formatMs(executeTotal)}, run ${
        formatMs(runTotal)
      }, run/action ${formatMs(actionTotal)}, outside-run overhead ${
        formatMs(externalScheduling)
      }, in-run wrapper ${formatMs(runWrapper)}`,
    );

    for (
      const line of [
        formatTimingDelta("depCollect", summary.depCollect),
        formatTimingDelta("collectDirtyDependencies", summary.collectDirty),
        formatTimingDelta("dirtyScan", summary.dirtyScan),
        formatTimingDelta("writerLookup", summary.writerLookup),
        formatTimingDelta(
          "scheduleAffectedEffects",
          summary.scheduleAffectedEffects,
        ),
      ]
    ) {
      if (line) console.log(`  ${line}`);
    }
  }
});

function createEnv(pullMode: boolean): BenchEnv {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
  });

  if (pullMode) runtime.scheduler.enablePullMode();
  else runtime.scheduler.disablePullMode();

  const { commontools } = createBuilder();
  const { lift, pattern } = commontools;

  return { runtime, storageManager, lift, pattern };
}

async function cleanup(env: BenchEnv) {
  await env.runtime.dispose();
  await env.storageManager.close();
}

function unaryNumberListOpPattern(
  env: BenchEnv,
  fn: (element: unknown) => unknown,
  resultSchema: JSONSchema,
) {
  return env.pattern<{ element: number }, unknown>(
    ({ element }) => fn(element),
    numberElementArgumentSchema,
    resultSchema,
  );
}

async function createNumberCells(
  runtime: Runtime,
  prefix: string,
  size: number,
  valueAt: (index: number) => number,
): Promise<Cell<number>[]> {
  const tx = runtime.edit();
  const cells: Cell<number>[] = [];

  for (let i = 0; i < size; i++) {
    const cell = runtime.getCell<number>(
      space,
      `${prefix}:item:${i}`,
      numberSchema,
      tx,
    );
    cell.set(valueAt(i));
    cells.push(cell);
  }

  await tx.commit();
  return cells;
}

async function setNumber(runtime: Runtime, cell: Cell<number>, value: number) {
  const tx = runtime.edit();
  cell.withTx(tx).set(value);
  await tx.commit();
}

function consumeArray(value: readonly number[] | undefined) {
  if (!value) return;
  blackhole = (blackhole + value.length + (value[value.length - 1] ?? 0)) | 0;
}

function consumeNumber(value: number | undefined) {
  blackhole = (blackhole + (value ?? 0)) | 0;
}

function takeFirst<T>(values: T[], count: number): T[] {
  return values.slice(0, Math.min(count, values.length));
}

function takeLast<T>(values: T[], count: number): T[] {
  if (count <= 0) return [];
  return values.slice(Math.max(0, values.length - count));
}

async function setupMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => index + 1,
  );

  const double = env.lift(numberSchema, numberSchema, (x: number) => x * 2);
  const doublePattern = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => double(element as any),
    numberSchema,
  );

  const mapPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      mapped: values.mapWithPattern(doublePattern as any, {}),
    }),
    numberListInputSchema,
    mappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ mapped: number[] }>(
    space,
    `${prefix}:result`,
    mappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, mapPattern, { values }, resultCell);
  await tx.commit();

  return {
    targetCell: values[TARGET_INDEX],
    outputCell: result.key("mapped") as Cell<number[]>,
  };
}

async function setupFilterScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? -1 : index + 1),
  );

  const isPositive = env.lift(
    numberSchema,
    booleanSchema,
    (x: number) => x > 0,
  );
  const filterPatternFn = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => isPositive(element as any),
    booleanSchema,
  );

  const filterPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      filtered: values.filterWithPattern(filterPatternFn as any, {}),
    }),
    numberListInputSchema,
    filteredResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ filtered: number[] }>(
    space,
    `${prefix}:result`,
    filteredResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, filterPattern, { values }, resultCell);
  await tx.commit();

  return {
    targetCell: values[TARGET_INDEX],
    outputCell: result.key("filtered") as Cell<number[]>,
  };
}

async function setupFlatMapScenario(
  env: BenchEnv,
  prefix: string,
): Promise<ListScenario> {
  const values = await createNumberCells(
    env.runtime,
    `${prefix}:values`,
    LIST_SIZE,
    (index) => (index === TARGET_INDEX ? 0 : index + 1),
  );

  const expand = env.lift(
    numberSchema,
    numberArraySchema,
    (x: number) => (x > 0 ? [x, x * 10] : []),
  );
  const flatMapPatternFn = unaryNumberListOpPattern(
    env,
    // deno-lint-ignore no-explicit-any
    (element) => expand(element as any),
    numberArraySchema,
  );

  const flatMapPattern = env.pattern<{ values: number[] }>(
    ({ values }) => ({
      // deno-lint-ignore no-explicit-any
      flat: values.flatMapWithPattern(flatMapPatternFn as any, {}),
    }),
    numberListInputSchema,
    flatMappedResultSchema,
  );

  const tx = env.runtime.edit();
  const resultCell = env.runtime.getCell<{ flat: number[] }>(
    space,
    `${prefix}:result`,
    flatMappedResultSchema,
    tx,
  );
  const result = env.runtime.run(tx, flatMapPattern, { values }, resultCell);
  await tx.commit();

  return {
    targetCell: values[TARGET_INDEX],
    outputCell: result.key("flat") as Cell<number[]>,
  };
}

async function setupFanoutScenario(
  env: BenchEnv,
  prefix: string,
): Promise<FanoutScenario> {
  const tx = env.runtime.edit();
  const inputCell = env.runtime.getCell<{ value: number }>(
    space,
    `${prefix}:input`,
    scalarInputSchema,
    tx,
  );
  inputCell.set({ value: 1 });

  const outputCells: Cell<number>[] = [];

  for (let i = 0; i < FANOUT_WIDTH; i++) {
    const derive = env.lift(
      numberSchema,
      numberSchema,
      (value: number) => value + i + 1,
    );
    const derivePattern = env.pattern<{ value: number }>(
      ({ value }) => ({
        result: derive(value),
      }),
      scalarInputSchema,
      scalarResultSchema,
    );

    const resultCell = env.runtime.getCell<{ result: number }>(
      space,
      `${prefix}:result:${i}`,
      scalarResultSchema,
      tx,
    );
    const result = env.runtime.run(tx, derivePattern, inputCell, resultCell);
    outputCells.push(result.key("result") as Cell<number>);
  }

  await tx.commit();

  return {
    targetCell: inputCell.key("value") as Cell<number>,
    outputCells,
    sinkCancels: [],
  };
}

async function runPullBench(
  b: Deno.BenchContext,
  options: {
    pullMode: boolean;
    setupScenario: (env: BenchEnv, prefix: string) => Promise<ListScenario>;
    prefix: string;
    nextValue: (round: number) => number;
    rounds?: number;
  },
) {
  const env = createEnv(options.pullMode);

  try {
    resetAllTimingStats();
    const scenario = await options.setupScenario(env, options.prefix);
    consumeArray(await scenario.outputCell.pull());
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    b.start();
    for (let i = 0; i < (options.rounds ?? UPDATE_ROUNDS); i++) {
      await setNumber(env.runtime, scenario.targetCell, options.nextValue(i));
      consumeArray(await scenario.outputCell.pull());
    }
    b.end();

    recordSchedulerTimingSummary(
      b.name,
      timingBefore,
      snapshotSchedulerTiming(),
    );
  } finally {
    await cleanup(env);
  }
}

async function runSinkBench(
  b: Deno.BenchContext,
  options: {
    pullMode: boolean;
    setupScenario: (env: BenchEnv, prefix: string) => Promise<ListScenario>;
    prefix: string;
    nextValue: (round: number) => number;
    rounds?: number;
  },
) {
  const env = createEnv(options.pullMode);

  try {
    resetAllTimingStats();
    const scenario = await options.setupScenario(env, options.prefix);
    const cancel = scenario.outputCell.sink((value) => {
      consumeArray(value);
    });
    await env.runtime.idle();
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    try {
      b.start();
      for (let i = 0; i < (options.rounds ?? SINK_ROUNDS); i++) {
        await setNumber(env.runtime, scenario.targetCell, options.nextValue(i));
        await env.runtime.idle();
      }
      b.end();
      recordSchedulerTimingSummary(
        b.name,
        timingBefore,
        snapshotSchedulerTiming(),
      );
    } finally {
      cancel();
    }
  } finally {
    await cleanup(env);
  }
}

async function runFanoutBench(
  b: Deno.BenchContext,
  options: {
    pullMode: boolean;
    prefix: string;
    liveSinkCount: number;
    pulledOutputCount: number;
    rounds?: number;
  },
) {
  const env = createEnv(options.pullMode);

  try {
    resetAllTimingStats();
    const scenario = await setupFanoutScenario(env, options.prefix);
    const liveOutputs = takeFirst(scenario.outputCells, options.liveSinkCount);
    const pulledOutputs = takeLast(
      scenario.outputCells,
      options.pulledOutputCount,
    );

    scenario.sinkCancels = liveOutputs.map((output) =>
      output.sink((value) => {
        consumeNumber(value);
      })
    );

    if (scenario.sinkCancels.length > 0) {
      await env.runtime.idle();
    }
    for (const output of pulledOutputs) {
      consumeNumber(await output.pull());
    }
    resetAllTimingBaselines();
    const timingBefore = snapshotSchedulerTiming();

    try {
      b.start();
      for (let i = 0; i < (options.rounds ?? FANOUT_UPDATE_ROUNDS); i++) {
        await setNumber(env.runtime, scenario.targetCell, i + 2);
        if (scenario.sinkCancels.length > 0) {
          await env.runtime.idle();
        }
        for (const output of pulledOutputs) {
          consumeNumber(await output.pull());
        }
      }
      b.end();
      recordSchedulerTimingSummary(
        b.name,
        timingBefore,
        snapshotSchedulerTiming(),
      );
    } finally {
      for (const cancel of scenario.sinkCancels) cancel();
    }
  } finally {
    await cleanup(env);
  }
}

for (const pullMode of [false, true]) {
  const mode = pullMode ? "pull" : "push";

  Deno.bench(
    `Pattern push vs pull - mapWithPattern single element update + pull [${mode}]`,
    benchOptions("pattern-map-pull", !pullMode),
    async (b) => {
      await runPullBench(b, {
        pullMode,
        prefix: `bench:map:pull:${mode}`,
        setupScenario: setupMapScenario,
        nextValue: (round) => LIST_SIZE + round + 1,
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - filterWithPattern membership flip + pull [${mode}]`,
    benchOptions("pattern-filter-pull", !pullMode),
    async (b) => {
      await runPullBench(b, {
        pullMode,
        prefix: `bench:filter:pull:${mode}`,
        setupScenario: setupFilterScenario,
        nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : -1),
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - flatMapWithPattern expansion flip + pull [${mode}]`,
    benchOptions("pattern-flatmap-pull", !pullMode),
    async (b) => {
      await runPullBench(b, {
        pullMode,
        prefix: `bench:flatmap:pull:${mode}`,
        setupScenario: setupFlatMapScenario,
        nextValue: (round) => (round % 2 === 0 ? TARGET_INDEX + 1 : 0),
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - mapWithPattern single element update + sink [${mode}]`,
    benchOptions("pattern-map-sink", !pullMode),
    async (b) => {
      await runSinkBench(b, {
        pullMode,
        prefix: `bench:map:sink:${mode}`,
        setupScenario: setupMapScenario,
        nextValue: (round) => LIST_SIZE + round + 1,
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - fanout ${FANOUT_WIDTH}, pull ${FANOUT_SPARSE_PULLS} [${mode}]`,
    benchOptions("pattern-fanout-pull-sparse", !pullMode),
    async (b) => {
      await runFanoutBench(b, {
        pullMode,
        prefix: `bench:fanout:pull-sparse:${mode}`,
        liveSinkCount: 0,
        pulledOutputCount: FANOUT_SPARSE_PULLS,
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - fanout ${FANOUT_WIDTH}, pull ${FANOUT_WIDE_PULLS} [${mode}]`,
    benchOptions("pattern-fanout-pull-wide", !pullMode),
    async (b) => {
      await runFanoutBench(b, {
        pullMode,
        prefix: `bench:fanout:pull-wide:${mode}`,
        liveSinkCount: 0,
        pulledOutputCount: FANOUT_WIDE_PULLS,
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - fanout ${FANOUT_WIDTH}, sink ${FANOUT_LIVE_SINKS} [${mode}]`,
    benchOptions("pattern-fanout-sinks", !pullMode),
    async (b) => {
      await runFanoutBench(b, {
        pullMode,
        prefix: `bench:fanout:sinks:${mode}`,
        liveSinkCount: FANOUT_LIVE_SINKS,
        pulledOutputCount: 0,
      });
    },
  );

  Deno.bench(
    `Pattern push vs pull - fanout ${FANOUT_WIDTH}, sink ${FANOUT_LIVE_SINKS} + pull ${FANOUT_SPARSE_PULLS} [${mode}]`,
    benchOptions("pattern-fanout-mixed", !pullMode),
    async (b) => {
      await runFanoutBench(b, {
        pullMode,
        prefix: `bench:fanout:mixed:${mode}`,
        liveSinkCount: FANOUT_LIVE_SINKS,
        pulledOutputCount: FANOUT_SPARSE_PULLS,
      });
    },
  );
}
