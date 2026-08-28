/**
 * Reading a space's per-cell CFC labels, offline and read-only.
 *
 * The labels a run's cells carry live in the space's own durable store, not in
 * the run's artifact tree, so a reader working from artifacts alone sees a
 * cell with no label on it however loudly the run was enforcing. This module
 * opens the space SQLite the server already wrote — the same read-only lens
 * `cf inspect` uses — and answers "what is this cell labelled" for the cells a
 * run held a reference to.
 *
 * Nothing here writes: the database is opened read-only, and a failure is
 * returned as an unavailable snapshot rather than thrown, because a run whose
 * space cannot be read is still a run to record.
 */

import {
  decodedLinkOf,
  discoverSpaceDbs,
  openSpace,
  reconstructOutcome,
  resolveSpace,
  type SpaceDb,
} from "@commonfabric/state-inspector";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelEntry,
  type HarnessCellLabelRecord,
  type HarnessCellLabels,
  type HarnessCfcAtom,
} from "./contracts/cell-labels.ts";

/** The atom type whose identity resolves a derived value to its producer. */
const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One stored atom, normalized. A string atom is its own type and its own
 * name; an object atom names its type by URL and keeps every other field it
 * carried, so an atom this module has no special reading for still arrives
 * whole at whoever shows it.
 *
 * A disjunctive confidentiality clause — the one record shape whose sole key
 * is `anyOf` — is one requirement satisfiable several ways, so it arrives as
 * one atom carrying its alternatives rather than as several atoms, which
 * would read as several requirements.
 */
const atomOf = (value: unknown): HarnessCfcAtom | undefined => {
  if (typeof value === "string") {
    return { type: value, name: value };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "anyOf" && Array.isArray(value.anyOf)) {
    const alternatives = atomsOf(value.anyOf);
    return {
      type: "anyOf",
      name: alternatives.map((atom) => atom.name).join(" or ") || "anyOf",
      anyOf: alternatives,
    };
  }
  if (typeof value.type !== "string") {
    return undefined;
  }
  const { type, ...fields } = value;
  const name = type.split("/").pop() ?? type;
  return Object.keys(fields).length === 0
    ? { type, name }
    : { type, name, fields };
};

const atomsOf = (value: unknown): HarnessCfcAtom[] =>
  Array.isArray(value)
    ? value.flatMap((clause) => {
      const atom = atomOf(clause);
      return atom === undefined ? [] : [atom];
    })
    : [];

/** The labels one stored document holds, and the schema they were cut to. */
interface StoredCellLabels {
  entries: HarnessCellLabelEntry[];
  schemaHash?: string;
}

/**
 * The labelled paths of one stored document. The document's `cfc` path holds
 * a `labelMap` whose entries each name a path and the label sitting at it; a
 * document with no `cfc` path has no labels, which is a finding rather than a
 * failure. Several entries may name one path, differing in what produced them
 * and what they observed, and all of them are kept: the effective label at a
 * path is the join of its components, so dropping one changes the answer.
 */
const labelsOf = (
  document: Record<string, unknown> | undefined,
): StoredCellLabels => {
  const cfc = document?.cfc;
  if (!isRecord(cfc)) {
    return { entries: [] };
  }
  const labelMap = cfc.labelMap;
  const stored = isRecord(labelMap) && Array.isArray(labelMap.entries)
    ? labelMap.entries
    : [];
  const entries: HarnessCellLabelEntry[] = [];
  for (const raw of stored) {
    if (!isRecord(raw)) {
      continue;
    }
    const label = isRecord(raw.label) ? raw.label : {};
    const integrity = atomsOf(label.integrity);
    const transformedBy = integrity.find((atom) =>
      atom.type === TRANSFORMED_BY
    );
    entries.push({
      path: Array.isArray(raw.path)
        ? raw.path.filter((segment): segment is string =>
          typeof segment === "string"
        )
        : [],
      confidentiality: atomsOf(label.confidentiality),
      integrity,
      ...(typeof raw.origin === "string" ? { origin: raw.origin } : {}),
      ...(typeof raw.observes === "string" ? { observes: raw.observes } : {}),
      ...(transformedBy !== undefined ? { transformedBy } : {}),
    });
  }
  return {
    entries,
    ...(typeof cfc.schemaHash === "string"
      ? { schemaHash: cfc.schemaHash }
      : {}),
  };
};

/** The document and scope a reference names, or `undefined` for a non-link. */
export interface CellAddress {
  /** The entity as the store ids it (`of:fid1:…`). */
  id: string;

  /**
   * The scope kind the reference names, `space` unless it says otherwise. A
   * labelMap is written at the same scope as the document it labels, so a
   * per-user override's labels are not in the space scope.
   *
   * A reference names the kind and not the principal, though, while the store
   * partitions by principal — `user:<did>`, not `user`. So a scoped reference
   * addresses no row on its own, and the read falls back to the base scope,
   * whose labels every scope inherits. What that cannot report is a label an
   * override introduced and the base scope does not carry.
   */
  scope: string;
}

/**
 * The cell a reference addresses. The harness holds an LLM-friendly link
 * (`/of:fid1:…/path`, or `/@did:key:…/of:fid1:…` across spaces); labels are
 * stored per document, so the document is what a lookup keys on and a path
 * inside one resolves to the document that holds it.
 */
export const cellAddressOfRef = (ref: string): CellAddress | undefined => {
  const trimmed = ref.trim();
  try {
    const link = parseLLMFriendlyLink(
      trimmed.startsWith("/") ? trimmed : `/${trimmed}`,
    );
    return link.id === undefined
      ? undefined
      : { id: link.id, scope: link.scope ?? "space" };
  } catch {
    return undefined;
  }
};

