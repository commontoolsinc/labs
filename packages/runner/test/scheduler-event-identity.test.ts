import { describe, expect, it } from "./scheduler-test-utils.ts";
import { mintEventId } from "../src/scheduler/event-identity.ts";
import { queueSchedulerEvent } from "../src/scheduler/events.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { Runtime } from "../src/runtime.ts";
import type { QueuedEvent } from "../src/scheduler/types.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";

const eventLink: NormalizedFullLink = {
  id: "of:event-stream",
  space: "did:key:z6MkEventIdentity" as MemorySpace,
  scope: "space",
  path: [],
};

function eventKey(id: string): string {
  return id.split(":")[1];
}

describe("scheduler event identity", () => {
  it("mints sequential ids from the same origin transaction", () => {
    const originTx = {} as IExtendedStorageTransaction;

    const first = mintEventId(eventLink, originTx);
    const second = mintEventId(eventLink, originTx);

    expect(first).toMatch(/^evt:[^:]+:0:of:event-stream$/);
    expect(second).toMatch(/^evt:[^:]+:1:of:event-stream$/);
    expect(eventKey(first)).toBe(eventKey(second));
  });

  it("mints different keys for different origin transactions", () => {
    const first = mintEventId(eventLink, {} as IExtendedStorageTransaction);
    const second = mintEventId(eventLink, {} as IExtendedStorageTransaction);

    expect(eventKey(first)).not.toBe(eventKey(second));
  });

  it("mints distinct ids without an origin transaction", () => {
    const first = mintEventId(eventLink);
    const second = mintEventId(eventLink);

    expect(first).toMatch(/^evt:[^:]+:of:event-stream$/);
    expect(second).toMatch(/^evt:[^:]+:of:event-stream$/);
    expect(first).not.toBe(second);
  });

  it("threads explicit event ids into queued events", () => {
    const eventQueue: QueuedEvent[] = [];
    const originTx = {} as IExtendedStorageTransaction;
    const handler = () => {};

    queueSchedulerEvent({
      runtime: {} as Runtime,
      eventHandlers: [[eventLink, handler]],
      eventQueue,
      backgroundTasks: new Set(),
      queueExecution: () => {},
      queueEvent: () => {},
      recordLineageEvent: () => {},
    }, {
      eventLink,
      event: { value: 1 },
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      eventId: "evt:provided:0:of:event-stream",
      originTx,
    });

    expect(eventQueue.length).toBe(1);
    expect(eventQueue[0].id).toBe("evt:provided:0:of:event-stream");
    expect(eventQueue[0].originTx).toBe(originTx);
  });
});
