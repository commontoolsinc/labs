import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";

const signer = await Identity.fromPassphrase("runner-cfc-link-integrity-gate");

const INJECTION_SAFE_ATOM = {
  type: "https://commonfabric.org/cfc/atom/InjectionSafe",
};

type StoredCfcDocument = {
  cfc?: {
    labelMap?: {
      entries: Array<
        {
          path: string[];
          label: {
            confidentiality?: unknown[];
            integrity?: Array<{ type?: string }>;
          };
        }
      >;
    };
  };
};

// Regression guard for runtime-evidence atoms on the link-write path (audit S4
// review follow-up). The integrity mint gate originally covered only
// schema-derived labels; an author could persist a forged InjectionSafe through
// a link's carried label view (or embedded link schema) and later satisfy an
// InjectionSafe requiredIntegrity gate. Author-influenced link labels must be
// gated too; only the runtime-minted LinkReference survives.
describe("CFC link-write integrity gate", () => {
  it("filters a forged InjectionSafe carried on a link's label view", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-link-integrity-target",
        undefined,
        tx,
      );
      const targetId = target.getAsNormalizedFullLink().id;

      // A plain value write makes the target a CFC write target.
      tx.markCfcRelevant("test");
      tx.writeValueOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value", "field"],
      }, "v");

      // Forge a link-write policy input whose carried label view attaches an
      // InjectionSafe integrity atom (author-controlled).
      tx.recordCfcWritePolicyInput({
        kind: "link-write",
        target: {
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "field"],
        },
        source: {
          space: signer.did(),
          scope: "space",
          id: "of:cfc-link-integrity-source",
          path: ["value"],
        },
        cfcLabelView: {
          version: 1,
          entries: [{
            path: [],
            label: {
              confidentiality: ["leak"],
              integrity: [INJECTION_SAFE_ATOM],
            },
          }],
        },
      });

      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(target.getAsLink()).id!;
      const document = storageManager.open(signer.did()).replica.getDocument(
        persistedId,
      ) as StoredCfcDocument | undefined;
      const entries = document?.cfc?.labelMap?.entries ??
        [];
      const allIntegrity = entries.flatMap((e) => e.label.integrity ?? []);
      // The forged InjectionSafe must not have been persisted anywhere.
      expect(
        allIntegrity.some((a) => a?.type?.endsWith("/InjectionSafe")),
      ).toBe(false);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
