import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-tx-control-guard");

// Regression guard for the transaction control surface (audit S3).
//
// setCfcEnforcementMode / prepareCfc are on the public IExtendedStorageTransaction
// and cell.tx is public, so code holding a Cell can reach them. prepareCfc was
// fixed to always verify (S2); the remaining weakening lever is
// setCfcEnforcementMode lowering an enforcing transaction back to disabled/observe.
// The mode must not be lowerable below the highest enforcing level set on a tx.
describe("CFC transaction control guard", () => {
  it("refuses to weaken an enforcing transaction's mode", () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      expect(tx.getCfcState().enforcementMode).toBe("enforce-explicit");

      // Downgrades to weaker modes must throw.
      expect(() => tx.setCfcEnforcementMode("disabled")).toThrow();
      expect(() => tx.setCfcEnforcementMode("observe")).toThrow();

      // Mode is unchanged after the rejected downgrades.
      expect(tx.getCfcState().enforcementMode).toBe("enforce-explicit");

      // Raising strictness is still allowed.
      expect(() => tx.setCfcEnforcementMode("enforce-strict")).not.toThrow();
      expect(tx.getCfcState().enforcementMode).toBe("enforce-strict");

      // ...and cannot then be lowered back to a weaker enforcing level.
      expect(() => tx.setCfcEnforcementMode("enforce-explicit")).toThrow();
    } finally {
      runtime.dispose();
      storageManager.close();
    }
  });

  it("allows juggling non-enforcing modes before any enforcement", () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      // disabled <-> observe impose no floor (neither enforces).
      expect(() => tx.setCfcEnforcementMode("observe")).not.toThrow();
      expect(() => tx.setCfcEnforcementMode("disabled")).not.toThrow();
      expect(() => tx.setCfcEnforcementMode("enforce-explicit")).not.toThrow();
      // Now the floor is set.
      expect(() => tx.setCfcEnforcementMode("observe")).toThrow();
    } finally {
      runtime.dispose();
      storageManager.close();
    }
  });

  it("still rejects a violation after a blocked downgrade attempt", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-tx-control-guard",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          savedTitle: {
            type: "string",
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: {
                  file: "/main.tsx",
                  path: ["commitTrustedSaveTitle"],
                },
              },
            },
          },
        },
        required: ["savedTitle"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-tx-control-guard",
        schema,
        tx,
      );
      cell.set({ savedTitle: "not user authorized" });

      // Attacker tries to disable enforcement, then commit the violation.
      expect(() => tx.setCfcEnforcementMode("disabled")).toThrow();
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
