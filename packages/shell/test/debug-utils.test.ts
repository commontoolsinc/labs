import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  summarizeDebugValue,
  summarizeTriggerTraceEntries,
} from "../src/lib/debug-utils.ts";
import type { TriggerTraceEntry } from "@commonfabric/runtime-client";

describe("debug utils", () => {
  it("summarizeDebugValue classifies common process/result shapes", () => {
    const summary = summarizeDebugValue({
      $NAME: "My Note",
      $TYPE: "notes/note",
      $UI: { children: [1, 2, 3] },
      internal: {
        allPieces: [],
        visiblePieces: [],
        mentionable: [],
      },
    });

    expect(summary.kind).toBe("object");
    expect(summary.name).toBe("My Note");
    expect(summary.type).toBe("notes/note");
    expect(summary.uiChildCount).toBe(3);
    expect(summary.looksLike).toContain("named-piece-output");
    expect(summary.looksLike).toContain("pattern-result");
    expect(summary.looksLike).toContain("ui-result");
    expect(summary.looksLike).toContain("runtime-process-cell");
    expect(summary.looksLike).toContain("default-app-or-home-state");
    expect(summary.looksLike).toContain("index-state");
  });

  it("summarizeTriggerTraceEntries groups by precise change key", () => {
    const trace: TriggerTraceEntry[] = [
      {
        recordedAt: 1,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 2,
        mode: "push",
        writerActionId: "writer:a",
        space: "did:key:space-a",
        entityId: "of:entity-a",
        path: [],
        before: { kind: "undefined" },
        after: { kind: "object", size: 2 },
        triggered: [
          {
            actionId: "action:a",
            actionType: "computation",
            mode: "push",
            decision: "schedule-push",
            pendingBefore: false,
            pendingAfter: true,
            dirtyBefore: false,
            dirtyAfter: false,
            scheduledEffects: [{
              actionId: "effect:a",
              pendingBefore: false,
              dirtyBefore: false,
            }],
          },
          {
            actionId: "action:b",
            actionType: "computation",
            mode: "push",
            decision: "schedule-push",
            pendingBefore: false,
            pendingAfter: true,
            dirtyBefore: false,
            dirtyAfter: false,
            scheduledEffects: [],
          },
        ],
      },
      {
        recordedAt: 2,
        notificationType: "commit",
        changeIndex: 2,
        matchedActionCount: 1,
        mode: "push",
        writerActionId: "writer:a",
        space: "did:key:space-a",
        entityId: "of:entity-a",
        path: [],
        before: { kind: "object", size: 2 },
        after: { kind: "object", size: 3 },
        triggered: [{
          actionId: "action:a",
          actionType: "computation",
          mode: "push",
          decision: "schedule-push",
          pendingBefore: false,
          pendingAfter: true,
          dirtyBefore: false,
          dirtyAfter: false,
          scheduledEffects: [],
        }],
      },
      {
        recordedAt: 3,
        notificationType: "commit",
        changeIndex: 1,
        matchedActionCount: 1,
        mode: "push",
        space: "did:key:space-a",
        entityId: "of:entity-b",
        path: ["internal", "count"],
        before: { kind: "number", preview: 1 },
        after: { kind: "number", preview: 2 },
        triggered: [{
          actionId: "action:c",
          actionType: "computation",
          mode: "push",
          decision: "schedule-push",
          pendingBefore: false,
          pendingAfter: true,
          dirtyBefore: false,
          dirtyAfter: false,
          scheduledEffects: [],
        }],
      },
    ];

    const summary = summarizeTriggerTraceEntries(trace, { limit: 5 });
    expect(summary.traceEntries).toBe(3);
    expect(summary.rootEntries).toBe(2);
    expect(summary.nestedEntries).toBe(1);
    expect(summary.pathLengthCounts).toEqual([[0, 2], [2, 1]]);
    expect(summary.topChanges[0]?.changeKey).toBe(
      "did:key:space-a/of:entity-a/",
    );
    expect(summary.topChanges[0]?.entryCount).toBe(2);
    expect(summary.topChanges[0]?.directSchedules).toBe(3);
    expect(summary.topChanges[0]?.downstreamSchedules).toBe(1);
    expect(summary.topChanges[0]?.writers).toEqual(["writer:a"]);
    expect(summary.topChanges[0]?.topDirectActions[0]).toEqual(["action:a", 2]);

    const rootOnly = summarizeTriggerTraceEntries(trace, {
      limit: 5,
      rootOnly: true,
    });
    expect(rootOnly.traceEntries).toBe(2);
    expect(rootOnly.nestedEntries).toBe(0);
    expect(rootOnly.topChanges).toHaveLength(1);
  });
});
