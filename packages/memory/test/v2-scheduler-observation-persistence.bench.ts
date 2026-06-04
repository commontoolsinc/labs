import { toFileUrl } from "@std/path";
import type { URI } from "../interface.ts";
import {
  applyCommit,
  close,
  type Engine,
  open,
  type SchedulerActionObservation,
  type SchedulerObservationAddress,
} from "../v2/engine.ts";

const RUN_COUNT = readIntEnv("SCHEDULER_OBSERVATION_BENCH_RUNS", 500, 1);
const NOOP_BATCH_SIZE = readIntEnv(
  "SCHEDULER_OBSERVATION_BENCH_NOOP_BATCH_SIZE",
  50,
  1,
);
const PATH_COUNTS = readIntListEnv(
  "SCHEDULER_OBSERVATION_BENCH_PATHS",
  [1, 25],
);

const space = "did:key:z6Mk-memory-v2-scheduler-observation-persistence";
const branch = "";
const pieceId = "of:scheduler-observation-persistence-piece";
const processGeneration = 1;

type BenchmarkMetric = {
  runs: number;
  pathCount: number;
  activeSqliteBytes: number;
  bytesPerRun: number;
  commits: number;
  revisions: number;
  schedulerObservations: number;
  schedulerObservationReplays: number;
  schedulerReadIndexRows: number;
  schedulerWriteIndexRows: number;
};

const benchmarkMetrics = new Map<string, BenchmarkMetric>();

