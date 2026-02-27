import { canonicalHash } from "@commontools/memory/canonical-hash";
import { toDeepStorableValue } from "@commontools/memory/storable-value";
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

interface NormalizedReadMetadata {
  readonly ignoreReadForScheduling: boolean;
  readonly potentialWrite: boolean;
}

interface NormalizedReadCfc {
  readonly internalVerifierRead: boolean;
  readonly maxConfidentiality: readonly string[];
  readonly requiredIntegrity: readonly string[];
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
  const requiredIntegrity = [...(cfc?.requiredIntegrity ?? [])].sort();
  return {
    internalVerifierRead: cfc?.internalVerifierRead === true,
    maxConfidentiality,
    requiredIntegrity,
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

export function computeCfcActivityDigest(
  activity: Iterable<Activity>,
): Promise<string> {
  const storable = toDeepStorableValue(normalizeActivity(activity));
  return Promise.resolve(toHex(canonicalHash(storable).hash));
}
