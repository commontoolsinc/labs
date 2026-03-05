// Push-triggered filtering and parent-child action ordering tests.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import { type Action } from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("push-triggered filtering", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should track mightWrite from actual writes", async () => {
    const cell = runtime.getCell<number>(
      space,
      "mightwrite-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(42);
    };

    // Initially no mightWrite
    expect(runtime.scheduler.getMightWrite(action)).toBeUndefined();

    // Run action
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    // mightWrite should now include the cell
    const mightWrite = runtime.scheduler.getMightWrite(action);
    expect(mightWrite).toBeDefined();
    expect(mightWrite!.length).toBeGreaterThan(0);
  });

  it("should accumulate mightWrite over multiple runs", async () => {
    const cell1 = runtime.getCell<number>(space, "mw-accum-1", undefined, tx);
    const cell2 = runtime.getCell<number>(space, "mw-accum-2", undefined, tx);
    cell1.set(0);
    cell2.set(0);
    await tx.commit();
    tx = runtime.edit();

    let writeToCell2 = false;
    const action: Action = (actionTx) => {
      cell1.withTx(actionTx).send(1);
      if (writeToCell2) {
        cell2.withTx(actionTx).send(2);
      }
    };

    // First run - writes only to cell1
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell1.getAsNormalizedFullLink()] },
      {},
    );
    await cell1.pull();

    const mightWrite1 = runtime.scheduler.getMightWrite(action);
    const initialLength = mightWrite1?.length || 0;

    // Second run - writes to both cells
    writeToCell2 = true;
    runtime.scheduler.subscribe(
      action,
      {
        reads: [],
        writes: [
          cell1.getAsNormalizedFullLink(),
          cell2.getAsNormalizedFullLink(),
        ],
      },
      {},
    );
    await cell2.pull();

    // mightWrite should have grown
    const mightWrite2 = runtime.scheduler.getMightWrite(action);
    expect(mightWrite2!.length).toBeGreaterThan(initialLength);
  });

  it("should track filter stats", async () => {
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(space, "filter-stats", undefined, tx);
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const action: Action = (actionTx) => {
      cell.withTx(actionTx).send(1);
    };

    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [] },
      {},
    );
    await cell.pull();

    const stats = runtime.scheduler.getFilterStats();
    // Action should have executed (not filtered)
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should allow first run even without pushTriggered (default scheduling)", async () => {
    runtime.scheduler.enablePullMode();
    runtime.scheduler.resetFilterStats();

    const cell = runtime.getCell<number>(
      space,
      "first-run-test",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // First run with default scheduling should work
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(1);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
    expect(stats.filtered).toBe(0);
  });

  it("should use pushTriggered to track storage-triggered actions", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "push-triggered-test",
      undefined,
      tx,
    );
    cell.set(1);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      const val = cell.withTx(actionTx).get();
      cell.withTx(actionTx).send(val + 1);
    };

    // Subscribe as effect - first run
    runtime.scheduler.subscribe(
      action,
      {
        reads: [cell.getAsNormalizedFullLink()],
        writes: [cell.getAsNormalizedFullLink()],
      },
      { isEffect: true },
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Change cell via external means (simulating storage change)
    cell.withTx(tx).send(100);
    await tx.commit();
    tx = runtime.edit();
    await cell.pull();

    // Action should have been triggered by storage change and run
    expect(runCount).toBe(2);

    // Verify it was tracked as push-triggered (executed, not filtered)
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.executed).toBeGreaterThan(0);
  });

  it("should not filter actions scheduled with default scheduling", async () => {
    runtime.scheduler.enablePullMode();

    const cell = runtime.getCell<number>(
      space,
      "schedule-immed-filter",
      undefined,
      tx,
    );
    cell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const action: Action = (actionTx) => {
      runCount++;
      cell.withTx(actionTx).send(runCount);
    };

    // Run once to establish mightWrite
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();
    expect(runCount).toBe(1);

    runtime.scheduler.resetFilterStats();

    // Run again with default scheduling - should bypass filter
    runtime.scheduler.subscribe(
      action,
      { reads: [], writes: [cell.getAsNormalizedFullLink()] },
      {},
    );
    await cell.pull();

    expect(runCount).toBe(2);
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
  });

  it("should reset filter stats", () => {
    runtime.scheduler.resetFilterStats();
    const stats = runtime.scheduler.getFilterStats();
    expect(stats.filtered).toBe(0);
    expect(stats.executed).toBe(0);
  });
});

