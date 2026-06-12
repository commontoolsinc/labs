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
  toMemorySpaceAddress,
} from "./scheduler-test-utils.ts";
import type {
  Action,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";

describe("static write surface demand", () => {
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

  it("keeps a declared writer dormant while its output has no demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-dormant-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-dormant-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const writer: Action = (actionTx) => {
      runs++;
      const value = source.withTx(actionTx).get();
      output.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );

    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();

    expect(runs).toBe(0);
    expect(output.get()).toBe(0);
  });

  it("runs a declared writer when demand arrives at its output", async () => {
    const source = runtime.getCell<number>(
      space,
      "static-writes-demand-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "static-writes-demand-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const writer: Action = (actionTx) => {
      runs++;
      const value = source.withTx(actionTx).get();
      output.withTx(actionTx).send(value * 10);
    };

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(output.getAsNormalizedFullLink())],
      },
      {},
    );

    source.withTx(tx).send(3);
    await tx.commit();
    tx = runtime.edit();
    await runtime.scheduler.idle();
    expect(runs).toBe(0);

    const cancel = output.withTx(tx).sink(() => {});
    try {
      await runtime.scheduler.idle();

      expect(runs).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      cancel();
    }
  });
});
