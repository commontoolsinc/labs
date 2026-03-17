import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import { escapeJsonPointerToken } from "./canonical-activity.ts";
import type { ConsumedReadWithEffectiveLabel } from "./consumed-input-labels.ts";
import type { CfcImplementationIdentity } from "./implementation-identity.ts";
import {
  FLOW_TAINT_PRECISION_CONCEPT,
  isImplementationTrustedForConcept,
} from "./trust-lattice.ts";

type FlowPrecisionClaimType =
  | "PointwisePresencePreserved"
  | "PointwiseWriteDependency";

export interface FlowPrecisionClaimSpec {
  readonly concept: string;
  readonly sourceCollection: string;
  readonly claims: readonly FlowPrecisionClaimType[];
}

export interface FlowPrecisionSelection {
  readonly consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[];
  readonly outputPatternPath?: string;
  readonly sourcePath?: string;
  readonly usedClaim: boolean;
  readonly trusted: boolean;
}

type FlowPrecisionClaimMatch = {
  readonly claim: FlowPrecisionClaimSpec;
  readonly outputPatternPath: string;
  readonly sourcePath: string;
};

function toCanonicalSegments(path: string): string[] {
  if (path === "/") {
    return [];
  }
  return path.slice(1).split("/").filter(Boolean);
}

function fromCanonicalSegments(path: readonly string[]): string {
  if (path.length === 0) {
    return "/";
  }
  return `/${path.map(escapeJsonPointerToken).join("/")}`;
}

function appendCanonicalSegment(path: string, segment: string): string {
  const next = toCanonicalSegments(path);
  next.push(segment);
  return fromCanonicalSegments(next);
}

function isSameOrDescendantCanonicalPath(
  basePath: string,
  candidatePath: string,
): boolean {
  if (basePath === "/") {
    return candidatePath.startsWith("/");
  }
  return candidatePath === basePath || candidatePath.startsWith(`${basePath}/`);
}

function strongestConsumedClassification(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  cfc: ContextualFlowControl,
): string {
  const consumed = new Set<string>();
  for (const read of consumedReadLabels) {
    consumed.add(read.effectiveLabel?.classification?.[0] ?? "unclassified");
  }
  if (consumed.size === 0) {
    return "unclassified";
  }
  return cfc.lub(consumed);
}

function classificationDominates(
  actualClassification: string,
  minClassification: string,
  cfc: ContextualFlowControl,
): boolean {
  try {
    return cfc.lub(new Set([actualClassification, minClassification])) ===
      actualClassification;
  } catch {
    return false;
  }
}

function isFlowPrecisionClaimType(
  value: unknown,
): value is FlowPrecisionClaimType {
  return value === "PointwisePresencePreserved" ||
    value === "PointwiseWriteDependency";
}

function normalizeFlowPrecisionClaimType(
  value: unknown,
): FlowPrecisionClaimType | undefined {
  if (isFlowPrecisionClaimType(value)) {
    return value;
  }
  if (value === "KeyLocalShapePreserved") {
    return "PointwisePresencePreserved";
  }
  if (value === "KeyLocalWriteDependency") {
    return "PointwiseWriteDependency";
  }
  return undefined;
}

function readFlowPrecisionClaim(
  schema: JSONSchema | undefined,
): FlowPrecisionClaimSpec | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return undefined;
  }
  const rawIfc = (schema as { ifc?: unknown }).ifc;
  if (!rawIfc || typeof rawIfc !== "object" || Array.isArray(rawIfc)) {
    return undefined;
  }
  const rawClaim = (rawIfc as { flowPrecisionClaim?: unknown })
    .flowPrecisionClaim;
  if (!rawClaim || typeof rawClaim !== "object" || Array.isArray(rawClaim)) {
    return undefined;
  }

  const concept = (rawClaim as { concept?: unknown }).concept;
  const sourceCollection = (rawClaim as { sourceCollection?: unknown })
    .sourceCollection;
  const rawClaims = (rawClaim as { claims?: unknown }).claims;
  if (
    typeof concept !== "string" || concept.length === 0 ||
    typeof sourceCollection !== "string" || !sourceCollection.startsWith("/") ||
    !Array.isArray(rawClaims)
  ) {
    return undefined;
  }

  const claims = rawClaims
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? normalizeFlowPrecisionClaimType((entry as { type?: unknown }).type)
        : undefined
    )
    .filter(isFlowPrecisionClaimType);

  if (
    claims.length === 0 ||
    !claims.includes("PointwisePresencePreserved") ||
    !claims.includes("PointwiseWriteDependency")
  ) {
    return undefined;
  }

  return {
    concept,
    sourceCollection,
    claims,
  };
}

