import { describe, expect, it } from "./scheduler-test-utils.ts";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import { SchedulerTriggerIndex } from "../src/scheduler/trigger-index.ts";
import {
  markInvalid,
  type StorageNotificationState,
} from "../src/scheduler/notifications.ts";
import { processPullStorageNotification } from "../src/scheduler/pull-notifications.ts";
import { watchReactiveActionCommit } from "../src/scheduler/action-run.ts";
import { MAX_RETRIES_FOR_REACTIVE } from "../src/scheduler/constants.ts";
import { NodeRegistry } from "../src/scheduler/node-record.ts";
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

describe("invalid cause dedup keys", () => {
  it("keeps addresses distinct across scope and ambiguous path joins", () => {
    const action: Action = () => {};
    const nodes = new NodeRegistry();
    const record = nodes.register(action, "effect");

    // Distinct path arrays that a naive join("/") would collapse.
    markInvalid(
      nodes,
      action,
      { ...makeChange({ id: "of:cell", path: ["a", "b"] }).address, space },
    );
    markInvalid(
      nodes,
      action,
      { ...makeChange({ id: "of:cell", path: ["a/b"] }).address, space },
    );
    // Same space/id/path in a different scope is a distinct trigger entity.
    markInvalid(
      nodes,
      action,
      {
        ...makeChange({ id: "of:cell", path: ["a", "b"], scope: "user" })
          .address,
        space,
      },
    );
    // Exact duplicate (scope omitted ≡ scope "space") dedups.
    markInvalid(
      nodes,
      action,
      {
        ...makeChange({ id: "of:cell", path: ["a", "b"], scope: "space" })
          .address,
        space,
      },
    );

    expect(record.invalidCauses.length).toBe(3);
  });
});

function makeNotificationState(args: {
  action: Action;
  triggerIndex: SchedulerTriggerIndex;
  actionChangeGroups?: WeakMap<Action, ChangeGroup>;
}): StorageNotificationState {
  const nodes = new NodeRegistry();
  nodes.register(args.action, "effect");
  return {
    triggerIndex: args.triggerIndex,
    nodes,
    getDiagnosisEnabled: () => false,
    getCollectTriggerTrace: () => false,
    changeGroupToActionId: new Map(),
    recordCausalEdge: () => {},
    actionChangeGroups: args.actionChangeGroups ?? new WeakMap(),
    effects: new Set([args.action]),
    pending: new Set(),
    getActionId: () => "test-action",
    recordCellUpdate: () => {},
    recordTriggerTrace: () => {},
    scheduleWithDebounce: () => {},
    markInvalid: (action, cause) => {
      markInvalid(nodes, action, cause);
    },
    isInvalid: (action) => {
      const record = nodes.get(action);
      return record?.status === "invalid" || record?.status === "never-ran";
    },
    materializerIndex: {
      materializersByEntity: new Map(),
      effects: new Set(),
      getMaterializerWriteEnvelopes: () => undefined,
      isMaterializer: () => false,
    },
    queueExecution: () => {},
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

      expect(state.nodes.get(action)?.invalidCauses.length).toBe(0);
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

      expect(state.nodes.get(action)?.invalidCauses.length).toBe(0);
    });

    it(`${mode}: a scheduling change records the trigger read`, () => {
      const action: Action = () => {};
      const state = makeNotificationState({
        action,
        triggerIndex: makeTriggerIndexFor(action),
      });

      process(state, makeCommitNotification({} as IStorageTransaction));

      const causes = state.nodes.get(action)?.invalidCauses;
      expect(causes).toBeDefined();
      expect(causes!.length).toBe(1);
      expect(causes![0]).toMatchObject({
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
      resubscribe: () => {},
      markInvalid: () => {},
      queueExecution: () => {},
      restoreInvalidCauses: args.onRestore,
    });
    return commitPromise.then(() => undefined);
  }

  it("restores consumed trigger reads when a commit conflict re-runs", async () => {
    let restored = 0;
    await watchWith({
      error: new Error("conflict"),
      onRestore: () => restored++,
    });
    expect(restored).toBe(1);
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

      const nodes = (runtime.scheduler as unknown as {
        nodes: NodeRegistry;
      }).nodes;
      const record = nodes.get(action);
      expect(record).toBeDefined();
      record!.invalidCauses = [{
        space,
        scope: "space",
        id: "of:stale",
        path: ["value"],
      }];

      runtime.scheduler.unsubscribe(action);

      expect(record!.invalidCauses.length).toBe(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
