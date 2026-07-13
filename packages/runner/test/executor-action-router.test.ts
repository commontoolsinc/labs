import { assertEquals, assertStrictEquals } from "@std/assert";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
import type {
  ActionClaimKey,
  ClientCommit,
  ExecutionClaim,
} from "@commonfabric/memory/v2";
import { toDocumentPath } from "@commonfabric/memory/v2";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
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

Deno.test("executor action router reoffers an unclaimed pure action then routes its exact claim upstream", async () => {
  const counts = getLoggerCountsBreakdown()["execution.executor"] ?? {};
  const shadowBaseline = counts["execution-server-shadow-action-run"]?.debug ??
    0;
  const authoritativeBaseline =
    counts["execution-server-authoritative-action-run"]?.debug ?? 0;
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const started: Array<{ claim: ExecutionClaim; sourceAction: object }> = [];
  const claims = new WeakMap<object, ExecutionClaim>();
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: (sourceAction) => claims.get(sourceAction),
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onAttemptStarted: (claim, sourceAction) =>
      started.push({ claim, sourceAction }),
  });

  const first = commit();
  const firstRoute = await router({
    space: SPACE,
    commit: first,
    sourceAction: action,
  });
  assertEquals(firstRoute.disposition, "local");
  if (firstRoute.disposition !== "local") throw new Error("expected local");
  assertEquals(firstRoute.kind, "executor-shadow");
  assertEquals(candidates, []);
  if (firstRoute.kind === "executor-shadow") firstRoute.afterLocalApply?.();
  assertEquals(candidates, [{ claimKey: key, sourceAction: action }]);
  assertEquals(diagnostics, []);
  assertEquals(
    getLoggerCountsBreakdown()["execution.executor"]?.[
      "execution-server-shadow-action-run"
    ]?.debug ?? 0,
    shadowBaseline + 1,
  );

  const stillUnclaimed = commit();
  const stillUnclaimedRoute = await router({
    space: SPACE,
    commit: stillUnclaimed,
    sourceAction: action,
  });
  assertEquals(stillUnclaimedRoute.disposition, "local");
  if (stillUnclaimedRoute.disposition !== "local") {
    throw new Error("expected local");
  }
  assertEquals(stillUnclaimedRoute.kind, "executor-shadow");
  assertEquals(candidates.length, 1);
  if (stillUnclaimedRoute.kind === "executor-shadow") {
    stillUnclaimedRoute.afterLocalApply?.();
  }
  assertEquals(candidates, [
    { claimKey: key, sourceAction: action },
    { claimKey: key, sourceAction: action },
  ]);

  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 5,
    claimGeneration: 7,
    expiresAt: 100_000,
  };
  claims.set(action, claim);
  const claimed = commit();
  const claimedRoute = await router({
    space: SPACE,
    commit: claimed,
    sourceAction: action,
  });
  assertEquals(claimedRoute.disposition, "upstream");
  if (claimedRoute.disposition !== "upstream") {
    throw new Error("expected claimed upstream route");
  }
  assertEquals(started, []);
  claimedRoute.afterRouteSelected?.();
  assertEquals(started, [{ claim, sourceAction: action }]);
  assertEquals(
    (claimed.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 5,
      claimGeneration: 7,
    },
  );
  assertEquals(
    getLoggerCountsBreakdown()["execution.executor"]?.[
      "execution-server-authoritative-action-run"
    ]?.debug ?? 0,
    authoritativeBaseline + 1,
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

Deno.test("executor action router turns a dynamically invalid live claim into an unserved attempt", async () => {
  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 9,
    claimGeneration: 11,
    expiresAt: 100_000,
  };
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => claim,
    onCandidate: () => {
      throw new Error("a live claim must settle unserved, not re-candidate");
    },
  });
  const scoped = commit();
  scoped.reads.confirmed[0]!.scope = "user";

  assertEquals(
    await router({
      space: SPACE,
      commit: scoped,
      sourceAction: action,
    }),
    {
      disposition: "unserved",
      diagnosticCode: "dynamic-non-space-read-scope",
    },
  );
  assertEquals(
    (scoped.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 9,
      claimGeneration: 11,
    },
  );
});

