import {
  getLogger,
  getLoggerCountsBreakdown,
} from "@commonfabric/utils/logger";
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
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        output.withTx(actionTx).send(value * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
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
    const outputLink = output.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        output.withTx(actionTx).send(value * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
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

  it("does not warn for scoped-slot writes outside the declared surface", async () => {
    getLogger("scheduler").resetCounts();
    const source = runtime.getCell<number>(
      space,
      "static-writes-scoped-source",
      undefined,
      tx,
    );
    const declared = runtime.getCell<number>(
      space,
      "static-writes-scoped-declared",
      undefined,
      tx,
    );
    const scopedTarget = runtime.getCell<number>(
      space,
      "static-writes-scoped-target",
      undefined,
      tx,
    );
    source.set(1);
    declared.set(0);
    await tx.commit();
    tx = runtime.edit();

    // Per-user/per-session slots are runtime-mediated (scope defaults,
    // UI state) and not part of the authored surface; the declaration-gap
    // diagnostic must not flag them.
    const scopedLink = {
      ...scopedTarget.getAsNormalizedFullLink(),
      scope: "session" as const,
    };
    let runs = 0;
    const declaredLink = declared.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        runtime.getCellFromLink<number>(scopedLink, undefined, actionTx)
          .send(value);
      }) as Action,
      {
        writes: [declaredLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredLink)],
      },
      {},
    );

    const cancel = declared.withTx(tx).sink(() => {});
    try {
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(runs).toBe(1);
      expect(
        getLoggerCountsBreakdown().scheduler?.["write-surface-violation"]
          ?.debug ?? 0,
      ).toBe(0);
    } finally {
      cancel();
      getLogger("scheduler").resetCounts();
    }
  });

  it("warns when a computation writes outside its declared surface", async () => {
    getLogger("scheduler").resetCounts();
    const source = runtime.getCell<number>(
      space,
      "static-writes-violation-source",
      undefined,
      tx,
    );
    const declared = runtime.getCell<number>(
      space,
      "static-writes-violation-declared",
      undefined,
      tx,
    );
    const undeclared = runtime.getCell<number>(
      space,
      "static-writes-violation-undeclared",
      undefined,
      tx,
    );
    source.set(1);
    declared.set(0);
    undeclared.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const declaredLink = declared.getAsNormalizedFullLink();
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const value = source.withTx(actionTx).get();
        undeclared.withTx(actionTx).send(value);
      }) as Action,
      {
        writes: [declaredLink],
      },
    );

    runtime.scheduler.subscribe(
      writer,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(declaredLink)],
      },
      {},
    );

    const cancel = declared.withTx(tx).sink(() => {});
    try {
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(runs).toBe(1);
      expect(undeclared.get()).toBe(2);
      expect(
        getLoggerCountsBreakdown().scheduler?.["write-surface-violation"]
          ?.debug,
      ).toBe(1);
    } finally {
      cancel();
      getLogger("scheduler").resetCounts();
    }
  });
});
