import { assertEquals, assertStrictEquals } from "@std/assert";
import type {
  ActionClaimKey,
  ClientCommit,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import {
  sessionExecutionContextKey,
  toDocumentPath,
  userExecutionContextKey,
} from "@commonfabric/memory/v2";
import {
  type ClientActionRouteDiagnostic,
  routeClientActionTransaction,
} from "../src/client-execution/action-transaction-router.ts";
import { ownChainContextKeys } from "../src/scheduler/servability.ts";

const SPACE = "did:key:z6Mk-client-action-router";
const OTHER_SPACE = "did:key:z6Mk-client-action-router-other";
// Colon-bearing principals end-to-end (amendment A18): the canonical helpers
// percent-encode the segments, so naive `user:${did}` concatenation must
// never match.
const MY_DID = "did:key:z6Mk-client-action-router-me";
const MY_SESSION_ID = "session:client-action-router";
const OTHER_DID = "did:key:z6Mk-client-action-router-you";
const ownChain = ownChainContextKeys(MY_DID, MY_SESSION_ID);
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
      { claims: [live], ownContextKeys: ownChain, builtinPassivity: false },
    ),
    { disposition: "local", kind: "claimed-overlay", claim: live },
  );
});

Deno.test("two actions in one piece route independently by exact claim key", () => {
  const claimed = commit();
  const unclaimed = commit();
  const unclaimedObservation = unclaimed.schedulerObservation as ReturnType<
    typeof observation
  >;
  Object.assign(unclaimedObservation, { actionId: "action:other" });

  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: claimed, sourceAction },
      { claims: [claim()], ownContextKeys: ownChain, builtinPassivity: false },
    ).disposition,
    "local",
  );
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: unclaimed, sourceAction: {} },
      { claims: [claim()], ownContextKeys: ownChain, builtinPassivity: false },
    ),
    { disposition: "upstream" },
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
        {
          claims: [claim(mismatch)],
          ownContextKeys: ownChain,
          builtinPassivity: false,
        },
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
      {
        claims: [claim({ actionId: "action:other" })],
        ownContextKeys: ownChain,
      },
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
      { claims: [claim()], ownContextKeys: ownChain },
    ),
    { disposition: "upstream" },
  );

  const handler = commit();
  (handler.schedulerObservation as Record<string, unknown>).actionKind =
    "event-handler";
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: handler, sourceAction },
      { claims: [claim()], ownContextKeys: ownChain },
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
          ownContextKeys: ownChain,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      ),
      { disposition: "upstream" },
    );
    assertEquals(diagnostics.at(-1)?.diagnosticCode, diagnosticCode);
  }
});

// --- C1.6: chain-scoped routing (context-lattice §2, amendments A3/A10/A18) —

Deno.test("client action router accepts every member of its own lattice chain", () => {
  // A10: the accept set is the FULL own chain. The session member cannot be
  // issued before C2, so it is exercised synthetically here.
  for (
    const contextKey of [
      "space" as const,
      userExecutionContextKey(MY_DID),
      sessionExecutionContextKey(MY_DID, MY_SESSION_ID),
    ]
  ) {
    const live = claim({ contextKey });
    assertEquals(
      routeClientActionTransaction(
        { space: SPACE, commit: commit(), sourceAction },
        { claims: [live], ownContextKeys: ownChain, builtinPassivity: false },
      ),
      { disposition: "local", kind: "claimed-overlay", claim: live },
    );
  }
});

