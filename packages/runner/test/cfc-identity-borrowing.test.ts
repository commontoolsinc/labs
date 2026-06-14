import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-identity-borrowing");

// Regression guard for the write-policy identity fallback (audit S13).
//
// writeAuthorizedBy is verified against the implementation identity captured
// when the write-policy input was recorded. The pre-fix code fell back to the
// transaction's *current* identity (state.implementationIdentity) for inputs
// recorded before any identity was set, so an unattributed write into a
// protected field could borrow a trusted identity set later in the same
// transaction and pass verification. Unattributed writes must fail closed.
describe("CFC write-policy identity borrowing", () => {
  it("does not attribute an unattributed write to a later-set identity", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-identity-borrowing",
        actingPrincipal: signer.did(),
      }),
    });
    try {
      const tx = runtime.edit();
      const schema = {
        type: "object",
        properties: {
          counter: {
            type: "number",
            ifc: {
              // Builtin write-authority claim: only the named builtin may write.
              writeAuthorizedBy: ["trustedIncrement"],
            },
          },
        },
        required: ["counter"],
      } as const satisfies JSONSchema;
      const cell = runtime.getCell(
        signer.did(),
        "cfc-identity-borrowing",
        schema,
        tx,
      );

      // The write is recorded now, while no implementation identity is active —
      // so this write is unattributed.
      cell.set({ counter: 1 });

      // Later in the same transaction a trusted builtin identity becomes active
      // (e.g. an unrelated builtin runs). The earlier unattributed write must
      // NOT borrow it to satisfy writeAuthorizedBy.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "trustedIncrement",
      });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
