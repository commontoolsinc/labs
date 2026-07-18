import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { getLoggerCountsBreakdown } from "@commonfabric/utils/logger";
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
  SCOPE_NAMING_LINK_CONFORMANCE,
  SESSION_SCOPE_NAMING_LINK_CONFORMANCE,
} from "@commonfabric/memory/v2/scope-naming-link";
import { internSchemaAsTaggedHashString } from "@commonfabric/data-model/schema-hash";
import {
  createExecutorActionTransactionRouter,
  type ExecutorCandidateDiagnostic,
} from "../src/executor/action-transaction-router.ts";
import {
  isServerExecutableBuiltinId,
  SERVER_EXECUTABLE_BUILTIN_IDS,
  serverBuiltinImplementationHash,
  type ServerExecutableBuiltinId,
} from "../src/builtins/server-execution.ts";

const SPACE = "did:key:z6Mk-action-router";
const EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  "generateText",
  "generateObject",
] as const satisfies readonly ServerExecutableBuiltinId[];
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

Deno.test("executor action router offers an unclaimed pure action once then routes its exact claim upstream", async () => {
  const counts = getLoggerCountsBreakdown()["execution.executor"] ?? {};
  const shadowBaseline = counts["execution-server-shadow-action-run"]?.debug ??
    0;
  const authoritativeBaseline =
    counts["execution-server-authoritative-action-run"]?.debug ?? 0;
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const started: Array<{ claim: ExecutionClaim; sourceAction: object }> = [];
  const placements: Array<"shadow" | "authoritative"> = [];
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
    onActionTransaction: (placement) => placements.push(placement),
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
  assertEquals(placements, ["shadow"]);
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
  assertEquals(candidates, [{ claimKey: key, sourceAction: action }]);
  assertEquals(placements, ["shadow", "shadow"]);

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
  assertEquals(placements, ["shadow", "shadow", "authoritative"]);
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

Deno.test("server executable builtin registry is exact and excludes ambient capabilities", () => {
  assertEquals(
    SERVER_EXECUTABLE_BUILTIN_IDS,
    EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS,
  );
  assertEquals(
    EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS.map((id) =>
      serverBuiltinImplementationHash(id)
    ),
    EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS.map((id) =>
      `cf:builtin/${id}:server-v1`
    ),
  );
  assertEquals(
    EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS.every(
      isServerExecutableBuiltinId,
    ),
    true,
  );
  assertEquals(
    ["fetch", "generateImage", "llm"].map(isServerExecutableBuiltinId),
    [false, false, false],
  );
});

Deno.test("executor action router candidates every canonical supported builtin when its broker is available", async () => {
  const candidates: Array<{ builtinId?: string; claimKey: ActionClaimKey }> =
    [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    builtinBrokerAvailable: true,
    claimForAction: () => undefined,
    onCandidate: (candidate) => candidates.push(candidate),
  });

  for (const id of EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS) {
    const effectAction = Object.assign({}, {
      serverBuiltin: {
        version: 1 as const,
        id,
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
    effectObservation.implementationFingerprint = `impl:${
      serverBuiltinImplementationHash(id)
    }`;
    delete effectObservation.completeActionScopeSummary;

    const candidateCount = candidates.length;
    const route = await router({
      space: SPACE,
      commit: effectCommit,
      sourceAction: effectAction,
    });
    assertEquals(route.disposition, "local");
    if (route.disposition !== "local") throw new Error("expected local");
    assertEquals(route.kind, "executor-shadow");
    assertEquals(candidates.length, candidateCount);
    if (route.kind === "executor-shadow") route.afterLocalApply?.();
    assertEquals(candidates.length, candidateCount + 1);
  }
  assertEquals(
    candidates.map((candidate) => candidate.builtinId),
    [...EXPECTED_SERVER_EXECUTABLE_BUILTIN_IDS],
  );
  assertEquals(
    candidates.every((candidate) => candidate.claimKey.actionKind === "effect"),
    true,
  );
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
  let permanentFailure:
    | { claim: ExecutionClaim; diagnosticCode: string }
    | undefined;
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    builtinBrokerAvailable: true,
    claimForAction: (sourceAction) => claims.get(sourceAction),
    onCandidate: (candidate) => {
      candidateKey = candidate.claimKey;
    },
    permanentUnservedReasonForAction: (sourceAction, liveClaim) => {
      const failure = sourceAction === effectAction
        ? permanentFailure
        : undefined;
      if (failure === undefined || failure.claim !== liveClaim) {
        return undefined;
      }
      return failure.diagnosticCode;
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

  const materializedId = "of:fid1:claimed-builtin-materialized-child";
  const materialized = commit();
  materialized.reads.confirmed.push(
    {
      id: materializedId,
      scope: "space",
      path: toDocumentPath(["cfc"]),
      seq: 0,
    },
    {
      id: materializedId,
      scope: "space",
      path: toDocumentPath(["value"]),
      seq: 0,
    },
  );
  materialized.operations = [{
    op: "patch",
    id: output.id,
    scope: "space",
    patches: [{
      op: "add",
      path: "/value/messages/0",
      value: {
        "/": { "link@1": { id: materializedId, path: [] } },
      },
    }],
  }, {
    op: "set",
    id: materializedId,
    scope: "space",
    value: { value: { role: "assistant", content: "broker result" } },
  }];
  materialized.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: materialized,
      sourceAction: effectAction,
    }),
    { disposition: "upstream" },
  );

  const unlinkedId = "of:fid1:claimed-builtin-unlinked-child";
  const unlinked = commit();
  unlinked.reads.confirmed.push({
    id: unlinkedId,
    scope: "space",
    path: toDocumentPath([]),
    seq: 0,
  });
  unlinked.operations = [{
    op: "set",
    id: unlinkedId,
    scope: "space",
    value: { value: "must remain outside the claimed surface" },
  }];
  unlinked.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: unlinked,
      sourceAction: effectAction,
    }),
    {
      disposition: "unserved",
      // Dynamic same-space reads are admitted; the unlinked side WRITE is
      // what must stay outside the claimed surface.
      diagnosticCode: "dynamic-write-outside-static-surface",
    },
  );

  permanentFailure = {
    claim,
    diagnosticCode: "server-builtin-egress-blocked-destination",
  };
  const permanentlyUnserved = commit();
  permanentlyUnserved.operations = [...continuation.operations];
  permanentlyUnserved.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: permanentlyUnserved,
      sourceAction: effectAction,
    }),
    {
      disposition: "unserved",
      diagnosticCode: "server-builtin-egress-blocked-destination",
    },
  );
  assertEquals(
    (permanentlyUnserved.schedulerObservation as Record<string, unknown>)
      .executionClaimAssertion,
    {
      contextKey: "space",
      leaseGeneration: 3,
      claimGeneration: 4,
    },
  );

  permanentFailure = {
    claim: { ...claim, claimGeneration: claim.claimGeneration + 1 },
    diagnosticCode: "stale-permanent-failure",
  };
  const staleFailure = commit();
  staleFailure.operations = [...continuation.operations];
  staleFailure.schedulerObservation = undefined;
  assertEquals(
    await router({
      space: SPACE,
      commit: staleFailure,
      sourceAction: effectAction,
    }),
    { disposition: "upstream" },
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

Deno.test("executor action router reports a repeated unservable verdict once", async () => {
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    claimForAction: () => undefined,
    onCandidate: () => {
      throw new Error("an unservable action must not become a candidate");
    },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  // A statically unservable verdict cannot change while the implementation
  // and runtime fingerprints are unchanged; reruns must not re-report it.
  const untrusted = () => {
    const rerun = commit();
    const stamped = rerun.schedulerObservation as {
      implementationFingerprint: string;
      completeActionScopeSummary: { implementationFingerprint: string };
    };
    stamped.implementationFingerprint = "action:router-untrusted";
    stamped.completeActionScopeSummary.implementationFingerprint =
      "action:router-untrusted";
    return rerun;
  };
  for (let rerun = 0; rerun < 3; rerun++) {
    assertEquals(
      await router({ space: SPACE, commit: untrusted(), sourceAction: action }),
      { disposition: "local", kind: "executor-shadow" },
    );
  }
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "untrusted-implementation",
  ]);

  // A fingerprint change is a new implementation: exactly one more report.
  const restamped = () => {
    const rerun = commit();
    const stamped = rerun.schedulerObservation as {
      implementationFingerprint: string;
      completeActionScopeSummary: { implementationFingerprint: string };
    };
    stamped.implementationFingerprint = "action:router-untrusted-v2";
    stamped.completeActionScopeSummary.implementationFingerprint =
      "action:router-untrusted-v2";
    return rerun;
  };
  await router({ space: SPACE, commit: restamped(), sourceAction: action });
  await router({ space: SPACE, commit: restamped(), sourceAction: action });
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "untrusted-implementation",
    "untrusted-implementation",
  ]);

  // A dynamic verdict re-reports only when its diagnostic code changes.
  const scoped = () => {
    const rerun = commit();
    rerun.reads.confirmed[0]!.scope = "user";
    return rerun;
  };
  await router({ space: SPACE, commit: scoped(), sourceAction: action });
  await router({ space: SPACE, commit: scoped(), sourceAction: action });
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "untrusted-implementation",
    "untrusted-implementation",
    "dynamic-non-space-read-scope",
  ]);
  const foreignWrite = () => {
    const rerun = commit();
    (rerun.operations[0] as { scope?: "space" | "user" }).scope = "user";
    return rerun;
  };
  await router({ space: SPACE, commit: foreignWrite(), sourceAction: action });
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "untrusted-implementation",
    "untrusted-implementation",
    "dynamic-non-space-read-scope",
    "dynamic-non-space-write-scope",
  ]);
});

