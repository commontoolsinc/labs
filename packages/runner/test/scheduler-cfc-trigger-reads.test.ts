import { describe, expect, it } from "./scheduler-test-utils.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { SchedulerTriggerIndex } from "../src/scheduler/trigger-index.ts";
import {
  recordCfcTriggerRead,
  type StorageNotificationState,
} from "../src/scheduler/notifications.ts";
import { processPullStorageNotification } from "../src/scheduler/pull-notifications.ts";
import { watchReactiveActionCommit } from "../src/scheduler/action-run.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import type { Action } from "../src/scheduler/types.ts";
import type {
  ChangeGroup,
  IExtendedStorageTransaction,
  IMemoryChange,
  IMemorySpaceAddress,
  IStorageTransaction,
  StorageNotification,
} from "../src/storage/interface.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";

const signer = await Identity.fromPassphrase("scheduler-cfc-trigger-reads");
const space = signer.did() as MemorySpace;

type CfcTriggerReads = StorageNotificationState["cfcTriggerReads"];

function makeChange(
  address: Partial<IMemoryChange["address"]> & { id: string },
): IMemoryChange {
  return {
    address: {
      type: "application/json",
      path: [],
      ...address,
    } as IMemoryChange["address"],
    before: 1,
    after: 2,
  };
}

describe("recordCfcTriggerRead dedup keys", () => {
  it("keeps addresses distinct across scope and ambiguous path joins", () => {
    const cfcTriggerReads: CfcTriggerReads = new WeakMap();
    const state = { cfcTriggerReads };
    const action: Action = () => {};

    // Distinct path arrays that a naive join("/") would collapse.
    recordCfcTriggerRead(
      state,
      action,
      space,
      makeChange({ id: "of:cell", path: ["a", "b"] }),
    );
    recordCfcTriggerRead(
      state,
      action,
      space,
      makeChange({ id: "of:cell", path: ["a/b"] }),
    );
    // Same space/id/path in a different scope is a distinct trigger entity.
    recordCfcTriggerRead(
      state,
      action,
      space,
      makeChange({ id: "of:cell", path: ["a", "b"], scope: "user" }),
    );
    // Exact duplicate (scope omitted ≡ scope "space") dedups.
    recordCfcTriggerRead(
      state,
      action,
      space,
      makeChange({ id: "of:cell", path: ["a", "b"], scope: "space" }),
    );

    const pending = cfcTriggerReads.get(action);
    expect(pending).toBeDefined();
    expect(pending!.addresses.length).toBe(3);
  });
});

function makeNotificationState(args: {
  action: Action;
  triggerIndex: SchedulerTriggerIndex;
  actionChangeGroups?: WeakMap<Action, ChangeGroup>;
}): StorageNotificationState {
  return {
    triggerIndex: args.triggerIndex,
    cfcTriggerReads: new WeakMap(),
    getDiagnosisEnabled: () => false,
    getCollectTriggerTrace: () => false,
    changeGroupToActionId: new Map(),
    recordCausalEdge: () => {},
    actionChangeGroups: args.actionChangeGroups ?? new WeakMap(),
    effects: new Set([args.action]),
    pending: new Set(),
    dirty: new Set(),
    conditionallyScheduledEffects: new Map(),
    getActionId: () => "test-action",
    recordCellUpdate: () => {},
    recordTriggerTrace: () => {},
    scheduleWithDebounce: () => {},
    markDirty: () => {},
    materializerIndex: {
      materializersByEntity: new Map(),
      effects: new Set(),
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    queueExecution: () => {},
    scheduleAffectedEffects: () => [],
  };
}

function makeCommitNotification(
  source: IStorageTransaction,
): StorageNotification {
  // Document-root change: before/after are walked into by the registered
  // trigger paths, so ["value"] must differ between them.
  return {
    type: "commit",
    space,
    changes: [{
      address: {
        id: "of:cell",
        type: "application/json",
        path: [],
      } as IMemoryChange["address"],
      before: { value: 1 },
      after: { value: 2 },
    }],
    source,
  };
}

function makeTriggerIndexFor(action: Action): SchedulerTriggerIndex {
  const triggerIndex = new SchedulerTriggerIndex();
  const read: IMemorySpaceAddress = {
    space,
    scope: "space",
    id: "of:cell",
    path: ["value"],
  };
  triggerIndex.addActionReads(action, [read], []);
  return triggerIndex;
}

describe("trigger reads follow the scheduling decision", () => {
  for (
    const [mode, process] of [
      ["pull", processPullStorageNotification],
    ] as const
  ) {
    it(`${mode}: skip-own-commit-source records no trigger read`, () => {
      const action: Action = () => {};
      const sourceTx = { sourceAction: action } as IStorageTransaction;
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
      });

      process(state, makeCommitNotification(sourceTx));

      expect(state.cfcTriggerReads.get(action)).toBeUndefined();
    });

    it(`${mode}: skip-same-change-group records no trigger read`, () => {
      const action: Action = () => {};
      const changeGroup = {} as ChangeGroup;
      const sourceTx = { changeGroup } as IStorageTransaction;
      const actionChangeGroups = new WeakMap<Action, ChangeGroup>();
      actionChangeGroups.set(action, changeGroup);
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
        actionChangeGroups,
      });

      process(state, makeCommitNotification(sourceTx));

      expect(state.cfcTriggerReads.get(action)).toBeUndefined();
    });

    it(`${mode}: a scheduling change records the trigger read`, () => {
      const action: Action = () => {};
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
      });

      process(state, makeCommitNotification({} as IStorageTransaction));

      const pending = state.cfcTriggerReads.get(action);
      expect(pending).toBeDefined();
      expect(pending!.addresses.length).toBe(1);
      expect(pending!.addresses[0]).toMatchObject({
        space,
        id: "of:cell",
        path: [],
      });
    });
  }
});

