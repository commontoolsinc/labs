import { assertEquals } from "@std/assert";
import { Identity } from "@commonfabric/identity";
import type { MemorySpace, Signer, URI } from "@commonfabric/memory/interface";
import type { ClientCommit } from "@commonfabric/memory/v2";
import type { AppliedCommit } from "@commonfabric/memory/v2/engine";
import type { ReplicaSessionHandle } from "../src/storage/v2-replica-session.ts";
import { type SessionFactory, StorageManager } from "../src/storage/v2.ts";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";

const signer = await Identity.fromPassphrase(
  "executor unserved ordering principal",
);
const SPACE = signer.did() as MemorySpace;
const OUTPUT = "of:executor-unserved-ordering" as URI;

const rejected = (name: string, message: string, fields = {}) =>
  Object.assign(new Error(message), { name, ...fields });

class ScriptedSessionFactory implements SessionFactory {
  readonly commits: ClientCommit[] = [];

  constructor(
    private readonly transact: (
      commit: ClientCommit,
      attempt: number,
    ) => Promise<AppliedCommit>,
  ) {}

  create(
    _space: MemorySpace,
    _signer?: Signer,
  ): Promise<ReplicaSessionHandle> {
    const session = {
      sessionId: "session:unserved-ordering",
      sessionToken: undefined,
      serverSeq: 0,
      transact: async (commit: ClientCommit) => {
        this.commits.push(structuredClone(commit));
        return await this.transact(commit, this.commits.length);
      },
    } as unknown as ReplicaSessionHandle["session"];
    return Promise.resolve({
      client: {
        serverFlags: null,
        close: () => Promise.resolve(),
      },
      session,
    });
  }
}

class ScriptedStorageManager extends StorageManager {
  static connectTo(
    factory: SessionFactory,
    onFirewallRejected: () => void,
  ): ScriptedStorageManager {
    return new ScriptedStorageManager(
      {
        as: signer,
        memoryHost: new URL("memory://executor-unserved-ordering"),
        actionTransactionRouter: () => ({
          disposition: "upstream",
          onFirewallRejected,
        }),
      },
      factory,
    );
  }
}

const applied = (seq: number): AppliedCommit =>
  ({ seq, branch: "", revisions: [] }) as AppliedCommit;

Deno.test("canonical unserved settlement is accepted before claim release", async () => {
  const factory = new ScriptedSessionFactory((_commit, attempt) => {
    if (attempt === 1) {
      return Promise.reject(rejected(
        "ExecutionActionFirewallError",
        "claimed action exceeded its surface",
        { diagnosticCode: "unobserved-read" },
      ));
    }
    return Promise.resolve(applied(attempt));
  });
  let callbackCommitCount = 0;
  const telemetry: RuntimeTelemetryMarker[] = [];
  const storage = ScriptedStorageManager.connectTo(factory, () => {
    callbackCommitCount = factory.commits.length;
  });
  storage.setTelemetry({ submit: (marker) => telemetry.push(marker) });
  try {
    const result = await storage.open(SPACE).replica.commitNative!({
      operations: [{
        op: "set",
        id: OUTPUT,
        type: "application/json",
        value: { value: "must-not-land" },
      }],
      schedulerObservation: {
        actionId: "action:unserved-ordering",
        executionClaimAssertion: {
          contextKey: "space",
          leaseGeneration: 1,
          claimGeneration: 2,
        },
      },
    });

    assertEquals(result.error?.name, "ExecutionActionFirewallError");
    assertEquals(factory.commits.length, 2);
    assertEquals(factory.commits[1]?.operations, []);
    assertEquals(
      (factory.commits[1]?.schedulerObservation as Record<string, unknown>)
        .executionUnservedAttempt,
      { diagnosticCode: "unobserved-read" },
    );
    assertEquals(callbackCommitCount, 2);
    assertEquals(telemetry, [{
      type: "storage.push.start",
      id: `push:${SPACE}:1`,
      operation: "transact",
      localSeq: 1,
      spaceDid: SPACE,
    }, {
      type: "storage.push.error",
      id: `push:${SPACE}:1`,
      error: "ExecutionActionFirewallError",
    }, {
      type: "storage.push.start",
      id: `push:${SPACE}:2`,
      operation: "transact",
      localSeq: 2,
      spaceDid: SPACE,
    }, {
      type: "storage.push.complete",
      id: `push:${SPACE}:2`,
      sessionId: "session:unserved-ordering",
    }]);
  } finally {
    await storage.close();
  }
});

Deno.test("conflicted unserved settlement retains the claim for retry", async () => {
  const factory = new ScriptedSessionFactory((_commit, attempt) => {
    if (attempt === 1) {
      return Promise.reject(rejected(
        "ExecutionActionFirewallError",
        "claimed action exceeded its surface",
        { diagnosticCode: "unobserved-read" },
      ));
    }
    return Promise.reject(rejected(
      "ConflictError",
      "stale confirmed read: of:input at seq 1",
      { retryAfterSeq: 2 },
    ));
  });
  let released = false;
  const telemetry: RuntimeTelemetryMarker[] = [];
  const storage = ScriptedStorageManager.connectTo(factory, () => {
    released = true;
  });
  storage.setTelemetry({ submit: (marker) => telemetry.push(marker) });
  try {
    const result = await storage.open(SPACE).replica.commitNative!({
      operations: [{
        op: "set",
        id: OUTPUT,
        type: "application/json",
        value: { value: "must-not-land" },
      }],
      schedulerObservation: { actionId: "action:unserved-conflict" },
    });

    assertEquals(result.error?.name, "ConflictError");
    assertEquals(factory.commits.length, 2);
    assertEquals(released, false);
    assertEquals(
      telemetry.filter((marker) => marker.type.endsWith(".error")),
      [{
        type: "storage.push.error",
        id: `push:${SPACE}:1`,
        error: "ExecutionActionFirewallError",
      }, {
        type: "storage.push.error",
        id: `push:${SPACE}:2`,
        error: "ConflictError",
      }],
    );
  } finally {
    await storage.close();
  }
});

Deno.test("execution lease fence identity survives runner normalization", async () => {
  const factory = new ScriptedSessionFactory(() =>
    Promise.reject(rejected(
      "ExecutionLeaseFenceError",
      "execution claim incarnation is stale",
    ))
  );
  const storage = ScriptedStorageManager.connectTo(factory, () => {});
  try {
    const result = await storage.open(SPACE).replica.commitNative!({
      operations: [{
        op: "set",
        id: OUTPUT,
        type: "application/json",
        value: { value: "must-not-land" },
      }],
    });

    assertEquals(result.error?.name, "ExecutionLeaseFenceError");
    assertEquals(factory.commits.length, 1);
  } finally {
    await storage.close();
  }
});