function collectFlowPrecisionClaims(
  schema: JSONSchema,
): ReadonlyArray<{
  readonly claim: FlowPrecisionClaimSpec;
  readonly outputPatternPath: string;
}> {
  const claims: Array<{
    readonly claim: FlowPrecisionClaimSpec;
    readonly outputPatternPath: string;
  }> = [];
  const stack = new Set<object>();

  const collect = (
    node: JSONSchema | undefined,
    fullSchema: JSONSchema,
    path: string,
  ) => {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return;
    }

    const resolved =
      ContextualFlowControl.resolveSchemaRefs(node, fullSchema) ??
        node;
    if (
      !resolved || typeof resolved !== "object" || Array.isArray(resolved)
    ) {
      return;
    }

    if (stack.has(resolved)) {
      return;
    }
    stack.add(resolved);

    const claim = readFlowPrecisionClaim(resolved);
    if (claim) {
      claims.push({ claim, outputPatternPath: path });
    }

    const properties = (resolved as { properties?: unknown }).properties;
    if (
      properties && typeof properties === "object" && !Array.isArray(properties)
    ) {
      for (const [key, child] of Object.entries(properties)) {
        collect(
          child as JSONSchema,
          fullSchema,
          appendCanonicalSegment(path, key),
        );
      }
    }

    const additionalProperties =
      (resolved as { additionalProperties?: unknown }).additionalProperties;
    if (
      additionalProperties &&
      typeof additionalProperties === "object" &&
      !Array.isArray(additionalProperties)
    ) {
      collect(
        additionalProperties as JSONSchema,
        fullSchema,
        appendCanonicalSegment(path, "*"),
      );
    }

    const items = (resolved as { items?: unknown }).items;
    if (items && typeof items === "object" && !Array.isArray(items)) {
      collect(
        items as JSONSchema,
        fullSchema,
        appendCanonicalSegment(path, "*"),
      );
    }

    const prefixItems = (resolved as { prefixItems?: unknown }).prefixItems;
    if (Array.isArray(prefixItems)) {
      for (let index = 0; index < prefixItems.length; index++) {
        collect(
          prefixItems[index] as JSONSchema,
          fullSchema,
          appendCanonicalSegment(path, String(index)),
        );
      }
    }
  };

  collect(schema, schema, "/");
  return claims;
}

function matchClaimOutputPath(
  outputPatternPath: string,
  writePath: string,
):
  | {
    readonly wildcardSegments: readonly string[];
    readonly suffix: readonly string[];
  }
  | undefined {
  const patternSegments = toCanonicalSegments(outputPatternPath);
  const writeSegments = toCanonicalSegments(writePath);

  if (patternSegments.length > writeSegments.length) {
    return undefined;
  }

  const wildcardSegments: string[] = [];
  for (let index = 0; index < patternSegments.length; index++) {
    const patternSegment = patternSegments[index];
    const writeSegment = writeSegments[index];
    if (patternSegment === "*") {
      wildcardSegments.push(writeSegment);
      continue;
    }
    if (patternSegment !== writeSegment) {
      return undefined;
    }
  }

  return {
    wildcardSegments,
    suffix: writeSegments.slice(patternSegments.length),
  };
}

function buildSourcePath(
  sourceCollection: string,
  wildcardSegments: readonly string[],
  suffix: readonly string[],
): string {
  const sourceSegments = toCanonicalSegments(sourceCollection);
  return fromCanonicalSegments([
    ...sourceSegments,
    ...wildcardSegments,
    ...suffix,
  ]);
}

function readEntityKey(
  consumed: ConsumedReadWithEffectiveLabel,
): string {
  const { space, id, type } = consumed.read;
  return `${space}\u0000${id}\u0000${type}`;
}

