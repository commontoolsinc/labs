import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  cellLabelsAt,
  consoleCellLabelIndex,
  consoleCellLabels,
  consoleCellLabelsSummary,
} from "../../console/cell-labels.ts";
import {
  HARNESS_CELL_LABELS_TYPE,
  type HarnessCellLabelEntry,
  type HarnessCellLabelRecord,
  type HarnessCellLabels,
} from "../../src/contracts/cell-labels.ts";

const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";
const SCHEMA_HASH = "fid1:C4ajDsLKcfdMDDs3lbNShZBcQCVA4qhVo5mRoBcgpB0";

/** An entity id in the store's own shape: `of:fid1:` and 44 base64url chars. */
const entity = (name: string) => `of:fid1:${name.padEnd(44, "0")}`;

const LABELLED = entity("labelled");
const BARE = entity("bare");

/** The space a snapshot is taken in, and one it is not. */
const OWN_DID = "did:key:z6MkfrQ3tCDZgvJcLwPTvxNsFR8RgTsHTa5JzmnW9pQrUvNq";
const FOREIGN_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

const atom = (name: string) => ({ type: name, name });

/** The provenance atom for one identity arm, as the space stores it. */
const provenance = (identity: Record<string, unknown>) => ({
  type: TRANSFORMED_BY,
  name: "TransformedBy",
  fields: { identity },
});

const declared: HarnessCellLabelEntry = {
  path: [],
  confidentiality: [atom("demo-secret")],
  integrity: [atom("cf-compiled-by:cf-compiler")],
  origin: "declared",
};

const derived = (identity: Record<string, unknown>): HarnessCellLabelEntry => ({
  path: ["summary"],
  confidentiality: [atom("demo-secret")],
  integrity: [atom("cf-compiled-by:cf-compiler"), provenance(identity)],
  origin: "derived",
  observes: "members",
  transformedBy: provenance(identity),
});

const record = (
  entityId: string,
  ref: string,
  entries: readonly HarnessCellLabelEntry[],
): HarnessCellLabelRecord => ({
  entityId,
  ref,
  schemaHash: SCHEMA_HASH,
  entries,
});

const snapshot = (
  cells: readonly HarnessCellLabelRecord[],
): HarnessCellLabels => ({
  type: HARNESS_CELL_LABELS_TYPE,
  version: 1,
  generatedAt: "2026-01-01T00:00:00.000Z",
  status: "read",
  space: { configured: "demo-space", dbPath: "/spaces/demo.sqlite" },
  cells,
});

const readSnapshot = snapshot([
  record(LABELLED, `/${LABELLED}`, [declared]),
  record(BARE, `/${BARE}`, []),
]);

const PIECE = entity("piece");
const ROOTED = entity("rooted");

const LIFT = { kind: "builtin", builtinId: "llm" };

/**
 * Two documents to narrow into. `PIECE` labels two of its paths and leaves a
 * third unlabelled, which is the shape a run holding one reference per cell of
 * a piece produces; `ROOTED` labels the document itself.
 */
const pieceSnapshot = snapshot([
  record(PIECE, `/${PIECE}`, [
    {
      path: ["secret"],
      confidentiality: [atom("demo-secret")],
      integrity: [],
      origin: "declared",
    },
    {
      path: ["briefing"],
      confidentiality: [atom("demo-secret")],
      integrity: [atom("cf-compiled-by:cf-compiler"), provenance(LIFT)],
      origin: "derived",
      transformedBy: provenance(LIFT),
    },
    {
      path: ["briefing", "inner"],
      confidentiality: [atom("inner-only")],
      integrity: [],
      origin: "declared",
    },
  ]),
  record(ROOTED, `/${ROOTED}`, [{
    path: [],
    confidentiality: [atom("org-only")],
    integrity: [],
    origin: "declared",
  }]),
]);

const WILD = entity("wild");

/**
 * A document labelled the way the runtime writes one: `*` stands for every
 * member of `items`, and two of its keys hold the characters a reference
 * escapes — `/`, which is the separator itself, and `~`, which escapes it.
 */
const wildSnapshot = snapshot([
  record(WILD, `/${WILD}`, [
    {
      path: ["items", "*"],
      confidentiality: [atom("member-secret")],
      integrity: [],
      origin: "declared",
    },
    {
      path: ["a/b"],
      confidentiality: [atom("slash-secret")],
      integrity: [],
      origin: "declared",
    },
    {
      path: ["c~d"],
      confidentiality: [atom("tilde-secret")],
      integrity: [],
      origin: "declared",
    },
  ]),
]);

