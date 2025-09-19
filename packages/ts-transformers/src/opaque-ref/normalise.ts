import ts from "typescript";

import type { DataFlowGraph, DataFlowNode } from "./dataflow.ts";

export interface NormalisedDataFlow {
  readonly canonicalKey: string;
  readonly expression: ts.Expression;
  readonly occurrences: readonly DataFlowNode[];
  readonly scopeId: number;
}

export interface NormalisedDataFlowSet {
  readonly all: readonly NormalisedDataFlow[];
  readonly byCanonicalKey: ReadonlyMap<string, NormalisedDataFlow>;
}

export function normaliseDataFlows(
  graph: DataFlowGraph,
): NormalisedDataFlowSet {
  const nodesById = new Map<number, DataFlowNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);

  const grouped = new Map<string, {
    expression: ts.Expression;
    nodes: DataFlowNode[];
    scopeId: number;
  }>();
  const nodeToGroup = new Map<number, string>();

  const normaliseExpression = (node: DataFlowNode): ts.Expression => {
    let current: ts.Expression = node.expression;

    while (true) {
      if (ts.isPropertyAccessExpression(current)) {
        if (
          ts.isCallExpression(current.parent) &&
          current.parent.expression === current
        ) {
          current = current.expression;
          continue;
        }
        if (ts.isIdentifier(current.name) && current.name.text === "length") {
          current = current.expression;
          continue;
        }
      }

      if (ts.isElementAccessExpression(current)) {
        const argument = current.argumentExpression;
        if (argument && ts.isExpression(argument)) {
          if (
            ts.isLiteralExpression(argument) ||
            ts.isNoSubstitutionTemplateLiteral(argument)
          ) {
            current = current.expression;
            continue;
          }
        }
        if (
          ts.isCallExpression(current.parent) &&
          current.parent.expression === current
        ) {
          current = current.expression;
          continue;
        }
      }

      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (
          ts.isPropertyAccessExpression(callee) ||
          ts.isElementAccessExpression(callee)
        ) {
          current = callee.expression;
          continue;
        }
      }

      break;
    }

    return current;
  };

  for (const node of graph.nodes) {
    const expression = normaliseExpression(node);
    const sourceFile = expression.getSourceFile();
    const key = `${node.scopeId}:${expression.getText(sourceFile)}`;
    let group = grouped.get(key);
    if (!group) {
      group = {
        expression,
        nodes: [],
        scopeId: node.scopeId,
      };
      grouped.set(key, group);
    }
    group.nodes.push(node);
    nodeToGroup.set(node.id, key);
  }

  const suppressed = new Set<string>();

  for (const [canonicalKey, group] of grouped.entries()) {
    for (const node of group.nodes) {
      let currentParent = node.parentId;
      while (currentParent !== null) {
        const parentGroupKey = nodeToGroup.get(currentParent);
        if (parentGroupKey && parentGroupKey !== canonicalKey) {
          suppressed.add(parentGroupKey);
        }
        currentParent = nodesById.get(currentParent)?.parentId ?? null;
      }
    }
  }

  const filtered = Array.from(grouped.entries())
    .filter(([canonicalKey]) => !suppressed.has(canonicalKey));

  const all: NormalisedDataFlow[] = filtered.map(([canonicalKey, value]) => ({
    canonicalKey,
    expression: value.expression,
    occurrences: value.nodes,
    scopeId: value.scopeId,
  })).sort((a, b) => {
    const aId = a.occurrences[0]?.id ?? -1;
    const bId = b.occurrences[0]?.id ?? -1;
    return aId - bId;
  });

  return {
    all,
    byCanonicalKey: new Map(all.map((dependency) => [
      dependency.canonicalKey,
      dependency,
    ])),
  };
}

const isWithin = (outer: ts.Node, inner: ts.Node): boolean => {
  return inner.pos >= outer.pos && inner.end <= outer.end;
};

export function selectDataFlowsWithin(
  set: NormalisedDataFlowSet,
  node: ts.Node,
): NormalisedDataFlow[] {
  return set.all.filter((dataFlow) =>
    dataFlow.occurrences.some((occurrence) =>
      isWithin(node, occurrence.expression)
    )
  );
}