// --- C1.5a: executor candidate context rank -------------------------------

const LANE_PRINCIPAL =
  "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const OTHER_LANE_PRINCIPAL =
  "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z";

const userOutput = {
  space: SPACE,
  scope: "user" as const,
  id: "of:action-router-user-output",
  path: ["value"],
};

/** PerUser derivation: user-scoped read, user-scoped output. */
const perUserObservation = () => {
  const base = observation();
  const userRead = {
    space: SPACE,
    scope: "user" as const,
    id: "of:action-router-user-input",
    path: ["value"],
  };
  return {
    ...base,
    reads: [userRead],
    actualChangedWrites: [userOutput],
    currentKnownWrites: [userOutput],
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary,
      reads: [userRead],
      writes: [userOutput],
      directOutputs: [userOutput],
    },
  };
};

const perUserCommit = (): ClientCommit => ({
  localSeq: 1,
  reads: {
    confirmed: [{
      id: "of:action-router-user-input",
      scope: "user",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [{
    op: "set",
    id: "of:action-router-user-output",
    scope: "user",
    value: { value: 42 },
  }],
  schedulerObservation: perUserObservation(),
});

const userLaneRouter = (
  lanePrincipal: string,
  candidates: { claimKey: ActionClaimKey; sourceAction: object }[],
  diagnostics: ExecutorCandidateDiagnostic[],
  options: { userRankCandidates?: boolean } = {},
) =>
  createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    userRankCandidates: options.userRankCandidates ?? true,
    lanePrincipal,
    claimForAction: () => undefined,
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

Deno.test("executor router keys a PerUser computation candidate at user rank", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const route = await router({
    space: SPACE,
    commit: perUserCommit(),
    sourceAction: action,
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  assertEquals(route.kind, "executor-shadow");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(diagnostics, []);
  assertEquals(candidates.length, 1);
  // The canonical helper percent-encodes the colon-bearing DID; naive
  // `user:${did}` concatenation must never appear as a candidate key.
  assertEquals(
    candidates[0]!.claimKey.contextKey,
    userExecutionContextKey(LANE_PRINCIPAL),
  );
  assertEquals(candidates[0]!.claimKey, {
    ...key,
    contextKey: userExecutionContextKey(LANE_PRINCIPAL),
  });
});

Deno.test("executor router keys two principals' lanes as distinct candidate identities", async () => {
  const aliceCandidates: { claimKey: ActionClaimKey; sourceAction: object }[] =
    [];
  const bobCandidates: { claimKey: ActionClaimKey; sourceAction: object }[] =
    [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const alice = userLaneRouter(LANE_PRINCIPAL, aliceCandidates, diagnostics);
  const bob = userLaneRouter(OTHER_LANE_PRINCIPAL, bobCandidates, diagnostics);

  const aliceAction = {};
  const bobAction = {};
  const aliceRoute = await alice({
    space: SPACE,
    commit: perUserCommit(),
    sourceAction: aliceAction,
  });
  const bobRoute = await bob({
    space: SPACE,
    commit: perUserCommit(),
    sourceAction: bobAction,
  });
  if (
    aliceRoute.disposition !== "local" ||
    aliceRoute.kind !== "executor-shadow" ||
    bobRoute.disposition !== "local" || bobRoute.kind !== "executor-shadow"
  ) {
    throw new Error("expected shadow routes");
  }
  aliceRoute.afterLocalApply?.();
  bobRoute.afterLocalApply?.();
  assertEquals(diagnostics, []);
  assertEquals(
    aliceCandidates[0]!.claimKey.contextKey,
    userExecutionContextKey(LANE_PRINCIPAL),
  );
  assertEquals(
    bobCandidates[0]!.claimKey.contextKey,
    userExecutionContextKey(OTHER_LANE_PRINCIPAL),
  );
  assert(
    aliceCandidates[0]!.claimKey.contextKey !==
      bobCandidates[0]!.claimKey.contextKey,
  );
});

Deno.test("executor router keeps a user-floor effect space-classified (amendment 8)", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const effect = perUserCommit();
  const effectObservation = effect
    .schedulerObservation as unknown as Record<string, unknown>;
  effectObservation.actionKind = "effect";
  const route = await router({
    space: SPACE,
    commit: effect,
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  // Never a user-rank candidate: the effect keeps today's space-only
  // classification and unserves on its user-scoped surface.
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "non-space-read-scope",
  ]);
});

Deno.test("executor router keeps session-scoped surfaces unservable in a user lane", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const scoped = perUserCommit();
  const scopedObservation = scoped.schedulerObservation as ReturnType<
    typeof perUserObservation
  >;
  (scopedObservation.completeActionScopeSummary.reads as Array<
    Record<string, unknown>
  >)[0] = {
    ...scopedObservation.completeActionScopeSummary.reads[0],
    scope: "session",
  };
  const route = await router({
    space: SPACE,
    commit: scoped,
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "non-space-read-scope",
  ]);
});

Deno.test("executor router keeps space actions byte-identical with the user lane on", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const spaceAction = {};
  const route = await router({
    space: SPACE,
    commit: commit(),
    sourceAction: spaceAction,
  });
  if (route.disposition !== "local" || route.kind !== "executor-shadow") {
    throw new Error("expected shadow route");
  }
  route.afterLocalApply?.();
  assertEquals(diagnostics, []);
  // Exactly today's space candidate: contextKey "space", nothing else added.
  assertEquals(candidates, [{ claimKey: key, sourceAction: spaceAction }]);
});

Deno.test("executor router produces zero user-rank candidates with the option off", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics, {
    userRankCandidates: false,
  });

  const route = await router({
    space: SPACE,
    commit: perUserCommit(),
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  // Option off: the PerUser surface classifies exactly as today — an
  // unservable static verdict, never a candidate of any rank.
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "non-space-read-scope",
  ]);
});

