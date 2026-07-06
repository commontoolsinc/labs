import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model/schema-hash";
import { CFC_ATOM_TYPE, cfcAtom } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { CfcPolicyRecordInput, ExchangeRule } from "../src/cfc/policy.ts";
import { preparedDigestFor } from "../src/cfc/canonical.ts";
import type { PreparedDigestInput } from "../src/cfc/types.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-policy-boundary");

// Epic B5 (docs/plans/cfc-future-work-implementation.md §3): exchange-rule
// evaluation wired into the boundary gates behind the cfcPolicyEvaluation
// dial. `off` is byte-identical to the pre-dial gates; `observe` evaluates
// and diagnoses but decides on the raw label; `enforce` decides on the
// REWRITTEN label and fails closed on fuel exhaustion.

const SPACE_ATOM = cfcAtom.space("space:x");
const USER_ALICE = cfcAtom.user("did:key:alice");
const USER_MALLORY = cfcAtom.user("did:key:mallory");
const ROLE_ALICE = cfcAtom.hasRole("did:key:alice", "space:x", "reader");

// Space-reader access (spec §4.3.3 worked example), applicable only at
// network-class boundaries.
const spaceReaderAtNetwork: ExchangeRule = {
  id: "space-reader-at-network",
  appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
  preCondition: {
    integrity: [{
      type: CFC_ATOM_TYPE.HasRole,
      principal: { var: "$p" },
      space: { var: "$s" },
      role: "reader",
    }],
    boundary: [{
      type: CFC_ATOM_TYPE.BoundaryContext,
      key: "sinkClass",
      value: "network",
    }],
  },
  post: {
    addAlternatives: [{ type: CFC_ATOM_TYPE.User, subject: { var: "$p" } }],
  },
};

const POLICY: CfcPolicyRecordInput[] = [{
  id: "boundary-test-policy",
  rules: [spaceReaderAtNetwork],
}];

// An add/drop ping-pong over the Space atom: never converges, so enforce
// must fail closed on fuel exhaustion (spec §4.4.5 bounded evaluator).
const CYCLING_POLICY: CfcPolicyRecordInput[] = [{
  id: "cycling-policy",
  rules: [
    {
      id: "add-marker",
      appliesTo: { type: CFC_ATOM_TYPE.Space, id: { var: "$s" } },
      post: {
        addAlternatives: [{ type: "https://example.com/atoms/Marker" }],
      },
    },
    {
      id: "drop-marker",
      appliesTo: { type: "https://example.com/atoms/Marker" },
      post: { dropClause: true },
    },
  ],
}];

