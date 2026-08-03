import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import {
  type ClientCommit,
  type ExecutionClaim,
  type ExecutionLease,
  toDocumentPath,
} from "../v2.ts";
import * as Engine from "../v2/engine.ts";
import type { SchedulerActionObservation } from "../v2/engine.ts";

const SPACE = "did:key:z6Mk-engine-execution-lease-space";
const PRINCIPAL = "did:key:z6Mk-engine-execution-lease-user";

const openTempEngine = async (): Promise<{
  directory: string;
  store: URL;
  engine: Engine.Engine;
}> => {
  const directory = await Deno.makeTempDir();
  const store = toFileUrl(`${directory}/space.sqlite`);
  return { directory, store, engine: await Engine.open({ url: store }) };
};

const acquire = (
  engine: Engine.Engine,
  options: {
    hostId: string;
    nowMs: number;
    ttlMs: number;
  },
): ExecutionLease | null =>
  Engine.acquireExecutionLease(engine, {
    space: SPACE,
    branch: "",
    hostId: options.hostId,
    onBehalfOf: PRINCIPAL,
    nowMs: options.nowMs,
    ttlMs: options.ttlMs,
    authorizeWrite: () => true,
  });

Deno.test("execution lease preserves Date.now-scale expiry across reopen", async () => {
  const { directory, store, engine } = await openTempEngine();
  const nowMs = Date.now();
  const ttlMs = 60_123;
  let currentEngine = engine;
  try {
    const lease = acquire(currentEngine, {
      hostId: "host:precision",
      nowMs,
      ttlMs,
    });
    assertExists(lease);
    assert(lease.expiresAt > 2 ** 31);
    assertEquals(lease.expiresAt, nowMs + ttlMs);

    Engine.close(currentEngine);
    currentEngine = await Engine.open({ url: store });
    assertEquals(
      Engine.currentExecutionLease(currentEngine, {
        space: SPACE,
        branch: "",
        nowMs: nowMs + 1,
      }),
      lease,
    );
  } finally {
    Engine.close(currentEngine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("execution lease acquisition is idempotent for the exact owner", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const first = acquire(engine, {
      hostId: "host:sticky",
      nowMs,
      ttlMs: 10_000,
    });
    assertExists(first);
    assertEquals(
      acquire(engine, {
        hostId: "host:sticky",
        nowMs: nowMs + 1,
        ttlMs: 20_000,
      }),
      first,
    );
    assertEquals(
      acquire(engine, {
        hostId: "host:other",
        nowMs: nowMs + 1,
        ttlMs: 20_000,
      }),
      null,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("execution lease lifecycle is fenced and generation-monotonic", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const first = acquire(engine, {
      hostId: "host:first",
      nowMs,
      ttlMs: 1_000,
    });
    assertExists(first);

    const renewed = Engine.renewExecutionLease(engine, {
      lease: first,
      nowMs: nowMs + 10,
      ttlMs: 2_000,
      authorizeWrite: () => true,
    });
    assertExists(renewed);
    assertEquals(renewed.expiresAt, nowMs + 2_010);

    const stale = { ...renewed, leaseGeneration: 99 };
    assertEquals(
      Engine.renewExecutionLease(engine, {
        lease: stale,
        nowMs: nowMs + 11,
        ttlMs: 2_000,
        authorizeWrite: () => true,
      }),
      null,
    );
    assertEquals(
      Engine.revokeExecutionLease(engine, {
        lease: stale,
        nowMs: nowMs + 11,
      }),
      null,
    );

    const draining = Engine.beginExecutionLeaseDrain(engine, {
      lease: renewed,
      nowMs: nowMs + 20,
      drainTtlMs: 30,
    });
    assertExists(draining);
    assertEquals(draining.state, "draining");
    assertEquals(draining.expiresAt, nowMs + 50);
    assertEquals(
      Engine.renewExecutionLease(engine, {
        lease: draining,
        nowMs: nowMs + 21,
        ttlMs: 2_000,
        authorizeWrite: () => true,
      }),
      null,
    );

    const revoked = Engine.revokeExecutionLease(engine, {
      lease: draining,
      nowMs: nowMs + 25,
    });
    assertExists(revoked);
    assertEquals(revoked.state, "revoked");
    assertEquals(
      Engine.currentExecutionLease(engine, {
        space: SPACE,
        branch: "",
        nowMs: nowMs + 25,
      }),
      null,
    );

    const second = acquire(engine, {
      hostId: "host:second",
      nowMs: nowMs + 26,
      ttlMs: 20,
    });
    assertExists(second);
    assertEquals(second.leaseGeneration, 2);
    assertEquals(
      Engine.expireExecutionLease(engine, {
        lease: second,
        nowMs: nowMs + 45,
      }),
      null,
    );
    const expired = Engine.expireExecutionLease(engine, {
      lease: second,
      nowMs: nowMs + 46,
    });
    assertExists(expired);
    assertEquals(expired.state, "revoked");

    const third = acquire(engine, {
      hostId: "host:third",
      nowMs: nowMs + 47,
      ttlMs: 100,
    });
    assertExists(third);
    assertEquals(third.leaseGeneration, 3);
    assertEquals(
      Engine.revokeExecutionLease(engine, {
        lease: second,
        nowMs: nowMs + 48,
      }),
      null,
    );
    assertEquals(
      Engine.currentExecutionLease(engine, {
        space: SPACE,
        branch: "",
        nowMs: nowMs + 48,
      }),
      third,
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("execution lease acquisition rejects missing and deleted branches", async () => {
  const { directory, engine } = await openTempEngine();
  try {
    assertThrows(
      () =>
        Engine.acquireExecutionLease(engine, {
          space: SPACE,
          branch: "missing",
          hostId: "host:missing",
          onBehalfOf: PRINCIPAL,
          nowMs: 1_800_000_000_000,
          ttlMs: 1_000,
          authorizeWrite: () => true,
        }),
      Error,
      "unknown branch: missing",
    );
    Engine.createBranch(engine, "deleted");
    Engine.deleteBranch(engine, "deleted");
    assertThrows(
      () =>
        Engine.acquireExecutionLease(engine, {
          space: SPACE,
          branch: "deleted",
          hostId: "host:deleted",
          onBehalfOf: PRINCIPAL,
          nowMs: 1_800_000_000_000,
          ttlMs: 1_000,
          authorizeWrite: () => true,
        }),
      Error,
      "branch is not active: deleted",
    );
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("stale lease commits apply nothing while accepted replay survives revoke", async () => {
  const { directory, engine } = await openTempEngine();
  const nowMs = 1_800_000_000_000;
  try {
    const first = acquire(engine, {
      hostId: "host:first",
      nowMs,
      ttlMs: 1_000,
    });
    assertExists(first);
    const claim: ExecutionClaim = {
      branch: "",
      space: SPACE,
      contextKey: "space",
      pieceId: "space:of:lease-fence-piece",
      actionId: "action:lease-fence",
      actionKind: "computation",
      implementationFingerprint: "impl:lease-fence",
      runtimeFingerprint: "runtime:lease-fence",
      leaseGeneration: first.leaseGeneration,
      claimGeneration: 1,
      expiresAt: first.expiresAt,
    };
    const output = {
      space: SPACE,
      scope: "space" as const,
      id: "of:accepted",
      path: ["value"],
    };
    const accepted: ClientCommit = {
      localSeq: 1,
      reads: { confirmed: [], pending: [] },
      operations: [{ op: "set", id: output.id, value: { value: 1 } }],
      schedulerObservation: {
        version: 2,
        ownerSpace: SPACE,
        branch: "",
        pieceId: claim.pieceId,
        processGeneration: 1,
        actionId: claim.actionId,
        actionKind: claim.actionKind,
        implementationFingerprint: claim.implementationFingerprint,
        runtimeFingerprint: claim.runtimeFingerprint,
        executionClaimAssertion: {
          contextKey: claim.contextKey,
          leaseGeneration: claim.leaseGeneration,
          claimGeneration: claim.claimGeneration,
        },
        observedAtSeq: 0,
        transactionKind: "action-run",
        reads: [],
        shallowReads: [],
        actualChangedWrites: [output],
        currentKnownWrites: [output],
        materializerWriteEnvelopes: [],
        completeActionScopeSummary: {
          version: 1,
          complete: true,
          implementationFingerprint: claim.implementationFingerprint,
          runtimeFingerprint: claim.runtimeFingerprint,
          piece: {
            space: SPACE,
            scope: "space",
            id: claim.pieceId.slice("space:".length),
            path: [],
          },
          reads: [],
          writes: [output],
          materializerWriteEnvelopes: [],
          directOutputs: [output],
        },
        status: "success",
      },
    };
    const applied = Engine.applyCommit(engine, {
      sessionId: "executor-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: accepted,
      executionClaims: new Map([[accepted.localSeq, claim]]),
      executionLeaseFence: {
        lease: first,
        nowMs: nowMs + 1,
        authorize: () => true,
      },
    });
    assertEquals(applied.seq, 1);
    Engine.revokeExecutionLease(engine, {
      lease: first,
      nowMs: nowMs + 2,
    });
    const second = acquire(engine, {
      hostId: "host:second",
      nowMs: nowMs + 3,
      ttlMs: 1_000,
    });
    assertExists(second);
    assertEquals(second.leaseGeneration, 2);

    const replay = Engine.applyCommit(engine, {
      sessionId: "executor-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: accepted,
      executionLeaseFence: {
        lease: first,
        nowMs: nowMs + 4,
        authorize: () => false,
      },
    });
    assertEquals(replay.seq, applied.seq);
    assert(Engine.isAppliedCommitReplay(replay));

    const before = Engine.serverSeq(engine);
    assertThrows(
      () =>
        Engine.applyCommit(engine, {
          sessionId: "executor-session",
          space: SPACE,
          principal: PRINCIPAL,
          commit: {
            localSeq: 2,
            reads: { confirmed: [], pending: [] },
            operations: [
              { op: "set", id: "of:partial-a", value: { value: "a" } },
              { op: "set", id: "of:partial-b", value: { value: "b" } },
            ],
          },
          executionLeaseFence: {
            lease: first,
            nowMs: nowMs + 4,
            authorize: () => true,
          },
        }),
      Engine.ExecutionLeaseFenceError,
    );
    assertEquals(Engine.serverSeq(engine), before);
    assertEquals(Engine.read(engine, { id: "of:partial-a" }), null);
    assertEquals(Engine.read(engine, { id: "of:partial-b" }), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});

Deno.test("applyCommit separates executor replay identity from sponsor session scope", async () => {
  const { directory, engine } = await openTempEngine();
  const sponsorSessionId = "session:sponsor";
  const executorSessionId = "session:executor";
  const scoped = (id: string, sessionId: string) =>
    Engine.read(engine, {
      id,
      scope: "session",
      principal: PRINCIPAL,
      sessionId,
    });
  try {
    Engine.applyCommit(engine, {
      sessionId: sponsorSessionId,
      principal: PRINCIPAL,
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "set",
          id: "of:sponsor-scope-input",
          scope: "session",
          value: { value: { lane: "sponsor" } },
        }],
      },
    });

    const outputAddress = {
      space: SPACE,
      id: "of:sponsor-scope-output",
      scope: "session" as const,
      path: ["value", "lane"],
    };
    const schedulerObservation: SchedulerActionObservation = {
      version: 1,
      branch: "",
      pieceId: "of:sponsor-scope-piece",
      processGeneration: 1,
      actionId: "pattern.tsx:computed:sponsor-session",
      actionKind: "computation",
      implementationFingerprint: "impl:sponsor-session",
      runtimeFingerprint: "runtime:test",
      observedAtSeq: 1,
      transactionKind: "action-run",
      reads: [],
      shallowReads: [],
      actualChangedWrites: [outputAddress],
      currentKnownWrites: [outputAddress],
      declaredWrites: [outputAddress],
      materializerWriteEnvelopes: [],
      status: "success",
    };
    const executorCommit: ClientCommit = {
      localSeq: 1,
      reads: {
        confirmed: [{
          id: "of:sponsor-scope-input",
          scope: "session",
          seq: 1,
          path: toDocumentPath(["value"]),
        }],
        pending: [],
      },
      preconditions: [{
        kind: "entity-absent",
        id: "of:sponsor-scope-output",
        scope: "session",
      }],
      operations: [{
        op: "set",
        id: "of:sponsor-scope-output",
        scope: "session",
        value: { value: { lane: "executor" } },
      }],
      schedulerObservation,
    };
    const applied = Engine.applyCommit(engine, {
      sessionId: executorSessionId,
      scopeSessionId: sponsorSessionId,
      principal: PRINCIPAL,
      commit: executorCommit,
    });
    assertEquals(applied.seq, 2);
    assertEquals(
      scoped("of:sponsor-scope-output", sponsorSessionId),
      { value: { lane: "executor" } },
    );
    assertEquals(scoped("of:sponsor-scope-output", executorSessionId), null);
    const [snapshot] = Engine.listSchedulerActionSnapshots(engine, {
      actionId: schedulerObservation.actionId,
    }).snapshots;
    assertEquals(
      snapshot.executionContextKey,
      Engine.resolveScopeKey("session", {
        principal: PRINCIPAL,
        sessionId: sponsorSessionId,
      }),
    );
    assertEquals(
      snapshot.writerSessionId,
      Engine.resolveCommitSessionKey(executorSessionId, PRINCIPAL),
    );

    const replay = Engine.applyCommit(engine, {
      sessionId: executorSessionId,
      scopeSessionId: sponsorSessionId,
      principal: PRINCIPAL,
      commit: executorCommit,
    });
    assert(Engine.isAppliedCommitReplay(replay));
    assertEquals(replay.seq, applied.seq);

    Engine.applyCommit(engine, {
      sessionId: executorSessionId,
      scopeSessionId: sponsorSessionId,
      principal: PRINCIPAL,
      commit: {
        localSeq: 2,
        reads: {
          confirmed: [],
          pending: [{
            id: "of:sponsor-scope-output",
            scope: "session",
            localSeq: 1,
            path: toDocumentPath(["value"]),
          }],
        },
        operations: [{
          op: "set",
          id: "of:sponsor-scope-chained",
          scope: "session",
          value: { value: { lane: "chained" } },
        }],
      },
    });
    assertEquals(
      scoped("of:sponsor-scope-chained", sponsorSessionId),
      { value: { lane: "chained" } },
    );
    assertEquals(scoped("of:sponsor-scope-chained", executorSessionId), null);
  } finally {
    Engine.close(engine);
    await Deno.remove(directory, { recursive: true });
  }
});
