import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { PreparedDigestInput } from "../src/cfc/mod.ts";

const signer = await Identity.fromPassphrase("runner-cfc-prepare-bypass-tests");

type PrepareCfcBypassProbe = {
  buildPreparedDigestInput?: () => PreparedDigestInput;
  prepareCfc(input: PreparedDigestInput): string;
};

// Regression guard for the prepareCfc verification-bypass (audit S2).
//
// The hole: prepareCfc(input) skipped prepareBoundaryCommit whenever an input
// was supplied, and the commit-time digest recheck only confirms the input
// matches real activity — not that policy verification ran. Untrusted code
// holding the transaction could reconstruct the genuine prepared-digest input
// from the public read/write getters, hand it to prepareCfc, and commit a
// policy-violating transaction cleanly.
//
// The fix removes the input parameter entirely so verification always runs.
// This test pins the behavioural contract: a relevant, policy-violating
// transaction can never reach a committed state through prepareCfc.
describe("CFC prepareCfc verification bypass", () => {
  it("rejects a writeAuthorizedBy violation even when prepareCfc is driven directly", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      trustSnapshotProvider: () => ({
        id: "trust-snapshot-prepare-bypass",
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
        "cfc-prepare-bypass",
        schema,
        tx,
      );
      // Unauthorized write into a writeAuthorizedBy-protected field.
      cell.set({ savedTitle: "not user authorized" });

      // Even if a caller reconstructs the genuine prepared-digest input from the
      // public transaction surfaces, there is no way to feed it to prepareCfc:
      // the parameter was removed (audit S2) so verification always runs. Pin
      // that prepareCfc accepts no argument and still rejects the violation.
      const prepareProbe = tx as unknown as PrepareCfcBypassProbe;
      const attackerInput = prepareProbe.buildPreparedDigestInput?.();
      expect(attackerInput).toBeDefined();
      if (attackerInput === undefined) {
        throw new Error("expected prepared digest input");
      }
      expect(() => prepareProbe.prepareCfc(attackerInput)).not.toThrow();

      // Verification must have run and invalidated the transaction regardless of
      // the ignored extra argument.
      expect(tx.getCfcState().prepare.status).toBe("invalidated");

      const result = await tx.commit();
      expect(result.error).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
