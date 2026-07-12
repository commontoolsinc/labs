import { assertEquals, assertThrows } from "@std/assert";
import {
  type ActionSettlement,
  toAcceptedCommitSeq,
  toInputBasisSeq,
} from "../v2.ts";

Deno.test("execution basis and accepted commit sequences stay nominally distinct", () => {
  const inputBasisSeq = toInputBasisSeq(3);
  const acceptedCommitSeq = toAcceptedCommitSeq(7);
  assertEquals(Number(inputBasisSeq), 3);
  assertEquals(Number(acceptedCommitSeq), 7);
  assertThrows(() => toInputBasisSeq(-1), TypeError);
  assertThrows(() => toAcceptedCommitSeq(0), TypeError);

  type Committed = Extract<ActionSettlement, { outcome: "committed" }>;
  const claim = {} as Committed["claim"];
  const valid: Committed = {
    branch: "",
    claim,
    inputBasisSeq,
    outcome: "committed",
    acceptedCommitSeq,
  };
  assertEquals(valid.inputBasisSeq, inputBasisSeq);

  const swapped = {
    ...valid,
    // @ts-expect-error AcceptedCommitSeq must not satisfy InputBasisSeq.
    inputBasisSeq: acceptedCommitSeq,
    // @ts-expect-error InputBasisSeq must not satisfy AcceptedCommitSeq.
    acceptedCommitSeq: inputBasisSeq,
  } satisfies Committed;
  void swapped;
});
