/**
 * A capped space-wide scan returns a SUBSET that looks exactly like a complete
 * one. These tests pin the two properties that tell them apart: every capped
 * scan reports how far it reached, and a `kind` filter selects DURING the scan
 * so the limit counts the entities the caller asked for.
 *
 * The seeded space makes the two orders disagree on purpose — six busy free
 * cells sort ahead of the three quiet pieces — because that is the shape where
 * filtering after the scan returns "the pieces among the first N entities"
 * rather than pieces, and the two are indistinguishable from the result.
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Database } from "@db/sqlite";

import { openSpace, type SpaceDb } from "../db.ts";
import {
  countEntities,
  entityKinds,
  isEntityKind,
  listEntityModels,
} from "../model.ts";
import { buildAllDetails } from "../detail.ts";
import { buildSpaceGraph, subgraphAround } from "../graph.ts";
import { buildInspectorBundle, renderInspectorHtml } from "../html.ts";

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
INSERT INTO branch (name, head_seq, status) VALUES ('', 39, 'active');
`;

const SESSION = "session:did:key:zSpaceAAAA:11111111-2222-3333";
const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

interface SeedEntity {
  id: string;
  /** The stored document, written once per revision. */
  document: Record<string, unknown>;
  revisions: number;
}

/** Six busy cells, one module, three quiet pieces — busiest scanned first. */
const ENTITIES: SeedEntity[] = [
  ...Array.from({ length: 6 }, (_, i) => ({
    id: `of:cell-${i + 1}`,
    document: { value: `cell ${i + 1}` },
    revisions: 5,
  })),
  {
    id: "of:mod",
    document: {
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "export default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
    },
    revisions: 2,
  },
  ...Array.from({ length: 3 }, (_, i) => ({
    id: `of:piece-${i + 1}`,
    document: {
      value: { $NAME: `Topic ${i + 1}` },
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    },
    revisions: 1,
  })),
];

const TOTAL = ENTITIES.length;
const PIECES = ENTITIES.filter((e) => e.id.startsWith("of:piece-")).length;

function seed(path: string): void {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  let seq = 0;
  for (const entity of ENTITIES) {
    for (let n = 0; n < entity.revisions; n++) {
      seq++;
      commit.run(seq, SESSION, seq);
      rev.run(entity.id, seq, JSON.stringify(entity.document), seq);
    }
  }
  db.close();
}

