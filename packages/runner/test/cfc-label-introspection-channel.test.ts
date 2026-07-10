import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { inspectStoredConfLabel } from "../src/cfc/label-introspection.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import type { CfcLabelMetadataObservation } from "../src/cfc/types.ts";
import type { ExtendedStorageTransaction } from "../src/storage/extended-storage-transaction.ts";
import type { URI } from "@commonfabric/memory/interface";

const signer = await Identity.fromPassphrase(
  "runner-cfc-label-introspection-channel",
);
const space = signer.did();

// Inv-12 Stage 2, the SC-6 partial revisit: label-metadata observations
// recorded by the introspection surface are APPLICATION observations — they
// enter the reading transaction's consumed set with their population-rule
// labels and feed the flow derivation — while runtime-internal verifier reads
// (readStoredCfcMetadata under INTERNAL_VERIFIER_META) stay excluded exactly
// as before.

const observationFor = (
  id: string,
  confidentiality: unknown[],
  targetSpace: string = space,
): CfcLabelMetadataObservation =>
  ({
    target: {
      space: targetSpace as CfcLabelMetadataObservation["target"]["space"],
      id,
      scope: "space",
      // The first-layer metadata subtree address (§4.6.4.1): observations
      // address /cfc/labels/<target-envelope-path>, never payload paths.
      path: ["cfc", "labels", "value", "body"],
    },
    observes: "labelMetadata",
    confidentiality,
  }) as CfcLabelMetadataObservation;

const seedLabeledDoc = async (
  runtime: Runtime,
  storageKey: string,
): Promise<string> => {
  const seed = runtime.edit();
  const id = parseLink(
    runtime.getCell(
      space,
      storageKey,
      { type: "object", properties: { body: { type: "string" } } },
    ).getAsLink(),
  ).id!;
  seed.writeOrThrow(
    { space, scope: "space", id: id as URI, path: [] },
    {
      value: { body: "payload" },
      cfc: {
        version: 1,
        schemaHash: "seed-schema",
        labelMap: {
          version: 1,
          entries: [{
            path: ["body"],
            label: {
              confidentiality: ["secret", {
                type: CFC_ATOM_TYPE.Caveat,
                kind: "prompt-influence",
                source: { space: "did:key:remote-a", id: "of:origin-a" },
              }],
            },
            origin: "derived",
          }],
        },
      },
    },
  );
  expect((await seed.commit()).ok).toBeDefined();
  return id;
};

const makeRuntime = (options: {
  cfcFlowLabels?: "off" | "observe" | "persist";
  cfcSinkMaxConfidentiality?: Record<string, unknown[]>;
} = {}) => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime(
    {
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      ...options,
    } as ConstructorParameters<typeof Runtime>[0],
  );
  return { storageManager, runtime };
};

