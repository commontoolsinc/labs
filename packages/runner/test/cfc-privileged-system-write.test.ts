import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { internSchema } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { storedCfcMetadataAppliesToPath } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-privileged-system-write",
);

// Audit S18: a write addressed directly at a document's ["cfc"] label-map path
// forges the CFC metadata that drives label derivation for OTHER writes,
// bypassing the commit-boundary derivation + mint-gating (S4) entirely. Only the
// runtime's own persistence (inside prepareBoundaryCommit's privileged scope)
// may write there; a non-privileged ["cfc"] write must fail closed in enforce
// mode and surface a diagnostic in observe. The forgery is the write PATH, not
// the hash: it names the backed seed document so the observe/disabled arms
// reach their commit outcome instead of refusing at the storage boundary for
// an unbacked schema reference.
const forgedMetadata = {
  version: 1,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: {
    version: 1,
    entries: [{
      path: [],
      // The exact runtime-evidence atom the prompt-injection screen trusts.
      label: { integrity: [{ kind: "InjectionSafe" }] },
    }],
  },
};

describe("CFC privileged system write (S18)", () => {
  it("rejects a non-privileged ['cfc'] metadata write in enforce mode", async () => {
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
        "s18-forge-enforce",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Backed here too: the S18 gate must be the ONLY thing that can
      // reject this transaction, never the storage boundary's closure check.
      writeSeedEnvelopeDoc(tx, signer.did());
      // Forge the label map directly at the document's ["cfc"] path.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      // Prepared, so the commit's rejection carries the S18 reason itself
      // rather than the generic relevant-but-unprepared guard.
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(String((result.error as Error).message)).toContain(
        "unprivileged write to protected cfc path",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("allows the write but records a diagnostic in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-observe",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.toLowerCase().includes("unprivileged") && d.includes("cfc")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("exposes no privilege-escalation method on the transaction (S18 review)", async () => {
    // The reviewer's scenario: (cell.tx as any).runPrivilegedSystemWrite(() =>
    // cell.tx.writeOrThrow({ path: ["cfc"] }, forged)). The scope is now an
    // ECMAScript #private method, so no such property exists on the tx — and a
    // direct ["cfc"] write therefore still fails closed.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const escalate = (tx as unknown as Record<string, unknown>)
        .runPrivilegedSystemWrite;
      expect(escalate).toBeUndefined();
      // And nothing under the tx wrapper exposes it either.
      const inner = (tx as unknown as { tx?: Record<string, unknown> }).tx;
      expect(inner?.runPrivilegedSystemWrite).toBeUndefined();
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("permits the runtime's own label persistence (privileged) to commit", async () => {
    // A normal labeled write: the runtime derives + persists ["cfc"] metadata
    // inside prepareBoundaryCommit's privileged scope. This must NOT trip the
    // guard — i.e. legitimate CFC persistence still commits in enforce mode.
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
      const tx = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "s18-legit-persist",
        guarded.schema,
        tx,
      );
      cell.set({ secret: "value" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a ['cfc'] write made while disabled so a mid-tx escalation to enforce rejects", async () => {
    // setCfcEnforcementMode permits raising the mode mid-transaction
    // (disabled/observe impose no floor — audit S3), so a forged ["cfc"] write
    // performed in a disabled window must not survive a later escalation to
    // enforce. Like every other CFC signal, the write is recorded
    // unconditionally and only evaluated against the mode at prepare/commit
    // time.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-escalate",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      // Backed here too: the S18 gate must be the ONLY thing that can
      // reject this transaction, never the storage boundary's closure check.
      writeSeedEnvelopeDoc(tx, signer.did());
      // Forge the label map while the transaction is still disabled.
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);
      // The forgery is recorded even though enforcement is disabled.
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(1);

      tx.setCfcEnforcementMode("enforce-explicit");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(String((result.error as Error).message)).toContain(
        "unprivileged write to protected cfc path",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("still commits a never-escalated transaction under disabled mode", async () => {
    // `disabled` leaves CFC inert end-to-end: the forged write is recorded
    // (see above) but prepareBoundaryCommit never runs for a transaction whose
    // mode is still disabled at commit, so nothing turns the record into a
    // rejection.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const tx = runtime.edit();
      const target = runtime.getCell(
        signer.did(),
        "s18-forge-disabled",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      tx.writeOrThrow({
        space: signer.did(),
        id,
        type: "application/json",
        path: ["cfc"],
      }, forgedMetadata);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate value-path writes", async () => {
    // The Cell API writes value paths, never the document ["cfc"] field, so
    // ordinary pattern writes are unaffected.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const tx = runtime.edit();
      const plain = runtime.getCell<{ note: string }>(
        signer.did(),
        "s18-plain-value",
        undefined,
        tx,
      );
      plain.set({ note: "hello" });
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a path-[] full-document write carrying a cfc field", async () => {
    // Open residual: a path-[] full-document write that leaves a label map
    // behind is not gated, whether it mints one where the document stored
    // none or substitutes one for another. This is the raw-seed idiom the CFC
    // tests are built on (seedPrivilegedCfc in cfc-boundary.test.ts, and the
    // metadata re-pointing in speculation-overlay.test.ts), and it is
    // reachable from untrusted code: a handler holds a runtime cell and the
    // transaction it is bound to addresses the whole document
    // (docs/plans/runner_cfc_implementation.md "Document Surface Rules").
    // The meta seam is gated across both addressing modes
    // (meta-seam-write-authorization.test.ts); label-map forgery through the
    // document root is what this test records as ungated. This case mints
    // onto a document that stored no map; the case below strips a live one. A
    // root write that leaves NO readable map behind is a different case and
    // IS gated — see the erasure cases after that.
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
        "s18-root-seed",
        undefined,
        tx,
      );
      const id = target.getAsNormalizedFullLink().id as URI;
      writeSeedEnvelopeDoc(tx, signer.did());
      // Mirror seedPrivilegedCfc: read the current doc, then write the whole
      // envelope at path [] with the cfc record embedded.
      const docAddress = {
        space: signer.did(),
        id,
        type: "application/json" as const,
        path: [],
      };
      let current: unknown;
      try {
        current = tx.readOrThrow(docAddress);
      } catch {
        current = undefined;
      }
      const base = current && typeof current === "object" ? current : {};
      tx.writeOrThrow(
        docAddress,
        { ...base, cfc: forgedMetadata },
      );
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  //
  // Root envelope writes and the stored label map
  //
  // A path-[] whole-document write replaces every sibling of `value`, the
  // ["cfc"] label map included. An envelope that omits `cfc` therefore erases
  // the stored map, and the document that carried confidentiality reads
  // afterwards as carrying none. That is the S18 downgrade spelled as an
  // omission rather than as an overwrite, so it is recorded as the same class
  // of unprivileged label-map write. The cases below cover the erasure, the
  // shapes that erase nothing, and the runtime's own exempt persistence.
  //

  const storedMetadata = {
    version: 1,
    schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
    labelMap: {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: ["secret"] },
      }],
    },
  };

  const seedLabeledDocument = async (
    runtime: Runtime,
    name: string,
  ): Promise<{
    space: ReturnType<typeof signer.did>;
    id: URI;
    type: "application/json";
    path: string[];
  }> => {
    const seed = runtime.edit();
    const target = runtime.getCell(signer.did(), name, undefined, seed);
    const address = {
      space: signer.did(),
      id: target.getAsNormalizedFullLink().id as URI,
      type: "application/json" as const,
      path: [] as string[],
    };
    // The commit boundary validates a metadata `schemaHash` like any other
    // schema reference, so the seed names the backed seed document and
    // installs it in the same transaction.
    writeSeedEnvelopeDoc(seed, signer.did());
    seed.writeOrThrow(address, { value: { note: "one" }, cfc: storedMetadata });
    const seedResult = await seed.commit();
    expect(seedResult.ok).toBeDefined();
    return address;
  };

  it("rejects a root envelope write that erases a stored label map", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-erase");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
        `${address.id}/cfc`,
      ]);

      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(String((result.error as Error).message).toLowerCase()).toContain(
        "cfc",
      );

      // The stored label map survives the refused commit.
      const after = runtime.edit();
      expect(after.readOrThrow({ ...address, path: ["cfc"] })).toEqual(
        storedMetadata,
      );
      await after.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a loaded writer stripping a live label map to an empty one", async () => {
    // The half of the forge residual that decides how much the erasure arm
    // above is worth. A writer holding the document — the arm's best case,
    // where its transaction-local read sees the stored map — strips every
    // label by substituting a well-formed map with no entries. Nothing is
    // recorded, the commit lands, and policy then applies on no path at all:
    // the same unlabeled document an erasure would leave, reached without
    // ever dropping the member.
    //
    // So an erasure gate is not the boundary here while this stands. It is
    // pinned rather than described because it is what a reader weighing the
    // erasure arm's reach needs to see, and because it fails the day the
    // forge residual closes.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-strip");
      const target = {
        space: signer.did(),
        id: address.id,
        scope: "space",
        path: [],
      } as const;

      const before = runtime.edit();
      expect(storedCfcMetadataAppliesToPath(before, target)).toBe(true);
      await before.commit();

      const tx = runtime.edit();
      const envelope = tx.readOrThrow(address) as Record<string, unknown>;
      expect(envelope.cfc).toBeDefined();
      tx.writeOrThrow(address, {
        ...envelope,
        value: { note: "stripped" },
        cfc: { ...storedMetadata, labelMap: { version: 1, entries: [] } },
      });
      expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([]);
      expect((await tx.commit()).ok).toBeDefined();

      const after = runtime.edit();
      expect(storedCfcMetadataAppliesToPath(after, target)).toBe(false);
      await after.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a root envelope write on a document with no stored label map", async () => {
    // Creating a document, and replacing one that never carried a label map,
    // erase nothing — the ordinary seeding shape stays ungated.

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
        "s18-root-unlabeled",
        undefined,
        tx,
      );
      const address = {
        space: signer.did(),
        id: target.getAsNormalizedFullLink().id as URI,
        type: "application/json" as const,
        path: [] as string[],
      };
      tx.writeOrThrow(address, { value: { note: "one" } });
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a root envelope write that carries the stored label map forward", async () => {
    // Spreading the read envelope, the way ACLManager does, keeps `cfc` in
    // place. That write is not an erasure and stays ungated.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-preserve");

      const tx = runtime.edit();
      const envelope = tx.readOrThrow(address) as Record<string, unknown>;
      tx.writeOrThrow(address, { ...envelope, value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);

      const result = await tx.commit();
      expect(result.ok).toBeDefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a root envelope whose cfc member a reader reports as absent", async () => {
    // Carrying the key is not carrying the map. `cfc: null` — and every other
    // value `readStoredCfcMetadata` reports as absent — leaves the document
    // reading as an unlabeled one, so it erases the stored map exactly as an
    // envelope with no `cfc` member does.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      for (
        const [name, malformed] of [
          ["s18-root-null", null],
          ["s18-root-scalar", "not-an-envelope"],
          ["s18-root-versionless", { labelMap: { version: 1, entries: [] } }],
        ] as const
      ) {
        const address = await seedLabeledDocument(runtime, name);
        const tx = runtime.edit();
        tx.writeOrThrow(address, { value: { note: "two" }, cfc: malformed });
        expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([
          `${address.id}/cfc`,
        ]);
        expect((await tx.commit()).error).toBeDefined();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not gate a root envelope carrying a label map this build cannot read", async () => {
    // An envelope whose `version` this build does not interpret is not an
    // erasure: the reader throws on it and every consumer fails closed, so the
    // document it leaves behind is not an unlabeled one.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-future");
      const tx = runtime.edit();
      tx.writeOrThrow(address, {
        value: { note: "two" },
        cfc: { ...storedMetadata, version: 99 },
      });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("diagnoses a label-map erasure in observe mode", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-observe");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.toLowerCase().includes("unprivileged") && d.includes("cfc")
        ),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("records a label-map erasure made while disabled so a mid-tx escalation rejects", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    try {
      const address = await seedLabeledDocument(runtime, "s18-root-escalate");

      const tx = runtime.edit();
      tx.writeOrThrow(address, { value: { note: "two" } });
      expect(tx.getCfcState().unprivilegedSystemWrites.length).toBe(1);

      tx.setCfcEnforcementMode("enforce-explicit");
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(String((result.error as Error).message).toLowerCase()).toContain(
        "cfc",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("permits the runtime's own privileged root write over a labeled document", async () => {
    // The privileged scope is exempt, so the runtime's own persistence still
    // replaces an envelope wholesale without tripping the erasure arm.

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
      const first = runtime.edit();
      const cell = runtime.getCell(
        signer.did(),
        "s18-root-privileged",
        guarded.schema,
        first,
      );
      cell.set({ secret: "one" });
      first.prepareCfc();
      expect((await first.commit()).ok).toBeDefined();

      // The label persistence stored a map; a second labeled write reruns the
      // whole privileged persistence pass over the same document.
      const second = runtime.edit();
      const again = runtime.getCell(
        signer.did(),
        "s18-root-privileged",
        guarded.schema,
        second,
      );
      again.set({ secret: "two" });
      second.prepareCfc();
      expect((await second.commit()).ok).toBeDefined();

      const after = runtime.edit();
      expect(
        after.readOrThrow({
          space: signer.did(),
          id: again.getAsNormalizedFullLink().id as URI,
          type: "application/json",
          path: ["cfc"],
        }),
      ).toBeDefined();
      await after.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("does not reach a writer whose transaction never loaded the document", async () => {
    // The bound on the arm above, pinned rather than described. The stored
    // half reads through the writing transaction, and a transaction whose
    // view does not hold the document answers the same "no map here" a
    // document with no map answers. So a writer that simply does not sync
    // first erases the map and commits: no race, the map present throughout.
    //
    // What the arm establishes is therefore narrower than "a root envelope
    // write cannot erase a stored label map" — it is that such a write cannot
    // erase a label map THIS TRANSACTION HAS LOADED. Closing the rest means
    // either forcing the document into view before deciding, which turns
    // every blind root write into a read-modify-write, or making the commit
    // boundary establish what the space holds. Both are open design choices,
    // and this test fails when either lands, which is the point of it.
    const server: MemoryV2Server.Server = await newSharedServer();
    const space = signer.did();
    let id: URI;
    try {
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
          cfcEnforcementMode: "enforce-explicit",
        });
        try {
          const seed = runtime.edit();
          const cell = runtime.getCell(space, "s18-unloaded", undefined, seed);
          id = cell.getAsNormalizedFullLink().id as URI;
          writeSeedEnvelopeDoc(seed, space);
          seed.writeOrThrow({
            space,
            id,
            type: "application/json",
            path: [],
          }, { value: { note: "one" }, cfc: storedMetadata });
          expect((await seed.commit()).ok).toBeDefined();
          await storage.synced();
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }

      // A session that has never synced the document, writing the whole
      // envelope with no `cfc`.
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
          cfcEnforcementMode: "enforce-explicit",
        });
        try {
          const tx = runtime.edit();
          tx.writeOrThrow({
            space,
            id: id!,
            type: "application/json",
            path: [],
          }, { value: { note: "erased" } });
          expect(tx.getCfcState().unprivilegedSystemWrites).toEqual([]);
          expect((await tx.commit()).ok).toBeDefined();
          await storage.synced();
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }

      // The stored label map is gone from the durable document.
      {
        const storage = EmulatedStorageManager.connectTo(server, {
          as: signer,
        });
        const runtime = new Runtime({
          apiUrl: new URL("https://example.com"),
          storageManager: storage,
        });
        try {
          const cell = runtime.getCell(space, "s18-unloaded", undefined);
          await cell.sync();
          const tx = runtime.edit();
          expect(tx.readOrThrow({
            space,
            id: id!,
            type: "application/json",
            path: [],
          })).toEqual({ value: { note: "erased" } });
          await tx.commit();
        } finally {
          await runtime.dispose();
          await storage.close();
        }
      }
    } finally {
      await server.close?.();
    }
  });
});
