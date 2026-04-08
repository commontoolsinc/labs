import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { createBenchPhaseMetricsTracker } from "./profile-memory-regressions-lib.ts";

type MemoryVersion = "v1" | "v2";
type Scenario =
  | "get-as-link"
  | "get-as-link-with-options"
  | "read-tx-fallback-direct"
  | "read-tx-create-only"
  | "cell-set-single-tx"
  | "cell-set-nested"
  | "bench-body-get-as-link"
  | "bench-body-read-tx-fallback-direct"
  | "bench-body-cell-set-single-tx"
  | "bench-body-cell-set-nested";

type PreparedScenario = {
  run(iterations: number): unknown | Promise<unknown>;
  cleanup(): Promise<void>;
  metrics?(): Record<string, unknown>;
  resetMetrics?(): void;
};

function parseArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of Deno.args) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function requireMemoryVersion(): MemoryVersion {
  const value = parseArg("memory-version");
  if (value === "v1" || value === "v2") return value;
  throw new Error("--memory-version must be v1 or v2");
}

function requireScenario(): Scenario {
  const value = parseArg("scenario");
  switch (value) {
    case "get-as-link":
    case "get-as-link-with-options":
    case "read-tx-fallback-direct":
    case "read-tx-create-only":
    case "cell-set-single-tx":
    case "cell-set-nested":
    case "bench-body-get-as-link":
    case "bench-body-read-tx-fallback-direct":
    case "bench-body-cell-set-single-tx":
    case "bench-body-cell-set-nested":
      return value;
    default:
      throw new Error(
        "--scenario must be one of get-as-link, get-as-link-with-options, " +
          "read-tx-fallback-direct, read-tx-create-only, cell-set-single-tx, " +
          "cell-set-nested, bench-body-get-as-link, " +
          "bench-body-read-tx-fallback-direct, bench-body-cell-set-single-tx, " +
          "bench-body-cell-set-nested",
      );
  }
}

function parseNumberArg(name: string, defaultValue: number): number {
  const value = parseArg(name);
  if (value === undefined) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return Math.floor(parsed);
}

const scenario = requireScenario();
const memoryVersion = requireMemoryVersion();
const iterations = parseNumberArg("iterations", 100_000);
const warmup = parseNumberArg("warmup", 1_000);

const signer = await Identity.fromPassphrase(
  `profile-memory-regressions:${scenario}:${memoryVersion}`,
);
const space = signer.did();
const apiUrl = new URL(import.meta.url);

function setupRuntime() {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion,
  });
  const runtime = new Runtime({
    apiUrl,
    storageManager,
    memoryVersion,
  });
  return { runtime, storageManager };
}

async function cleanupRuntime(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit();
  await runtime.dispose();
  await storageManager.close();
}

function consume(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 1;
}

async function prepareGetAsLink(
  includeOptions: boolean,
): Promise<PreparedScenario> {
  const { runtime, storageManager } = setupRuntime();
  const tx = runtime.edit();
  const cell = runtime.getCell<{ value: number }>(
    space,
    `profile-get-as-link-${crypto.randomUUID()}`,
    undefined,
    tx,
  );
  cell.set({ value: 42 });
  let base:
    | ReturnType<typeof runtime.getCell<any>>
    | undefined;
  if (includeOptions) {
    base = runtime.getCell<{ other: string }>(
      space,
      `profile-get-as-link-base-${crypto.randomUUID()}`,
      undefined,
      tx,
    );
    base.set({ other: "test" });
  }
  await tx.commit();

  return {
    run(loopIterations: number) {
      let checksum = 0;
      const options = includeOptions && base
        ? { base, includeSchema: true as const }
        : undefined;
      for (let i = 0; i < loopIterations; i += 1) {
        checksum += consume(cell.getAsLink(options));
      }
      return checksum;
    },
    cleanup: () => cleanupRuntime(runtime, storageManager),
  };
}

