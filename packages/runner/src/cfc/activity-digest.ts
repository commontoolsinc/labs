import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import type {
  Activity,
  ICfcReadAnnotations,
  Metadata,
} from "../storage/interface.ts";
import {
  ignoreReadForSchedulingMarker,
  markReadAsPotentialWriteMarker,
} from "../storage/read-metadata.ts";
import { canonicalizeStoragePath } from "./canonical-activity.ts";
import { activityWriteChangedFlag, toHex } from "./shared.ts";
import {
  type CfcPrepareScope,
  computeCfcTrustContextHash,
} from "./integrity-trust.ts";
import { encodeImplementationIdentity } from "./implementation-identity.ts";
import { normalizeIntegrityLabel } from "./label-algebra.ts";

interface NormalizedReadMetadata {
  readonly ignoreReadForScheduling: boolean;
  readonly potentialWrite: boolean;
}

interface NormalizedReadCfc {
  readonly internalVerifierRead: boolean;
  readonly op: string;
  readonly selector: string | null;
  readonly maxConfidentiality: readonly string[];
  readonly requiredIntegrity: readonly unknown[];
  readonly flowPrecisionOutputPath: string | null;
  readonly flowPrecisionSourcePath: string | null;
}

type NormalizedReadActivity = {
  readonly kind: "read";
  readonly space: string;
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly meta: NormalizedReadMetadata;
  readonly cfc: NormalizedReadCfc;
};

type NormalizedWriteActivity = {
  readonly kind: "write";
  readonly space: string;
  readonly id: string;
  readonly type: string;
  readonly path: string;
  readonly changed: boolean;
};

type NormalizedActivity = NormalizedReadActivity | NormalizedWriteActivity;

interface NormalizedDigestScope {
  readonly implementationIdentity: string;
  readonly actingPrincipal: string | null;
  readonly trustContextHash: string;
  readonly executionIntegrity: readonly unknown[];
}

function normalizeReadMetadata(
  meta: Metadata | undefined,
): NormalizedReadMetadata {
  return {
    ignoreReadForScheduling: meta?.[ignoreReadForSchedulingMarker] === true,
    potentialWrite: meta?.[markReadAsPotentialWriteMarker] === true,
  };
}

function normalizeCfcReadAnnotations(
  cfc: ICfcReadAnnotations | undefined,
): NormalizedReadCfc {
  const maxConfidentiality = [...(cfc?.maxConfidentiality ?? [])].sort();
  const requiredIntegrity = normalizeIntegrityLabel(cfc?.requiredIntegrity) ??
    [];
  return {
    internalVerifierRead: cfc?.internalVerifierRead === true,
    op: cfc?.op ?? "value",
    selector: cfc?.selector ?? null,
    maxConfidentiality,
    requiredIntegrity,
    flowPrecisionOutputPath: cfc?.flowPrecisionOutputPath ?? null,
    flowPrecisionSourcePath: cfc?.flowPrecisionSourcePath ?? null,
  };
}

function normalizeActivity(
  activity: Iterable<Activity>,
): readonly NormalizedActivity[] {
  const normalized: NormalizedActivity[] = [];
  for (const item of activity) {
    if ("read" in item && item.read) {
      const read = item.read;
      normalized.push({
        kind: "read",
        space: read.space,
        id: read.id,
        type: read.type,
        path: canonicalizeStoragePath(read.path),
        meta: normalizeReadMetadata(read.meta),
        cfc: normalizeCfcReadAnnotations(read.cfc),
      });
      continue;
    }

    if ("write" in item && item.write) {
      normalized.push({
        kind: "write",
        space: item.write.space,
        id: item.write.id,
        type: item.write.type,
        path: canonicalizeStoragePath(item.write.path),
        changed: activityWriteChangedFlag(item.write),
      });
    }
  }
  return normalized;
}

function normalizeDigestScope(
  scope: CfcPrepareScope | undefined,
): NormalizedDigestScope {
  return {
    implementationIdentity: encodeImplementationIdentity(
      scope?.implementationIdentity,
    ),
    actingPrincipal: scope?.actingPrincipal ?? null,
    trustContextHash: computeCfcTrustContextHash(
      scope?.actingPrincipal,
      scope?.trustContext,
    ),
    executionIntegrity: normalizeIntegrityLabel(scope?.executionIntegrity) ??
      [],
  };
}

export function computeCfcActivityDigest(
  activity: Iterable<Activity>,
  scope?: CfcPrepareScope,
): string {
  const storable = storableFromNativeValue({
    activity: normalizeActivity(activity),
    scope: normalizeDigestScope(scope),
  });
  return toHex(canonicalHash(storable).hash);
}
