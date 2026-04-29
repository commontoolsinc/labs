export type {
  FabricHash,
  FabricHash as ContentId,
} from "@commonfabric/data-model/fabric-hash";

export {
  hashObjectFromJson as contentIdFromJSON,
  hashObjectFromString as fromString,
  hashOf as refer,
  isHashObject as isContentId,
} from "@commonfabric/data-model/value-hash";