Deno.test("executor action router settles a statically invalidated live claim as unserved", async () => {
  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 12,
    claimGeneration: 14,
    expiresAt: 100_000,
  };
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => claim,
    onCandidate: () => {
      throw new Error("a live claim must settle unserved, not re-candidate");
    },
  });
  const scoped = commit();
  const staticSummary = (scoped.schedulerObservation as ReturnType<
    typeof observation
  >).completeActionScopeSummary;
  (staticSummary.writes as unknown as Array<Record<string, unknown>>)[0] = {
    ...staticSummary.writes[0],
    scope: "user",
  };

  assertEquals(
    await router({
      space: SPACE,
      commit: scoped,
      sourceAction: action,
    }),
    {
      disposition: "unserved",
      diagnosticCode: "non-space-write-scope",
    },
  );
  assertEquals(
    (scoped.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 12,
      claimGeneration: 14,
    },
  );
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

Deno.test("executor action router candidates only a canonical supported builtin when its broker is available", async () => {
  const effectAction = Object.assign({}, {
    serverBuiltin: {
      version: 1 as const,
      id: "fetchText" as const,
      piece: {
        space: SPACE,
        scope: "space" as const,
        id: "of:action-router-piece",
        path: [],
      },
      reads: [{
        space: SPACE,
        scope: "space" as const,
        id: "of:action-router-input",
        path: [],
      }],
      writes: [{ ...output, path: [] }],
      runtimeWrites: [{ ...output, path: [] }],
      directOutputs: [{ ...output, path: [] }],
    },
  });
  const effectCommit = commit();
  const effectObservation = effectCommit.schedulerObservation as Record<
    string,
    unknown
  >;
  effectObservation.actionKind = "effect";
  effectObservation.implementationFingerprint =
    "impl:cf:builtin/fetchText:server-v1";
  delete effectObservation.completeActionScopeSummary;
  const candidates: Array<{ builtinId?: string; claimKey: ActionClaimKey }> =
    [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    builtinBrokerAvailable: true,
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
  });

  const route = await router({
    space: SPACE,
    commit: effectCommit,
    sourceAction: effectAction,
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  assertEquals(route.kind, "executor-shadow");
  assertEquals(candidates, []);
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]?.builtinId, "fetchText");
  assertEquals(candidates[0]?.claimKey.actionKind, "effect");
});

