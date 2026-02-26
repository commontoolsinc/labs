import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc prepare input requirements test",
);
const space = signer.did();

const maxConfidentialSchema = {
  type: "number",
  ifc: {
    maxConfidentiality: ["confidential"],
  },
} as const satisfies JSONSchema;

const requiredIntegritySchema = {
  type: "number",
  ifc: {
    requiredIntegrity: ["trusted-source"],
  },
} as const satisfies JSONSchema;

describe("CFC prepare input requirements", () => {
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

  async function seedInputWithClassification(
    id: URI,
    value: number,
    classification: string,
    integrity?: readonly string[],
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
    }, {
      "/": {
        classification: [classification],
        ...(integrity ? { integrity } : {}),
      },
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("allows prepare when consumed input satisfies maxConfidentiality", async () => {
    const sourceId = runtime.getCell(space, "cfc-input-maxconf-allow-source")
      .getAsNormalizedFullLink().id;
    await seedInputWithClassification(sourceId, 1, "confidential");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-input-maxconf-allow-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-input-maxconf-allow-target",
    );

    const value = Number(
      sourceCell.withTx(tx).asSchema(maxConfidentialSchema).get() ?? 0,
    );
    targetCell.withTx(tx).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when consumed input exceeds maxConfidentiality", async () => {
    const sourceId = runtime.getCell(space, "cfc-input-maxconf-reject-source")
      .getAsNormalizedFullLink().id;
    await seedInputWithClassification(sourceId, 1, "secret");

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-input-maxconf-reject-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-input-maxconf-reject-target",
    );

    const value = Number(
      sourceCell.withTx(tx).asSchema(maxConfidentialSchema).get() ?? 0,
    );
    targetCell.withTx(tx).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcInputRequirementViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("maxConfidentiality");
  });

  it("allows prepare when consumed input satisfies requiredIntegrity", async () => {
    const sourceId = runtime.getCell(
      space,
      "cfc-input-required-integrity-allow-source",
    ).getAsNormalizedFullLink().id;
    await seedInputWithClassification(
      sourceId,
      1,
      "confidential",
      ["trusted-source"],
    );

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-input-required-integrity-allow-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-input-required-integrity-allow-target",
    );

    const value = Number(
      sourceCell.withTx(tx).asSchema(requiredIntegritySchema).get() ?? 0,
    );
    targetCell.withTx(tx).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when consumed input misses requiredIntegrity", async () => {
    const sourceId = runtime.getCell(
      space,
      "cfc-input-required-integrity-reject-source",
    ).getAsNormalizedFullLink().id;
    await seedInputWithClassification(
      sourceId,
      1,
      "confidential",
      ["untrusted-source"],
    );

    const tx = runtime.edit();
    const sourceCell = runtime.getCell<number>(
      space,
      "cfc-input-required-integrity-reject-source",
    );
    const targetCell = runtime.getCell<number>(
      space,
      "cfc-input-required-integrity-reject-target",
    );

    const value = Number(
      sourceCell.withTx(tx).asSchema(requiredIntegritySchema).get() ?? 0,
    );
    targetCell.withTx(tx).set(value + 1);

    let thrown: unknown;
    try {
      await prepareCfcCommitIfNeeded(tx);
    } catch (error) {
      thrown = error;
    }
    tx.abort(thrown);

    expect((thrown as { name?: string } | undefined)?.name).toBe(
      "CfcInputRequirementViolationError",
    );
    expect(
      (thrown as { requirement?: string } | undefined)?.requirement,
    ).toBe("requiredIntegrity");
  });
});
