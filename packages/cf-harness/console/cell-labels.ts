/**
 * The per-cell CFC labels a run recorded, as the page reads them.
 *
 * A run's `cell-labels.json` is the join between the run's artifact tree and
 * the space it wrote into: the tree knows which cells the run touched, the
 * space knows what each of them is labelled. This module turns that artifact
 * into something a cell chip can show — an index keyed by the address a cell
 * goes by, and per-cell facts already reduced to the names a badge writes.
 *
 * Two distinctions are kept rather than flattened, because collapsing either
 * one makes the page lie:
 *
 * - **Read against unread.** A cell with no atoms under a snapshot that was
 *   taken is a cell the space holds no label for. The same cell under a run
 *   whose space could not be read is a cell nobody asked about. It holds per
 *   path as well as per run: a link the snapshot could not follow leaves the
 *   path it sat at unread, and every cell at or under that path with it. A
 *   cell whose read ran out partway states less again — that its labels are
 *   some of what the space holds, without naming which paths it missed.
 * - **Derived against carried.** A value's label may be the join of the
 *   fields it was built from, so a plain input reached through a labelled
 *   object carries a confidentiality atom without having been derived from
 *   anything confidential. `origin` and the provenance atom beside it are
 *   what separate the two, and a reader that colored by the atom alone would
 *   report a plain input as tainted.
 */

import {
  canonicalizeCfcLogicalPath,
  cfcLabelPathPrefixMatches,
  type CfcLabelView,
  type IFCLabel,
  type LabelObservationClass,
  rebaseCfcLabelView,
} from "@commonfabric/runner/cfc/label-view-core";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";

import type {
  HarnessCellLabelEntry,
  HarnessCellLabelRecord,
  HarnessCellLabels,
  HarnessCellLabelTruncationReason,
  HarnessCfcAtom,
} from "../src/contracts/cell-labels.ts";

/** The labels at one path of a cell, named for showing. */
export interface ConsoleCellLabelEntry {
  /**
   * The path inside the cell, segment by segment; empty for the cell itself.
   * Kept as segments rather than joined, because a segment may hold the
   * separator and a stored path may hold the `*` that stands for every
   * member of a container — both of which a joined string loses. Joining is
   * for showing, and belongs to whoever shows it.
   */
  path: readonly string[];
  confidentiality: readonly string[];
  integrity: readonly string[];
  origin?: string;
  observes?: string;

  /** The implementation that produced this value, when one is recorded. */
  transformedBy?: string;
}

/** Everything the space says about one cell. */
export interface ConsoleCellLabels {
  /** Every confidentiality atom at any path, deduplicated. */
  confidentiality: readonly string[];

  /** Every integrity atom at any path, deduplicated. */
  integrity: readonly string[];

  /**
   * Whether any of it was computed from what a function read, rather than
   * declared on a schema or carried in on a reference. This is the fact a
   * confidentiality atom on its own does not establish.
   */
  derived: boolean;

  /** The implementations that produced the derived paths, if any. */
  transformedBy: readonly string[];

  /** The labels path by path, for a reader that wants the whole of it. */
  entries: readonly ConsoleCellLabelEntry[];

  /**
   * The paths beneath this cell that nothing was read for — a link the
   * snapshot could not follow, or a path lying deeper than it descends — and
   * absent where it read every one. A reference landing at or under one of
   * them has no answer here at all — {@link cellLabelsAt} returns nothing for
   * it — and the cell itself keeps them so that what is missing from
   * `entries` is on the record rather than inferred from its absence.
   */
  unreadPaths?: readonly (readonly string[])[];

  /**
   * Why the snapshot did not finish reading this cell, when it did not. It
   * says less than `unreadPaths` and about the cell rather than about a path:
   * the snapshot stopped before enumerating what it had left, so it can name
   * no path, and everything here is some of what the space holds rather than
   * all of it. A path with no entry under it is unknown, and a reader that
   * showed this cell as fully labelled would be reporting the reading it did
   * not finish as the answer.
   */
  truncationReason?: HarnessCellLabelTruncationReason;
}

/** Why a run shows no labels on any cell, when it shows none. */
export type ConsoleCellLabelsStatus = "read" | "unavailable" | "absent";

