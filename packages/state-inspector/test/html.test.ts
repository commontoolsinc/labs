// Hermetic test for the HTML visual surface: the bundle carries the full model
// (entities/pieces/graph/timeline) and the rendered page is self-contained with
// a parseable, `</script>`-safe embedded bundle.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Database } from "@db/sqlite";

import { openSpace } from "../db.ts";
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
INSERT INTO branch (name, head_seq, status) VALUES ('', 4, 'active');
`;

const MODULE_IDENTITY = "pf1v3J_M5Nep7cq-Uh8EYG0ZQaE217FfDfcjbwGdjVI";

function link(id: string) {
  return { "/": { "link@1": { id, path: [] } } };
}

function seed(path: string) {
  const db = new Database(path, { create: true });
  db.exec(SCHEMA);
  const commit = db.prepare(
    `INSERT INTO "commit" (seq, session_id, local_seq, original, resolution)
     VALUES (?, 'session:did:key:zX:u', ?, '{}', '{}')`,
  );
  const rev = db.prepare(
    `INSERT INTO revision (id, seq, op_index, op, data, commit_seq)
     VALUES (?, ?, 0, 'set', ?, ?)`,
  );
  commit.run(1, 1);
  rev.run(
    "of:mod",
    1,
    JSON.stringify({
      value: {
        kind: "source",
        identity: MODULE_IDENTITY,
        // A value containing the literal `</script>` to exercise escaping.
        code: "// </script> guard\nexport default () => null;\n",
        filename: "/api/patterns/notes/notebook.tsx",
        imports: [],
      },
    }),
    1,
  );
  commit.run(2, 2);
  rev.run(
    "of:piece",
    2,
    JSON.stringify({
      value: { $NAME: "My Notebook", $UI: {} },
      argument: link("of:input"),
      internal: [{ partialCause: "q", link: link("of:owned") }],
      patternIdentity: { identity: MODULE_IDENTITY, symbol: "default" },
      schema: { type: "object", properties: {}, $defs: {} },
    }),
    2,
  );
  commit.run(3, 3);
  rev.run("of:input", 3, JSON.stringify({ value: { title: "t" } }), 3);
  commit.run(4, 4);
  rev.run(
    "of:owned",
    4,
    JSON.stringify({ value: "hi", result: link("of:piece") }),
    4,
  );
  db.close();
}

Deno.test("html visual surface: bundle + self-contained render", async (t) => {
  const dir = await Deno.makeTempDir({ prefix: "state-inspector-html-" });
  const dbPath = `${dir}/space.sqlite`;
  try {
    seed(dbPath);
    const space = openSpace(dbPath);
    try {
      const bundle = buildInspectorBundle(space, { generatedAt: "2026-01-01" });

      await t.step("bundle carries the full model", () => {
        assert(bundle.entities.length >= 4);
        assertEquals(bundle.pieces.length, 1);
        assertEquals(bundle.pieces[0].name, "My Notebook");
        assert(bundle.graph.nodes.length >= 4);
        assert(bundle.graph.edges.some((e) => e.kind === "pattern"));
        assert(bundle.timeline.length >= 1);
      });

      await t.step("render is self-contained HTML", () => {
        const html = renderInspectorHtml(bundle);
        assertStringIncludes(html, "<!doctype html>");
        assertStringIncludes(html, bundle.space);
        assertStringIncludes(html, "My Notebook");
        // No external resource references (fully offline).
        assert(
          !/src=|href=|@import/.test(html),
          "should have no external refs",
        );
      });

      await t.step("embedded bundle is parseable + script-safe", () => {
        const html = renderInspectorHtml(bundle);
        const m = html.match(
          /<script id="bundle" type="application\/json">(.*?)<\/script>/s,
        );
        assert(m, "bundle script block present");
        // The raw payload must not contain an unescaped </script> closer.
        assert(
          !m![1].includes("</script>"),
          "payload must escape </script>",
        );
        const parsed = JSON.parse(m![1].replaceAll("\\u003c", "<"));
        assertEquals(parsed.space, bundle.space);
        assertEquals(parsed.pieces.length, 1);
      });
    } finally {
      space.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
