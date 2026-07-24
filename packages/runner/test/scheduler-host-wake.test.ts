import {
  afterEach,
  beforeEach,
  createSchedulerTestRuntime,
  describe,
  disposeSchedulerTestRuntime,
  expect,
  it,
  Runtime,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("scheduler durable host wakes", () => {
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

  it("re-invalidates a clean live action and coalesces duplicate wakes", async () => {
    let runs = 0;
    const action = (() => {
      runs++;
    }) as Action;
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.scheduler.idle();

    expect(runs).toBe(1);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    expect(runtime.scheduler.invalidateActionForHostWake(action)).toBe(true);
    expect(runtime.scheduler.invalidateActionForHostWake(action)).toBe(true);
    expect(runtime.scheduler.isDirty(action)).toBe(true);

    await runtime.scheduler.idle();
    expect(runs).toBe(2);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
  });

  it("schedules a registered dormant action because the host proved demand", async () => {
    let runs = 0;
    const action = (() => {
      runs++;
    }) as Action;
    runtime.scheduler.subscribe(action, {
      reads: [],
      shallowReads: [],
      writes: [],
    });
    await runtime.scheduler.run(action);
    await runtime.scheduler.idle();

    expect(runs).toBe(1);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
    expect(
      runtime.scheduler.getGraphSnapshot().nodes.find((node) =>
        node.type === "computation"
      )?.isDemanded,
    ).toBe(false);
    expect(runtime.scheduler.invalidateActionForHostWake(action)).toBe(true);

    await runtime.scheduler.idle();
    expect(runs).toBe(2);
    expect(runtime.scheduler.isDirty(action)).toBe(false);
  });

  it("ignores a stale wake for an action no longer registered", () => {
    const action = (() => {}) as Action;
    expect(runtime.scheduler.invalidateActionForHostWake(action)).toBe(false);
  });
});
