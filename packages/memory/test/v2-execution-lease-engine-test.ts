import { assert, assertEquals, assertExists, assertThrows } from "@std/assert";
import { toFileUrl } from "@std/path";
import type { ClientCommit, ExecutionLease } from "../v2.ts";
import * as Engine from "../v2/engine.ts";

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
        space: SPACE,
        branch: "",
        nowMs: nowMs + 45,
      }),
      null,
    );
    const expired = Engine.expireExecutionLease(engine, {
      space: SPACE,
      branch: "",
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
  const accepted: ClientCommit = {
    localSeq: 1,
    reads: { confirmed: [], pending: [] },
    operations: [{ op: "set", id: "of:accepted", value: { value: 1 } }],
  };
  try {
    const first = acquire(engine, {
      hostId: "host:first",
      nowMs,
      ttlMs: 1_000,
    });
    assertExists(first);
    const applied = Engine.applyCommit(engine, {
      sessionId: "executor-session",
      space: SPACE,
      principal: PRINCIPAL,
      commit: accepted,
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