describe("console/cell-labels", () => {
  describe("consoleCellLabels()", () => {
    it("returns every atom of every path, deduplicated", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [
          declared,
          derived({ kind: "builtin", builtinId: "llm" }),
        ]),
      );
      expect(labels.confidentiality).toEqual(["demo-secret"]);
      expect(labels.integrity).toEqual([
        "cf-compiled-by:cf-compiler",
        "TransformedBy",
      ]);
      expect(labels.entries.map((entry) => entry.path)).toEqual([
        [],
        ["summary"],
      ]);
      expect(labels.entries[1].observes).toBe("members");
    });

    it("returns `derived` false when no entry was derived", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [declared]),
      );
      expect(labels.derived).toBe(false);
      expect(labels.transformedBy).toEqual([]);
    });

    it("returns `derived` true when an entry names `derived` as its origin", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [
          declared,
          derived({ kind: "builtin", builtinId: "llm" }),
        ]),
      );
      expect(labels.derived).toBe(true);
    });

    it("returns the builtin's own id as the producer of a builtin identity", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [
          derived({ kind: "builtin", builtinId: "llm" }),
        ]),
      );
      expect(labels.transformedBy).toEqual(["llm"]);
      expect(labels.entries[0].transformedBy).toBe("llm");
    });

    it("returns `<symbol> in <module>` as the producer of a verified identity carrying both", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [
          derived({
            kind: "verified",
            moduleIdentity: "cf:module/abc",
            symbol: "__cfLift_2",
          }),
        ]),
      );
      expect(labels.transformedBy).toEqual(["__cfLift_2 in cf:module/abc"]);
    });

    it("returns the module as the producer of a verified identity carrying no symbol", () => {
      const labels = consoleCellLabels(
        record(LABELLED, `/${LABELLED}`, [
          derived({ kind: "verified", moduleIdentity: "cf:module/abc" }),
        ]),
      );
      expect(labels.transformedBy).toEqual(["cf:module/abc"]);
    });
  });

  describe("consoleCellLabelIndex()", () => {
    it("keys each cell by its entity id alone, and not by the reference the run held", () => {
      const index = consoleCellLabelIndex(readSnapshot);
      expect([...index.byAddress.keys()]).toEqual([LABELLED, BARE]);
      expect(index.byAddress.get(`/${LABELLED}`)).toBe(undefined);
    });

    it("returns `absent` as the status of a run that wrote no snapshot", () => {
      const index = consoleCellLabelIndex(undefined);
      expect(index.status).toBe("absent");
      expect(index.byAddress.size).toBe(0);
      expect(index.space).toBe(undefined);
    });

    it("returns `unavailable` as the status of an unavailable snapshot, with its detail", () => {
      const index = consoleCellLabelIndex({
        ...snapshot([]),
        status: "unavailable",
        unavailableReason: "space-not-found",
        unavailableDetail: `no space matches "demo-space"`,
      });
      expect(index.status).toBe("unavailable");
      expect(index.detail).toBe(`no space matches "demo-space"`);
      expect(index.space).toEqual({
        configured: "demo-space",
        dbPath: "/spaces/demo.sqlite",
      });
    });

    it("returns `read` as the status of a snapshot the space was read for", () => {
      expect(consoleCellLabelIndex(readSnapshot).status).toBe("read");
    });
  });

  describe("consoleCellLabelsSummary()", () => {
    it("counts one cell for each entity the snapshot read", () => {
      const index = consoleCellLabelIndex(readSnapshot);
      expect(index.byAddress.size).toBe(2);
      expect(consoleCellLabelsSummary(index).cellsRead).toBe(2);
    });

    it("counts only the cells that carry an entry as labelled", () => {
      const summary = consoleCellLabelsSummary(
        consoleCellLabelIndex(readSnapshot),
      );
      expect(summary.cellsLabelled).toBe(1);
    });

    it("carries the status, detail and space of the index it summarizes", () => {
      const summary = consoleCellLabelsSummary(
        consoleCellLabelIndex(readSnapshot),
      );
      expect(summary.status).toBe("read");
      expect(summary.detail).toBe(undefined);
      expect(summary.space).toEqual({
        configured: "demo-space",
        dbPath: "/spaces/demo.sqlite",
      });
    });
  });

  describe("cellLabelsAt()", () => {
    const index = consoleCellLabelIndex(readSnapshot);

    it("returns `undefined` for no reference", () => {
      expect(cellLabelsAt(index, undefined)).toBe(undefined);
    });

    it("returns the labels a reference is keyed under", () => {
      expect(cellLabelsAt(index, `/${LABELLED}`)?.confidentiality).toEqual([
        "demo-secret",
      ]);
    });

    it("narrows a reference addressing a path inside a document to that path", () => {
      expect(cellLabelsAt(index, `/${LABELLED}/value/secret`)?.entries)
        .toEqual([{
          path: [],
          confidentiality: ["demo-secret"],
          integrity: ["cf-compiled-by:cf-compiler"],
          origin: "declared",
        }]);
    });

    it("strips the scope suffix of a scoped id to find the document", () => {
      expect(cellLabelsAt(index, `/${LABELLED}@user`)).toBe(
        index.byAddress.get(LABELLED),
      );
    });

    it("returns `undefined` for a link into a space the snapshot was not taken in", () => {
      expect(cellLabelsAt(index, `/@${FOREIGN_DID}/${LABELLED}`)).toBe(
        undefined,
      );
    });

    it("returns the labels for a link naming the space the snapshot was taken in", () => {
      const inSpace = consoleCellLabelIndex({
        ...readSnapshot,
        space: { configured: "demo-space", did: OWN_DID },
      });
      expect(cellLabelsAt(inSpace, `/@${OWN_DID}/${LABELLED}`)).toBe(
        inSpace.byAddress.get(LABELLED),
      );
    });

    it("leaves a cell the snapshot marked unread out of the index it answers from", () => {
      const unread = consoleCellLabelIndex(snapshot([
        record(LABELLED, `/${LABELLED}`, [declared]),
        {
          entityId: BARE,
          ref: `/@${FOREIGN_DID}/${BARE}`,
          space: FOREIGN_DID,
          unreadReason: "cross-space",
          entries: [],
        },
      ]));
      expect([...unread.byAddress.keys()]).toEqual([LABELLED]);
      expect(consoleCellLabelsSummary(unread).cellsRead).toBe(1);
    });

    it("returns `undefined` for a reference naming no entity", () => {
      expect(cellLabelsAt(index, "my notebook")).toBe(undefined);
    });

    describe("narrowing to the path the reference names", () => {
      const piece = consoleCellLabelIndex(pieceSnapshot);

      it("returns the atom declared at the path the reference names", () => {
        expect(cellLabelsAt(piece, `/${PIECE}/secret`)?.confidentiality)
          .toEqual(["demo-secret"]);
      });

      it("returns no atom for a sibling cell of a labelled one in the same document", () => {
        const labels = cellLabelsAt(piece, `/${PIECE}/city`);
        expect(labels?.entries).toEqual([]);
        expect(labels?.confidentiality).toEqual([]);
      });

      it("keeps the suffix of an entry under the named path, re-rooted to it", () => {
        const labels = cellLabelsAt(piece, `/${PIECE}/briefing`);
        expect(labels?.entries.map((entry) => entry.path)).toEqual([
          [],
          ["inner"],
        ]);
        expect(labels?.confidentiality).toEqual(["demo-secret", "inner-only"]);
      });

      it("returns an entry at the document root for every reference into the document", () => {
        const labels = cellLabelsAt(piece, `/${ROOTED}/anything/deeper`);
        expect(labels?.entries).toEqual([{
          path: [],
          confidentiality: ["org-only"],
          integrity: [],
          origin: "declared",
        }]);
      });

      it("returns `derived` false when the narrowed path holds no derived entry", () => {
        const labels = cellLabelsAt(piece, `/${PIECE}/secret`);
        expect(labels?.derived).toBe(false);
        expect(labels?.transformedBy).toEqual([]);
      });

      it("returns `derived` true and the producer when the narrowed path holds one", () => {
        const labels = cellLabelsAt(piece, `/${PIECE}/briefing`);
        expect(labels?.derived).toBe(true);
        expect(labels?.transformedBy).toEqual(["llm"]);
      });
    });

    describe("matching the segments a label path is written in", () => {
      const wild = consoleCellLabelIndex(wildSnapshot);

      it("returns the atom of a `*` entry for a reference to a member under it", () => {
        const labels = cellLabelsAt(wild, `/${WILD}/items/0`);
        expect(labels?.confidentiality).toEqual(["member-secret"]);
        expect(labels?.entries.map((entry) => entry.path)).toEqual([[]]);
      });

      it("keeps the `*` of an entry under the container a reference names", () => {
        const labels = cellLabelsAt(wild, `/${WILD}/items`);
        expect(labels?.entries.map((entry) => entry.path)).toEqual([["*"]]);
      });

      it("returns the atom of a key holding the separator for the reference that escapes it", () => {
        expect(cellLabelsAt(wild, `/${WILD}/a~1b`)?.confidentiality)
          .toEqual(["slash-secret"]);
      });

      it("returns the atom of a key holding a tilde for the reference that escapes it", () => {
        expect(cellLabelsAt(wild, `/${WILD}/c~0d`)?.confidentiality)
          .toEqual(["tilde-secret"]);
      });

      it("returns no atom of a key holding the separator for a reference naming two segments", () => {
        const labels = cellLabelsAt(wild, `/${WILD}/a/b`);
        expect(labels?.entries).toEqual([]);
        expect(labels?.confidentiality).toEqual([]);
      });
    });
  });
});
