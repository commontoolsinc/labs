import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-labelmap-monotone");

// Regression guard for labelMap store-confidentiality monotonicity (audit S9).
//
// A persisted path can carry confidentiality beyond what its schema declares
// (link-derived or carried-view atoms). The persist path re-derived the label
// from the schema alone and replaced the stored entry, dropping that extra
// confidentiality — a non-monotone downgrade (§8.12.1: store confidentiality is
// grow-only). A re-write must preserve it.
describe("CFC labelMap confidentiality monotonicity", () => {
  it("preserves stored confidentiality beyond the schema on a re-write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const guarded = internSchema(
        {
          type: "object",
          properties: {
            secret: { type: "string", ifc: { confidentiality: ["base"] } },
          },
          required: ["secret"],
        } satisfies JSONSchema,
        true,
      );

      // Seed a stored state whose labelMap carries an extra confidentiality atom
      // ("link-derived") beyond the schema's declared ["base"].
      const seed = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone",
        undefined,
        seed,
      );
      const targetId = target.getAsNormalizedFullLink().id;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: [],
      }, {
        value: { secret: "seeded" },
        cfc: {
          version: 1,
          schemaHash: guarded.taggedHashString,
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["base", "link-derived"] },
            }],
          },
        },
      });
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: `cid:${guarded.taggedHashString}`,
        path: [],
      }, { value: guarded.schema });
      expect((await seed.commit()).ok).toBeDefined();

      // Re-write the path through its schema (which declares only ["base"]).
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "cfc-labelmap-monotone",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "updated" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const persistedId = parseLink(cell.getAsLink()).id!;
      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                { path: string[]; label: { confidentiality?: string[] } }
              >;
            };
          };
        } | undefined;
      };
      const entry = replica.getDocument(persistedId)?.cfc?.labelMap?.entries
        .find((e) => e.path.length === 1 && e.path[0] === "secret");
      expect(entry).toBeDefined();
      expect([...(entry!.label.confidentiality ?? [])].sort()).toEqual(
        ["base", "link-derived"],
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
