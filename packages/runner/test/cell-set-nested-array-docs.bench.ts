/**
 * Benchmarks Cell.set() for nested arrays in a local frame.
 *
 * With a frame captured by the Cell, Cell.set() annotates each object found as
 * an array element with a generated ID. The diff/write path then stores those
 * array objects as their own documents and writes everything in one
 * transaction.
 *
 * Environment controls:
 * - CELL_SET_NESTED_ARRAY_DEPTH: nested child-array levels, default 4
 * - CELL_SET_NESTED_ARRAY_WIDTH: objects per array level, default 4
 * - CELL_SET_NESTED_ARRAY_PAYLOAD_FIELDS: scalar fields per object, default 4
 * - CELL_SET_NESTED_ARRAY_RUNS: number of Cell.set() calls before commit, default 1
 */

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { popFrame, pushFrame } from "../src/builder/pattern.ts";
import { type Frame } from "../src/builder/types.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("bench nested array docs");
const space = signer.did();

const DEPTH = readIntEnv("CELL_SET_NESTED_ARRAY_DEPTH", 4, 0);
const WIDTH = readIntEnv("CELL_SET_NESTED_ARRAY_WIDTH", 4, 1);
const PAYLOAD_FIELDS = readIntEnv("CELL_SET_NESTED_ARRAY_PAYLOAD_FIELDS", 4, 0);
const RUNS = readIntEnv("CELL_SET_NESTED_ARRAY_RUNS", 1, 1);
const DOCUMENT_COUNT = countArrayObjects(DEPTH, WIDTH) * RUNS;

type NestedArrayDoc = {
  label: string;
  level: number;
  index: number;
  path: string;
  payload: Record<string, string | number | boolean>;
  children?: NestedArrayDoc[];
};

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

function countArrayObjects(depth: number, width: number): number {
  let total = 0;
  let levelCount = width;

  for (let level = 0; level <= depth; level++) {
    total += levelCount;
    levelCount *= width;
  }

  return total;
}

function makePayload(
  run: number,
  level: number,
  index: number,
): Record<string, string | number | boolean> {
  const payload: Record<string, string | number | boolean> = {};

  for (let field = 0; field < PAYLOAD_FIELDS; field++) {
    payload[`field${field}`] =
      `run-${run}:level-${level}:item-${index}:field-${field}`;
  }

  payload.run = run;
  payload.active = index % 2 === 0;
  return payload;
}

function makeNodes(
  run: number,
  level: number,
  maxDepth: number,
  path: string,
): NestedArrayDoc[] {
  return Array.from({ length: WIDTH }, (_, index) => {
    const childPath = path === "" ? `${index}` : `${path}.${index}`;
    const node: NestedArrayDoc = {
      label: `node-${run}-${childPath}`,
      level,
      index,
      path: childPath,
      payload: makePayload(run, level, index),
    };

    if (level < maxDepth) {
      node.children = makeNodes(run, level + 1, maxDepth, childPath);
    }

    return node;
  });
}

function setup() {
  const storageManager = StorageManager.emulate({
    as: signer,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager,
    memoryVersion: BENCH_MEMORY_VERSION,
  });
  const tx = runtime.edit();
  return { runtime, storageManager, tx };
}

async function cleanup(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
  tx: IExtendedStorageTransaction,
) {
  if (tx.status().status === "ready") {
    tx.abort();
  }
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench({
  name:
    `Cell.set() nested array docs - depth=${DEPTH}, width=${WIDTH}, docs=${DOCUMENT_COUNT}, runs=${RUNS}`,
  group: "cell-set-nested-array-docs",
  async fn(b) {
    const { runtime, storageManager, tx } = setup();
    const values = Array.from(
      { length: RUNS },
      (_, run) => makeNodes(run, 0, DEPTH, ""),
    );
    const frame: Frame = pushFrame({
      cause: {
        type: "bench-cell-set-nested-array-docs",
        depth: DEPTH,
        width: WIDTH,
        runs: RUNS,
      },
      runtime,
      tx,
      space,
      inHandler: true,
    });
    const cell = runtime.getCell<NestedArrayDoc[]>(
      space,
      "bench-cell-set-nested-array-docs",
      undefined,
      tx,
    );

    try {
      b.start();
      for (const value of values) {
        cell.set(value);
      }
      await tx.commit();
      b.end();
    } finally {
      popFrame(frame);
      await cleanup(runtime, storageManager, tx);
    }
  },
});
