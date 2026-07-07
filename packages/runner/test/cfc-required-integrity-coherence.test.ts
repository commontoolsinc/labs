import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import {
  cfcIntegritySatisfiesFloor,
  cfcIntegritySatisfiesFloorCoherently,
  cfcIntegrityWitnessKey,
} from "../src/cfc/observation.ts";
import type { JSONSchema } from "../src/builder/types.ts";

const signer = await Identity.fromPassphrase("runner-cfc-integrity-coherence");

// Epic B5, the §8.10.3 soundness edge: `requiredIntegrity` satisfaction is
// pattern-based (a floor names exactly the fields it demands) and — when one
// requirement spans multiple consumed leaves — COHERENT: every leaf must
// satisfy it via one shared witness atom. "Each input was screened by
// someone" is not "the inputs were screened". Red→green documented in the PR:
// with pattern matching alone (coherence hunk reverted), the heterogeneous
// scenario below wrongly commits.

const REVIEWED = "https://example.com/atoms/Reviewed";
const reviewedBy = (by: string) => ({ type: REVIEWED, by });

describe("CFC requiredIntegrity coherence (B5)", () => {
  describe("shared predicate semantics", () => {
    it("floors are atom patterns: named fields constrain, others don't", () => {
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [{ type: REVIEWED }],
      )).toBe(true);
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [{ type: REVIEWED, by: "r2" }],
      )).toBe(false);
      // Exact concrete floors keep their meaning (degenerate pattern).
      expect(cfcIntegritySatisfiesFloor(
        [reviewedBy("r1")],
        [reviewedBy("r1")],
      )).toBe(true);
      expect(cfcIntegritySatisfiesFloor([], [{ type: REVIEWED }])).toBe(false);
    });

    it("coherence: one shared witness across all leaves, per requirement", () => {
      const required = [{ type: REVIEWED }];
      // Homogeneous witness: both leaves carry the SAME atom.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], [reviewedBy("r1"), reviewedBy("r3")]],
        required,
      )).toBe(true);
      // Heterogeneous witnesses: each leaf satisfies the pattern, but via
      // different atoms — incoherent, must fail.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], [reviewedBy("r2")]],
        required,
      )).toBe(false);
      // A leaf with no match at all fails outright.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")], []],
        required,
      )).toBe(false);
      // Single leaf reduces to the plain floor.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[reviewedBy("r1")]],
        required,
      )).toBe(true);
      // No leaves: vacuously satisfied (the caller's quantification decides
      // whether the gate runs at all).
      expect(cfcIntegritySatisfiesFloorCoherently([], required)).toBe(true);
    });

    it("requirements are per-requirement coherent, jointly conjunctive", () => {
      const approved = { type: "https://example.com/atoms/Approved" };
      // Requirement 1 shares witness r1; requirement 2 shares `approved`.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [
          [reviewedBy("r1"), approved],
          [reviewedBy("r1"), reviewedBy("r2"), approved],
        ],
        [{ type: REVIEWED }, approved],
      )).toBe(true);
      // Requirement 2's witness missing from one leaf: the whole floor fails.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [
          [reviewedBy("r1"), approved],
          [reviewedBy("r1")],
        ],
        [{ type: REVIEWED }, approved],
      )).toBe(false);
    });

    it("keys valueRef-scoped witnesses with scope.projection dropped (§8.10.3)", () => {
      const bound = (projection?: string) => ({
        type: REVIEWED,
        by: "r1",
        scope: {
          valueRef: { "/": "value-doc" },
          ...(projection === undefined ? {} : { projection }),
        },
      });
      // Two projections of the same bound value are the SAME witness.
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/a")))
        .toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/b")));
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, bound()))
        .toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound("/a")));
      // Different valueRefs stay distinct witnesses.
      const otherValue = {
        type: REVIEWED,
        by: "r1",
        scope: { valueRef: { "/": "other-doc" } },
      };
      expect(cfcIntegrityWitnessKey({ type: REVIEWED }, otherValue))
        .not.toBe(cfcIntegrityWitnessKey({ type: REVIEWED }, bound()));
      // Non-matching atoms have no witness key.
      expect(cfcIntegrityWitnessKey({ type: "other" }, bound())).toBeNull();
      // Coherence across projections of one bound value holds.
      expect(cfcIntegritySatisfiesFloorCoherently(
        [[bound("/a")], [bound("/b")]],
        [{ type: REVIEWED }],
      )).toBe(true);
    });
  });

  describe("read-side gate integration", () => {
    const sourceSchema = (id: string) =>
      ({
        type: "string",
        ifc: {
          confidentiality: ["s"],
          integrity: [reviewedBy(id)],
        },
      }) as JSONSchema;

    const runGate = async (
      witnesses: [string, string],
      required: unknown,
    ): Promise<{ ok: boolean; message?: string }> => {
      const storageManager = StorageManager.emulate({ as: signer });
      const runtime = new Runtime({
        apiUrl: new URL("https://example.com"),
        storageManager,
        cfcEnforcementMode: "enforce-explicit",
      });
      try {
        for (const [index, witness] of witnesses.entries()) {
          const seed = runtime.edit();
          runtime.getCell(
            signer.did(),
            `coherence-src-${index}`,
            sourceSchema(witness),
            seed,
          ).set(`value-${index}`);
          seed.prepareCfc();
          expect((await seed.commit()).ok).toBeDefined();
        }

        const tx = runtime.edit();
        for (const [index, witness] of witnesses.entries()) {
          runtime.getCell(
            signer.did(),
            `coherence-src-${index}`,
            sourceSchema(witness),
            tx,
          ).get();
        }
        runtime.getCell(
          signer.did(),
          "coherence-sink",
          {
            type: "object",
            properties: {
              out: {
                type: "string",
                ifc: { requiredIntegrity: [required] },
              },
            },
            required: ["out"],
          } as JSONSchema,
          tx,
        ).set({ out: "derived" });
        // "" = prepare rejected; the commit result carries the reason.
        tx.prepareCfc();
        const result = await tx.commit();
        return {
          ok: result.ok !== undefined,
          message: (result.error as Error | undefined)?.message,
        };
      } finally {
        await runtime.dispose();
        await storageManager.close();
      }
    };

    it("rejects heterogeneous per-leaf witnesses for one object-level requirement", async () => {
      // RED without the coherence upgrade: both reads match the pattern via
      // DIFFERENT witnesses and the commit wrongly succeeds.
      const result = await runGate(["r1", "r2"], { type: REVIEWED });
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });

    it("admits a shared witness across every consumed read", async () => {
      const result = await runGate(["r1", "r1"], { type: REVIEWED });
      expect(result.ok).toBe(true);
    });

    it("still rejects when a read matches nothing at all", async () => {
      const result = await runGate(["r1", "r2"], reviewedBy("r1"));
      expect(result.ok).toBe(false);
      expect(result.message).toContain("requiredIntegrity failed");
    });
  });
});