async function prepareReadTxFallback(
  createOnly: boolean,
): Promise<PreparedScenario> {
  const { runtime, storageManager } = setupRuntime();
  const tx = runtime.edit();
  const schema = { type: "number" } as const satisfies JSONSchema;
  const cell = runtime.getCell(
    space,
    `profile-read-tx-${crypto.randomUUID()}`,
    schema,
    tx,
  );
  cell.set(42);
  await tx.commit();
  const link = cell.getAsNormalizedFullLink();

  return {
    run(loopIterations: number) {
      let checksum = 0;
      for (let i = 0; i < loopIterations; i += 1) {
        const readTx = runtime.readTx();
        checksum += createOnly
          ? 1
          : consume(readTx.readValueOrThrow(link) as number);
      }
      return checksum;
    },
    cleanup: () => cleanupRuntime(runtime, storageManager),
  };
}

function prepareCellSet(
  mode: "single-tx" | "nested",
): PreparedScenario {
  const { runtime, storageManager } = setupRuntime();
  const tx = runtime.edit();
  const cell = runtime.getCell<any>(
    space,
    `profile-cell-set-${mode}-${crypto.randomUUID()}`,
    undefined,
    tx,
  );

  if (mode === "nested") {
    cell.set({
      a: 1,
      b: "hello",
      c: { d: 2, e: "world", f: { g: 3, h: "nested" } },
    });
  }

  return {
    run(loopIterations: number) {
      let checksum = 0;
      if (mode === "single-tx") {
        for (let i = 0; i < loopIterations; i += 1) {
          const value = { value: i, data: `test-${i}` };
          cell.set(value);
          checksum += consume(value);
        }
        return checksum;
      }

      const baseObj = {
        a: 1,
        b: "hello",
        c: { d: 2, e: "world", f: { g: 3, h: "nested" } },
      };
      for (let i = 0; i < loopIterations; i += 1) {
        const value = {
          ...baseObj,
          c: {
            ...baseObj.c,
            f: { ...baseObj.c.f, g: i },
          },
        };
        cell.set(value);
        checksum += consume(value);
      }
      return checksum;
    },
    cleanup: () => cleanupRuntime(runtime, storageManager, tx),
  };
}

