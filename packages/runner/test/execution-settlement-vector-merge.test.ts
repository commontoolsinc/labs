// C3.5 (C3A14/C3A15) — the RUNNER-side settlement coalescer
// (`mergeSuccessfulExecutionSettlementRecords`, backing both the
// early-settlement cache and pending-settlement coalescing) carries the
// vector basis: per-component maximum under the vacuous union — a
// component either side lacks rides through unchanged (absent is never
// zero and never satisfied), scalar-only merges stay byte-identical.
// Unit-level deliberately: the merged vector is not client-observable
// until C3.9's drop rule consumes it (C3.9's acceptance owns the
// reconnect-snapshot and settlement-before-claim drop flows).
import { assertEquals } from "@std/assert";
import {
  type ActionSettlement,
  type ExecutionClaim,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "@commonfabric/memory/v2";
import { mergeSuccessfulExecutionSettlementRecords } from "../src/storage/v2.ts";

const SPACE = "did:key:z6Mk-settle-merge-home";
const SPACE_B = "did:key:z6Mk-settle-merge-b";
const SPACE_C = "did:key:z6Mk-settle-merge-c";

const claim: ExecutionClaim = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:piece:merge",
  actionId: "action:merge",
  actionKind: "computation",
  implementationFingerprint: "impl:v1",
  runtimeFingerprint: "runtime:v1",
  leaseGeneration: 1,
  claimGeneration: 1,
  expiresAt: 9_999_999,
};

const settlement = (
  options: {
    inputBasisSeq: number;
    inputBasis?: readonly { space: string; seq: number }[];
    acceptedCommitSeq?: number;
  },
): ActionSettlement =>
  options.acceptedCommitSeq === undefined
    ? {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(options.inputBasisSeq),
      ...(options.inputBasis !== undefined
        ? {
          inputBasis: options.inputBasis.map((component) => ({
            space: component.space,
            seq: toInputBasisSeq(component.seq),
          })),
        }
        : {}),
      outcome: "no-op",
    }
    : {
      branch: "",
      claim,
      inputBasisSeq: toInputBasisSeq(options.inputBasisSeq),
      ...(options.inputBasis !== undefined
        ? {
          inputBasis: options.inputBasis.map((component) => ({
            space: component.space,
            seq: toInputBasisSeq(component.seq),
          })),
        }
        : {}),
      outcome: "committed",
      acceptedCommitSeq: toAcceptedCommitSeq(options.acceptedCommitSeq),
    };

Deno.test("C3.5 (C3A14): the runner merge takes per-component maxima under the vacuous union", () => {
  const merged = mergeSuccessfulExecutionSettlementRecords(
    settlement({
      inputBasisSeq: 5,
      inputBasis: [
        { space: SPACE, seq: 5 },
        { space: SPACE_B, seq: 9 },
        { space: SPACE_C, seq: 2 },
      ],
      acceptedCommitSeq: 6,
    }),
    settlement({
      inputBasisSeq: 7,
      inputBasis: [
        { space: SPACE, seq: 7 },
        { space: SPACE_B, seq: 4 },
      ],
    }),
  );
  // The accepted-data barrier survives; scalar takes the max; the vector
  // unions with per-component maxima — the second settlement's missing C
  // component does NOT erase the first's (C3A15: absent is vacuous).
  assertEquals(merged, {
    branch: "",
    claim,
    inputBasisSeq: toInputBasisSeq(7),
    inputBasis: [
      { space: SPACE_B, seq: toInputBasisSeq(9) },
      { space: SPACE_C, seq: toInputBasisSeq(2) },
      { space: SPACE, seq: toInputBasisSeq(7) },
    ],
    outcome: "committed",
    acceptedCommitSeq: toAcceptedCommitSeq(6),
  });
});

Deno.test("C3.5 (C3A15): a scalar-only side neither zeroes nor erases the vector side; scalar-only merges stay byte-identical", () => {
  const vectorSide = settlement({
    inputBasisSeq: 5,
    inputBasis: [
      { space: SPACE, seq: 5 },
      { space: SPACE_B, seq: 9 },
    ],
  });
  const scalarSide = settlement({ inputBasisSeq: 7 });
  // Vector ⊔ scalar keeps the vector (scalar-only means NO components —
  // vacuous everywhere — not zero components).
  assertEquals(
    mergeSuccessfulExecutionSettlementRecords(vectorSide, scalarSide)
      .inputBasis,
    [
      { space: SPACE, seq: toInputBasisSeq(5) },
      { space: SPACE_B, seq: toInputBasisSeq(9) },
    ],
  );
  assertEquals(
    mergeSuccessfulExecutionSettlementRecords(scalarSide, vectorSide)
      .inputBasis,
    [
      { space: SPACE, seq: toInputBasisSeq(5) },
      { space: SPACE_B, seq: toInputBasisSeq(9) },
    ],
  );
  // Scalar-only ⊔ scalar-only: no inputBasis field materializes at all.
  const scalarMerge = mergeSuccessfulExecutionSettlementRecords(
    settlement({ inputBasisSeq: 5, acceptedCommitSeq: 6 }),
    scalarSide,
  );
  assertEquals("inputBasis" in scalarMerge, false);
  assertEquals(scalarMerge, {
    branch: "",
    claim,
    inputBasisSeq: toInputBasisSeq(7),
    outcome: "committed",
    acceptedCommitSeq: toAcceptedCommitSeq(6),
  });
});
