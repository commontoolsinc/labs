import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { cfcLabelsAddress } from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc static descendant vs parent enumeration test",
);
const space = signer.did();

const confidentialNumberSchema = {
  type: "number",
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

describe(
  "CFC prepare: static descendant read does not join parent enumeration",
  () => {
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

    async function seedSource(): Promise<void> {
      const tx = runtime.edit();
      const sourceCell = runtime.getCell<
        { error: { code: number; details: { reason: string } } }
      >(
        space,
        "cfc-static-descendant-enum-source",
        undefined,
        tx,
      );
      sourceCell.set({
        error: {
          code: 403,
          details: { reason: "scope-insufficient" },
        },
      });
      tx.writeOrThrow(
        cfcLabelsAddress({
          space,
          id: sourceCell.getAsNormalizedFullLink().id,
          type: "application/json",
        }),
        {
          "/error": {
            iterate: {
              order: {
                classification: ["secret"],
              },
            },
          },
          "/error/code": {
            value: {
              classification: ["confidential"],
            },
          },
        },
      );
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    }

    it("allows prepare when only the descendant value observation is downgraded", async () => {
      await seedSource();

      const tx = runtime.edit();
      const sourceCell = runtime.getCell<
        { error: { code: number; details: { reason: string } } }
      >(
        space,
        "cfc-static-descendant-enum-source",
      );
      const targetCell = runtime.getCell<number>(
        space,
        "cfc-static-descendant-enum-target",
      );

      const source = sourceCell.getAsQueryResult(undefined, tx);
      const code = Number(source.error.code);
      targetCell.withTx(tx).asSchema(confidentialNumberSchema).set(code);

      await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    });
  },
);
