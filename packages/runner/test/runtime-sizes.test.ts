import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, URI } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { immutableCellsFor } from "../src/immutable-cell.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import {
  CFC_REJECTION_REASON_LIMIT,
  CFC_REJECTION_REASON_OTHER,
  cfcRejectionReasonPrefix,
  CfcRejectionTally,
} from "../src/runtime-sizes.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";

const signer = await Identity.fromPassphrase("runner-runtime-sizes");
const space: MemorySpace = signer.did();

describe("runtime-sizes", () => {
  describe("cfcRejectionReasonPrefix()", () => {
    it("returns the words ahead of the document a reason names after ` for `", () => {
      expect(cfcRejectionReasonPrefix(
        "missing link source metadata for of:fid1:abc at /, linked into computed:fid1:def at /0/",
      )).toBe("missing link source metadata");
      expect(cfcRejectionReasonPrefix(
        "writer-fit confidentiality misfit for of:fid1:abc at / (canWrite, §8.12.4)",
      )).toBe("writer-fit confidentiality misfit");
    });

    it("returns the words ahead of the path a reason names after ` at `", () => {
      expect(cfcRejectionReasonPrefix("writePolicyAnyOf failed at /title"))
        .toBe("writePolicyAnyOf failed");
      expect(cfcRejectionReasonPrefix("requiredIntegrity failed at /"))
        .toBe("requiredIntegrity failed");
    });

    it("returns the words ahead of a `:` detail", () => {
      expect(cfcRejectionReasonPrefix("CFC commit-prep crashed: boom"))
        .toBe("CFC commit-prep crashed");
      expect(cfcRejectionReasonPrefix(
        "sink-request confidentiality exceeds ceiling for llm: personal",
      )).toBe("sink-request confidentiality exceeds ceiling");
    });

    it("returns the words ahead of an identifier a reason names with no connective", () => {
      expect(cfcRejectionReasonPrefix(
        "unprivileged write to protected runtime surface of:fid1:abc at /",
      )).toBe("unprivileged write to protected runtime surface");
      expect(cfcRejectionReasonPrefix(
        "unprivileged write to protected runtime surface /secret/path",
      )).toBe("unprivileged write to protected runtime surface");
    });

    it("returns a reason that names nothing whole", () => {
      expect(cfcRejectionReasonPrefix("prepared digest changed"))
        .toBe("prepared digest changed");
      expect(cfcRejectionReasonPrefix("CFC commit preparation crashed: boom"))
        .toBe("CFC commit preparation crashed");
    });

    it("returns a placeholder for a reason with no words ahead of its detail", () => {
      expect(cfcRejectionReasonPrefix(": only detail")).toBe("(unclassified)");
    });

    it("returns at most 80 characters", () => {
      expect(cfcRejectionReasonPrefix("x".repeat(200))).toHaveLength(80);
    });
  });

  describe("CfcRejectionTally", () => {
    describe("add()", () => {
      it("counts a refusal once under each of its reasons' prefixes", () => {
        const tally = new CfcRejectionTally();
        tally.add([
          "writePolicyAnyOf failed at /a",
          "writePolicyAnyOf failed at /b",
          "requiredIntegrity failed at /c",
        ]);
        expect(tally.snapshot()).toEqual({
          "writePolicyAnyOf failed": 2,
          "requiredIntegrity failed": 1,
        });
      });

      it("counts prefixes past the limit under one shared key", () => {
        const tally = new CfcRejectionTally();
        for (let i = 0; i < CFC_REJECTION_REASON_LIMIT; i++) {
          tally.add([`rule ${i} refused at /`]);
        }
        tally.add(["one more rule refused at /"]);
        tally.add(["and another refused at /"]);
        tally.add(["rule 0 refused at /"]);

        const snapshot = tally.snapshot();
        expect(Object.keys(snapshot)).toHaveLength(
          CFC_REJECTION_REASON_LIMIT + 1,
        );
        expect(snapshot[CFC_REJECTION_REASON_OTHER]).toBe(2);
        expect(snapshot["rule 0 refused"]).toBe(2);
      });
    });
  });

  describe("Runtime.getSizes()", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
    let runtime: Runtime | undefined;

    const createRuntime = (
      options: Omit<RuntimeOptions, "storageManager"> = {
        apiUrl: new URL(import.meta.url),
      },
    ) => {
      storageManager = StorageManager.emulate({ as: signer });
      runtime = new Runtime({ ...options, storageManager });
      return runtime;
    };

    afterEach(async () => {
      await runtime?.dispose();
      await storageManager?.close();
      runtime = undefined;
      storageManager = undefined;
    });

    it("returns every size at zero for a runtime that has done nothing, with no reasons tallied", () => {
      const sizes = createRuntime().getSizes();

      expect(sizes.scheduler).toEqual({
        nodes: 0,
        invalidNodes: 0,
        eventQueue: 0,
        pendingActions: 0,
        backgroundTasks: 0,
        actionStats: 0,
      });
      expect(sizes.storage?.spaces).toBe(0);
      expect(sizes.storage?.documents).toBe(0);
      expect(sizes.patterns.compiledPrograms).toBe(0);
      expect(sizes.runtime.retryingEdits).toBe(0);
      expect(sizes.cfcRejectionsByReason).toEqual({});
    });

    it("counts a committed document and the space it opened", async () => {
      const runtime = createRuntime();
      const tx = runtime.edit();
      runtime.getCell<number>(space, "sized", { type: "number" }, tx).set(1);
      await tx.commit().settled;

      const sizes = runtime.getSizes();
      expect(sizes.storage?.spaces).toBe(1);
      expect(sizes.storage?.documents).toBe(1);
    });

    it("counts a sink's node while it is live and not after it is cancelled", async () => {
      const runtime = createRuntime();
      const cell = runtime.getCell<number>(space, "sunk", { type: "number" });
      const cancel = cell.sink(() => {});
      await runtime.idle();
      expect(runtime.getSizes().scheduler.nodes).toBe(1);

      cancel();
      await runtime.idle();
      expect(runtime.getSizes().scheduler.nodes).toBe(0);
    });

    it("counts the snapshots the immutable cell stores retain", () => {
      // The count spans every store in the process, so it is read as a
      // difference: what this runtime adds to whatever other stores hold.

      const runtime = createRuntime();
      const before = runtime.getSizes().runtime.immutableSnapshots;
      runtime.getImmutableCell(space, { value: 1 }, { type: "object" });
      runtime.getImmutableCell(space, { value: 2 }, { type: "object" });

      expect(runtime.getSizes().runtime.immutableSnapshots - before).toBe(2);
    });

    it("counts an element snapshot a child store retains", () => {
      // Element traversal retains its snapshots in a store of their own, not
      // in the runtime's root store, and the count includes them all the same.

      const runtime = createRuntime();
      const base = runtime.getCell(space, "elements", { type: "object" })
        .getAsNormalizedFullLink();
      const before = runtime.getSizes().runtime.immutableSnapshots;
      immutableCellsFor(runtime).createElement({ name: "Ada" }, base);

      expect(runtime.getSizes().runtime.immutableSnapshots - before).toBe(1);
    });

    it("counts a storage sink once however often it registers and cancels", () => {
      const runtime = createRuntime();
      const replica = storageManager!.open(space).replica as SpaceReplica;
      const uri = runtime.getCell(space, "sunk-document")
        .getAsNormalizedFullLink()
        .id as URI;
      const sink = () => {};
      const subscriptions = () => runtime.getSizes().storage?.subscriptions;

      const cancel = replica.sinkDocument(uri, sink);
      replica.sinkDocument(uri, sink);
      expect(subscriptions()).toBe(1);

      cancel();
      cancel();
      expect(subscriptions()).toBe(0);
    });

    it("tallies a commit CFC enforcement refused under its reason's prefix", async () => {
      // A labeled target linked to a source whose document stores no CFC
      // metadata is refused with the reason `missing link source metadata
      // for <source> at /…`, so that is the prefix the tally has to carry.

      const runtime = createRuntime({
        apiUrl: new URL(import.meta.url),
        cfcEnforcementMode: "enforce-explicit",
        cfcFlowLabels: "off",
        cfcWriteFloor: "off",
        cfcTriggerReadGating: false,
        cfcDecomposedEnvelopes: false,
        cfcPolicyEvaluation: "off",
        cfcLabelMetadataProtection: "off",
        cfcDeclaredMonotonicity: "off",
      });
      const labeled: JSONSchema = {
        type: "object",
        ifc: { confidentiality: ["personal-space"] },
      };
      const seed = runtime.edit();
      seed.setCfcEnforcementMode("enforce-explicit");
      runtime.getCell(space, "target", labeled, seed).set({ existing: true });
      runtime.getCell(space, "source", undefined, seed).set({ title: "plain" });
      seed.prepareCfc();
      expect((await seed.commit().settled).ok).toBeDefined();

      const errors: { name?: string }[] = [];
      const link: Action = (tx) => {
        tx.setCfcEnforcementMode("enforce-explicit");
        tx.addVerdictCallback((_tx, result) => {
          if (result.error) errors.push(result.error);
        });
        runtime.getCell(space, "target", undefined, tx).set(
          runtime.getCell(space, "source", undefined, tx),
        );
      };
      let runs = 0;
      const counted: Action = (tx) => {
        runs += 1;
        link(tx);
      };
      const seen: unknown[] = [];
      const observed: Action = (tx) => {
        counted(tx);
        tx.addVerdictCallback(() => {
          const state = tx.getCfcState();
          seen.push({
            relevant: state.relevant,
            mode: state.enforcementMode,
            cal: state.contentAddressedLabels,
            env: state.decomposedEnvelopes,
            prepare: state.prepare.status,
            reasons: state.prepare.status === "invalidated"
              ? state.prepare.reasons.length
              : -1,
            diagnostics: state.diagnostics.length,
          });
        });
      };
      runtime.scheduler.subscribe(observed, { isEffect: true });
      await runtime.scheduler.idleWithPendingCommits();
      console.error(
        "[sizes-diag refusal]",
        JSON.stringify({
          seen,
          targetCfc: runtime.getCell(space, "target").getMetaRaw("cfc"),
          sourceCfc: runtime.getCell(space, "source").getMetaRaw("cfc"),
          sourceSchema: runtime.getCell(space, "source").getMetaRaw("schema"),
          os: Deno.build.os,
          envKeys: Object.keys(Deno.env.toObject()).filter((key) =>
            key.startsWith("CF_") || key === "ENV" || key.startsWith("DENO_")
          ),
        }),
      );

      const stats = runtime.getCfcStats();
      expect({
        runs,
        errors: errors.map((error) => error.name),
        relevant: stats.cfcRelevantTx,
        prepared: stats.cfcPreparedTx,
        rejects: stats.cfcPrepareRejects,
        tally: runtime.getSizes().cfcRejectionsByReason,
      }).toEqual({
        runs: 1,
        errors: ["CfcCommitRefusalError"],
        relevant: 2,
        prepared: 1,
        rejects: 1,
        tally: { "missing link source metadata": 1 },
      });
    });

    it("tallies a commit whose CFC preparation crashed", async () => {
      // A stored envelope carrying two ifc-bearing `anyOf` branches makes the
      // next merging writer's preparation throw, and that commit is refused
      // before storage as a `CommitPreparationError`.

      const runtime = createRuntime();
      const profile: JSONSchema = {
        type: "object",
        properties: {
          name: { type: "string", ifc: { confidentiality: ["secret"] } },
        },
      };
      const ambiguous: JSONSchema = {
        type: "object",
        properties: {
          result: {
            anyOf: [
              profile,
              { type: "string", ifc: { confidentiality: ["other"] } },
            ],
          },
          candidates: { type: "array", items: profile },
        },
      };
      const seed = runtime.edit();
      runtime.getCell(space, "wish", ambiguous, seed).set({
        candidates: [{ name: "Bob" }],
      });
      seed.prepareCfc();
      expect((await seed.commit().settled).error).toBeUndefined();

      const tx = runtime.edit();
      const resolved = runtime.getCell(space, "wish-resolved", profile, tx);
      resolved.set({ name: "Ada" });
      runtime.getCell(space, "wish", ambiguous, tx).set({
        result: resolved,
        candidates: [],
      });
      runtime.prepareTxForCommit(tx);
      const prepare = tx.getCfcState().prepare;
      const state = tx.getCfcState();
      console.error(
        "[sizes-diag crash]",
        JSON.stringify({
          relevant: state.relevant,
          mode: state.enforcementMode,
          cal: state.contentAddressedLabels,
          env: state.decomposedEnvelopes,
          prepare: prepare.status,
          diagnostics: state.diagnostics,
          wishCfc: runtime.getCell(space, "wish").getMetaRaw("cfc"),
          wishSchema: runtime.getCell(space, "wish").getMetaRaw("schema"),
        }),
      );
      const result = await tx.commit().settled;

      const stats = runtime.getCfcStats();
      expect({
        error: result.error?.name,
        relevant: tx.getCfcState().relevant,
        status: prepare.status,
        reasons: prepare.status === "invalidated" ? prepare.reasons.length : 0,
        relevantTx: stats.cfcRelevantTx,
        preparedTx: stats.cfcPreparedTx,
        tally: runtime.getSizes().cfcRejectionsByReason,
      }).toEqual({
        error: "CommitPreparationError",
        relevant: true,
        status: "invalidated",
        reasons: 1,
        relevantTx: 2,
        preparedTx: 1,
        tally: { "CFC commit preparation crashed": 1 },
      });
    });
  });
});
