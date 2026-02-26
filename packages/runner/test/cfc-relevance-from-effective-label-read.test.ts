import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc relevance from effective label read",
);
const space = signer.did();

const plainNumberSchema = {
  type: "number",
} as const satisfies JSONSchema;

describe("CFC relevance from effective-label read", () => {
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

  it("marks tx relevant when persisted labels constrain the read path", async () => {
    let tx = runtime.edit();
    const labeledCell = runtime.getCell<number>(
      space,
      "cfc-relevance-effective-label-read",
      undefined,
      tx,
    );
    labeledCell.set(5);
    tx.writeOrThrow({
      space,
      id: labeledCell.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const value = labeledCell.withTx(tx).asSchema(plainNumberSchema).get();
    expect(value).toBe(5);
    expect(tx.cfcRelevant).toBe(true);
    expect(tx.cfcReasons).toContain("ifc-read-effective-label");
    tx.abort("test-complete");
  });
});
