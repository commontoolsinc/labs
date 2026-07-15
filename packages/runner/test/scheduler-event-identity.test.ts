import {
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  space,
} from "./scheduler-test-utils.ts";
import { mintEventId } from "../src/scheduler/event-identity.ts";
import {
  addSchedulerEventHandler,
  dropQueuedEvent,
  queueSchedulerEvent,
} from "../src/scheduler/events.ts";
import type { NormalizedFullLink } from "../src/link-utils.ts";
import type { Runtime } from "../src/runtime.ts";
import type {
  EventHandlerRegistration,
  QueuedEvent,
} from "../src/scheduler/types.ts";
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
      eventHandlers: [{
        ref: eventLink,
        handler,
        generation: 1,
        active: true,
        readinessCancels: new Set(),
      }],
      eventQueue,
      backgroundTasks: new Set(),
      nextEventSequence: () => 1,
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
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

  it("reserves FIFO position while an earlier event loads its handler", async () => {
    const loadingLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:loading-stream",
      space,
    };
    const readyLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:ready-stream",
      space,
    };
    const env = createSchedulerTestRuntime(import.meta.url);
    const handled: string[] = [];
    let finishPieceLoad!: (started: boolean) => void;
    const pieceLoad = new Promise<boolean>((resolve) => {
      finishPieceLoad = resolve;
    });
    try {
      // Inject only the asynchronous piece-start seam; queueing, head parking,
      // dispatch, commits, and continuation all run through the real Scheduler.
      const schedulerInternals = env.runtime.scheduler as unknown as {
        eventQueueState: {
          loadPieceForEvent?: () => Promise<boolean>;
        };
      };
      schedulerInternals.eventQueueState.loadPieceForEvent = () => pieceLoad;

      env.runtime.scheduler.queueEvent(loadingLink, "first");
      env.runtime.scheduler.addEventHandler((_tx, value) => {
        handled.push(String(value));
      }, readyLink);
      env.runtime.scheduler.queueEvent(readyLink, "second");

      // Cross the scheduler's queued task. The ready second handler must not
      // overtake the still-loading FIFO head.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(handled).toEqual([]);

      env.runtime.scheduler.addEventHandler((_tx, value) => {
        handled.push(String(value));
      }, loadingLink);
      finishPieceLoad(true);
      await env.runtime.idle();

      expect(handled).toEqual(["first", "second"]);
    } finally {
      finishPieceLoad(true);
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("hydrates a load-pending event as soon as its exact handler registers", async () => {
    const loadingLink: NormalizedFullLink = {
      ...eventLink,
      id: "of:register-during-load-stream",
      space,
    };
    const env = createSchedulerTestRuntime(import.meta.url);
    const pieceLoad = Promise.withResolvers<boolean>();
    const handled = Promise.withResolvers<string>();
    try {
      const schedulerInternals = env.runtime.scheduler as unknown as {
        eventQueueState: {
          loadPieceForEvent?: () => Promise<boolean>;
        };
      };
      schedulerInternals.eventQueueState.loadPieceForEvent = () =>
        pieceLoad.promise;

      env.runtime.scheduler.queueEvent(loadingLink, "payload");
      env.runtime.scheduler.addEventHandler((_tx, value) => {
        handled.resolve(String(value));
      }, loadingLink);

      const outcome = await Promise.race([
        handled.promise,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("piece-load-deadlock"), 250)
        ),
      ]);
      expect(outcome).toBe("payload");
    } finally {
      pieceLoad.resolve(true);
      await disposeSchedulerTestRuntime(env);
    }
  });

  it("keeps a started piece's event parked until its nested handler registers", async () => {
    const eventQueue: QueuedEvent[] = [];
    const eventHandlers: EventHandlerRegistration[] = [];
    const backgroundTasks = new Set<Promise<unknown>>();
    let executionWakes = 0;
    const state = {
      runtime: {} as Runtime,
      eventHandlers,
      eventQueue,
      backgroundTasks,
      nextEventSequence: () => 1,
      loadPieceForEvent: () => Promise.resolve(true),
      queueExecution: () => executionWakes++,
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    };

    queueSchedulerEvent(state, {
      eventLink,
      event: "payload",
      retries: true,
      doNotLoadPieceIfNotRunning: false,
    });
    await Promise.all([...backgroundTasks]);

    expect(eventQueue.length).toBe(1);
    expect(eventQueue[0].handlerLoadPending).toBe(true);

    executionWakes = 0;
    const handler = () => {};
    addSchedulerEventHandler({
      eventHandlers,
      nextEventHandlerGeneration: () => 1,
      eventQueue,
      queueExecution: () => executionWakes++,
    }, { handler, ref: eventLink });

    expect(eventQueue[0].handlerLoadPending).toBeUndefined();
    expect(eventQueue[0].handler).toBe(handler);
    expect(executionWakes).toBe(1);
  });

  it("settles a piece-start failure exactly once", async () => {
    const eventQueue: QueuedEvent[] = [];
    const backgroundTasks = new Set<Promise<unknown>>();
    let callbackCount = 0;
    let callbackStatus: string | undefined;
    const droppedTx = {
      abort: () => {},
      status: () => ({ status: "error" }),
    } as unknown as IExtendedStorageTransaction;

    queueSchedulerEvent({
      runtime: { edit: () => droppedTx } as unknown as Runtime,
      eventHandlers: [],
      eventQueue,
      backgroundTasks,
      nextEventSequence: () => 1,
      loadPieceForEvent: () => Promise.reject(new Error("start failed")),
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    }, {
      eventLink,
      event: "payload",
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      onCommit: (commitTx) => {
        callbackCount++;
        callbackStatus = commitTx.status().status;
      },
    });

    await Promise.all([...backgroundTasks]);
    expect(eventQueue).toEqual([]);
    expect(callbackCount).toBe(1);
    expect(callbackStatus).toBe("error");
  });

  it("does not resurrect an event dropped while its handler is loading", async () => {
    const eventQueue: QueuedEvent[] = [];
    const backgroundTasks = new Set<Promise<unknown>>();
    const pieceLoad = Promise.withResolvers<boolean>();
    let callbackCount = 0;
    const droppedTx = {
      abort: () => {},
      status: () => ({ status: "error" }),
    } as unknown as IExtendedStorageTransaction;
    const state = {
      runtime: { edit: () => droppedTx } as unknown as Runtime,
      eventHandlers: [],
      eventQueue,
      backgroundTasks,
      nextEventSequence: () => 1,
      loadPieceForEvent: () => pieceLoad.promise,
      queueExecution: () => {},
      recordLineageEvent: () => {},
      releaseLineageEvent: () => {},
    };

    queueSchedulerEvent(state, {
      eventLink,
      event: "payload",
      retries: true,
      doNotLoadPieceIfNotRunning: false,
      onCommit: () => callbackCount++,
    });
    const queued = eventQueue[0];
    expect(queued.handlerLoadPending).toBe(true);

    dropQueuedEvent(state, queued, "lineage failed while loading");
    dropQueuedEvent(state, queued, "duplicate terminal notification");
    pieceLoad.resolve(true);
    await Promise.all([...backgroundTasks]);

    expect(eventQueue).toEqual([]);
    expect(callbackCount).toBe(1);
    expect(queued.handlerLoadPending).toBe(true);
  });
});
