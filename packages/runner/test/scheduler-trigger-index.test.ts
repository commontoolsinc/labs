import { describe, expect, it } from "./scheduler-test-utils.ts";
import {
  applyActionReadDelta,
  ensureCancelForActionTriggers,
  SchedulerTriggerIndex,
  SchedulerTriggerSubscriptions,
} from "../src/scheduler/trigger-index.ts";
import type { Action, ReactivityLog } from "../src/scheduler/types.ts";
import type { IMemorySpaceAddress } from "../src/storage/interface.ts";

describe("SchedulerTriggerIndex", () => {
  it("removes empty trigger entities when the last action unsubscribes", () => {
    const triggerIndex = new SchedulerTriggerIndex();
    const action: Action = () => {};
    const read: IMemorySpaceAddress = {
      space: "did:key:trigger-index-test",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };

    const { entities } = triggerIndex.addActionReads(action, [read], []);
    expect(triggerIndex.hasRegisteredTriggers()).toBe(true);

    triggerIndex.removeActionFromEntities(action, entities);

    expect(triggerIndex.hasRegisteredTriggers()).toBe(false);
    expect(triggerIndex.triggers.size).toBe(0);
    expect(triggerIndex.nonRecursiveTriggers.size).toBe(0);
  });

  it("removes all trigger entities for an unloaded space", () => {
    const triggerIndex = new SchedulerTriggerIndex();
    const firstAction: Action = () => {};
    const secondAction: Action = () => {};
    const firstRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-space-a",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const secondRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-space-b",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    triggerIndex.addActionReads(firstAction, [firstRead], []);
    triggerIndex.addActionReads(secondAction, [secondRead], []);

    triggerIndex.removeSpace("did:key:trigger-index-space-a");

    expect(triggerIndex.collectReadersForWrite(firstRead).size).toBe(0);
    expect(triggerIndex.collectReadersForWrite(secondRead).size).toBe(1);
    expect(triggerIndex.hasRegisteredTriggers()).toBe(true);
  });
});

describe("applyActionReadDelta", () => {
  const emptyLog: ReactivityLog = { reads: [], shallowReads: [], writes: [] };

  it("updates triggers when only the read scope changes", () => {
    const triggerIndex = new SchedulerTriggerIndex();
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels: new WeakMap(),
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const base = {
      space: "did:key:trigger-index-test",
      id: "of:cell",
      path: ["value"],
    } as const;
    const spaceRead = { ...base, scope: "space" } as IMemorySpaceAddress;
    const userRead = { ...base, scope: "user" } as IMemorySpaceAddress;
    const firstLog: ReactivityLog = {
      reads: [spaceRead],
      shallowReads: [],
      writes: [],
    };
    const secondLog: ReactivityLog = {
      reads: [userRead],
      shallowReads: [],
      writes: [],
    };

    applyActionReadDelta(state, action, emptyLog, firstLog);
    ensureCancelForActionTriggers(state, action);

    // Same space/id/path, different scope: must NOT be treated as unchanged.
    applyActionReadDelta(state, action, firstLog, secondLog);

    expect(triggerIndex.collectReadersForWrite(userRead).has(action)).toBe(
      true,
    );
    expect(triggerIndex.collectReadersForWrite(spaceRead).has(action)).toBe(
      false,
    );
  });

  it("keeps one cancel that removes the latest trigger entities", () => {
    const triggerIndex = new SchedulerTriggerIndex();
    const cancels = new WeakMap<Action, () => void>();
    const state = new SchedulerTriggerSubscriptions({
      triggerIndex,
      cancels,
      getActionId: () => "test-action",
    });
    const action: Action = () => {};
    const firstRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-cancel-a",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const secondRead: IMemorySpaceAddress = {
      space: "did:key:trigger-index-cancel-b",
      scope: "space",
      id: "of:cell",
      path: ["value"],
    };
    const firstLog: ReactivityLog = {
      reads: [firstRead],
      shallowReads: [],
      writes: [],
    };
    const secondLog: ReactivityLog = {
      reads: [secondRead],
      shallowReads: [],
      writes: [],
    };

    applyActionReadDelta(state, action, emptyLog, firstLog);
    ensureCancelForActionTriggers(state, action);
    const firstCancel = cancels.get(action);
    applyActionReadDelta(state, action, firstLog, secondLog);
    ensureCancelForActionTriggers(state, action);

    expect(cancels.get(action)).toBe(firstCancel);

    cancels.get(action)?.();

    expect(triggerIndex.collectReadersForWrite(firstRead).has(action)).toBe(
      false,
    );
    expect(triggerIndex.collectReadersForWrite(secondRead).has(action)).toBe(
      false,
    );
  });
});
