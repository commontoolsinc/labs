export type {
  HashObject,
  HashObject as ContentId,
} from "@commontools/data-model/value-hash";

export {
  hashObjectFromJson as contentIdFromJSON,
  hashObjectFromString as fromString,
  hashOf as refer,
  isHashObject as isContentId,
  resetModernHashConfig as resetCanonicalHashConfig,
  setModernHashConfig as setCanonicalHashConfig,
} from "@commontools/data-model/value-hash";
