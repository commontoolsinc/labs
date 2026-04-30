import { isRecord } from "@commonfabric/utils/types";
import type {
  IExtendedStorageTransaction,
  MediaType,
} from "../storage/interface.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import type { Runtime } from "../runtime.ts";
import { readStoredCfcMetadata } from "./metadata.ts";
import type { CfcMetadata } from "./types.ts";
import {
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewFromMetadata,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
} from "./label-view-state.ts";

export type { CfcLabelView, CfcLabelViewEntry };
export {
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cloneCfcLabelView,
  getCarriedCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-state.ts";

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): CfcMetadata | undefined => {
  if (!cell.runtime) {
    return undefined;
  }
  try {
    return readStoredCfcMetadata(
      cell.runtime.readTx(cell.tx),
      {
        space: link.space,
        id: link.id,
        type: link.type as MediaType,
      },
    );
  } catch {
    return undefined;
  }
};

export const cfcLabelViewForCell = (
  cell: unknown,
): CfcLabelView | undefined => {
  if (
    !isRecord(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return getCarriedCfcLabelView(cell);
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return getCarriedCfcLabelView(cell);
  }

  const metadataView = cfcLabelViewFromMetadata(
    storedMetadataForCell(cell as LabelQueryableCell, link),
    link.path,
  );

  return mergeCfcLabelViews([
    metadataView,
    getCarriedCfcLabelView(cell),
  ]);
};
