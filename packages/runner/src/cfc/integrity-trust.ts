import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import { toHex } from "./shared.ts";
import type { CfcImplementationIdentity } from "./implementation-identity.ts";
import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import {
  type CfcAtom,
  type CfcIntegrityLabel,
  normalizeIntegrityLabel,
} from "./label-algebra.ts";

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

export interface CfcTrustContextSnapshot {
  readonly actingPrincipal: string | null;
  readonly delegations: readonly {
    readonly delegator: string;
    readonly verifier: string;
    readonly concepts: readonly string[];
  }[];
  readonly statements: readonly {
    readonly verifier: string;
    readonly concrete: string;
    readonly concept: string;
  }[];
  readonly conceptEdges: readonly {
    readonly from: string;
    readonly to: string;
  }[];
}

export interface CfcPrepareScope {
  readonly implementationIdentity?: CfcImplementationIdentity;
  readonly actingPrincipal?: string;
  readonly trustContext?: CfcTrustContext;
  readonly executionIntegrity?: CfcIntegrityLabel;
}

export type CfcPrepareScopeOverrides = Partial<CfcPrepareScope>;

export type CfcTrustContextSource =
  | CfcTrustContext
  | (() => CfcTrustContext | undefined);

export type CfcExecutionIntegritySource =
  | CfcIntegrityLabel
  | (() => CfcIntegrityLabel | undefined);

export interface CfcIntegrityTrustOptions {
  readonly actingPrincipal?: string;
  readonly trustContext?: CfcTrustContext;
}

export function resolveCfcTrustContextSnapshot(
  source: CfcTrustContextSource | undefined,
): CfcTrustContext | undefined {
  const trustContext = typeof source === "function" ? source() : source;
  if (!trustContext) {
    return undefined;
  }
  return structuredClone(trustContext);
}

export function resolveCfcExecutionIntegritySnapshot(
  source: CfcExecutionIntegritySource | undefined,
): CfcIntegrityLabel | undefined {
  const executionIntegrity = typeof source === "function" ? source() : source;
  return normalizeIntegrityLabel(executionIntegrity);
}

export function snapshotCfcTrustContext(
  actingPrincipal: string | undefined,
  trustContext: CfcTrustContext | undefined,
): CfcTrustContextSnapshot {
  if (!actingPrincipal) {
    return {
      actingPrincipal: null,
      delegations: [],
      statements: [],
      conceptEdges: [],
    };
  }

  const delegations = [...(trustContext?.delegations ?? [])]
    .filter((delegation) => delegation.delegator === actingPrincipal)
    .map((delegation) => ({
      delegator: delegation.delegator,
      verifier: delegation.verifier,
      concepts: [...(delegation.scope?.concepts ?? [])].sort(),
    }))
    .sort((a, b) =>
      a.delegator.localeCompare(b.delegator) ||
      a.verifier.localeCompare(b.verifier) ||
      a.concepts.join("\u0000").localeCompare(b.concepts.join("\u0000"))
    );

  const statements = [...(trustContext?.statements ?? [])]
    .map((statement) => ({
      verifier: statement.verifier,
      concrete: statement.concrete,
      concept: statement.concept,
    }))
    .sort((a, b) =>
      a.verifier.localeCompare(b.verifier) ||
      a.concrete.localeCompare(b.concrete) ||
      a.concept.localeCompare(b.concept)
    );

  const conceptEdges = [...(trustContext?.conceptEdges ?? [])]
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
    }))
    .sort((a, b) =>
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to)
    );

  return {
    actingPrincipal,
    delegations,
    statements,
    conceptEdges,
  };
}

export function computeCfcTrustContextHash(
  actingPrincipal: string | undefined,
  trustContext: CfcTrustContext | undefined,
): string {
  const snapshot = snapshotCfcTrustContext(actingPrincipal, trustContext);
  const storable = storableFromNativeValue(snapshot);
  return toHex(canonicalHash(storable).hash);
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

function integrityRequirementSatisfiedWithEdges(
  actual: CfcAtom | undefined,
  requirement: CfcAtom,
  trustedEdges: readonly CfcTrustConceptEdge[],
): boolean {
  if (actual === undefined) {
    return false;
  }
  if (
    typeof actual === "string" &&
    typeof requirement === "string" &&
    requirement.length > 0
  ) {
    if (actual === requirement) {
      return true;
    }
    return reachesConcept(actual, requirement, trustedEdges);
  }
  return matchesCfcAtomPattern(actual, requirement);
}

export function integrityRequirementSatisfied(
  actual: CfcAtom | undefined,
  requirement: CfcAtom,
  options: CfcIntegrityTrustOptions = {},
): boolean {
  const trustedEdges = trustedEdgesForActingPrincipal(
    options.actingPrincipal,
    options.trustContext,
  );
  return integrityRequirementSatisfiedWithEdges(
    actual,
    requirement,
    trustedEdges,
  );
}

export function integritySatisfiesRequiredIntegrity(
  actualIntegrity: CfcIntegrityLabel | undefined,
  requiredIntegrity: CfcIntegrityLabel,
  options: CfcIntegrityTrustOptions = {},
): boolean {
  if (requiredIntegrity.length === 0) {
    return true;
  }
  if (!actualIntegrity || actualIntegrity.length === 0) {
    return false;
  }

  const trustedEdges = trustedEdgesForActingPrincipal(
    options.actingPrincipal,
    options.trustContext,
  );

  return requiredIntegrity.every((requirement) => {
    return actualIntegrity.some((actual) =>
      integrityRequirementSatisfiedWithEdges(
        actual,
        requirement,
        trustedEdges,
      )
    );
  });
}
