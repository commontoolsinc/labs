export interface CfcVerifierDelegation {
  readonly delegator: string;
  readonly verifier: string;
  readonly scope?: {
    readonly concepts?: readonly string[];
  };
}

export interface CfcTrustStatement {
  readonly verifier: string;
  readonly concrete: string;
  readonly concept: string;
}

export interface CfcTrustConceptEdge {
  readonly from: string;
  readonly to: string;
}

export interface CfcTrustContext {
  readonly delegations?: readonly CfcVerifierDelegation[];
  readonly statements?: readonly CfcTrustStatement[];
  readonly conceptEdges?: readonly CfcTrustConceptEdge[];
}

export interface CfcIntegrityTrustOptions {
  readonly actingPrincipal?: string;
  readonly trustContext?: CfcTrustContext;
}

function delegationAllowsConcept(
  delegation: CfcVerifierDelegation,
  actingPrincipal: string,
  verifier: string,
  concept: string,
): boolean {
  if (
    delegation.delegator !== actingPrincipal || delegation.verifier !== verifier
  ) {
    return false;
  }
  const concepts = delegation.scope?.concepts;
  if (!concepts || concepts.length === 0) {
    return false;
  }
  return concepts.includes("*") || concepts.includes(concept);
}

function trustedEdgesForActingPrincipal(
  actingPrincipal: string | undefined,
  trustContext: CfcTrustContext | undefined,
): readonly CfcTrustConceptEdge[] {
  if (!actingPrincipal || !trustContext) {
    return [];
  }

  const statementEdges = (trustContext.statements ?? [])
    .filter((statement) =>
      (trustContext.delegations ?? []).some((delegation) =>
        delegationAllowsConcept(
          delegation,
          actingPrincipal,
          statement.verifier,
          statement.concept,
        )
      )
    )
    .map((statement) => ({
      from: statement.concrete,
      to: statement.concept,
    }));

  return [...statementEdges, ...(trustContext.conceptEdges ?? [])];
}

function reachesConcept(
  start: string,
  target: string,
  edges: readonly CfcTrustConceptEdge[],
): boolean {
  if (start === target) {
    return true;
  }

  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    const next = adjacency.get(edge.from);
    if (next) {
      next.push(edge.to);
    } else {
      adjacency.set(edge.from, [edge.to]);
    }
  }

  const visited = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of adjacency.get(current) ?? []) {
      if (next === target) {
        return true;
      }
      if (visited.has(next)) {
        continue;
      }
      visited.add(next);
      queue.push(next);
    }
  }

  return false;
}

export function integritySatisfiesRequiredIntegrity(
  actualIntegrity: readonly string[] | undefined,
  requiredIntegrity: readonly string[],
  options: CfcIntegrityTrustOptions = {},
): boolean {
  if (requiredIntegrity.length === 0) {
    return true;
  }
  if (!actualIntegrity || actualIntegrity.length === 0) {
    return false;
  }

  const actualSet = new Set(actualIntegrity);
  const trustedEdges = trustedEdgesForActingPrincipal(
    options.actingPrincipal,
    options.trustContext,
  );

  return requiredIntegrity.every((requirement) => {
    if (actualSet.has(requirement)) {
      return true;
    }
    return actualIntegrity.some((actual) =>
      reachesConcept(actual, requirement, trustedEdges)
    );
  });
}
