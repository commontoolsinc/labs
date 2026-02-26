import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc relevance from ifc schema read",
);
const space = signer.did();

const ifcNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

describe("CFC relevance from IFC schema read", () => {
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

  it("marks tx relevant when reading through link with IFC schema", async () => {
    let tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-relevance-ifc-source",
      undefined,
      tx,
    );
    const aliasCell = runtime.getCell<number>(
      space,
      "cfc-relevance-ifc-alias",
      undefined,
      tx,
    );
    sourceCell.set(7);
    aliasCell.set(sourceCell);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const readValue = aliasCell.withTx(tx).asSchema(ifcNumberSchema).get();
    expect(readValue).toBe(7);
    expect(tx.cfcRelevant).toBe(true);
    tx.abort("test-complete");
  });
});