Deno.test("client action router rejects contexts outside its own chain", () => {
  for (
    const contextKey of [
      userExecutionContextKey(OTHER_DID),
      sessionExecutionContextKey(OTHER_DID, MY_SESSION_ID),
      sessionExecutionContextKey(MY_DID, "session:other"),
      // A18: raw concatenation is not the canonical encoding — a claim whose
      // colon-bearing segments were never percent-encoded must not match.
      `user:${MY_DID}` as ExecutionClaim["contextKey"],
      `session:${MY_DID}:${MY_SESSION_ID}` as ExecutionClaim["contextKey"],
    ]
  ) {
    assertEquals(
      routeClientActionTransaction(
        { space: SPACE, commit: commit(), sourceAction },
        {
          claims: [claim({ contextKey })],
          ownContextKeys: ownChain,
          builtinPassivity: false,
        },
      ),
      { disposition: "upstream" },
    );
  }
});

Deno.test("dual chain-matching claims route to neither and surface one named diagnostic", () => {
  // A3: two live claims on one chain should be impossible (issuance-side
  // routing disjointness); when observed, deterministically fail open rather
  // than picking one, and count the event.
  const diagnostics: ClientActionRouteDiagnostic[] = [];
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: commit(), sourceAction },
      {
        claims: [
          claim(),
          claim({ contextKey: userExecutionContextKey(MY_DID) }),
        ],
        ownContextKeys: ownChain,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ),
    { disposition: "upstream" },
  );
  assertEquals(diagnostics.length, 1);
  assertEquals(diagnostics[0]?.diagnosticCode, "dual-chain-claim-match");
});

Deno.test("a foreign-chain claim does not make a single own-chain match ambiguous", () => {
  const diagnostics: ClientActionRouteDiagnostic[] = [];
  const live = claim({ contextKey: userExecutionContextKey(MY_DID) });
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: commit(), sourceAction },
      {
        claims: [
          claim({ contextKey: userExecutionContextKey(OTHER_DID) }),
          live,
        ],
        ownContextKeys: ownChain,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ),
    { disposition: "local", kind: "claimed-overlay", claim: live },
  );
  assertEquals(diagnostics, []);
});

Deno.test("the accepted claim's context keys both servability firewalls", () => {
  // A15/A19: the client carries the C1.5a lane parameterization of both
  // classifiers keyed by the ACCEPTED claim's contextKey — there is
  // deliberately no rank comparison against any local floor estimate (A10).
  const userScopedCommit = (): ClientCommit => {
    const candidate = commit();
    const observed = candidate.schedulerObservation as ReturnType<
      typeof observation
    >;
    const userRead = {
      space: SPACE,
      scope: "user" as const,
      id: "of:client-action-router-input",
      path: ["value"],
    };
    Object.assign(observed, { reads: [userRead] });
    Object.assign(observed.completeActionScopeSummary, { reads: [userRead] });
    candidate.reads.confirmed[0]!.scope = "user";
    return candidate;
  };

  // A user-context claim admits the lane principal's user-scoped surfaces.
  const live = claim({ contextKey: userExecutionContextKey(MY_DID) });
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: userScopedCommit(), sourceAction },
      { claims: [live], ownContextKeys: ownChain },
    ),
    { disposition: "local", kind: "claimed-overlay", claim: live },
  );

  // The same surfaces under a space-context claim keep the space-lane
  // byte-identical behavior: fail open upstream with the static diagnostic.
  const diagnostics: ClientActionRouteDiagnostic[] = [];
  assertEquals(
    routeClientActionTransaction(
      { space: SPACE, commit: userScopedCommit(), sourceAction },
      {
        claims: [claim()],
        ownContextKeys: ownChain,
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    ),
    { disposition: "upstream" },
  );
  assertEquals(diagnostics[0]?.diagnosticCode, "non-space-read-scope");
});

Deno.test("client action router leaves the unclaimed commit object untouched", () => {
  const candidate = commit();
  const before = structuredClone(candidate);
  const route = routeClientActionTransaction(
    { space: SPACE, commit: candidate, sourceAction },
    { claims: [], ownContextKeys: ownChain },
  );
  assertEquals(route, { disposition: "upstream" });
  assertEquals(candidate, before);
  assertStrictEquals(
    candidate.schedulerObservation,
    candidate.schedulerObservation,
  );
});
