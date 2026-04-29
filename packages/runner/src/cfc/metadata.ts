import { isRecord } from "@commonfabric/utils/types";
import type { URI } from "@commonfabric/memory/interface";
import type { NormalizedFullLink } from "../link-utils.ts";
import { ignoreReadForScheduling } from "../scheduler.ts";
import type {
  IExtendedStorageTransaction,
  MediaType,
  MemorySpace,
} from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { canonicalizeLogicalPath } from "./canonical.ts";
import type { CfcMetadata } from "./types.ts";

const INTERNAL_VERIFIER_META = {
  ...ignoreReadForScheduling,
  ...internalVerifierRead,
};

const isPrefix = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length <= right.length &&
  left.every((segment, index) => segment === right[index]);

export const readStoredCfcMetadata = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: string;
    type: string;
  },
): CfcMetadata | undefined => {
  const document = tx.readOrThrow({
    space: target.space,
    id: target.id as URI,
    type: target.type as MediaType,
    path: [],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  return isRecord(document) && isRecord(document.cfc)
    ? document.cfc as CfcMetadata
    : undefined;
};

export const storedCfcMetadataAppliesToPath = (
  tx: IExtendedStorageTransaction,
  target: Pick<NormalizedFullLink, "space" | "id" | "type" | "path">,
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
