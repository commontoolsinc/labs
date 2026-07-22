// Hermetic test for the unified entity model + encoded commit decoding. Seeds a
// modern piece (patternIdentity → module, argument, internal manifest), an
// owned cell, a stream, and a free cell, then checks classification + lineage.
// Side-effect free.

import { assert, assertEquals } from "@std/assert";
import { Database } from "@db/sqlite";
import { jsonFromValue } from "@commonfabric/data-model/codec-json";

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
  const original = jsonFromValue({
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
        const ents = listEntityModels(space);
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
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
