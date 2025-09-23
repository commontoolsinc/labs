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
  requestedDataFlows?: ts.Expression[],
): NormalisedDataFlowSet {
  const nodesById = new Map<number, DataFlowNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);

  // If specific dataFlows were requested, only process nodes corresponding to those expressions
  // This prevents suppressing nodes that are explicitly needed as dependencies
  let nodesToProcess = graph.nodes;
  if (requestedDataFlows && requestedDataFlows.length > 0) {
    const requestedTexts = new Set(
      requestedDataFlows.map((expr) => expr.getText(expr.getSourceFile())),
    );
    nodesToProcess = graph.nodes.filter((node) =>
      requestedTexts.has(
        node.expression.getText(node.expression.getSourceFile()),
      )
    );
  }

  const grouped = new Map<string, {
    expression: ts.Expression;
    nodes: DataFlowNode[];
    scopeId: number;
  }>();
  const nodeToGroup = new Map<number, string>();

  const normaliseExpression = (node: DataFlowNode): ts.Expression => {
    let current: ts.Expression = node.expression;

    // Only normalize away truly meaningless wrappers that don't change semantics
    while (true) {
      // Remove parentheses - purely syntactic, no semantic difference
      if (ts.isParenthesizedExpression(current)) {
        current = current.expression;
        continue;
      }

      // Remove type assertions - don't affect runtime behavior
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current)) {
        current = current.expression;
        continue;
      }

      // Remove non-null assertions - don't affect runtime behavior
      if (ts.isNonNullExpression(current)) {
        current = current.expression;
        continue;
      }

      // Special case: for method calls like obj.method(), we need to normalize
      // back to the object so the transformation can wrap it properly
      // e.g., state.user.name.toUpperCase() -> state.user.name
      if (ts.isCallExpression(current)) {
        const callee = current.expression;
        if (ts.isPropertyAccessExpression(callee)) {
          // This is a method call - normalize to the object
          current = callee.expression;
          continue;
        }
      }

      // Also handle property access when it's being called as a method
      // e.g., when we see state.user.name.toUpperCase (without the call),
      // but it's the callee of a call expression
      if (ts.isPropertyAccessExpression(current)) {
        if (
          current.parent &&
          ts.isCallExpression(current.parent) &&
          current.parent.expression === current
        ) {
          // This property is being called as a method
          current = current.expression;
          continue;
        }
      }

      // That's it! Keep all other meaningful distinctions:
      // - state.items vs state.items.length (different reactive dependencies)
      // - array[0] vs array (different values)
      break;
    }

    return current;
  };

  for (const node of nodesToProcess) {
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

  // Parent suppression: suppress parents that have more specific children
  // BUT: If we're working with explicitly requested dataFlows, don't suppress any of them
  // They were all explicitly requested as dependencies
  if (!requestedDataFlows || requestedDataFlows.length === 0) {
    for (const [canonicalKey, group] of grouped.entries()) {
      // Check if any node in this group has an explicit child
      // If so, this parent should be suppressed in favor of the more specific child
      for (const node of group.nodes) {
        let hasExplicitChild = false;

        // Check all nodes to see if any child is explicit
        for (const potentialChild of graph.nodes) {
          if (
            potentialChild.parentId === node.id && potentialChild.isExplicit
          ) {
            hasExplicitChild = true;
            break;
          }
        }

        if (hasExplicitChild) {
          suppressed.add(canonicalKey);
          break;
        }
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
