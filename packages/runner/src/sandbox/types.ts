export const CT_IMPLEMENTATION_REF = Symbol.for("ct.implementationRef");
export const CT_ITEM_ID = Symbol.for("ct.itemId");
export const CT_WRAPPER_KIND = Symbol.for("ct.wrapperKind");
export const CT_CAPTURE_IDS = Symbol.for("ct.captureIds");

export type VerifiedWrapperKind =
  | "pattern"
  | "recipe"
  | "lift"
  | "handler"
  | "fn"
  | "pure-fn"
  | "data";

export interface VerifiedMetadataCarrier {
  [CT_IMPLEMENTATION_REF]?: string;
  [CT_ITEM_ID]?: string;
  [CT_WRAPPER_KIND]?: VerifiedWrapperKind;
  [CT_CAPTURE_IDS]?: readonly string[];
}
