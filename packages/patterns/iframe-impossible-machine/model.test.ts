import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type {
  IframeStateData,
  MachineNode,
  MachineNodeKind,
  MachineParameters,
} from "./contract.ts";
import { evaluateSignals } from "./model.ts";

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

  it("returns zero for a graph cycle without an active source", () => {
    const state: IframeStateData = {
      nodes: [
        node("first", "transformer"),
        node("second", "transformer"),
      ],
      edges: [
        { id: "first-second", source: "first", target: "second" },
        { id: "second-first", source: "second", target: "first" },
      ],
    };

    expect(evaluateSignals(state, 0)).toEqual(
      new Map([
        ["first", 0],
        ["second", 0],
      ]),
    );
  });
});
