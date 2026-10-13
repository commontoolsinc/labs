import { isObjectOrArray } from "@commonfabric/utils/types";
import {
  cellRuntime,
  cellTx,
  getCarriedCfcLabelView,
  isCell,
} from "../cell.ts";
import type { NormalizedFullLink } from "../link-utils.ts";
import { resolveLink } from "../link-resolution.ts";
import {
  readStoredCfcLabelsForReader,
  type StoredCfcLabels,
  type StoredCfcTarget,
} from "./metadata.ts";
import { CFC_LABEL_READ_FAILED_ATOM } from "./observation.ts";
import {
  type CfcLabelView,
  type CfcLabelViewEntry,
  cfcLabelViewFromMetadata,
  cfcLabelViewOriginSpaces,
  mergeCfcLabelViews,
  referenceRestrictionsOf,
  withCfcLabelViewOrigins,
} from "./label-view-state.ts";

export type { CfcLabelView, CfcLabelViewEntry };
export {
  cfcLabelViewForAddress,
  cfcLabelViewForDereference,
  cfcLabelViewForDereferenceTraces,
  cfcLabelViewFromMetadata,
  cloneCfcLabelView,
  mergeCfcLabelViews,
  rebaseCfcLabelView,
} from "./label-view-state.ts";
export { getCarriedCfcLabelView } from "../cell.ts";
export { redactCaveatSourcesForDisplay } from "./label-view-core.ts";

type LabelQueryableCell = {
  getAsNormalizedFullLink(): NormalizedFullLink;
};

// `metadata` is what a reader of a document instance answers to
// (`readStoredCfcLabelsForReader`): the instance's own envelope, joined, for a
// scoped instance, with the confidentiality a value read of each broader
// instance of the same id consumes. It is `undefined` only when none of those
// instances stores a label. `readFailed` distinguishes a genuine metadata read
// error on any of them (fail closed) from a cleanly-absent label (`readOrThrow`
// already maps NotFound/TypeMismatch to undefined without throwing, so those
// are NOT failures).
type StoredMetadataResult = {
  metadata: StoredCfcLabels | undefined;
  readFailed: boolean;
};

type FollowedLabelViews = {
  /**
   * The reference restrictions of each link slot the resolution followed past
   * the first, and then the labels of the document holding the value.
   */
  views: readonly (CfcLabelView | undefined)[];
  readFailed: boolean;
};

export type CfcLabelViewStatus = {
  view: CfcLabelView | undefined;
  readFailed: boolean;
};

/**
 * {@link CfcLabelViewStatus}, plus the spaces of the documents whose stored
 * labels the view was derived from — where a module policy the label selects
 * has its manifest installed (spec §4.4.1). For a view carried on the cell,
 * these are the spaces it was read from wherever it was first read, such as
 * the document holding a link the cell was resolved through.
 */
export type CfcLabelViewSource = CfcLabelViewStatus & {
  spaces: readonly string[];
};

const storedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): StoredMetadataResult => {
  if (!isCell(cell)) {
    return { metadata: undefined, readFailed: false };
  }
  try {
    return {
      // A scoped instance of a document holds labels of its own, as it
      // holds a value of its own, and answers to its broader instances'
      // value-read confidentiality besides.
      metadata: readStoredCfcLabelsForReader(
        cellRuntime(cell).readTx(cellTx(cell)),
        { space: link.space, id: link.id, scope: link.scope },
      ),
      readFailed: false,
    };
  } catch {
    return { metadata: undefined, readFailed: true };
  }
};

/**
 * The labels a reader of the value at `link` answers to beyond the ones
 * `link`'s own document stores: the labels of the document that holds the
 * value, that document found by the runtime's own link resolution, and the
 * reference restrictions of each link slot the resolution followed in another
 * document on the way there (CFC §8.2.4).
 *
 * A link slot stores the label of the reference and nothing of its target's
 * (§8.2.5), so the labels of a value reached through links are read where the
 * value is stored, however many links the path lands on or crosses part way
 * through. The slot the resolution follows first is in `link`'s own document,
 * whose stored labels the caller reads whole, so that slot is left out here.
 *
 * The documents are read by the reader rule (`readStoredCfcLabelsForReader`).
 * A resolution that stops at a document this replica has not received
 * contributes no label for it, as a read of the value there yields no value.
 * A resolution that throws, as one around a cycle of links does, is a failed
 * read.
 */
const followedLabelViewsForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
): FollowedLabelViews => {
  if (!isCell(cell)) {
    return { views: [], readFailed: false };
  }
  try {
    const runtime = cellRuntime(cell);
    const tx = runtime.readTx(cellTx(cell));
    const tracesBefore = tx.getCfcState().dereferenceTraces.length;
    // A label read starts no sync: the value read it accompanies is what
    // asks for a document in another space.
    const resolved = resolveLink(runtime, tx, link, "value", {
      kickCrossSpaceTargets: false,
    });
    const traces = tx.getCfcState().dereferenceTraces.slice(tracesBefore);
    if (traces.length === 0) {
      return { views: [], readFailed: false };
    }
    const viewAt = (
      address: StoredCfcTarget & { path: readonly string[] },
    ): CfcLabelView | undefined =>
      withCfcLabelViewOrigins(
        cfcLabelViewFromMetadata(
          readStoredCfcLabelsForReader(tx, {
            space: address.space,
            id: address.id,
            scope: address.scope,
          }),
          address.path,
        ),
        [address.space],
      );
    return {
      views: [
        ...traces.slice(1).map((trace) =>
          referenceRestrictionsOf(viewAt(trace.source))
        ),
        viewAt(resolved),
      ],
      readFailed: false,
    };
  } catch {
    return { views: [], readFailed: true };
  }
};