/**
 * The run's labels, indexed by the cell they belong to.
 *
 * `byAddress` is keyed by entity, because that is what a label is stored per,
 * and holds the artifact's own record rather than the names a badge writes.
 * A reference names a path inside a document as well as the document, and
 * `cellLabelsAt` is what turns one into the other — narrowing over the
 * structural labels the space stored, and reducing to names after.
 */
export interface ConsoleCellLabelIndex {
  status: ConsoleCellLabelsStatus;

  /** What an `unavailable` status was, in the words the snapshot used. */
  detail?: string;

  /** The space the labels were read from, once a run finally names one. */
  space?: { configured: string; did?: string; dbPath?: string };

  byAddress: ReadonlyMap<string, HarnessCellLabelRecord>;
}

/** The run-level fact, without the index — what crosses to the page. */
export interface ConsoleCellLabelsSummary {
  status: ConsoleCellLabelsStatus;
  detail?: string;
  space?: { configured: string; did?: string; dbPath?: string };

  /** How many cells the snapshot read, and how many of them carry a label. */
  cellsRead: number;
  cellsLabelled: number;
}

const dedupe = (names: readonly string[]): string[] => [...new Set(names)];

/** What a provenance atom's identity resolves to, in as few words as carry it. */
const producerOf = (atom: HarnessCfcAtom | undefined): string | undefined => {
  const identity = atom?.fields?.identity;
  if (typeof identity !== "object" || identity === null) {
    return undefined;
  }
  const fields = identity as Record<string, unknown>;
  const named = (key: string): string | undefined =>
    typeof fields[key] === "string" ? fields[key] as string : undefined;
  // A builtin names itself; a verified implementation is named by its symbol
  // within its module, and by its module alone when the symbol is absent.
  const builtin = named("builtinId");
  if (builtin !== undefined) {
    return builtin;
  }
  const symbol = named("symbol");
  const module = named("moduleIdentity");
  if (symbol !== undefined) {
    return module === undefined ? symbol : `${symbol} in ${module}`;
  }
  return module ?? named("className");
};

const entryOf = (entry: HarnessCellLabelEntry): ConsoleCellLabelEntry => {
  const producer = producerOf(entry.transformedBy);
  return {
    path: [...entry.path],
    confidentiality: entry.confidentiality.map((atom) => atom.name),
    integrity: entry.integrity.map((atom) => atom.name),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    ...(producer !== undefined ? { transformedBy: producer } : {}),
  };
};

/** The cell-level facts a set of entries adds up to. */
const labelsOfEntries = (
  entries: readonly ConsoleCellLabelEntry[],
  unreadPaths: readonly (readonly string[])[],
  truncationReason: HarnessCellLabelTruncationReason | undefined,
): ConsoleCellLabels => ({
  confidentiality: dedupe(entries.flatMap((entry) => entry.confidentiality)),
  integrity: dedupe(entries.flatMap((entry) => entry.integrity)),
  derived: entries.some((entry) => entry.origin === "derived"),
  transformedBy: dedupe(
    entries.flatMap((entry) =>
      entry.transformedBy === undefined ? [] : [entry.transformedBy]
    ),
  ),
  entries,
  ...(unreadPaths.length > 0 ? { unreadPaths } : {}),
  ...(truncationReason !== undefined ? { truncationReason } : {}),
});

/** The paths of one record nothing was read for, as the page compares them. */
const unreadPathsOf = (
  record: HarnessCellLabelRecord,
): readonly string[][] =>
  (record.unreadPaths ?? []).map((unread) =>
    canonicalizeCfcLogicalPath(unread.path)
  );

/** One recorded cell, reduced to what a chip and a card show. */
export const consoleCellLabels = (
  record: HarnessCellLabelRecord,
): ConsoleCellLabels =>
  labelsOfEntries(
    record.entries.map(entryOf),
    unreadPathsOf(record),
    record.truncationReason,
  );

/**
 * The whole snapshot, indexed. A run that wrote no snapshot is `absent`
 * rather than empty: the artifact is written after a turn, so a run still
 * going has not reached one, and that is not the same as a space with
 * nothing to say.
 */
