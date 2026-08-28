import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import type { FabricValue } from "@commonfabric/data-model/fabric-value";

import {
  cellAddressOfRef,
  openSpaceLabelReader,
  readSpaceCellLabels,
  type SpaceLabelReader,
} from "../src/space-labels.ts";
import { HARNESS_CELL_LABELS_TYPE } from "../src/contracts/cell-labels.ts";

const SCHEMA = `
CREATE TABLE "commit" (
  seq INTEGER NOT NULL PRIMARY KEY, branch TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL, local_seq INTEGER NOT NULL,
  invocation_ref TEXT, authorization_ref TEXT,
  original JSON NOT NULL, resolution JSON NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE revision (
  branch TEXT NOT NULL DEFAULT '', id TEXT NOT NULL,
  scope_key TEXT NOT NULL DEFAULT 'space', seq INTEGER NOT NULL,
  op_index INTEGER NOT NULL, op TEXT NOT NULL, data JSON, commit_seq INTEGER NOT NULL,
  PRIMARY KEY (branch, id, scope_key, seq, op_index)
);
CREATE TABLE branch (
  name TEXT NOT NULL PRIMARY KEY DEFAULT '', parent_branch TEXT,
  fork_seq INTEGER, created_seq INTEGER NOT NULL DEFAULT 0,
  head_seq INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
);
INSERT INTO branch (name, head_seq, status) VALUES ('', 5, 'active');
`;

const TRANSFORMED_BY = "https://commonfabric.org/cfc/atom/TransformedBy";
const RESOURCE = "https://commonfabric.org/cfc/atom/Resource";
const SCHEMA_HASH = "fid1:C4ajDsLKcfdMDDs3lbNShZBcQCVA4qhVo5mRoBcgpB0";

/** An entity id in the store's own shape: `of:fid1:` and 44 base64url chars. */
const entity = (name: string) => `of:fid1:${name.padEnd(44, "0")}`;

const DECLARED = entity("declared");
const DERIVED = entity("derived");
const UNLABELLED = entity("unlabelled");
const DISJUNCTIVE = entity("disjunctive");
const COMMITTED = entity("committed");
const NEVER_WRITTEN = entity("neverWritten");

/**
 * The space the DID-named database holds, and one this host never opened. The
 * store names its file after its space, so a file named for {@link OWN_DID} is
 * the only proof this reader has of which space its ids belong to.
 */
const OWN_DID = "did:key:z6MkfrQ3tCDZgvJcLwPTvxNsFR8RgTsHTa5JzmnW9pQrUvNq";
const FOREIGN_DID = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";

/**
 * An id the seeded space holds a label for, standing for the id collision a
 * cross-space reference invites: the same id in another space is another cell
 * entirely, and reading it here would answer with this one's label.
 */
const COLLIDING = entity("colliding");

/** A document whose links reach the colliding id in three spaces. */
const LINKER = entity("linker");

/** One stored link, in the at-rest sigil form the store holds. */
const link = (id: string, space?: string) => ({
  "/": {
    "link@1": { id, path: [], ...(space === undefined ? {} : { space }) },
  },
});

/** One `labelMap` entry, in the shape the space stores it. */
const stored = (
  path: string[],
  label: Record<string, unknown>,
  origin: string,
  observes?: string,
) => ({
  path,
  label,
  origin,
  ...(observes === undefined ? {} : { observes }),
});