// --- C1.9: the §4 output-widening pair at the router seam ------------------

/** The real transformed-PerUser shape: the certificate declares the output
 * ONCE at the broad space address (the transformer cannot know the acting
 * principal), while the run writes the §4 pair — the broad scope-naming
 * redirect link plus the value at the acting principal's user instance. */
const wideningPairObservation = () => {
  const base = observation();
  const userTwin = { ...output, scope: "user" as const };
  const userRead = {
    space: SPACE,
    scope: "user" as const,
    id: "of:action-router-user-input",
    path: ["value"],
  };
  return {
    ...base,
    reads: [userRead],
    actualChangedWrites: [output, userTwin],
    currentKnownWrites: [output, userTwin],
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary,
      // The PerUser input is certificate-declared (that is what promotes the
      // computation to user rank); the output stays declared ONCE, broad.
      reads: [userRead],
    },
  };
};

const wideningPairCommit = (
  broadDocument: unknown = {
    value: { value: SCOPE_NAMING_LINK_CONFORMANCE.link },
  },
): ClientCommit => ({
  localSeq: 1,
  reads: {
    confirmed: [{
      id: "of:action-router-user-input",
      scope: "user",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [
    {
      op: "set",
      id: "of:action-router-output",
      scope: "space",
      value: broadDocument as Record<string, never>,
    },
    {
      op: "set",
      id: "of:action-router-output",
      scope: "user",
      value: { value: 42 },
    },
  ],
  schedulerObservation: wideningPairObservation(),
});

Deno.test("executor router candidates the §4 widening pair at user rank with an unwidened shadow certificate", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const pairAction = {};
  const shadow = wideningPairCommit();
  const route = await router({
    space: SPACE,
    commit: shadow,
    sourceAction: pairAction,
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(diagnostics, []);
  assertEquals(candidates, [{
    claimKey: {
      ...key,
      contextKey: userExecutionContextKey(LANE_PRINCIPAL),
    },
    sourceAction: pairAction,
  }]);
  // Unclaimed shadow routes keep the trusted certificate byte-identical:
  // envelope widening is claimed-commit presentation only.
  const shadowSummary = (shadow.schedulerObservation as ReturnType<
    typeof wideningPairObservation
  >).completeActionScopeSummary;
  assertEquals(shadowSummary.writes, [output]);
});

Deno.test("executor router presents the claimed §4 pair with the lane-widened certificate (A7 engine lockstep)", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const pairAction = {};
  const claim: ExecutionClaim = {
    ...key,
    contextKey: userExecutionContextKey(LANE_PRINCIPAL),
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    userRankCandidates: true,
    lanePrincipal: LANE_PRINCIPAL,
    claimForAction: () => claim,
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

  const claimed = wideningPairCommit();
  const route = await router({
    space: SPACE,
    commit: claimed,
    sourceAction: pairAction,
  });
  assertEquals(diagnostics, []);
  assertEquals(candidates, []);
  assertEquals(route.disposition, "upstream");
  const routed = claimed.schedulerObservation as
    & ReturnType<
      typeof wideningPairObservation
    >
    & { executionClaimAssertion?: Record<string, unknown> };
  // The claimed commit asserts exactly the lane claim…
  assertEquals(routed.executionClaimAssertion, {
    contextKey: claim.contextKey,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  });
  // …and presents the certificate with the acting lane's instance of the
  // broad direct output added to the write envelopes — the §4 pair shape the
  // engine's scope-sensitive coverage admits. Direct outputs stay untouched.
  assertEquals(routed.completeActionScopeSummary.writes, [
    output,
    { ...output, scope: "user" },
  ]);
  assertEquals(routed.completeActionScopeSummary.directOutputs, [output]);
});

Deno.test("executor router rejects a broad value write in the pair with the engine's code", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = userLaneRouter(LANE_PRINCIPAL, candidates, diagnostics);

  const route = await router({
    space: SPACE,
    // Output-scoping failed: the broad leg carries a plain value.
    commit: wideningPairCommit({ value: 42 }),
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "broad-lane-value-write",
  ]);
});

// --- C2.5: session-rank candidate identity + the CA9 rank filter -----------
//
// The session identity source is the host's lane-grant machinery: candidate
// keys come ONLY from open session lanes (delivered on the wire by the host,
// canonical `session:<did>:<sid>`), and a claimed commit's identity comes
// from its claim's contextKey. The router must never fabricate a session key
// from a DID (review CA9) — the pre-lane fallback for session rank is
// no-candidate (stay-space), and an action of classified rank R candidates
// only at open lanes of rank R.

const SESSION_LANE = sessionExecutionContextKey(
  LANE_PRINCIPAL,
  "session:router-alpha",
);
const OTHER_SESSION_LANE = sessionExecutionContextKey(
  LANE_PRINCIPAL,
  "session:router-beta",
);

const sessionOutput = {
  space: SPACE,
  scope: "session" as const,
  id: "of:action-router-session-output",
  path: ["value"],
};

/** PerSession derivation: session-scoped read, session-scoped output. */
const perSessionObservation = () => {
  const base = observation();
  const sessionRead = {
    space: SPACE,
    scope: "session" as const,
    id: "of:action-router-session-input",
    path: ["value"],
  };
  return {
    ...base,
    reads: [sessionRead],
    actualChangedWrites: [sessionOutput],
    currentKnownWrites: [sessionOutput],
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary,
      reads: [sessionRead],
      writes: [sessionOutput],
      directOutputs: [sessionOutput],
    },
  };
};

const perSessionCommit = (): ClientCommit => ({
  localSeq: 1,
  reads: {
    confirmed: [{
      id: "of:action-router-session-input",
      scope: "session",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [{
    op: "set",
    id: "of:action-router-session-output",
    scope: "session",
    value: { value: 42 },
  }],
  schedulerObservation: perSessionObservation(),
});

const sessionLaneRouter = (
  candidates: { claimKey: ActionClaimKey; sourceAction: object }[],
  diagnostics: ExecutorCandidateDiagnostic[],
  options: {
    sessionRankCandidates?: boolean;
    openLaneKeys?: readonly string[];
    claimForAction?: (
      sourceAction: object,
      lane: ActionClaimKey["contextKey"],
    ) => ExecutionClaim | undefined;
  } = {},
) =>
  createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    userRankCandidates: true,
    sessionRankCandidates: options.sessionRankCandidates ?? true,
    lanePrincipal: LANE_PRINCIPAL,
    ...(options.openLaneKeys !== undefined
      ? { openUserLaneKeys: () => options.openLaneKeys }
      : {}),
    claimForAction: options.claimForAction ?? (() => undefined),
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });

Deno.test("executor router keys a PerSession candidate at session rank for each open session lane", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [SESSION_LANE, OTHER_SESSION_LANE],
  });

  const sessionAction = {};
  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: sessionAction,
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(diagnostics, []);
  // One candidate per open SESSION lane, keyed by the canonical session
  // context key the host's grant machinery delivered — never a key built
  // from the Worker's own DID.
  assertEquals(candidates.map((entry) => entry.claimKey.contextKey), [
    SESSION_LANE,
    OTHER_SESSION_LANE,
  ]);
  assertEquals(candidates[0]!.claimKey, { ...key, contextKey: SESSION_LANE });
});