export const consoleCellLabelIndex = (
  snapshot: HarnessCellLabels | undefined,
): ConsoleCellLabelIndex => {
  if (snapshot === undefined) {
    return { status: "absent", byAddress: new Map() };
  }
  // Keyed by entity, and by entity alone: a reference names a path inside a
  // document as well as the document, and two references into one document
  // narrow to different cells. Keying a whole document's labels under one of
  // its references would hand every cell of it the same answer.
  const byAddress = new Map<string, HarnessCellLabelRecord>();
  for (const record of snapshot.cells) {
    // A cell nothing was asked about is left out of the index rather than
    // entered with no labels. Absent, it reads as a cell this run says
    // nothing about, which is what it is; entered, it would read as one the
    // space holds no label for — and, keyed by entity, it would answer for a
    // cell of the same id in the space that was read.
    if (record.unreadReason !== undefined) {
      continue;
    }
    byAddress.set(record.entityId, record);
  }
  return {
    status: snapshot.status === "read" ? "read" : "unavailable",
    ...(snapshot.unavailableDetail !== undefined
      ? { detail: snapshot.unavailableDetail }
      : {}),
    ...(snapshot.space !== undefined ? { space: snapshot.space } : {}),
    byAddress,
  };
};

/** The run-level fact the map and the run header state. */
export const consoleCellLabelsSummary = (
  index: ConsoleCellLabelIndex,
): ConsoleCellLabelsSummary => {
  const cells = [...index.byAddress.values()];
  return {
    status: index.status,
    ...(index.detail !== undefined ? { detail: index.detail } : {}),
    ...(index.space !== undefined ? { space: index.space } : {}),
    cellsRead: cells.length,
    cellsLabelled: cells.filter((record) => record.entries.length > 0).length,
  };
};

/** The entity a reference names, and the path inside it the reference walks. */
interface ConsoleCellAddress {
  entityId: string;
  path: readonly string[];
  space?: string;
}

/**
 * A JSON Pointer split into its segments, `~1` decoding to `/` and `~0` to
 * `~`. Mirrors `parsePointer` in `packages/memory/v2/path.ts`, which is the
 * definition; two lines of it are restated rather than imported, so that the
 * module the page reads its cell types from takes on no package for one
 * string function.
 */
const pointerSegments = (pointer: string): string[] =>
  pointer.split("/").slice(1).map((segment) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~")
  );

/**
 * The address of a reference the canonical parser will not take — one whose
 * id is shorter than a minted handle, which it reads as a human name. The
 * pointer is decoded by the same rule either way, so a segment holding a
 * separator survives the fallback as it does the parse.
 */
const looseAddressOf = (ref: string): ConsoleCellAddress | undefined => {
  const segments = pointerSegments(ref.startsWith("/") ? ref : `/${ref}`);
  const at = segments.findIndex((segment) =>
    segment.startsWith("of:") || segment.startsWith("computed:")
  );
  if (at < 0) {
    return undefined;
  }
  const space = segments.slice(0, at).find((segment) =>
    segment.startsWith("@")
  );
  return {
    entityId: segments[at].split("@")[0],
    path: segments.slice(at + 1),
    ...(space === undefined ? {} : { space: space.slice(1) }),
  };
};

/**
 * The address a reference resolves to. Parsed rather than split: a reference
 * is a JSON Pointer, so a segment holding a `/` or a `~` is escaped in it,
 * and splitting on the separator would cut such a segment in two and leave
 * neither half matching anything.
 */
const addressOf = (ref: string): ConsoleCellAddress | undefined => {
  const trimmed = ref.trim();
  try {
    const link = parseLLMFriendlyLink(
      trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
    );
    return link.id === undefined ? undefined : {
      entityId: link.id,
      path: link.path,
      ...(link.space ? { space: link.space } : {}),
    };
  } catch {
    return looseAddressOf(trimmed);
  }
};

/**
 * The label a stored entry crosses the rebase under, standing for "this entry
 * carries one". Its only job is to be non-empty, because
 * {@link rebaseCfcLabelView} keeps an entry only while its label holds
 * something; nothing reads its interior, and no atom of it reaches the page.
 */
const ENTRY_PRESENT: IFCLabel = { integrity: ["cf-harness/label-entry"] };

/**
 * One stored entry as a label view of its own, which is the form
 * {@link rebaseCfcLabelView} narrows. One entry per view rather than the
 * whole set in one: the canonical rebase merges the labels of entries that
 * land on one path, and `origin` and the provenance beside it belong to the
 * entry that carried them, so a merged label could no longer say which of
 * them was computed and which was declared.
 *
 * What crosses is {@link ENTRY_PRESENT} rather than the atoms the space
 * stored, because the two facts this caller takes from the rebase — whether
 * the entry reaches the path asked about, and what path it re-roots to —
 * depend on a label only through its being non-empty. The atoms the page
 * shows are read back off the stored entry, so the normalization and
 * structural deduplication the rebase performs on a label it merges reach
 * nothing a reader sees. An entry the space stored with no atoms in either
 * dimension crosses under an empty label, which the rebase drops: a path
 * labelled with nothing stays a path with no entry.
 */
