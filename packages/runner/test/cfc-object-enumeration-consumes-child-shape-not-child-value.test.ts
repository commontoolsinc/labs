import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { prepareCfcCommitIfNeeded } from "../src/cfc/prepare-shim.ts";
import { cfcLabelsAddress } from "../src/cfc/shared.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase(
  "cfc object enumeration child shape test",
);
const space = signer.did();

const confidentialStringArraySchema = {
  type: "array",
  items: { type: "string" },
  ifc: { classification: ["confidential"] },
} as const satisfies JSONSchema;

describe(
  "CFC prepare: object enumeration consumes child shape, not child value",
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
        "cfc-object-enumeration-source",
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
                classification: ["confidential"],
              },
            },
          },
          "/error/code": {
            shape: {
              classification: ["confidential"],
            },
            value: {
              classification: ["secret"],
            },
          },
          "/error/details": {
            shape: {
              classification: ["confidential"],
            },
            value: {
              classification: ["secret"],
            },
          },
        },
      );
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    }

    it("allows prepare when enumeration only exposes child shape observations", async () => {
      await seedSource();

      const tx = runtime.edit();
      const sourceCell = runtime.getCell<
        { error: { code: number; details: { reason: string } } }
      >(
        space,
        "cfc-object-enumeration-source",
      );
      const targetCell = runtime.getCell<string[]>(
        space,
        "cfc-object-enumeration-target",
      );

      const source = sourceCell.getAsQueryResult(undefined, tx);
      const keys = Object.keys(source.error);
      targetCell.withTx(tx).asSchema(confidentialStringArraySchema).set(keys);

      await expect(prepareCfcCommitIfNeeded(tx)).resolves.toBeUndefined();
      const { error } = await tx.commit();
      expect(error).toBeUndefined();
    });
  },
);
