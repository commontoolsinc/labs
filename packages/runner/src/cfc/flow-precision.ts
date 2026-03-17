import type { JSONSchema } from "../builder/types.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  type CanonicalBoundaryRead,
  canonicalizeStoragePath,
  escapeJsonPointerToken,
} from "./canonical-activity.ts";
import type { ConsumedReadWithEffectiveLabel } from "./consumed-input-labels.ts";
import type {
  IExtendedStorageTransaction,
  IMemorySpaceAddress,
} from "../storage/interface.ts";
import type { CfcImplementationIdentity } from "./implementation-identity.ts";
import type { CfcTrustContext } from "./integrity-trust.ts";
import {
  type CfcImplementationTrustEvaluator,
  FLOW_TAINT_PRECISION_CONCEPT,
  isImplementationTrustedForConcept,
} from "./trust-lattice.ts";
import {
  confidentialityDominates,
  joinConfidentialityLabels,
  type CfcConfidentialityLabel,
} from "./label-algebra.ts";

type FlowPrecisionClaimType =
  | "PointwisePresencePreserved"
  | "PointwiseWriteDependency"
  | "ElementLocalExpansion"
  | "StableRelativeOrder";

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
  readonly mode?: "pointwise" | "elementLocalExpansion";
}

export function recordFlowPrecisionOutputSource(
  tx: IExtendedStorageTransaction,
  output: IMemorySpaceAddress,
  source: IMemorySpaceAddress,
): void {
  tx.readValueOrThrow(source, {
    cfc: {
      internalVerifierRead: true,
      flowPrecisionOutputPath: canonicalizeStoragePath(output.path),
      flowPrecisionSourcePath: canonicalizeStoragePath(source.path),
    },
  });
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
): CfcConfidentialityLabel | undefined {
  let consumed: CfcConfidentialityLabel | undefined;
  for (const read of consumedReadLabels) {
    consumed = joinConfidentialityLabels(
      consumed,
      read.effectiveLabel?.classification,
    );
  }
  return consumed;
}

function classificationDominates(
  actualClassification: CfcConfidentialityLabel | undefined,
  minClassification: CfcConfidentialityLabel | undefined,
): boolean {
  return confidentialityDominates(actualClassification, minClassification);
}

function isFlowPrecisionClaimType(
  value: unknown,
): value is FlowPrecisionClaimType {
  return value === "PointwisePresencePreserved" ||
    value === "PointwiseWriteDependency" ||
    value === "ElementLocalExpansion" ||
    value === "StableRelativeOrder";
}

function hasPointwiseClaims(claim: FlowPrecisionClaimSpec): boolean {
  return claim.claims.includes("PointwisePresencePreserved") &&
    claim.claims.includes("PointwiseWriteDependency");
}

function hasElementLocalExpansionClaim(
  claim: FlowPrecisionClaimSpec,
): boolean {
  return claim.claims.includes("ElementLocalExpansion");
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
    (!hasPointwiseClaims({ concept, sourceCollection, claims }) &&
      !hasElementLocalExpansionClaim({ concept, sourceCollection, claims }))
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

function readEntityAddressKey(
  read: Pick<CanonicalBoundaryRead, "space" | "id" | "type">,
): string {
  return `${read.space}\u0000${read.id}\u0000${read.type}`;
}

function readEntityKey(consumed: ConsumedReadWithEffectiveLabel): string {
  return readEntityAddressKey(consumed.read);
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

function selectElementLocalExpansionSourcePath(
  internalVerifierReads: readonly CanonicalBoundaryRead[],
  writePath: string,
  sourceEntityKey: string,
  sourceCollection: string,
): string | undefined {
  const candidatePaths = new Set<string>();
  for (const read of internalVerifierReads) {
    const outputPath = read.cfc?.flowPrecisionOutputPath;
    const sourcePath = read.cfc?.flowPrecisionSourcePath;
    if (
      outputPath !== writePath ||
      sourcePath === undefined ||
      readEntityAddressKey(read) !== sourceEntityKey ||
      !isSameOrDescendantCanonicalPath(sourceCollection, sourcePath)
    ) {
      continue;
    }
    candidatePaths.add(sourcePath);
  }
  if (candidatePaths.size !== 1) {
    return undefined;
  }
  return [...candidatePaths][0];
}

export function selectFlowPrecisionConsumedReads(
  rootSchema: JSONSchema | undefined,
  writePath: string,
  consumedReadLabels: readonly ConsumedReadWithEffectiveLabel[],
  internalVerifierReads: readonly CanonicalBoundaryRead[],
  implementationIdentity: CfcImplementationIdentity | undefined,
  actingPrincipal?: string,
  trustContext?: CfcTrustContext,
  trustEvaluator?: CfcImplementationTrustEvaluator,
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

  const pointwise = hasPointwiseClaims(claim.claim);
  const elementLocalExpansion = hasElementLocalExpansionClaim(claim.claim);
  const retainNonSourceReads = !(
    elementLocalExpansion &&
    implementationIdentity?.kind === "builtin" &&
    implementationIdentity.name === "filter"
  );
  const claimSourcePath = pointwise
    ? claim.sourcePath
    : elementLocalExpansion
    ? selectElementLocalExpansionSourcePath(
      internalVerifierReads,
      writePath,
      sourceEntityKey,
      claim.claim.sourceCollection,
    )
    : undefined;
  if (!claimSourcePath) {
    return {
      consumedReadLabels,
      outputPatternPath: claim.outputPatternPath,
      usedClaim: false,
      trusted: false,
    };
  }

  const claimedConsumedReadLabels = consumedReadLabels.filter((consumed) => {
    const entityKey = readEntityKey(consumed);
    if (entityKey !== sourceEntityKey) {
      return retainNonSourceReads;
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
      claimSourcePath,
      consumed.read.path,
    );
  });

  const sourceLocalReads = claimedConsumedReadLabels.filter((consumed) =>
    readEntityKey(consumed) === sourceEntityKey &&
    isSameOrDescendantCanonicalPath(claimSourcePath, consumed.read.path)
  );
  if (sourceLocalReads.length === 0) {
    return {
      consumedReadLabels,
      outputPatternPath: claim.outputPatternPath,
      sourcePath: claimSourcePath,
      usedClaim: false,
      trusted: false,
    };
  }

  const defaultClassification = strongestConsumedClassification(
    consumedReadLabels,
  );
  const claimedClassification = strongestConsumedClassification(
    claimedConsumedReadLabels,
  );
  const trustRequired = !classificationDominates(
    claimedClassification,
    defaultClassification,
  );
  const trusted = !trustRequired ||
    (trustEvaluator ?? isImplementationTrustedForConcept)(
      implementationIdentity,
      FLOW_TAINT_PRECISION_CONCEPT,
      { actingPrincipal, trustContext },
    );

  if (!trusted) {
    return {
      consumedReadLabels,
      outputPatternPath: claim.outputPatternPath,
      sourcePath: claimSourcePath,
      usedClaim: false,
      trusted: false,
    };
  }

  return {
    consumedReadLabels: claimedConsumedReadLabels,
    outputPatternPath: claim.outputPatternPath,
    sourcePath: claimSourcePath,
    usedClaim: true,
    trusted,
    mode: pointwise ? "pointwise" : "elementLocalExpansion",
  };
}
