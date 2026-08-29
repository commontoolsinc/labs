import {
  type IframeStateData,
  type MachineEdge,
  machineEdgeId,
  type MachineNode,
} from "./contract.ts";

function clampSignal(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export interface SignalPresentation {
  semantic: number;
  label: string;
  highlighted: boolean;
}

/** Keeps signal meaning independent from the user's presentation preference. */
export function presentSignal(
  signal: number,
  showSignals: boolean,
): SignalPresentation {
  const semantic = clampSignal(signal);
  return {
    semantic,
    label: showSignals ? `${Math.round(semantic * 100)}%` : "Hidden",
    highlighted: showSignals && semantic >= 0.5,
  };
}

export function isActuatorFiring(node: MachineNode, signal: number): boolean {
  return node.kind === "actuator" && signal >= node.parameters.threshold;
}

/** Canonicalizes legacy and concurrent duplicate wires by logical endpoints. */
export function dedupeMachineEdges(
  edges: readonly MachineEdge[],
): MachineEdge[] {
  const unique = new Map<string, MachineEdge>();
  for (const edge of edges) {
    const id = machineEdgeId(edge.source, edge.target);
    if (!unique.has(id)) {
      unique.set(id, { id, source: edge.source, target: edge.target });
    }
  }
  return [...unique.values()];
}

function outgoingNodes(
  edges: readonly MachineEdge[],
): Map<string, Set<string>> {
  const outgoing = new Map<string, Set<string>>();
  for (const edge of dedupeMachineEdges(edges)) {
    const targets = outgoing.get(edge.source) ?? new Set<string>();
    targets.add(edge.target);
    outgoing.set(edge.source, targets);
  }
  return outgoing;
}

function canReach(
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  start: string,
  target: string,
): boolean {
  const pending = [...(outgoing.get(start) ?? [])];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(outgoing.get(current) ?? []));
  }
  return false;
}

/** Returns every module participating in a stored feedback loop. */
export function findFeedbackNodeIds(
  edges: readonly MachineEdge[],
): Set<string> {
  const outgoing = outgoingNodes(edges);
  const nodeIds = new Set<string>();
  for (const edge of dedupeMachineEdges(edges)) {
    nodeIds.add(edge.source);
    nodeIds.add(edge.target);
  }
  return new Set(
    [...nodeIds].filter((nodeId) => canReach(outgoing, nodeId, nodeId)),
  );
}

/** Checks whether one proposed directed wire would introduce feedback. */
export function createsFeedbackCycle(
  edges: readonly MachineEdge[],
  source: string,
  target: string,
): boolean {
  if (source === target) return true;
  return canReach(outgoingNodes(edges), target, source);
}

/** Evaluates the machine at one logical tick without storing derived state. */
export function evaluateSignals(
  state: IframeStateData,
  tick: number,
): Map<string, number> {
  const nodes = new Map(state.nodes.map((node) => [node.id, node]));
  const feedbackNodeIds = findFeedbackNodeIds(state.edges);
  const incoming = new Map<string, MachineEdge[]>();
  for (const edge of dedupeMachineEdges(state.edges)) {
    const edges = incoming.get(edge.target) ?? [];
    edges.push(edge);
    incoming.set(edge.target, edges);
  }
  const memo = new Map<string, number>();

  const evaluate = (
    nodeId: string,
    atTick: number,
  ): number => {
    if (atTick < 0) return 0;
    if (feedbackNodeIds.has(nodeId)) return 0;
    const memoKey = `${nodeId}@${atTick}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;

    const node = nodes.get(nodeId);
    if (!node) return 0;
    const sourceTick = node.kind === "delay"
      ? atTick - node.parameters.delaySteps
      : atTick;
    const inputs = (incoming.get(nodeId) ?? []).map((edge) =>
      evaluate(edge.source, sourceTick)
    );

    let result: number;
    switch (node.kind) {
      case "sensor":
        result = node.parameters.active ? node.parameters.strength : 0;
        break;
      case "gate": {
        const high = inputs.filter((value) => value >= 0.5).length;
        if (node.parameters.operator === "and") {
          result = inputs.length > 0 && high === inputs.length ? 1 : 0;
        } else if (node.parameters.operator === "or") {
          result = high > 0 ? 1 : 0;
        } else {
          result = high % 2 === 1 ? 1 : 0;
        }
        break;
      }
      case "delay":
        result = inputs.length === 0 ? 0 : Math.max(...inputs);
        break;
      case "transformer":
        result = clampSignal(
          average(inputs) * node.parameters.gain + node.parameters.offset,
        );
        break;
      case "actuator": {
        const received = inputs.length === 0 ? 0 : Math.max(...inputs);
        result = received >= node.parameters.threshold ? received : 0;
        break;
      }
    }
    result = clampSignal(result);
    memo.set(memoKey, result);
    return result;
  };

  return new Map(
    state.nodes.map((node: MachineNode) => [
      node.id,
      evaluate(node.id, tick),
    ]),
  );
}
