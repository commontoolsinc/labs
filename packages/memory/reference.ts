export type {
  ContentId,
  DefinedReferent,
} from "@commontools/data-model/value-hash";

export {
  contentIdFromJSON,
  fromString,
  hashOf as refer,
  isContentId,
  resetCanonicalHashConfig,
  setCanonicalHashConfig,
} from "@commontools/data-model/value-hash";