/**
 * Acquire a cell's display label view AND report whether a metadata read
 * errored while doing so. `cfcLabelViewForCell` drops the flag (the common
 * consumers treat a missing view as blocked); fail-closed consumers retain it
 * through `cfcLabelViewForCellFailClosedWithStatus`.
 *
 * The view joins the labels the cell's own document stores at the cell's
 * path, the labels of the document holding the value where the path lands on
 * or crosses links, the reference restrictions of the link slots followed on
 * the way there, and any view the cell carries.
 */
export const cfcLabelViewForCellWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  const { view, readFailed } = cfcLabelViewSourceForCell(cell);
  return { view, readFailed };
};

/**
 * {@link cfcLabelViewForCellWithStatus}, also naming the spaces of the
 * documents the view was derived from, the carried part included (see
 * {@link CfcLabelViewSource}). A carried view that crossed a worker boundary
 * or a persisted link names no space.
 */
export const cfcLabelViewSourceForCell = (
  cell: unknown,
): CfcLabelViewSource => {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    const view = getCarriedCfcLabelView(cell);
    return {
      view,
      readFailed: false,
      spaces: cfcLabelViewOriginSpaces(view),
    };
  }

  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    const view = getCarriedCfcLabelView(cell);
    return {
      view,
      readFailed: false,
      spaces: cfcLabelViewOriginSpaces(view),
    };
  }

  const stored = storedMetadataForCell(cell as LabelQueryableCell, link);
  const metadataView = withCfcLabelViewOrigins(
    cfcLabelViewFromMetadata(stored.metadata, link.path),
    [link.space],
  );
  const followed = followedLabelViewsForCell(
    cell as LabelQueryableCell,
    link,
  );
  const view = mergeCfcLabelViews([
    metadataView,
    ...followed.views,
    getCarriedCfcLabelView(cell),
  ]);
  return {
    view,
    readFailed: stored.readFailed || followed.readFailed,
    spaces: cfcLabelViewOriginSpaces(view),
  };
};

export const cfcLabelViewForCell = (
  cell: unknown,
): CfcLabelView | undefined => cfcLabelViewForCellWithStatus(cell).view;

/** Options for a label read that resolves the cell's path through links. */
export type ResolvedLabelReadOptions = {
  /**
   * Whether resolving the path kicks a sync of each hop target in another
   * space. On by default. A reader that resolves a link its caller's value
   * read has already resolved, and so already kicked, turns it off.
   */
  kickCrossSpaceTargets?: boolean;
};

type ResolvedMetadataResult = StoredMetadataResult & {
  /** The resolved doc's path, which the view is rebased against. */
  path: readonly string[];
};

/**
 * The stored labels a reader of the doc that actually HOLDS the value at
 * `link` answers to, that doc found by the runtime's own link resolution — the
 * following `.get()` performs. They are read by the reader rule
 * (`readStoredCfcLabelsForReader`): the doc's own envelope, joined, where the
 * doc is a scoped instance, with the confidentiality a value read of each
 * broader instance consumes. `metadata` is `undefined` only when none of those
 * instances stores a label.
 *
 * A labeled read commonly sits behind a link its path crosses part way
 * through: a sqlite query result splits each row into its own entity doc and
 * stores the row's labels there, so `q/result/0/secret` crosses a link at
 * `result/0` and its label is two docs away from the doc the path started in.
 */
const resolvedMetadataForCell = (
  cell: LabelQueryableCell,
  link: NormalizedFullLink,
  options: ResolvedLabelReadOptions,
): ResolvedMetadataResult => {
  if (!isCell(cell)) {
    return { metadata: undefined, readFailed: false, path: link.path };
  }
  try {
    const runtime = cellRuntime(cell);
    const tx = runtime.readTx(cellTx(cell));
    // `markIfcCrossings` is what a read entry point passes. On the CLI's path
    // it changes nothing observable: the cell carries no transaction, so
    // `readTx` mints a throwaway that is never committed and the marks die
    // with it. It is here for a caller that hands in a cell with a LIVE
    // transaction, where an ifc-bearing link crossed to reach a label counts
    // against that transaction's accounting like any other crossing.
    const resolved = resolveLink(runtime, tx, link, "value", {
      markIfcCrossings: true,
      ...(options.kickCrossSpaceTargets === false
        ? { kickCrossSpaceTargets: false }
        : {}),
    });
    return {
      metadata: readStoredCfcLabelsForReader(tx, {
        space: resolved.space,
        id: resolved.id,
        scope: resolved.scope,
      }),
      readFailed: false,
      path: resolved.path,
    };
  } catch {
    return { metadata: undefined, readFailed: true, path: link.path };
  }
};

