import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc state precondition predicate required test",
);
const space = signer.did();

const casSchema = {
  type: "number",
  ifc: {
    statePrecondition: {
      requiredRead: "/",
      path: "/",
      equals: 1,
    },
  },
} as const satisfies JSONSchema;

describe("CFC state precondition predicate requirement", () => {
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

  it("allows prepare when state predicate matches in the same attempt", async () => {
    let tx = runtime.edit();
    const guardedCell = runtime.getCell<number>(
      space,
      "cfc-state-precondition-predicate-allow-cell",
      undefined,
      tx,
    );
    guardedCell.set(1);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const current = Number(guardedCell.withTx(tx).asSchema(casSchema).get() ?? 0);
    guardedCell.withTx(tx).asSchema(casSchema).set(current + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("rejects prepare when state predicate does not match", async () => {
    let tx = runtime.edit();
    const guardedCell = runtime.getCell<number>(
      space,
      "cfc-state-precondition-predicate-reject-cell",
      undefined,
      tx,
    );
    guardedCell.set(0);
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    const current = Number(guardedCell.withTx(tx).asSchema(casSchema).get() ?? 0);
    guardedCell.withTx(tx).asSchema(casSchema).set(current + 1);

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
    expect((thrown as { requirement?: string } | undefined)?.requirement).toBe(
      "statePreconditionPredicate",
    );
  });
});
