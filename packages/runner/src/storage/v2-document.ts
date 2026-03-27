import type { StorableDatum } from "@commontools/memory/interface";
import type { EntityDocument } from "@commontools/memory/v2";

export const toTransactionDocumentValue = (
  document: EntityDocument | undefined,
): StorableDatum | undefined => {
  if (document === undefined) {
    return undefined;
  }

  return Object.keys(document).length === 0
    ? undefined
    : document as StorableDatum;
};
