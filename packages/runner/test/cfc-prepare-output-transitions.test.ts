import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc prepare output transition test",
);
const space = signer.did();

const secretNumberSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as unknown as JSONSchema;

const confidentialNumberSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as unknown as JSONSchema;

const exactCopyNumberSchema = {
  type: "number",
  ifc: {
    classification: ["secret"],
    exactCopyOf: "/",
  },
} as unknown as JSONSchema;

describe("CFC prepare output transitions", () => {
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

  async function seedInputClassification(
    id: URI,
    value: number,
    classification: string,
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, { "/": { classification: [classification] } });
    const { error } = await tx.commit();
    if (error) {
      throw new Error(`seed classification failed: ${error.name}`);
    }
  }

  it("allows prepare when output classification is monotone with consumed input", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-monotone-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 1, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(space, "cfc-output-monotone-source");
    const targetCell = runtime.getCell<number>(space, "cfc-output-monotone-target");
    const value = Number(sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0);
    targetCell.withTx(tx).asSchema(secretNumberSchema).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when output classification downgrades consumed input", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-downgrade-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 1, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(space, "cfc-output-downgrade-source");
    const targetCell = runtime.getCell<number>(space, "cfc-output-downgrade-target");
    const value = Number(sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0);
    targetCell.withTx(tx).asSchema(confidentialNumberSchema).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("confidentialityMonotonicity");
  });

  it("allows prepare when exactCopyOf assertion is satisfied", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-exact-copy-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 11, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(space, "cfc-output-exact-copy-source");
    const targetCell = runtime.getCell<number>(space, "cfc-output-exact-copy-target");
    const value = Number(sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0);
    targetCell.withTx(tx).asSchema(exactCopyNumberSchema).set(value);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when exactCopyOf assertion is violated", async () => {
    const sourceId = runtime.getCell(space, "cfc-output-exact-copy-fail-source")
      .getAsNormalizedFullLink().id;
    await seedInputClassification(sourceId, 11, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-fail-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-output-exact-copy-fail-target",
    );
    const value = Number(sourceCell.withTx(tx).asSchema(secretNumberSchema).get() ?? 0);
    targetCell.withTx(tx).asSchema(exactCopyNumberSchema).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcOutputTransitionViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("exactCopyOf");
  });
});
