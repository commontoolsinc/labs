import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { parseLink } from "../src/link-utils.ts";
import type { Action } from "../src/scheduler.ts";

const signer = await Identity.fromPassphrase("runner-cfc-flow-labels");

type StoredEntry = {
  path: string[];
  label: { confidentiality?: string[]; integrity?: unknown[] };
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

// S16 default transition: a transaction's outputs are tainted by what it
// read. Without this, "read labeled data, write a derived plain value to an
// unlabeled cell" launders the label away (audit S16) — the acceptance
// scenario for the cfcFlowLabels dial.
describe("CFC flow labels (default transition)", () => {
  it("persists derived flow labels on laundered value copies and gates downstream egress", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      // Doc A: labeled secret.
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-labels-source",
          {
            type: "object",
            properties: { secret: { type: "string" } },
          },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // The laundering tx: read A raw, write a derived plain value to the
      // unlabeled doc B. No schema ifc anywhere near B.
      const tx = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-source",
        undefined,
        tx,
      );
      const raw = source.getRaw() as { secret?: string };
      expect(raw.secret).toBe("s3cr3t");

      const derived = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-derived",
        undefined,
        tx,
      );
      derived.set({ copied: `${raw.secret}!` });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      // The derived doc carries the consumed confidentiality as a derived
      // component at the written path.
      const derivedId = derived.getAsNormalizedFullLink().id;
      const entries = replicaEntries(storageManager, derivedId);
      const flowEntry = entries.find((e) => e.origin === "derived");
      expect(flowEntry).toBeDefined();
      expect(flowEntry!.label.confidentiality).toContainEqual("secret");

      // And the derived label feeds the existing enforcement seams: a
      // later tx consuming B cannot write into a slot whose ceiling
      // excludes the secret.
      const egress = runtime.edit();
      egress.setCfcEnforcementMode("enforce-explicit");
      const derivedIn = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-derived",
        undefined,
        egress,
      );
      const rawDerived = derivedIn.getRaw() as { copied?: string };
      expect(rawDerived.copied).toBe("s3cr3t!");

      const gated = runtime.getCell(
        signer.did(),
        "cfc-flow-labels-gated",
        {
          type: "object",
          properties: {
            value: {
              type: "string",
              ifc: { maxConfidentiality: ["internal"] },
            },
          },
          required: ["value"],
        },
        egress,
      );
      gated.set({ value: "leak" });
      egress.prepareCfc();
      const result = await egress.commit();
      expect(result.error?.message).toContain("maxConfidentiality");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // Derived labels are per-value, not a ratchet: overwriting a flow-labeled
  // path from a transaction that read nothing labeled replaces the derived
  // component, so the label tracks the current value (the old, tainted value
  // is gone; reads of it journaled its label at read time).
  it("replaces the derived component when the value is overwritten by an untainted write", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-flow-replace-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // Tainted write: doc gets a derived ["secret"] component.
      const taint = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-flow-replace-source",
        undefined,
        taint,
      );
      const raw = source.getRaw() as { secret?: string };
      const target = runtime.getCell(
        signer.did(),
        "cfc-flow-replace-target",
        undefined,
        taint,
      );
      target.set({ note: raw.secret });
      taint.prepareCfc();
      expect((await taint.commit()).ok).toBeDefined();

      const targetId = target.getAsNormalizedFullLink().id;
      expect(
        replicaEntries(storageManager, targetId).find((e) =>
          e.origin === "derived"
        )?.label.confidentiality,
      ).toContainEqual("secret");

      // Untainted overwrite: a write whose journal contains no reads (raw
      // root write). The derived component is replaced (cleared — this tx
      // derived nothing), not unioned forever. Note that `cell.set()` is
      // NOT such a write: it journals a read of the prior value, so a
      // set-overwrite of a tainted doc conservatively re-derives the taint
      // — by the journal it consumed the old value.
      const clean = runtime.edit();
      clean.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: targetId,
        path: ["value"],
      }, { note: "fresh public text" });
      clean.prepareCfc();
      expect((await clean.commit()).ok).toBeDefined();

      const entriesAfter = replicaEntries(storageManager, targetId);
      expect(entriesAfter.find((e) => e.origin === "derived")).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A2: trigger reads (§8.9.2). The decision to run was influenced by the
  // triggering change even when the run never reads the changed value, so
  // its labels join the derivation.
  it("joins trigger-read labels into the derived component", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "s3cr3t" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      // The transaction reads nothing — only the trigger connects it to
      // the labeled doc.
      const tx = runtime.edit();
      tx.addCfcTriggerReads([{
        space: signer.did(),
        id: sourceId,
        type: "application/json",
        path: ["value", "secret"],
      }]);
      const out = runtime.getCell(
        signer.did(),
        "cfc-trigger-out",
        undefined,
        tx,
      );
      out.set({ flag: 1 });
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const outId = out.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, outId).find((e) =>
        e.origin === "derived"
      );
      expect(entry).toBeDefined();
      expect(entry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  // A2 end-to-end through the scheduler: run 1 subscribes to the labeled
  // doc; the rerun triggered by its change takes a branch that never
  // re-reads it, yet the rerun's write is tainted via the recorded trigger.
  it("taints rerun writes with the triggering change's labels", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "observe",
      cfcFlowLabels: "persist",
    });
    try {
      const seed = runtime.edit();
      const sourceId = parseLink(
        runtime.getCell(
          signer.did(),
          "cfc-trigger-sched-source",
          { type: "object", properties: { secret: { type: "string" } } },
        ).getAsLink(),
      ).id!;
      seed.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: [],
      }, {
        value: { secret: "v1" },
        cfc: {
          version: 1,
          schemaHash: "seed-schema",
          labelMap: {
            version: 1,
            entries: [{
              path: ["secret"],
              label: { confidentiality: ["secret"] },
            }],
          },
        },
      });
      expect((await seed.commit()).ok).toBeDefined();

      const setup = runtime.edit();
      const source = runtime.getCell(
        signer.did(),
        "cfc-trigger-sched-source",
        undefined,
        setup,
      );
      const flag = runtime.getCell(
        signer.did(),
        "cfc-trigger-sched-flag",
        undefined,
        setup,
      );
      setup.abort();

      let runs = 0;
      const action: Action = (atx) => {
        runs++;
        if (runs === 1) {
          // Subscribe to the labeled doc.
          source.withTx(atx).getRaw();
        } else {
          // Branch away: never re-read the source, just write the flag.
          flag.withTx(atx).set({ ran: runs });
        }
      };
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();
      expect(runs).toBe(1);

      const bump = runtime.edit();
      bump.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sourceId,
        path: ["value", "secret"],
      }, "v2");
      expect((await bump.commit()).ok).toBeDefined();
      await runtime.idle();
      expect(runs).toBeGreaterThan(1);

      const flagId = flag.getAsNormalizedFullLink().id;
      const entry = replicaEntries(storageManager, flagId).find((e) =>
        e.origin === "derived"
      );
      expect(entry).toBeDefined();
      expect(entry!.label.confidentiality).toContainEqual("secret");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
