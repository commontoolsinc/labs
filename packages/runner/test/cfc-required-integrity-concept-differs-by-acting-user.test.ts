import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { Cell } from "../src/cell.ts";
import type { CfcTrustContext } from "../src/cfc/integrity-trust.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../src/storage/interface.ts";

const trustedSigner = await Identity.fromPassphrase(
  "cfc acting principal trusted runtime",
);
const otherSigner = await Identity.fromPassphrase(
  "cfc acting principal other runtime",
);

const conceptRequiredIntegrity =
  "https://commonfabric.org/cfc/concepts/verified-input";

const conceptRequiredIntegritySchema = {
  type: "number",
  ifc: {
    requiredIntegrity: [conceptRequiredIntegrity],
  },
} as const satisfies JSONSchema;

function createTrustContext(delegator: string): CfcTrustContext {
  return {
    delegations: [{
      delegator,
      verifier: "did:key:cfc-acting-principal-verifier",
      scope: {
        concepts: [conceptRequiredIntegrity],
      },
    }],
    statements: [{
      verifier: "did:key:cfc-acting-principal-verifier",
      concrete: "runtime-attested-source",
      concept: conceptRequiredIntegrity,
    }],
  };
}

async function seedRuntime(
  runtime: Runtime,
  space: MemorySpace,
  sourceName: string,
  targetName: string,
): Promise<{ source: Cell<number>; target: Cell<number> }> {
  let tx = runtime.edit();
  const source = runtime.getCell<number>(space, sourceName, undefined, tx);
  const target = runtime.getCell<number>(space, targetName, undefined, tx);
  source.set(1);
  target.set(0);
  let result = await tx.commit();
  expect(result.error).toBeUndefined();

  tx = runtime.edit();
  tx.writeOrThrow({
    space,
    id: source.getAsNormalizedFullLink().id,
    type: "application/json",
    path: ["cfc", "labels"],
  }, {
    "/": {
      integrity: ["runtime-attested-source"],
    },
  });
  result = await tx.commit();
  expect(result.error).toBeUndefined();

  return { source, target };
}

async function waitForCellValue(
  cell: Cell<number>,
  expected: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await cell.pull();
    if (cell.get() === expected) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe("CFC requiredIntegrity acting principal scoping", () => {
  it("applies concept trust closure for one acting principal but not another through scheduler prepare", async () => {
    const trustedStorageManager = StorageManager.emulate({ as: trustedSigner });
    const untrustedStorageManager = StorageManager.emulate({ as: otherSigner });
    const trustContext = createTrustContext(trustedSigner.did());

    const trustedRuntime = new Runtime({
      storageManager: trustedStorageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: trustContext,
    });
    const untrustedRuntime = new Runtime({
      storageManager: untrustedStorageManager,
      apiUrl: new URL(import.meta.url),
      cfcTrustContext: trustContext,
    });

    trustedRuntime.scheduler.disablePullMode();
    untrustedRuntime.scheduler.disablePullMode();

    try {
      const trustedSpace = trustedSigner.did() as MemorySpace;
      const untrustedSpace = otherSigner.did() as MemorySpace;
      const trusted = await seedRuntime(
        trustedRuntime,
        trustedSpace,
        "cfc-acting-principal-source",
        "cfc-acting-principal-target",
      );
      const untrusted = await seedRuntime(
        untrustedRuntime,
        untrustedSpace,
        "cfc-acting-principal-source",
        "cfc-acting-principal-target",
      );

      const trustedAction = (tx: IExtendedStorageTransaction) => {
        const value = Number(
          trusted.source.withTx(tx).asSchema(conceptRequiredIntegritySchema)
            .get() ?? 0,
        );
        trusted.target.withTx(tx).set(value + 1);
      };
      const untrustedAction = (tx: IExtendedStorageTransaction) => {
        const value = Number(
          untrusted.source.withTx(tx).asSchema(conceptRequiredIntegritySchema)
            .get() ?? 0,
        );
        untrusted.target.withTx(tx).set(value + 1);
      };

      await trustedRuntime.scheduler.run(trustedAction);
      await untrustedRuntime.scheduler.run(untrustedAction);

      expect(await waitForCellValue(trusted.target, 2)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await untrusted.target.pull();
      expect(untrusted.target.get()).toBe(0);
    } finally {
      await trustedRuntime.dispose();
      await untrustedRuntime.dispose();
      await trustedStorageManager.close();
      await untrustedStorageManager.close();
    }
  });
});
