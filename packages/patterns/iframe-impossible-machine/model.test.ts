import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { machineEdgeId } from "./contract.ts";
import type {
  IframeStateData,
  MachineNode,
  MachineNodeKind,
  MachineParameters,
} from "./contract.ts";
import {
  createsFeedbackCycle,
  dedupeMachineEdges,
  evaluateSignals,
  findFeedbackNodeIds,
  isActuatorFiring,
  presentSignal,
} from "./model.ts";

const PARAMETERS: MachineParameters = {
  active: false,
  strength: 1,
  operator: "and",
  delaySteps: 1,
  gain: 1,
  offset: 0,
  threshold: 0.5,
};

function node(
  id: string,
  kind: MachineNodeKind,
  parameters: Partial<MachineParameters> = {},
): MachineNode {
  return {
    id,
    kind,
    label: id,
    position: { x: 0, y: 0 },
    parameters: { ...PARAMETERS, ...parameters },
  };
}

describe("evaluateSignals()", () => {
  it("returns a delayed sensor signal only after the configured tick", () => {
    const state: IframeStateData = {
      nodes: [
        node("sensor", "sensor", { active: true, strength: 0.8 }),
        node("delay", "delay", { delaySteps: 2 }),
      ],
      edges: [{ id: "wire", source: "sensor", target: "delay" }],
    };

    expect(evaluateSignals(state, 1).get("delay")).toBe(0);
    expect(evaluateSignals(state, 2).get("delay")).toBe(0.8);
  });

  it("applies each gate operator to the same incoming signals", () => {
    const base: IframeStateData = {
      nodes: [
        node("high", "sensor", { active: true }),
        node("low", "sensor", { active: false }),
        node("gate", "gate", { operator: "xor" }),
      ],
      edges: [
        { id: "high-gate", source: "high", target: "gate" },
        { id: "low-gate", source: "low", target: "gate" },
      ],
    };

    expect(evaluateSignals(base, 0).get("gate")).toBe(1);
    const andState = structuredClone(base);
    andState.nodes[2].parameters.operator = "and";
    expect(evaluateSignals(andState, 0).get("gate")).toBe(0);
    const orState = structuredClone(base);
    orState.nodes[2].parameters.operator = "or";
    expect(evaluateSignals(orState, 0).get("gate")).toBe(1);
  });

  it("uses odd parity for XOR gates with more than two inputs", () => {
    const state: IframeStateData = {
      nodes: [
        node("first", "sensor", { active: true }),
        node("second", "sensor", { active: true }),
        node("third", "sensor", { active: true }),
        node("fourth", "sensor", { active: true }),
        node("gate", "gate", { operator: "xor" }),
      ],
      edges: [
        { id: "first-gate", source: "first", target: "gate" },
        { id: "second-gate", source: "second", target: "gate" },
        { id: "third-gate", source: "third", target: "gate" },
      ],
    };

    expect(evaluateSignals(state, 0).get("gate")).toBe(1);
    state.edges.push({ id: "fourth-gate", source: "fourth", target: "gate" });
    expect(evaluateSignals(state, 0).get("gate")).toBe(0);
  });

  it("clamps transformed signals and applies actuator thresholds", () => {
    const state: IframeStateData = {
      nodes: [
        node("sensor", "sensor", { active: true, strength: 0.7 }),
        node("transformer", "transformer", { gain: 2, offset: 0.1 }),
        node("actuator", "actuator", { threshold: 0.9 }),
      ],
      edges: [
        { id: "sensor-transformer", source: "sensor", target: "transformer" },
        {
          id: "transformer-actuator",
          source: "transformer",
          target: "actuator",
        },
      ],
    };

    expect(evaluateSignals(state, 0).get("transformer")).toBe(1);
    expect(evaluateSignals(state, 0).get("actuator")).toBe(1);
  });

  it("makes feedback loops inert independently of node order", () => {
    const state: IframeStateData = {
      nodes: [
        node("first", "transformer", { offset: 0.2 }),
        node("second", "transformer", { offset: 0.3 }),
      ],
      edges: [
        { id: "first-second", source: "first", target: "second" },
        { id: "second-first", source: "second", target: "first" },
      ],
    };

    const forward = evaluateSignals(state, 0);
    const reversed = evaluateSignals(
      { ...state, nodes: [...state.nodes].reverse() },
      0,
    );

    expect(forward).toEqual(
      new Map([
        ["first", 0],
        ["second", 0],
      ]),
    );
    expect(Object.fromEntries(reversed)).toEqual(Object.fromEntries(forward));
    expect(findFeedbackNodeIds(state.edges)).toEqual(
      new Set(["first", "second"]),
    );
    expect(createsFeedbackCycle(state.edges.slice(0, 1), "second", "first"))
      .toBe(true);
  });

  it("hides signal presentation without changing actuator semantics", () => {
    const actuator = node("actuator", "actuator", { threshold: 0.7 });

    expect(presentSignal(0.9, false)).toEqual({
      semantic: 0.9,
      label: "Hidden",
      highlighted: false,
    });
    expect(isActuatorFiring(actuator, presentSignal(0.9, false).semantic))
      .toBe(true);
  });

  it("treats concurrent wires with the same endpoints as one input", () => {
    const state: IframeStateData = {
      nodes: [
        node("source", "sensor", { active: true }),
        node("gate", "gate", { operator: "xor" }),
      ],
      edges: [
        { id: "client-a", source: "source", target: "gate" },
        { id: "client-b", source: "source", target: "gate" },
      ],
    };

    expect(evaluateSignals(state, 0).get("gate")).toBe(1);
    expect(dedupeMachineEdges(state.edges)).toEqual([
      {
        id: machineEdgeId("source", "gate"),
        source: "source",
        target: "gate",
      },
    ]);
  });
});