function selectSourceEntityKey(
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  sourceCollection: string,
): string | undefined {
  const candidateEntityKeys = new Set<string>();
  for (const consumed of consumedReadLabels) {
    if (
      isSameOrDescendantCanonicalPath(sourceCollection, consumed.read.path)
    ) {
      candidateEntityKeys.add(readEntityKey(consumed));
    }
  }
  if (candidateEntityKeys.size !== 1) {
    return undefined;
  }
  return [...candidateEntityKeys][0];
}

function findFlowPrecisionClaimForWrite(
  rootSchema: JSONSchema,
  writePath: string,
): FlowPrecisionClaimMatch | undefined {
  const claims = collectFlowPrecisionClaims(rootSchema)
    .map((entry) => {
      const matched = matchClaimOutputPath(entry.outputPatternPath, writePath);
      if (!matched) {
        return undefined;
      }
      return {
        claim: entry.claim,
        outputPatternPath: entry.outputPatternPath,
        sourcePath: buildSourcePath(
          entry.claim.sourceCollection,
          matched.wildcardSegments,
          matched.suffix,
        ),
      };
    })
    .filter((value): value is FlowPrecisionClaimMatch => value !== undefined);

  claims.sort((left, right) =>
    right.outputPatternPath.length - left.outputPatternPath.length
  );
  return claims[0];
}

export function selectFlowPrecisionConsumedReads(
  rootSchema: JSONSchema | undefined,
  writePath: string,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  implementationIdentity: CfcImplementationIdentity | undefined,
): FlowPrecisionSelection {
  if (!rootSchema || consumedReadLabels.length === 0) {
    return {
      consumedReadLabels,
      usedClaim: false,
      trusted: false,
    };
  }

  const claim = findFlowPrecisionClaimForWrite(rootSchema, writePath);
  if (!claim || claim.claim.concept !== FLOW_TAINT_PRECISION_CONCEPT) {
    return {
      consumedReadLabels,
      usedClaim: false,
      trusted: false,
    };
  }

  const sourceEntityKey = selectSourceEntityKey(
    consumedReadLabels,
    claim.claim.sourceCollection,
  );
  if (!sourceEntityKey) {
    return {
      consumedReadLabels,
      usedClaim: false,
      trusted: false,
    };
  }

  const claimedConsumedReadLabels = consumedReadLabels.filter((consumed) => {
    const entityKey = readEntityKey(consumed);
    if (entityKey !== sourceEntityKey) {
      return true;
    }
    if (
      !isSameOrDescendantCanonicalPath(
        claim.claim.sourceCollection,
        consumed.read.path,
      )
    ) {
      return true;
    }
    return isSameOrDescendantCanonicalPath(
      claim.sourcePath,
      consumed.read.path,
    );
  });

  const sourceLocalReads = claimedConsumedReadLabels.filter((consumed) =>
    readEntityKey(consumed) === sourceEntityKey &&
    isSameOrDescendantCanonicalPath(claim.sourcePath, consumed.read.path)
  );
  if (sourceLocalReads.length === 0) {
    return {
      consumedReadLabels,
      usedClaim: false,
      trusted: false,
    };
  }

  const cfc = new ContextualFlowControl();
  const defaultClassification = strongestConsumedClassification(
    consumedReadLabels,
    cfc,
  );
  const claimedClassification = strongestConsumedClassification(
    claimedConsumedReadLabels,
    cfc,
  );
  const trustRequired = !classificationDominates(
    claimedClassification,
    defaultClassification,
    cfc,
  );
  const trusted = !trustRequired ||
    isImplementationTrustedForConcept(
      implementationIdentity,
      FLOW_TAINT_PRECISION_CONCEPT,
    );

  if (!trusted) {
    return {
      consumedReadLabels,
      outputPatternPath: claim.outputPatternPath,
      sourcePath: claim.sourcePath,
      usedClaim: false,
      trusted: false,
    };
  }

  return {
    consumedReadLabels: claimedConsumedReadLabels,
    outputPatternPath: claim.outputPatternPath,
    sourcePath: claim.sourcePath,
    usedClaim: true,
    trusted,
  };
}
