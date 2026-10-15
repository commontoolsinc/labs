import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { JSONSchema } from "../src/builder/types.ts";
import { Runtime, type RuntimeOptions } from "../src/runtime.ts";
import {
  CFC_REJECTION_REASON_LIMIT,
  CFC_REJECTION_REASON_OTHER,
  cfcRejectionReasonPrefix,
  CfcRejectionTally,
} from "../src/runtime-sizes.ts";
import type { Action } from "../src/scheduler/types.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

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

    it("returns a reason that names nothing whole", () => {
      expect(cfcRejectionReasonPrefix("prepared digest changed"))
        .toBe("prepared digest changed");
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
      expect(sizes.runtime.immutableSnapshots).toBe(0);
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

    it("counts the snapshots the immutable cell store retains", () => {
      const runtime = createRuntime();
      runtime.getImmutableCell(space, { value: 1 }, { type: "object" });
      runtime.getImmutableCell(space, { value: 2 }, { type: "object" });

      expect(runtime.getSizes().runtime.immutableSnapshots).toBe(2);
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
      runtime.scheduler.subscribe(link, { isEffect: true });
      await runtime.scheduler.idleWithPendingCommits();

      expect(errors.map((error) => error.name)).toEqual([
        "CfcCommitRefusalError",
      ]);
      expect(runtime.getSizes().cfcRejectionsByReason).toEqual({
        "missing link source metadata": 1,
      });
    });
  });
});
