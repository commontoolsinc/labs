import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-redundant-collapse");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: unknown[]; integrity?: unknown[] };
  origin?: string;
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id)?.cfc?.labelMap?.entries ?? [];
};

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });

// A list whose elements the schema declares `Resource(Secret)` on. The
// declared entry lands at the wildcard child path `["*"]`, which covers every
// index and `length`.
const labeledListSchema = {
  type: "array",
  items: {
    type: "string",
    ifc: { confidentiality: [cfcAtom.resource("Secret")] },
  },
} as unknown as JSONSchema;

// Seed a document carrying `confidentiality` on its `secret` field, so a
// transaction reading it takes those clauses into the per-transaction join.
const seedSource = async (
  runtime: Runtime,
  name: string,
  confidentiality: readonly FabricValue[],
) => {
  const seed = runtime.edit();
  const source = runtime.getCell(signer.did(), name, {
    type: "object",
    properties: { secret: { type: "string" } },
  } as JSONSchema);
  const sourceId = source.getAsNormalizedFullLink().id;
  writeSeedEnvelopeDoc(seed, signer.did());
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: sourceId,
    path: [],
  }, {
    value: { secret: "s3cr3t" },
    cfc: {
      version: 1,
      schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: [...confidentiality] },
        }],
      },
    },
  });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC redundant entry collapse", () => {
  // A `derived` or `structure` entry whose clauses the declared component
  // already carries at the same path adds nothing to the label a boundary
  // resolves: `labelForEntriesAtPath` resolves each component separately and
  // joins the results, and the join deduplicates clauses structurally. Such
  // an entry is dropped at persist time (spec §4.6.4).

  it("holds a labeled list's label map at its declared entry across appends", async () => {
    // Appending reads the list through its own element declaration, so the
    // transaction's join is that declaration. Stamping the join onto the new
    // index would record there what the `["*"]` entry already says, and the
    // metadata templates derived from those stamps would follow — five
    // entries per element, for the life of the list.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const seeded = runtime.edit();
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-labeled-list",
        labeledListSchema,
        seeded,
      ).set(["seed"]);
      seeded.prepareCfc();
      expect((await seeded.commit()).ok).toBeDefined();

      const listId = runtime
        .getCell<string[]>(
          signer.did(),
          "collapse-labeled-list",
          labeledListSchema,
        )
        .getAsNormalizedFullLink().id;
      const seededEntries = replicaEntries(storageManager, listId);
      expect(seededEntries).toEqual([{
        path: ["*"],
        label: { confidentiality: [cfcAtom.resource("Secret")] },
        origin: "declared",
      }]);

      for (const element of ["A", "B", "C"]) {
        const tx = runtime.edit();
        runtime.getCell<string[]>(
          signer.did(),
          "collapse-labeled-list",
          labeledListSchema,
          tx,
        ).push(element);
        tx.prepareCfc();
        // Nothing to say about the envelope means no envelope write: the
        // SC-11 canonical comparison finds the recomputed metadata identical
        // and the append leaves the `["cfc"]` document alone.
        expect(
          [...(tx.getWriteDetails?.(signer.did()) ?? [])].filter((write) =>
            write.address.id === listId && write.address.path[0] === "cfc"
          ),
        ).toEqual([]);
        expect((await tx.commit()).ok).toBeDefined();
      }

      expect(replicaEntries(storageManager, listId)).toEqual(seededEntries);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp carrying a clause the declared component does not", async () => {
    // The join of an append that also read an unrelated labeled source
    // carries a clause the element declaration does not, so the stamp is
    // the only place that clause is recorded at the appended index.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-foreign-source", [
        cfcAtom.resource("Other"),
      ]);

      const seeded = runtime.edit();
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-mixed-list",
        labeledListSchema,
        seeded,
      ).set(["seed"]);
      seeded.prepareCfc();
      expect((await seeded.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-foreign-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      runtime.getCell<string[]>(
        signer.did(),
        "collapse-mixed-list",
        labeledListSchema,
        tx,
      ).push(`${raw.secret}!`);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const listId = runtime
        .getCell<string[]>(
          signer.did(),
          "collapse-mixed-list",
          labeledListSchema,
        )
        .getAsNormalizedFullLink().id;
      const stamped = replicaEntries(storageManager, listId).filter((entry) =>
        entry.origin === "derived" && entry.path.join("/") === "1"
      );
      expect(stamped.length).toBeGreaterThan(0);
      for (const entry of stamped) {
        expect(entry.label.confidentiality).toContainEqual(
          cfcAtom.resource("Other"),
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps the root stamps a wildcard child declaration does not reach", async () => {
    // A declared entry at `["*"]` covers the children and not the container
    // node they hang off, so the stamps recording what the container's own
    // write derived from stay where they are.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-container-source", [
        cfcAtom.resource("Outer"),
      ]);

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-container-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const map = runtime.getCell<Record<string, string>>(
        signer.did(),
        "collapse-container-map",
        {
          type: "object",
          additionalProperties: {
            type: "string",
            ifc: { confidentiality: [cfcAtom.resource("Secret")] },
          },
        } as unknown as JSONSchema,
        tx,
      );
      map.set({ first: `${raw.secret}!` });
      const mapId = map.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, mapId);
      expect(
        entries.some((entry) =>
          entry.origin === "declared" && entry.path.join("/") === "*"
        ),
      ).toBe(true);
      const rootStamps = entries.filter((entry) =>
        entry.origin === "derived" && entry.path.length === 0
      );
      expect(rootStamps.length).toBeGreaterThan(0);
      for (const entry of rootStamps) {
        expect(entry.label.confidentiality).toContainEqual(
          cfcAtom.resource("Outer"),
        );
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps a stamp a more specific declared entry sits below", async () => {
    // The declared component resolves by longest matching prefix, so the
    // `["inner"]` declaration replaces the root declaration for reads at that
    // path. A root stamp the root declaration covers is therefore not covered
    // one segment down, and dropping it would lower the label there.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSource(runtime, "collapse-nested-source", [
        cfcAtom.resource("Outer"),
      ]);

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "collapse-nested-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const target = runtime.getCell<{ inner?: string }>(
        signer.did(),
        "collapse-nested-target",
        {
          type: "object",
          properties: {
            inner: {
              type: "string",
              ifc: { confidentiality: [cfcAtom.resource("Inner")] },
            },
          },
          ifc: { confidentiality: [cfcAtom.resource("Outer")] },
        } as unknown as JSONSchema,
        tx,
      );
      target.set({ inner: `${raw.secret}!` });
      const targetId = target.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, targetId);
      const rootStamps = entries.filter((entry) =>
        entry.origin === "derived" && entry.path.length === 0
      );
      expect(rootStamps.length).toBeGreaterThan(0);
      for (const entry of rootStamps) {
        expect(entry.label.confidentiality).toEqual([
          cfcAtom.resource("Outer"),
        ]);
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
