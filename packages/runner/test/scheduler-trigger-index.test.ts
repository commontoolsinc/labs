import { describe, expect, it } from "./scheduler-test-utils.ts";
import { SchedulerTriggerIndex } from "../src/scheduler/trigger-index.ts";
import type { Action } from "../src/scheduler/types.ts";
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