describe("trigger reads survive failed runs", () => {
  function watchWith(args: {
    retries?: WeakMap<Action, number>;
    error?: unknown;
    onRestore: () => void;
    onResubscribe?: () => void;
    onMarkDirectDirty?: () => void;
    onQueueExecution?: () => void;
  }): Promise<void> {
    const action: Action = () => {};
    const tx = { tx: {} } as IExtendedStorageTransaction;
    const commitPromise = Promise.resolve(
      { error: args.error } as Awaited<
        ReturnType<IExtendedStorageTransaction["commit"]>
      >,
    );
    watchReactiveActionCommit({
      action,
      tx,
      log: { reads: [], shallowReads: [], writes: [] },
      retries: args.retries ?? new WeakMap(),
      pending: new Set(),
      commitPromise,
      resubscribe: () => args.onResubscribe?.(),
      markDirectDirty: () => args.onMarkDirectDirty?.(),
      queueExecution: () => args.onQueueExecution?.(),
      restoreCfcTriggerReads: args.onRestore,
    });
    return commitPromise.then(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("restores trigger reads and re-queues a non-conflict retryable error", async () => {
    // Non-conflict, non-permanent errors keep their bounded retry: restore the
    // consumed trigger reads, resubscribe, and re-queue (dirty + pending + tick).
    let restored = 0;
    let queued = 0;
    await watchWith({
      error: new Error("transient"),
      onRestore: () => restored++,
      onQueueExecution: () => queued++,
    });
    expect(restored).toBe(1);
    expect(queued).toBe(1);
  });

  it("a commit conflict re-arms via resubscribe but does NOT re-queue", async () => {
    // #4210: a ConflictError is recovered by reader-dirty, not the retry budget.
    // The write that caused the conflict has already dirtied this action's
    // still-subscribed reads, so the scheduler re-runs it. The handler only
    // restores trigger reads and resubscribes — it does NOT re-queue (no
    // dirty/pending/tick). A `readyToRetry` on the error is irrelevant on this
    // path (the catch-up gate belonged to #4237's retry, which conflicts no
    // longer take).
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
      readyToRetry: () => Promise.resolve(),
    });
    const calls: string[] = [];
    await watchWith({
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkDirectDirty: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual(["restore", "resubscribe"]);
  });

  it("a commit conflict bypasses the retry budget (re-arms even when exhausted)", async () => {
    // A non-conflict error stops re-arming once the budget is exhausted (see
    // "does not restore when retries are exhausted"). A conflict must NOT: it is
    // recovered by reader-dirty regardless of the budget, so it always re-arms
    // (restore + resubscribe) and never falls into the exhausted-retries branch.
    const error = Object.assign(new Error("conflict"), {
      name: "ConflictError",
    });
    const retries = new WeakMap<Action, number>();
    retries.get = () => MAX_RETRIES_FOR_REACTIVE;
    const calls: string[] = [];
    await watchWith({
      retries,
      error,
      onRestore: () => calls.push("restore"),
      onResubscribe: () => calls.push("resubscribe"),
      onMarkDirectDirty: () => calls.push("dirty"),
      onQueueExecution: () => calls.push("queue"),
    });
    expect(calls).toEqual(["restore", "resubscribe"]);
  });

  it("requeues primitive retryable errors without retry readiness", async () => {
    let restored = 0;
    let queued = 0;
    await watchWith({
      error: "conflict",
      onRestore: () => restored++,
      onQueueExecution: () => queued++,
    });
    expect(restored).toBe(1);
    expect(queued).toBe(1);
  });

  it("does not restore on successful commit", async () => {
    let restored = 0;
    await watchWith({ onRestore: () => restored++ });
    expect(restored).toBe(0);
  });

  it("does not restore when retries are exhausted", async () => {
    let restored = 0;
    const retries = new WeakMap<Action, number>();
    // watchReactiveActionCommit reads retries via the action it was passed;
    // pre-load every lookup by stubbing get to simulate exhaustion.
    retries.get = () => MAX_RETRIES_FOR_REACTIVE;
    await watchWith({
      retries,
      error: new Error("conflict"),
      onRestore: () => restored++,
    });
    expect(restored).toBe(0);
  });
});

describe("unsubscribe clears pending trigger reads", () => {
  it("drops the pending set so re-subscriptions start clean", async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });
    try {
      const action: Action = () => {};
      runtime.scheduler.subscribe(
        action,
        { reads: [], shallowReads: [], writes: [] },
        { isEffect: true },
      );
      await runtime.idle();

      const scheduler = runtime.scheduler as unknown as {
        cfcTriggerReads: CfcTriggerReads;
      };
      const cfcTriggerReads = scheduler.cfcTriggerReads;
      cfcTriggerReads.set(action, {
        addresses: [{
          space,
          scope: "space",
          id: "of:stale",
          path: ["value"],
        }],
        keys: new Set(["stale-key"]),
      });

      runtime.scheduler.unsubscribe(action);

      expect(cfcTriggerReads.get(action)).toBeUndefined();
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
