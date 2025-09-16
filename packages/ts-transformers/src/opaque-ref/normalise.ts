import type ts from "typescript";

import type { DependencyNode, OpaqueDependencyGraph } from "./dependency.ts";

export interface NormalisedDependency {
  readonly canonicalKey: string;
  readonly expression: ts.Expression;
  readonly occurrences: readonly DependencyNode[];
  readonly scopeId: number;
}

export interface NormalisedDependencySet {
  readonly all: readonly NormalisedDependency[];
  readonly byCanonicalKey: ReadonlyMap<string, NormalisedDependency>;
}

export function normaliseDependencies(
  graph: OpaqueDependencyGraph,
): NormalisedDependencySet {
  const nodesById = new Map<number, DependencyNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);

  const grouped = new Map<string, {
    expression: ts.Expression;
    nodes: DependencyNode[];
    scopeId: number;
  }>();
  const nodeToGroup = new Map<number, string>();

  for (const node of graph.nodes) {
    const existing = grouped.get(node.canonicalKey);
    if (existing) {
      existing.nodes.push(node);
      nodeToGroup.set(node.id, node.canonicalKey);
      continue;
    }
    grouped.set(node.canonicalKey, {
      expression: node.expression,
      nodes: [node],
      scopeId: node.scopeId,
    });
    nodeToGroup.set(node.id, node.canonicalKey);
  }

  const suppressed = new Set<string>();

  for (const group of grouped.values()) {
    for (const node of group.nodes) {
      let currentParent = node.parentId;
      while (currentParent !== null) {
        const parentGroupKey = nodeToGroup.get(currentParent);
        if (parentGroupKey) {
          suppressed.add(parentGroupKey);
        }
        currentParent = nodesById.get(currentParent)?.parentId ?? null;
      }
    }
  }

  const filtered = Array.from(grouped.entries())
    .filter(([canonicalKey]) => !suppressed.has(canonicalKey));

  const all: NormalisedDependency[] = filtered.map(([canonicalKey, value]) => ({
    canonicalKey,
    expression: value.expression,
    occurrences: value.nodes,
    scopeId: value.scopeId,
  })).sort((a, b) => a.occurrences[0].id - b.occurrences[0].id);

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

export function selectDependenciesWithin(
  set: NormalisedDependencySet,
  node: ts.Node,
): NormalisedDependency[] {
  return set.all.filter((dependency) =>
    dependency.occurrences.some((occurrence) =>
      isWithin(node, occurrence.expression)
    )
  );
}
