/**
 * Hermetic test for the unified entity model + encoded commit decoding. Seeds a
 * modern piece (patternIdentity → module, argument, internal manifest), an
 * owned cell, a stream, and a free cell, then checks classification + lineage.
 *
 * It also seeds one entity for each way an entity ends up carrying no document
 * — a tombstone, a payload that does not decode, and a `set` that stored no
 * data — because all three reconstruct to nothing and a listing that reports
 * them alike cannot answer "show me what is broken". Side-effect free.
 */

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";

import { openSpace } from "../db.ts";
import { listCommits } from "../queries.ts";
import { describePiece, listEntityModels } from "../model.ts";

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
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

/** A plain-JSON sigil link to an entity id. */
function link(id: string) {
  return { "/": { "link@1": { id, path: [] } } };
}

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, ?, ?, ?, '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  const session = "session:did:key:zSpaceAAAA:11111111-2222-3333";

  // Commit 1: original stored codec-encoded with 2 ops and 1 confirmed read.
  const original = jsonFromFabricValue({
    localSeq: 1,
    operations: [{ op: "set" }, { op: "patch" }],
    reads: { confirmed: [{ id: "x" }], pending: [] },
  });
  commit.run(1, session, 1, original);

  // The pattern module (source).
  rev.run(
    "of:mod",
    1,
    JSON.stringify({
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        code: "export default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
    }),
    1,
  );

  // A modern piece: patternIdentity → module, argument → input, internal → owned.
  commit.run(2, session, 2, "{}");
  rev.run(
    "of:piece",
    2,
    JSON.stringify({
      value: { $NAME: "My Notebook", $UI: { type: "vnode" } },
      argument: link("of:input"),
      internal: [{ partialCause: "query", link: link("of:owned") }],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }),
    2,
  );

  // The piece's input (argument) cell.
  commit.run(3, session, 3, "{}");
  rev.run("of:input", 3, JSON.stringify({ value: { title: "untitled" } }), 3);

  // An owned cell (result back-link to the piece) + a stream + a free cell.
  commit.run(4, session, 4, "{}");
  rev.run(
    "of:owned",
    4,
    JSON.stringify({ value: "hello", result: link("of:piece") }),
    4,
  );

  commit.run(5, session, 5, "{}");
  rev.run(
    "of:stream",
    5,
    JSON.stringify({ value: { $stream: true }, result: link("of:piece") }),
    5,
  );

  commit.run(6, session, 6, "{}");
  rev.run("of:free", 6, JSON.stringify({ value: "none" }), 6);

  // The three ways an entity carries no document, plus a fourth entity that
  // decodes fine into a path-set nothing recognizes.
  const op = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, ?, ?, ?)`,
  );
  commit.run(7, session, 7, "{}");
  op.run("of:tombstoned", 7, "set", JSON.stringify({ value: { a: 1 } }), 7);
  commit.run(8, session, 8, "{}");
  op.run("of:tombstoned", 8, "delete", null, 8);
  commit.run(9, session, 9, "{}");
  op.run("of:corrupt", 9, "set", "{not json at all", 9);
  commit.run(10, session, 10, "{}");
  op.run("of:nodata", 10, "set", null, 10);
  commit.run(11, session, 11, "{}");
  op.run("of:oddshape", 11, "set", JSON.stringify({ cfc: {}, slug: "x" }), 11);
  // A document is a tree of paths. These two decode to something else, or do
  // not decode at all — both are corruption, not an entity that stored nothing.
  commit.run(13, session, 13, "{}");
  op.run("of:nulldoc", 13, "set", "null", 13);
  commit.run(14, session, 14, "{}");
  op.run("of:emptystr", 14, "set", "", 14);

  // The same corruption one op deeper, where a patch chain hides it. The engine
  // decodes a base and a patch payload unconditionally and rejects a malformed
  // one, so reconstruction has to reach the same verdict rather than reading an
  // empty payload as an absent one and rebuilding a document over it.
  commit.run(15, session, 15, "{}");
  op.run("of:badbase", 15, "set", "", 15);
  commit.run(16, session, 16, "{}");
  op.run(
    "of:badbase",
    16,
    "patch",
    JSON.stringify([{ op: "add", path: "/value", value: { ok: true } }]),
    16,
  );
  commit.run(17, session, 17, "{}");
  op.run("of:badpatch", 17, "set", JSON.stringify({ value: { n: 1 } }), 17);
  commit.run(18, session, 18, "{}");
  op.run("of:badpatch", 18, "patch", "", 18);

  // A second piece whose owned cells are a tombstone and a corrupt entity, so
  // `describePiece` has both to tell apart.
  commit.run(12, session, 12, "{}");
  op.run(
    "of:piece2",
    12,
    "set",
    JSON.stringify({
      value: { $NAME: "Second" },
      argument: link("of:tombstoned"),
      internal: [
        { partialCause: "a", link: link("of:tombstoned") },
        { partialCause: "b", link: link("of:corrupt") },
      ],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
    }),
    12,
  );

  db.close();
}

Deno.test("unified entity model + encoded commit decode", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-model-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      await t.step(
        "listCommits decodes an encoded original (ops/reads non-zero)",
        () => {
          const rows = listCommits(space);
          const c1 = rows.find((r) => r.seq === 1)!;
          assertEquals(c1.ops, 2);
          assertEquals(c1.reads, 1);
        },
      );

      await t.step("entities classify by path-set, not value shape", () => {
        const ents = listEntityModels(space).entities;
        const byId = Object.fromEntries(ents.map((e) => [e.id, e]));

        assertEquals(byId["of:mod"].kind, "module");
        assertEquals(byId["of:mod"].label, "module:notebook.tsx");

        // The piece is a piece because of patternIdentity — NOT because $NAME
        // is present (the old heuristic would have mislabeled a bare $NAME cell).
        assertEquals(byId["of:piece"].kind, "piece");
        assertEquals(byId["of:piece"].label, "My Notebook");
        assertEquals(byId["of:piece"].regime, "modern");
        assertEquals(byId["of:piece"].lineage.argument, "of:input");
        assertEquals(byId["of:piece"].lineage.internal, ["of:owned"]);
        // patternIdentity resolves to the module entity by matching value.identity.
        assertEquals(byId["of:piece"].lineage.pattern?.moduleId, "of:mod");

        // A stream beats ownership; an owned cell carries a back-link.
        assertEquals(byId["of:stream"].kind, "stream");
        assertEquals(byId["of:owned"].kind, "owned-cell");
        assertEquals(byId["of:owned"].owned, true);
        assertEquals(byId["of:owned"].lineage.owner, "of:piece");

        // A bare value cell with no result is free.
        assertEquals(byId["of:free"].kind, "free-cell");
      });

      await t.step(
        "describePiece resolves pattern, input, and owned cells",
        () => {
          const piece = describePiece(space, "of:piece");
          assert(!("error" in piece));
          if ("error" in piece) return;
          assertEquals(piece.name, "My Notebook");
          assertEquals(piece.pattern?.id, "of:mod");
          assertEquals(
            piece.pattern?.filename,
            "/api/patterns/notes/notebook.tsx",
          );
          assertEquals(piece.pattern?.symbol, "default");
          assertEquals(piece.input?.id, "of:input");
          assertEquals(piece.ownedCells.length, 1);
          assertEquals(piece.ownedCells[0].id, "of:owned");
          assert(piece.resultKeys.includes("$NAME"));
        },
      );

      await t.step("describePiece rejects non-pieces", () => {
        const r = describePiece(space, "of:free");
        assert("error" in r);
      });

      await t.step("an entity with no document says why it has none", () => {
        const byId = Object.fromEntries(
          listEntityModels(space).entities.map((e) => [e.id, e]),
        );

        // A deletion is an ordinary end, and is its own kind — so `--kind
        // deleted` asks for tombstones and `--kind unknown` no longer answers.
        assertEquals(byId["of:tombstoned"].kind, "deleted");
        assertEquals(byId["of:tombstoned"].label, "(deleted)");

        // The rest are `unknown`, which now means the entity is here and
        // cannot be read. Their labels keep the causes apart.
        assertEquals(byId["of:corrupt"].kind, "unknown");
        assertEquals(byId["of:corrupt"].label, "(undecodable)");
        assertEquals(byId["of:nodata"].kind, "unknown");
        assertEquals(byId["of:nodata"].label, "(no data)");
        assertEquals(byId["of:oddshape"].kind, "unknown");
        assertEquals(byId["of:oddshape"].label, "{cfc,slug}");

        // The tombstone's revision count still includes the delete op, so the
        // count alone never separated it from a corrupt entity.
        assertEquals(byId["of:tombstoned"].revisions, 2);

        // A payload that decodes to a non-document, and one that does not
        // decode at all, are both corruption — neither is "(no data)", which
        // belongs to a `set` that genuinely stored none.
        assertEquals(byId["of:nulldoc"].kind, "unknown");
        assertEquals(byId["of:nulldoc"].label, "(undecodable)");
        assertEquals(byId["of:emptystr"].kind, "unknown");
        assertEquals(byId["of:emptystr"].label, "(undecodable)");

        // A patch chain must not launder either one: a malformed base read as
        // an absent one would rebuild a document the engine refuses to produce,
        // and a malformed patch read as an empty list would silently apply
        // nothing and call the result current.
        assertEquals(byId["of:badbase"].kind, "unknown");
        assertEquals(byId["of:badbase"].label, "(undecodable)");
        assertEquals(byId["of:badpatch"].kind, "unknown");
        assertEquals(byId["of:badpatch"].label, "(undecodable)");
      });

      await t.step(
        "a piece's absent owned cells keep their causes apart",
        () => {
          const piece = describePiece(space, "of:piece2");
          assert(!("error" in piece));
          if ("error" in piece) return;
          assertEquals(piece.input?.summary, "(deleted)");
          const byId = Object.fromEntries(
            piece.ownedCells.map((c) => [c.id, c]),
          );
          assertEquals(byId["of:tombstoned"].kind, "deleted");
          assertEquals(byId["of:tombstoned"].label, "(deleted)");
          assertEquals(byId["of:corrupt"].kind, "unknown");
          assertEquals(byId["of:corrupt"].label, "(undecodable)");
        },
      );

      await t.step("describePiece names a tombstoned entity as deleted", () => {
        const r = describePiece(space, "of:tombstoned");
        assert("error" in r);
        assertEquals(r.error, "entity (deleted)");
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
