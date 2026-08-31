import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { Identity } from "@commonfabric/identity";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "../src/cfc/observation.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("runner-cfc-writer-fit");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
  origin?: string;
};

const storedDocument = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
):
  | { value?: unknown; cfc?: { labelMap?: { entries: StoredEntry[] } } }
  | undefined => {
  const replica = storageManager.open(signer.did()).replica as unknown as {
    getDocument(id: string): {
      value?: unknown;
      cfc?: { labelMap?: { entries: StoredEntry[] } };
    } | undefined;
  };
  return replica.getDocument(id);
};

const replicaEntries = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
  id: string,
): StoredEntry[] =>
  storedDocument(storageManager, id)?.cfc?.labelMap?.entries ?? [];

const newRuntime = (
  storageManager: ReturnType<typeof StorageManager.emulate>,
) =>
  new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    // The shipped shell posture (enforcement-matrix §3): explicit + flow
    // persist. Individual transactions escalate to `enforce-strict` per-tx,
    // which is exactly the seam H4 differentiates.
    cfcEnforcementMode: "enforce-explicit",
    cfcFlowLabels: "persist",
  });

// The space principal of the space every doc in this file lives in — the
// clause residency admits (§8.12.4).
const ownSpacePrincipal = {
  type: "https://commonfabric.org/cfc/atom/Space",
  id: signer.did(),
};

