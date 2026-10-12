import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { InputReadView, VerifierMetadataResolver } from "../src/cfc/prepare.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-prepare-input-read-view");
const space = signer.did();

describe("prepare", () => {
  describe("InputReadView", () => {
    // The boundary pass verifies every written target against the reads the
    // transaction made, and a commit of many targets asks for the same reads
    // once per target. These pin that the pass builds the view once and
    // reuses it, and that the view does not outlive what it was built from:
    // a read it has not seen, or a write that retires an envelope it
    // resolved.

    let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
    let runtime: Runtime | undefined;

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      runtime = undefined;
      storageManager = undefined;
    });

    const newRuntime = () => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
      });
      return runtime;
    };

    const address = (id: string) => ({
      space,
      scope: "space" as const,
      id: `of:${id}` as URI,
      path: [] as string[],
    });

    it("builds the read set once for a commit of many targets", () => {
      const runtime = newRuntime();
      const tx = runtime.edit();
      try {
        for (let index = 0; index < 4; index++) {
          tx.readOrThrow({ ...address(`source-${index}`), path: ["value"] });
        }
        const targets = 6;
        for (let index = 0; index < targets; index++) {
          const target = address(`target-${index}`);
          tx.writeValueOrThrow(target, { text: `row ${index}` });
          tx.recordCfcWritePolicyInput({
            kind: "schema",
            target,
            schema: {
              type: "object",
              properties: { text: { type: "string" } },
            },
          });
        }
        // Nothing above reads a labeled document, so the boundary pass runs
        // only once the transaction is marked relevant.
        tx.markCfcRelevant();
        runtime.resetCfcStats();
        runtime.prepareTxForCommit(tx);
        expect(tx.getCfcState().prepare.status).toBe("prepared");
        const stats = runtime.getCfcStats();
        expect(stats.inputReadViewsBuilt).toBe(1);
        expect(stats.inputReadViewsReused).toBe(targets - 1);
      } finally {
        tx.abort();
      }
    });

    it("keeps the read set until a read it has not seen is recorded", () => {
      const runtime = newRuntime();
      const tx = runtime.edit();
      try {
        tx.readOrThrow({ ...address("first"), path: ["value"] });
        const view = new InputReadView(tx);
        const reads = view.reads();
        expect(reads.map((read) => read.id)).toEqual(["of:first"]);
        expect(view.reads()).toBe(reads);
        tx.readOrThrow({ ...address("second"), path: ["value"] });
        const after = view.reads();
        expect(after).not.toBe(reads);
        expect(after.map((read) => read.id)).toEqual(["of:first", "of:second"]);
        expect(view.reads()).toBe(after);
      } finally {
        tx.abort();
      }
    });

    it("keeps the resolved envelopes until a write retires one", async () => {
      const runtime = newRuntime();
      const seed = runtime.edit();
      const labeled = address("labeled");
      writeSeedEnvelopeDoc(seed, space);
      seedStoredEnvelope(seed, labeled, {
        value: { field: "stored" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["field"],
              observes: "value",
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();
      const tx = runtime.edit();
      try {
        tx.readOrThrow({ ...labeled, path: ["value", "field"] });
        tx.readOrThrow({ ...address("plain"), path: ["value"] });
        const view = new InputReadView(tx);
        const resolver = new VerifierMetadataResolver(tx);
        resolver.refresh();
        const envelopes = view.sourceMetadata(resolver);
        expect(envelopes[0]?.labelMap.entries).toHaveLength(1);
        expect(envelopes[1]).toBeUndefined();
        const gated = view.gatedReads(resolver);
        expect(gated.map((read) => read.id)).toEqual(["of:labeled"]);
        resolver.refresh();
        expect(view.sourceMetadata(resolver)).toBe(envelopes);
        expect(view.gatedReads(resolver)).toBe(gated);

        // A write to a document the view never resolved retires nothing.
        tx.writeOrThrow({ ...address("other"), path: ["value"] }, { n: 1 });
        resolver.refresh();
        expect(view.sourceMetadata(resolver)).toBe(envelopes);

        tx.writeOrThrow({ ...labeled, path: ["value", "field"] }, "changed");
        resolver.refresh();
        const after = view.sourceMetadata(resolver);
        expect(after).not.toBe(envelopes);
        expect(after[0]?.labelMap.entries).toHaveLength(1);
        expect(view.gatedReads(resolver)).not.toBe(gated);
      } finally {
        tx.abort();
      }
    });
  });
});
