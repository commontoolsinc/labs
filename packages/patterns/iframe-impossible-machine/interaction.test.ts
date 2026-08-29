import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  createActionRunner,
  createSelectionRequestTracker,
  errorFrom,
  NODE_CONTROL_BOUNDARY_PROPS,
  NodeControls,
  settleCommittedPositionDraft,
  stopNodeControlPropagation,
} from "./interaction.ts";

describe("Impossible Machine interaction lifecycle", () => {
  it("stops embedded controls at the node boundary", () => {
    let stopped = false;
    stopNodeControlPropagation({ stopPropagation: () => stopped = true });

    expect(stopped).toBe(true);
    expect(NODE_CONTROL_BOUNDARY_PROPS.className).toBe(
      "node-parameters nodrag nopan",
    );
    expect(NODE_CONTROL_BOUNDARY_PROPS.onClick).toBe(
      stopNodeControlPropagation,
    );
    const element = NodeControls({ children: "Operator" });
    expect(element.props).toEqual({
      ...NODE_CONTROL_BOUNDARY_PROPS,
      children: "Operator",
    });
  });

  it("clears only the position draft acknowledged by a write", () => {
    const newer = { x: 24, y: 18 };
    const ref = { current: { gate: newer } };
    let rendered: Record<string, typeof newer> = { gate: newer };
    const setRendered = (
      update: (current: typeof rendered) => typeof rendered,
    ) => rendered = update(rendered);

    settleCommittedPositionDraft(ref, setRendered, "gate", { x: 12, y: 9 });
    expect(ref.current).toEqual({ gate: newer });
    expect(rendered).toEqual({ gate: newer });

    settleCommittedPositionDraft(ref, setRendered, "gate", newer);
    expect(ref.current).toEqual({});
    expect(rendered).toEqual({});
  });

  it("orders actions while keeping node pending state local", async () => {
    let globalPending = false;
    let actionError: Error | undefined;
    let busyNodes: Readonly<Record<string, number>> = {};
    const runner = createActionRunner({
      setGlobalPending: (value) => globalPending = value,
      setActionError: (value) => actionError = value,
      setBusyNodeCounts: (update) => busyNodes = update(busyNodes),
    });
    const order: string[] = [];
    let releaseNode!: () => void;
    const nodeGate = new Promise<void>((resolve) => releaseNode = resolve);

    const nodeAction = runner.runNode("gate", async () => {
      order.push("node:start");
      await nodeGate;
      order.push("node:end");
    });
    const globalAction = runner.run(() => {
      order.push("global");
      return Promise.reject("visible failure");
    });

    await Promise.resolve();
    expect(globalPending).toBe(false);
    expect(busyNodes).toEqual({ gate: 1 });
    expect(order).toEqual(["node:start"]);

    releaseNode();
    await nodeAction;
    await globalAction;

    expect(order).toEqual(["node:start", "node:end", "global"]);
    expect(globalPending).toBe(false);
    expect(busyNodes).toEqual({});
    expect(actionError).toEqual(new Error("visible failure"));
    expect(errorFrom(new Error("same"))).toEqual(new Error("same"));
  });

  it("retains the latest rapid selection request", async () => {
    const tracker = createSelectionRequestTracker("node-a");
    const writes: string[] = [];
    let releaseNodeB!: () => void;
    const nodeBGate = new Promise<void>((resolve) => releaseNodeB = resolve);
    const writeSelection = (nodeId: string) => {
      writes.push(nodeId);
      return nodeId === "node-b" ? nodeBGate : Promise.resolve();
    };

    const duplicate = tracker.request("node-a", writeSelection);
    const nodeB = tracker.request("node-b", writeSelection);
    tracker.reconcile("node-b");
    const nodeA = tracker.request("node-a", writeSelection);

    expect(writes).toEqual(["node-b", "node-a"]);
    releaseNodeB();
    await Promise.all([duplicate, nodeB, nodeA]);

    tracker.reconcile("node-a");
    await tracker.request("node-a", writeSelection);
    expect(writes).toEqual(["node-b", "node-a"]);
  });
});
