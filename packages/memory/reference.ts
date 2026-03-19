// Re-export from data-model where the implementation now lives.
export {
  contentIdFromJSON,
  type ContentId,
  type DefinedReferent,
  fromString,
  isContentId,
  refer,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "@commontools/data-model/value-hash";
