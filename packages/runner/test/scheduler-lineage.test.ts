import type { NormalizedFullLink } from "../src/link-utils.ts";
import { SpeculationLineage } from "../src/scheduler/lineage.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import type {
  CommitError,
  IExtendedStorageTransaction,
  MemorySpace,
  Result,
  Unit,
} from "../src/storage/interface.ts";
import { describe, expect, it } from "./scheduler-test-utils.ts";

type CommitCallback = Parameters<
  IExtendedStorageTransaction["addCommitCallback"]
>[0];

type TestOriginTx = IExtendedStorageTransaction & {
  settle(result: Result<Unit, CommitError>): void;
};

const eventLink: NormalizedFullLink = {
  id: "of:event-stream",
  space: "did:key:z6MkLineage" as MemorySpace,
  scope: "space",
  path: [],
};

const okResult: Result<Unit, CommitError> = { ok: {} };
const errorResult: Result<Unit, CommitError> = {
  error: {
    name: "StorageTransactionAborted",
    message: "failed",
    reason: new Error("failed"),
  },
};

function createOriginTx(): TestOriginTx {
  const callbacks: CommitCallback[] = [];
  const origin = {
    tx: {},
    addCommitCallback(callback: CommitCallback): void {
      callbacks.push(callback);
    },
    settle(result: Result<Unit, CommitError>): void {
      for (const callback of callbacks) {
        callback(origin as TestOriginTx, result);
      }
    },
  };

  return origin as TestOriginTx;
}

function queuedEvent(
  id: string,
  originTx?: IExtendedStorageTransaction,
): QueuedEvent {
  return {
    id,
    originTx,
    eventLink,
    action: () => {},
    handler: () => {},
    event: { id },
    retriesLeft: 0,
  };
}

function createLineageHooks() {
  const removed: QueuedEvent[] = [];
  const errors: unknown[] = [];
  let queueExecutions = 0;
  const lineage = new SpeculationLineage({
    removeQueuedEvent: (event) => removed.push(event),
    queueExecution: () => queueExecutions++,
    onError: (error) => errors.push(error),
  });

  return {
    lineage,
    removed,
    errors,
    queueExecutions: () => queueExecutions,
  };
}

describe("SpeculationLineage", () => {
  it("cancels recorded events and runs piece stops when the origin fails", () => {
    const origin = createOriginTx();
    const event = queuedEvent("evt:failed", origin);
    const { lineage, removed, errors, queueExecutions } = createLineageHooks();
    let stops = 0;

    lineage.recordEvent(origin, event);
    lineage.recordPieceStop(origin, () => stops++);
    origin.settle(errorResult);

    expect(removed).toEqual([event]);
    expect(stops).toBe(1);
    expect(queueExecutions()).toBe(1);
    expect(errors).toEqual([]);
    expect(lineage.originStatus(origin)).toBe("confirmed");
  });

  it("keeps recorded events and drops piece stops when the origin confirms", () => {
    const origin = createOriginTx();
    const event = queuedEvent("evt:confirmed", origin);
    const { lineage, removed, errors, queueExecutions } = createLineageHooks();
    let stops = 0;

    lineage.recordEvent(origin, event);
    lineage.recordPieceStop(origin, () => stops++);
    origin.settle(okResult);

    expect(removed).toEqual([]);
    expect(stops).toBe(0);
    expect(queueExecutions()).toBe(1);
    expect(errors).toEqual([]);
    expect(lineage.originStatus(origin)).toBe("confirmed");
  });

  it("keeps confirmed siblings visible after the first event releases", () => {
    const origin = createOriginTx();
    const first = queuedEvent("evt:first", origin);
    const second = queuedEvent("evt:second", origin);
    const { lineage } = createLineageHooks();

    lineage.recordEvent(origin, first);
    lineage.recordEvent(origin, second);
    origin.settle(okResult);
    lineage.release(origin, first);

    expect(lineage.originStatus(origin)).toBe("confirmed");
    lineage.release(origin, second);
    expect(lineage.originStatus(origin)).toBe("confirmed");
  });

  it("deletes the record when the last settled event releases", () => {
    const origin = createOriginTx();
    const event = queuedEvent("evt:last", origin);
    const { lineage, removed, queueExecutions } = createLineageHooks();
    let stops = 0;

    lineage.recordEvent(origin, event);
    lineage.recordPieceStop(origin, () => stops++);
    origin.settle(okResult);
    lineage.release(origin, event);
    origin.settle(errorResult);

    expect(removed).toEqual([]);
    expect(stops).toBe(0);
    expect(queueExecutions()).toBe(1);
    expect(lineage.originStatus(origin)).toBe("confirmed");
  });

  it("treats an unknown origin as confirmed", () => {
    const origin = createOriginTx();
    const { lineage } = createLineageHooks();

    expect(lineage.originStatus(origin)).toBe("confirmed");
  });

  it("ignores duplicate settlement callbacks after failure cleanup", () => {
    const origin = createOriginTx();
    const event = queuedEvent("evt:double-fail", origin);
    const { lineage, removed, queueExecutions } = createLineageHooks();
    let stops = 0;

    lineage.recordEvent(origin, event);
    lineage.recordPieceStop(origin, () => stops++);
    origin.settle(errorResult);
    origin.settle(errorResult);

    expect(removed).toEqual([event]);
    expect(stops).toBe(1);
    expect(queueExecutions()).toBe(1);
  });
});
