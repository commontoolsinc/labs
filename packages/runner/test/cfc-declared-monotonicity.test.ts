import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-declared-mono");

// WP5 (docs/specs/cfc-persisted-declassification.md §4 item 3, §5; spec
// §8.12.1/§8.12.8): the declared-component monotonicity gate. The declared
// (store-policy) component of a persisted path's label map evolves only
// through the schema-walk re-mint in prepare.ts; §8.12.1's
// `canUpdateStoreLabel` (confidentiality may only add clauses or remove
// alternatives; the integrity claim may only remove atoms) had no runtime
// check — the "never an ordinary write" clause of §8.12.7 route 2b was
// unenforced prose. This suite first PINS current behavior (the
// characterization block — the off/observe byte-compat contract), then
// specifies the gate behind `cfcDeclaredMonotonicity: off | observe |
// enforce` (default off).

const CLAUSE_A = "clause-a";
const CLAUSE_B = "clause-b";
const ATOM_X = "integrity-x";
const ATOM_Y = "integrity-y";

const SCHEMA_TWO_CLAUSES = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { confidentiality: [CLAUSE_A, CLAUSE_B] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_ONE_CLAUSE = {
  type: "object",
  properties: {
    out: { type: "string", ifc: { confidentiality: [CLAUSE_A] } },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_OR_CLAUSE = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [{ anyOf: [CLAUSE_A, CLAUSE_B] }] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_NO_IFC = {
  type: "object",
  properties: {
    out: { type: "string" },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_MINT_X = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [CLAUSE_A], addIntegrity: [ATOM_X] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

const SCHEMA_MINT_XY = {
  type: "object",
  properties: {
    out: {
      type: "string",
      ifc: { confidentiality: [CLAUSE_A], addIntegrity: [ATOM_X, ATOM_Y] },
    },
  },
  required: ["out"],
} as const satisfies JSONSchema;

type PersistedEntry = {
  path: string[];
  origin?: string;
  observes?: string;
  label: {
    confidentiality?: unknown[];
    integrity?: unknown[];
  };
};

const makeRuntime = (opts: {
  storageManager: ReturnType<typeof StorageManager.emulate>;
  cfcEnforcementMode?: "disabled" | "observe" | "enforce-explicit";
  cfcFlowLabels?: "off" | "observe" | "persist";
}) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager: opts.storageManager,
    cfcEnforcementMode: opts.cfcEnforcementMode ?? "enforce-explicit",
    ...(opts.cfcFlowLabels !== undefined
      ? { cfcFlowLabels: opts.cfcFlowLabels }
      : {}),
  });

const persistedEntriesFor = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): PersistedEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: PersistedEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

const declaredEntryAt = (
  entries: PersistedEntry[],
  path: string[],
): PersistedEntry | undefined =>
  entries.find((entry) =>
    (entry.origin === "declared" || entry.origin === undefined) &&
    entry.path.length === path.length &&
    entry.path.every((segment, index) => segment === path[index])
  );

/** Commit a value write through a schema-bearing cell; returns the result. */
const commitWrite = async (
  runtime: Runtime,
  name: string,
  schema: JSONSchema | undefined,
  value: unknown,
): Promise<
  { error?: unknown; docId: string; diagnostics: string[] }
> => {
  const tx = runtime.edit();
  const cell = runtime.getCell(signer.did(), name, schema, tx);
  const docId = cell.getAsNormalizedFullLink().id;
  cell.set(value as never);
  tx.prepareCfc();
  const result = await tx.commit();
  return {
    ...(result.error !== undefined ? { error: result.error } : {}),
    docId,
    diagnostics: [...tx.getCfcState().diagnostics],
  };
};

/**
 * Rewrite the stored declared labelMap entries of an existing doc, keeping
 * the real schemaHash (so the next prepare's stored-schema load succeeds).
 * Runs on a SEPARATE `disabled`-enforcement runtime over the same storage:
 * tests seed stored ["cfc"] metadata via an ungated path-[] full-document
 * write (the shape hydration delivers), and a doc that already carries
 * metadata trips the missing-schema-input reason on enforcing runtimes.
 * The caller owns the seeder runtime and must dispose it only AFTER its last
 * read of the doc — disposing a runtime tears down subscription state shared
 * through the storage manager, and the doc becomes unreadable from the other
 * runtime (verified empirically while pinning this suite).
 */
const rewriteStoredEntries = async (
  seeder: Runtime,
  docId: string,
  mutate: (entries: PersistedEntry[]) => PersistedEntry[],
): Promise<void> => {
  const tx = seeder.edit();
  const document = tx.readOrThrow({
    space: signer.did(),
    id: docId as URI,
    type: "application/json",
    path: [],
  }) as { value?: unknown; cfc?: { labelMap: { entries: PersistedEntry[] } } };
  const cloned = JSON.parse(JSON.stringify(document)) as {
    value?: unknown;
    cfc: {
      version: 1;
      schemaHash: string;
      labelMap: { version: 1; entries: PersistedEntry[] };
    };
  };
  cloned.cfc.labelMap.entries = mutate(cloned.cfc.labelMap.entries);
  tx.writeOrThrow({
    space: signer.did(),
    id: docId as URI,
    type: "application/json",
    path: [],
  }, cloned as never);
  const result = await tx.commit();
  expect(result.error).toBeUndefined();
};

describe("CFC declared-component monotonicity (WP5, §8.12.1/§8.12.8)", () => {
  // ------------------------------------------------------------------
  // Characterization: what the re-mint does TODAY, with no gate dial.
  // These pin the `off`/`observe` byte-compat contract.
  // ------------------------------------------------------------------
  describe("current behavior (characterization — the off/observe contract)", () => {
    it("(a) a schema dropping a confidentiality clause is rejected by the schema merge", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-drop",
          SCHEMA_TWO_CLAUSES,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        // Today the SCHEMA-level weakening guard (mergeCfcSchemaEnvelopes)
        // rejects this route before any entry is re-minted.
        expect(String((second.error as Error | undefined)?.message)).toContain(
          "confidentiality cannot be weakened",
        );
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A, CLAUSE_B]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("(b) a schema adding an alternative to an existing clause is rejected by the schema merge", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-alt",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-alt",
          SCHEMA_OR_CLAUSE,
          { out: "v2" },
        );
        // Replacing clause A with A∨B grows the clause's satisfier set; the
        // schema merge's clause-set subset check rejects it today.
        expect(String((second.error as Error | undefined)?.message)).toContain(
          "confidentiality cannot be weakened",
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("(c) a schema adding an integrity atom silently grows the declared integrity claim", async () => {
      // THE gap the gate closes: §8.12.1 says the declared integrity claim
      // may only shrink, but addIntegrity growth is merge-legal and the
      // re-mint persists the grown claim with no check.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-integ",
          SCHEMA_MINT_X,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const before = declaredEntryAt(
          persistedEntriesFor(storageManager, first.docId),
          ["out"],
        );
        expect(before?.label.integrity).toEqual([ATOM_X]);
        const second = await commitWrite(
          runtime,
          "dm-char-integ",
          SCHEMA_MINT_XY,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const after = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(after?.label.integrity).toEqual([ATOM_X, ATOM_Y]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("(d) a schema declaring nothing where an entry exists keeps the entry (merge restores stored ifc)", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-none",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        const second = await commitWrite(
          runtime,
          "dm-char-none",
          SCHEMA_NO_IFC,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("a stored declared entry stronger than its schema is silently weakened under flow persist", async () => {
      // The entry-level weakening route the schema merge cannot see: the
      // stored declared entry carries confidentiality beyond what the
      // (unchanged) schema declares — an earlier exactCopy mint, an earlier
      // ratchet fold, a peer's write. Under cfcFlowLabels:"persist" the
      // re-mint derives from the schema alone and DROPS the extra clause.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager, cfcFlowLabels: "persist" });
      const seeder = makeRuntime({
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-entry-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(seeder, first.docId, (entries) =>
          entries.map((entry) =>
            entry.origin === "declared" && entry.path.join("/") === "out"
              ? {
                ...entry,
                label: {
                  ...entry.label,
                  confidentiality: [CLAUSE_A, CLAUSE_B],
                },
              }
              : entry
          ));
        const second = await commitWrite(
          runtime,
          "dm-char-entry-drop",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        // CLAUSE_B silently dropped: the non-monotone declared re-mint.
        expect(entry?.label.confidentiality).toEqual([CLAUSE_A]);
      } finally {
        await runtime.dispose();
        await seeder.dispose();
        await storageManager.close();
      }
    });

    it("with flow labels off, the Wave-2 grow-only ratchet folds the stronger stored entry back in", async () => {
      // The dual pin: under the default cfcFlowLabels:"off" the legacy
      // ratchet merges prior confidentiality into the fresh entry, so the
      // confidentiality half of §8.12.1 cannot regress on this path — which
      // is why the gate's confidentiality tests run under flow persist.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = makeRuntime({ storageManager });
      const seeder = makeRuntime({
        storageManager,
        cfcEnforcementMode: "disabled",
      });
      try {
        const first = await commitWrite(
          runtime,
          "dm-char-ratchet",
          SCHEMA_ONE_CLAUSE,
          { out: "v1" },
        );
        expect(first.error).toBeUndefined();
        await rewriteStoredEntries(seeder, first.docId, (entries) =>
          entries.map((entry) =>
            entry.origin === "declared" && entry.path.join("/") === "out"
              ? {
                ...entry,
                label: {
                  ...entry.label,
                  confidentiality: [CLAUSE_A, CLAUSE_B],
                },
              }
              : entry
          ));
        const second = await commitWrite(
          runtime,
          "dm-char-ratchet",
          SCHEMA_ONE_CLAUSE,
          { out: "v2" },
        );
        expect(second.error).toBeUndefined();
        const entry = declaredEntryAt(
          persistedEntriesFor(storageManager, second.docId),
          ["out"],
        );
        expect(entry?.label.confidentiality).toEqual(
          expect.arrayContaining([CLAUSE_A, CLAUSE_B]),
        );
      } finally {
        await runtime.dispose();
        await seeder.dispose();
        await storageManager.close();
      }
    });
  });
});