/**
 * The cells one document links to, by the key that names each. A pattern's
 * results are their own cells rather than paths inside the piece that names
 * them, so following these one hop is what puts a derived label where a
 * reader looks for it.
 */
const linkedCellsOf = (
  document: Record<string, unknown> | undefined,
  space: string | undefined,
): { key: string; id: string }[] => {
  const value = document?.value;
  if (!isRecord(value)) {
    return [];
  }
  const linked: { key: string; id: string }[] = [];
  for (const [key, held] of Object.entries(value)) {
    const link = decodedLinkOf(held as never);
    if (link?.id === undefined || link.id === null) {
      continue;
    }
    // A link naming another space addresses a store this reader did not
    // open. One naming this space, or naming none, is a cell here.
    if (
      link.space === undefined || link.space === null || space === undefined ||
      link.space === space
    ) {
      linked.push({ key, id: link.id });
    }
  }
  return linked;
};

/** A space DB opened for reading labels, and the space it was resolved from. */
export interface SpaceLabelReader {
  readonly dbPath: string;
  readonly did?: string;

  /**
   * The labels stored for one cell, and for the cells it links to one hop
   * out. A linked cell's entries arrive under the key that named it, and say
   * which cell they were read from, so the two are never confused.
   *
   * An entity that holds no document — never written, deleted, or
   * undecodable — reads as no labels, the same as one whose document carries
   * no `cfc` path: neither is a label this reader can report, and one corrupt
   * entity does not end the walk.
   */
  read(address: CellAddress): StoredCellLabels & {
    linked: { key: string; id: string }[];
  };
  close(): void;
}

/**
 * Opens the space named by a run's fabric session configuration — a space
 * name, a DID, a DID prefix, or a path to the file itself. Throws when no
 * database on this host matches, which is the caller's cue to record an
 * unavailable snapshot rather than a bare one.
 */
export const openSpaceLabelReader = async (
  space: string,
  options: { dbPath?: string } = {},
): Promise<SpaceLabelReader> => {
  const discovered = options.dbPath === undefined
    ? discoverSpaceDbs()
    : undefined;
  const dbPath = options.dbPath ?? await resolveSpace(space, discovered);
  const opened: SpaceDb = openSpace(dbPath);
  const did = discovered?.find((entry) => entry.path === dbPath)?.did;
  return {
    dbPath,
    ...(did !== undefined ? { did } : {}),
    read: (address) => {
      // The named scope, then the base scope it inherits from: a reference
      // carries a scope kind rather than a principal, so a scoped one
      // addresses no stored row and would otherwise read as unlabelled.
      const outcome = [address.scope, "space"]
        .filter((scope, index, scopes) => scopes.indexOf(scope) === index)
        .map((scope) => reconstructOutcome(opened, { id: address.id, scope }))
        .find((candidate) => candidate.status === "present");
      if (outcome === undefined || outcome.status !== "present") {
        return { entries: [], linked: [] };
      }
      const own = labelsOf(outcome.document);
      const linked = linkedCellsOf(outcome.document, did);
      const entries = [...own.entries];
      for (const { key, id } of linked) {
        const target = reconstructOutcome(opened, { id, scope: "space" });
        if (target.status !== "present") {
          continue;
        }
        for (const entry of labelsOf(target.document).entries) {
          entries.push({ ...entry, path: [key, ...entry.path], source: id });
        }
      }
      return { ...own, entries, linked };
    },
    close: () => opened.close(),
  };
};

/** What a snapshot is taken over: the cells a run held a reference to. */
export interface SpaceLabelSnapshotRequest {
  /** The space as the run was configured with it. */
  space: string;

  /** An explicit database file, for a host whose store is not discoverable. */
  dbPath?: string;

  /** The references the run held, in the order it minted them. */
  refs: readonly string[];

  generatedAt: string;
}

/**
 * The label snapshot for one run: every reference it held, resolved to the
 * document it names and read against the space.
 *
 * A reference that names no document is dropped rather than recorded empty —
 * it addresses nothing this reader can ask about, and an empty record would
 * read as a cell the space holds no label for. Every other failure lands on
 * the snapshot as a whole, so a reader can tell "no labels" from "not read".
 */
export const readSpaceCellLabels = async (
  request: SpaceLabelSnapshotRequest,
): Promise<HarnessCellLabels> => {
  const base = {
    type: HARNESS_CELL_LABELS_TYPE,
    version: 1,
    generatedAt: request.generatedAt,
  } as const;
  let reader: SpaceLabelReader;
  try {
    reader = await openSpaceLabelReader(request.space, {
      ...(request.dbPath !== undefined ? { dbPath: request.dbPath } : {}),
    });
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason: "space-not-found",
      unavailableDetail: error instanceof Error ? error.message : String(error),
      space: { configured: request.space },
      cells: [],
    };
  }
  const space = {
    configured: request.space,
    ...(reader.did !== undefined ? { did: reader.did } : {}),
    dbPath: reader.dbPath,
  };
  try {
    const cells: HarnessCellLabelRecord[] = [];
    const seen = new Set<string>();
    for (const ref of request.refs) {
      const address = cellAddressOfRef(ref);
      if (address === undefined) {
        continue;
      }
      const key = `${address.scope}\x00${address.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const read = reader.read(address);
      cells.push({
        entityId: address.id,
        ref,
        ...(read.schemaHash !== undefined
          ? { schemaHash: read.schemaHash }
          : {}),
        entries: read.entries,
      });
    }
    return { ...base, status: "read", space, cells };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      unavailableReason: "read-failed",
      unavailableDetail: error instanceof Error ? error.message : String(error),
      space,
      cells: [],
    };
  } finally {
    reader.close();
  }
};
