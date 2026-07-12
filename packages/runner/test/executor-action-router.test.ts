import { assertEquals, assertStrictEquals } from "@std/assert";
import type {
  ActionClaimKey,
  ClientCommit,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import { toDocumentPath } from "@commonfabric/memory/v2";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";

const SPACE = "did:key:z6Mk-action-router";
const action = {};
const output = {
  space: SPACE,
  scope: "space" as const,
  id: "of:action-router-output",
  path: ["value"],
};

const observation = () => ({
  version: 2 as const,
  ownerSpace: SPACE,
  branch: "",
  pieceId: "space:of:action-router-piece",
  processGeneration: 1,
  actionId: "action:compute",
  actionKind: "computation" as const,
  implementationFingerprint: "impl:action-router",
  runtimeFingerprint: "runtime:action-router",
  observedAtSeq: 0,
  transactionKind: "action-run" as const,
  reads: [{
    space: SPACE,
    scope: "space" as const,
    id: "of:action-router-input",
    path: ["value"],
  }],
  shallowReads: [],
  actualChangedWrites: [output],
  currentKnownWrites: [output],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: "impl:action-router",
    runtimeFingerprint: "runtime:action-router",
    piece: {
      space: SPACE,
      scope: "space" as const,
      id: "of:action-router-piece",
      path: ["value"],
    },
    reads: [{
      space: SPACE,
      scope: "space" as const,
      id: "of:action-router-input",
      path: ["value"],
    }],
    writes: [output],
    materializerWriteEnvelopes: [],
    directOutputs: [output],
  },
  status: "success" as const,
});

const commit = (): ClientCommit => ({
  localSeq: 1,
  reads: {
    confirmed: [{
      id: "of:action-router-input",
      scope: "space",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [{
    op: "set",
    id: "of:action-router-output",
    scope: "space",
    value: { value: 42 },
  }],
  schedulerObservation: observation(),
});

const key: ActionClaimKey = {
  branch: "",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:action-router-piece",
  actionId: "action:compute",
  actionKind: "computation",
  implementationFingerprint: "impl:action-router",
  runtimeFingerprint: "runtime:action-router",
};

Deno.test("executor action router reports a pure candidate then routes its exact claim upstream", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const claims = new WeakMap<object, ExecutionClaim>();
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: (sourceAction) => claims.get(sourceAction),
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const first = commit();
  assertEquals(
    await router({
      space: SPACE,
      commit: first,
      sourceAction: action,
    }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(candidates, [{ claimKey: key, sourceAction: action }]);
  assertEquals(diagnostics, []);

  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 5,
    claimGeneration: 7,
    expiresAt: 100_000,
  };
  claims.set(action, claim);
  const claimed = commit();
  assertEquals(
    await router({
      space: SPACE,
      commit: claimed,
      sourceAction: action,
    }),
    { disposition: "upstream" },
  );
  assertEquals(
    (claimed.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 5,
      claimGeneration: 7,
    },
  );
});

Deno.test("executor action router rejects the whole dynamic scoped transaction", async () => {
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {
      throw new Error("scoped transaction must not become a candidate");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  const scoped = commit();
  scoped.reads.confirmed[0]!.scope = "user";

  assertEquals(
    await router({
      space: SPACE,
      commit: scoped,
      sourceAction: action,
    }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "dynamic-non-space-read-scope",
  ]);
});

Deno.test("executor action router keeps broker-required effects local", async () => {
  const effectCommit = commit();
  (effectCommit.schedulerObservation as Record<string, unknown>).actionKind =
    "effect";
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {
      throw new Error("effects require W1.4 before claim publication");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const result = await router({
    space: SPACE,
    commit: effectCommit,
    sourceAction: action,
  });
  assertEquals(result, { disposition: "local", kind: "executor-shadow" });
  assertStrictEquals(diagnostics[0]?.diagnosticCode, "broker-required");
});
