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

/**
 * A stored `revision.data` payload. Every document but {@link UNLABELLED} goes
 * in through the codec, which tags its envelope (`fvj1:…`) the way the server
 * writes one; that one goes in as plain JSON, which the store also holds.
 */
const payload = (id: string, document: unknown): string =>
  id === UNLABELLED
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
  let reader: SpaceLabelReader;

  beforeAll(async () => {
    directory = await Deno.makeTempDir({ prefix: "cf-harness-space-labels-" });
    dbPath = `${directory}/space.sqlite`;
    seed(dbPath);
    reader = await openSpaceLabelReader("demo-space", { dbPath });
  });

  afterAll(async () => {
    reader.close();
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

    it("returns the entity named after the space of a cross-space link", () => {
      const did = "did:key:z6MkfrQ3tCDZgvJcLwPTvxNsFR8RgTsHTa5JzmnW9pQrUvNq";
      expect(cellAddressOfRef(`/@${did}/${DECLARED}/title`)).toEqual({
        id: DECLARED,
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