function readIntEnv(name: string, defaultValue: number, min: number): number {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return defaultValue;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new Error(
      `${name} must be an integer >= ${min}; got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

function readIntListEnv(
  name: string,
  defaultValue: readonly number[],
): number[] {
  const raw = Deno.env.get(name);
  if (raw === undefined || raw === "") return [...defaultValue];

  const values = raw.split(",").map((part) => Number(part.trim()));
  if (
    values.length === 0 ||
    values.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    throw new Error(
      `${name} must be a comma-separated list of integers >= 1; got ${
        JSON.stringify(raw)
      }`,
    );
  }
  return values;
}

async function createEngine(): Promise<{ engine: Engine; path: string }> {
  const path = await Deno.makeTempFile({
    prefix: "scheduler-observation-persistence-",
    suffix: ".sqlite",
  });
  const engine = await open({ url: toFileUrl(path) });
  return { engine, path };
}

async function cleanupEngine(engine: Engine, path: string): Promise<void> {
  close(engine);
  await Promise.all([
    removeIfExists(path),
    removeIfExists(`${path}-wal`),
    removeIfExists(`${path}-shm`),
  ]);
}

async function removeIfExists(path: string): Promise<void> {
  try {
    await Deno.remove(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

function addressFor(
  kind: "read" | "write" | "changed",
  index: number,
): SchedulerObservationAddress {
  return {
    space,
    scope: "space",
    id: `of:scheduler-observation-${kind}-${String(index).padStart(6, "0")}`,
    path: ["value", "items", String(index)],
  };
}

function observationFor(
  localSeq: number,
  pathCount: number,
  actualChangedWrites: SchedulerObservationAddress[] = [],
  pathOffset = 0,
): SchedulerActionObservation {
  return {
    version: 1,
    ownerSpace: space,
    branch,
    pieceId,
    processGeneration,
    actionId: "pattern.tsx:computed:stable-side-effect",
    actionKind: "computation",
    implementationFingerprint: "impl:scheduler-observation-persistence",
    runtimeFingerprint: "runtime:bench",
    observedAtSeq: 0,
    observedAtLocalSeq: localSeq,
    transactionKind: "action-run",
    reads: Array.from(
      { length: pathCount },
      (_, index) => addressFor("read", pathOffset + index),
    ),
    shallowReads: [],
    actualChangedWrites,
    currentKnownWrites: Array.from(
      { length: pathCount },
      (_, index) => addressFor("write", pathOffset + index),
    ),
    declaredWrites: [],
    materializerWriteEnvelopes: [],
    status: "success",
  };
}

function semanticOperation(localSeq: number) {
  return {
    op: "set" as const,
    id: "of:scheduler-observation-semantic-target" as URI,
    value: {
      value: {
        localSeq,
        payload: `value:${localSeq}`,
      },
    },
  };
}

function applySemanticCommit(
  engine: Engine,
  localSeq: number,
  schedulerObservation?: SchedulerActionObservation,
): void {
  applyCommit(engine, {
    sessionId: "session:scheduler-observation-semantic",
    space,
    commit: {
      branch,
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [semanticOperation(localSeq)],
      ...(schedulerObservation ? { schedulerObservation } : {}),
    },
  });
}

function applyObservationOnlyCommit(
  engine: Engine,
  localSeq: number,
  schedulerObservation: SchedulerActionObservation,
): void {
  applyCommit(engine, {
    sessionId: "session:scheduler-observation-noop",
    space,
    commit: {
      branch,
      localSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservation,
    },
  });
}

function applyObservationOnlyBatch(
  engine: Engine,
  batchLocalSeq: number,
  startLocalSeq: number,
  count: number,
  pathCount: number,
  pathOffset: (localSeq: number) => number = () => 0,
): void {
  applyCommit(engine, {
    sessionId: "session:scheduler-observation-noop",
    space,
    commit: {
      branch,
      localSeq: batchLocalSeq,
      reads: { confirmed: [], pending: [] },
      operations: [],
      schedulerObservationBatch: Array.from({ length: count }, (_, index) => {
        const localSeq = startLocalSeq + index;
        return {
          localSeq,
          reads: { confirmed: [], pending: [] },
          schedulerObservation: observationFor(
            localSeq,
            pathCount,
            [],
            pathOffset(localSeq),
          ),
        };
      }),
    },
  });
}

function countRows(engine: Engine, table: string): number {
  return (engine.database.prepare(
    `SELECT count(*) AS count FROM ${table}`,
  ).get() as { count: number }).count;
}

function collectMetrics(
  engine: Engine,
  path: string,
  runs: number,
  pathCount: number,
): BenchmarkMetric {
  const activeSqliteBytes = sqliteBytes(path);
  return {
    runs,
    pathCount,
    activeSqliteBytes,
    bytesPerRun: activeSqliteBytes / runs,
    commits: countRows(engine, `"commit"`),
    revisions: countRows(engine, "revision"),
    schedulerObservations: countRows(engine, "scheduler_observation"),
    schedulerObservationReplays: countRows(
      engine,
      "scheduler_observation_replay",
    ),
    schedulerReadIndexRows: countRows(engine, "scheduler_read_index"),
    schedulerWriteIndexRows: countRows(engine, "scheduler_write_index"),
  };
}

function sqliteBytes(path: string): number {
  return fileSize(path) + fileSize(`${path}-wal`) + fileSize(`${path}-shm`);
}

function fileSize(path: string): number {
  try {
    return Deno.statSync(path).size;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return 0;
    throw error;
  }
}

function recordMetrics(
  name: string,
  engine: Engine,
  path: string,
  pathCount: number,
): void {
  benchmarkMetrics.set(
    name,
    collectMetrics(engine, path, RUN_COUNT, pathCount),
  );
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

Deno.bench({
  name: `semantic commits only - runs=${RUN_COUNT}`,
  group: "v2-scheduler-observation-persistence",
  baseline: true,
  n: 1,
  warmup: 0,
  async fn(b) {
    const { engine, path } = await createEngine();
    try {
      b.start();
      for (let localSeq = 1; localSeq <= RUN_COUNT; localSeq++) {
        applySemanticCommit(engine, localSeq);
      }
      b.end();
      recordMetrics("semantic commits only", engine, path, 0);
    } finally {
      await cleanupEngine(engine, path);
    }
  },
});

for (const pathCount of PATH_COUNTS) {
  Deno.bench({
    name:
      `semantic commits with scheduler observation - runs=${RUN_COUNT}, paths=${pathCount}`,
    group: "v2-scheduler-observation-persistence",
    n: 1,
    warmup: 0,
    async fn(b) {
      const { engine, path } = await createEngine();
      try {
        b.start();
        for (let localSeq = 1; localSeq <= RUN_COUNT; localSeq++) {
          applySemanticCommit(
            engine,
            localSeq,
            observationFor(localSeq, pathCount, [addressFor("changed", 0)]),
          );
        }
        b.end();
        recordMetrics(
          `semantic commits with observation, paths=${pathCount}`,
          engine,
          path,
          pathCount,
        );
      } finally {
        await cleanupEngine(engine, path);
      }
    },
  });

  Deno.bench({
    name:
      `semantic commits with changing scheduler observation - runs=${RUN_COUNT}, paths=${pathCount}`,
    group: "v2-scheduler-observation-persistence",
    n: 1,
    warmup: 0,
    async fn(b) {
      const { engine, path } = await createEngine();
      try {
        b.start();
        for (let localSeq = 1; localSeq <= RUN_COUNT; localSeq++) {
          applySemanticCommit(
            engine,
            localSeq,
            observationFor(
              localSeq,
              pathCount,
              [addressFor("changed", localSeq)],
              localSeq * pathCount,
            ),
          );
        }
        b.end();
        recordMetrics(
          `semantic commits with changing observation, paths=${pathCount}`,
          engine,
          path,
          pathCount,
        );
      } finally {
        await cleanupEngine(engine, path);
      }
    },
  });

  Deno.bench({
    name:
      `observation-only no-op commits - runs=${RUN_COUNT}, paths=${pathCount}`,
    group: "v2-scheduler-observation-persistence",
    n: 1,
    warmup: 0,
    async fn(b) {
      const { engine, path } = await createEngine();
      try {
        b.start();
        for (let localSeq = 1; localSeq <= RUN_COUNT; localSeq++) {
          applyObservationOnlyCommit(
            engine,
            localSeq,
            observationFor(localSeq, pathCount),
          );
        }
        b.end();
        recordMetrics(
          `observation-only commits, paths=${pathCount}`,
          engine,
          path,
          pathCount,
        );
      } finally {
        await cleanupEngine(engine, path);
      }
    },
  });

  Deno.bench({
    name:
      `batched observation-only no-op commits - runs=${RUN_COUNT}, paths=${pathCount}, batch=${NOOP_BATCH_SIZE}`,
    group: "v2-scheduler-observation-persistence",
    n: 1,
    warmup: 0,
    async fn(b) {
      const { engine, path } = await createEngine();
      try {
        b.start();
        let batchLocalSeq = RUN_COUNT + 1;
        for (
          let localSeq = 1;
          localSeq <= RUN_COUNT;
          localSeq += NOOP_BATCH_SIZE
        ) {
          applyObservationOnlyBatch(
            engine,
            batchLocalSeq++,
            localSeq,
            Math.min(NOOP_BATCH_SIZE, RUN_COUNT - localSeq + 1),
            pathCount,
          );
        }
        b.end();
        recordMetrics(
          `batched observation-only commits, paths=${pathCount}, batch=${NOOP_BATCH_SIZE}`,
          engine,
          path,
          pathCount,
        );
      } finally {
        await cleanupEngine(engine, path);
      }
    },
  });

  Deno.bench({
    name:
      `observation-only changing commits - runs=${RUN_COUNT}, paths=${pathCount}`,
    group: "v2-scheduler-observation-persistence",
    n: 1,
    warmup: 0,
    async fn(b) {
      const { engine, path } = await createEngine();
      try {
        b.start();
        for (let localSeq = 1; localSeq <= RUN_COUNT; localSeq++) {
          applyObservationOnlyCommit(
            engine,
            localSeq,
            observationFor(localSeq, pathCount, [], localSeq * pathCount),
          );
        }
        b.end();
        recordMetrics(
          `observation-only changing commits, paths=${pathCount}`,
          engine,
          path,
          pathCount,
        );
      } finally {
        await cleanupEngine(engine, path);
      }
    },
  });
}

const benchDiagnosticsEnabled = Deno.env.get("BENCH_DIAGNOSTICS") === "1";

addEventListener("unload", () => {
  if (!benchDiagnosticsEnabled) return;
  if (benchmarkMetrics.size === 0) return;

  console.error("\nScheduler observation persistence diagnostics:");
  for (const [name, metrics] of benchmarkMetrics) {
    console.error(
      `- ${name}: runs=${metrics.runs}, paths=${metrics.pathCount}, ` +
        `activeSqlite=${formatBytes(metrics.activeSqliteBytes)} (${
          formatBytes(metrics.bytesPerRun)
        }/run), commits=${metrics.commits}, revisions=${metrics.revisions}, ` +
        `observations=${metrics.schedulerObservations}, replays=${metrics.schedulerObservationReplays}, readIndex=${metrics.schedulerReadIndexRows}, writeIndex=${metrics.schedulerWriteIndexRows}`,
    );
  }
});
