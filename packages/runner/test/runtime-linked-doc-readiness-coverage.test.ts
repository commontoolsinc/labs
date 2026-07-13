import type { Cell } from "../src/cell.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
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
});