describe("scan-extent", () => {
  let dir: string;
  let space: SpaceDb;

  beforeAll(async () => {
    dir = await Deno.makeTempDir({ prefix: "state-inspector-scan-extent-" });
    seed(`${dir}/space.sqlite`);
    space = openSpace(`${dir}/space.sqlite`);
  });

  afterAll(async () => {
    space.close();
    await Deno.remove(dir, { recursive: true });
  });

  describe("countEntities()", () => {
    it("returns every entity on the branch and scope, however busy each is", () => {
      expect(countEntities(space)).toBe(TOTAL);
    });

    it("returns 0 for a scope the space stores nothing under", () => {
      expect(countEntities(space, { scope: "user:did:key:zNobody" })).toBe(0);
    });
  });

  describe("entityKinds", () => {
    it("names every kind a listing presents, in the order it presents them", () => {
      expect(entityKinds).toEqual([
        "piece",
        "module",
        "stream",
        "schema",
        "owned-cell",
        "free-cell",
        "unknown",
      ]);
    });
  });

  describe("isEntityKind()", () => {
    it("returns true for a name a listing presents", () => {
      expect(isEntityKind("owned-cell")).toBe(true);
    });

    it("returns false for a plural spelling of one", () => {
      expect(isEntityKind("pieces")).toBe(false);
    });
  });

  describe("listEntityModels()", () => {
    it("returns the entities the limit allowed and reports the result truncated", () => {
      const listing = listEntityModels(space, { limit: 3 });
      expect(listing.entities.length).toBe(3);
      expect(listing.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
      });
    });

    it("reports truncation one below the entity count and not at it", () => {
      expect(listEntityModels(space, { limit: TOTAL - 1 }).extent.truncated)
        .toBe(true);
      const whole = listEntityModels(space, { limit: TOTAL });
      expect(whole.entities.length).toBe(TOTAL);
      expect(whole.extent.truncated).toBe(false);
    });

    it("returns up to `limit` entities OF the requested kind, not the kinds among the first `limit` entities", () => {
      // The scan runs busiest-first, and at this limit it reaches only cells,
      // so a filter applied to its RESULT would return nothing. Assert that
      // first: it is what keeps the assertion below from passing vacuously.
      const unfiltered = listEntityModels(space, { limit: 6 });
      expect(unfiltered.entities.filter((e) => e.kind === "piece")).toEqual([]);

      const listing = listEntityModels(space, { kind: "piece", limit: 6 });
      expect(listing.entities.map((e) => e.kind)).toEqual(
        Array(PIECES).fill("piece"),
      );
      expect(listing.extent.truncated).toBe(false);
    });

    it("reports truncation when the space holds more of the requested kind than the limit", () => {
      const listing = listEntityModels(space, { kind: "piece", limit: 2 });
      expect(listing.entities.length).toBe(2);
      expect(listing.extent).toEqual({
        limit: 2,
        total: TOTAL,
        truncated: true,
      });
    });

    it("resolves a piece's pattern module across the entities the filter dropped", () => {
      const listing = listEntityModels(space, { kind: "piece" });
      expect(listing.entities.map((e) => e.lineage.pattern?.moduleId)).toEqual(
        Array(PIECES).fill("of:mod"),
      );
    });

    it("returns no entities for a kind the space holds none of", () => {
      const listing = listEntityModels(space, { kind: "schema" });
      expect(listing.entities).toEqual([]);
      expect(listing.extent.truncated).toBe(false);
    });

    it("returns nothing but reports truncation for a limit below one", () => {
      const listing = listEntityModels(space, { limit: 0 });
      expect(listing.entities).toEqual([]);
      expect(listing.extent).toEqual({
        limit: 0,
        total: TOTAL,
        truncated: true,
      });
    });
  });

  describe("buildSpaceGraph()", () => {
    it("returns the cap it applied and that the space outran it", () => {
      const graph = buildSpaceGraph(space, { limit: 3 });
      expect(graph.extent).toEqual({ limit: 3, total: TOTAL, truncated: true });
    });

    it("returns `truncated` false for a limit the whole space fits inside", () => {
      const graph = buildSpaceGraph(space, { limit: TOTAL });
      expect(graph.extent.truncated).toBe(false);
    });
  });

  describe("subgraphAround()", () => {
    it("returns the extent of the scan the neighborhood was cut from", () => {
      const graph = buildSpaceGraph(space, { limit: 3 });
      expect(subgraphAround(graph, "of:cell-1", 2).extent).toEqual(
        graph.extent,
      );
    });
  });

  describe("buildAllDetails()", () => {
    it("returns the details the limit allowed and reports the pass truncated", () => {
      const listing = buildAllDetails(space, { limit: 3 });
      expect(listing.details.length).toBe(3);
      expect(listing.extent).toEqual({
        limit: 3,
        total: TOTAL,
        truncated: true,
      });
    });

    it("returns `truncated` false for a limit the whole space fits inside", () => {
      expect(buildAllDetails(space, { limit: TOTAL }).extent.truncated).toBe(
        false,
      );
    });
  });

  describe("renderInspectorHtml()", () => {
    it("names the cap and the space's entity count in a truncated explorer", () => {
      const html = renderInspectorHtml(
        buildInspectorBundle(space, { limit: 3 }),
      );
      expect(html).toContain(`capped at 3 of ${TOTAL} entities`);
    });

    it("says nothing about a cap in an explorer that covers the space", () => {
      const html = renderInspectorHtml(
        buildInspectorBundle(space, { limit: TOTAL }),
      );
      expect(html).not.toContain("capped at");
    });
  });
});