function prepareBenchBody(
  mode:
    | "get-as-link"
    | "read-tx-fallback-direct"
    | "cell-set-single-tx"
    | "cell-set-nested",
): PreparedScenario {
  const phaseMetrics = createBenchPhaseMetricsTracker();
  const { phaseTotals } = phaseMetrics;
  return {
    async run(loopIterations: number) {
      let checksum = 0;
      for (let i = 0; i < loopIterations; i += 1) {
        const setupStarted = performance.now();
        const { runtime, storageManager } = setupRuntime();
        phaseTotals.setupMs += performance.now() - setupStarted;
        const tx = runtime.edit();
        try {
          switch (mode) {
            case "get-as-link": {
              const prepareStarted = performance.now();
              const cell = runtime.getCell<{ value: number }>(
                space,
                `bench-body-get-as-link-${crypto.randomUUID()}`,
                undefined,
                tx,
              );
              cell.set({ value: 42 });
              phaseTotals.prepareMs += performance.now() - prepareStarted;
              const firstCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.firstCommitMs += performance.now() -
                firstCommitStarted;
              const loopStarted = performance.now();
              for (let j = 0; j < 100; j += 1) {
                checksum += consume(cell.getAsLink());
              }
              phaseTotals.loopMs += performance.now() - loopStarted;
              const cleanupCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.cleanupCommitMs += performance.now() -
                cleanupCommitStarted;
              const disposeStarted = performance.now();
              await runtime.dispose();
              await storageManager.close();
              phaseTotals.disposeMs += performance.now() - disposeStarted;
              break;
            }
            case "read-tx-fallback-direct": {
              const prepareStarted = performance.now();
              const schema = { type: "number" } as const satisfies JSONSchema;
              const cell = runtime.getCell(
                space,
                `bench-body-read-tx-${crypto.randomUUID()}`,
                schema,
                tx,
              );
              cell.set(42);
              phaseTotals.prepareMs += performance.now() - prepareStarted;
              const firstCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.firstCommitMs += performance.now() -
                firstCommitStarted;
              const link = cell.getAsNormalizedFullLink();
              const loopStarted = performance.now();
              for (let j = 0; j < 100; j += 1) {
                const readTx = runtime.readTx();
                checksum += consume(readTx.readValueOrThrow(link) as number);
              }
              phaseTotals.loopMs += performance.now() - loopStarted;
              const cleanupCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.cleanupCommitMs += performance.now() -
                cleanupCommitStarted;
              const disposeStarted = performance.now();
              await runtime.dispose();
              await storageManager.close();
              phaseTotals.disposeMs += performance.now() - disposeStarted;
              break;
            }
            case "cell-set-single-tx": {
              const prepareStarted = performance.now();
              const cell = runtime.getCell<any>(
                space,
                `bench-body-cell-set-single-${crypto.randomUUID()}`,
                undefined,
                tx,
              );
              phaseTotals.prepareMs += performance.now() - prepareStarted;
              const loopStarted = performance.now();
              for (let j = 0; j < 100; j += 1) {
                const value = { value: j, data: `test-${j}` };
                cell.set(value);
                checksum += consume(value);
              }
              phaseTotals.loopMs += performance.now() - loopStarted;
              const cleanupCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.cleanupCommitMs += performance.now() -
                cleanupCommitStarted;
              const disposeStarted = performance.now();
              await runtime.dispose();
              await storageManager.close();
              phaseTotals.disposeMs += performance.now() - disposeStarted;
              break;
            }
            case "cell-set-nested": {
              const prepareStarted = performance.now();
              const cell = runtime.getCell<any>(
                space,
                `bench-body-cell-set-nested-${crypto.randomUUID()}`,
                undefined,
                tx,
              );
              const baseObj = {
                a: 1,
                b: "hello",
                c: { d: 2, e: "world", f: { g: 3, h: "nested" } },
              };
              cell.set(baseObj);
              phaseTotals.prepareMs += performance.now() - prepareStarted;
              const loopStarted = performance.now();
              for (let j = 0; j < 100; j += 1) {
                const value = {
                  ...baseObj,
                  c: {
                    ...baseObj.c,
                    f: { ...baseObj.c.f, g: j },
                  },
                };
                cell.set(value);
                checksum += consume(value);
              }
              phaseTotals.loopMs += performance.now() - loopStarted;
              const cleanupCommitStarted = performance.now();
              await tx.commit();
              phaseTotals.cleanupCommitMs += performance.now() -
                cleanupCommitStarted;
              const disposeStarted = performance.now();
              await runtime.dispose();
              await storageManager.close();
              phaseTotals.disposeMs += performance.now() - disposeStarted;
              break;
            }
          }
        } catch (error) {
          await runtime.dispose();
          await storageManager.close();
          throw error;
        }
        phaseMetrics.recordRun();
      }
      return checksum;
    },
    resetMetrics() {
      phaseMetrics.reset();
    },
    async cleanup() {
      // No shared state; each loop iteration handles its own runtime cleanup.
    },
    metrics() {
      return phaseMetrics.metrics();
    },
  };
}

async function prepareScenario(which: Scenario): Promise<PreparedScenario> {
  switch (which) {
    case "get-as-link":
      return await prepareGetAsLink(false);
    case "get-as-link-with-options":
      return await prepareGetAsLink(true);
    case "read-tx-fallback-direct":
      return await prepareReadTxFallback(false);
    case "read-tx-create-only":
      return await prepareReadTxFallback(true);
    case "cell-set-single-tx":
      return await prepareCellSet("single-tx");
    case "cell-set-nested":
      return await prepareCellSet("nested");
    case "bench-body-get-as-link":
      return await prepareBenchBody("get-as-link");
    case "bench-body-read-tx-fallback-direct":
      return await prepareBenchBody("read-tx-fallback-direct");
    case "bench-body-cell-set-single-tx":
      return await prepareBenchBody("cell-set-single-tx");
    case "bench-body-cell-set-nested":
      return await prepareBenchBody("cell-set-nested");
  }
}

const prepared = await prepareScenario(scenario);
try {
  if (warmup > 0) {
    await prepared.run(warmup);
    prepared.resetMetrics?.();
  }

  const started = performance.now();
  const checksum = await prepared.run(iterations);
  const durationMs = performance.now() - started;
  console.log(JSON.stringify(
    {
      scenario,
      memoryVersion,
      iterations,
      warmup,
      durationMs,
      nsPerIteration: (durationMs * 1_000_000) / Math.max(iterations, 1),
      checksum,
      ...prepared.metrics?.(),
    },
    null,
    2,
  ));
} finally {
  await prepared.cleanup();
}
