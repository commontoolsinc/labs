import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc state precondition read required test",
);
const space = signer.did();

const readRequiredSchema = {
  type: "object",
  properties: {
    guard: { type: "boolean" },
    count: {
      type: "number",
      ifc: {
        statePrecondition: {
          requiredRead: "/guard",
        },
      },
    },
  },
} as const satisfies JSONSchema;

describe("CFC state precondition read requirement", () => {
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

  it("rejects prepare when required state read is missing", async () => {
    let tx = runtime.edit();
    const guardedCell = runtime.getCell<{ guard: boolean; count: number }>(
      space,
      "cfc-state-precondition-read-required-cell",
      undefined,
      tx,
    );
    guardedCell.set({ guard: true, count: 1 });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    tx = runtime.edit();
    guardedCell.withTx(tx).asSchema(readRequiredSchema).set({
      guard: true,
      count: 2,
    });

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
      "statePreconditionRead",
    );
  });

  it("allows prepare when required state read is observed in same attempt", async () => {
    let tx = runtime.edit();
    const guardedCell = runtime.getCell<{ guard: boolean; count: number }>(
      space,
      "cfc-state-precondition-read-required-allow-cell",
      undefined,
      tx,
    );
    guardedCell.set({ guard: true, count: 1 });
    const seeded = await tx.commit();
    expect(seeded.error).toBeUndefined();

    const link = guardedCell.getAsNormalizedFullLink();
    tx = runtime.edit();
    tx.readValueOrThrow({
      space,
      id: link.id,
      type: link.type,
      path: ["guard"],
    });
    guardedCell.withTx(tx).asSchema(readRequiredSchema).set({
      guard: true,
      count: 2,
    });

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });
});
