import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type Pattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece result stream retry");

async function runRetryScenario(withoutSessionId = false) {
  const storageManager = StorageManager.emulate({ as: signer });
  let runtime: Runtime | undefined;
  try {
    const activeRuntime = runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });
    const session = await createSession({
      identity: signer,
      spaceName: "piece-result-stream-retry-" + crypto.randomUUID(),
    });
    const pieces = new PiecesController(session, activeRuntime);
    await pieces.synced();

    const pattern: Pattern = {
      argumentSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      resultSchema: {
        type: "object",
        properties: {
          event: { type: "number", asCell: ["stream"] },
        },
        required: ["event"],
      },
      result: {
        event: { $alias: { cell: "argument", path: ["event"] } },
      },
      nodes: [],
    };
    const piece = await pieces.runPersistent(
      activeRuntime.unsafeTrustPattern(pattern, {
        reason: "piece result stream retry test fixture",
      }),
      { event: { $stream: true } },
      undefined,
      { start: true },
    );
    const controller = new PieceController(pieces, piece);
    const stream = pieces.getArgument(piece).key("event");
    const received: unknown[] = [];
    const removeHandler = activeRuntime.scheduler.addEventHandler(
      (_tx, event) => {
        received.push(event);
      },
      stream.getAsNormalizedFullLink(),
    );

    const provider = storageManager.open(pieces.getSpace());
    const originalReconciliation = provider.loadUnexaminedAbsences;
    const replica = provider.replica;
    const originalEnqueue = replica.enqueueEventAppend;
    if (
      originalReconciliation === undefined || originalEnqueue === undefined
    ) {
      throw new Error("test storage does not support event reconciliation");
    }

    let reconciliationCalls = 0;
    const eventIds: string[] = [];
    provider.loadUnexaminedAbsences = () => {
      reconciliationCalls++;
      return reconciliationCalls === 1 ? Promise.resolve(1) : 0;
    };
    replica.enqueueEventAppend = (append) => {
      eventIds.push(append.eventId);
      return Promise.resolve({ delivered: true });
    };
    if (withoutSessionId) {
      const { principal } = activeRuntime.scopeKeyIdentity;
      Object.defineProperty(activeRuntime, "scopeKeyIdentity", {
        configurable: true,
        value: { principal },
      });
    }

    try {
      await controller.result.set(7, ["event"]);
      await activeRuntime.idle();

      return {
        eventIds,
        received,
        reconciliationCalls,
        runtimeId: activeRuntime.id,
        sessionId: activeRuntime.scopeKeyIdentity.sessionId,
      };
    } finally {
      if (withoutSessionId) {
        Reflect.deleteProperty(activeRuntime, "scopeKeyIdentity");
      }
      provider.loadUnexaminedAbsences = originalReconciliation;
      replica.enqueueEventAppend = originalEnqueue;
      removeHandler();
    }
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      await storageManager.close();
    }
  }
}

describe("piece-result-stream-retry", () => {
  it("submits one event identity across transaction attempts", async () => {
    const result = await runRetryScenario();

    expect(result.sessionId).toBeDefined();
    expect(result.reconciliationCalls).toBe(2);
    expect(new Set(result.eventIds).size).toBe(1);
    expect(result.received).toEqual([7]);
  });

  it("uses the runtime identity when the storage session is absent", async () => {
    const result = await runRetryScenario(true);

    expect(result.sessionId).toBeUndefined();
    expect(result.runtimeId).not.toBe("");
    expect(result.reconciliationCalls).toBe(2);
    expect(new Set(result.eventIds).size).toBe(1);
    expect(result.received).toEqual([7]);
  });
});