Deno.test("CA9: a session-rank action off the lane wire produces zero candidates (no DID fabrication)", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // No openUserLaneKeys callback at all: the pre-lane wire. A user-rank
  // action falls back to the sponsor's lane here; a session-rank action has
  // no representable identity (a bare DID cannot name a session) and must
  // stay space — no candidate, no fabricated key.
  const router = sessionLaneRouter(candidates, diagnostics, {});

  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates, []);
  assertEquals(diagnostics, []);
});

Deno.test("CA9: a session-rank action candidates only at session lanes (rank filter)", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // The demand slice names a USER lane and a session lane. The session-rank
  // action pairs only with the session lane.
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [userExecutionContextKey(LANE_PRINCIPAL), SESSION_LANE],
  });

  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: {},
  });
  if (route.disposition !== "local" || route.kind !== "executor-shadow") {
    throw new Error("expected shadow route");
  }
  route.afterLocalApply?.();
  assertEquals(candidates.map((entry) => entry.claimKey.contextKey), [
    SESSION_LANE,
  ]);
});

Deno.test("CA9: a user-rank action never candidates at a session lane (rank filter)", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // Mixed-rank demand (the C2.7 world): a piece demanded by both a user lane
  // and a session lane. The user-rank action pairs only with the user lane —
  // a session-lane claim for it would ping-pong against chain-compatible
  // issuance (CA9's thrash finding).
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [SESSION_LANE, userExecutionContextKey(LANE_PRINCIPAL)],
  });

  const route = await router({
    space: SPACE,
    commit: perUserCommit(),
    sourceAction: {},
  });
  if (route.disposition !== "local" || route.kind !== "executor-shadow") {
    throw new Error("expected shadow route");
  }
  route.afterLocalApply?.();
  assertEquals(candidates.map((entry) => entry.claimKey.contextKey), [
    userExecutionContextKey(LANE_PRINCIPAL),
  ]);
});

