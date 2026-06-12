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
import { CFC_LABEL_READ_FAILED_ATOM } from "./observation.ts";
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
export { redactCaveatSourcesForDisplay } from "./label-view-core.ts";

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
  runtime?: Runtime;
  tx?: IExtendedStorageTransaction;
};

type LinkedValueMetadata = {
  metadata: CfcMetadata;
  path: readonly string[];
};

// `readFailed` distinguishes a genuine metadata read error (fail closed) from a
// cleanly-absent label (`readOrThrow` already maps NotFound/TypeMismatch to
// undefined without throwing, so those are NOT failures).
type StoredMetadataResult = {
  metadata: CfcMetadata | undefined;
  readFailed: boolean;
};

type LinkedValueMetadataResult = {
  linkedValue: LinkedValueMetadata | undefined;
  readFailed: boolean;
};

export type CfcLabelViewStatus = {
  view: CfcLabelView | undefined;
  readFailed: boolean;
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): StoredMetadataResult => {
  if (!cell.runtime) {
    return { metadata: undefined, readFailed: false };
  }
  try {
    return {
      metadata: readStoredCfcMetadata(
        cell.runtime.readTx(cell.tx),
        {
          space: link.space,
          id: link.id,
        },
      ),
      readFailed: false,
    };
  } catch {
    return { metadata: undefined, readFailed: true };
  }
};

const linkedValueMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): LinkedValueMetadataResult => {
  if (!cell.runtime || link.path.length === 0) {
    return { linkedValue: undefined, readFailed: false };
  }
  try {
    const tx = cell.runtime.readTx(cell.tx);
    const value = tx.readValueOrThrow(link);
    if (!isPrimitiveCellLink(value)) {
      return { linkedValue: undefined, readFailed: false };
    }
    const target = parseLink(value, link);
    if (target?.id === undefined || target.space === undefined) {
      return { linkedValue: undefined, readFailed: false };
    }
    const metadata = readStoredCfcMetadata(tx, {
      space: target.space,
      id: target.id,
      scope: target.scope,
    });
    return {
      linkedValue: metadata === undefined
        ? undefined
        : { metadata, path: target.path },
      readFailed: false,
    };
  } catch {
    return { linkedValue: undefined, readFailed: true };
  }
};

/**
 * Acquire a cell's display label view AND report whether a metadata read
 * errored while doing so. `cfcLabelViewForCell` drops the flag (the common
 * consumers treat a missing view as blocked); the LLM-observation path consults
 * it via `cfcLabelViewForCellFailClosed`.
 */
export const cfcLabelViewForCellWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  if (
    !isRecord(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return { view: getCarriedCfcLabelView(cell), readFailed: false };
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return { view: getCarriedCfcLabelView(cell), readFailed: false };
  }

  const stored = storedMetadataForCell(cell as LabelQueryableCell, link);
  const metadataView = cfcLabelViewFromMetadata(stored.metadata, link.path);
  const linked = linkedValueMetadataForCell(cell as LabelQueryableCell, link);
  const linkedValueView = cfcLabelViewFromMetadata(
    linked.linkedValue?.metadata,
    linked.linkedValue?.path ?? [],
  );

  return {
    view: mergeCfcLabelViews([
      metadataView,
      linkedValueView,
      getCarriedCfcLabelView(cell),
    ]),
    readFailed: stored.readFailed || linked.readFailed,
  };
};

export const cfcLabelViewForCell = (
  cell: unknown,
): CfcLabelView | undefined => cfcLabelViewForCellWithStatus(cell).view;

/**
 * Fail-closed label acquisition for the LLM-observation egress path (audit 22).
 * Identical to `cfcLabelViewForCell` EXCEPT that when a metadata read errored,
 * the returned view is tainted at the root with `CFC_LABEL_READ_FAILED_ATOM`, so
 * every observation node under it fails any declared confidentiality ceiling and
 * is redacted rather than serialized to the model as public. A cleanly-absent
 * label (no read error) is unchanged, so normal unlabelled data is not
 * over-redacted.
 */
export const cfcLabelViewForCellFailClosed = (
  cell: unknown,
): CfcLabelView | undefined => {
  const { view, readFailed } = cfcLabelViewForCellWithStatus(cell);
  if (!readFailed) {
    return view;
  }
  return mergeCfcLabelViews([
    view,
    {
      version: 1,
      entries: [{
        path: [],
        label: { confidentiality: [CFC_LABEL_READ_FAILED_ATOM] },
      }],
    },
  ]);
};