Deno.test("executor action router never candidates an unsupported effect even with a broker", async () => {
  const effectCommit = commit();
  (effectCommit.schedulerObservation as Record<string, unknown>).actionKind =
    "effect";
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    builtinBrokerAvailable: true,
    claimForAction: () => undefined,
    onCandidate: () => {
      throw new Error("unsupported effects must stay client-primary");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assertEquals(
    await router({
      space: SPACE,
      commit: effectCommit,
      sourceAction: {},
    }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "unsupported-server-builtin",
  ]);
});

Deno.test("executor action router carries an accepted builtin claim across async writebacks", async () => {
  const effectAction = Object.assign({}, {
    serverBuiltin: {
      version: 1 as const,
      id: "fetchText" as const,
      piece: {
        space: SPACE,
        scope: "space" as const,
        id: "of:action-router-piece",
        path: [],
      },
      reads: [{
        space: SPACE,
        scope: "space" as const,
        id: "of:action-router-input",
        path: [],
      }],
      writes: [{ ...output, path: [] }],
      runtimeWrites: [{ ...output, path: [] }],
      directOutputs: [{ ...output, path: [] }],
    },
  });
  const claims = new WeakMap<object, ExecutionClaim>();
  let candidateKey: ActionClaimKey | undefined;
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    builtinBrokerAvailable: true,
    claimForAction: (sourceAction) => claims.get(sourceAction),
    onCandidate: (candidate) => {
      candidateKey = candidate.claimKey;
    },
  });
  const initial = commit();
  const initialObservation = initial.schedulerObservation as Record<
    string,
    unknown
  >;
  initialObservation.actionKind = "effect";
  initialObservation.implementationFingerprint =
    "impl:cf:builtin/fetchText:server-v1";
  delete initialObservation.completeActionScopeSummary;
  const initialRoute = await router({
    space: SPACE,
    commit: initial,
    sourceAction: effectAction,
  });
  if (
    initialRoute.disposition === "local" &&
    initialRoute.kind === "executor-shadow"
  ) {
    initialRoute.afterLocalApply?.();
  }
  const claim: ExecutionClaim = {
    ...candidateKey!,
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  claims.set(effectAction, claim);

  const continuation = commit();
  const schema = { type: "string" } as const;
  const schemaHash = internSchemaAsTaggedHashString(schema);
  continuation.operations = [{
    op: "patch",
    id: output.id,
    scope: "space",
    patches: [{
      op: "add",
      path: "/cfc",
      value: { version: 1 },
    }, {
      op: "replace",
      path: "/value",
      value: 42,
    }],
  }, {
    op: "set",
    id: `cid:${schemaHash}`,
    scope: "space",
    value: { value: schema },
  }];
  continuation.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: continuation,
      sourceAction: effectAction,
    }),
    { disposition: "upstream" },
  );
  assertEquals(
    (continuation.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 3,
      claimGeneration: 4,
    },
  );

  const forgedSchema = commit();
  forgedSchema.operations = [{
    op: "set",
    id: `cid:${schemaHash}-forged`,
    scope: "space",
    value: { value: schema },
  }];
  forgedSchema.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: forgedSchema,
      sourceAction: effectAction,
    }),
    {
      disposition: "unserved",
      diagnosticCode: "dynamic-write-outside-static-surface",
    },
  );
});

Deno.test("ownerless malformed observation reports a diagnostic without an invalid claim key", async () => {
  const malformed = commit();
  delete (malformed.schedulerObservation as Record<string, unknown>).ownerSpace;
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {
      throw new Error("malformed observation must not become a candidate");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  assertEquals(
    await router({ space: SPACE, commit: malformed, sourceAction: action }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(diagnostics, [{ diagnosticCode: "malformed-candidate" }]);
});

Deno.test("changed action identity invalidates its old exact claim", async () => {
  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 15,
    claimGeneration: 17,
    expiresAt: 100_000,
  };
  const invalidated: Array<{
    claim: ExecutionClaim;
    sourceAction: object;
    diagnosticCode: string;
  }> = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => claim,
    onCandidate: () => {
      throw new Error("changed identity must invalidate before recandidating");
    },
    onInvalidated: (
      oldClaim: ExecutionClaim,
      sourceAction: object,
      diagnosticCode: string,
    ) => invalidated.push({ claim: oldClaim, sourceAction, diagnosticCode }),
  });
  const changed = commit();
  (changed.schedulerObservation as Record<string, unknown>).actionId =
    "action:changed";

  assertEquals(
    await router({ space: SPACE, commit: changed, sourceAction: action }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(invalidated, [{
    claim,
    sourceAction: action,
    diagnosticCode: "claim-key-mismatch",
  }]);
});

Deno.test("malformed observation invalidates an already live claim", async () => {
  const claim: ExecutionClaim = {
    ...key,
    leaseGeneration: 18,
    claimGeneration: 20,
    expiresAt: 100_000,
  };
  const invalidated: string[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => claim,
    onCandidate: () => {
      throw new Error("malformed observation must not recandidate");
    },
    onInvalidated: (_oldClaim, _sourceAction, diagnosticCode) =>
      invalidated.push(diagnosticCode),
  });
  const malformed = commit();
  malformed.schedulerObservation = { version: 2 };

  assertEquals(
    await router({ space: SPACE, commit: malformed, sourceAction: action }),
    { disposition: "local", kind: "executor-shadow" },
  );
  assertEquals(invalidated, ["malformed-action-observation"]);
});
