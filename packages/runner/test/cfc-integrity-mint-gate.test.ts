import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-integrity-mint-gate");

// Regression guard for runtime-evidence integrity minting (audit S4).
//
// InjectionSafe is runtime-minted evidence consumed by requiredIntegrity gates
// and the prompt-injection screen. The pre-fix code persisted whatever integrity
// atoms an author declared in ifc.integrity/addIntegrity, so untrusted pattern
// code could self-attach InjectionSafe to a value it controls and then satisfy
// an InjectionSafe requiredIntegrity gate. Author-declared schemas (verified or
// unattributed identity) must not mint runtime-evidence atoms.
const INJECTION_SAFE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
};

describe("CFC integrity mint gate", () => {
  it("does not let an author-declared InjectionSafe satisfy a requiredIntegrity gate", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      // An author persists a source value with a self-attached InjectionSafe
      // integrity atom (plus a confidentiality atom so the read is labeled).
      const seed = runtime.edit();
      const srcSchema = {
        type: "string",
        ifc: {
          confidentiality: ["s"],
          integrity: [INJECTION_SAFE_ATOM],
        },
      } as const satisfies JSONSchema;
      const src = runtime.getCell(
        signer.did(),
        "mint-gate-src",
        srcSchema,
        seed,
      );
      src.set("attacker-controlled");
      seed.prepareCfc();
      expect((await seed.commit()).ok).toBeDefined();

      // A sink requires InjectionSafe integrity on its inputs. The forged atom
      // on the source must not satisfy it.
      const tx = runtime.edit();
      const srcRead = runtime.getCell(
        signer.did(),
        "mint-gate-src",
        srcSchema,
        tx,
      );
      srcRead.get();
      const sink = runtime.getCell(
        signer.did(),
        "mint-gate-sink",
        {
          type: "object",
          properties: {
            out: {
              type: "string",
              ifc: { requiredIntegrity: [INJECTION_SAFE_ATOM] },
            },
          },
          required: ["out"],
        } as const satisfies JSONSchema,
        tx,
      );
      sink.set({ out: "derived" });

      const digest = tx.prepareCfc();
      expect(digest).toBe("");
      const result = await tx.commit();
      expect(result.error?.message).toContain("requiredIntegrity failed");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