const SECRET_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["never-fits"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const seedSpaceLabeledCell = async (
  runtime: Runtime,
  id: string,
  label: { confidentiality: unknown[]; integrity?: unknown[] },
): Promise<void> => {
  const seed = runtime.edit();
  const target = runtime.getCell(signer.did(), id, undefined, seed);
  const targetId = target.getAsNormalizedFullLink().id;
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: targetId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: SECRET_SCHEMA.taggedHashString,
      labelMap: { version: 1, entries: [{ path: ["secret"], label }] },
    },
  });
  seed.writeOrThrow({
    space: signer.did(),
    scope: "space",
    id: `cid:${SECRET_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: SECRET_SCHEMA.schema });
  expect((await seed.commit()).ok).toBeDefined();
};

// Read the labeled cell and enqueue a fetchJson sink request; prepare and
// return the recorded prepare reasons + diagnostics.
const readThenSink = (
  runtime: Runtime,
  id: string,
): { reasons: readonly string[]; diagnostics: readonly string[] } => {
  const tx = runtime.edit();
  const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
  expect(cell.key("secret").get()).toBe("rosebud");
  enqueueSinkRequestPostCommitEffect(
    tx,
    "fetchJson",
    "fetchJson:policy-boundary-test",
    createFrozenRequestSnapshot({ url: "https://example.com/exfil" }),
    "fetchJson-start",
    () => {},
  );
  tx.prepareCfc();
  const state = tx.getCfcState();
  const reasons = state.prepare.status === "invalidated"
    ? state.prepare.reasons
    : [];
  const result = {
    reasons: [...reasons],
    diagnostics: [...state.diagnostics],
  };
  tx.abort();
  return result;
};

const withRuntime = async (
  opts: {
    policyEvaluation?: "off" | "observe" | "enforce";
    policyRecords?: CfcPolicyRecordInput[];
  },
  body: (runtime: Runtime) => void | Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-explicit",
    cfcSinkMaxConfidentiality: { fetchJson: [USER_ALICE] },
    cfcPolicyRecords: opts.policyRecords ?? POLICY,
    cfcPolicyEvaluation: opts.policyEvaluation ?? "off",
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

describe("CFC policy evaluation at boundaries (B5)", () => {
  describe("sink-request egress gate", () => {
    it("off: decides on the raw label even when a rule would admit", async () => {
      await withRuntime({ policyEvaluation: "off" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-off", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-off");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("enforce: admits via the rewritten label (guarded add-alternative)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-enforce", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-enforce");
        expect(reasons).toEqual([]);
      });
    });

    it("enforce: an unsatisfied integrity guard never fires (inv-3)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        // Same clause, NO HasRole evidence.
        await seedSpaceLabeledCell(runtime, "policy-no-evidence", {
          confidentiality: [SPACE_ATOM],
        });
        const { reasons } = readThenSink(runtime, "policy-no-evidence");
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
      });
    });

    it("enforce: a boundary guard for another sink class never fires", async () => {
      const displayOnly: CfcPolicyRecordInput[] = [{
        id: "display-only-policy",
        rules: [{
          ...spaceReaderAtNetwork,
          id: "space-reader-at-display",
          preCondition: {
            ...spaceReaderAtNetwork.preCondition,
            boundary: [{
              type: CFC_ATOM_TYPE.BoundaryContext,
              key: "sinkClass",
              value: "display",
            }],
          },
        }],
      }];
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: displayOnly },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-display-guard", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenSink(runtime, "policy-display-guard");
          expect(
            reasons.some((reason) =>
              reason.includes("sink-request confidentiality exceeds ceiling")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: releasing one clause never releases a sibling (inv-11)", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-sibling", {
          confidentiality: [SPACE_ATOM, USER_MALLORY],
          integrity: [ROLE_ALICE],
        });
        const { reasons } = readThenSink(runtime, "policy-sibling");
        // The Space clause is admitted through the rewrite, but Mallory's
        // clause stays outside the ceiling and still rejects.
        const offending = reasons.find((reason) =>
          reason.includes("sink-request confidentiality exceeds ceiling")
        );
        expect(offending).toBeDefined();
        expect(offending).toContain("did:key:mallory");
        expect(offending).not.toContain("space:x");
      });
    });

    it("observe: decides as off, and diagnoses the would-be admission", async () => {
      await withRuntime({ policyEvaluation: "observe" }, async (runtime) => {
        await seedSpaceLabeledCell(runtime, "policy-observe", {
          confidentiality: [SPACE_ATOM],
          integrity: [ROLE_ALICE],
        });
        const { reasons, diagnostics } = readThenSink(
          runtime,
          "policy-observe",
        );
        expect(
          reasons.some((reason) =>
            reason.includes("sink-request confidentiality exceeds ceiling")
          ),
        ).toBe(true);
        expect(
          diagnostics.some((note) =>
            note.includes("policy-evaluation(observe)") &&
            note.includes("from reject to fit")
          ),
        ).toBe(true);
      });
    });

    it("enforce: fuel exhaustion fails closed", async () => {
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: CYCLING_POLICY },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-exhausted", {
            confidentiality: [SPACE_ATOM],
          });
          const { reasons } = readThenSink(runtime, "policy-exhausted");
          expect(
            reasons.some((reason) =>
              reason.includes("policy evaluation exhausted fuel")
            ),
          ).toBe(true);
        },
      );
    });

    it("observe: fuel exhaustion is diagnosed, decision unchanged", async () => {
      await withRuntime(
        { policyEvaluation: "observe", policyRecords: CYCLING_POLICY },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "policy-exhausted-observe", {
            confidentiality: [SPACE_ATOM],
          });
          const { reasons, diagnostics } = readThenSink(
            runtime,
            "policy-exhausted-observe",
          );
          expect(
            reasons.some((reason) =>
              reason.includes("sink-request confidentiality exceeds ceiling")
            ),
          ).toBe(true);
          expect(diagnostics.some((note) => note.includes("fuel exhausted")))
            .toBe(true);
        },
      );
    });
  });

  describe("input-requirement maxConfidentiality gate", () => {
    const sinkSchema = {
      type: "object",
      properties: {
        out: {
          type: "string",
          ifc: { maxConfidentiality: [USER_ALICE] },
        },
      },
      required: ["out"],
    } as const satisfies JSONSchema;

    // No boundary guard: the input-requirement gate is a write-target gate,
    // not a sink — it mints no BoundaryContext atoms.
    const unguardedPolicy: CfcPolicyRecordInput[] = [{
      id: "input-gate-policy",
      rules: [{
        ...spaceReaderAtNetwork,
        id: "space-reader-anywhere",
        preCondition: {
          integrity: spaceReaderAtNetwork.preCondition!.integrity,
        },
      }],
    }];

    const readThenWrite = (
      runtime: Runtime,
      id: string,
    ): { reasons: readonly string[] } => {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), id, SECRET_SCHEMA.schema, tx);
      expect(cell.key("secret").get()).toBe("rosebud");
      runtime.getCell(signer.did(), `${id}-sink`, sinkSchema, tx)
        .set({ out: "derived" });
      tx.prepareCfc();
      const state = tx.getCfcState();
      const reasons = state.prepare.status === "invalidated"
        ? [...state.prepare.reasons]
        : [];
      tx.abort();
      return { reasons };
    };

    it("off: rejects on the raw label", async () => {
      await withRuntime(
        { policyEvaluation: "off", policyRecords: unguardedPolicy },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-off", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-off");
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
        },
      );
    });

    it("enforce: subsumption-fits the rewritten consumed label", async () => {
      await withRuntime(
        { policyEvaluation: "enforce", policyRecords: unguardedPolicy },
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-enforce", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-enforce");
          expect(reasons).toEqual([]);
        },
      );
    });

    it("enforce: rules gated on boundary context cannot fire at a write gate", async () => {
      await withRuntime(
        { policyEvaluation: "enforce" }, // POLICY requires sinkClass network
        async (runtime) => {
          await seedSpaceLabeledCell(runtime, "input-boundary-guarded", {
            confidentiality: [SPACE_ATOM],
            integrity: [ROLE_ALICE],
          });
          const { reasons } = readThenWrite(runtime, "input-boundary-guarded");
          expect(
            reasons.some((reason) =>
              reason.includes("maxConfidentiality failed")
            ),
          ).toBe(true);
        },
      );
    });
  });

  describe("dial + digest plumbing", () => {
    it("pins enforce against mid-tx weakening", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, (runtime) => {
        const tx = runtime.edit();
        expect(tx.getCfcState().policyEvaluationMode).toBe("enforce");
        expect(() => tx.setCfcPolicyEvaluationMode("off")).toThrow(
          /cannot be weakened/,
        );
        expect(() => tx.setCfcPolicyEvaluationMode("observe")).toThrow(
          /cannot be weakened/,
        );
        // Re-asserting enforce is fine.
        tx.setCfcPolicyEvaluationMode("enforce");
        tx.abort();
      });
    });

    it("folds the policy snapshot digest into the prepared digest", () => {
      const base: PreparedDigestInput = {
        consumedReads: [],
        attemptedWrites: [],
        writes: [],
        dereferenceTraces: [],
        triggerReads: [],
        writePolicyInputs: [],
      };
      const withA = preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-a" },
      });
      const withB = preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-b" },
      });
      const without = preparedDigestFor(base);
      expect(withA).not.toBe(withB);
      expect(withA).not.toBe(without);
      // Stable for identical inputs.
      expect(preparedDigestFor({
        ...base,
        policySnapshot: { digest: "sha256:policy-a" },
      })).toBe(withA);
    });

    it("records the snapshot digest in the prepared input of a live tx", async () => {
      await withRuntime({ policyEvaluation: "enforce" }, (runtime) => {
        const tx = runtime.edit();
        const cell = runtime.getCell(
          signer.did(),
          "digest-probe",
          {
            type: "object",
            properties: {
              value: { type: "string", ifc: { confidentiality: ["x"] } },
            },
          } as const satisfies JSONSchema,
          tx,
        );
        cell.set({ value: "v" });
        tx.prepareCfc();
        const state = tx.getCfcState();
        expect(state.prepare.status).toBe("prepared");
        if (state.prepare.status === "prepared") {
          expect(state.prepare.input.policySnapshot?.digest)
            .toBe(runtime.cfcPolicySnapshot!.digest);
        }
        tx.abort();
      });
    });
  });
});
