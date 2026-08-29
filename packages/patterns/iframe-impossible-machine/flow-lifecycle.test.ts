/** Exercises React Flow state that exists only for one browser gesture. */

import type { Node, NodeChange } from "@xyflow/react";
import { applyNodeChanges } from "@xyflow/react";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  applyCollaborativeNodeChanges,
  reconcileCollaborativeNodes,
  settlePositionDraft,
} from "./flow-lifecycle.ts";

type TestNode = Node<Record<string, never>>;

describe("applyCollaborativeNodeChanges()", () => {
  it("retains drag state and untouched node identity", () => {
    const dragged: TestNode = {
      id: "dragged",
      position: { x: 0, y: 0 },
      data: {},
    };
    const untouched: TestNode = {
      id: "untouched",
      position: { x: 20, y: 20 },
      data: {},
    };
    const changes: NodeChange<TestNode>[] = [{
      id: dragged.id,
      type: "position",
      position: { x: 12, y: 8 },
      dragging: true,
    }];
    const draftsRef = { current: {} };

    const result = applyCollaborativeNodeChanges(
      changes,
      [dragged, untouched],
      draftsRef,
      applyNodeChanges,
    );

    expect(result[0]?.position).toEqual({ x: 12, y: 8 });
    expect(result[0]?.dragging).toBe(true);
    expect(result[1]).toBe(untouched);
    expect(draftsRef.current).toEqual({ dragged: { x: 12, y: 8 } });
  });

  it("reconciles durable data without displacing an active drag", () => {
    const current: TestNode = {
      id: "gate",
      position: { x: 30, y: 18 },
      dragging: true,
      data: {},
    };
    const authoritative: TestNode = {
      id: "gate",
      position: { x: 4, y: 6 },
      selected: true,
      data: {},
    };

    const result = reconcileCollaborativeNodes(
      [current],
      [authoritative],
      { gate: current.position },
    );

    expect(result[0]?.position).toEqual(current.position);
    expect(result[0]?.dragging).toBe(true);
    expect(result[0]?.selected).toBe(true);
  });

  it("clears only the position draft acknowledged by a write", () => {
    const draftsRef = { current: { gate: { x: 30, y: 18 } } };

    expect(settlePositionDraft(draftsRef, "gate", { x: 12, y: 9 })).toBe(
      false,
    );
    expect(draftsRef.current).toEqual({ gate: { x: 30, y: 18 } });

    expect(settlePositionDraft(draftsRef, "gate", { x: 30, y: 18 })).toBe(
      true,
    );
    expect(draftsRef.current).toEqual({});
  });
});
