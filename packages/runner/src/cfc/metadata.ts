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

/**
 * A stored envelope whose `version` this build does not understand. The
 * labels cannot be interpreted, so every consumer fails CLOSED on this
 * error — treating the envelope as absent would read a labeled document
 * as unlabeled, which is exactly the failure a format version exists to
 * prevent.
 */
export class UnknownCfcMetadataVersionError extends Error {
  constructor(version: unknown) {
    super(
      `stored CFC metadata version ${
        JSON.stringify(version)
      } is not one this build interprets`,
    );
    this.name = "UnknownCfcMetadataVersionError";
  }
}

// Typed against the metadata's own version union, so growing the list
// without growing `CfcMetadata["version"]` (or the reverse) is a compile
// error — the predicate below narrows to `CfcMetadata` on the strength of
// this list.
const KNOWN_CFC_METADATA_VERSIONS: readonly CfcMetadata["version"][] = [1];

const isKnownMetadataVersion = (value: unknown): boolean =>
  KNOWN_CFC_METADATA_VERSIONS.some((version) => version === value);

export const isCfcMetadata = (value: unknown): value is CfcMetadata =>
  isObjectNotArray(value) && isKnownMetadataVersion(value.version) &&
  isObjectNotArray(value.labelMap) &&
  Array.isArray(value.labelMap.entries);

/**
 * A stored envelope at the reserved position that carries no label map this
 * build can walk. The labels cannot be read, so a consumer that resolves
 * labels fails CLOSED on this error: a document whose envelope is present but
 * unreadable is not an unlabeled document.
 */
export class UnreadableCfcMetadataError extends Error {
  constructor(id: string) {
    super(
      `stored CFC metadata for ${id} carries no label map this build can read`,
    );
    this.name = "UnreadableCfcMetadataError";
  }
}

// A record at the reserved metadata position whose `version` this build does
// not interpret. The position is what qualifies the record, never its field
// names — a future format may rename every field except the version, and
// requiring today's members would read exactly those envelopes as unlabeled.
// A record with no `version` at all is not an envelope.
const isUnknownVersionEnvelope = (
  value: unknown,
): value is { version: unknown } =>
  isObjectNotArray(value) && "version" in value &&
  !isKnownMetadataVersion(value.version);

/**
 * Throws for a record at the reserved metadata position carrying a
 * `version` outside {@link KNOWN_CFC_METADATA_VERSIONS}.
 */
const refuseUnknownMetadataVersion = (value: unknown): void => {
  if (isUnknownVersionEnvelope(value)) {
    throw new UnknownCfcMetadataVersionError(value.version);
  }
};

/**
 * Whether a value at a document's reserved metadata position leaves the
 * document carrying a label map. True for an envelope this build interprets,
 * and for one whose `version` it does not — that one throws on read and every
 * consumer fails closed on the throw, so the document is not an unlabeled one.
 * False for everything {@link readStoredCfcMetadata} reports as absent, `null`
 * and a record with no `version` among them: a document holding one of those
 * reads as carrying no confidentiality at all.
 */
export const cfcMetadataPresent = (value: unknown): boolean =>
  isCfcMetadata(value) || isUnknownVersionEnvelope(value);

export const readStoredCfcMetadata = (
  tx: IExtendedStorageTransaction,
  target: {
    space: MemorySpace;
    id: string;
    scope?: NormalizedFullLink["scope"];
  },
): CfcMetadata | undefined => {
  const document = tx.readOrThrow({
    space: target.space,
    id: target.id as URI,
    scope: normalizeCellScope(target.scope),
    type: "application/json",
    path: ["cfc"],
  }, {
    meta: INTERNAL_VERIFIER_META,
  });
  if (isCfcMetadata(document)) {
    return document;
  }
  refuseUnknownMetadataVersion(document);
  if (isObjectOrArray(document) && isCfcMetadata(document.cfc)) {
    return document.cfc;
  }
  if (isObjectOrArray(document)) {
    refuseUnknownMetadataVersion(document.cfc);
  }
  return undefined;
};

export const storedCfcMetadataAppliesToPath = (
  tx: IExtendedStorageTransaction,
  target: Pick<NormalizedFullLink, "space" | "id" | "scope" | "path">,
): boolean => {
  let metadata: CfcMetadata | undefined;
  try {
    metadata = readStoredCfcMetadata(tx, target);
  } catch (error) {
    // An envelope this build cannot interpret still marks the document as
    // policy-carrying: "applies" is the fail-closed answer, and the write
    // it gates then meets the same unreadable envelope at prepare time.
    if (error instanceof UnknownCfcMetadataVersionError) return true;
    throw error;
  }
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
