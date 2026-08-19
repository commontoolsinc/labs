import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { URI } from "@commonfabric/memory/interface";
import type { NormalizedFullLink } from "../link-utils.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { normalizeCellScope } from "../scope.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import type { CfcMetadata } from "./types.ts";

const INTERNAL_VERIFIER_META = {
  ...internalVerifierRead,
};

const isPrefix = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length <= right.length &&
  left.every((segment, index) => segment === right[index]);

const isCfcMetadata = (value: unknown): value is CfcMetadata =>
  isObjectNotArray(value) && value.version === 1 &&
  isObjectNotArray(value.labelMap) &&
  Array.isArray(value.labelMap.entries);

/**
 * The metadata a `["cfc"]` read answered with, decided by shape. A caller that
 * resolves the path is handed the member; a path-blind one is handed the whole
 * envelope to take `cfc` from. A value of neither shape reports no metadata.
 */
export const cfcMetadataFromCfcRead = (
  value: unknown,
): CfcMetadata | undefined => {
  if (isCfcMetadata(value)) {
    return value;
  }
  return isObjectOrArray(value) && isCfcMetadata(value.cfc)
    ? value.cfc
    : undefined;
};

export const readStoredCfcMetadata = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: string;
    scope?: NormalizedFullLink["scope"];
  },
): CfcMetadata | undefined =>
  cfcMetadataFromCfcRead(tx.readOrThrow({
    space: target.space,
    id: target.id as URI,
    scope: normalizeCellScope(target.scope),
    type: "application/json",
    path: ["cfc"],
  }, {
    meta: INTERNAL_VERIFIER_META,
  }));

export const storedCfcMetadataAppliesToPath = (
  tx: IExtendedStorageTransaction,
  target: Pick<NormalizedFullLink, "space" | "id" | "scope" | "path">,
): boolean => {
  const metadata = readStoredCfcMetadata(tx, target);
  if (metadata === undefined) {
    return false;
  }
  const logicalPath = canonicalizeLogicalPath(target.path);
  // labelMap entries are persisted both for paths with confidentiality /
  // integrity values AND for paths whose schema carried a policy claim
  // (writeAuthorizedBy / uiContract / exactCopyOf — see
  // `derivePersistedLabel` and the persistence guard in `prepare.ts`). The
  // mere presence of an entry signals "policy applies on this path"; do NOT
  // filter on `hasLabelValues` here, or claim-only entries get silently
  // bypassed.
  return metadata.labelMap.entries.some((entry) =>
    isPrefix(entry.path, logicalPath) || isPrefix(logicalPath, entry.path)
  );
};
