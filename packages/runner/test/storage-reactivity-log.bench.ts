import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import {
  ignoreReadForScheduling,
  markReadAsPotentialWrite,
} from "../src/storage/reactivity-log.ts";
import { txToReactivityLog } from "../src/scheduler.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("storage-reactivity-log-bench");
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
  return { storageManager, runtime };
};

const cleanup = async (
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) => {
  await runtime.dispose();
  await storageManager.close();
};

Deno.bench(
  "Storage reactivity log - txToReactivityLog after mixed activity",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      const tx = runtime.edit();
      tx.writeValueOrThrow({
        space,
        id: "of:reactivity-log-bench",
        type: "application/json",
        path: [],
      }, {
        count: 0,
        nested: { value: 1, label: "bench" },
        list: Array.from({ length: 10 }, (_, index) => ({ index })),
      });

      for (let index = 0; index < 50; index += 1) {
        tx.readValueOrThrow({
          space,
          id: "of:reactivity-log-bench",
          type: "application/json",
          path: ["count"],
        });
        tx.read({
          space,
          id: "of:reactivity-log-bench",
          type: "application/json",
          path: ["nested", "value"],
        }, { nonRecursive: true });
        tx.read({
          space,
          id: "of:reactivity-log-bench",
          type: "application/json",
          path: ["nested"],
        }, { meta: ignoreReadForScheduling });
        tx.read({
          space,
          id: "of:reactivity-log-bench",
          type: "application/json",
          path: ["list"],
        }, { meta: markReadAsPotentialWrite });
        tx.writeValueOrThrow({
          space,
          id: "of:reactivity-log-bench",
          type: "application/json",
          path: ["count"],
        }, index);
      }

      txToReactivityLog(tx);
      await tx.commit();
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);

Deno.bench(
  "Storage reactivity log - repeated direct hook reads",
  async () => {
    const { runtime, storageManager } = setup();
    try {
      const tx = runtime.edit();
      tx.writeValueOrThrow({
        space,
        id: "of:reactivity-log-repeat",
        type: "application/json",
        path: [],
      }, {
        count: 0,
        nested: { value: 1 },
      });

      for (let index = 0; index < 50; index += 1) {
        tx.readValueOrThrow({
          space,
          id: "of:reactivity-log-repeat",
          type: "application/json",
          path: ["nested", "value"],
        });
        tx.writeValueOrThrow({
          space,
          id: "of:reactivity-log-repeat",
          type: "application/json",
          path: ["count"],
        }, index);
      }

      for (let index = 0; index < 100; index += 1) {
        tx.getReactivityLog?.();
      }

      await tx.commit();
    } finally {
      await cleanup(runtime, storageManager);
    }
  },
);
