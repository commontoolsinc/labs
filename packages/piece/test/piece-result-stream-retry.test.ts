import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { type Pattern, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PieceController } from "../src/ops/piece-controller.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("piece result stream retry");

describe("piece-result-stream-retry", () => {
  it("submits one event identity across transaction attempts", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: true },
    });

    try {
      const session = await createSession({
        identity: signer,
        spaceName: "piece-result-stream-retry-" + crypto.randomUUID(),
      });
      const pieces = new PiecesController(session, runtime);
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
        runtime.unsafeTrustPattern(pattern, {
          reason: "piece result stream retry test fixture",
        }),
        { event: { $stream: true } },
        undefined,
        { start: true },
      );
      const controller = new PieceController(pieces, piece);
      const stream = pieces.getArgument(piece).key("event");
      const received: unknown[] = [];
      const removeHandler = runtime.scheduler.addEventHandler((_tx, event) => {
        received.push(event);
      }, stream.getAsNormalizedFullLink());

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

      try {
        await controller.result.set(7, ["event"]);
        await runtime.idle();

        expect(reconciliationCalls).toBe(2);
        expect(new Set(eventIds).size).toBe(1);
        expect(received).toEqual([7]);
      } finally {
        provider.loadUnexaminedAbsences = originalReconciliation;
        replica.enqueueEventAppend = originalEnqueue;
        removeHandler();
      }
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
