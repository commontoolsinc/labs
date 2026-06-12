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
  Cell,
  IExtendedStorageTransaction,
  SchedulerTestStorageManager,
} from "./scheduler-test-utils.ts";
import { PASS_RUN_BUDGET } from "../src/scheduler/constants.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
import {
  type DependencyGraphState,
  isLive,
  registerDependentEdge,
  unregisterDependentEdge,
} from "../src/scheduler/dependency-graph.ts";
import { SchedulerDelays } from "../src/scheduler/delays.ts";
import {
  getNextDebounceRunTime,
  isDebouncedComputationWaiting,
  type SchedulerDelayControlState,
} from "../src/scheduler/delay-control.ts";

async function expectSchedulerIdle(runtime: Runtime): Promise<void> {
  const result = await Promise.race([
    runtime.scheduler.idle().then(() => "idle" as const),
    new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 2_000)
    ),
  ]);
  expect(result).toBe("idle");
}

describe("scheduler v2 cutover fixtures", () => {
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

  it("rewires conditional reads when the active branch changes", async () => {
    const condition = runtime.getCell<boolean>(
      space,
      "v2-cutover-ifelse-condition",
      undefined,
      tx,
    );
    const left = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-left",
      undefined,
      tx,
    );
    const right = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-right",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-ifelse-output",
      undefined,
      tx,
    );
    condition.set(true);
    left.set(10);
    right.set(20);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const chooser = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        const active = condition.withTx(actionTx).get()
          ? left.withTx(actionTx).get()
          : right.withTx(actionTx).get();
        output.withTx(actionTx).send(active);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    runtime.scheduler.subscribe(
      chooser,
      {
        reads: [
          toMemorySpaceAddress(condition.getAsNormalizedFullLink()),
          toMemorySpaceAddress(left.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );

    expect(await output.pull()).toBe(10);
    expect(runs).toBe(1);

    condition.withTx(tx).send(false);
    await tx.commit();
    tx = runtime.edit();
    expect(await output.pull()).toBe(20);
    expect(runs).toBe(2);

    left.withTx(tx).send(11);
    await tx.commit();
    tx = runtime.edit();
    expect(await output.pull()).toBe(20);
    expect(runs).toBe(2);

    right.withTx(tx).send(21);
    await tx.commit();
    tx = runtime.edit();
    expect(await output.pull()).toBe(21);
    expect(runs).toBe(3);
  });

  it("continues a parent when its created child updates a sampled value", async () => {
    const item = runtime.getCell<number>(
      space,
      "v2-cutover-parent-continuation-item",
      undefined,
      tx,
    );
    item.set(1);
    await tx.commit();
    tx = runtime.edit();

    const samples: number[] = [];
    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const itemLink = item.getAsNormalizedFullLink();
    const itemAddress = toMemorySpaceAddress(itemLink);

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        item.withTx(actionTx).send(2);
      }) as Action,
      {
        writes: [itemLink],
      },
    );

    const parent: Action = (actionTx) => {
      samples.push(item.withTx(actionTx).get());
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [], shallowReads: [], writes: [itemAddress] },
          {},
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      { reads: [itemAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(samples).toEqual([1, 2]);
      expect(childRuns).toBe(1);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("does not run an effect when its upstream output is unchanged", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-noop-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-noop-output",
      undefined,
      tx,
    );
    source.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let computeRuns = 0;
    let effectRuns = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const compute = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        computeRuns++;
        const next = Math.floor(source.withTx(actionTx).get() / 10);
        output.withTx(actionTx).send(next);
      }) as Action,
      {
        writes: [outputLink],
      },
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
      effectRuns++;
    };

    const computeCancel = runtime.scheduler.subscribe(
      compute,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );
    const effectCancel = runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outputLink)],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      computeRuns = 0;
      effectRuns = 0;

      for (const value of [1, 2, 3]) {
        source.withTx(tx).send(value);
        await tx.commit();
        tx = runtime.edit();
        await runtime.scheduler.idle();
      }

      expect(computeRuns).toBe(3);
      expect(effectRuns).toBe(0);
      expect(output.get()).toBe(0);
    } finally {
      computeCancel();
      effectCancel();
    }
  });

  it("runs an effect once per changed upstream output", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-changed-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-changed-output",
      undefined,
      tx,
    );
    source.set(0);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let effectRuns = 0;
    const outputLink = output.getAsNormalizedFullLink();
    const compute = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );
    const effect: Action = (actionTx) => {
      output.withTx(actionTx).get();
      effectRuns++;
    };

    const computeCancel = runtime.scheduler.subscribe(
      compute,
      {
        reads: [toMemorySpaceAddress(source.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(outputLink)],
      },
      {},
    );
    const effectCancel = runtime.scheduler.subscribe(
      effect,
      {
        reads: [toMemorySpaceAddress(outputLink)],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      effectRuns = 0;

      for (const [index, value] of [1, 2, 3].entries()) {
        source.withTx(tx).send(value);
        await tx.commit();
        tx = runtime.edit();
        await runtime.scheduler.idle();
        expect(output.get()).toBe(value * 10);
        expect(effectRuns).toBe(index + 1);
      }
    } finally {
      computeCancel();
      effectCancel();
    }
  });

  it("bounds a cycling subgraph without blocking an unrelated subgraph", async () => {
    const cycleA = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-a",
      undefined,
      tx,
    );
    const cycleB = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-b",
      undefined,
      tx,
    );
    const unrelatedSource = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-unrelated-source",
      undefined,
      tx,
    );
    const unrelatedOutput = runtime.getCell<number>(
      space,
      "v2-cutover-cycle-unrelated-output",
      undefined,
      tx,
    );
    cycleA.set(0);
    cycleB.set(0);
    unrelatedSource.set(7);
    unrelatedOutput.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCountA = 0;
    let runCountB = 0;
    const unrelatedValues: number[] = [];

    const actionA = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCountA++;
        cycleA.withTx(actionTx).send(cycleB.withTx(actionTx).get() + 1);
      }) as Action,
      {
        writes: [cycleA.getAsNormalizedFullLink()],
      },
    );
    const actionB = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runCountB++;
        cycleB.withTx(actionTx).send(cycleA.withTx(actionTx).get() + 1);
      }) as Action,
      {
        writes: [cycleB.getAsNormalizedFullLink()],
      },
    );
    const cycleEffect: Action = (actionTx) => {
      cycleB.withTx(actionTx).get();
    };

    const unrelatedWriter = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        unrelatedOutput.withTx(actionTx).send(
          unrelatedSource.withTx(actionTx).get() * 10,
        );
      }) as Action,
      {
        writes: [unrelatedOutput.getAsNormalizedFullLink()],
      },
    );
    const unrelatedEffect: Action = (actionTx) => {
      unrelatedValues.push(unrelatedOutput.withTx(actionTx).get());
    };

    const cancelA = runtime.scheduler.subscribe(
      actionA,
      {
        reads: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
      },
      {},
    );
    const cancelB = runtime.scheduler.subscribe(
      actionB,
      {
        reads: [toMemorySpaceAddress(cycleA.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
      },
      {},
    );
    const cancelCycleEffect = runtime.scheduler.subscribe(
      cycleEffect,
      {
        reads: [toMemorySpaceAddress(cycleB.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );
    const cancelUnrelatedWriter = runtime.scheduler.subscribe(
      unrelatedWriter,
      {
        reads: [
          toMemorySpaceAddress(unrelatedSource.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [
          toMemorySpaceAddress(unrelatedOutput.getAsNormalizedFullLink()),
        ],
      },
      {},
    );
    const cancelUnrelatedEffect = runtime.scheduler.subscribe(
      unrelatedEffect,
      {
        reads: [
          toMemorySpaceAddress(unrelatedOutput.getAsNormalizedFullLink()),
        ],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await expectSchedulerIdle(runtime);
      expect(runCountA + runCountB).toBeGreaterThan(0);
      expect(runCountA).toBeLessThanOrEqual(PASS_RUN_BUDGET);
      expect(runCountB).toBeLessThanOrEqual(PASS_RUN_BUDGET);
      expect(unrelatedValues[unrelatedValues.length - 1]).toBe(70);
    } finally {
      cancelA();
      cancelB();
      cancelCycleEffect();
      cancelUnrelatedWriter();
      cancelUnrelatedEffect();
    }
  });

  it("keeps provisional demand until parent-created readers can demand a child", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-trigger",
      undefined,
      tx,
    );
    const childSource = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-child-source",
      undefined,
      tx,
    );
    const childOutput = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-child-output",
      undefined,
      tx,
    );
    trigger.set(0);
    childSource.set(1);
    childOutput.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childARuns = 0;
    const childBValues: number[] = [];
    let childACancel: (() => void) | undefined;
    let childBCancel: (() => void) | undefined;
    const childOutputLink = childOutput.getAsNormalizedFullLink();
    const childOutputAddress = toMemorySpaceAddress(childOutputLink);

    const childA = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childARuns++;
        childOutput.withTx(actionTx).send(
          childSource.withTx(actionTx).get() * 10,
        );
      }) as Action,
      {
        writes: [childOutputLink],
      },
    );
    const childB: Action = (actionTx) => {
      childBValues.push(childOutput.withTx(actionTx).get());
    };

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childACancel) {
        childACancel = runtime.scheduler.subscribe(
          childA,
          {
            reads: [
              toMemorySpaceAddress(childSource.getAsNormalizedFullLink()),
            ],
            shallowReads: [],
            writes: [childOutputAddress],
          },
          {},
        );
      }
      if (!childBCancel) {
        childBCancel = runtime.scheduler.subscribe(
          childB,
          { reads: [childOutputAddress], shallowReads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(childARuns).toBe(1);
      expect(childBValues.includes(10)).toBe(true);

      childBValues.length = 0;
      childSource.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(childARuns).toBe(2);
      expect(childBValues.includes(20)).toBe(true);
    } finally {
      parentCancel();
      childACancel?.();
      childBCancel?.();
    }
  });

  it("keeps provisional demand for a debounced child until the gate opens", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-trigger",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-gated-output",
      undefined,
      tx,
    );
    trigger.set(0);
    source.set(3);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const outputLink = output.getAsNormalizedFullLink();
    const outputAddress = toMemorySpaceAddress(outputLink);
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [sourceAddress], shallowReads: [], writes: [outputAddress] },
          { debounce: 200 },
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      const idleStart = performance.now();
      await runtime.scheduler.idle();
      expect(performance.now() - idleStart).toBeGreaterThanOrEqual(180);
      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("expires provisional demand after a parent-created child runs", async () => {
    const trigger = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-trigger",
      undefined,
      tx,
    );
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-provisional-expiry-output",
      undefined,
      tx,
    );
    trigger.set(0);
    source.set(3);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let childRuns = 0;
    let childCancel: (() => void) | undefined;
    const outputLink = output.getAsNormalizedFullLink();
    const outputAddress = toMemorySpaceAddress(outputLink);
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const child = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        childRuns++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        writes: [outputLink],
      },
    );

    const parent: Action = (actionTx) => {
      trigger.withTx(actionTx).get();
      if (!childCancel) {
        childCancel = runtime.scheduler.subscribe(
          child,
          { reads: [sourceAddress], shallowReads: [], writes: [outputAddress] },
          {},
        );
      }
    };

    const parentCancel = runtime.scheduler.subscribe(
      parent,
      {
        reads: [toMemorySpaceAddress(trigger.getAsNormalizedFullLink())],
        shallowReads: [],
        writes: [],
      },
      { isEffect: true },
    );

    try {
      await runtime.scheduler.idle();
      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);

      source.withTx(tx).send(4);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(childRuns).toBe(1);
      expect(output.get()).toBe(30);
    } finally {
      parentCancel();
      childCancel?.();
    }
  });

  it("keeps a declared writer dormant while its output has no demand", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-dormant-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-dormant-output",
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
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
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

  it("does not trigger a never-ran node from declared reads alone", async () => {
    const source = runtime.getCell<number>(
      space,
      "v2-cutover-declared-read-source",
      undefined,
      tx,
    );
    const output = runtime.getCell<number>(
      space,
      "v2-cutover-declared-read-output",
      undefined,
      tx,
    );
    source.set(1);
    output.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runs = 0;
    const sourceLink = source.getAsNormalizedFullLink();
    const outputLink = output.getAsNormalizedFullLink();
    const sourceAddress = toMemorySpaceAddress(sourceLink);
    const writer = Object.assign(
      ((actionTx: IExtendedStorageTransaction) => {
        runs++;
        output.withTx(actionTx).send(source.withTx(actionTx).get() * 10);
      }) as Action,
      {
        reads: [sourceLink],
        writes: [outputLink],
      },
    );
    const internal = runtime.scheduler as unknown as {
      nodes: {
        get(action: Action): {
          status: string;
          declaredReads: unknown[];
          invalidCauses: unknown[];
        } | undefined;
      };
    };

    const cancel = runtime.scheduler.subscribe(writer);

    try {
      await runtime.scheduler.idle();
      const record = internal.nodes.get(writer);
      expect(record?.status).toBe("never-ran");
      expect(record?.declaredReads).toEqual([sourceAddress]);
      expect(record?.invalidCauses).toEqual([]);
      expect(runs).toBe(0);

      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();

      expect(internal.nodes.get(writer)?.invalidCauses).toEqual([]);
      expect(runs).toBe(0);
      expect(output.get()).toBe(0);
    } finally {
      cancel();
    }
  });

  it("matches v1 parent-link semantics across registration paths", async () => {
    const parentlessSource = runtime.getCell<number>(
      space,
      "v2-cutover-parentless-source",
      undefined,
      tx,
    );
    const stickySource = runtime.getCell<number>(
      space,
      "v2-cutover-sticky-parent-source",
      undefined,
      tx,
    );
    const parentTrigger = runtime.getCell<number>(
      space,
      "v2-cutover-parent-link-trigger",
      undefined,
      tx,
    );
    parentlessSource.set(1);
    stickySource.set(1);
    parentTrigger.set(1);
    await tx.commit();
    tx = runtime.edit();

    const parentlessAddress = toMemorySpaceAddress(
      parentlessSource.getAsNormalizedFullLink(),
    );
    const stickyAddress = toMemorySpaceAddress(
      stickySource.getAsNormalizedFullLink(),
    );
    const triggerAddress = toMemorySpaceAddress(
      parentTrigger.getAsNormalizedFullLink(),
    );

    const noOpThenAssignChild: Action = function noOpThenAssignChild(
      actionTx,
    ) {
      parentlessSource.withTx(actionTx).get();
    };
    const preserveChild: Action = function preserveChild(actionTx) {
      stickySource.withTx(actionTx).get();
    };
    const overwriteChild: Action = function overwriteChild(actionTx) {
      stickySource.withTx(actionTx).get();
    };
    const deferredRegistry = new NodeRegistry();
    const deferredParent: Action = function deferredParent() {};
    const deferredChild: Action = function deferredChild() {};

    deferredRegistry.register(deferredChild, "computation");
    deferredRegistry.linkParent(deferredChild, deferredParent);
    expect(deferredRegistry.parentOf(deferredChild)).toBeUndefined();
    deferredRegistry.register(deferredParent, "effect");
    expect(deferredRegistry.parentOf(deferredChild)?.action).toBe(
      deferredParent,
    );
    expect(
      deferredRegistry.childrenOf(deferredParent)?.has(
        deferredRegistry.get(deferredChild)!,
      ),
    ).toBe(true);

    const parentlessInitialCancel = runtime.scheduler.subscribe(
      noOpThenAssignChild,
      { reads: [parentlessAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();
    parentlessInitialCancel();
    await runtime.scheduler.idle();

    const parentlessNestedCancels: Array<() => void> = [];
    const parentQ: Action = function parentQ(actionTx) {
      parentTrigger.withTx(actionTx).get();
      if (parentlessNestedCancels.length === 0) {
        parentlessNestedCancels.push(
          runtime.scheduler.subscribe(
            noOpThenAssignChild,
            { reads: [parentlessAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
      }
    };
    const parentQCancel = runtime.scheduler.subscribe(
      parentQ,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    let graph = runtime.scheduler.getGraphSnapshot();
    const parentlessNode = graph.nodes.find((node) =>
      node.id === "noOpThenAssignChild"
    );
    expect(parentlessNode).toBeDefined();
    expect(parentlessNode!.parentId).toBe("parentQ");

    const stickyCancels: Array<() => void> = [];
    const parentP: Action = function parentP(actionTx) {
      parentTrigger.withTx(actionTx).get();
      if (stickyCancels.length === 0) {
        stickyCancels.push(
          runtime.scheduler.subscribe(
            preserveChild,
            { reads: [stickyAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
        stickyCancels.push(
          runtime.scheduler.subscribe(
            overwriteChild,
            { reads: [stickyAddress], shallowReads: [], writes: [] },
            { isEffect: true },
          ),
        );
      }
    };
    const parentPCancel = runtime.scheduler.subscribe(
      parentP,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    graph = runtime.scheduler.getGraphSnapshot();
    const firstPreserveNode = graph.nodes.find((node) =>
      node.id === "preserveChild"
    );
    const firstOverwriteNode = graph.nodes.find((node) =>
      node.id === "overwriteChild"
    );
    expect(firstPreserveNode?.parentId).toBe("parentP");
    expect(firstOverwriteNode?.parentId).toBe("parentP");

    const parentRSubscribeCancels: Array<() => void> = [];
    const parentR: Action = function parentR(actionTx) {
      parentTrigger.withTx(actionTx).get();
      runtime.scheduler.resubscribe(
        preserveChild,
        { reads: [stickyAddress], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      if (parentRSubscribeCancels.length === 0) {
        parentRSubscribeCancels.push(
          runtime.scheduler.subscribe(overwriteChild, {
            reads: [stickyAddress],
            shallowReads: [],
            writes: [],
          }, { isEffect: true }),
        );
      }
    };
    const parentRCancel = runtime.scheduler.subscribe(
      parentR,
      { reads: [triggerAddress], shallowReads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.scheduler.idle();

    graph = runtime.scheduler.getGraphSnapshot();
    const secondPreserveNode = graph.nodes.find((node) =>
      node.id === "preserveChild"
    );
    const secondOverwriteNode = graph.nodes.find((node) =>
      node.id === "overwriteChild"
    );
    expect(secondPreserveNode?.parentId).toBe("parentP");
    expect(secondOverwriteNode?.parentId).toBe("parentR");

    parentQCancel();
    for (const cancel of parentlessNestedCancels) cancel();
    parentPCancel();
    parentRCancel();
    for (const cancel of stickyCancels) cancel();
    for (const cancel of parentRSubscribeCancels) cancel();
  });

  it("promotes a computation to an effect on re-registration", async () => {
    // v1 parity: updateSchedulerActionType allowed an action first seen as a
    // computation to be promoted by a later `isEffect: true` subscription
    // ("once an effect, stays an effect"). Strict kind re-registration must
    // not throw on that path.
    const registry = new NodeRegistry();
    const promoted: Action = function promotedAction() {};
    registry.register(promoted, "computation");
    expect(registry.isComputation(promoted)).toBe(true);

    const record = registry.register(promoted, "effect");
    expect(record.kind).toBe("effect");
    expect(registry.isEffect(promoted)).toBe(true);
    expect(registry.isComputation(promoted)).toBe(false);

    // End-to-end: a live re-subscription with isEffect must not throw.
    const source = runtime.getCell<number>(
      space,
      "cutover-promotion-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();
    const sourceAddress = toMemorySpaceAddress(
      source.getAsNormalizedFullLink(),
    );

    const reader: Action = function promotionReader(actionTx) {
      source.withTx(actionTx).get();
    };
    const firstCancel = runtime.scheduler.subscribe(reader, {
      reads: [sourceAddress],
      shallowReads: [],
      writes: [],
    });
    const promoteCancel = runtime.scheduler.subscribe(reader, {
      reads: [sourceAddress],
      shallowReads: [],
      writes: [],
    }, { isEffect: true });
    await runtime.scheduler.idle();
    firstCancel();
    promoteCancel();
  });

  it("keeps captured parent actions reachable before the parent registers", () => {
    // v1 parity: the parent edge was a WeakMap keyed by action objects, so
    // demand checks could consult the parent action even when its record was
    // not (yet) registered. parentActionOf() preserves that raw access.
    const registry = new NodeRegistry();
    const lazyParent: Action = function lazyParent() {};
    const lazyChild: Action = function lazyChild() {};
    registry.register(lazyChild, "computation");
    registry.linkParent(lazyChild, lazyParent);

    expect(registry.parentOf(lazyChild)).toBeUndefined();
    expect(registry.parentActionOf(lazyChild)).toBe(lazyParent);

    registry.register(lazyParent, "effect");
    expect(registry.parentOf(lazyChild)?.action).toBe(lazyParent);
    expect(registry.parentActionOf(lazyChild)).toBe(lazyParent);
  });

  it("releases liveness through dependency cycles", () => {
    // Spec §5.2: edge updates propagate refcount deltas with a visited-set
    // cycle guard. Without the guard on the increment itself, a cycle's back
    // edge double-counts the origin (A=2), and unsubscribing the only live
    // root drops just one ref — the cycle stays live forever.
    const nodes = new NodeRegistry();
    const state = {
      nodes,
      dependents: new WeakMap<Action, Set<Action>>(),
      reverseDependencies: new WeakMap<Action, Set<Action>>(),
      materializerIndex: { isMaterializer: () => false },
      staleness: {
        addStaleUpstream: () => {},
        removeStaleUpstream: () => {},
      },
      isStale: () => false,
      queueExecution: () => {},
      getSchedulingWrites: () => undefined,
    } as unknown as DependencyGraphState;

    const liveRoot: Action = function liveRoot() {};
    const cycleA: Action = function cycleA() {};
    const cycleB: Action = function cycleB() {};
    nodes.register(liveRoot, "effect");
    nodes.register(cycleA, "computation");
    nodes.register(cycleB, "computation");

    // A and B read each other; the effect reads A.
    registerDependentEdge(state, cycleB, cycleA);
    registerDependentEdge(state, cycleA, cycleB);
    registerDependentEdge(state, cycleA, liveRoot);

    expect(isLive(state, nodes.get(cycleA)!)).toBe(true);
    expect(isLive(state, nodes.get(cycleB)!)).toBe(true);

    unregisterDependentEdge(state, cycleA, liveRoot);

    expect(isLive(state, nodes.get(cycleA)!)).toBe(false);
    expect(isLive(state, nodes.get(cycleB)!)).toBe(false);
  });

  it("plans wake times for first-run debounced computations", () => {
    // The waiting check and the wake-time planner must agree on the
    // first-run debounce gate: if one schedules a debounce the other must
    // report its ready time, or planners spin without a wake.
    const delays = new SchedulerDelays({
      actionStats: new Map(),
      getActionId: () => "debounced-first-run",
    });
    const action: Action = function debouncedFirstRun() {};
    delays.setDebounce(action, 50);
    const state: SchedulerDelayControlState = {
      delays,
      computations: new Set([action]),
      effects: new Set<Action>(),
      isInvalid: () => true,
      pending: new Set<Action>(),
      queueExecution: () => {},
      logDebounce: () => {},
      shouldDebounceFirstRun: () => true,
    };

    try {
      expect(isDebouncedComputationWaiting(state, action)).toBe(true);
      expect(getNextDebounceRunTime(state, action)).toBeDefined();
    } finally {
      delays.clearActiveDebounceTimers();
    }
  });

  it("settles a deep acyclic chain without iteration-cap backoff", async () => {
    // A chain deeper than MAX_ITERS (10) advances one hop per settle
    // iteration as each commit invalidates the next reader. It hits the
    // iteration cap while making healthy forward progress (no action runs
    // anywhere near the per-pass run budget), so it must re-queue another
    // pass immediately, not pause for BACKOFF_BASE_MS (250ms).
    const DEPTH = 12;
    const cells: Cell<number>[] = [];
    for (let i = 0; i <= DEPTH; i++) {
      const cell = runtime.getCell<number>(
        space,
        `v2-cutover-deep-chain-${i}`,
        undefined,
        tx,
      );
      cell.set(0);
      cells.push(cell);
    }
    await tx.commit();
    tx = runtime.edit();

    const cancels: Array<() => void> = [];
    let maxRunsForAnyLink = 0;
    try {
      // Chain: cell[i+1] = cell[i] + 1 for each hop.
      for (let i = 0; i < DEPTH; i++) {
        const src = cells[i];
        const dst = cells[i + 1];
        let runs = 0;
        const link = Object.assign(
          ((actionTx: IExtendedStorageTransaction) => {
            runs++;
            maxRunsForAnyLink = Math.max(maxRunsForAnyLink, runs);
            dst.withTx(actionTx).send(src.withTx(actionTx).get() + 1);
          }) as Action,
          { writes: [dst.getAsNormalizedFullLink()] },
        );
        cancels.push(
          runtime.scheduler.subscribe(link, {
            reads: [toMemorySpaceAddress(src.getAsNormalizedFullLink())],
            shallowReads: [],
            writes: [toMemorySpaceAddress(dst.getAsNormalizedFullLink())],
          }),
        );
      }

      // A live effect at the tail makes the whole chain demanded.
      const tailReads: number[] = [];
      const tailEffect: Action = (actionTx) => {
        tailReads.push(cells[DEPTH].withTx(actionTx).get());
      };
      cancels.push(
        runtime.scheduler.subscribe(tailEffect, {
          reads: [toMemorySpaceAddress(cells[DEPTH].getAsNormalizedFullLink())],
          shallowReads: [],
          writes: [],
        }, { isEffect: true }),
      );

      const start = performance.now();
      cells[0].withTx(tx).send(5);
      await tx.commit();
      tx = runtime.edit();
      await runtime.scheduler.idle();
      const elapsed = performance.now() - start;

      // Full propagation: tail sees source + DEPTH hops.
      expect(cells[DEPTH].get()).toBe(5 + DEPTH);
      // Healthy progress, not a cycle: no link approached the run budget.
      expect(maxRunsForAnyLink).toBeLessThan(5);
      // No time-gated backoff pause (250ms). Generous bound for CI noise.
      expect(elapsed).toBeLessThan(200);
    } finally {
      for (const cancel of cancels) cancel();
    }
  });
});
