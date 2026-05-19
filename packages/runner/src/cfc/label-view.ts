import { isRecord } from "@commonfabric/utils/types";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import {
  isPrimitiveCellLink,
  type NormalizedFullLink,
  parseLink,
} from "../link-utils.ts";
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

type LinkedValueMetadata = {
  metadata: CfcMetadata;
  path: readonly string[];
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
      },
    );
  } catch {
    return undefined;
  }
};

const linkedValueMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): LinkedValueMetadata | undefined => {
  if (!cell.runtime || link.path.length === 0) {
    return undefined;
  }
  try {
    const tx = cell.runtime.readTx(cell.tx);
    const value = tx.readValueOrThrow(link);
    if (!isPrimitiveCellLink(value)) {
      return undefined;
    }
    const target = parseLink(value, link);
    if (target?.id === undefined || target.space === undefined) {
      return undefined;
    }
    const metadata = readStoredCfcMetadata(tx, {
      space: target.space,
      id: target.id,
      scope: target.scope,
    });
    return metadata === undefined ? undefined : { metadata, path: target.path };
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
  const linkedValue = linkedValueMetadataForCell(
    cell as LabelQueryableCell,
    link,
  );
  const linkedValueView = cfcLabelViewFromMetadata(
    linkedValue?.metadata,
    linkedValue?.path ?? [],
  );

  return mergeCfcLabelViews([
    metadataView,
    linkedValueView,
    getCarriedCfcLabelView(cell),
  ]);
};
