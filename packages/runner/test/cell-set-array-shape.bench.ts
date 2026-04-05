import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { recursivelyAddIDIfNeeded } from "../src/cell.ts";
import { diffAndUpdate, normalizeAndDiff } from "../src/data-updating.ts";
import { resolveLink } from "../src/link-resolution.ts";
import { BENCH_MEMORY_VERSION } from "./bench-memory-version.ts";

const signer = await Identity.fromPassphrase("bench operator");
const space = signer.did();

const makeArrayValue = (index: number) => ({
  items: Array.from({ length: 10 }, (_, itemIndex) => ({
    id: itemIndex,
    value: `item-${index}-${itemIndex}`,
  })),
});

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
  tx?: IExtendedStorageTransaction,
) {
  await tx?.commit();
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench({
  name: "Cell set array shape - recursivelyAddIDIfNeeded only (100x)",
  group: "array-shape",
  baseline: true,
  fn() {
    for (let i = 0; i < 100; i++) {
      recursivelyAddIDIfNeeded(makeArrayValue(i), undefined);
    }
  },
});

Deno.bench({
  name: "Cell set array shape - normalizeAndDiff only (100x)",
  group: "array-shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell<any>(
      space,
      "bench-array-shape-normalize",
      undefined,
      tx,
    );
    const link = resolveLink(
      runtime,
      runtime.readTx(tx),
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
    );

    for (let i = 0; i < 100; i++) {
      normalizeAndDiff(runtime, tx, link, makeArrayValue(i));
    }

    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  },
});

Deno.bench({
  name: "Cell set array shape - diffAndUpdate only (100x)",
  group: "array-shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell<any>(
      space,
      "bench-array-shape-diff",
      undefined,
      tx,
    );
    const link = resolveLink(
      runtime,
      runtime.readTx(tx),
      cell.getAsNormalizedFullLink(),
      "writeRedirect",
    );

    for (let i = 0; i < 100; i++) {
      diffAndUpdate(runtime, tx, link, makeArrayValue(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});

Deno.bench({
  name: "Cell set array shape - cell.set loop (100x)",
  group: "array-shape",
  async fn() {
    const { runtime, storageManager, tx } = setup();
    const cell = runtime.getCell<any>(
      space,
      "bench-array-shape-set",
      undefined,
      tx,
    );

    for (let i = 0; i < 100; i++) {
      cell.set(makeArrayValue(i));
    }

    await cleanup(runtime, storageManager, tx);
  },
});