Deno.test("CA9: non-canonical session lane keys never key a candidate", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // A raw concatenation (colon-bearing DID never percent-encoded) is not a
  // canonical session key; the host could never have granted it. Drop it.
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [
      `session:${LANE_PRINCIPAL}:session:router-alpha`,
      "session::",
      SESSION_LANE,
    ],
  });

  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: {},
  });
  if (route.disposition !== "local" || route.kind !== "executor-shadow") {
    throw new Error("expected shadow route");
  }
  route.afterLocalApply?.();
  assertEquals(candidates.map((entry) => entry.claimKey.contextKey), [
    SESSION_LANE,
  ]);
});

Deno.test("executor router keeps session-scoped surfaces unservable with the session option off", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  // Regression leg: user-rank candidacy alone never admits session scope —
  // byte-identical to the pre-C2.5 classification.
  const router = sessionLaneRouter(candidates, diagnostics, {
    sessionRankCandidates: false,
    openLaneKeys: [SESSION_LANE],
  });

  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "non-space-read-scope",
  ]);
});

// The real transformed-PerSession §4 shape: the certificate declares the
// output ONCE at the broad space address, while the run writes the pair —
// the broad scope-naming redirect link plus the value at the acting
// SESSION's instance.
const sessionWideningPairObservation = () => {
  const base = observation();
  const sessionTwin = { ...output, scope: "session" as const };
  const sessionRead = {
    space: SPACE,
    scope: "session" as const,
    id: "of:action-router-session-input",
    path: ["value"],
  };
  return {
    ...base,
    reads: [sessionRead],
    actualChangedWrites: [output, sessionTwin],
    currentKnownWrites: [output, sessionTwin],
    completeActionScopeSummary: {
      ...base.completeActionScopeSummary,
      reads: [sessionRead],
    },
  };
};