describe("CFC label-metadata observation channel (inv-12 Stage 2)", () => {
  it("recorded observations join the flow derivation with their population labels", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const join = deriveFlowJoin(tx, { collectLabeledSpaces: true });
      expect(join.confidentiality).toContainEqual("secret");
      // The observation's space counts as a label contributor (the Stage 1
      // cross-space predicate input).
      expect([...(join.labeledSpaces ?? [])]).toContain(space);
      // Confidentiality only: a metadata observation is not a content input,
      // so it must not seed or empty the hereditary integrity meet.
      expect(join.integrity).toEqual([]);
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("marks the transaction relevant and invalidates a prepared digest", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      expect(tx.getCfcState().relevant).toBe(false);
      runtime.getCell(space, "channel-out-1", undefined, tx).set({ v: 1 });
      tx.prepareCfc();
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      expect(tx.getCfcState().relevant).toBe(true);
      const prepare = tx.getCfcState().prepare;
      expect(prepare.status).toBe("invalidated");
      expect(
        (prepare as { reasons: readonly string[] }).reasons,
      ).toContainEqual("label-metadata-observation-added");
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("binds observations into the prepared digest", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const bare = runtime.edit();
      runtime.getCell(space, "channel-digest", undefined, bare).set({ v: 1 });
      const bareDigest = bare.prepareCfc();
      expect(bareDigest).not.toBe("");
      await bare.commit();

      const observing = runtime.edit();
      runtime.getCell(space, "channel-digest", undefined, observing).set({
        v: 1,
      });
      observing.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const observingDigest = observing.prepareCfc();
      expect(observingDigest).not.toBe("");
      // Same reads/writes, one extra observation: the digest must differ —
      // the observation is a boundary-decision input (it changes the flow
      // join and the consumed set).
      expect(observingDigest).not.toBe(bareDigest);
      await observing.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("ignores empty (public) observations", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", []),
      );
      expect(tx.getCfcState().labelMetadataObservations).toHaveLength(0);
      expect(tx.getCfcState().relevant).toBe(false);
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("persists the observation's confidentiality onto written docs under flow persist", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcFlowLabels: "persist",
    });
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const out = runtime.getCell(space, "channel-out-persist", undefined, tx);
      out.set({ copied: "derived-from-metadata" });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const check = runtime.edit();
      const stored = readStoredCfcMetadata(check, { space, id: outId });
      await check.commit();
      const derived = stored?.labelMap.entries.find((entry) =>
        entry.origin === "derived"
      );
      expect(derived).toBeDefined();
      // The result of a transaction that observed protected label metadata
      // carries that metadata's population label: result label ⊇ the
      // consumed observation's confidentiality.
      expect(derived!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("keeps verifier reads excluded: raw metadata reads consume nothing", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcFlowLabels: "persist",
    });
    try {
      const id = await seedLabeledDoc(runtime, "channel-verifier-src");

      // Transaction A: performs a runtime-internal verifier read of the
      // stored metadata (the readStoredCfcMetadata seam prepare itself
      // uses) and writes a doc. Transaction B: writes the same value with
      // no metadata read. Their consumed sets must be EQUAL — the verifier
      // read is not an observation (§8.10.1); only the explicit
      // record-channel consumes.
      const txA = runtime.edit();
      const metadata = readStoredCfcMetadata(txA, { space, id });
      expect(metadata).toBeDefined();
      expect(
        metadata!.labelMap.entries[0].label.confidentiality,
      ).toContainEqual("secret");
      const joinA = deriveFlowJoin(txA);

      const txB = runtime.edit();
      const joinB = deriveFlowJoin(txB);

      expect(joinA.confidentiality).toEqual(joinB.confidentiality);
      expect(joinA.confidentiality).toEqual([]);

      // And end-to-end: the doc written by the verifier-reading transaction
      // stays unlabeled (no derived component minted from the raw read).
      const outA = runtime.getCell(
        space,
        "channel-verifier-out",
        undefined,
        txA,
      );
      outA.set({ copied: "no-taint" });
      txA.prepareCfc();
      expect((await txA.commit()).ok).toBeDefined();
      await txB.commit();

      const check = runtime.edit();
      const stored = readStoredCfcMetadata(check, {
        space,
        id: outA.getAsNormalizedFullLink().id,
      });
      await check.commit();
      expect(
        stored?.labelMap.entries.some((entry) => entry.origin === "derived"),
      ).not.toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("inspectStoredConfLabel records the observation at the metadata subtree address", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcFlowLabels: "persist",
    });
    try {
      const id = await seedLabeledDoc(runtime, "channel-direct-src");
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "channel-direct-src", undefined, tx);
      const outcome = inspectStoredConfLabel(
        tx,
        cell.getAsNormalizedFullLink(),
        "/body",
        {},
      );
      expect(outcome.status).toBe("ok");
      const observations = tx.getCfcState().labelMetadataObservations;
      expect(observations).toHaveLength(1);
      expect(observations[0].observes).toBe("labelMetadata");
      // The record addresses the FIRST-LAYER metadata subtree, never a
      // payload path (§4.6.4.1 addressing).
      expect([...observations[0].target.path]).toEqual([
        "cfc",
        "labels",
        "value",
        "body",
      ]);
      expect(observations[0].target.id).toBe(id);
      expect([...observations[0].confidentiality]).toContainEqual("secret");
      await tx.commit();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("collapses a metadata read error to the unobservable arm", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcFlowLabels: "persist",
    });
    try {
      await seedLabeledDoc(runtime, "channel-err-src");
      const tx = runtime.edit();
      const cell = runtime.getCell(space, "channel-err-src", undefined, tx);
      const link = cell.getAsNormalizedFullLink();
      tx.abort(new Error("simulated storage failure"));
      // Reads on an aborted transaction throw; the introspection step must
      // collapse that to the SAME notAvailable as missing metadata.
      const outcome = inspectStoredConfLabel(tx, link, "/body", {});
      expect(outcome).toEqual({ status: "notAvailable" });
      expect(tx.getCfcState().labelMetadataObservations).toHaveLength(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("gates protected writes on consumed observations (maxConfidentiality)", async () => {
    const { storageManager, runtime } = makeRuntime();
    try {
      const tx = runtime.edit();
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      const target = runtime.getCell(
        space,
        "channel-gated-target",
        {
          type: "object",
          properties: {
            out: { type: "string", ifc: { maxConfidentiality: [] } },
          },
          required: ["out"],
        },
        tx,
      );
      target.set({ out: "derived" });
      tx.prepareCfc();
      const result = await tx.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("feeds the sink-request egress ceiling (consumed set)", async () => {
    const { storageManager, runtime } = makeRuntime({
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      const tx = runtime.edit() as ExtendedStorageTransaction;
      tx.recordCfcLabelMetadataObservation(
        observationFor("of:introspected", ["secret"]),
      );
      tx.recordCfcWritePolicyInput({
        kind: "sink-request",
        effectId: "introspection-egress-1",
        sink: "fetchJson",
        request: { url: "https://example.com" },
      });
      tx.prepareCfc();
      const result = await tx.commit();
      // The empty (public-only) fetchJson ceiling must reject a request from
      // a transaction whose consumed set includes the protected metadata
      // observation.
      expect(result.error?.message).toContain(
        "CFC enforcement rejected commit",
      );
      const reasons =
        (tx.getCfcState().prepare as { reasons?: readonly string[] })
          .reasons ?? [];
      expect(
        reasons.some((reason) => reason.includes("fetchJson")),
      ).toBe(true);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