const labelViewOfEntry = (entry: HarnessCellLabelEntry): CfcLabelView => ({
  version: 1,
  entries: [{
    path: entry.path,
    label: entry.confidentiality.length > 0 || entry.integrity.length > 0
      ? ENTRY_PRESENT
      : {},
    // The space is the authority on what it observed, so the recorded class
    // crosses as it stands. One it named that CFC has no rule for is not a
    // content observation, and the rebase treats it as one it cannot inherit
    // down — which is the reading that grafts no label onto a cell beneath.
    ...(entry.observes !== undefined
      ? { observes: entry.observes as LabelObservationClass }
      : {}),
  }],
});

/**
 * The labels of one document, narrowed to a path inside it.
 *
 * Labels are stored per document, and a run holds a reference per cell — two
 * cells of one piece are two references into one document. Handing both the
 * document's whole label set would put one cell's atom on the other, which is
 * the same mistake as coloring a plain input by the label of the object it
 * was reached through. So an entry counts for a reference only where CFC's
 * own re-rooting says it reaches: `rebaseCfcLabelView` is the definition of
 * that relation, and the page answers by it so that what the console shows at
 * a path is what the runtime enforces there.
 *
 * A reference at or under a path nothing was read for has no answer at all.
 * That is the read-against-unread distinction one level down from the
 * snapshot: a link the walk could not follow, or a path it sat too shallow to
 * reach, leaves its key holding no entry, and an empty label set there would
 * read as a cell the space holds no label for.
 *
 * A cell the walk did not finish carries its {@link
 * ConsoleCellLabels.truncationReason} down to every path instead. The paths
 * it missed were never enumerated, so no path can be refused on their
 * account; what the reader owes such a cell is to show its labels as partial
 * rather than to show them as all there is.
 */
const narrow = (
  record: HarnessCellLabelRecord,
  path: readonly string[],
): ConsoleCellLabels | undefined => {
  const unread = unreadPathsOf(record);
  const logical = canonicalizeCfcLogicalPath(path);
  if (unread.some((each) => cfcLabelPathPrefixMatches(each, logical))) {
    return undefined;
  }
  const entries: ConsoleCellLabelEntry[] = [];
  for (const entry of record.entries) {
    const rebased = rebaseCfcLabelView(labelViewOfEntry(entry), path)
      ?.entries[0];
    if (rebased !== undefined) {
      entries.push({ ...entryOf(entry), path: [...rebased.path] });
    }
  }
  // The cell's truncation crosses to every path inside it: the walk that did
  // not finish did not finish for any of them, and where it stopped is not
  // something a path can be compared against.
  return labelsOfEntries(
    entries,
    unread.flatMap((each) =>
      cfcLabelPathPrefixMatches(logical, each)
        ? [each.slice(logical.length)]
        : []
    ),
    record.truncationReason,
  );
};

/**
 * The labels for the cell a reference names. A reference addresses a path
 * inside a document while the labels are stored for the document, so the
 * document's labels are found first and then narrowed to the path.
 *
 * The index is keyed by entity, and an entity id names a document within its
 * own space, so a reference naming a space other than the one the snapshot
 * was taken in has no answer here: the id it carries would find whichever
 * cell of the read space happens to share it. Such a reference reads as a
 * cell nothing is known about, the same as one the snapshot never covered —
 * and so does one landing at or under a path the snapshot left unread.
 */
export const cellLabelsAt = (
  index: ConsoleCellLabelIndex,
  ref: string | undefined,
): ConsoleCellLabels | undefined => {
  if (ref === undefined) {
    return undefined;
  }
  const address = addressOf(ref);
  if (address === undefined) {
    const keyed = index.byAddress.get(ref);
    return keyed === undefined ? undefined : consoleCellLabels(keyed);
  }
  if (address.space !== undefined && address.space !== index.space?.did) {
    return undefined;
  }
  const document = index.byAddress.get(address.entityId);
  return document === undefined ? undefined : narrow(document, address.path);
};
