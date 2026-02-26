import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc prepare smoke bench");
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

async function setup() {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL(import.meta.url),
  });
  runtime.scheduler.disablePullMode();

  const seedTx = runtime.edit();
  const source = runtime.getCell<number>(
    space,
    "cfc-prepare-bench-source",
    undefined,
    seedTx,
  );
  const target = runtime.getCell<number>(
    space,
    "cfc-prepare-bench-target",
    undefined,
    seedTx,
  );
  source.set(1);
  target.set(0);
  await seedTx.commit();

  return { runtime, storageManager, source, target };
}

async function teardown(
  runtime: Runtime,
  storageManager: ReturnType<typeof StorageManager.emulate>,
) {
  await runtime.dispose();
  await storageManager.close();
}

Deno.bench(
  "CFC prepare smoke (50 tx with IFC read/write + prepare)",
  { group: "cfc-prepare-overhead" },
  async () => {
    const { runtime, storageManager, source, target } = await setup();

    for (let index = 0; index < 50; index++) {
      const tx = runtime.edit();
      const value = Number(source.withTx(tx).asSchema(ifcNumberSchema).get() ?? 0);
      target.withTx(tx).asSchema(ifcNumberSchema).set(value + index);
      await prepareCfcCommitIfNeeded(tx);
      await tx.commit();
    }

    await teardown(runtime, storageManager);
  },
);

Deno.bench(
  "CFC baseline smoke (50 tx without IFC prepare)",
  { group: "cfc-prepare-overhead" },
  async () => {
    const { runtime, storageManager, source, target } = await setup();

    for (let index = 0; index < 50; index++) {
      const tx = runtime.edit();
      const value = Number(source.withTx(tx).get() ?? 0);
      target.withTx(tx).set(value + index);
      await tx.commit();
    }

    await teardown(runtime, storageManager);
  },
);
