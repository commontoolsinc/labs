import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc relevance from write target");
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

describe("CFC relevance from write target labels", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      storageManager,
      apiUrl: new URL(import.meta.url),
    });
    runtime.scheduler.disablePullMode();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  it("marks tx relevant on write-only IFC target path", async () => {
    const tx = runtime.edit();
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-relevance-write-target-label",
      undefined,
      tx,
    );
    targetCell.withTx(tx).asSchema(ifcNumberSchema).set(11);
    expect(tx.cfcRelevant).toBe(true);
    tx.abort("test-complete");
  });
});