/**
 * The labels a reader of the document that holds the value at `cell`'s path
 * answers to ({@link resolvedMetadataForCell}), rebased onto that value, or
 * undefined when `cell` names no document.
 */
const resolvedTargetLabelView = (
  cell: unknown,
  options: ResolvedLabelReadOptions,
): CfcLabelViewStatus | undefined => {
  if (
    !isObjectOrArray(cell) ||
    typeof cell.getAsNormalizedFullLink !== "function"
  ) {
    return undefined;
  }
  let link: NormalizedFullLink;
  try {
    link = (cell as LabelQueryableCell).getAsNormalizedFullLink();
  } catch {
    return undefined;
  }
  const resolved = resolvedMetadataForCell(
    cell as LabelQueryableCell,
    link,
    options,
  );
  return {
    view: cfcLabelViewFromMetadata(resolved.metadata, resolved.path),
    readFailed: resolved.readFailed,
  };
};

/**
 * The labels a reader of the document that holds the value at `cell`'s path
 * answers to, that document found by the runtime's own link resolution, rebased
 * onto that value: the document's own envelope and, where it is a scoped
 * instance, the confidentiality a value read of each broader instance of the
 * same id consumes. Its integrity is the document's own alone.
 *
 * It leaves out the labels of the documents the path passes through on the way
 * there, and any view the cell carries. A label on a document that holds a
 * link is about the link: what integrity it carries endorses the reference,
 * not the current contents of its target (spec §3.7.2, §8.2.4). This is
 * therefore the view that says what vouches for the value itself, which is what
 * a check requiring integrity of the value reads. It is undefined when none of
 * those instances stores a label, and when the read fails.
 */
export const cfcLabelViewForResolvedTarget = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelView | undefined => resolvedTargetLabelView(cell, options)?.view;

/**
 * {@link cfcLabelViewForCellWithStatus}, read by a resolution that takes
 * {@link ResolvedLabelReadOptions}: it kicks a sync of each hop target in
 * another space unless told not to, and it counts an ifc-bearing link it
 * crosses against the cell's live transaction.
 *
 * It is the read for an inspection or display surface that answers "what is
 * the label here" about a path a person typed or a value a view is bound to,
 * where no value read has asked for the documents the path reaches. The
 * labels of the doc the path RESOLVES to, as
 * {@link cfcLabelViewForResolvedTarget} reads them, are merged into the view,
 * rebased so its entries stay relative to the selected cell.
 *
 * Merging is keyed per (observation class, path) with a union of the labels,
 * so the labels both reads find appear once. `readFailed` stays fail-closed
 * across both: a resolution that throws is a failed read, not an absent label.
 */
export const cfcLabelViewForResolvedCellWithStatus = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelViewStatus => {
  const unresolved = cfcLabelViewForCellWithStatus(cell);
  const target = resolvedTargetLabelView(cell, options);
  if (target === undefined) return unresolved;
  return {
    view: mergeCfcLabelViews([unresolved.view, target.view]),
    readFailed: unresolved.readFailed || target.readFailed,
  };
};

/**
 * The label view a display surface shows for a cell: the view-only form of
 * {@link cfcLabelViewForResolvedCellWithStatus}. A value bound to a label
 * display is commonly reached across a link part way along its path, as a
 * list element that links to the document holding the value, and the label
 * that vouches for that value is stored on the linked document.
 */
export const cfcLabelViewForResolvedCell = (
  cell: unknown,
  options: ResolvedLabelReadOptions = {},
): CfcLabelView | undefined =>
  cfcLabelViewForResolvedCellWithStatus(cell, options).view;

/**
 * Fail-closed label acquisition for the LLM-observation egress path (audit 22),
 * including whether a metadata read failed. When a read fails, the returned
 * view is tainted at the root with `CFC_LABEL_READ_FAILED_ATOM`, so every
 * observation node under it fails any declared confidentiality ceiling and is
 * redacted rather than serialized to the model as public. A cleanly-absent
 * label (no read error) is unchanged, so normal unlabelled data is not
 * over-redacted.
 */
export const cfcLabelViewForCellFailClosedWithStatus = (
  cell: unknown,
): CfcLabelViewStatus => {
  const { view, readFailed } = cfcLabelViewForCellWithStatus(cell);
  if (!readFailed) {
    return { view, readFailed };
  }
  return {
    view: mergeCfcLabelViews([
      view,
      {
        version: 1,
        entries: [{
          path: [],
          label: { confidentiality: [CFC_LABEL_READ_FAILED_ATOM] },
        }],
      },
    ]),
    readFailed,
  };
};

/** The view-only surface of fail-closed label acquisition. */
export const cfcLabelViewForCellFailClosed = (
  cell: unknown,
): CfcLabelView | undefined =>
  cfcLabelViewForCellFailClosedWithStatus(cell).view;