const sessionWideningPairCommit = (
  broadDocument: unknown = {
    value: { value: SESSION_SCOPE_NAMING_LINK_CONFORMANCE.link },
  },
): ClientCommit => ({
  localSeq: 1,
  reads: {
    confirmed: [{
      id: "of:action-router-session-input",
      scope: "session",
      path: toDocumentPath(["value"]),
      seq: 2,
    }],
    pending: [],
  },
  operations: [
    {
      op: "set",
      id: "of:action-router-output",
      scope: "space",
      value: broadDocument as Record<string, never>,
    },
    {
      op: "set",
      id: "of:action-router-output",
      scope: "session",
      value: { value: 42 },
    },
  ],
  schedulerObservation: sessionWideningPairObservation(),
});

Deno.test("executor router presents the claimed session §4 pair with the session-widened certificate", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const pairAction = {};
  const claim: ExecutionClaim = {
    ...key,
    contextKey: SESSION_LANE,
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [SESSION_LANE],
    claimForAction: (_action, lane) => lane === SESSION_LANE ? claim : undefined,
  });

  const claimed = sessionWideningPairCommit();
  const route = await router({
    space: SPACE,
    commit: claimed,
    sourceAction: pairAction,
    lane: SESSION_LANE,
  });
  assertEquals(diagnostics, []);
  assertEquals(candidates, []);
  assertEquals(route.disposition, "upstream");
  const routed = claimed.schedulerObservation as
    & ReturnType<typeof sessionWideningPairObservation>
    & { executionClaimAssertion?: Record<string, unknown> };
  // The claimed commit asserts exactly the session lane's claim (the CA9
  // identity chain: grant -> issuance -> claim contextKey -> commit)…
  assertEquals(routed.executionClaimAssertion, {
    contextKey: SESSION_LANE,
    leaseGeneration: claim.leaseGeneration,
    claimGeneration: claim.claimGeneration,
  });
  // …and presents the certificate with the acting SESSION instance of the
  // broad direct output added to the write envelopes.
  assertEquals(routed.completeActionScopeSummary.writes, [
    output,
    { ...output, scope: "session" },
  ]);
  assertEquals(routed.completeActionScopeSummary.directOutputs, [output]);
});

