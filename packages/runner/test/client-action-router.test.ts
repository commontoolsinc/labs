import { assertEquals, assertStrictEquals } from "@std/assert";
import type {
  ActionClaimKey,
  ClientCommit,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import { toDocumentPath } from "@commonfabric/memory/v2";
import {
  type ClientActionRouteDiagnostic,
  routeClientActionTransaction,
} from "../src/client-execution/action-transaction-router.ts";

const SPACE = "did:key:z6Mk-client-action-router";
const OTHER_SPACE = "did:key:z6Mk-client-action-router-other";
const sourceAction = {};
const output = {
  space: SPACE,
  scope: "space" as const,
  id: "of:client-action-router-output",
  path: ["value"],
};

const observation = () => ({
  version: 2 as const,
  ownerSpace: SPACE,
  branch: "branch-a",
  pieceId: "space:of:client-action-router-piece",
  processGeneration: 1,
  actionId: "action:compute",
  actionKind: "computation" as const,
  implementationFingerprint: "impl:client-action-router",
  runtimeFingerprint: "runtime:client-action-router",
  observedAtSeq: 0,
  transactionKind: "action-run" as const,
  reads: [{
    space: SPACE,
    scope: "space" as const,
    id: "of:client-action-router-input",
    path: ["value"],
  }],
  shallowReads: [],
  actualChangedWrites: [output],
  currentKnownWrites: [output],
  materializerWriteEnvelopes: [],
  completeActionScopeSummary: {
    version: 1 as const,
    complete: true as const,
    implementationFingerprint: "impl:client-action-router",
    runtimeFingerprint: "runtime:client-action-router",
    piece: {
      space: SPACE,
      scope: "space" as const,
      id: "of:client-action-router-piece",
      path: ["value"],
    },
    reads: [{
      space: SPACE,
      scope: "space" as const,
      id: "of:client-action-router-input",
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
      id: "of:client-action-router-input",
      scope: "space",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [{
    op: "set",
    id: "of:client-action-router-output",
    scope: "space",
    value: { value: 42 },
  }],
  schedulerObservation: observation(),
});

const key: ActionClaimKey = {
  branch: "branch-a",
  space: SPACE,
  contextKey: "space",
  pieceId: "space:of:client-action-router-piece",
  actionId: "action:compute",
  actionKind: "computation",
  implementationFingerprint: "impl:client-action-router",
  runtimeFingerprint: "runtime:client-action-router",
};

const claim = (overrides: Partial<ExecutionClaim> = {}): ExecutionClaim => ({
  ...key,
  leaseGeneration: 3,
  claimGeneration: 5,
  expiresAt: 100_000,
  ...overrides,
});

Deno.test("client action router keeps an exact claimed computation local", () => {
  const live = claim();
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: commit(), sourceAction },
      { claims: [live], builtinPassivity: false },
    ),
    { disposition: "local", kind: "claimed-overlay", claim: live },
  );
});

Deno.test("client action router fails open when the full claim key mismatches", () => {
  for (
    const mismatch of [
      { branch: "branch-b" },
      { space: OTHER_SPACE },
      { actionId: "action:other" },
      { implementationFingerprint: "impl:other" },
      { runtimeFingerprint: "runtime:other" },
    ] satisfies Partial<ExecutionClaim>[]
  ) {
    assertEquals(
      routeClientActionTransaction(
        { space: SPACE, commit: commit(), sourceAction },
        { claims: [claim(mismatch)], builtinPassivity: false },
      ),
      { disposition: "upstream" },
    );
  }
});

Deno.test("client action router never matches server-authored provenance", () => {
  const candidate = commit();
  const observed = candidate.schedulerObservation as
    & ReturnType<
      typeof observation
    >
    & Record<string, unknown>;
  observed.executionProvenance = {
    claim: { ...key, actionId: "action:other" },
    onBehalfOf: "did:key:z6Mk-someone",
    leaseGeneration: 3,
    claimGeneration: 5,
    causedBy: [],
    inputBasisSeq: 2,
  };

  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: candidate, sourceAction },
      { claims: [claim({ actionId: "action:other" })] },
    ),
    { disposition: "upstream" },
  );
});

Deno.test("client action router keeps source and handler transactions upstream", () => {
  const noObservation = commit();
  delete noObservation.schedulerObservation;
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: noObservation, sourceAction },
      { claims: [claim()] },
    ),
    { disposition: "upstream" },
  );

  const handler = commit();
  (handler.schedulerObservation as Record<string, unknown>).actionKind =
    "event-handler";
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: handler, sourceAction },
      { claims: [claim()] },
    ),
    { disposition: "upstream" },
  );
});

Deno.test("client action router fails open for the whole dynamically unsupported transaction", () => {
  const diagnostics: ClientActionRouteDiagnostic[] = [];
  const cases: Array<[string, (value: ClientCommit) => void]> = [
    ["dynamic-non-space-read-scope", (value) => {
      value.reads.confirmed[0]!.scope = "user";
    }],
    ["dynamic-non-space-write-scope", (value) => {
      const operation = value.operations[0]!;
      if (operation.op !== "sqlite") operation.scope = "session";
    }],
    ["dynamic-sqlite-operation", (value) => {
      value.operations.push({
        op: "sqlite",
        db: { id: "db:test" },
        sql: "SELECT 1",
        params: [],
      });
    }],
    ["dynamic-branch-merge", (value) => {
      value.merge = {
        sourceBranch: "other",
        sourceSeq: 2,
        baseBranch: "branch-a",
        baseSeq: 1,
      };
    }],
  ];

  for (const [diagnosticCode, mutate] of cases) {
    const candidate = commit();
    mutate(candidate);
    assertEquals(
      routeClientActionTransaction(
        { space: SPACE, commit: candidate, sourceAction },
        {
          claims: [claim()],
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      ),
      { disposition: "upstream" },
    );
    assertEquals(diagnostics.at(-1)?.diagnosticCode, diagnosticCode);
  }
});

Deno.test("client action router leaves the unclaimed commit object untouched", () => {
  const candidate = commit();
  const before = structuredClone(candidate);
  const route = routeClientActionTransaction(
    { space: SPACE, commit: candidate, sourceAction },
    { claims: [] },
  );
  assertEquals(route, { disposition: "upstream" });
  assertEquals(candidate, before);
  assertStrictEquals(
    candidate.schedulerObservation,
    candidate.schedulerObservation,
  );
});
