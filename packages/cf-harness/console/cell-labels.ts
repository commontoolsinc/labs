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

import type {
  HarnessCellLabelEntry,
  HarnessCellLabelRecord,
  HarnessCellLabels,
  HarnessCfcAtom,
} from "../src/contracts/cell-labels.ts";

/** The labels at one path of a cell, named for showing. */
export interface ConsoleCellLabelEntry {
  /** The path inside the cell, `/`-joined; empty for the cell itself. */
  path: string;
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
 * `byAddress` is keyed by both the entity id and the canonical reference the
 * run held, because a cell is named one way in a handle table and another in
 * an argument written as a whole link, and both have to find the same labels.
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
    path: entry.path.join("/"),
    confidentiality: entry.confidentiality.map((atom) => atom.name),
    integrity: entry.integrity.map((atom) => atom.name),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.observes !== undefined ? { observes: entry.observes } : {}),
    ...(producer !== undefined ? { transformedBy: producer } : {}),
  };
};

/** One recorded cell, reduced to what a chip and a card show. */
export const consoleCellLabels = (
  record: HarnessCellLabelRecord,
): ConsoleCellLabels => {
  const entries = record.entries.map(entryOf);
  return {
    confidentiality: dedupe(entries.flatMap((entry) => entry.confidentiality)),
    integrity: dedupe(entries.flatMap((entry) => entry.integrity)),
    derived: entries.some((entry) => entry.origin === "derived"),
    transformedBy: dedupe(
      entries.flatMap((entry) =>
        entry.transformedBy === undefined ? [] : [entry.transformedBy]
      ),
    ),
    entries,
  };
};

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
  const byAddress = new Map<string, ConsoleCellLabels>();
  for (const record of snapshot.cells) {
    const labels = consoleCellLabels(record);
    byAddress.set(record.entityId, labels);
    if (record.ref !== undefined) {
      byAddress.set(record.ref, labels);
    }
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
  // Entity ids and refs both key the same labels, so counting the map's
  // values would count most cells twice. The distinct label objects are the
  // cells.
  const cells = new Set(index.byAddress.values());
  return {
    status: index.status,
    ...(index.detail !== undefined ? { detail: index.detail } : {}),
    ...(index.space !== undefined ? { space: index.space } : {}),
    cellsRead: cells.size,
    cellsLabelled: [...cells].filter((labels) => labels.entries.length > 0)
      .length,
  };
};

/**
 * The labels for the cell a reference names. A reference may address a path
 * inside a document while the labels are stored for the document, so a ref
 * that misses is retried against the document it sits in.
 */
export const cellLabelsAt = (
  index: ConsoleCellLabelIndex,
  ref: string | undefined,
): ConsoleCellLabels | undefined => {
  if (ref === undefined) {
    return undefined;
  }
  const direct = index.byAddress.get(ref);
  if (direct !== undefined) {
    return direct;
  }
  // The entity id inside the reference: the segment carrying a URI scheme,
  // which a cross-space link puts after its space DID and a path puts before
  // its own segments.
  const segment = ref.split("/").find((part) =>
    part.startsWith("of:") || part.startsWith("computed:")
  );
  return segment === undefined
    ? undefined
    : index.byAddress.get(segment.split("@")[0]);
};