const documents: Record<string, unknown> = {
  [DECLARED]: {
    value: { secret: "the combination is 1234" },
    cfc: {
      version: 1,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: ["demo-secret"],
            integrity: ["cf-compiled-by:cf-compiler"],
          }, "declared"),
        ],
      },
    },
  },
  [DERIVED]: {
    value: { summary: "a redaction of the above" },
    cfc: {
      version: 1,
      schemaHash: SCHEMA_HASH,
      labelMap: {
        version: 1,
        entries: [
          stored(
            ["summary"],
            {
              confidentiality: ["demo-secret"],
              integrity: [
                "cf-compiled-by:cf-compiler",
                {
                  type: TRANSFORMED_BY,
                  identity: {
                    kind: "verified",
                    moduleIdentity: "cf:module/abc",
                    symbol: "__cfLift_2",
                  },
                },
              ],
            },
            "derived",
            "members",
          ),
        ],
      },
    },
  },
  // Stored as plain JSON rather than through the codec: a durable file holds
  // both at-rest forms, and a reader that only decoded the tagged one would
  // report every legacy row as an entity with no document.
  [UNLABELLED]: { value: { title: "nothing is labelled here" } },
  [DISJUNCTIVE]: {
    value: { note: "reachable two ways" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: [
              { anyOf: [{ type: RESOURCE, class: "A", subject: "s" }, "b"] },
            ],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
  [COLLIDING]: {
    value: { secret: "local, and labelled" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: ["foreign-secret"],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
  [LINKER]: {
    value: {
      mine: link(COLLIDING),
      ours: link(COLLIDING, OWN_DID),
      theirs: link(COLLIDING, FOREIGN_DID),
    },
  },
  [COMMITTED]: {
    value: { attachment: "…" },
    cfc: {
      version: 1,
      labelMap: {
        version: 1,
        entries: [
          stored([], {
            confidentiality: [
              {
                type: RESOURCE,
                class: "attachment",
                subject: { digestOf: SCHEMA_HASH },
              },
            ],
            integrity: [],
          }, "declared"),
        ],
      },
    },
  },
};

/** The documents written as plain JSON rather than through the codec. */
const PLAIN = new Set([UNLABELLED, LINKER]);

/**
 * A stored `revision.data` payload. Most documents go in through the codec,
 * which tags their envelope (`fvj1:…`) the way the server writes one; the
 * {@link PLAIN} ones go in as plain JSON, which the store also holds — one to
 * show that a legacy row still reads, and one to keep its links in the sigil
 * form a reader meets them in.
 */
const payload = (id: string, document: unknown): string =>
  PLAIN.has(id)
    ? JSON.stringify(document)
    : jsonFromFabricValue(document as FabricValue);

const seed = (path: string) => {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const revision = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  for (const [id, document] of Object.entries(documents)) {
    seq += 1;
    commit.run(seq, seq);
    revision.run(id, seq, payload(id, document), seq);
  }
  db.close();
};

describe("space-labels", () => {
  let directory: string;
  let dbPath: string;
  let didDbPath: string;
  let reader: SpaceLabelReader;
  let didReader: SpaceLabelReader;

  beforeAll(async () => {
    directory = await Deno.makeTempDir({ prefix: "cf-harness-space-labels-" });
    dbPath = `${directory}/space.sqlite`;
    seed(dbPath);
    reader = await openSpaceLabelReader("demo-space", { dbPath });
    // The same store under the name the server gives one, so the reader can
    // prove which space its ids belong to. Every space-naming reference is
    // answerable only against this one.
    didDbPath = `${directory}/${OWN_DID}.sqlite`;
    seed(didDbPath);
    didReader = await openSpaceLabelReader("demo-space", {
      dbPath: didDbPath,
    });
  });

  afterAll(async () => {
    reader.close();
    didReader.close();
    await Deno.remove(directory, { recursive: true });
  });

  describe("cellAddressOfRef()", () => {
    it("returns the entity at the space scope for a bare `of:` id", () => {
      expect(cellAddressOfRef(DECLARED)).toEqual({
        id: DECLARED,
        scope: "space",
      });
    });

    it("returns the document for a link naming a path inside it", () => {
      expect(cellAddressOfRef(`/${DECLARED}/value/secret`)).toEqual({
        id: DECLARED,
        scope: "space",
      });
    });

    it("returns the entity and the space a cross-space link names", () => {
      expect(cellAddressOfRef(`/@${FOREIGN_DID}/${DECLARED}/title`)).toEqual({
        id: DECLARED,
        space: FOREIGN_DID,
        scope: "space",
      });
    });

    it("returns the scope of a scoped id, which a label map is stored at", () => {
      expect(cellAddressOfRef(`/${DECLARED}@user`)).toEqual({
        id: DECLARED,
        scope: "user",
      });
    });

    it("returns `undefined` for a string that is not a link", () => {
      expect(cellAddressOfRef("my notebook")).toBe(undefined);
    });
  });

  describe("openSpaceLabelReader()", () => {
    it("returns the atoms, origin and schema hash of a declared label", () => {
      const read = reader.read({ id: DECLARED, scope: "space" });
      expect(read.schemaHash).toBe(SCHEMA_HASH);
      expect(read.entries).toEqual([{
        path: [],
        confidentiality: [{ type: "demo-secret", name: "demo-secret" }],
        integrity: [{
          type: "cf-compiled-by:cf-compiler",
          name: "cf-compiled-by:cf-compiler",
        }],
        origin: "declared",
      }]);
    });

    it("lifts a `TransformedBy` atom out of `integrity` and leaves it there", () => {
      const [entry] = reader.read({ id: DERIVED, scope: "space" }).entries;
      const provenance = {
        type: TRANSFORMED_BY,
        name: "TransformedBy",
        fields: {
          identity: {
            kind: "verified",
            moduleIdentity: "cf:module/abc",
            symbol: "__cfLift_2",
          },
        },
      };
      expect(entry.path).toEqual(["summary"]);
      expect(entry.origin).toBe("derived");
      expect(entry.observes).toBe("members");
      expect(entry.transformedBy).toEqual(provenance);
      expect(entry.integrity).toEqual([
        {
          type: "cf-compiled-by:cf-compiler",
          name: "cf-compiled-by:cf-compiler",
        },
        provenance,
      ]);
    });

    it("returns an empty entry list for a document with no `cfc` path", () => {
      const read = reader.read({ id: UNLABELLED, scope: "space" });
      expect(read.entries).toEqual([]);
      expect(read.schemaHash).toBe(undefined);
    });

    it("returns an empty entry list for an entity the space never wrote", () => {
      expect(reader.read({ id: NEVER_WRITTEN, scope: "space" }).entries)
        .toEqual([]);
    });

    it("returns a disjunctive confidentiality clause as one atom carrying its alternatives", () => {
      const [entry] = reader.read({ id: DISJUNCTIVE, scope: "space" }).entries;
      expect(entry.confidentiality).toEqual([{
        type: "anyOf",
        name: "Resource or b",
        anyOf: [
          {
            type: RESOURCE,
            name: "Resource",
            fields: { class: "A", subject: "s" },
          },
          { type: "b", name: "b" },
        ],
      }]);
    });

    it("keeps an object atom's non-`type` fields, including a committed one", () => {
      const [entry] = reader.read({ id: COMMITTED, scope: "space" }).entries;
      expect(entry.confidentiality).toEqual([{
        type: RESOURCE,
        name: "Resource",
        fields: {
          class: "attachment",
          subject: { digestOf: SCHEMA_HASH },
        },
      }]);
    });

    it("returns the space DID the opened file is named for", () => {
      expect(didReader.did).toBe(OWN_DID);
    });

    it("returns no space DID for an opened file whose name is not one", () => {
      expect(reader.did).toBe(undefined);
    });

    it("returns the labels of an address naming the space that was opened", () => {
      const read = didReader.read({
        id: COLLIDING,
        space: OWN_DID,
        scope: "space",
      });
      expect(read.unread).toBe(undefined);
      expect(read.entries.map((entry) => entry.confidentiality)).toEqual([
        [{ type: "foreign-secret", name: "foreign-secret" }],
      ]);
    });

    it("returns no labels and `cross-space` for an address in another space holding an id this space also holds", () => {
      const read = didReader.read({
        id: COLLIDING,
        space: FOREIGN_DID,
        scope: "space",
      });
      expect(read.unread).toBe("cross-space");
      expect(read.entries).toEqual([]);
    });

    it("returns no labels and `space-unproven` for an address naming any space when the opened file proves none", () => {
      const read = reader.read({
        id: COLLIDING,
        space: OWN_DID,
        scope: "space",
      });
      expect(read.unread).toBe("space-unproven");
      expect(read.entries).toEqual([]);
    });

    it("returns the labels of the linked cells naming no space and naming the opened one", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.linked).toEqual([
        { key: "mine", id: COLLIDING },
        { key: "ours", id: COLLIDING },
      ]);
      expect(read.entries).toEqual([
        {
          path: ["mine"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
        {
          path: ["ours"],
          confidentiality: [{ type: "foreign-secret", name: "foreign-secret" }],
          integrity: [],
          origin: "declared",
          source: COLLIDING,
        },
      ]);
    });

    it("returns no entry under a link into another space holding an id this space also holds", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.linked.map((cell) => cell.key)).not.toContain("theirs");
      expect(read.entries.map((entry) => entry.path[0])).not.toContain(
        "theirs",
      );
    });

    it("returns the path of a link into another space as unread rather than dropping it", () => {
      const read = didReader.read({ id: LINKER, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["theirs"], reason: "cross-space" },
      ]);
    });

    it("returns only the link naming no space when the opened file proves no DID", () => {
      const read = reader.read({ id: LINKER, scope: "space" });
      expect(read.linked).toEqual([{ key: "mine", id: COLLIDING }]);
      expect(read.entries.map((entry) => entry.path)).toEqual([["mine"]]);
    });

    it("returns every spaced link as unread when the opened file proves no DID", () => {
      const read = reader.read({ id: LINKER, scope: "space" });
      expect(read.unreadPaths).toEqual([
        { path: ["ours"], reason: "space-unproven" },
        { path: ["theirs"], reason: "space-unproven" },
      ]);
    });

    it("returns no unread path for a document whose links were all followed", () => {
      expect(didReader.read({ id: DECLARED, scope: "space" }).unreadPaths)
        .toBe(undefined);
    });
  });

  describe("readSpaceCellLabels()", () => {
    const read = (refs: readonly string[]) =>
      readSpaceCellLabels({
        space: "demo-space",
        dbPath,
        refs,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });

    it("records one cell per entity, naming the reference the run held", async () => {
      const snapshot = await read([`/${DECLARED}`, `/${UNLABELLED}`]);
      expect(snapshot.type).toBe(HARNESS_CELL_LABELS_TYPE);
      expect(snapshot.status).toBe("read");
      expect(snapshot.space).toEqual({ configured: "demo-space", dbPath });
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([
        DECLARED,
        UNLABELLED,
      ]);
      expect(snapshot.cells[0].ref).toBe(`/${DECLARED}`);
      expect(snapshot.cells[0].schemaHash).toBe(SCHEMA_HASH);
      expect(snapshot.cells[1].entries).toEqual([]);
    });

    it("records one cell for a reference the run held more than once", async () => {
      const snapshot = await read([`/${DECLARED}`, `/${DECLARED}`]);
      expect(snapshot.cells.length).toBe(1);
    });

    it("resolves a reference naming a path inside a document to the document", async () => {
      const snapshot = await read([`/${DECLARED}/value/secret`]);
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([DECLARED]);
      expect(snapshot.cells[0].ref).toBe(`/${DECLARED}/value/secret`);
    });

    it("drops a reference that names no document", async () => {
      const snapshot = await read(["my notebook", `/${DECLARED}`]);
      expect(snapshot.cells.map((cell) => cell.entityId)).toEqual([DECLARED]);
    });

    const readAgainstDid = (refs: readonly string[]) =>
      readSpaceCellLabels({
        space: "demo-space",
        dbPath: didDbPath,
        refs,
        generatedAt: "2026-01-01T00:00:00.000Z",
      });

    it("names the space DID of a database named for its space", async () => {
      const snapshot = await readAgainstDid([`/${DECLARED}`]);
      expect(snapshot.space).toEqual({
        configured: "demo-space",
        did: OWN_DID,
        dbPath: didDbPath,
      });
    });

    it("records a reference into another space as unread rather than reading its id here", async () => {
      const ref = `/@${FOREIGN_DID}/${COLLIDING}`;
      const snapshot = await readAgainstDid([ref]);
      expect(snapshot.cells).toEqual([{
        entityId: COLLIDING,
        ref,
        space: FOREIGN_DID,
        unreadReason: "cross-space",
        entries: [],
      }]);
    });

    it("records one cell per space for an id referenced in two", async () => {
      const snapshot = await readAgainstDid([
        `/${COLLIDING}`,
        `/@${FOREIGN_DID}/${COLLIDING}`,
      ]);
      expect(snapshot.cells.map((cell) => cell.unreadReason)).toEqual([
        undefined,
        "cross-space",
      ]);
      expect(snapshot.cells[0].entries.map((entry) => entry.confidentiality))
        .toEqual([[{ type: "foreign-secret", name: "foreign-secret" }]]);
    });

    it("records the path of a link the walk could not follow", async () => {
      const snapshot = await readAgainstDid([`/${LINKER}`]);
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["theirs"], reason: "cross-space" },
      ]);
      expect(snapshot.cells[0].unreadReason).toBe(undefined);
    });

    it("records every spaced link of a cell as unread against a database naming no space", async () => {
      const snapshot = await read([`/${LINKER}`]);
      expect(snapshot.cells[0].unreadPaths).toEqual([
        { path: ["ours"], reason: "space-unproven" },
        { path: ["theirs"], reason: "space-unproven" },
      ]);
    });

    it("records no unread path for a cell whose links were all followed", async () => {
      const snapshot = await readAgainstDid([`/${DECLARED}`]);
      expect(snapshot.cells[0].unreadPaths).toBe(undefined);
    });

    it("returns an unavailable snapshot naming the space when no database is found", async () => {
      const snapshot = await readSpaceCellLabels({
        space: "demo-space",
        dbPath: `${directory}/absent.sqlite`,
        refs: [`/${DECLARED}`],
        generatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(snapshot.status).toBe("unavailable");
      expect(snapshot.unavailableReason).toBe("space-not-found");
      expect(snapshot.space).toEqual({ configured: "demo-space" });
      expect(snapshot.cells).toEqual([]);
      expect(typeof snapshot.unavailableDetail).toBe("string");
    });
  });
});
