import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("storage-transaction-path-bench");
const space = signer.did();

const setup = () => {
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
  return { storageManager, runtime, tx };
};

const cleanup = async (
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await runtime.dispose();
  await storageManager.close();
};

Deno.bench("Storage tx path - root read x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      id: "of:storage-tx-read",
      type: "application/json",
      path: [],
    }, { count: 0, label: "bench", nested: { value: 1 } });

    for (let index = 0; index < 100; index += 1) {
      tx.readValueOrThrow({
        space,
        id: "of:storage-tx-read",
        type: "application/json",
        path: [],
      });
    }
  } finally {
    await tx.commit();
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Storage tx path - single sibling write x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      id: "of:storage-tx-write",
      type: "application/json",
      path: [],
    }, { count: 0, label: "bench", nested: { value: 1 } });

    for (let index = 0; index < 100; index += 1) {
      tx.writeValueOrThrow({
        space,
        id: "of:storage-tx-write",
        type: "application/json",
        path: ["count"],
      }, index);
    }
  } finally {
    await tx.commit();
    await cleanup(runtime, storageManager);
  }
});

Deno.bench("Storage tx path - five sibling writes x100", async () => {
  const { storageManager, runtime, tx } = setup();
  try {
    tx.writeValueOrThrow({
      space,
      id: "of:storage-tx-five",
      type: "application/json",
      path: [],
    }, {
      a: 0,
      b: "zero",
      c: true,
      d: { nested: 0 },
      e: 0,
    });

    for (let index = 0; index < 100; index += 1) {
      tx.writeValuesOrThrow?.([
        {
          address: {
            space,
            id: "of:storage-tx-five",
            type: "application/json",
            path: ["a"],
          },
          value: index,
        },
        {
          address: {
            space,
            id: "of:storage-tx-five",
            type: "application/json",
            path: ["b"],
          },
          value: `value-${index}`,
        },
        {
          address: {
            space,
            id: "of:storage-tx-five",
            type: "application/json",
            path: ["c"],
          },
          value: index % 2 === 0,
        },
        {
          address: {
            space,
            id: "of:storage-tx-five",
            type: "application/json",
            path: ["d", "nested"],
          },
          value: index * 2,
        },
        {
          address: {
            space,
            id: "of:storage-tx-five",
            type: "application/json",
            path: ["e"],
          },
          value: index + 1,
        },
      ]);
    }
  } finally {
    await tx.commit();
    await cleanup(runtime, storageManager);
  }
});
