import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { mergeCfcSchemaEnvelopes } from "../src/cfc/schema-merge.ts";
import { NAME, UI } from "../src/builder/types.ts";
import type { JSONSchema, JSONSchemaObj } from "../src/builder/types.ts";

// Why: reproduces the live Estuary "home stays bricked" incident's next layer.
// The cold-start-setup-repair materializes the real home pattern over a home
// root doc that predates some of home's fields, and CFC schema-merge's
// additive-required guard ("required field <name> needs a default to preserve
// old documents") refuses the setup commit. #4933 defaulted the six DATA
// fields (favorites/journal/spaces/defaultAppUrl/profiles/mru), but that only
// advanced the rejection to the next required-no-default field: `defaultProfile`
// (genuinely `… | undefined`, so it should be optional) and then the six
// exported handler streams — which cannot carry a meaningful `Default<>` and
// so cannot be healed the #4933 way.
//
// These tests run with CFC enforcement ON (the runtime default,
// "enforce-explicit"); the piece cold-start harness runs with enforcement
// disabled, which is why #4926/#4933's tests were blind to this layer.

const alice = await Identity.fromPassphrase(
  "cfc-additive-default-preserves-old-doc-alice",
);

const OWNER_WRITER = "system.legacy-home";

const ownerProtectedString = (ownerDid: string): JSONSchema => ({
  type: "string",
  ifc: {
    ownerPrincipal: ownerDid,
    addIntegrity: [{ kind: "represents-principal", subject: ownerDid }],
    writeAuthorizedBy: [OWNER_WRITER],
  },
});

// A realistic pre-favorites home root: it once ran a home setup, so it carries
// the primordial framework projection keys ($NAME/$UI) and an owner-protected
// field (so the root is cfc-relevant / has stored CFC metadata), but it
// predates favorites and the handlers that shipped with it — exactly the
// vintage whose repair throws additive-required.
const legacyHomeSchema = (ownerDid: string): JSONSchema => ({
  type: "object",
  properties: {
    [NAME]: { type: "string" },
    [UI]: { type: "unknown" },
    owner: ownerProtectedString(ownerDid),
  },
  required: [NAME, UI, "owner"],
});

const compileHomePattern = async (
  runtime: Runtime,
  space: ReturnType<typeof alice.did>,
) => {
  const repoRoot = new URL("../../..", import.meta.url).pathname.replace(
    /\/$/,
    "",
  );
  const sourcePath = new URL(
    "../../patterns/system/home.tsx",
    import.meta.url,
  ).pathname;
  const program = await runtime.harness.resolve(
    new FileSystemProgramResolver(sourcePath, repoRoot),
  );
  return await runtime.patternManager.compilePattern(program, { space });
};

describe("CFC additive-required default preserves old documents", () => {
  // Tight pin on the guard itself: a newly-required STREAM slot must not need
  // a default (a stream carries no preservable document value), while a plain
  // newly-required data field still must. This isolates the schema-merge fix
  // from the full home compile.
  it("exempts an additive-required stream slot from the default requirement", () => {
    const stored: JSONSchema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const candidate: JSONSchema = {
      type: "object",
      properties: {
        owner: { type: "string" },
        // A handler stream slot, exactly as the schema-generator emits home's
        // exported handlers.
        addFavorite: {
          type: "object",
          properties: {},
          asCell: ["stream"],
        },
      },
      required: ["owner", "addFavorite"],
    };
    // Before the fix this threw: "required field addFavorite needs a default".
    const merged = mergeCfcSchemaEnvelopes(stored, candidate) as JSONSchemaObj;
    expect(merged.required).toContain("addFavorite");
  });

  it("still rejects an additive-required plain data field without a default", () => {
    const stored: JSONSchema = {
      type: "object",
      properties: { owner: { type: "string" } },
      required: ["owner"],
    };
    const candidate: JSONSchema = {
      type: "object",
      properties: {
        owner: { type: "string" },
        title: { type: "string" },
      },
      required: ["owner", "title"],
    };
    expect(() => mergeCfcSchemaEnvelopes(stored, candidate)).toThrow(
      /required field title needs a default/,
    );
  });

  // Faithful end-to-end: run the real home pattern's setup over a realistic
  // old home root, with enforcement ON. Before the fix, the setup commit is
  // rejected (defaultProfile, then the handler streams). After the fix it
  // commits and the home heals.
  it("materializes the real home pattern over a pre-favorites root under enforcement", async () => {
    const storageManager = StorageManager.emulate({ as: alice });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    const space = alice.did();
    const ROOT = "legacy-home-root";
    try {
      // 1. Seed the "old" home root doc (with stored CFC metadata) lacking
      //    favorites and the handlers.
      {
        const tx = runtime.edit();
        tx.setCfcEnforcementMode("enforce-explicit");
        tx.setCfcTrustSnapshot({
          id: `trust-${space}`,
          actingPrincipal: space,
        });
        tx.setCfcImplementationIdentity({
          kind: "builtin",
          builtinId: OWNER_WRITER,
        });
        const cell = runtime.getCell(
          space,
          ROOT,
          legacyHomeSchema(space),
          tx,
        );
        cell.set({
          [NAME]: "Legacy Home (pre-setup)",
          [UI]: null,
          owner: "alice",
        });
        const target = cell.getAsNormalizedFullLink();
        tx.recordCfcWritePolicyInput({
          kind: "trusted-event",
          target: {
            space: target.space,
            scope: target.scope,
            id: target.id,
            path: ["owner"],
          },
          eventId: "seed-owner",
          provenance: { origin: "dom", trusted: true },
        });
        tx.prepareCfc();
        const res = await tx.commit();
        expect(res.ok).toBeDefined();
      }

      // 2. Materialize the real home pattern over the SAME root cell
      //    (enforce-explicit is the runtime default).
      const homePattern = await compileHomePattern(runtime, space);
      const resultCell = runtime.getCell(space, ROOT);
      const home = await runtime.runSynced(resultCell, homePattern, {});
      await home.pull();
      await runtime.idle();

      // Discriminator: the setup projection only overwrites the root's $NAME
      // with the pattern's "Home" if its commit actually LANDED. When the
      // additive-required guard rejects the commit, the transaction aborts and
      // the seeded legacy name survives — so this assertion fails exactly when
      // the setup was refused (the reproduced bricked-home behavior).
      expect(home.key(NAME).get()).toBe("Home");
      // And favorites materialized to its defaulted empty list.
      const favorites = home.key("favorites");
      expect(favorites.get() ?? []).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