// Seed a source doc whose `secret` field carries `confidentiality`, so a
// transaction reading it takes those clauses into the per-tx flow join.
const seedSecretSource = async (
  runtime: Runtime,
  name: string,
  confidentiality: readonly FabricValue[] = ["secret"],
) => {
  const seed = runtime.edit();
  const sourceCell = runtime.getCell(
    signer.did(),
    name,
    {
      type: "object",
      properties: { secret: { type: "string" } },
    },
  );
  const sourceId = parseLink(sourceCell.getAsLink()).id!;
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

// Read the seeded source in a fresh transaction at `mode`, derive a value
// into `targetName`, and commit. `targetSchema` declares the target's store
// policy; omitted, the target declares nothing.
const deriveIntoTarget = async (
  runtime: Runtime,
  sourceName: string,
  targetName: string,
  mode: "enforce-strict" | "enforce-explicit" = "enforce-strict",
  targetSchema?: JSONSchema,
) => {
  const tx = runtime.edit();
  tx.setCfcEnforcementMode(mode);
  const source = runtime.getCell(signer.did(), sourceName, undefined, tx);
  const raw = source.getRaw() as { secret?: string };
  const target = runtime.getCell<{ copied?: string }>(
    signer.did(),
    targetName,
    targetSchema,
    tx,
  );
  target.set({ copied: `${raw.secret}!` });
  const targetId = target.getAsNormalizedFullLink().id;
  tx.prepareCfc();
  return { tx, targetId, result: await tx.commit() };
};

// The writer-fit reasons this transaction recorded, whether they rejected the
// commit or landed as persist-and-flag diagnostics.
const writerFitDiagnostics = (
  tx: { getCfcState(): { diagnostics: string[] } },
) => tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit"));

describe("CFC writer-fit (canWrite, §8.12.4 / SC-18b)", () => {
  // H4 writer-fit (SC-18b, spec §8.12.4): a write whose derived flow label does
  // not fit the target's write ceiling — its DECLARED store policy joined with
  // the residency clause its own space contributes. Under `enforce-explicit`
  // the derived component is a measurement, not a write ceiling — the write
  // persists and the misfit is flagged as a diagnostic (SC-18a/c). Under
  // `enforce-strict` the same misfit is a fail-closed reject (the strict-only
  // delta of docs/specs/cfc-enforcement-matrix.md §4), leaving the §8.12.5
  // outs: upgrade the store label in the same tx, write to a fitting store, or
  // write to a store whose space the clause already names.

  it("rejects a confidentiality misfit under enforce-strict with the SC-18c reason", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-strict-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-strict-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");

      // Target doc declares NO store policy, so residency is its whole
      // ceiling: a `secret`-tainted component, naming no space, cannot fit.
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-strict-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      // SC-18c error contract: stable reason naming the rule id and path.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(`for ${derivedId} at /`);
      expect(result.error?.message).toContain("(canWrite, §8.12.4)");

      // Fail-closed: the rejected transaction persisted nothing.
      expect(storedDocument(storageManager, derivedId)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the measurement and flags the misfit under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-explicit-source");

      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const derived = runtime.getCell(
        signer.did(),
        "writer-fit-explicit-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      const derivedId = derived.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // Persist-and-flag, half one: the derived component records the
      // value's actual taint (unchanged shipped behavior — readers stay
      // protected by the effective-label floor).
      const entries = replicaEntries(storageManager, derivedId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // Persist-and-flag, half two: the misfit is flagged as a diagnostic
      // carrying the same SC-18c reason string the strict reject uses.
      const flags = tx.getCfcState().diagnostics.filter((d) =>
        d.includes("writer-fit(persist-and-flag)")
      );
      expect(flags.length).toBeGreaterThan(0);
      expect(flags[0]).toContain("writer-fit confidentiality misfit");
      expect(flags[0]).toContain(`for ${derivedId} at /`);
      expect(flags[0]).toContain("(canWrite, §8.12.4)");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a fitting write under enforce-strict when the declared policy covers the join", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-covered-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-covered-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // §8.12.5 route 2, atomically in one tx: the write rides a schema that
      // declares a store policy at least as strict as the derived join.
      const covered = runtime.getCell(
        signer.did(),
        "writer-fit-covered-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"] },
        },
        tx,
      );
      covered.set({ copied: `${raw.secret}!` });
      const coveredId = covered.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const entries = replicaEntries(storageManager, coveredId);
      expect(entries.some((e) =>
        e.origin === "declared" &&
        (e.label.confidentiality ?? []).includes("secret")
      )).toBe(true);
      expect(entries.some((e) => e.origin === "derived")).toBe(true);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores pointer-classed declared policy for a value write under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-followref-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-followref-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      // The target's ONLY declared confidentiality is classed
      // `observes: "followRef"` — pointer policy. Value readers never
      // consume it (C0 §4), so it is not part of the floor a value reader
      // is tainted with and must not serve as the writer-fit ceiling
      // (bot review on this PR: pointer policy admitting a secret value
      // write would under-block exactly the readers the check protects).
      const pointerOnly = runtime.getCell(
        signer.did(),
        "writer-fit-followref-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["secret"], observes: "followRef" },
        },
        tx,
      );
      pointerOnly.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("names the offending clause when the declared policy only partially covers", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-partial-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-partial-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      const partial = runtime.getCell(
        signer.did(),
        "writer-fit-partial-derived",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
        tx,
      );
      partial.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error).toBeDefined();
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      // The reason names the clause(s) outside the write ceiling so the
      // flag identifies exactly what the store would need to declare.
      expect(result.error?.message).toContain('"secret"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a same-space principal clause into an undeclared store under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The source's confidentiality names this space's own principal, so
      // residency fits the tainted write below even though the target
      // declares nothing.
      await seedSecretSource(runtime, "wf-samespace-source", [
        ownSpacePrincipal,
      ]);
      const { tx, targetId, result } = await deriveIntoTarget(
        runtime,
        "wf-samespace-source",
        "wf-samespace-derived",
      );
      expect(result.error?.message).toBeUndefined();

      // The fit is a write admission, not a label drop: the derived stamp
      // still carries the space principal for the egress gates.
      const flowEntry = replicaEntries(storageManager, targetId)
        .find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual(
        ownSpacePrincipal,
      );
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("admits a clause carrying the space principal as one alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Residency reaches into an OR-clause: the ceiling clause subsumes a
      // label clause listing the space among its alternatives.
      await seedSecretSource(runtime, "wf-alternative-source", [{
        anyOf: [
          {
            type: "https://commonfabric.org/cfc/atom/User",
            subject: "did:key:zReader",
          },
          ownSpacePrincipal,
        ],
      }]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-alternative-source",
        "wf-alternative-derived",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("raises no persist-and-flag diagnostic for a same-space clause under enforce-explicit", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The measurement is one computation feeding both the strict reject and
      // the lower-mode diagnostic, so a residency fit is silent at every rung.
      await seedSecretSource(runtime, "wf-explicit-source", [
        ownSpacePrincipal,
      ]);
      const { tx, result } = await deriveIntoTarget(
        runtime,
        "wf-explicit-source",
        "wf-explicit-derived",
        "enforce-explicit",
      );
      expect(result.error?.message).toBeUndefined();
      expect(writerFitDiagnostics(tx)).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a principal naming a space other than the target's", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-foreignspace-source", [{
        type: "https://commonfabric.org/cfc/atom/Space",
        id: "did:key:zForeignSpace",
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-foreignspace-source",
        "wf-foreignspace-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("zForeignSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the personal-space principal form under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "wf-personalspace-source", [{
        type: "https://commonfabric.org/cfc/atom/PersonalSpace",
        owner: signer.did(),
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-personalspace-source",
        "wf-personalspace-derived",
      );
      // `PersonalSpace` gates by equality against one acting reader, so its
      // audience is a person rather than the space's reader set. Residency
      // does not admit it, even though the owner DID matches this space's.
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain("PersonalSpace");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects the bare DID-string principal that the declared policy omits", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // Two clauses: one the target's declared policy lists, one it does not
      // — the bare DID-string spelling, which names a reader by identity
      // rather than naming the container.
      await seedSecretSource(runtime, "wf-baredid-source", [
        "internal",
        signer.did(),
      ]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-baredid-source",
        "wf-baredid-derived",
        "enforce-strict",
        {
          type: "object",
          properties: { copied: { type: "string" } },
          ifc: { confidentiality: ["internal"] },
        },
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(signer.did());
      expect(result.error?.message).not.toContain('"internal"');
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a read-failed marker clause that lists a same-space alternative", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      // The ungrantable marker stays outside every ceiling, the residency
      // clause included. This is also the fence against reimplementing the
      // rule as a filter over the measured label, which would drop the
      // clause before the marker check ever ran.
      await seedSecretSource(runtime, "wf-poisoned-source", [{
        anyOf: [CFC_LABEL_READ_FAILED_ATOM, ownSpacePrincipal],
      }]);
      const { result } = await deriveIntoTarget(
        runtime,
        "wf-poisoned-source",
        "wf-poisoned-derived",
      );
      expect(result.error?.message).toContain(
        "writer-fit confidentiality misfit",
      );
      expect(result.error?.message).toContain(CFC_LABEL_READ_FAILED_ATOM);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  describe("meta-seam exemption", () => {
    // The measurement quantifies over paths a schema could have declared a
    // policy at, and the raw meta seam is not one: `setMetaRaw` lands on a
    // document-root sibling of `value` (`schema`, `internal`, and the rest of
    // the `MetaField` union), which no value schema describes.
    //
    // One route does reach a ceiling there — a document-root declaration
    // resolves at every meta path by longest prefix — but it widens the
    // ceiling over the whole payload, and a declaration on a single result
    // field, which is how a pattern normally labels one, leaves the seam's
    // ceiling empty. Such a pattern is then un-updatable: the pattern updater,
    // `setsrc`, and setup over an existing piece all stamp meta.
    //
    // The seam is outside the check at every rung, so these cases assert on
    // both the strict reject and the persist-and-flag diagnostic below it.

    // Pinned rather than inherited: this exemption is only observable at the
    // strictness where the misfit rejects.
    const strictRuntime = (
      storageManager: ReturnType<typeof StorageManager.emulate>,
    ) =>
      new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-strict",
        cfcFlowLabels: "persist",
      });

    /** Seed `cause` as a plain document declaring no store policy. */
    const seedUndeclaredTarget = async (
      runtime: Runtime,
      cause: string,
      payload: FabricValue = { note: "public" },
    ) => {
      const id = runtime.getCell(signer.did(), cause)
        .getAsNormalizedFullLink().id;
      const seed = runtime.edit();
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: [],
      }, { value: payload });
      expect((await seed.commit()).ok).toBeDefined();
      return id;
    };

    it("admits a meta write of a tainted join into an undeclared store", async () => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-source");
        const targetId = await seedUndeclaredTarget(runtime, "wf-meta-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        expect(raw.secret).toBe("s3cr3t");
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-target",
          undefined,
          tx,
        );
        await target.sync();
        // The two paths the piece-update flows land on, and the two the
        // strict measurement used to reject at.
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        target.setMetaRaw(
          "internal",
          { derived: raw.secret },
          rawMetaWriteAuthorization,
        );
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeUndefined();
        expect(result.ok).toBeDefined();
        // Not merely "did not reject": no measurement named a meta path at
        // all, at either rung (a strict reject and an explicit flag carry the
        // identical reason string).
        expect(writerFitDiagnostics(tx)).toEqual([]);

        // The taint is not lost with the measurement. The join still lands as
        // the derived component on the meta paths, so the egress, display,
        // and observation gates read the unchanged label. (Each path carries
        // the C2 per-class split — a `value` entry and a `shape` entry — so
        // the paths are compared as a set.)
        const stamped = replicaEntries(storageManager, targetId).filter((e) =>
          e.origin === "derived" &&
          (e.label.confidentiality ?? []).includes("secret")
        );
        expect([...new Set(stamped.map((e) => e.path.join("/")))].sort())
          .toEqual(["internal", "schema"]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("raises no persist-and-flag diagnostic for a meta write under enforce-explicit", async () => {
      // The exemption is a statement about what the check can measure, not
      // about what a rung does with a misfit, so it holds below strict too.
      // Were it scoped to the reject, the shipped posture would keep flagging
      // a measurement the strict rung had already declared meaningless.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = newRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-explicit-source");
        await seedUndeclaredTarget(runtime, "wf-meta-explicit-target");

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-explicit-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("still rejects an ordinary value write of the same join into the same store", async () => {
      // The control: the exemption is about paths a schema cannot reach, not
      // about this transaction's join or this target's store. Swap the meta
      // write above for a payload write into the same undeclared document and
      // the misfit is back.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-control-source");
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-control-target",
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-control-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "note"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(`for ${targetId} at /note`);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("skips the measurement even where a root declaration resolves at the meta path", async () => {
      // The skip is unconditional, and this pins that. A document-root
      // declared entry is a prefix of every meta path, so longest-prefix
      // resolution hands the meta path a non-empty ceiling — but that
      // reaches the envelope seam only because canonicalization strips a
      // leading `"value"`, making the payload root and the document root one
      // logical path. It says nothing about the seam, and honoring it would
      // make a piece updatable or not according to whether its pattern
      // carries a root `ifc`.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-rooted-source");

        // A root declaration that does NOT cover the join the tx will carry.
        const targetId = runtime.getCell(signer.did(), "wf-meta-rooted-target")
          .getAsNormalizedFullLink().id;
        const seed = runtime.edit();
        writeSeedEnvelopeDoc(seed, signer.did());
        seed.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: [],
        }, {
          value: { note: "public" },
          cfc: {
            version: 1,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{
                path: [],
                label: { confidentiality: ["unrelated"] },
              }],
            },
          },
        });
        expect((await seed.commit()).ok).toBeDefined();

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-rooted-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw("slug", `${raw.secret}!`, rawMetaWriteAuthorization);
        tx.prepareCfc();

        expect((await tx.commit()).ok).toBeDefined();
        expect(writerFitDiagnostics(tx)).toEqual([]);
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });

    it("keeps measuring a payload field that shares a meta field's logical path", async () => {
      // A payload field literally named `schema` lives at raw
      // `["value","schema"]` and canonicalizes onto the meta root's logical
      // path. The exemption is recorded per path across every write that
      // reached it, so writing both in one transaction leaves the path
      // measured — and an exempt meta path must not collapse a value write
      // below it out of the measurement either.
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = strictRuntime(storageManager);
      try {
        await seedSecretSource(runtime, "wf-meta-collide-source");
        // The payload carries a `schema` object of its own, so the write
        // below materializes at its own path instead of at the document root.
        const targetId = await seedUndeclaredTarget(
          runtime,
          "wf-meta-collide-target",
          { schema: { existing: true } },
        );

        const tx = runtime.edit();
        const source = runtime.getCell(
          signer.did(),
          "wf-meta-collide-source",
          undefined,
          tx,
        );
        const raw = source.getRaw() as { secret?: string };
        const target = runtime.getCell(
          signer.did(),
          "wf-meta-collide-target",
          undefined,
          tx,
        );
        await target.sync();
        target.setMetaRaw(
          "schema",
          { type: "object" },
          rawMetaWriteAuthorization,
        );
        tx.writeOrThrow({
          space: signer.did(),
          scope: "space",
          id: targetId,
          path: ["value", "schema", "leaked"],
        }, `${raw.secret}!`);
        tx.prepareCfc();

        const result = await tx.commit();
        expect(result.error).toBeDefined();
        expect(result.error?.message).toContain(
          "writer-fit confidentiality misfit",
        );
        expect(result.error?.message).toContain(
          `for ${targetId} at /schema/leaked`,
        );
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    });
  });

  it("admits a reserved grant document under enforce-strict", async () => {
    // Reserved CFC documents (policy manifests, release grants) hold policy
    // state the runtime persists through its privileged writers, so they are
    // not value-write targets the fit measures. The grant document declares no
    // store policy of its own, and the transaction that authors one has read
    // the resource it releases — a tainted join.

    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      await seedSecretSource(runtime, "writer-fit-grant-source");

      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const source = runtime.getCell(
        signer.did(),
        "writer-fit-grant-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");
      // The trusted policy-writer authors under a builtin identity, the one
      // sanctioned writer of the reserved grant namespace.
      tx.setCfcImplementationIdentity({
        kind: "builtin",
        builtinId: "cfc-grant-writer",
      });
      const written = tx.writeCfcGrant({
        kind: "ShareGrant",
        owner: signer.did(),
        resource: "of:writer-fit-grant-resource",
        audience: [cfcAtom.user(
          "did:key:z6MkfZ3gV6ZKqmyWLTPYnPYRUYQBqTHTNCJgqbCkNBzYqZ4H",
        )],
        grantedAt: 1000,
      });
      expect(tx.prepareCfc()).not.toBe("");
      expect((await tx.commit()).ok).toBeDefined();

      // The grant persisted, carrying no derived label of its own: a
      // consultation reading it inherits nothing from the releasing
      // transaction.
      const stored = storedDocument(storageManager, written.id);
      expect(stored?.value).toBeDefined();
      expect(stored?.cfc).toBeUndefined();
      expect(
        tx.getCfcState().diagnostics.filter((diagnostic) =>
          diagnostic.includes(written.id)
        ),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("leaves untainted writes untouched under enforce-strict", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = newRuntime(storageManager);
    try {
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      const plain = runtime.getCell(
        signer.did(),
        "writer-fit-plain",
        undefined,
        tx,
      );
      plain.set({ note: "public" });
      const plainId = plain.getAsNormalizedFullLink().id;
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();
      expect(replicaEntries(storageManager, plainId)).toEqual([]);
      expect(
        tx.getCfcState().diagnostics.filter((d) => d.includes("writer-fit")),
      ).toEqual([]);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