Deno.test("executor router rejects a broad value write at session rank with the engine's code", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const router = sessionLaneRouter(candidates, diagnostics, {
    openLaneKeys: [SESSION_LANE],
  });

  const route = await router({
    space: SPACE,
    // Output-scoping failed: the broad leg carries a plain value. The §4
    // backstop applies to session-acting commits exactly as to user ones.
    commit: sessionWideningPairCommit({ value: 42 }),
    sourceAction: {},
  });
  assertEquals(route.disposition, "local");
  if (route.disposition !== "local") throw new Error("expected local");
  if (route.kind === "executor-shadow") route.afterLocalApply?.();
  assertEquals(candidates, []);
  assertEquals(diagnostics.map((entry) => entry.diagnosticCode), [
    "broad-lane-value-write",
  ]);
});

Deno.test("CA9: a claim on a non-canonical session lane invalidates as a key mismatch", async () => {
  const candidates: { claimKey: ActionClaimKey; sourceAction: object }[] = [];
  const diagnostics: ExecutorCandidateDiagnostic[] = [];
  const invalidated: { claim: ExecutionClaim; diagnosticCode: string }[] = [];
  // A raw-concatenated lane key can only exist through a host bug or a
  // fabricated identity; the router refuses to adopt it as the commit's
  // identity (it is not the canonical claim-key source), so the claim fails
  // the key match and is invalidated — observable, never silently served.
  const rawLane = `session:${LANE_PRINCIPAL}:session:router-alpha`;
  const claim: ExecutionClaim = {
    ...key,
    contextKey: rawLane as ExecutionClaim["contextKey"],
    leaseGeneration: 3,
    claimGeneration: 4,
    expiresAt: 100_000,
  };
  const router = createExecutorActionTransactionRouter({
    servedSpace: SPACE,
    branch: "",
    userRankCandidates: true,
    sessionRankCandidates: true,
    lanePrincipal: LANE_PRINCIPAL,
    claimForAction: (_action, lane) => lane === rawLane ? claim : undefined,
    onCandidate: (candidate, sourceAction) =>
      candidates.push({ claimKey: candidate.claimKey, sourceAction }),
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    onInvalidated: (invalidClaim, _sourceAction, diagnosticCode) =>
      invalidated.push({ claim: invalidClaim, diagnosticCode }),
  });

  const route = await router({
    space: SPACE,
    commit: perSessionCommit(),
    sourceAction: {},
    lane: rawLane,
  });
  assertEquals(route.disposition, "local");
  assertEquals(candidates, []);
  assertEquals(invalidated.map((entry) => entry.diagnosticCode), [
    "claim-key-mismatch",
  ]);
});
