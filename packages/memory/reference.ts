export type {
  HashObject,
  HashObject as ContentId,
} from "@commonfabric/data-model/value-hash";

export {
  hashObjectFromJson as contentIdFromJSON,
  hashObjectFromString as fromString,
  hashOf as refer,
  isHashObject as isContentId,
  resetModernHashConfig as resetCanonicalHashConfig,
  setModernHashConfig as setCanonicalHashConfig,
} from "@commonfabric/data-model/value-hash";
