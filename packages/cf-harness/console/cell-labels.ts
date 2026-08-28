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
 *   whose space could not be read is a cell nobody asked about.
 * - **Derived against carried.** A value's label may be the join of the
 *   fields it was built from, so a plain input reached through a labelled
 *   object carries a confidentiality atom without having been derived from
 *   anything confidential. `origin` and the provenance atom beside it are
 *   what separate the two, and a reader that colored by the atom alone would
 *   report a plain input as tainted.
 */

import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";

import type {
  HarnessCellLabelEntry,
  HarnessCellLabelRecord,
  HarnessCellLabels,
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
}

/** Why a run shows no labels on any cell, when it shows none. */
export type ConsoleCellLabelsStatus = "read" | "unavailable" | "absent";

/**
 * The run's labels, indexed by the cell they belong to.
 *
 * `byAddress` is keyed by entity, because that is what a label is stored per.
 * A reference names a path inside a document as well as the document, and
 * `cellLabelsAt` is what turns one into the other.
 */
export interface ConsoleCellLabelIndex {
  status: ConsoleCellLabelsStatus;

  /** What an `unavailable` status was, in the words the snapshot used. */
  detail?: string;

  /** The space the labels were read from, once a run finally names one. */
  space?: { configured: string; did?: string; dbPath?: string };

  byAddress: ReadonlyMap<string, ConsoleCellLabels>;
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
});

/** One recorded cell, reduced to what a chip and a card show. */
export const consoleCellLabels = (
  record: HarnessCellLabelRecord,
): ConsoleCellLabels => labelsOfEntries(record.entries.map(entryOf));

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
  const byAddress = new Map<string, ConsoleCellLabels>();
  for (const record of snapshot.cells) {
    // A cell nothing was asked about is left out of the index rather than
    // entered with no labels. Absent, it reads as a cell this run says
    // nothing about, which is what it is; entered, it would read as one the
    // space holds no label for — and, keyed by entity, it would answer for a
    // cell of the same id in the space that was read.
    if (record.unreadReason !== undefined) {
      continue;
    }
    byAddress.set(record.entityId, consoleCellLabels(record));
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
    cellsLabelled: cells.filter((labels) => labels.entries.length > 0).length,
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
 * Whether `prefix` covers `path`, over the segments a stored label path is
 * written in: `*` stands for every member of a container, so it matches any
 * concrete segment and any concrete segment matches it.
 *
 * Mirrors `cfcLabelPathPrefixMatches` in
 * `packages/runner/src/cfc/label-view-core.ts`, which is the definition of
 * this relation and of the re-rooting below it in `rebaseCfcLabelView`. It is
 * not exported from `@commonfabric/runner/cfc`, so it is restated here; the
 * two are one rule and a change to that one belongs here too.
 */
const pathPrefixMatches = (
  prefix: readonly string[],
  path: readonly string[],
): boolean =>
  prefix.length <= path.length &&
  prefix.every((segment, index) =>
    segment === path[index] || segment === "*" || path[index] === "*"
  );

/**
 * The labels of one document, narrowed to a path inside it.
 *
 * Labels are stored per document, and a run holds a reference per cell — two
 * cells of one piece are two references into one document. Handing both the
 * document's whole label set would put one cell's atom on the other, which is
 * the same mistake as coloring a plain input by the label of the object it
 * was reached through. So an entry counts for a reference only where the
 * reference's path reaches it: an entry at or under that path, re-rooted to
 * it, or an entry above it, which governs everything beneath.
 */
const narrow = (
  labels: ConsoleCellLabels,
  path: readonly string[],
): ConsoleCellLabels => {
  if (path.length === 0) {
    return labels;
  }
  const entries: ConsoleCellLabelEntry[] = [];
  for (const entry of labels.entries) {
    if (pathPrefixMatches(path, entry.path)) {
      entries.push({ ...entry, path: entry.path.slice(path.length) });
      continue;
    }
    // An entry above the reference covers it: a label on the document itself,
    // or on anything the reference is reached through, reaches every cell
    // beneath it, and re-roots to the reference's own path.
    if (pathPrefixMatches(entry.path, path)) {
      entries.push({ ...entry, path: [] });
    }
  }
  return labelsOfEntries(entries);
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
 * cell nothing is known about, the same as one the snapshot never covered.
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
    return index.byAddress.get(ref);
  }
  if (address.space !== undefined && address.space !== index.space?.did) {
    return undefined;
  }
  const document = index.byAddress.get(address.entityId);
  return document === undefined ? undefined : narrow(document, address.path);
};
