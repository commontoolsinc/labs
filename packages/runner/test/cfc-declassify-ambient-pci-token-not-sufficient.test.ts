import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("cfc declassify ambient pci test");
const space = signer.did();

const sourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const declassifySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: ["proof-token"],
      addAlternatives: ["confidential"],
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

const ambientOnlyDeclassifySchema = {
  type: "number",
  ifc: {
    classification: ["confidential"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: ["proof-token"],
      addAlternatives: ["confidential"],
      releaseCondition: true,
      ambientPcIntegrity: ["proof-token"],
    },
  },
} as const satisfies JSONSchema;

describe("CFC declassify ambient pcI handling", () => {
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

  it("allows declassification when required integrity evidence is value-derived", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-declassify-pci-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-declassify-pci-target",
      undefined,
      tx,
    );
    source.set(10);
    target.set(0);
    tx.writeOrThrow({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
        integrity: ["proof-token"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(declassifySchema).set(value + 1);

    await prepareCfcCommitIfNeeded(tx);
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  });

  it("does not treat ambient pcI tokens as value integrity evidence", async () => {
    let tx = runtime.edit();
    const source = runtime.getCell<number>(
      space,
      "cfc-declassify-pci-ambient-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-declassify-pci-ambient-target",
      undefined,
      tx,
    );
    source.set(10);
    target.set(0);
    tx.writeOrThrow({
      space,
      id: source.getAsNormalizedFullLink().id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: ["secret"],
      },
    });
    await tx.commit();

    tx = runtime.edit();
    const value = Number(source.withTx(tx).asSchema(sourceSchema).get() ?? 0);
    target.withTx(tx).asSchema(ambientOnlyDeclassifySchema).set(value + 1);

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
});
