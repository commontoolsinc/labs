import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { URI } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase(
  "cfc clause-local release isolation test",
);
const space = signer.did();

const secretSourceSchema = {
  type: "number",
  ifc: { classification: ["secret"] },
} as const satisfies JSONSchema;

const confidentialSourceSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

const clauseLocalReleaseSchema = {
  type: "number",
  ifc: {
    classification: ["unclassified"],
    declassify: {
      confidentialityPre: ["secret"],
      integrityPre: ["proof-token"],
      removeMatchedClauses: true,
      releaseCondition: true,
    },
  },
} as const satisfies JSONSchema;

describe("CFC clause-local release isolation", () => {
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

  async function seedLabels(
    id: URI,
    value: unknown,
    classification: string,
    integrity: readonly string[],
  ): Promise<void> {
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["value"],
    }, value as never);
    tx.writeOrThrow({
      space,
      id,
      type: "application/json",
      path: ["cfc", "labels"],
    }, {
      "/": {
        classification: [classification],
        integrity: [...integrity],
      },
    });
    const { error } = await tx.commit();
    expect(error).toBeUndefined();
  }

  it("does not let releasing one confidentiality clause authorize another", async () => {
    let tx = runtime.edit();
    const secretSource = runtime.getCell<number>(
      space,
      "cfc-clause-local-release-secret-source",
      undefined,
      tx,
    );
    const confidentialSource = runtime.getCell<number>(
      space,
      "cfc-clause-local-release-confidential-source",
      undefined,
      tx,
    );
    const target = runtime.getCell<number>(
      space,
      "cfc-clause-local-release-target",
      undefined,
      tx,
    );

    secretSource.set(7);
    confidentialSource.set(3);
    target.set(0);
    await tx.commit();

    await seedLabels(
      secretSource.getAsNormalizedFullLink().id,
      7,
      "secret",
      ["proof-token"],
    );
    await seedLabels(
      confidentialSource.getAsNormalizedFullLink().id,
      3,
      "confidential",
      ["proof-token"],
    );

    tx = runtime.edit();
    const a = Number(
      secretSource.withTx(tx).asSchema(secretSourceSchema).get() ?? 0,
    );
    const b = Number(
      confidentialSource.withTx(tx).asSchema(confidentialSourceSchema).get() ??
        0,
    );
    target.withTx(tx).asSchema(clauseLocalReleaseSchema).set(a + b);

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
