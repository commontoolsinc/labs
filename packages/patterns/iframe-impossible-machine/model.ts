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

/** Evaluates the machine at one logical tick without storing derived state. */
export function evaluateSignals(
  state: IframeStateData,
  tick: number,
): Map<string, number> {
  const nodes = new Map(state.nodes.map((node) => [node.id, node]));
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
    active: Set<string>,
  ): number => {
    if (atTick < 0) return 0;
    const memoKey = `${nodeId}@${atTick}`;
    const known = memo.get(memoKey);
    if (known !== undefined) return known;
    if (active.has(memoKey)) return 0;

    const node = nodes.get(nodeId);
    if (!node) return 0;
    const nextActive = new Set(active).add(memoKey);
    const sourceTick = node.kind === "delay"
      ? atTick - node.parameters.delaySteps
      : atTick;
    const inputs = (incoming.get(nodeId) ?? []).map((edge) =>
      evaluate(edge.source, sourceTick, nextActive)
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
          result = high === 1 ? 1 : 0;
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
      evaluate(node.id, tick, new Set()),
    ]),
  );
}
