import type { Cell } from "../src/cell.ts";
import type {
  IExtendedStorageTransaction,
  StorageConnectionState,
} from "../src/storage/interface.ts";
import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
  space,
} from "./scheduler-test-utils.ts";
import type { SchedulerTestStorageManager } from "./scheduler-test-utils.ts";

describe("linked-document readiness lifecycle", () => {
  let storageManager: SchedulerTestStorageManager;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    ({ storageManager, runtime, tx } = createSchedulerTestRuntime(
      import.meta.url,
    ));
  });

  afterEach(async () => {
    await disposeSchedulerTestRuntime({ storageManager, runtime, tx });
  });

  it("drops a retry-ready selector when no live action is waiting", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-no-waiter-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let attempts = 0;
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      return Promise.reject(new Error(`sync failed ${attempts}`));
    };

    try {
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      await storageManager.crossSpaceSettled();
      expect(attempts).toBe(1);

      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      expect(attempts).toBe(2);
      await storageManager.crossSpaceSettled();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("cancels a scheduled retry when the runtime is disposed", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-cancel-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    storageManager.syncCell = <T>(_cell: Cell<T>): Promise<Cell<T>> =>
      Promise.reject(new Error("sync failed before disposal"));

    try {
      expect(runtime.ensureLinkedDocLoaded(target.getAsNormalizedFullLink()))
        .toBe("pending");
      await Promise.resolve();
      await runtime.dispose();
      await storageManager.crossSpaceSettled();
    } finally {
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("waits through a disconnect and retries after the space is restored", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-reconnect-retry",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionState: StorageConnectionState = {
      status: "ready",
      epoch: 1,
    };
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback(connectionState);
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const firstAttemptStarted = Promise.withResolvers<void>();
    const secondAttemptStarted = Promise.withResolvers<void>();
    let rejectFirstAttempt: ((cause: Error) => void) | undefined;
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      if (attempts === 1) {
        firstAttemptStarted.resolve();
        return new Promise<Cell<T>>((_resolve, reject) => {
          rejectFirstAttempt = reject;
        });
      }
      secondAttemptStarted.resolve();
      if (connectionState.status === "disconnected") {
        return Promise.reject(new Error("storage remains disconnected"));
      }
      return Promise.resolve(cell);
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await firstAttemptStarted.promise;
      if (rejectFirstAttempt === undefined) {
        throw new Error("first linked-document attempt did not install reject");
      }

      connectionState = {
        status: "disconnected",
        epoch: 1,
        cause: new Error("synthetic disconnect"),
      };
      connectionListener?.(connectionState);
      rejectFirstAttempt(connectionState.cause);
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();

      expect(attempts).toBe(1);
      expect(status).toBe("pending");

      connectionState = { status: "ready", epoch: 2 };
      connectionListener?.(connectionState);
      await secondAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(attempts).toBe(2);
      expect(status).toBe("settled");
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("invalidates a terminal linked-document error on the next restored epoch", async () => {
    const target = runtime.getCell(
      space,
      "linked-doc-terminal-reconnect",
    );
    const originalSyncCell = storageManager.syncCell.bind(storageManager);
    let connectionState: StorageConnectionState = {
      status: "ready",
      epoch: 1,
    };
    let connectionListener:
      | ((state: StorageConnectionState) => void)
      | undefined;
    storageManager.subscribeConnectionState = (_space, callback) => {
      connectionListener = callback;
      callback(connectionState);
      return () => {
        if (connectionListener === callback) connectionListener = undefined;
      };
    };

    let attempts = 0;
    const thirdAttemptStarted = Promise.withResolvers<void>();
    const fourthAttemptStarted = Promise.withResolvers<void>();
    let allowSuccess = false;
    storageManager.syncCell = <T>(cell: Cell<T>): Promise<Cell<T>> => {
      attempts++;
      if (attempts === 3) thirdAttemptStarted.resolve();
      if (attempts === 4) fourthAttemptStarted.resolve();
      return allowSuccess
        ? Promise.resolve(cell)
        : Promise.reject(new Error(`sync failed ${attempts}`));
    };

    let status: ReturnType<Runtime["ensureLinkedDocLoaded"]> | undefined;
    const consumer = () => {
      status = runtime.ensureLinkedDocLoaded(
        target.getAsNormalizedFullLink(),
      );
    };

    try {
      runtime.scheduler.subscribe(consumer, {
        reads: [],
        shallowReads: [],
        writes: [],
      }, {
        isEffect: true,
      });
      runtime.scheduler.queueExecution();
      await thirdAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(status).toBe("error");

      connectionState = {
        status: "disconnected",
        epoch: 1,
        cause: new Error("synthetic disconnect after exhaustion"),
      };
      connectionListener?.(connectionState);
      allowSuccess = true;
      connectionState = { status: "ready", epoch: 2 };
      connectionListener?.(connectionState);

      await fourthAttemptStarted.promise;
      await storageManager.crossSpaceSettled();
      await runtime.scheduler.idle();
      expect(status).toBe("settled");
    } finally {
      runtime.scheduler.unsubscribe(consumer);
      storageManager.syncCell = originalSyncCell;
    }
  });

  it("does not reserve a same-space pull when its connection is closed", () => {
    const target = runtime.getCell(
      space,
      "linked-doc-closed-without-reservation",
    );
    const link = target.getAsNormalizedFullLink();
    const cause = new Error("synthetic closed connection");
    let reservationCalls = 0;

    storageManager.subscribeConnectionState = (_space, callback) => {
      callback({ status: "closed", epoch: 1, cause });
      return () => {};
    };
    storageManager.shouldPullDoc = () => {
      reservationCalls++;
      return true;
    };

    expect(runtime.ensureLinkedDocLoaded(link, space)).toBe("error");
    expect(runtime.linkedDocLoadError(link)).toBe(cause);
    expect(reservationCalls).toBe(0);
  });
});