describe("parent-child action ordering", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Use push mode for parent-child ordering tests since these test
    // execution ordering when all pending actions run in the same cycle
    runtime.scheduler.disablePullMode();
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("should execute parent actions before child actions", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-order-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    // Parent action that subscribes a child during execution
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      // Subscribe child action during parent execution
      runtime.scheduler.subscribe(
        childAction,
        { reads: [], writes: [] },
        { isEffect: true },
      );

      return val;
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    // Parent should execute first, then child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should skip child if parent unsubscribes it", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-unsubscribe-source",
      undefined,
      tx,
    );
    source.set(1);
    const toggle = runtime.getCell<boolean>(
      space,
      "parent-child-unsubscribe-toggle",
      undefined,
      tx,
    );
    toggle.set(true);
    await tx.commit();
    tx = runtime.edit();

    let childCanceler: (() => void) | null = null;

    // Parent action that conditionally subscribes/unsubscribes child
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const shouldHaveChild = toggle.withTx(actionTx).get();

      if (shouldHaveChild && !childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          {},
        );
      } else if (!shouldHaveChild && childCanceler) {
        childCanceler();
        childCanceler = null;
      }
    };

    const childAction: Action = (_actionTx) => {
      executionOrder.push("child");
    };

    // Subscribe parent as an effect (so it re-runs when toggle changes)
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [toggle.getAsNormalizedFullLink()], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Now toggle to false - parent should unsubscribe child
    executionOrder.length = 0;
    toggle.withTx(tx).send(false);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Parent runs (and unsubscribes child), child should NOT run
    expect(executionOrder).toEqual(["parent"]);
  });

  it("should order parent before child even when both become dirty", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-both-dirty-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;

    // Parent reads source and subscribes child on first run
    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      const val = source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe child as an effect too (so it re-runs when source changes)
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { isEffect: true },
        );
      }

      return val;
    };

    // Child also reads source (so both become dirty when source changes)
    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark parent as effect so it re-runs when source changes
    runtime.scheduler.subscribe(
      parentAction,
      { reads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    expect(executionOrder).toEqual(["parent", "child"]);

    // Change source - both parent and child should become dirty
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Parent should still execute before child
    expect(executionOrder).toEqual(["parent", "child"]);
  });

  it("should handle nested parent-child-grandchild ordering", async () => {
    const executionOrder: string[] = [];

    const source = runtime.getCell<number>(
      space,
      "parent-child-grandchild-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childSubscribed = false;
    let grandchildSubscribed = false;

    const grandparentAction: Action = (actionTx) => {
      executionOrder.push("grandparent");
      source.withTx(actionTx).get();

      if (!childSubscribed) {
        childSubscribed = true;
        // Subscribe parent as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          parentAction,
          { reads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const parentAction: Action = (actionTx) => {
      executionOrder.push("parent");
      source.withTx(actionTx).get();

      if (!grandchildSubscribed) {
        grandchildSubscribed = true;
        // Subscribe child as effect so it re-runs when source changes
        runtime.scheduler.subscribe(
          childAction,
          { reads: [], writes: [] },
          { isEffect: true },
        );
      }
    };

    const childAction: Action = (actionTx) => {
      executionOrder.push("child");
      source.withTx(actionTx).get();
    };

    // Mark grandparent as effect so the chain re-runs when source changes
    runtime.scheduler.subscribe(
      grandparentAction,
      { reads: [], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    // Should execute in order: grandparent -> parent -> child
    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);

    // Change source - all three should become dirty and re-execute in order
    executionOrder.length = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(executionOrder).toEqual(["grandparent", "parent", "child"]);
  });

  it("should clean up parent-child relationships on unsubscribe", async () => {
    const source = runtime.getCell<number>(
      space,
      "parent-child-cleanup-source",
      undefined,
      tx,
    );
    source.set(1);
    await tx.commit();
    tx = runtime.edit();

    let childCanceler: (() => void) | undefined;
    let childRunCount = 0;

    const parentAction: Action = (actionTx) => {
      source.withTx(actionTx).get();

      if (!childCanceler) {
        childCanceler = runtime.scheduler.subscribe(
          childAction,
          { reads: [source.getAsNormalizedFullLink()], writes: [] },
          {},
        );
      }
    };

    const childAction: Action = (actionTx) => {
      childRunCount++;
      source.withTx(actionTx).get();
    };

    const parentCanceler = runtime.scheduler.subscribe(
      parentAction,
      { reads: [source.getAsNormalizedFullLink()], writes: [] },
      { isEffect: true },
    );
    await runtime.idle();

    expect(childRunCount).toBe(1);

    // Unsubscribe the parent - this should clean up the relationship
    parentCanceler();

    // Also unsubscribe child to prevent it from running independently
    if (childCanceler) childCanceler();

    // Change source and verify neither runs
    childRunCount = 0;
    source.withTx(tx).send(2);
    await tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    expect(childRunCount).toBe(0);
  });
});
